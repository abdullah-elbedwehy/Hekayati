import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertSelfCheck,
  isAllowedModelVersion,
  modelForId,
  sha256,
  type CredentialSource,
  type ImageModelConfig,
  type ProbeConfig,
} from "./gemini-probe-support.js";

export type AttemptOutcome = "accepted" | "input_rejected" | "inconclusive";
export type CharacterFixture = {
  id: string;
  label: string;
  referenceFiles: [string, string];
  identityTraits: string;
  clothing: string;
};
export type SceneFixture = { id: string; description: string; action: string };
export type FixtureManifest = {
  schemaVersion: 1;
  fixtureKind: "deterministic-synthetic-vector";
  fictionalOnly: true;
  characters: CharacterFixture[];
  scenes: SceneFixture[];
};
export type RenderedInput = { id: string; bytes: Buffer; sha256: string };
export type AttemptResult = {
  outcome: AttemptOutcome;
  modelVersion?: string;
  outputSha256?: string;
  outputMimeType?: string;
  outputArtifact?: string;
  failureCategory?: string;
};
export type ReferenceAttempt = AttemptResult & { count: number };
export type ReferenceLimitResult = {
  modelId: string;
  documentedMax: number;
  outcome: "COMPLETE" | "INCONCLUSIVE";
  maxAccepted?: number;
  exceedsDocumentedMaximum: boolean;
  attempts: ReferenceAttempt[];
};
export type IdentityScore = {
  characterId: string;
  recognizable: boolean | null;
  traitsStable: boolean | null;
  clothingFollowed: boolean | null;
};
export type SceneScores = {
  identities: IdentityScore[];
  allSelectedPresent: boolean | null;
  noUnselectedDuplicatedOrSwapped: boolean | null;
};
export type SceneReview = {
  modelId: string;
  participantCount: number;
  sceneId: string;
  selectedCharacterIds: string[];
  generationOutcome: "PASS" | "FAIL";
  modelVersion?: string;
  outputSha256?: string;
  outputMimeType?: string;
  outputArtifact?: string;
  failureCategory?: string;
  scores: SceneScores;
};
export type ReviewDocument = {
  schemaVersion: 2;
  generatedAt: string;
  credentialSource: Exclude<CredentialSource, "none">;
  probeConfigSha256: string;
  fixtureSourceSha256: string;
  renderedInputSha256: Record<string, string>;
  referenceLimits: ReferenceLimitResult[];
  scenes: SceneReview[];
  abortReason?: string;
};

export interface ReviewBindingContext {
  config: ProbeConfig;
  manifest: FixtureManifest;
  probeConfigSha256: string;
  fixtureSourceSha256: string;
  renderedInputSha256: Record<string, string>;
  artifactRoot: string;
}

const BASE_REVIEW_KEYS = [
  "schemaVersion", "generatedAt", "credentialSource", "probeConfigSha256",
  "fixtureSourceSha256", "renderedInputSha256", "referenceLimits", "scenes",
];
const OUTPUT_KEYS = ["modelVersion", "outputSha256", "outputMimeType", "outputArtifact"];

export function parseReviewDocument(
  value: unknown,
  config: ProbeConfig,
  manifest: FixtureManifest,
): ReviewDocument | undefined {
  if (!isRecord(value) || !topLevelValid(value)) return undefined;
  if (!Array.isArray(value.referenceLimits) || !Array.isArray(value.scenes)) return undefined;
  if (!referenceResultsValid(value.referenceLimits, config)) return undefined;
  if (!sceneSequenceValid(value.scenes, config, manifest)) return undefined;
  return value as ReviewDocument;
}

function topLevelValid(value: Record<string, unknown>): boolean {
  const allowedKeys = value.abortReason === undefined ? BASE_REVIEW_KEYS : [...BASE_REVIEW_KEYS, "abortReason"];
  if (!hasExactKeys(value, allowedKeys) || value.schemaVersion !== 2) return false;
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) return false;
  if (value.credentialSource !== "environment" && value.credentialSource !== "keychain") return false;
  if (!isSha256(value.probeConfigSha256) || !isSha256(value.fixtureSourceSha256)) return false;
  if (!hashRecordValid(value.renderedInputSha256)) return false;
  return value.abortReason === undefined
    || (typeof value.abortReason === "string" && /^[a-z0-9:_-]{1,160}$/.test(value.abortReason));
}

function referenceResultsValid(values: unknown[], config: ProbeConfig): boolean {
  if (values.length > config.imageModels.length) return false;
  return values.every((value, index) => {
    const model = config.imageModels[index];
    return Boolean(model) && referenceResultValid(value, model);
  });
}

function referenceResultValid(value: unknown, model: ImageModelConfig): boolean {
  if (!isRecord(value) || !hasExactKeys(value, referenceResultKeys(value))) return false;
  if (value.modelId !== model.id || value.documentedMax !== model.documentedMaxReferences) return false;
  if (value.outcome !== "COMPLETE" && value.outcome !== "INCONCLUSIVE") return false;
  if (typeof value.exceedsDocumentedMaximum !== "boolean" || !Array.isArray(value.attempts)) return false;
  if (!attemptSequenceValid(value.attempts, model)) return false;
  const attempts = value.attempts as ReferenceAttempt[];
  if (value.outcome === "INCONCLUSIVE") {
    return value.maxAccepted === undefined && attempts.at(-1)?.outcome === "inconclusive";
  }
  const accepted = attempts.filter((attempt) => attempt.outcome === "accepted").map((attempt) => attempt.count);
  const measured = accepted.length === 0 ? 0 : Math.max(...accepted);
  return value.maxAccepted === measured
    && value.exceedsDocumentedMaximum === (measured > model.documentedMaxReferences)
    && attempts.every((attempt) => attempt.outcome !== "inconclusive");
}

function referenceResultKeys(value: Record<string, unknown>): string[] {
  const keys = ["modelId", "documentedMax", "outcome", "exceedsDocumentedMaximum", "attempts"];
  return value.outcome === "COMPLETE" ? [...keys, "maxAccepted"] : keys;
}

function attemptSequenceValid(values: unknown[], model: ImageModelConfig): boolean {
  if (values.length === 0 || values.length > 8) return false;
  let low = 0;
  let high = model.documentedMaxReferences - 1;
  for (let index = 0; index < values.length; index += 1) {
    if (index > 1 && isRecord(values[0]) && values[0].outcome === "accepted") return false;
    if (index > 1 && low === high) return false;
    const expected = expectedAttemptCount(values, index, model, low, high);
    const attempt = parseAttempt(values[index], expected, model);
    if (!attempt) return false;
    if (index > 0 && values[0] && isRecord(values[0]) && values[0].outcome === "input_rejected") {
      if (attempt.outcome === "accepted") low = attempt.count;
      if (attempt.outcome === "input_rejected") high = attempt.count - 1;
    }
    if (attempt.outcome === "inconclusive" && index !== values.length - 1) return false;
  }
  return true;
}

function expectedAttemptCount(
  values: unknown[], index: number, model: ImageModelConfig, low: number, high: number,
): number {
  if (index === 0) return model.documentedMaxReferences;
  const first = isRecord(values[0]) ? values[0].outcome : undefined;
  if (first === "accepted") return model.documentedMaxReferences + 1;
  return Math.ceil((low + high) / 2);
}

function parseAttempt(value: unknown, expectedCount: number, model: ImageModelConfig): ReferenceAttempt | undefined {
  if (!isRecord(value) || value.count !== expectedCount) return undefined;
  if (value.outcome !== "accepted" && value.outcome !== "input_rejected" && value.outcome !== "inconclusive") return undefined;
  if (!hasExactKeys(value, attemptKeys(value.outcome))) return undefined;
  if (value.outcome === "accepted") {
    if (!isAllowedModelVersion(value.modelVersion, model) || !isSha256(value.outputSha256)) return undefined;
    if (!validImageMime(value.outputMimeType) || value.outputArtifact !== expectedReferenceArtifact(model, expectedCount, value.outputMimeType)) return undefined;
  } else if (typeof value.failureCategory !== "string" || value.failureCategory.length === 0) return undefined;
  return value as ReferenceAttempt;
}

function attemptKeys(outcome: unknown): string[] {
  return outcome === "accepted"
    ? ["count", "outcome", ...OUTPUT_KEYS]
    : ["count", "outcome", "failureCategory"];
}

function sceneSequenceValid(values: unknown[], config: ProbeConfig, manifest: FixtureManifest): boolean {
  const expected = expectedScenes(config, manifest);
  if (values.length > expected.length) return false;
  return values.every((value, index) => sceneValid(value, expected[index]!, config, manifest));
}

function expectedScenes(config: ProbeConfig, manifest: FixtureManifest): Array<{
  modelId: string; role: ImageModelConfig["role"]; participantCount: number; sceneId: string;
}> {
  return config.imageModels.flatMap((model) => [1, 2, 3, 4].flatMap((participantCount) =>
    manifest.scenes.map((scene) => ({ modelId: model.id, role: model.role, participantCount, sceneId: scene.id })),
  ));
}

function sceneValid(
  value: unknown,
  expected: ReturnType<typeof expectedScenes>[number],
  config: ProbeConfig,
  manifest: FixtureManifest,
): boolean {
  if (!isRecord(value) || (value.generationOutcome !== "PASS" && value.generationOutcome !== "FAIL")) return false;
  if (!hasExactKeys(value, sceneKeys(value.generationOutcome))) return false;
  if (value.modelId !== expected.modelId || value.participantCount !== expected.participantCount || value.sceneId !== expected.sceneId) return false;
  const selected = manifest.characters.slice(0, expected.participantCount).map((character) => character.id);
  if (!sameStringsInOrder(value.selectedCharacterIds, selected) || !scoresValid(value.scores, selected)) return false;
  const model = modelForId(config, expected.modelId);
  if (!model || model.role === "text-structured") return false;
  return value.generationOutcome === "PASS"
    ? sceneOutputValid(value, model, expected)
    : typeof value.failureCategory === "string" && value.failureCategory.length > 0;
}

function sceneKeys(outcome: unknown): string[] {
  const base = ["modelId", "participantCount", "sceneId", "selectedCharacterIds", "generationOutcome", "scores"];
  return outcome === "PASS" ? [...base, ...OUTPUT_KEYS] : [...base, "failureCategory"];
}

function sceneOutputValid(
  value: Record<string, unknown>,
  model: ImageModelConfig,
  expected: ReturnType<typeof expectedScenes>[number],
): boolean {
  return isAllowedModelVersion(value.modelVersion, model)
    && isSha256(value.outputSha256)
    && validImageMime(value.outputMimeType)
    && value.outputArtifact === expectedSceneArtifact(model, expected.participantCount, expected.sceneId, value.outputMimeType);
}

function scoresValid(value: unknown, selectedIds: string[]): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["identities", "allSelectedPresent", "noUnselectedDuplicatedOrSwapped"])) return false;
  if (!nullableBoolean(value.allSelectedPresent) || !nullableBoolean(value.noUnselectedDuplicatedOrSwapped)) return false;
  if (!Array.isArray(value.identities) || value.identities.length !== selectedIds.length) return false;
  return value.identities.every((entry, index) => identityScoreValid(entry, selectedIds[index]!));
}

function identityScoreValid(value: unknown, characterId: string): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["characterId", "recognizable", "traitsStable", "clothingFollowed"])) return false;
  return value.characterId === characterId && nullableBoolean(value.recognizable)
    && nullableBoolean(value.traitsStable) && nullableBoolean(value.clothingFollowed);
}

export async function validateReviewBindings(
  review: ReviewDocument,
  context: ReviewBindingContext,
): Promise<boolean> {
  if (review.probeConfigSha256 !== context.probeConfigSha256) return false;
  if (review.fixtureSourceSha256 !== context.fixtureSourceSha256) return false;
  if (!sameHashRecords(review.renderedInputSha256, context.renderedInputSha256)) return false;
  const outputs = reviewOutputs(review);
  for (const output of outputs) {
    if (!await outputArtifactMatches(context.artifactRoot, output)) return false;
  }
  return true;
}

function reviewOutputs(review: ReviewDocument): Array<{
  artifact: string; sha256: string; mimeType: string; modelVersion: string;
}> {
  const attempts = review.referenceLimits.flatMap((result) => result.attempts)
    .filter((attempt) => attempt.outcome === "accepted")
    .map((attempt) => ({
      artifact: attempt.outputArtifact!, sha256: attempt.outputSha256!, mimeType: attempt.outputMimeType!,
      modelVersion: attempt.modelVersion!,
    }));
  const scenes = review.scenes.filter((scene) => scene.generationOutcome === "PASS")
    .map((scene) => ({
      artifact: scene.outputArtifact!, sha256: scene.outputSha256!, mimeType: scene.outputMimeType!,
      modelVersion: scene.modelVersion!,
    }));
  return [...attempts, ...scenes];
}

async function outputArtifactMatches(
  artifactRoot: string,
  output: { artifact: string; sha256: string; mimeType: string; modelVersion: string },
): Promise<boolean> {
  if (!/^outputs\/[a-z0-9-]+\.(png|jpg|webp)$/.test(output.artifact)) return false;
  try {
    const bytes = await readFile(join(artifactRoot, output.artifact));
    if (sha256(bytes) !== output.sha256 || !imageMagicValid(bytes, output.mimeType)) return false;
    const responsePath = output.artifact.replace(/^outputs\//, "responses/").replace(/\.(png|jpg|webp)$/, ".json");
    const response: unknown = JSON.parse(await readFile(join(artifactRoot, responsePath), "utf8"));
    return isRecord(response) && response.modelVersion === output.modelVersion;
  } catch {
    return false;
  }
}

export function reviewComplete(review: ReviewDocument, config: ProbeConfig, manifest: FixtureManifest): boolean {
  if (review.abortReason || review.referenceLimits.length !== config.imageModels.length) return false;
  if (review.referenceLimits.some((result) => result.outcome !== "COMPLETE")) return false;
  if (review.scenes.length !== expectedScenes(config, manifest).length) return false;
  return review.scenes.every((scene) => scene.generationOutcome === "FAIL" || scoresComplete(scene.scores));
}

function scoresComplete(scores: SceneScores): boolean {
  const values = scores.identities.flatMap((score) => [score.recognizable, score.traitsStable, score.clothingFollowed]);
  return [...values, scores.allSelectedPresent, scores.noUnselectedDuplicatedOrSwapped]
    .every((value) => typeof value === "boolean");
}

export async function runReviewValidationSelfCheck(config: ProbeConfig, manifest: FixtureManifest): Promise<void> {
  const hashes = Object.fromEntries(manifest.characters.map((character) => [character.id, "a".repeat(64)]));
  const partial: ReviewDocument = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    credentialSource: "environment",
    probeConfigSha256: "b".repeat(64),
    fixtureSourceSha256: "c".repeat(64),
    renderedInputSha256: hashes,
    referenceLimits: [],
    scenes: [],
  };
  assertSelfCheck(Boolean(parseReviewDocument(partial, config, manifest)), "valid partial review schema accepted");
  assertSelfCheck(!reviewComplete(partial, config, manifest), "partial handcrafted review cannot complete gate");
  const staleContext: ReviewBindingContext = {
    config, manifest, probeConfigSha256: "d".repeat(64), fixtureSourceSha256: partial.fixtureSourceSha256,
    renderedInputSha256: hashes, artifactRoot: "/nonexistent",
  };
  assertSelfCheck(!await validateReviewBindings(partial, staleContext), "stale config binding rejected");
  const incompatible = { ...partial, scenes: [{ modelId: "gemini-unmapped" }] };
  assertSelfCheck(!parseReviewDocument(incompatible, config, manifest), "incompatible output identity rejected");
}

function expectedReferenceArtifact(model: ImageModelConfig, count: number, mimeType: unknown): string {
  return `outputs/${model.role}-reference-limit-${count}.${imageExtension(mimeType)}`;
}

function expectedSceneArtifact(
  model: ImageModelConfig, count: number, sceneId: string, mimeType: unknown,
): string {
  return `outputs/${model.role}-${count}-${sceneId}.${imageExtension(mimeType)}`;
}

function imageExtension(mimeType: unknown): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return mimeType === "image/webp" ? "webp" : "invalid";
}

function imageMagicValid(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return mimeType === "image/webp" && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function validImageMime(value: unknown): value is string {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp";
}

function hashRecordValid(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0 && Object.values(value).every(isSha256);
}

function sameHashRecords(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return sameStringsInOrder(leftKeys, rightKeys) && leftKeys.every((key) => left[key] === right[key]);
}

function nullableBoolean(value: unknown): boolean {
  return value === null || typeof value === "boolean";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return sameStringsInOrder(Object.keys(value).sort(), [...expected].sort());
}

function sameStringsInOrder(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, type GenerateContentResponse, type Part } from "@google/genai";
import { chromium, type Page } from "playwright";

import {
  assertSelfCheck,
  atomicWrite,
  cairoCalendarDate,
  classifyProviderError,
  fileSha256,
  isAllowedModelVersion,
  loadProbeConfig,
  modelConfigs,
  modelForId,
  requireAllowedModelVersion,
  resolveCredential,
  sha256,
  type AnyModelConfig,
  type CredentialResult,
  type CredentialSource,
  type ImageModelConfig,
  type ProbeConfig,
} from "./gemini-probe-support.js";
import {
  parseReviewDocument,
  reviewComplete,
  runReviewValidationSelfCheck,
  validateReviewBindings,
  type AttemptResult,
  type CharacterFixture,
  type FixtureManifest,
  type ReferenceLimitResult,
  type RenderedInput,
  type ReviewDocument,
  type SceneFixture,
  type SceneReview,
  type SceneScores,
} from "./g2-review-validation.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(ROOT, "fixtures", "gemini-phase0.config.json");
const FIXTURE_ROOT = join(ROOT, "fixtures", "g2");
const MANIFEST_PATH = join(FIXTURE_ROOT, "manifest.json");
const EVIDENCE_PATH = join(ROOT, "evidence", "g2-scorecard.md");
const ARTIFACT_ROOT = join(ROOT, ".local-artifacts", "g2");
const REVIEW_PATH = join(ARTIFACT_ROOT, "manual-review.json");
const G4_SUMMARY_PATH = join(ROOT, ".local-artifacts", "g4", "runtime-summary.json");

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStrings(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry) => typeof entry === "string")
    && [...value].sort().every((entry, index) => entry === [...expected].sort()[index]);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${label}`);
  return value;
}

function fail(message: string): never {
  throw new Error(message);
}

async function loadManifest(): Promise<FixtureManifest> {
  const value: unknown = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  assertRecord(value, "G2 fixture manifest");
  if (value.schemaVersion !== 1 || value.fixtureKind !== "deterministic-synthetic-vector"
      || value.fictionalOnly !== true || !Array.isArray(value.characters) || !Array.isArray(value.scenes)) {
    throw new Error("Invalid G2 fixture manifest header");
  }
  const manifest: FixtureManifest = {
    schemaVersion: 1,
    fixtureKind: "deterministic-synthetic-vector",
    fictionalOnly: true,
    characters: value.characters.map(parseCharacter),
    scenes: value.scenes.map(parseScene),
  };
  assertFixtureMatrix(manifest);
  return manifest;
}

function parseCharacter(value: unknown): CharacterFixture {
  assertRecord(value, "character fixture");
  if (!Array.isArray(value.referenceFiles) || value.referenceFiles.length !== 2) {
    fail("Each character needs exactly two reference views");
  }
  return {
    id: requiredString(value.id, "character ID"),
    label: requiredString(value.label, "character label"),
    referenceFiles: [
      requiredString(value.referenceFiles[0], "front reference"),
      requiredString(value.referenceFiles[1], "three-quarter reference"),
    ],
    identityTraits: requiredString(value.identityTraits, "identity traits"),
    clothing: requiredString(value.clothing, "clothing"),
  };
}

function parseScene(value: unknown): SceneFixture {
  assertRecord(value, "scene fixture");
  return {
    id: requiredString(value.id, "scene ID"),
    description: requiredString(value.description, "scene description"),
    action: requiredString(value.action, "scene action"),
  };
}

function assertFixtureMatrix(manifest: FixtureManifest): void {
  const characterIds = manifest.characters.map((item) => item.id);
  const sceneIds = manifest.scenes.map((item) => item.id);
  if (characterIds.length !== 4 || new Set(characterIds).size !== 4) {
    fail("G2 requires exactly four unique synthetic characters");
  }
  if (sceneIds.length !== 5 || new Set(sceneIds).size !== 5) {
    fail("G2 requires exactly five unique controlled scenes");
  }
}

async function g4PassedFor(config: ProbeConfig, configSha256: string): Promise<boolean> {
  try {
    const summary: unknown = JSON.parse(await readFile(G4_SUMMARY_PATH, "utf8"));
    assertRecord(summary, "G4 summary");
    const models = modelConfigs(config);
    if (summary.schemaVersion !== 2 || summary.configSha256 !== configSha256 || summary.gatePass !== true) return false;
    if (!Array.isArray(summary.configuredModelIds) || !sameStrings(summary.configuredModelIds, models.map((model) => model.id))) return false;
    if (!g4ListingValid(summary.listing, models.map((model) => model.id))) return false;
    if (!Array.isArray(summary.directProbes) || summary.directProbes.length !== models.length) return false;
    return models.every((model) => g4DirectProbeValid(summary.directProbes as unknown[], model));
  } catch {
    return false;
  }
}

function g4ListingValid(value: unknown, modelIds: string[]): boolean {
  if (!isRecord(value) || value.outcome !== "PASS" || !isRecord(value.found)) return false;
  const found = value.found;
  return modelIds.every((id) => isRecord(found[id]));
}

function g4DirectProbeValid(values: unknown[], model: AnyModelConfig): boolean {
  const matches = values.filter(
    (value): value is Record<string, unknown> => isRecord(value) && value.requestedModelId === model.id,
  );
  if (matches.length !== 1) return false;
  const probe = matches[0]!;
  if (probe.outcome !== "PASS" || !isAllowedModelVersion(probe.modelVersion, model)) return false;
  if (!isSha256(probe.outputSha256)) return false;
  return model.role === "text-structured"
    ? probe.outputMimeType === "application/json"
    : typeof probe.outputMimeType === "string" && probe.outputMimeType.startsWith("image/");
}

async function fixtureSourceHash(manifest: FixtureManifest): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(MANIFEST_PATH));
  for (const character of manifest.characters) {
    for (const file of character.referenceFiles) hash.update(await readFile(join(FIXTURE_ROOT, file)));
  }
  return hash.digest("hex");
}

async function renderInputs(
  manifest: FixtureManifest,
): Promise<{ characterRefs: RenderedInput[]; objectRefs: RenderedInput[] }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 512 } });
    const characterRefs: RenderedInput[] = [];
    for (const character of manifest.characters) {
      characterRefs.push(await renderCharacterSheet(page, character));
    }
    const objectRefs: RenderedInput[] = [];
    for (let index = 1; index <= 15; index += 1) {
      objectRefs.push(await renderObjectReference(page, index));
    }
    return { characterRefs, objectRefs };
  } finally {
    await browser.close();
  }
}

async function renderCharacterSheet(page: Page, character: CharacterFixture): Promise<RenderedInput> {
  const [front, threeQuarter] = await Promise.all(
    character.referenceFiles.map((file) => readFile(join(FIXTURE_ROOT, file), "utf8")),
  );
  const html = `<style>html,body{margin:0;background:#fff}#sheet{display:flex;width:1024px;height:512px}svg{width:512px;height:512px}</style><div id="sheet">${front}${threeQuarter}</div>`;
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  const bytes = await page.locator("#sheet").screenshot({ animations: "disabled", type: "png" });
  const path = join(ARTIFACT_ROOT, "references", `${character.id}.png`);
  await atomicWrite(path, bytes);
  return { id: character.id, bytes, sha256: sha256(bytes) };
}

async function renderObjectReference(page: Page, index: number): Promise<RenderedInput> {
  const hue = (index * 41) % 360;
  const sides = 3 + (index % 6);
  const points = polygonPoints(128, 128, 78, sides, index * 0.17);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#fff8df"/><polygon points="${points}" fill="hsl(${hue} 72% 52%)" stroke="#252631" stroke-width="9"/><circle cx="128" cy="128" r="18" fill="#ffd83d"/></svg>`;
  await page.setContent(`<style>html,body{margin:0;width:256px;height:256px}</style>${svg}`);
  const bytes = await page.locator("svg").screenshot({ animations: "disabled", type: "png" });
  const id = `object-${String(index).padStart(2, "0")}`;
  await atomicWrite(join(ARTIFACT_ROOT, "object-references", `${id}.png`), bytes);
  return { id, bytes, sha256: sha256(bytes) };
}

function polygonPoints(cx: number, cy: number, radius: number, sides: number, offset: number): string {
  return Array.from({ length: sides }, (_, index) => {
    const angle = offset + (Math.PI * 2 * index) / sides;
    return `${(cx + Math.cos(angle) * radius).toFixed(2)},${(cy + Math.sin(angle) * radius).toFixed(2)}`;
  }).join(" ");
}

function imageParts(inputs: RenderedInput[]): Part[] {
  return inputs.flatMap((input, index): Part[] => [
    { text: `Synthetic reference ${index + 1}: ${input.id}.` },
    { inlineData: { mimeType: "image/png", data: input.bytes.toString("base64") } },
  ]);
}

function firstImage(response: GenerateContentResponse): { bytes: Buffer; mimeType: string } | undefined {
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const data = part.inlineData?.data;
      const mimeType = part.inlineData?.mimeType;
      if (typeof data !== "string" || typeof mimeType !== "string") continue;
      const bytes = Buffer.from(data, "base64");
      if (validImageMagic(bytes, mimeType)) return { bytes, mimeType };
    }
  }
  return undefined;
}

function validImageMagic(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return mimeType === "image/webp"
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function imageExtension(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return "webp";
}

async function generateImage(
  ai: GoogleGenAI,
  model: ImageModelConfig,
  prompt: string,
  inputs: RenderedInput[],
  artifactStem: string,
  referenceBoundary = false,
): Promise<AttemptResult> {
  try {
    const response = await ai.models.generateContent({
      model: model.id,
      contents: [{ text: prompt }, ...imageParts(inputs)],
      config: {
        httpOptions: { timeout: 180_000 },
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: "1:1", imageSize: model.probeImageSize },
      },
    });
    const modelVersion = requireAllowedModelVersion(response.modelVersion, model);
    const image = firstImage(response);
    if (!image) return { outcome: "inconclusive", failureCategory: "output_validation" };
    const safeStem = artifactStem.replace(/[^a-z0-9-]/g, "-");
    const outputArtifact = `outputs/${safeStem}.${imageExtension(image.mimeType)}`;
    await writeProviderPayload(join(ARTIFACT_ROOT, "responses", `${safeStem}.json`), response);
    await atomicWrite(join(ARTIFACT_ROOT, outputArtifact), image.bytes);
    return {
      outcome: "accepted",
      modelVersion,
      outputSha256: sha256(image.bytes),
      outputMimeType: image.mimeType,
      outputArtifact,
    };
  } catch (error) {
    const classified = classifyProviderError(error, referenceBoundary);
    return { outcome: classified.outcome, failureCategory: classified.category };
  }
}

async function writeProviderPayload(path: string, response: GenerateContentResponse): Promise<void> {
  const payload = {
    candidates: response.candidates,
    modelVersion: response.modelVersion,
    promptFeedback: response.promptFeedback,
    responseId: response.responseId,
    usageMetadata: response.usageMetadata,
  };
  await atomicWrite(path, `${JSON.stringify(payload, null, 2)}\n`);
}

async function probeReferenceLimit(
  ai: GoogleGenAI, model: ImageModelConfig, objects: RenderedInput[], characters: RenderedInput[],
): Promise<ReferenceLimitResult> {
  const attempts: ReferenceLimitResult["attempts"] = [];
  const attempt = async (count: number): Promise<AttemptResult> => {
    const result = await generateImage(
      ai,
      model,
      "Arrange every supplied synthetic reference once in a neat catalog grid. Keep fictional characters stylized; no text.",
      referenceLimitInputs(model, objects, characters, count),
      `${model.role}-reference-limit-${count}`,
      true,
    );
    attempts.push({ count, ...result });
    return result;
  };
  const documented = model.documentedMaxReferences;
  const atDocumented = await attempt(documented);
  if (atDocumented.outcome === "inconclusive") return inconclusiveLimit(model, attempts);
  if (atDocumented.outcome === "accepted") {
    const above = await attempt(documented + 1);
    if (above.outcome === "inconclusive") return inconclusiveLimit(model, attempts);
    return {
      modelId: model.id,
      documentedMax: documented,
      outcome: "COMPLETE",
      maxAccepted: above.outcome === "accepted" ? documented + 1 : documented,
      exceedsDocumentedMaximum: above.outcome === "accepted",
      attempts,
    };
  }
  return searchLowerReferenceBoundary(ai, model, objects, characters, attempts);
}

function referenceLimitInputs(model: ImageModelConfig, objects: RenderedInput[], characters: RenderedInput[], count: number): RenderedInput[] {
  const characterLimit = model.documentedMaxCharacterReferences ?? 0;
  if (characterLimit === 0) return objects.slice(0, count);
  const documentedObjectLimit = model.documentedMaxReferences - characterLimit;
  const characterCount = count > model.documentedMaxReferences ? characterLimit : Math.max(0, count - documentedObjectLimit);
  return [...objects.slice(0, count - characterCount), ...characters.slice(0, characterCount)];
}

function inconclusiveLimit(model: ImageModelConfig, attempts: ReferenceLimitResult["attempts"]): ReferenceLimitResult {
  return {
    modelId: model.id,
    documentedMax: model.documentedMaxReferences,
    outcome: "INCONCLUSIVE",
    exceedsDocumentedMaximum: false,
    attempts,
  };
}

async function searchLowerReferenceBoundary(
  ai: GoogleGenAI, model: ImageModelConfig, objects: RenderedInput[], characters: RenderedInput[],
  attempts: ReferenceLimitResult["attempts"],
): Promise<ReferenceLimitResult> {
  let low = 0;
  let high = model.documentedMaxReferences - 1;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    const result = await generateImage(
      ai,
      model,
      "Arrange every supplied synthetic reference once in a neat catalog grid. Keep fictional characters stylized; no text.",
      referenceLimitInputs(model, objects, characters, count),
      `${model.role}-reference-limit-${count}`,
      true,
    );
    attempts.push({ count, ...result });
    if (result.outcome === "inconclusive") return inconclusiveLimit(model, attempts);
    if (result.outcome === "accepted") low = count;
    else high = count - 1;
  }
  return {
    modelId: model.id,
    documentedMax: model.documentedMaxReferences,
    outcome: "COMPLETE",
    maxAccepted: low,
    exceedsDocumentedMaximum: false,
    attempts,
  };
}

function scenePrompt(selected: CharacterFixture[], scene: SceneFixture): string {
  const roster = selected.map((character, index) => [
    `Character ${index + 1} (${character.label}) must retain ${character.identityTraits};`,
    `clothing must remain ${character.clothing}.`,
  ].join(" ")).join(" ");
  return [
    "Create one square flat-vector children's-book illustration using only the selected fictional characters.",
    `Scene: ${scene.description}; they are ${scene.action}.`,
    roster,
    "Every selected character must appear exactly once, at comparable scale, fully visible, and clearly separated.",
    "Do not add, omit, duplicate, merge, age-shift, or swap any person. No text, logos, or photorealism.",
    "Each supplied reference contact sheet shows front and three-quarter views of one character.",
  ].join(" ");
}

function emptyScores(selected: CharacterFixture[]): SceneScores {
  return {
    identities: selected.map((character) => ({
      characterId: character.id,
      recognizable: null,
      traitsStable: null,
      clothingFollowed: null,
    })),
    allSelectedPresent: null,
    noUnselectedDuplicatedOrSwapped: null,
  };
}

async function runSceneMatrix(
  ai: GoogleGenAI,
  model: ImageModelConfig,
  manifest: FixtureManifest,
  characterRefs: RenderedInput[],
  onReview: (review: SceneReview) => Promise<void>,
): Promise<boolean> {
  for (let participantCount = 1; participantCount <= 4; participantCount += 1) {
    const selected = manifest.characters.slice(0, participantCount);
    for (const scene of manifest.scenes) {
      const result = await generateImage(
        ai,
        model,
        scenePrompt(selected, scene),
        characterRefs.slice(0, participantCount),
        `${model.role}-${participantCount}-${scene.id}`,
      );
      const review: SceneReview = {
        modelId: model.id,
        participantCount,
        sceneId: scene.id,
        selectedCharacterIds: selected.map((character) => character.id),
        generationOutcome: result.outcome === "accepted" ? "PASS" : "FAIL",
        modelVersion: result.modelVersion,
        outputSha256: result.outputSha256,
        outputMimeType: result.outputMimeType,
        outputArtifact: result.outputArtifact,
        failureCategory: result.failureCategory,
        scores: emptyScores(selected),
      };
      await onReview(review);
      if (result.outcome === "inconclusive") return true;
    }
  }
  return false;
}

function sceneSuccess(review: SceneReview): boolean | null {
  if (review.generationOutcome === "FAIL") return false;
  const identityValues = review.scores.identities.flatMap((score) => [
    score.recognizable,
    score.traitsStable,
    score.clothingFollowed,
  ]);
  const values = [
    ...identityValues,
    review.scores.allSelectedPresent,
    review.scores.noUnselectedDuplicatedOrSwapped,
  ];
  if (values.some((value) => value === null)) return null;
  return values.every((value) => value === true);
}

function successfulSceneCount(
  review: ReviewDocument | undefined,
  modelId: string,
  count: number,
): number | null {
  const rows = review?.scenes.filter(
    (scene) => scene.modelId === modelId && scene.participantCount === count,
  ) ?? [];
  if (rows.length !== 5) return null;
  const values = rows.map(sceneSuccess);
  if (values.some((value) => value === null)) return null;
  return values.filter((value) => value === true).length;
}

function scoreCell(review: ReviewDocument | undefined, modelId: string, count: number): string {
  const rows = review?.scenes.filter(
    (scene) => scene.modelId === modelId && scene.participantCount === count,
  ) ?? [];
  if (rows.length === 0) return "pending";
  if (rows.length !== 5) return "incomplete";
  const successes = successfulSceneCount(review, modelId, count);
  return successes === null ? "pending review" : `${successes}/5`;
}

function reliableCount(review: ReviewDocument | undefined, modelId: string): string {
  if (!review) return "pending";
  const counts = [1, 2, 3, 4].map((count) => successfulSceneCount(review, modelId, count));
  if (counts.some((count) => count === null)) return "pending";
  let reliable = 0;
  counts.forEach((count, index) => {
    if ((count ?? 0) >= 4) reliable = index + 1;
  });
  return String(reliable);
}

function referenceLimitCell(review: ReviewDocument | undefined, model: ImageModelConfig): string {
  const result = review?.referenceLimits.find((item) => item.modelId === model.id);
  if (!result) return `docs: ${model.documentedMaxReferences}; runtime pending`;
  if (result.outcome === "INCONCLUSIVE") return "inconclusive";
  const warning = result.maxAccepted !== result.documentedMax ? " (documented-limit mismatch)" : "";
  return `${result.maxAccepted ?? 0}${warning}`;
}

function outputHashes(review: ReviewDocument | undefined, modelId: string, count: number): string {
  const rows = review?.scenes.filter(
    (scene) => scene.modelId === modelId && scene.participantCount === count,
  ) ?? [];
  if (rows.length === 0) return "none";
  return rows.map((row) => `${row.sceneId}=\`${row.outputSha256?.slice(0, 16) ?? "generation-failed"}\``).join("; ");
}

function gatePass(
  review: ReviewDocument | undefined,
  config: ProbeConfig,
  manifest: FixtureManifest,
  bindingsValidated: boolean,
): boolean {
  if (!bindingsValidated || !review || !reviewComplete(review, config, manifest)) return false;
  const defaultModel = config.imageModels.find((model) => model.role === "default-image");
  if (!defaultModel || (successfulSceneCount(review, defaultModel.id, 1) ?? 0) < 4) return false;
  return review!.referenceLimits.every((result) => result.maxAccepted === result.documentedMax);
}

function evidenceStatus(
  review: ReviewDocument | undefined,
  config: ProbeConfig,
  manifest: FixtureManifest,
  bindingsValidated: boolean,
  unavailableReason?: string,
): string {
  if (unavailableReason) return `FAIL (${unavailableReason}) — no provider calls made`;
  if (review?.abortReason) return `FAIL — paid calls stopped after ${review.abortReason}`;
  if (!review || !reviewComplete(review, config, manifest)) {
    return "PENDING — generated outputs require rubric review or runtime evidence is incomplete";
  }
  if (!bindingsValidated) return "FAIL — review evidence is unvalidated, stale, or incompatible";
  return gatePass(review, config, manifest, true)
    ? "PASS"
    : "FAIL — catastrophic baseline or documented-limit mismatch";
}

function renderEvidence(config: ProbeConfig, manifest: FixtureManifest,
  review: ReviewDocument | undefined,
  bindingsValidated = false,
  unavailableReason?: string,
  sourceHash?: string,
  configHash?: string,
): string {
  const checked = cairoCalendarDate(review?.generatedAt ?? new Date().toISOString()), resultRows = config.imageModels.map((model) => `| \`${model.id}\` | ${[1, 2, 3, 4].map((count) => scoreCell(review, model.id, count)).join(" | ")} | ${referenceLimitCell(review, model)} | ${reliableCount(review, model.id)} |`), hashRows = config.imageModels.flatMap((model) => [1, 2, 3, 4].map((count) => `| \`${model.id}\` | ${count} | ${outputHashes(review, model.id, count)} |`));
  return `# G2 — Gemini Reference Consistency Scorecard

**Task**: T-P0-05

**Checked**: ${checked}

**Status**: ${evidenceStatus(review, config, manifest, bindingsValidated, unavailableReason)}

## Fixture and privacy

- Four fictional vector-illustrated characters, created deterministically for this probe; no real person/customer resemblance or data.
- Two source views per character are composited into one PNG contact sheet, keeping the four-character run within the documented four character-reference-image allowance.
- Fixture kind: \`${manifest.fixtureKind}\`; source SHA-256: \`${review?.fixtureSourceSha256 ?? sourceHash ?? "not rendered"}\`.
- Probe configuration SHA-256: \`${review?.probeConfigSha256 ?? configHash ?? "not recorded"}\`.
- Raw references, provider payloads, and generated outputs remain under ignored \`spikes/.local-artifacts/g2/\`.

## Predeclared reproducible protocol

- For each configured image model, run exactly five controlled scenes for each participant count 1, 2, 3, and 4 (20 identity calls per model, no automatic retry).
- Participant selection is the first N characters in \`fixtures/g2/manifest.json\`; scene order is the five-entry manifest order.
- A scene succeeds only when every selected fictional identity is recognizable, identity traits remain stable, clothing is followed, every selected participant is present, and no unselected, duplicated, merged, or swapped person appears.
- Single-character baseline PASS: at least 4 of 5 scenes succeed.
- \`reliableCharacterCount\`: largest participant count whose five-scene set meets the same ≥4/5 threshold.
- Reference-limit procedure sends each model's documented subtype mix up to ${config.imageModels[0]?.documentedMaxReferences} total references (configured character-reference cap plus synthetic objects; objects only where no separate character cap is documented), then one above that total. If the documented maximum is rejected as input, a no-retry binary search measures the lower boundary. Quota, auth, timeout, model, or provider failures are inconclusive—not reference-limit evidence.
- HTTP 400 / \`INVALID_ARGUMENT\` counts as a reference boundary only when structured provider details unambiguously identify reference count or type; otherwise it is inconclusive.
- Any inconclusive reference prerequisite or global auth, quota/rate, model, timeout, version, or provider-contract failure stops remaining paid calls and atomically preserves partial review evidence.
- Human review is recorded in ignored \`.local-artifacts/g2/manual-review.json\`; rerun \`npm run g2 -- --review-only\` to recompute sanitized evidence without provider calls.
- Catastrophic default-model result: one referenced fictional character cannot meet 4/5, usable reference-image generation is unavailable, or the measured input boundary contradicts the configured documented maximum.

## Results

| Model | 1 character | 2 characters | 3 characters | 4 characters | max refs accepted | reliable count |
|---|---:|---:|---:|---:|---:|---:|
${resultRows.join("\n")}

## Sanitized output hashes

| Model | Participants | Five scene outputs |
|---|---:|---|
${hashRows.join("\n")}

## Gate decision

**${gatePass(review, config, manifest, bindingsValidated) ? "PASS" : "FAIL / PENDING"}**. A PASS additionally requires schema-valid review JSON bound to the current probe configuration, fixture sources, rendered inputs, exact model versions, scene identities, and on-disk output hashes. No empirical identity claim may be promoted earlier. No alias, preview ID, model substitution, fallback, or real-person fixture is permitted.
`;
}

async function loadExistingReview(config: ProbeConfig, manifest: FixtureManifest): Promise<ReviewDocument | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(REVIEW_PATH, "utf8"));
    return parseReviewDocument(value, config, manifest);
  } catch {
    return undefined;
  }
}

async function writeUnavailableEvidence(
  config: ProbeConfig,
  manifest: FixtureManifest,
  reason: string,
): Promise<void> {
  const sourceHash = await fixtureSourceHash(manifest);
  const configHash = await fileSha256(CONFIG_PATH);
  await atomicWrite(EVIDENCE_PATH, renderEvidence(config, manifest, undefined, false, reason, sourceHash, configHash));
  console.log("G2 FAIL: prerequisite unavailable; no provider calls were made.");
  process.exitCode = 1;
}

async function runLive(
  config: ProbeConfig,
  manifest: FixtureManifest,
  credential: Required<CredentialResult>,
  probeConfigSha256: string,
): Promise<ReviewDocument> {
  const rendered = await renderInputs(manifest);
  const ai = new GoogleGenAI({ apiKey: credential.apiKey });
  const allInputs = [...rendered.characterRefs, ...rendered.objectRefs];
  const review: ReviewDocument = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    credentialSource: credential.source as Exclude<CredentialSource, "none">,
    probeConfigSha256,
    fixtureSourceSha256: await fixtureSourceHash(manifest),
    renderedInputSha256: Object.fromEntries(allInputs.map((input) => [input.id, input.sha256])),
    referenceLimits: [],
    scenes: [],
  };
  await persistReview(review);
  for (const model of config.imageModels) {
    const referenceResult = await probeReferenceLimit(ai, model, rendered.objectRefs, rendered.characterRefs);
    review.referenceLimits.push(referenceResult);
    await persistReview(review);
    if (referenceResult.outcome === "INCONCLUSIVE") {
      review.abortReason = `reference_prerequisite:${referenceResult.attempts.at(-1)?.failureCategory ?? "inconclusive"}`;
      await persistReview(review);
      return review;
    }
    const aborted = await runSceneMatrix(ai, model, manifest, rendered.characterRefs, async (scene) => {
      review.scenes.push(scene);
      await persistReview(review);
    });
    if (aborted) {
      review.abortReason = `global_provider:${review.scenes.at(-1)?.failureCategory ?? "inconclusive"}`;
      await persistReview(review);
      return review;
    }
  }
  return review;
}

async function persistReview(review: ReviewDocument): Promise<void> {
  await atomicWrite(REVIEW_PATH, `${JSON.stringify(review, null, 2)}\n`);
}

async function reviewOnly(config: ProbeConfig, manifest: FixtureManifest): Promise<void> {
  const review = await loadExistingReview(config, manifest);
  if (!review) {
    await writeUnavailableEvidence(config, manifest, "review-invalid-or-unavailable");
    return;
  }
  const rendered = await renderInputs(manifest);
  const probeConfigSha256 = await fileSha256(CONFIG_PATH);
  const fixtureHash = await fixtureSourceHash(manifest);
  const renderedHashes = Object.fromEntries(
    [...rendered.characterRefs, ...rendered.objectRefs].map((input) => [input.id, input.sha256]),
  );
  const bindingsValidated = await validateReviewBindings(review, {
    config, manifest, probeConfigSha256, fixtureSourceSha256: fixtureHash,
    renderedInputSha256: renderedHashes, artifactRoot: ARTIFACT_ROOT,
  });
  if (!bindingsValidated) {
    await writeUnavailableEvidence(config, manifest, "review-stale-or-incompatible");
    return;
  }
  await atomicWrite(EVIDENCE_PATH, renderEvidence(config, manifest, review, true));
  console.log(gatePass(review, config, manifest, true)
    ? "G2 PASS: reviewed synthetic matrix meets the predeclared gate."
    : "G2 FAIL / PENDING: reviewed synthetic matrix does not yet meet the gate.");
  process.exitCode = gatePass(review, config, manifest, true) ? 0 : 1;
}

async function main(): Promise<void> {
  const config = await loadProbeConfig(CONFIG_PATH);
  const manifest = await loadManifest();
  if (process.argv.includes("--self-check")) {
    await runSelfCheck(config, manifest);
    return;
  }
  if (process.argv.includes("--review-only")) {
    await reviewOnly(config, manifest);
    return;
  }
  const credential = await resolveCredential(config.keychainService);
  if (!credential.apiKey) {
    await writeUnavailableEvidence(config, manifest, "environment");
    return;
  }
  const probeConfigSha256 = await fileSha256(CONFIG_PATH);
  if (!await g4PassedFor(config, probeConfigSha256)) {
    await writeUnavailableEvidence(config, manifest, "G4-prerequisite");
    return;
  }
  const review = await runLive(config, manifest, credential as Required<CredentialResult>, probeConfigSha256);
  await atomicWrite(EVIDENCE_PATH, renderEvidence(config, manifest, review));
  console.log(review.abortReason
    ? "G2 FAIL: paid calls stopped after an inconclusive global prerequisite; partial evidence was preserved."
    : "G2 PENDING: synthetic outputs generated; complete manual rubric review, then use --review-only.");
  process.exitCode = 1;
}

async function runSelfCheck(config: ProbeConfig, manifest: FixtureManifest): Promise<void> {
  await runReviewValidationSelfCheck(config, manifest);
  const ambiguous400 = classifyProviderError({ status: 400 }, true);
  assertSelfCheck(ambiguous400.outcome === "inconclusive", "unstructured HTTP 400 is inconclusive");
  const explicitLimit = classifyProviderError({
    status: 400,
    details: [{ reason: "REFERENCE_IMAGE_LIMIT_EXCEEDED" }],
  }, true);
  assertSelfCheck(explicitLimit.outcome === "input_rejected", "structured reference-limit reason accepted");
  for (const model of config.imageModels) {
    assertSelfCheck(isAllowedModelVersion(model.id, model), `${model.role} exact model version accepted`);
    assertSelfCheck(!isAllowedModelVersion(undefined, model), `${model.role} missing model version rejected`);
  }
  console.log("G2 self-check PASS: review binding, error classification, and model-version guards fail closed.");
}

main().catch(() => {
  console.error("G2 FAIL: probe could not complete safely; no sensitive error detail was emitted.");
  process.exitCode = 1;
});

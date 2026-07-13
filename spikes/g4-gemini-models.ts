import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GoogleGenAI,
  type GenerateContentResponse,
  type Model,
  type Part,
} from "@google/genai";

import {
  assertSelfCheck,
  atomicWrite,
  cairoCalendarDate,
  classifyProviderError,
  fileSha256,
  isAllowedModelVersion,
  loadProbeConfig,
  modelConfigs,
  requireAllowedModelVersion,
  resolveCredential,
  safeProviderToken,
  sha256,
  type CredentialResult,
  type ImageModelConfig,
  type ProbeConfig,
  type TextModelConfig,
} from "./gemini-probe-support.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(ROOT, "fixtures", "gemini-phase0.config.json");
const EVIDENCE_PATH = join(ROOT, "evidence", "g4-scorecard.md");
const ARTIFACT_ROOT = join(ROOT, ".local-artifacts", "g4");
const SUMMARY_PATH = join(ARTIFACT_ROOT, "runtime-summary.json");

type Outcome = "PASS" | "FAIL" | "NOT_RUN";

interface ModelListingResult {
  outcome: Outcome;
  found: Record<string, { version?: string; supportedActions: string[] }>;
  failureCategory?: string;
}

interface DirectProbeResult {
  requestedModelId: string;
  role: string;
  outcome: Outcome;
  modelVersion?: string;
  outputMimeType?: string;
  outputBytes?: number;
  outputSha256?: string;
  failureCategory?: string;
}

interface RuntimeSummary {
  schemaVersion: 2;
  checkedAt: string;
  sdkVersion: string;
  configSha256: string;
  credentialSource: CredentialResult["source"];
  configuredModelIds: string[];
  listing: ModelListingResult;
  directProbes: DirectProbeResult[];
  gatePass: boolean;
}

function canonicalModelName(model: Model): string | undefined {
  const name = model.name;
  if (typeof name !== "string") return undefined;
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

async function listConfiguredModels(
  ai: GoogleGenAI,
  configuredIds: string[],
): Promise<ModelListingResult> {
  try {
    const found: ModelListingResult["found"] = {};
    const pager = await ai.models.list({ config: { pageSize: 100, queryBase: true, httpOptions: { timeout: 60_000 } } });
    for await (const model of pager) {
      const id = canonicalModelName(model);
      if (id && configuredIds.includes(id)) {
        found[id] = {
          version: safeProviderToken(model.version),
          supportedActions: (model.supportedActions ?? []).filter(
            (action): action is string => typeof action === "string" && action.length < 100,
          ),
        };
      }
      if (Object.keys(found).length === configuredIds.length) break;
    }
    return {
      outcome: configuredIds.every((id) => found[id]) ? "PASS" : "FAIL",
      found,
      failureCategory: configuredIds.every((id) => found[id]) ? undefined : "configured_id_not_listed",
    };
  } catch (error) {
    return { outcome: "FAIL", found: {}, failureCategory: classifyError(error) };
  }
}

function classifyError(error: unknown): string {
  return classifyProviderError(error, false).category;
}

async function probeStructuredText(
  ai: GoogleGenAI,
  model: TextModelConfig,
): Promise<DirectProbeResult> {
  let observedModelVersion: string | undefined;
  try {
    const response = await ai.models.generateContent({
      model: model.id,
      contents: "Return the fixed synthetic Phase 0 probe object. Do not add fields.",
      config: {
        httpOptions: { timeout: 60_000 },
        temperature: 0,
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          additionalProperties: false,
          required: ["probe", "count"],
          properties: {
            probe: { type: "string", enum: ["HEKAYATI_G4_OK"] },
            count: { type: "integer", enum: [1] },
          },
        },
      },
    });
    observedModelVersion = safeProviderToken(response.modelVersion);
    const modelVersion = requireAllowedModelVersion(response.modelVersion, model);
    const text = response.text;
    const output = text ? JSON.parse(text) as unknown : undefined;
    if (!validStructuredOutput(output)) throw new Error("output_validation");
    await writeRawPayload("text-response.json", response);
    return {
      requestedModelId: model.id,
      role: model.role,
      outcome: "PASS",
      modelVersion,
      outputMimeType: "application/json",
      outputBytes: Buffer.byteLength(text ?? "", "utf8"),
      outputSha256: sha256(Buffer.from(text ?? "", "utf8")),
    };
  } catch (error) {
    return failureResult(model.id, model.role, error, observedModelVersion);
  }
}

function validStructuredOutput(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && record.probe === "HEKAYATI_G4_OK"
    && record.count === 1;
}

async function probeImage(
  ai: GoogleGenAI,
  model: ImageModelConfig,
): Promise<DirectProbeResult> {
  let observedModelVersion: string | undefined;
  try {
    const response = await ai.models.generateContent({
      model: model.id,
      contents: [
        "Create one square flat-vector image containing only a yellow lemon,",
        "a teal circle, and an orange triangle on a plain cream background.",
        "No people, faces, letters, logos, or realistic subjects.",
      ].join(" "),
      config: {
        httpOptions: { timeout: 120_000 },
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: "1:1", imageSize: model.probeImageSize },
      },
    });
    observedModelVersion = safeProviderToken(response.modelVersion);
    const modelVersion = requireAllowedModelVersion(response.modelVersion, model);
    const image = firstValidImage(response);
    if (!image) throw new Error("output_validation");
    const bytes = Buffer.from(image.data, "base64");
    await writeRawPayload(`${model.role}-response.json`, response);
    await atomicWrite(join(ARTIFACT_ROOT, `${model.role}.${extensionFor(image.mimeType)}`), bytes);
    return {
      requestedModelId: model.id,
      role: model.role,
      outcome: "PASS",
      modelVersion,
      outputMimeType: image.mimeType,
      outputBytes: bytes.byteLength,
      outputSha256: sha256(bytes),
    };
  } catch (error) {
    return failureResult(model.id, model.role, error, observedModelVersion);
  }
}

function firstValidImage(response: GenerateContentResponse): { data: string; mimeType: string } | undefined {
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const image = validInlineImage(part);
      if (image) return image;
    }
  }
  return undefined;
}

function validInlineImage(part: Part): { data: string; mimeType: string } | undefined {
  const data = part.inlineData?.data;
  const mimeType = part.inlineData?.mimeType;
  if (typeof data !== "string" || typeof mimeType !== "string" || data.length < 100) return undefined;
  const bytes = Buffer.from(data, "base64");
  return hasExpectedMagic(bytes, mimeType) ? { data, mimeType } : undefined;
}

function hasExpectedMagic(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/webp") {
    return bytes.subarray(0, 4).toString("ascii") === "RIFF"
      && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

function failureResult(
  modelId: string, role: string, error: unknown, observedModelVersion?: string,
): DirectProbeResult {
  const validationFailure = error instanceof Error && error.message === "output_validation";
  return {
    requestedModelId: modelId,
    role,
    outcome: "FAIL",
    modelVersion: observedModelVersion,
    failureCategory: validationFailure ? "output_validation" : classifyError(error),
  };
}

function extensionFor(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return "webp";
}

async function writeRawPayload(name: string, response: GenerateContentResponse): Promise<void> {
  const payload = {
    candidates: response.candidates,
    modelVersion: response.modelVersion,
    promptFeedback: response.promptFeedback,
    responseId: response.responseId,
    usageMetadata: response.usageMetadata,
  };
  await atomicWrite(join(ARTIFACT_ROOT, name), `${JSON.stringify(payload, null, 2)}\n`);
}

async function readSdkVersion(): Promise<string> {
  const packagePath = join(ROOT, "node_modules", "@google", "genai", "package.json");
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : "unknown";
}

function unconfiguredSummary(config: ProbeConfig, sdkVersion: string, configSha256: string): RuntimeSummary {
  const ids = modelConfigs(config).map((model) => model.id);
  return {
    schemaVersion: 2,
    checkedAt: new Date().toISOString(),
    sdkVersion,
    configSha256,
    credentialSource: "none",
    configuredModelIds: ids,
    listing: { outcome: "NOT_RUN", found: {}, failureCategory: "credential_unavailable" },
    directProbes: modelConfigs(config).map((model) => ({
      requestedModelId: model.id,
      role: model.role,
      outcome: "NOT_RUN",
      failureCategory: "credential_unavailable",
    })),
    gatePass: false,
  };
}

async function runConfiguredProbe(
  config: ProbeConfig,
  credential: Required<CredentialResult>,
  sdkVersion: string,
  configSha256: string,
): Promise<RuntimeSummary> {
  const ai = new GoogleGenAI({ apiKey: credential.apiKey });
  const configuredIds = modelConfigs(config).map((model) => model.id);
  const listing = await listConfiguredModels(ai, configuredIds);
  const directProbes = listing.outcome === "PASS"
    ? await runDirectProbesFailClosed(ai, config)
    : notRunProbes(config, `listing_prerequisite_${listing.failureCategory ?? "failed"}`);
  return {
    schemaVersion: 2,
    checkedAt: new Date().toISOString(),
    sdkVersion,
    configSha256,
    credentialSource: credential.source,
    configuredModelIds: configuredIds,
    listing,
    directProbes,
    gatePass: listing.outcome === "PASS" && directProbeSetValid(config, directProbes),
  };
}

function directProbeSetValid(config: ProbeConfig, probes: DirectProbeResult[]): boolean {
  const models = modelConfigs(config);
  if (probes.length !== models.length) return false;
  return models.every((model) => {
    const matches = probes.filter((probe) => probe.requestedModelId === model.id);
    return matches.length === 1 && matches[0]?.outcome === "PASS"
      && isAllowedModelVersion(matches[0].modelVersion, model);
  });
}

async function runDirectProbesFailClosed(ai: GoogleGenAI, config: ProbeConfig): Promise<DirectProbeResult[]> {
  const results: DirectProbeResult[] = [];
  const textResult = await probeStructuredText(ai, config.textModel);
  results.push(textResult);
  if (textResult.outcome !== "PASS") {
    return [...results, ...notRunImageProbes(config.imageModels, "aborted_after_global_failure")];
  }
  for (let index = 0; index < config.imageModels.length; index += 1) {
    const result = await probeImage(ai, config.imageModels[index]!);
    results.push(result);
    if (result.outcome !== "PASS") {
      results.push(...notRunImageProbes(config.imageModels.slice(index + 1), "aborted_after_global_failure"));
      break;
    }
  }
  return results;
}

function notRunProbes(config: ProbeConfig, category: string): DirectProbeResult[] {
  return modelConfigs(config).map((model) => notRunProbe(model.id, model.role, category));
}

function notRunImageProbes(models: ImageModelConfig[], category: string): DirectProbeResult[] {
  return models.map((model) => notRunProbe(model.id, model.role, category));
}

function notRunProbe(modelId: string, role: string, category: string): DirectProbeResult {
  return { requestedModelId: modelId, role, outcome: "NOT_RUN", failureCategory: category };
}

function listingCell(summary: RuntimeSummary, id: string): string {
  if (summary.listing.outcome === "NOT_RUN") return "not run";
  return summary.listing.found[id] ? "listed" : `not verified (${summary.listing.failureCategory ?? "unknown"})`;
}

function probeCell(probe: DirectProbeResult): string {
  if (probe.outcome === "PASS") {
    const imageDetails = probe.outputMimeType?.startsWith("image/")
      ? `; ${probe.outputMimeType}, ${probe.outputBytes} bytes, SHA-256 \`${probe.outputSha256}\``
      : `; schema-valid JSON, SHA-256 \`${probe.outputSha256}\``;
    return `PASS${imageDetails}`;
  }
  if (probe.outcome === "NOT_RUN") return `not run (${probe.failureCategory})`;
  return `FAIL (${probe.failureCategory ?? "unknown"})`;
}

function renderEvidence(summary: RuntimeSummary, config: ProbeConfig): string {
  const date = cairoCalendarDate(summary.checkedAt);
  const status = summary.gatePass ? "PASS — all exact IDs listed and directly verified" : summary.credentialSource === "none" ? "FAIL (environment) — credential unavailable; no provider calls made" : "FAIL — one or more account-level checks did not pass";
  const rows = [config.textModel, ...config.imageModels].map((model) => { const probe = summary.directProbes.find((item) => item.requestedModelId === model.id); const observedVersion = probe?.modelVersion ? `\`${probe.modelVersion}\`` : "not observed"; return `| \`${model.id}\` | ${model.role} | ${listingCell(summary, model.id)} | ${observedVersion} | ${probe ? probeCell(probe) : "not run"} |`; });
  return `# G4 — Gemini Model and Account Availability Scorecard

**Task**: T-P0-04

**Checked**: ${date}

**Status**: ${status}

## Official documentation result

| Hekayati role | Exact stable model ID | Documented capability |
|---|---|---|
| Text/structured | \`${config.textModel.id}\` | Text output; structured outputs supported |
| Default image | \`${config.imageModels[0]?.id}\` | Image+text output; up to 14 refs, including up to 4 character images |
| Economy image | \`${config.imageModels[1]?.id}\` | 1K image+text output; up to 14 object refs; no separate character-consistency allowance documented |

Official model cards mark all three IDs stable. The deprecation table lists no announced shutdown date for the configured text/default-image IDs; the Lite image model is stable but not listed in that table. Image models are probed for image output only; structured JSON is probed on the configured text model.

Official sources:

- <https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash>
- <https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image>
- <https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image>
- <https://ai.google.dev/gemini-api/docs/image-generation>
- <https://ai.google.dev/gemini-api/docs/structured-output>
- <https://ai.google.dev/gemini-api/docs/deprecations>
- <https://github.com/googleapis/js-genai/releases/tag/v2.11.0>

## Runtime result

- SDK version: \`@google/genai\` ${summary.sdkVersion}.
- Probe configuration SHA-256: \`${summary.configSha256}\`.
- Credential source: ${summary.credentialSource === "none" ? "unavailable" : summary.credentialSource} (value never printed or persisted).
- Every direct probe requires a present \`response.modelVersion\` explicitly allowed for its exact requested stable ID; missing or mismatched versions fail closed and abort remaining paid probes.
- Raw provider payloads and generated images: ignored \`spikes/.local-artifacts/g4/\` only.

| Exact requested ID | Role | Account listing | Observed \`modelVersion\` | Direct probe |
|---|---|---|---|---|
${rows.join("\n")}

## Gate decision

**${summary.gatePass ? "PASS" : `FAIL (${summary.credentialSource === "none" ? "environment" : "runtime"}, ${date})`}**${summary.gatePass ? "." : " until every configured exact ID is listed and its direct probe passes."} No alias, preview ID, model substitution, or fallback is permitted.
`;
}

async function main(): Promise<void> {
  const config = await loadProbeConfig(CONFIG_PATH);
  if (process.argv.includes("--self-check")) {
    runSelfCheck(config);
    return;
  }
  const sdkVersion = await readSdkVersion();
  const configSha256 = await fileSha256(CONFIG_PATH);
  const credential = await resolveCredential(config.keychainService);
  const summary = credential.apiKey
    ? await runConfiguredProbe(config, credential as Required<CredentialResult>, sdkVersion, configSha256)
    : unconfiguredSummary(config, sdkVersion, configSha256);
  await atomicWrite(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`);
  await atomicWrite(EVIDENCE_PATH, renderEvidence(summary, config));
  console.log(summary.gatePass
    ? "G4 PASS: exact configured Gemini IDs are listed and directly verified."
    : "G4 FAIL: required account-level Gemini verification is incomplete; see sanitized scorecard.");
  process.exitCode = summary.gatePass ? 0 : 1;
}

function runSelfCheck(config: ProbeConfig): void {
  for (const model of modelConfigs(config)) {
    assertSelfCheck(isAllowedModelVersion(model.id, model), `${model.role} exact response version accepted`);
    assertSelfCheck(!isAllowedModelVersion(undefined, model), `${model.role} missing response version rejected`);
    assertSelfCheck(!isAllowedModelVersion(`${model.id}-unmapped`, model), `${model.role} mismatch rejected`);
  }
  console.log("G4 self-check PASS: response-model version mapping fails closed.");
}

main().catch(async () => {
  console.error("G4 FAIL: probe could not complete safely; no sensitive error detail was emitted.");
  process.exitCode = 1;
});

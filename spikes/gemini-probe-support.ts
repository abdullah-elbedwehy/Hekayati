import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type CredentialSource = "environment" | "keychain" | "none";
export type ProviderAttemptOutcome = "input_rejected" | "inconclusive";

export interface TextModelConfig {
  role: "text-structured";
  id: string;
  allowedResponseModelVersions: string[];
}

export interface ImageModelConfig {
  role: "default-image" | "economy-image";
  id: string;
  allowedResponseModelVersions: string[];
  documentedMaxReferences: number;
  documentedMaxCharacterReferences: number | null;
  probeImageSize: "1K";
}

export type AnyModelConfig = TextModelConfig | ImageModelConfig;

export interface ProbeConfig {
  schemaVersion: 2;
  keychainService: string;
  textModel: TextModelConfig;
  imageModels: ImageModelConfig[];
}

export interface CredentialResult {
  apiKey?: string;
  source: CredentialSource;
}

export interface ClassifiedProviderError {
  outcome: ProviderAttemptOutcome;
  category: string;
}

export class ProbeFailure extends Error {
  constructor(readonly category: string) {
    super(category);
    this.name = "ProbeFailure";
  }
}

export async function loadProbeConfig(path: string): Promise<ProbeConfig> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  assertRecord(value, "probe configuration");
  assertRecord(value.textModel, "text model configuration");
  if (value.schemaVersion !== 2 || !Array.isArray(value.imageModels)) {
    throw new Error("Unsupported probe configuration schema");
  }
  const config: ProbeConfig = {
    schemaVersion: 2,
    keychainService: requiredString(value.keychainService, "Keychain service"),
    textModel: parseTextModel(value.textModel),
    imageModels: value.imageModels.map(parseImageModel),
  };
  assertUniqueModels(config);
  return config;
}

function parseTextModel(value: Record<string, unknown>): TextModelConfig {
  if (value.role !== "text-structured") throw new Error("Invalid text model role");
  return {
    role: "text-structured",
    id: stableModelId(value.id),
    allowedResponseModelVersions: allowedVersions(value.allowedResponseModelVersions),
  };
}

function parseImageModel(value: unknown): ImageModelConfig {
  assertRecord(value, "image model configuration");
  const role = value.role;
  const characterLimit = value.documentedMaxCharacterReferences;
  if (role !== "default-image" && role !== "economy-image") throw new Error("Invalid image model role");
  if (characterLimit !== null && (!Number.isInteger(characterLimit) || (characterLimit as number) < 1)) {
    throw new Error("Invalid character-reference limit");
  }
  return {
    role,
    id: stableModelId(value.id),
    allowedResponseModelVersions: allowedVersions(value.allowedResponseModelVersions),
    documentedMaxReferences: positiveInteger(value.documentedMaxReferences),
    documentedMaxCharacterReferences: characterLimit as number | null,
    probeImageSize: value.probeImageSize === "1K" ? "1K" : fail("Invalid image size"),
  };
}

function allowedVersions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Missing response-model version mapping");
  const versions = value.map((entry) => providerToken(entry, "response-model version"));
  if (new Set(versions).size !== versions.length) throw new Error("Duplicate response-model version mapping");
  if (versions.some((version) => version.includes("latest") || version.includes("preview"))) {
    throw new Error("Response-model versions must map stable releases only");
  }
  return versions;
}

function assertUniqueModels(config: ProbeConfig): void {
  const ids = modelConfigs(config).map((model) => model.id);
  if (ids.length !== 3 || new Set(ids).size !== ids.length) {
    throw new Error("Phase 0 requires exactly three unique model IDs");
  }
  for (const model of modelConfigs(config)) {
    if (!model.allowedResponseModelVersions.includes(model.id)) {
      throw new Error("Each stable request ID must be an explicitly allowed response version");
    }
  }
}

export function modelConfigs(config: ProbeConfig): AnyModelConfig[] {
  return [config.textModel, ...config.imageModels];
}

export function modelForId(config: ProbeConfig, id: string): AnyModelConfig | undefined {
  return modelConfigs(config).find((model) => model.id === id);
}

export async function resolveCredential(service: string): Promise<CredentialResult> {
  const environmentKey = process.env.GEMINI_API_KEY;
  if (typeof environmentKey === "string" && environmentKey.trim().length > 0) {
    return { apiKey: environmentKey.trim(), source: "environment" };
  }
  try {
    const result = await execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-w"],
      { encoding: "utf8", maxBuffer: 8_192, timeout: 5_000, killSignal: "SIGKILL" },
    );
    const key = result.stdout.trim();
    return key ? { apiKey: key, source: "keychain" } : { source: "none" };
  } catch {
    return { source: "none" };
  }
}

export function requireAllowedModelVersion(value: unknown, model: AnyModelConfig): string {
  if (typeof value !== "string" || !safeProviderToken(value)) {
    throw new ProbeFailure("model_version_missing");
  }
  if (!model.allowedResponseModelVersions.includes(value)) {
    throw new ProbeFailure("model_version_mismatch");
  }
  return value;
}

export function isAllowedModelVersion(value: unknown, model: AnyModelConfig): value is string {
  return typeof value === "string" && Boolean(safeProviderToken(value))
    && model.allowedResponseModelVersions.includes(value);
}

export function classifyProviderError(error: unknown, referenceBoundary: boolean): ClassifiedProviderError {
  if (error instanceof ProbeFailure) return { outcome: "inconclusive", category: error.category };
  const record = errorRecord(error);
  if (!record) return { outcome: "inconclusive", category: "provider_error" };
  const status = typeof record.status === "number" ? record.status : record.code;
  if (status === 401 || status === 403 || status === "UNAUTHENTICATED" || status === "PERMISSION_DENIED") {
    return { outcome: "inconclusive", category: "authentication_or_permission" };
  }
  if (status === 429 || status === "RESOURCE_EXHAUSTED") {
    return { outcome: "inconclusive", category: "quota_or_rate_limit" };
  }
  if (record.name === "AbortError" || status === 408 || status === "DEADLINE_EXCEEDED") {
    return { outcome: "inconclusive", category: "timeout" };
  }
  if (status === 404 || status === "NOT_FOUND") {
    return { outcome: "inconclusive", category: "model_unavailable" };
  }
  if (status === 400 || status === "INVALID_ARGUMENT") {
    return referenceBoundary && hasStructuredReferenceRejection(record)
      ? { outcome: "input_rejected", category: "reference_count_or_type_rejected" }
      : { outcome: "inconclusive", category: "invalid_argument_unclassified" };
  }
  return { outcome: "inconclusive", category: "provider_error" };
}

function hasStructuredReferenceRejection(record: Record<string, unknown>): boolean {
  const details = structuredDetails(record);
  const exactReasons = new Set([
    "TOO_MANY_REFERENCE_IMAGES",
    "REFERENCE_IMAGE_LIMIT_EXCEEDED",
    "REFERENCE_TYPE_LIMIT_EXCEEDED",
    "INVALID_REFERENCE_IMAGE_COUNT",
    "UNSUPPORTED_REFERENCE_IMAGE_TYPE",
  ]);
  for (const detail of details) {
    const reason = typeof detail.reason === "string" ? detail.reason.toUpperCase() : undefined;
    if (reason && exactReasons.has(reason)) return true;
    if (fieldViolationsProveReferenceRejection(detail, exactReasons)) return true;
    if (numericMetadataProvesReferenceLimit(detail)) return true;
  }
  return false;
}

function structuredDetails(record: Record<string, unknown>): Record<string, unknown>[] {
  const direct = Array.isArray(record.details) ? record.details : [];
  const nested = errorRecord(record.error);
  const nestedDetails = nested && Array.isArray(nested.details) ? nested.details : [];
  return [...direct, ...nestedDetails].filter(isRecord);
}

function fieldViolationsProveReferenceRejection(
  detail: Record<string, unknown>,
  exactReasons: Set<string>,
): boolean {
  if (!Array.isArray(detail.fieldViolations)) return false;
  return detail.fieldViolations.filter(isRecord).some((violation) => {
    const field = typeof violation.field === "string" ? violation.field.toLowerCase() : "";
    const reason = typeof violation.reason === "string" ? violation.reason.toUpperCase() : "";
    const description = typeof violation.description === "string" ? violation.description.toLowerCase() : "";
    const referenceField = /(reference|inline.?data|contents.*parts|image)/.test(field);
    const explicitDescription = /(reference|image)/.test(description)
      && /(too many|maximum|max |limit|count|unsupported type)/.test(description);
    return referenceField && (exactReasons.has(reason) || explicitDescription);
  });
}

function numericMetadataProvesReferenceLimit(detail: Record<string, unknown>): boolean {
  const metadata = isRecord(detail.metadata) ? detail.metadata : detail;
  const count = numberField(metadata, ["referenceImageCount", "reference_image_count"]);
  const maximum = numberField(metadata, ["maxReferenceImages", "max_reference_images"]);
  return count !== undefined && maximum !== undefined && count > maximum;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) if (typeof record[key] === "number") return record[key] as number;
  return undefined;
}

export function safeProviderToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,200}$/.test(value) ? value : undefined;
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export async function atomicWrite(path: string, contents: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
}

export function cairoCalendarDate(value: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function assertSelfCheck(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`Self-check failed: ${label}`);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${label}`);
  return value;
}

function providerToken(value: unknown, label: string): string {
  const token = safeProviderToken(value);
  if (!token) throw new Error(`Invalid ${label}`);
  return token;
}

function stableModelId(value: unknown): string {
  const id = requiredString(value, "model ID");
  if (!/^gemini-[a-z0-9.-]+$/.test(id) || id.includes("latest") || id.includes("preview")) {
    throw new Error("Model ID must be exact and stable");
  }
  return id;
}

function positiveInteger(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error("Expected positive integer");
  return value as number;
}

function fail(message: string): never {
  throw new Error(message);
}

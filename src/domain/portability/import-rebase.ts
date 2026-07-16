import { createHash } from "node:crypto";

import { creativeCapacityBindingHash } from "../../contracts/creative-policy.js";
import { canonicalJson } from "../../contracts/canonical-json.js";
import {
  createIdempotencyKey,
  createRequestHash,
} from "../../jobs/idempotency.js";
import { requestEnvelope } from "../../jobs/scheduler-core.js";
import { jobRecordSchema, type JobRecord } from "../../jobs/schemas.js";
import { hashCanonical } from "../layout/hashes.js";
import type { BaseDocument } from "../repository/document-store.js";
import { exactIdMapHash } from "./id-map.js";
import type { ExactIdMap } from "./participants.js";

export const IMPORT_DERIVED_HASH_RULES: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  invalidation_receipts: ["consequenceHash"],
  story_versions: ["pageCountChange.planHash"],
  character_sheet_intents: ["policyPlan.capacity.bindingHash"],
  creative_runs: ["policyPlan.capacity.bindingHash"],
  creative_stage_records: ["outputHash"],
  finding_acknowledgements: ["findingKey"],
  invalidation_audits: ["consequenceHash"],
  jobs: ["request.payloadHash", "requestHash", "idempotencyKey"],
  layout_versions: [
    "inputSnapshot.pageContentHash",
    "inputSnapshot.compositionInputHash",
    "inputSnapshot.reviewHash",
    "layoutHash",
  ],
  cover_composition_versions: ["compositionHash"],
  preview_workflows: ["inputSnapshotHash"],
  preview_outputs: [
    "orderedInteriorPages.*.pageContentHash",
    "orderedInteriorPages.*.layoutHash",
    "orderedInteriorPages.*.compositionInputHash",
    "orderedInteriorPages.*.reviewHash",
    "customerContentHash",
    "approvalBundleHash",
    "pageMapHash",
    "previewSnapshotHash",
  ],
  book_approval_cycles: [
    "customerContentHash",
    "approvalBundleHash",
    "pageMapHash",
    "previewSnapshotHash",
  ],
  book_approval_actions: [
    "canonicalRequestHash",
    "customerContentHash",
    "approvalBundleHash",
  ],
  printer_profile_versions: ["profileHash"],
  print_runs: [
    "requestHash",
    "contentAuthorizationHash",
    "customerContentHash",
    "sourceSnapshotHash",
    "convertedProofBundleHash",
  ],
  print_artifacts: [
    "contentAuthorizationHash",
    "sourceSnapshotHash",
    "pageMapHash",
  ],
  print_preflight_reports: ["contentAuthorizationHash", "measurementsHash"],
  print_proof_bundles: ["contentAuthorizationHash", "bundleHash"],
  converted_proof_actions: [
    "canonicalRequestHash",
    "proofBundleHash",
    "contentAuthorizationHash",
  ],
});

const idempotencyCollections = new Set([
  "book_approval_actions",
  "print_runs",
  "converted_proof_actions",
]);

export function rebaseParticipantDerivedFields<T extends BaseDocument>(
  collection: string,
  document: Readonly<T>,
  idMap: ExactIdMap,
): T {
  let rebased = clone(document) as T;
  if (collection === "jobs")
    rebased = normalizeImportedJob(
      rebased as unknown as JobRecord,
      idMap,
    ) as unknown as T;
  if (collection === "printer_profile_versions") rebasePrinterProfile(rebased);
  if (collection === "print_preflight_reports")
    rebasePreflightMeasurements(rebased);
  if (
    collection === "character_sheet_intents" ||
    collection === "creative_runs"
  )
    rebaseCapacityPlan(rebased, "policyPlan.capacity");
  const rules = IMPORT_DERIVED_HASH_RULES[collection] ?? [];
  const mapHash = exactIdMapHash(idMap);
  for (const path of rules) {
    if (handledSpecialPath(collection, path)) continue;
    transformAtPath(rebased, path, (value) =>
      typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
        ? translatedHash(hashKind(collection, path), value, mapHash)
        : value,
    );
  }
  if (idempotencyCollections.has(collection))
    rebaseHistoricalIdempotency(rebased, collection, mapHash);
  return rebased;
}

export function normalizeImportedJob(
  document: Readonly<JobRecord>,
  idMap: ExactIdMap,
): JobRecord {
  const job = clone(document) as MutableJobRecord;
  const sourceState = job.state;
  const terminal = ["succeeded", "failed", "canceled"].includes(sourceState);
  const humanGate = job.request.kind === "human_gate";
  if (!terminal && !humanGate) {
    job.state = "paused";
    job.stateReason = "operator";
    job.resumeState = resumableState(sourceState, job.resumeState);
    job.resumeReason = null;
  }
  job.lease = null;
  job.retrySchedule = null;
  job.progress = null;
  const mapHash = exactIdMapHash(idMap);
  job.intentId = `import-${translatedHash("jobIntent", job.intentId, mapHash).slice(0, 48)}`;
  if (job.request.kind === "local") {
    job.request = {
      kind: "local",
      payloadHash: hashCanonical({
        contract: "HekayatiImportedLocalJobPayload/v1",
        jobId: job.id,
        jobType: job.jobType,
        projectId: job.projectId,
        inputSnapshot: job.inputSnapshot,
        dependsOn: job.dependsOn,
      }),
    };
  }
  const envelope = requestEnvelope(job);
  job.requestHash = createRequestHash(envelope);
  job.idempotencyKey = createIdempotencyKey({
    ...envelope,
    intentId: job.intentId,
  });
  return jobRecordSchema.parse(job);
}

export function derivedHashRuleIdentity(): string {
  return hashCanonical(IMPORT_DERIVED_HASH_RULES);
}

function rebaseCapacityPlan(document: BaseDocument, path: string): void {
  transformAtPath(document, path, (value) => {
    if (!isRecord(value)) return value;
    const bound = { ...value };
    const confirmed = bound.confirmed;
    delete bound.bindingHash;
    delete bound.confirmed;
    return {
      ...bound,
      bindingHash: creativeCapacityBindingHash(bound as never),
      confirmed,
    };
  });
}

function rebasePrinterProfile(document: BaseDocument): void {
  const profile = document as BaseDocument & Record<string, unknown>;
  const draft = {
    trim: profile.trim,
    bleedMm: profile.bleedMm,
    safeContentRegion: profile.safeContentRegion,
    dpiMin: profile.dpiMin,
    color: profile.color,
    cropMarks: profile.cropMarks,
    spine: profile.spine,
    coverTemplate: profile.coverTemplate,
    requiredBlankPages: profile.requiredBlankPages,
  };
  profile.profileHash = hashCanonical(draft);
}

function rebasePreflightMeasurements(document: BaseDocument): void {
  const report = document as BaseDocument & Record<string, unknown>;
  if (report.measurements !== undefined)
    report.measurementsHash = hashCanonical(report.measurements);
}

function rebaseHistoricalIdempotency(
  document: BaseDocument,
  collection: string,
  mapHash: string,
): void {
  const record = document as BaseDocument & Record<string, unknown>;
  if (typeof record.idempotencyKey !== "string") return;
  record.idempotencyKey = `import-${translatedHash(
    `${collection}.idempotencyKey`,
    record.idempotencyKey,
    mapHash,
  ).slice(0, 96)}`;
}

function handledSpecialPath(collection: string, path: string): boolean {
  if (collection === "jobs") return true;
  if (collection === "printer_profile_versions" && path === "profileHash")
    return true;
  if (collection === "print_preflight_reports" && path === "measurementsHash")
    return true;
  return (
    (collection === "character_sheet_intents" ||
      collection === "creative_runs") &&
    path === "policyPlan.capacity.bindingHash"
  );
}

function hashKind(collection: string, path: string): string {
  const field = path.split(".").at(-1) ?? path;
  if (
    field === "bundleHash" ||
    field === "proofBundleHash" ||
    field === "convertedProofBundleHash"
  )
    return "printProofBundleHash";
  return sharedHashFields.has(field) ? field : `${collection}.${path}`;
}

const sharedHashFields = new Set([
  "approvalBundleHash",
  "compositionInputHash",
  "contentAuthorizationHash",
  "customerContentHash",
  "layoutHash",
  "pageContentHash",
  "pageMapHash",
  "previewSnapshotHash",
  "reviewHash",
  "sourceSnapshotHash",
]);

function translatedHash(kind: string, source: string, mapHash: string): string {
  return createHash("sha256")
    .update("HekayatiImportedDerivedField/v1\n")
    .update(canonicalJson({ kind, source, mapHash }))
    .digest("hex");
}

function resumableState(
  state: JobRecord["state"],
  prior: JobRecord["resumeState"],
): JobRecord["state"] {
  if (state === "paused") return prior ?? "queued";
  if (state === "claimed" || state === "running" || state === "waiting_review")
    return "queued";
  return state;
}

function transformAtPath(
  value: unknown,
  path: string,
  transform: (value: unknown) => unknown,
): void {
  transformSegments(value, path.split("."), transform);
}

function transformSegments(
  value: unknown,
  segments: readonly string[],
  transform: (value: unknown) => unknown,
): void {
  const [segment, ...rest] = segments;
  if (!segment) return;
  for (const target of targets(value, segment)) {
    if (rest.length === 0) writeTarget(target, transform(readTarget(target)));
    else transformSegments(readTarget(target), rest, transform);
  }
}

type MutableJobRecord = {
  -readonly [Key in keyof JobRecord]: JobRecord[Key];
};

type PathTarget = {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
};

function readTarget(target: PathTarget): unknown {
  return (target.parent as Record<string | number, unknown>)[target.key];
}

function writeTarget(target: PathTarget, value: unknown): void {
  (target.parent as Record<string | number, unknown>)[target.key] = value;
}

function targets(
  value: unknown,
  segment: string,
): Array<{
  parent: Record<string, unknown> | unknown[];
  key: string | number;
}> {
  if (segment === "*") {
    if (Array.isArray(value))
      return value.map((_, key) => ({ parent: value, key }));
    if (isRecord(value))
      return Object.keys(value).map((key) => ({ parent: value, key }));
    return [];
  }
  if (Array.isArray(value) && /^[0-9]+$/.test(segment)) {
    const key = Number(segment);
    return key < value.length ? [{ parent: value, key }] : [];
  }
  return isRecord(value) && Object.hasOwn(value, segment)
    ? [{ parent: value, key: segment }]
    : [];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

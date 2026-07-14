import type { NormalizedFailure } from "../providers/failures.js";
import { makeFailure } from "../providers/failures.js";
import { JobError } from "./errors.js";
import {
  persistedJobFailureSchema,
  type JobRecord,
  type JobState,
} from "./schemas.js";
import type { JobFence } from "./types.js";

const terminalStates = new Set<JobState>(["succeeded", "failed", "canceled"]);

export function assertOwned(
  job: JobRecord,
  fence: JobFence,
  nowMonoMs: number | undefined,
  expectedState: "claimed" | "running",
): void {
  const lease = job.lease;
  if (
    job.state !== expectedState ||
    !lease ||
    lease.workerId !== fence.workerId ||
    lease.bootId !== fence.bootId ||
    lease.claimToken !== fence.claimToken ||
    job.attempts !== fence.attempt
  )
    throw new JobError("JOB_FENCE_MISMATCH");
  if (nowMonoMs !== undefined && nowMonoMs >= lease.expiresAtMono)
    throw new JobError("JOB_LEASE_EXPIRED");
}

export function restoreState(job: JobRecord): Partial<JobRecord> {
  return {
    state: job.resumeState ?? "queued",
    stateReason: job.resumeReason ?? null,
    resumeState: null,
    resumeReason: null,
  };
}

export function resumableState(state: JobState): JobState {
  return ["claimed", "running", "created"].includes(state) ? "queued" : state;
}

export function isStalled(
  job: JobRecord,
  nowMonoMs: number,
  thresholdMs: number,
): boolean {
  const baseline = job.progress?.updatedAtMono ?? job.lease?.claimedAtMono;
  return baseline !== undefined && nowMonoMs - baseline >= thresholdMs;
}

export function emptyStateCounts(): Record<JobState, number> {
  return {
    created: 0,
    blocked: 0,
    queued: 0,
    claimed: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    paused: 0,
    canceled: 0,
    waiting_review: 0,
  };
}

export function isStorageFailure(
  failure: NonNullable<JobRecord["failure"]>,
): boolean {
  return ["disk_write_failure", "insufficient_disk_space"].includes(
    failure.category,
  );
}

export function safeFailure(
  failure: NormalizedFailure,
): NonNullable<JobRecord["failure"]> {
  const canonical = makeFailure(failure.category, {
    retryAfterMs: failure.retryAfterMs,
    reasonCode: failure.reasonCode,
  });
  return persistedJobFailureSchema.parse({
    category: canonical.category,
    message: canonical.message,
    retryable: canonical.retryable,
    reasonCode: canonical.reasonCode,
    retryAfterMs: canonical.retryAfterMs,
    diagnostics: safeStructuralDiagnostics(failure),
  });
}

function safeStructuralDiagnostics(
  failure: NormalizedFailure,
): Array<{ path: string[]; code: string }> {
  if (
    !["malformed_output", "output_validation_failed"].includes(
      failure.category,
    ) ||
    !failure.providerDetail
  )
    return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(failure.providerDetail) as unknown;
  } catch {
    return [];
  }
  if (!isStructuralDiagnostics(parsed)) return [];
  return parsed.issues.flatMap((issue) => {
    const path =
      issue.path === "<root>" ? [] : issue.path.split(".").slice(0, 8);
    if (
      !safeDiagnosticId(issue.code) ||
      path.some((segment) => !safeDiagnosticId(segment))
    )
      return [];
    return [{ path, code: issue.code }];
  });
}

function isStructuralDiagnostics(
  value: unknown,
): value is { issues: Array<{ path: string; code: string }> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "sha256",
    "byteCount",
    "topLevelType",
    "topLevelKeys",
    "issues",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return false;
  if (
    typeof record.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sha256) ||
    !Number.isInteger(record.byteCount) ||
    (record.byteCount as number) < 0 ||
    typeof record.topLevelType !== "string" ||
    ![
      "array",
      "boolean",
      "null",
      "number",
      "object",
      "string",
      "unparseable",
    ].includes(record.topLevelType) ||
    !Array.isArray(record.issues) ||
    record.issues.length > 10
  )
    return false;
  if (
    record.topLevelKeys !== undefined &&
    (!Array.isArray(record.topLevelKeys) ||
      record.topLevelKeys.length > 20 ||
      record.topLevelKeys.some(
        (key) => typeof key !== "string" || key.length > 160,
      ))
  )
    return false;
  return (record.issues as unknown[]).every(isRawStructuralIssue);
}

function isRawStructuralIssue(
  value: unknown,
): value is { path: string; code: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const issue = value as Record<string, unknown>;
  return (
    Object.keys(issue).length === 2 &&
    typeof issue.path === "string" &&
    issue.path.length > 0 &&
    issue.path.length <= 1_280 &&
    typeof issue.code === "string"
  );
}

function safeDiagnosticId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
}

export function isStoragePausable(job: JobRecord): boolean {
  return (
    !terminalStates.has(job.state) &&
    job.state !== "waiting_review" &&
    !(job.state === "paused" && job.stateReason === "storage")
  );
}

export function matchesQuota(job: JobRecord, source: JobRecord): boolean {
  return (
    job.target?.providerId === source.target?.providerId &&
    job.target?.operation === source.target?.operation
  );
}

export function matchesProvider(job: JobRecord, source: JobRecord): boolean {
  return job.target?.providerId === source.target?.providerId;
}

export function isQuotaPausable(job: JobRecord, sourceId: string): boolean {
  return job.id === sourceId || ["queued", "blocked"].includes(job.state);
}

export function isCredentialPausable(
  job: JobRecord,
  sourceId: string,
): boolean {
  return job.id === sourceId || ["queued", "blocked"].includes(job.state);
}

export function isManuallyRetryable(job: JobRecord): boolean {
  return (
    job.state === "paused" &&
    !["credentials", "quota", "storage", "operator"].includes(
      job.stateReason ?? "",
    )
  );
}

export function dependenciesReady(
  job: JobRecord,
  jobs: ReadonlyMap<string, JobRecord>,
): boolean {
  return job.dependsOn.every((id) => jobs.get(id)?.state === "succeeded");
}

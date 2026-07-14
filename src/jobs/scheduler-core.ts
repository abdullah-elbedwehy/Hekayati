import { dependenciesSucceeded } from "./dag.js";
import { JobError } from "./errors.js";
import { createRequestHash } from "./idempotency.js";
import type { JobRecord } from "./schemas.js";
import type { ClaimOptions, EnqueueJobInput } from "./types.js";

export function projectActionJobs(
  jobs: readonly JobRecord[],
  projectId: string,
  action: "pause" | "resume",
): JobRecord[] {
  return jobs.filter((job) => {
    if (job.projectId !== projectId) return false;
    if (action === "pause") return ["queued", "blocked"].includes(job.state);
    return job.state === "paused" && job.stateReason === "operator";
  });
}

export function projectActionImpact(
  jobs: readonly JobRecord[],
  projectId: string,
  action: "pause" | "resume",
): { impactHash: string; affectedCount: number } {
  const affected = projectActionJobs(jobs, projectId, action);
  return {
    impactHash: createRequestHash({
      kind: `project_${action}`,
      projectId,
      affected: affected.map(jobRevisionEntry),
    }),
    affectedCount: affected.length,
  };
}

export function jobRevisionEntry(job: JobRecord) {
  return { id: job.id, revision: job.revision, state: job.state };
}

export function requestEnvelope(input: EnqueueJobInput): {
  jobType: string;
  target: EnqueueJobInput["target"];
  request: EnqueueJobInput["request"];
  inputSnapshot: EnqueueJobInput["inputSnapshot"];
  projectId: string | null;
  standaloneScopeId: string | null;
  dependsOn: string[];
} {
  return {
    jobType: input.jobType,
    target: input.target,
    request: input.request,
    inputSnapshot: input.inputSnapshot,
    projectId: input.projectId,
    standaloneScopeId: input.standaloneScopeId,
    dependsOn: input.dependsOn,
  };
}

export function isSameIntent(left: JobRecord, right: JobRecord): boolean {
  return (
    left.intentId === right.intentId &&
    left.jobType === right.jobType &&
    left.projectId === right.projectId &&
    left.standaloneScopeId === right.standaloneScopeId
  );
}

export function initializeState(
  job: JobRecord,
  jobs: ReadonlyMap<string, JobRecord>,
): JobRecord {
  if (!dependenciesSucceeded(job, jobs)) {
    return { ...job, state: "blocked", stateReason: "dependency" };
  }
  if (job.request.kind === "human_gate")
    return { ...job, state: "waiting_review", stateReason: null };
  return {
    ...job,
    state: "queued",
    stateReason: null,
  };
}

export function isExpired(
  job: JobRecord,
  bootId: string,
  nowMonoMs: number,
): boolean {
  return (
    ["claimed", "running"].includes(job.state) &&
    job.lease !== null &&
    (job.lease.bootId !== bootId || job.lease.expiresAtMono <= nowMonoMs)
  );
}

export function validateClaimOptions(options: ClaimOptions): void {
  if (
    options.leaseTtlMs <= 0 ||
    options.concurrencyPerProvider < 1 ||
    options.concurrencyPerProvider > 4 ||
    options.nowMonoMs < 0
  ) {
    throw new JobError("JOB_CLAIM_OPTIONS_INVALID", 400);
  }
}

import { JobError } from "./errors.js";
import { createRequestHash } from "./idempotency.js";
import type { JobRecord } from "./schemas.js";

export interface StorageIncidentControl {
  active: boolean;
  revision: number;
  incidentId: string | null;
  ownedJobIds: readonly string[];
}

export interface StorageResumeImpact {
  expectedRevision: number;
  impactHash: string;
  affectedCount: number;
}

export interface StorageResumeConfirmation {
  expectedRevision: number;
  impactHash: string;
  confirmedAffectedCount: number;
  confirmed: true;
}

export function storageResumeImpact(
  control: StorageIncidentControl,
  jobs: readonly JobRecord[],
): StorageResumeImpact {
  assertOpenStorageIncident(control);
  const affected = storageIncidentJobs(control, jobs);
  return {
    expectedRevision: control.revision,
    impactHash: createRequestHash({
      kind: "storage_resume",
      incidentId: control.incidentId,
      controlRevision: control.revision,
      affected: affected.map(jobImpactEntry),
    }),
    affectedCount: affected.length,
  };
}

export function confirmStorageResume(
  control: StorageIncidentControl,
  jobs: readonly JobRecord[],
  input: StorageResumeConfirmation,
): JobRecord[] {
  assertOpenStorageIncident(control);
  if (control.revision !== input.expectedRevision)
    throw new JobError("JOB_REVISION_CONFLICT");
  const impact = storageResumeImpact(control, jobs);
  if (
    input.confirmed !== true ||
    input.impactHash !== impact.impactHash ||
    input.confirmedAffectedCount !== impact.affectedCount
  )
    throw new JobError("JOB_IMPACT_CONFLICT");
  return storageIncidentJobs(control, jobs);
}

export function storageIncidentJobs(
  control: StorageIncidentControl,
  jobs: readonly JobRecord[],
): JobRecord[] {
  const owned = new Set(control.ownedJobIds);
  return jobs
    .filter(
      (job) =>
        owned.has(job.id) &&
        job.state === "paused" &&
        job.stateReason === "storage",
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

function assertOpenStorageIncident(control: StorageIncidentControl): void {
  if (!control.active || !control.incidentId)
    throw new JobError("JOB_STORAGE_NOT_PAUSED");
}

function jobImpactEntry(job: JobRecord) {
  return {
    id: job.id,
    revision: job.revision,
    state: job.state,
    stateReason: job.stateReason,
  };
}

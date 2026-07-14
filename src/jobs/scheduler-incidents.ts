import { JobError } from "./errors.js";
import { createRequestHash } from "./idempotency.js";
import type {
  CredentialIncident,
  JobRecord,
  JobTarget,
  QuotaIncident,
} from "./schemas.js";
import { jobRevisionEntry } from "./scheduler-core.js";
import type {
  EnqueueJobInput,
  QuotaAvailabilityPort,
  QuotaDecisionInput,
  ResumeQuotaInput,
} from "./types.js";

export function sameTargets(
  left: readonly NonNullable<JobRecord["target"]>[],
  right: readonly NonNullable<JobRecord["target"]>[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((target, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      target.providerId === other.providerId &&
      target.modelId === other.modelId &&
      target.operation === other.operation &&
      target.settingsHash === other.settingsHash
    );
  });
}

export function quotaScopeJobs(
  jobs: readonly JobRecord[],
  incident: QuotaIncident,
  scope: Pick<QuotaDecisionInput, "projectId" | "standaloneScopeId">,
): JobRecord[] {
  if ((scope.projectId === null) === (scope.standaloneScopeId === null))
    throw new JobError("JOB_QUOTA_SCOPE_INVALID", 400);
  const owned = new Set(incident.ownedJobIds);
  return jobs.filter(
    (job) =>
      owned.has(job.id) &&
      job.state === "paused" &&
      job.stateReason === "quota" &&
      job.target?.providerId === incident.providerId &&
      job.target.operation === incident.operation &&
      job.projectId === scope.projectId &&
      job.standaloneScopeId === scope.standaloneScopeId,
  );
}

export function quotaImpact(
  incident: QuotaIncident,
  scope: Pick<QuotaDecisionInput, "projectId" | "standaloneScopeId">,
  affected: readonly JobRecord[],
): { impactHash: string; affectedCount: number } {
  return {
    impactHash: createRequestHash({
      kind: "quota_scope_decision",
      incidentId: incident.id,
      incidentRevision: incident.revision,
      projectId: scope.projectId,
      standaloneScopeId: scope.standaloneScopeId,
      affected: [...affected]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(jobRevisionEntry),
    }),
    affectedCount: affected.length,
  };
}

export function quotaIncidentJobs(
  jobs: readonly JobRecord[],
  incident: QuotaIncident,
): JobRecord[] {
  const owned = new Set(incident.ownedJobIds);
  return jobs.filter(
    (job) =>
      owned.has(job.id) &&
      job.state === "paused" &&
      job.stateReason === "quota" &&
      job.target?.providerId === incident.providerId &&
      job.target.operation === incident.operation,
  );
}

export function quotaResumeImpact(
  incident: QuotaIncident,
  affected: readonly JobRecord[],
): { impactHash: string; affectedCount: number } {
  return {
    impactHash: createRequestHash({
      kind: "quota_incident_resume",
      incidentId: incident.id,
      incidentRevision: incident.revision,
      targets: [...incident.originalTargets].sort((left, right) =>
        targetKey(left).localeCompare(targetKey(right)),
      ),
      affected: [...affected]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(jobRevisionEntry),
    }),
    affectedCount: affected.length,
  };
}

export function assertQuotaResumeImpact(
  impact: { impactHash: string; affectedCount: number },
  input: ResumeQuotaInput,
): void {
  if (
    impact.impactHash !== input.impactHash ||
    impact.affectedCount !== input.confirmedAffectedCount
  )
    throw new JobError("JOB_IMPACT_CONFLICT");
}

export async function forceCheckQuotaTargets(
  targets: readonly JobTarget[],
  availability: QuotaAvailabilityPort,
): Promise<void> {
  for (const target of targets) {
    let available: boolean;
    try {
      available = await availability.forceCheckExact(target);
    } catch {
      throw new JobError("JOB_QUOTA_AVAILABILITY_CHECK_FAILED");
    }
    if (!available) throw new JobError("JOB_QUOTA_TARGET_UNAVAILABLE");
  }
}

export function quotaDecisionRequestHash(
  incidentId: string,
  input: QuotaDecisionInput,
): string {
  return createRequestHash({
    kind: "quota_decision_action",
    incidentId,
    actionId: input.actionId,
    expectedRevision: input.expectedRevision,
    impactHash: input.impactHash,
    projectId: input.projectId,
    standaloneScopeId: input.standaloneScopeId,
    decision: input.decision,
    alternateTarget: input.alternateTarget ?? null,
  });
}

export function quotaResumeRequestHash(
  incidentId: string,
  input: ResumeQuotaInput,
): string {
  return createRequestHash({
    kind: "quota_resume_action",
    incidentId,
    actionId: input.actionId,
    expectedRevision: input.expectedRevision,
    impactHash: input.impactHash,
    confirmedAffectedCount: input.confirmedAffectedCount,
  });
}

function targetKey(target: JobTarget): string {
  return [
    target.providerId,
    target.modelId,
    target.operation,
    target.settingsHash,
  ].join("\u0000");
}

export function credentialIncidentJobs(
  jobs: readonly JobRecord[],
  incident: CredentialIncident,
): JobRecord[] {
  const owned = new Set(incident.ownedJobIds);
  return jobs.filter(
    (job) =>
      owned.has(job.id) &&
      job.state === "paused" &&
      job.stateReason === "credentials" &&
      job.target?.providerId === incident.providerId,
  );
}

export function credentialImpact(
  incident: CredentialIncident,
  affected: readonly JobRecord[],
): { impactHash: string; affectedCount: number } {
  return {
    impactHash: createRequestHash({
      kind: "credential_incident_resume",
      incidentId: incident.id,
      incidentRevision: incident.revision,
      providerId: incident.providerId,
      affected: [...affected]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(jobRevisionEntry),
    }),
    affectedCount: affected.length,
  };
}

export function quotaSuccessorInput(
  job: JobRecord,
  target: NonNullable<QuotaDecisionInput["alternateTarget"]>,
  incidentId: string,
  ids: ReadonlyMap<string, string>,
): EnqueueJobInput {
  return {
    id: ids.get(job.id),
    jobType: job.jobType,
    projectId: job.projectId,
    standaloneScopeId: job.standaloneScopeId,
    dependsOn: job.dependsOn.map((id) => ids.get(id) ?? id),
    priority: job.priority,
    intentId: `quota-${incidentId}-${job.id}`,
    target,
    request: job.request,
    inputSnapshot: job.inputSnapshot,
    supersedesJobId: job.id,
  };
}

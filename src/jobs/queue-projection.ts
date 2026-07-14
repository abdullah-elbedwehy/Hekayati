import type { JobScheduler } from "./scheduler.js";
import type {
  CredentialIncident,
  JobEvent,
  JobRecord,
  JobState,
  JobTarget,
  QuotaIncident,
  StorageControl,
} from "./schemas.js";
import { jobTargetSchema } from "./schemas.js";
import { sameJobTarget } from "./targets.js";
import type { StorageResumeImpact } from "./types.js";

export type QueueAction =
  "pause" | "resume" | "cancel" | "retry" | "priority" | "open_gate";

export interface QueueJobProjection {
  id: string;
  revision: number;
  jobType: string;
  projectId: string | null;
  standaloneScopeId: string | null;
  state: JobState;
  stateReason: string | null;
  priority: number;
  queuePosition: number | null;
  blockers: Array<{ id: string; state: JobState; reason: string | null }>;
  attempts: number;
  automaticRetries: number;
  manualRetries: number;
  progress: JobRecord["progress"];
  noProgress: boolean;
  target: JobTarget | null;
  createdAt: string;
  updatedAt: string;
  failure: JobRecord["failure"];
  provenance: JobRecord["provenance"];
  resultRefs: string[];
  gate: {
    gateKind: string;
    targetId: string;
    targetVersionId: string;
  } | null;
  allowedActions: QueueAction[];
  history: JobEvent[];
}

export interface QueueProjection {
  checkedAt: string;
  jobs: QueueJobProjection[];
  counts: Record<JobState, number>;
  stalledCount: number;
  runningByProvider: Record<string, number>;
  quotaIncidents: QueueQuotaIncident[];
  credentialIncidents: QueueCredentialIncident[];
  projectActions: ProjectQueueActions[];
  storage: QueueStorageControl;
}

export interface QueueStorageControl extends StorageControl {
  resumeImpact: StorageResumeImpact | null;
}

export interface ProjectQueueActions {
  projectId: string;
  pause: { impactHash: string; affectedCount: number };
  resume: { impactHash: string; affectedCount: number };
}

export interface QueueQuotaIncident extends QuotaIncident {
  alternateTargets: JobTarget[];
  scopes: QuotaScopeProjection[];
  resumeImpact: { impactHash: string; affectedCount: number } | null;
}

export interface QueueCredentialIncident extends CredentialIncident {
  impactHash: string | null;
  affectedCount: number;
}

export interface QuotaScopeProjection {
  projectId: string | null;
  standaloneScopeId: string | null;
  impactHash: string;
  affectedCount: number;
}

export function buildQueueProjection(
  scheduler: JobScheduler,
  nowMonoMs: number,
  checkedAt: string,
  quotaAlternates: (incident: QuotaIncident) => readonly JobTarget[] = () => [],
): QueueProjection {
  const records = scheduler.list();
  const byId = new Map(records.map((job) => [job.id, job]));
  const positions = queuePositions(records);
  const snapshot = scheduler.queueSnapshot(nowMonoMs);
  return {
    checkedAt,
    jobs: records.map((job) =>
      projectJob(job, byId, positions, scheduler, nowMonoMs),
    ),
    counts: snapshot.counts,
    stalledCount: snapshot.stalledCount,
    runningByProvider: snapshot.runningByProvider,
    quotaIncidents: scheduler
      .quotaIncidents()
      .map((incident) => projectIncident(incident, scheduler, quotaAlternates)),
    credentialIncidents: scheduler
      .credentialIncidents()
      .map((incident) => projectCredentialIncident(incident, scheduler)),
    projectActions: projectActionProjections(records, scheduler),
    storage: projectStorage(scheduler),
  };
}

function projectStorage(scheduler: JobScheduler): QueueStorageControl {
  const storage = scheduler.storageStatus();
  const resumeImpact =
    storage.active && storage.incidentId
      ? scheduler.storageResumeImpact()
      : null;
  return { ...storage, resumeImpact };
}

function projectCredentialIncident(
  incident: CredentialIncident,
  scheduler: JobScheduler,
): QueueCredentialIncident {
  if (incident.status !== "open") {
    return { ...incident, impactHash: null, affectedCount: 0 };
  }
  return { ...incident, ...scheduler.credentialResumeImpact(incident.id) };
}

function projectActionProjections(
  jobs: readonly JobRecord[],
  scheduler: JobScheduler,
): ProjectQueueActions[] {
  const projectIds = new Set(
    jobs.flatMap((job) => (job.projectId ? [job.projectId] : [])),
  );
  return [...projectIds].map((projectId) => ({
    projectId,
    pause: scheduler.projectActionImpact(projectId, "pause"),
    resume: scheduler.projectActionImpact(projectId, "resume"),
  }));
}

function projectIncident(
  incident: QuotaIncident,
  scheduler: JobScheduler,
  quotaAlternates: (incident: QuotaIncident) => readonly JobTarget[],
): QueueQuotaIncident {
  const targets = incident.status === "open" ? quotaAlternates(incident) : [];
  const alternateTargets = targets.reduce<JobTarget[]>((safe, candidate) => {
    const parsed = jobTargetSchema.safeParse(candidate);
    if (
      !parsed.success ||
      parsed.data.providerId === incident.providerId ||
      parsed.data.operation !== incident.operation ||
      safe.some((target) => sameJobTarget(target, parsed.data))
    )
      return safe;
    return [...safe, parsed.data];
  }, []);
  return {
    ...incident,
    alternateTargets,
    scopes: quotaScopeProjections(incident, scheduler),
    resumeImpact:
      incident.status === "open"
        ? scheduler.quotaResumeImpact(incident.id)
        : null,
  };
}

function quotaScopeProjections(
  incident: QuotaIncident,
  scheduler: JobScheduler,
): QuotaScopeProjection[] {
  if (incident.status !== "open") return [];
  const owned = new Set(incident.ownedJobIds);
  const jobs = scheduler.list();
  return incident.affectedScopeIds.flatMap((scopeId) => {
    const matching = jobs.filter(
      (job) =>
        owned.has(job.id) &&
        job.state === "paused" &&
        job.stateReason === "quota" &&
        job.target?.providerId === incident.providerId &&
        job.target.operation === incident.operation &&
        (job.projectId === scopeId || job.standaloneScopeId === scopeId),
    );
    const sample = matching[0];
    if (!sample) return [];
    const scope = {
      projectId: sample.projectId,
      standaloneScopeId: sample.projectId ? null : sample.standaloneScopeId,
    };
    const impact = scheduler.quotaDecisionImpact(incident.id, scope);
    return impact.affectedCount > 0 ? [{ ...scope, ...impact }] : [];
  });
}

function projectJob(
  job: JobRecord,
  byId: ReadonlyMap<string, JobRecord>,
  positions: ReadonlyMap<string, number>,
  scheduler: JobScheduler,
  nowMonoMs: number,
): QueueJobProjection {
  return {
    id: job.id,
    revision: job.revision,
    jobType: job.jobType,
    projectId: job.projectId,
    standaloneScopeId: job.standaloneScopeId,
    state: job.state,
    stateReason: job.stateReason,
    priority: job.priority,
    queuePosition: positions.get(job.id) ?? null,
    blockers: blockersFor(job, byId),
    attempts: job.attempts,
    automaticRetries: job.autoRetryIndex,
    manualRetries: job.manualRetryCount,
    progress: job.progress,
    noProgress: hasNoProgress(job, nowMonoMs),
    target: job.target,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    failure: job.failure,
    provenance: job.provenance,
    resultRefs: [...job.resultRefs],
    gate: gateFor(job),
    allowedActions: allowedActions(job),
    history: scheduler.events(job.id),
  };
}

function blockersFor(
  job: JobRecord,
  byId: ReadonlyMap<string, JobRecord>,
): QueueJobProjection["blockers"] {
  return job.dependsOn.flatMap((id) => {
    const dependency = byId.get(id);
    if (!dependency || dependency.state === "succeeded") return [];
    return [
      {
        id: dependency.id,
        state: dependency.state,
        reason: dependency.stateReason,
      },
    ];
  });
}

function hasNoProgress(job: JobRecord, nowMonoMs: number): boolean {
  const baseline = job.progress?.updatedAtMono ?? job.lease?.claimedAtMono;
  return (
    job.state === "running" &&
    baseline !== undefined &&
    nowMonoMs - baseline >= 600_000
  );
}

function gateFor(job: JobRecord): QueueJobProjection["gate"] {
  if (job.request.kind !== "human_gate") return null;
  return {
    gateKind: job.request.gateKind,
    targetId: job.request.targetId,
    targetVersionId: job.request.targetVersionId,
  };
}

function queuePositions(jobs: readonly JobRecord[]): Map<string, number> {
  const ordered = jobs
    .filter((job) => job.state === "queued")
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        (left.createdSequence ?? Number.MAX_SAFE_INTEGER) -
          (right.createdSequence ?? Number.MAX_SAFE_INTEGER),
    );
  return new Map(ordered.map((job, index) => [job.id, index + 1]));
}

function allowedActions(job: JobRecord): QueueAction[] {
  if (job.state === "waiting_review") return ["open_gate"];
  if (job.state === "claimed" || job.state === "running") return ["cancel"];
  if (job.state === "queued" || job.state === "blocked")
    return ["pause", "cancel", "priority"];
  if (job.state === "paused" && job.stateReason === "operator")
    return ["resume", "cancel", "priority"];
  if (
    job.state === "paused" &&
    !["credentials", "quota", "storage"].includes(job.stateReason ?? "")
  )
    return ["retry", "cancel", "priority"];
  if (job.state === "paused") return ["cancel", "priority"];
  return [];
}

import { dependenciesSucceeded, validateDag } from "./dag.js";
import { JobError } from "./errors.js";
import type { JobHistory } from "./history.js";
import { createIdempotencyKey, createRequestHash } from "./idempotency.js";
import type { JobRepository } from "./repository.js";
import { jobRecordSchema, type JobRecord } from "./schemas.js";
import {
  initializeState,
  isSameIntent,
  requestEnvelope,
} from "./scheduler-core.js";
import type { EnqueueJobInput, JobRegistration } from "./types.js";

export class JobEnqueuer {
  constructor(
    private readonly repository: JobRepository,
    private readonly history: JobHistory,
    private readonly registeredJobs: ReadonlyMap<string, JobRegistration>,
    private readonly nowIso: () => string,
    private readonly idFactory: () => string,
  ) {}

  enqueueInTransaction(inputs: readonly EnqueueJobInput[]): JobRecord[] {
    const persisted = this.repository.list();
    const proposedByKey = new Map<string, JobRecord>();
    let nextSequence = this.repository.nextCreatedSequence();
    const results = inputs.map((input) => {
      this.validateRegistration(input);
      const candidate = this.newJob(input, nextSequence++);
      const sameIntent = [...persisted, ...proposedByKey.values()].find((job) =>
        isSameIntent(job, candidate),
      );
      if (sameIntent) {
        if (sameIntent.requestHash !== candidate.requestHash)
          throw new JobError("JOB_INTENT_COLLISION");
        return sameIntent;
      }
      const duplicate =
        this.repository.findByIdempotencyKey(candidate.idempotencyKey) ??
        proposedByKey.get(candidate.idempotencyKey);
      if (!duplicate) {
        proposedByKey.set(candidate.idempotencyKey, candidate);
        return candidate;
      }
      if (duplicate.requestHash !== candidate.requestHash)
        throw new JobError("JOB_IDEMPOTENCY_COLLISION");
      return duplicate;
    });
    const proposed = [...proposedByKey.values()];
    validateDag(proposed, persisted);
    const all = new Map(
      [...persisted, ...proposed].map((job) => [job.id, job]),
    );
    for (const job of proposed) {
      const initialized = this.applyOpenIncidentPause(
        initializeState(job, all),
      );
      const inserted = this.repository.insert(initialized);
      this.history.append(inserted, "enqueued", {
        toState: inserted.state,
        reason: inserted.stateReason,
      });
      all.set(inserted.id, inserted);
    }
    return results.map((job) => this.repository.get(job.id) ?? job);
  }

  promoteReady(): void {
    const jobs = this.repository.list();
    const byId = new Map(jobs.map((job) => [job.id, job]));
    for (const job of jobs) {
      if (job.state !== "blocked" || !dependenciesSucceeded(job, byId))
        continue;
      const nextState =
        job.request.kind === "human_gate" ? "waiting_review" : "queued";
      const queued = this.repository.update(job, {
        ...job,
        state: nextState,
        stateReason: null,
        updatedAt: this.nowIso(),
        revision: job.revision + 1,
      });
      byId.set(queued.id, queued);
    }
  }

  private newJob(input: EnqueueJobInput, createdSequence: number): JobRecord {
    const now = this.nowIso();
    const requestHash = createRequestHash(requestEnvelope(input));
    const idempotencyKey = createIdempotencyKey({
      ...requestEnvelope(input),
      intentId: input.intentId,
    });
    return jobRecordSchema.parse({
      id: input.id ?? this.idFactory(),
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      jobType: input.jobType,
      projectId: input.projectId,
      standaloneScopeId: input.standaloneScopeId,
      dependsOn: input.dependsOn,
      priority: input.priority,
      createdSequence,
      intentId: input.intentId,
      idempotencyKey,
      requestHash,
      target: input.target,
      request: input.request,
      inputSnapshot: input.inputSnapshot,
      state: input.request.kind === "human_gate" ? "waiting_review" : "created",
      stateReason: null,
      resumeState: null,
      resumeReason: null,
      lease: null,
      attempts: 0,
      autoRetryIndex: 0,
      manualRetryCount: 0,
      retrySchedule: null,
      progress: null,
      failure: null,
      provenance: null,
      resultRefs: [],
      supersedesJobId: input.supersedesJobId ?? null,
      successorJobIds: [],
    });
  }

  private validateRegistration(input: EnqueueJobInput): void {
    const registration = this.registeredJobs.get(input.jobType);
    if (!registration) throw new JobError("JOB_TYPE_UNKNOWN", 400);
    try {
      registration.requestSchema.parse(input.request);
      registration.validateEnqueue(input);
    } catch (error) {
      if (error instanceof JobError) throw error;
      throw new JobError("JOB_REQUEST_SCHEMA_INVALID", 400, { cause: error });
    }
  }

  private applyOpenIncidentPause(job: JobRecord): JobRecord {
    const credentialIncident = this.history
      .credentialIncidents()
      .find(
        (item) =>
          item.status === "open" && item.providerId === job.target?.providerId,
      );
    if (credentialIncident && job.request.kind !== "human_gate") {
      this.history.openCredentialIncident(
        job as JobRecord & { target: NonNullable<JobRecord["target"]> },
        [job],
      );
      return {
        ...job,
        state: "paused",
        stateReason: "credentials",
        resumeState: job.state,
        resumeReason: job.stateReason,
      };
    }
    const incident = this.history
      .quotaIncidents()
      .find(
        (item) =>
          item.status === "open" &&
          item.providerId === job.target?.providerId &&
          item.operation === job.target?.operation,
      );
    if (!incident || job.request.kind === "human_gate") return job;
    this.history.openQuotaIncident(
      job as JobRecord & { target: NonNullable<JobRecord["target"]> },
      [job],
    );
    return {
      ...job,
      state: "paused",
      stateReason: "quota",
      resumeState: job.state,
      resumeReason: job.stateReason,
    };
  }
}

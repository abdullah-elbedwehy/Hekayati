import { randomUUID } from "node:crypto";

import type { DocumentStore } from "../domain/repository/document-store.js";
import { SystemJobClock } from "./clocks.js";
import {
  buildQueueProjection,
  type QueueProjection,
} from "./queue-projection.js";
import { humanGateJobRegistration } from "./registrations.js";
import { JobScheduler } from "./scheduler.js";
import type { JobTarget, QuotaIncident } from "./schemas.js";
import { JobError } from "./errors.js";
import { isDatabaseUnavailableError } from "./runtime-errors.js";
import { sameJobTarget } from "./targets.js";
import type {
  CredentialAvailabilityPort,
  EnqueueJobInput,
  JobClock,
  QuotaAvailabilityPort,
  QuotaDecisionInput,
  RegisteredJobDefinition,
  ResumeCredentialsInput,
  ResumeQuotaInput,
  StorageResumeInput,
} from "./types.js";
import { JobWorkerPool } from "./worker-pool.js";

export interface JobRuntimeOptions {
  clock?: JobClock;
  bootId?: string;
  workerId?: string;
  concurrencyPerProvider?: number;
  getConcurrencyPerProvider?: () => number;
  definitions?: readonly RegisteredJobDefinition[];
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxWorkers?: number;
  storageProbe?: () => Promise<boolean>;
  quotaAvailability?: QuotaAvailabilityPort;
  credentialAvailability?: CredentialAvailabilityPort;
  quotaAlternates?: (incident: QuotaIncident) => readonly JobTarget[];
}

export interface JobHealthSnapshot {
  status: "available";
  workerStatus: "stopped" | "running" | "halted";
  depth: number;
  counts: QueueProjection["counts"];
  runningByProvider: Record<string, number>;
  stalledCount: number;
  storage: {
    active: boolean;
    reason: QueueProjection["storage"]["reason"];
  };
  openQuotaIncidents: number;
  openCredentialIncidents: number;
  lastRecoveryAt: string | null;
}

export class JobRuntime {
  readonly scheduler: JobScheduler;
  readonly bootId: string;
  private readonly clock: JobClock;
  private readonly worker: JobWorkerPool;
  private readonly storageProbe: () => Promise<boolean>;
  private readonly quotaAvailability: QuotaAvailabilityPort;
  private readonly credentialAvailability: CredentialAvailabilityPort;
  private readonly quotaAlternates: (
    incident: QuotaIncident,
  ) => readonly JobTarget[];
  private workerStatus: JobHealthSnapshot["workerStatus"] = "stopped";
  private lastHealthSnapshot: JobHealthSnapshot | null = null;

  constructor(store: DocumentStore, options: JobRuntimeOptions = {}) {
    this.clock = options.clock ?? new SystemJobClock();
    this.bootId = options.bootId ?? randomUUID();
    const definitions = options.definitions ?? [];
    this.storageProbe = options.storageProbe ?? (() => Promise.resolve(false));
    this.quotaAvailability =
      options.quotaAvailability ?? failClosedQuotaAvailability;
    this.credentialAvailability =
      options.credentialAvailability ?? failClosedCredentialAvailability;
    this.quotaAlternates = options.quotaAlternates ?? (() => []);
    this.scheduler = new JobScheduler(store, {
      registeredJobs: [
        humanGateJobRegistration("human_gate"),
        ...definitions.map((definition) => ({
          jobType: definition.jobType,
          requestSchema: definition.requestSchema,
          validateEnqueue: (input: Readonly<EnqueueJobInput>) =>
            definition.validateEnqueue(input),
        })),
      ],
      nowIso: () => this.clock.wallNowIso(),
    });
    this.worker = new JobWorkerPool(this.scheduler, definitions, {
      bootId: this.bootId,
      workerId: options.workerId ?? randomUUID(),
      clock: this.clock,
      concurrencyPerProvider: options.concurrencyPerProvider ?? 2,
      getConcurrencyPerProvider: options.getConcurrencyPerProvider,
      leaseTtlMs: options.leaseTtlMs ?? 30_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
      timeoutMs: options.timeoutMs ?? 120_000,
      pollIntervalMs: options.pollIntervalMs ?? 250,
      maxWorkers: options.maxWorkers ?? 4,
      onDatabaseUnavailable: () => {
        this.workerStatus = "halted";
      },
    });
    this.recover();
  }

  start(): void {
    if (this.workerStatus === "halted")
      throw new JobError("JOB_DATABASE_UNAVAILABLE", 503);
    this.scheduler.updateRuntimeStatus({
      workerStatus: "running",
      bootId: this.bootId,
    });
    this.workerStatus = "running";
    this.worker.start();
  }

  async stop(): Promise<void> {
    await this.worker.stop();
    try {
      this.scheduler.updateRuntimeStatus({
        workerStatus: "stopped",
        bootId: this.bootId,
      });
      this.workerStatus = "stopped";
    } catch (error) {
      if (!isDatabaseUnavailableError(error)) throw error;
      this.workerStatus = "halted";
    }
  }

  halt(): void {
    this.worker.halt();
    this.workerStatus = "halted";
    this.scheduler.updateRuntimeStatus({
      workerStatus: "halted",
      bootId: this.bootId,
    });
  }

  queueProjection(): QueueProjection {
    const projection = buildQueueProjection(
      this.scheduler,
      this.clock.monotonicNow(),
      this.clock.wallNowIso(),
      this.quotaAlternates,
    );
    return {
      ...projection,
      storage: { ...projection.storage, workerStatus: this.workerStatus },
    };
  }

  healthSnapshot(): JobHealthSnapshot {
    try {
      const snapshot = healthFromQueue(this.queueProjection());
      this.lastHealthSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      if (!isDatabaseUnavailableError(error)) throw error;
      this.worker.halt();
      this.workerStatus = "halted";
      return {
        ...(this.lastHealthSnapshot ?? emptyHealthSnapshot()),
        workerStatus: "halted",
      };
    }
  }

  async resumeStorage(input: StorageResumeInput): Promise<string[]> {
    const passed = await this.storageProbe();
    return this.scheduler.resumeStorage(input, () => passed);
  }

  async resumeQuota(
    incidentId: string,
    input: ResumeQuotaInput,
  ): Promise<string[]> {
    const restored = await this.scheduler.resumeQuota(
      incidentId,
      input,
      this.quotaAvailability,
    );
    return restored.map((job) => job.id);
  }

  async resumeCredentials(
    incidentId: string,
    input: ResumeCredentialsInput,
  ): Promise<string[]> {
    const restored = await this.scheduler.resumeCredentials(
      incidentId,
      input,
      this.credentialAvailability,
    );
    return restored.map((job) => job.id);
  }

  async decideQuota(
    incidentId: string,
    input: QuotaDecisionInput,
  ): Promise<string[]> {
    const impact = this.scheduler.quotaDecisionImpact(incidentId, input);
    if (impact.impactHash !== input.impactHash)
      throw new JobError("JOB_IMPACT_CONFLICT");
    if (input.decision === "continue")
      await this.assertQuotaAlternateAvailable(incidentId, input);
    return this.scheduler.decideQuota(incidentId, input).map((job) => job.id);
  }

  private recover(): void {
    this.scheduler.recoverExpiredLeases(this.bootId, this.clock.monotonicNow());
    const recoveredAt = this.clock.wallNowIso();
    this.scheduler.updateRuntimeStatus({
      workerStatus: "stopped",
      bootId: this.bootId,
      lastRecoveryAt: recoveredAt,
    });
    this.workerStatus = "stopped";
  }

  private async assertQuotaAlternateAvailable(
    incidentId: string,
    input: QuotaDecisionInput,
  ): Promise<void> {
    const incident = this.scheduler
      .quotaIncidents()
      .find((candidate) => candidate.id === incidentId);
    if (!incident) throw new JobError("JOB_QUOTA_INCIDENT_NOT_FOUND", 404);
    if (incident.status !== "open")
      throw new JobError("JOB_QUOTA_INCIDENT_RESOLVED");
    if (input.expectedRevision !== incident.revision)
      throw new JobError("JOB_REVISION_CONFLICT");
    const target = input.alternateTarget;
    if (
      !target ||
      !this.quotaAlternates(incident).some((item) =>
        sameJobTarget(item, target),
      )
    )
      throw new JobError("JOB_QUOTA_ALTERNATE_UNAVAILABLE");
    if (!(await this.quotaAvailability.forceCheckExact(target)))
      throw new JobError("JOB_QUOTA_ALTERNATE_UNAVAILABLE");
  }
}

function healthFromQueue(queue: QueueProjection): JobHealthSnapshot {
  return {
    status: "available",
    workerStatus: queue.storage.workerStatus,
    depth: queue.jobs.filter((job) =>
      [
        "blocked",
        "queued",
        "claimed",
        "running",
        "paused",
        "waiting_review",
      ].includes(job.state),
    ).length,
    counts: queue.counts,
    runningByProvider: queue.runningByProvider,
    stalledCount: queue.stalledCount,
    storage: { active: queue.storage.active, reason: queue.storage.reason },
    openQuotaIncidents: queue.quotaIncidents.filter(
      (incident) => incident.status === "open",
    ).length,
    openCredentialIncidents: queue.credentialIncidents.filter(
      (incident) => incident.status === "open",
    ).length,
    lastRecoveryAt: queue.storage.lastRecoveryAt,
  };
}

function emptyHealthSnapshot(): JobHealthSnapshot {
  return {
    status: "available",
    workerStatus: "halted",
    depth: 0,
    counts: {
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
    },
    runningByProvider: {},
    stalledCount: 0,
    storage: { active: false, reason: null },
    openQuotaIncidents: 0,
    openCredentialIncidents: 0,
    lastRecoveryAt: null,
  };
}

const failClosedQuotaAvailability: QuotaAvailabilityPort = {
  forceCheckExact: () => Promise.resolve(false),
};

const failClosedCredentialAvailability: CredentialAvailabilityPort = {
  forceCheckExact: () => Promise.resolve(false),
};

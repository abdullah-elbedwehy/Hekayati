import type { NormalizedFailure } from "../providers/failures.js";
import {
  assertOwned,
  dependenciesReady,
  emptyStateCounts,
  isCredentialPausable,
  isManuallyRetryable,
  isQuotaPausable,
  isStalled,
  isStorageFailure,
  isStoragePausable,
  matchesProvider,
  matchesQuota,
  restoreState,
  resumableState,
  safeFailure,
} from "./control-helpers.js";
import { JobError } from "./errors.js";
import type { JobHistory } from "./history.js";
import type { JobRepository } from "./repository.js";
import { decideFailure } from "./retry-policy.js";
import type {
  JobEvent,
  JobRecord,
  JobState,
  CredentialIncident,
  CredentialRemediationAudit,
  QuotaDecisionAudit,
  QuotaIncident,
  StorageControl,
} from "./schemas.js";
import {
  confirmStorageResume,
  storageResumeImpact as calculateStorageResumeImpact,
} from "./storage-resume.js";
import type {
  ExpectedJobState,
  FailureTiming,
  JobFence,
  ProgressInput,
  StorageResumeImpact,
  StorageResumeInput,
} from "./types.js";

const terminalStates = new Set<JobState>(["succeeded", "failed", "canceled"]);
const ownerOnlyGateKinds = new Set([
  "customer_approval",
  "print_converted_proof",
]);

export interface QueueSnapshot {
  counts: Record<JobState, number>;
  stalledCount: number;
  runningByProvider: Record<string, number>;
}

export class JobControls {
  constructor(
    private readonly repository: JobRepository,
    private readonly history: JobHistory,
    private readonly nowIso: () => string,
    private readonly promoteReady: () => void,
  ) {}

  events(jobId: string): JobEvent[] {
    return this.history.events(jobId);
  }

  quotaIncidents(): QuotaIncident[] {
    return this.history.quotaIncidents();
  }

  credentialIncidents(): CredentialIncident[] {
    return this.history.credentialIncidents();
  }

  credentialAuditEvents(): CredentialRemediationAudit[] {
    return this.history.credentialAuditEvents();
  }

  auditEvents(): QuotaDecisionAudit[] {
    return this.history.auditEvents();
  }

  storageStatus(): StorageControl {
    return this.history.storageStatus();
  }

  updateRuntimeStatus(input: {
    workerStatus: StorageControl["workerStatus"];
    bootId: string;
    lastRecoveryAt?: string;
  }): StorageControl {
    return this.history.updateStorage({
      workerStatus: input.workerStatus,
      bootId: input.bootId,
      ...(input.lastRecoveryAt ? { lastRecoveryAt: input.lastRecoveryAt } : {}),
    });
  }

  setPriority(
    id: string,
    input: ExpectedJobState & { priority: number },
  ): JobRecord {
    if (
      !Number.isInteger(input.priority) ||
      input.priority < 1 ||
      input.priority > 5
    )
      throw new JobError("JOB_PRIORITY_INVALID", 400);
    return this.repository.transaction(() => {
      const current = this.expected(id, input);
      if (
        !["queued", "blocked", "paused", "waiting_review"].includes(
          current.state,
        )
      )
        throw new JobError("JOB_ACTION_NOT_ALLOWED");
      const updated = this.update(current, { priority: input.priority });
      this.history.append(updated, "priority_changed", {
        fromState: current.state,
        toState: updated.state,
        noteCode: `priority_${input.priority}`,
      });
      return updated;
    });
  }

  pause(id: string, input: ExpectedJobState): JobRecord {
    return this.repository.transaction(() => {
      const current = this.expected(id, input);
      if (!["queued", "blocked"].includes(current.state))
        throw new JobError("JOB_ACTION_NOT_ALLOWED");
      const paused = this.update(current, {
        state: "paused",
        stateReason: "operator",
        resumeState: current.state,
        resumeReason: current.stateReason,
      });
      this.history.append(paused, "paused", {
        fromState: current.state,
        toState: "paused",
        reason: "operator",
      });
      return paused;
    });
  }

  pauseOwnedForIntegrity(
    id: string,
    input: { expectedRevision: number },
    ownerVerify: (job: JobRecord) => boolean,
  ): JobRecord {
    return this.repository.transaction(() => {
      const current = this.requireJob(id);
      if (current.revision !== input.expectedRevision)
        throw new JobError("JOB_REVISION_CONFLICT");
      if (!ownerVerify(current)) throw new JobError("JOB_OWNER_REJECTED");
      if (terminalStates.has(current.state))
        throw new JobError("JOB_ACTION_NOT_ALLOWED");
      if (current.state === "paused") return current;
      const paused = this.update(current, {
        state: "paused",
        stateReason: "asset_integrity",
        resumeState: resumableState(current.state),
        resumeReason: current.stateReason,
        lease: null,
      });
      this.history.append(paused, "paused", {
        fromState: current.state,
        toState: "paused",
        reason: "asset_integrity",
      });
      return paused;
    });
  }

  releaseOwnedIntegrityPause(
    id: string,
    input: { expectedRevision: number },
    ownerVerify: (job: JobRecord) => boolean,
  ): JobRecord {
    return this.repository.transaction(() => {
      const current = this.requireJob(id);
      if (current.revision !== input.expectedRevision)
        throw new JobError("JOB_REVISION_CONFLICT");
      if (!ownerVerify(current)) throw new JobError("JOB_OWNER_REJECTED");
      if (
        current.state !== "paused" ||
        current.stateReason !== "asset_integrity"
      )
        throw new JobError("JOB_ACTION_NOT_ALLOWED");
      const paused = this.update(current, { stateReason: "operator" });
      this.history.append(paused, "paused", {
        fromState: "paused",
        toState: "paused",
        reason: "operator",
        noteCode: "integrity_repaired",
      });
      return paused;
    });
  }

  resume(id: string, input: ExpectedJobState): JobRecord {
    return this.repository.transaction(() => {
      const current = this.expected(id, input);
      if (current.state !== "paused" || current.stateReason !== "operator")
        throw new JobError("JOB_ACTION_NOT_ALLOWED");
      const resumed = this.update(current, restoreState(current));
      this.history.append(resumed, "resumed", {
        fromState: "paused",
        toState: resumed.state,
        reason: "operator",
      });
      this.promoteReady();
      return resumed;
    });
  }

  retry(id: string, input: ExpectedJobState): JobRecord {
    return this.repository.transaction(() => {
      const current = this.expected(id, input);
      if (!isManuallyRetryable(current))
        throw new JobError("JOB_ACTION_NOT_ALLOWED");
      const jobs = new Map(this.repository.list().map((job) => [job.id, job]));
      const state = dependenciesReady(current, jobs) ? "queued" : "blocked";
      const retried = this.update(current, {
        state,
        stateReason: state === "blocked" ? "dependency" : null,
        resumeState: null,
        resumeReason: null,
        lease: null,
        retrySchedule: null,
        failure: null,
        progress: null,
        autoRetryIndex: 0,
        manualRetryCount: current.manualRetryCount + 1,
      });
      this.history.append(retried, "retry_scheduled", {
        fromState: current.state,
        toState: state,
        reason: "manual_retry",
      });
      return retried;
    });
  }

  pauseProject(projectId: string): string[] {
    return this.repository.transaction(() => {
      const affected: string[] = [];
      for (const job of this.repository.list()) {
        if (
          job.projectId !== projectId ||
          !["queued", "blocked"].includes(job.state)
        )
          continue;
        const paused = this.update(job, {
          state: "paused",
          stateReason: "operator",
          resumeState: job.state,
          resumeReason: job.stateReason,
        });
        this.history.append(paused, "paused", {
          fromState: job.state,
          toState: "paused",
          reason: "operator",
        });
        affected.push(job.id);
      }
      return affected;
    });
  }

  resumeProject(projectId: string): string[] {
    return this.repository.transaction(() => {
      const affected: string[] = [];
      for (const job of this.repository.list()) {
        if (
          job.projectId !== projectId ||
          job.state !== "paused" ||
          job.stateReason !== "operator"
        )
          continue;
        const resumed = this.update(job, restoreState(job));
        this.history.append(resumed, "resumed", {
          fromState: "paused",
          toState: resumed.state,
          reason: "operator",
        });
        affected.push(job.id);
      }
      this.promoteReady();
      return affected;
    });
  }

  cancel(id: string, input: ExpectedJobState): JobRecord {
    return this.repository.transaction(() => {
      const current = this.expected(id, input);
      if (
        current.request.kind === "human_gate" &&
        ownerOnlyGateKinds.has(current.request.gateKind)
      )
        throw new JobError("JOB_GATE_OWNER_ACTION_REQUIRED");
      if (terminalStates.has(current.state))
        throw new JobError("JOB_ACTION_NOT_ALLOWED");
      const canceled = this.update(current, {
        state: "canceled",
        stateReason: "user_canceled",
        lease: null,
        retrySchedule: null,
        resumeState: null,
        resumeReason: null,
      });
      this.history.append(canceled, "canceled", {
        fromState: current.state,
        toState: "canceled",
        reason: "user_canceled",
      });
      return canceled;
    });
  }

  cancelOwnedHumanGate(
    id: string,
    input: {
      expectedRevision: number;
      targetVersionId: string;
      reason: string;
    },
    ownerVerify: (job: JobRecord) => boolean,
  ): JobRecord {
    return this.repository.transaction(() => {
      const current = this.requireJob(id);
      if (current.revision !== input.expectedRevision)
        throw new JobError("JOB_REVISION_CONFLICT");
      if (
        current.request.kind !== "human_gate" ||
        !ownerOnlyGateKinds.has(current.request.gateKind) ||
        current.state !== "waiting_review"
      )
        throw new JobError("JOB_GATE_NOT_WAITING");
      if (current.request.targetVersionId !== input.targetVersionId)
        throw new JobError("JOB_GATE_VERSION_MISMATCH");
      if (!ownerVerify(current)) throw new JobError("JOB_GATE_OWNER_REJECTED");
      const canceled = this.update(current, {
        state: "canceled",
        stateReason: input.reason,
        lease: null,
        retrySchedule: null,
        resumeState: null,
        resumeReason: null,
      });
      this.history.append(canceled, "canceled", {
        fromState: "waiting_review",
        toState: "canceled",
        reason: input.reason,
      });
      return canceled;
    });
  }

  recordProgress(id: string, fence: JobFence, input: ProgressInput): JobRecord {
    return this.repository.transaction(() => {
      const current = this.requireJob(id);
      assertOwned(current, fence, input.nowMonoMs, "running");
      const previous = current.progress;
      if (
        previous?.attempt === current.attempts &&
        input.percent < previous.percent
      )
        throw new JobError("JOB_PROGRESS_REGRESSION");
      const updated = this.repository.update(current, {
        ...current,
        progress: {
          attempt: current.attempts,
          percent: input.percent,
          noteCode: input.noteCode,
          updatedAtMono: input.nowMonoMs,
          noProgress: false,
        },
        updatedAt: input.wallNowIso,
        revision: current.revision + 1,
      });
      this.history.append(updated, "progress", {
        fromState: "running",
        toState: "running",
        noteCode: input.noteCode,
      });
      return updated;
    });
  }

  queueSnapshot(nowMonoMs: number, stallThresholdMs = 600_000): QueueSnapshot {
    const jobs = this.repository.list();
    const counts = emptyStateCounts();
    const runningByProvider: Record<string, number> = {};
    let stalledCount = 0;
    for (const job of jobs) {
      counts[job.state] += 1;
      if (job.state !== "running") continue;
      if (isStalled(job, nowMonoMs, stallThresholdMs)) stalledCount += 1;
      if (job.target) {
        const provider = job.target.providerId;
        runningByProvider[provider] = (runningByProvider[provider] ?? 0) + 1;
      }
    }
    return { counts, stalledCount, runningByProvider };
  }

  recordFailure(
    id: string,
    fence: JobFence,
    failure: NormalizedFailure,
    timing: FailureTiming,
  ): JobRecord {
    if (failure.category === "database_unavailable")
      throw new JobError("JOB_DATABASE_UNAVAILABLE", 503);
    return this.repository.transaction(() => {
      const current = this.requireJob(id);
      assertOwned(current, fence, timing.nowMonoMs, "running");
      const persistedFailure = safeFailure(failure);
      if (persistedFailure.category === "invalid_credentials")
        return this.activateCredentials(current, persistedFailure);
      if (persistedFailure.category === "quota_exhausted")
        return this.activateQuota(current, persistedFailure);
      if (isStorageFailure(persistedFailure))
        return this.activateStorage(
          current,
          persistedFailure,
          timing.wallNowIso,
        );
      return this.applyFailureDecision(current, persistedFailure, timing);
    });
  }

  storageResumeImpact(): StorageResumeImpact {
    return calculateStorageResumeImpact(
      this.history.storageStatus(),
      this.repository.list(),
    );
  }

  resumeStorage(input: StorageResumeInput, probe: () => boolean): string[] {
    confirmStorageResume(
      this.history.storageStatus(),
      this.repository.list(),
      input,
    );
    if (!probe()) {
      this.recordFailedStorageProbe(input);
      throw new JobError("JOB_STORAGE_PROBE_FAILED");
    }
    return this.commitStorageResume(input);
  }

  completeHumanGate(
    id: string,
    input: { expectedRevision: number; targetVersionId: string },
    ownerVerify: (job: JobRecord) => boolean,
  ): JobRecord {
    return this.repository.transaction(() => {
      const current = this.requireJob(id);
      if (current.revision !== input.expectedRevision)
        throw new JobError("JOB_REVISION_CONFLICT");
      if (
        current.request.kind !== "human_gate" ||
        current.state !== "waiting_review"
      )
        throw new JobError("JOB_GATE_NOT_WAITING");
      if (current.request.targetVersionId !== input.targetVersionId)
        throw new JobError("JOB_GATE_VERSION_MISMATCH");
      if (!ownerVerify(current)) throw new JobError("JOB_GATE_OWNER_REJECTED");
      const succeeded = this.update(current, {
        state: "succeeded",
        stateReason: null,
      });
      this.history.append(succeeded, "gate_completed", {
        fromState: "waiting_review",
        toState: "succeeded",
      });
      this.promoteReady();
      return succeeded;
    });
  }

  private applyFailureDecision(
    current: JobRecord,
    failure: NonNullable<JobRecord["failure"]>,
    timing: FailureTiming,
  ): JobRecord {
    const decision = decideFailure(
      failure.category,
      current.autoRetryIndex,
      failure.retryAfterMs,
    );
    if (decision.action === "retry")
      return this.scheduleRetry(current, failure, timing, decision.delayMs);
    if (decision.action === "halt")
      throw new JobError("JOB_DATABASE_UNAVAILABLE", 503);
    if (decision.action === "pause_all")
      throw new JobError("JOB_STORAGE_FAILURE_REQUIRED");
    const state: JobState =
      decision.action === "cancel"
        ? "canceled"
        : decision.action === "fail"
          ? "failed"
          : "paused";
    const reason = failure.reasonCode ?? decision.reason;
    const updated = this.update(current, {
      state,
      stateReason: reason,
      lease: null,
      failure,
    });
    this.history.append(
      updated,
      state === "paused"
        ? "paused"
        : state === "canceled"
          ? "canceled"
          : "failed",
      {
        fromState: current.state,
        toState: updated.state,
        reason,
        noteCode: failure.category,
      },
    );
    return updated;
  }

  private scheduleRetry(
    current: JobRecord,
    failure: NonNullable<JobRecord["failure"]>,
    timing: FailureTiming,
    delayMs: number,
  ): JobRecord {
    const dueAt = new Date(
      Date.parse(timing.wallNowIso) + delayMs,
    ).toISOString();
    const updated = this.update(current, {
      state: "queued",
      stateReason: "retry_delay",
      lease: null,
      failure,
      autoRetryIndex: current.autoRetryIndex + 1,
      retrySchedule: {
        scheduledAt: timing.wallNowIso,
        nextEligibleAt: dueAt,
        bootId: current.lease!.bootId,
        nextEligibleAtMono: timing.nowMonoMs + delayMs,
        delayMs,
      },
    });
    this.history.append(updated, "retry_scheduled", {
      fromState: current.state,
      toState: "queued",
      reason: "retry_delay",
      noteCode: failure.category,
    });
    return updated;
  }

  private activateQuota(
    source: JobRecord,
    failure: NonNullable<JobRecord["failure"]>,
  ): JobRecord {
    if (!source.target) throw new JobError("JOB_TARGET_REQUIRED");
    const candidates = this.repository
      .list()
      .filter(
        (job) => matchesQuota(job, source) && isQuotaPausable(job, source.id),
      );
    this.history.openQuotaIncident(
      source as JobRecord & { target: NonNullable<JobRecord["target"]> },
      candidates,
    );
    const affected: JobRecord[] = [];
    for (const job of candidates) {
      const paused = this.update(job, {
        state: "paused",
        stateReason: "quota",
        resumeState: resumableState(job.state),
        resumeReason: job.state === "paused" ? job.stateReason : null,
        lease: null,
        failure: job.id === source.id ? failure : job.failure,
      });
      this.history.append(paused, "paused", {
        fromState: job.state,
        toState: "paused",
        reason: "quota",
        noteCode: failure.category,
      });
      affected.push(paused);
    }
    return affected.find((job) => job.id === source.id)!;
  }

  private activateCredentials(
    source: JobRecord,
    failure: NonNullable<JobRecord["failure"]>,
  ): JobRecord {
    if (!source.target) throw new JobError("JOB_TARGET_REQUIRED");
    const candidates = this.repository
      .list()
      .filter(
        (job) =>
          matchesProvider(job, source) && isCredentialPausable(job, source.id),
      );
    this.history.openCredentialIncident(
      source as JobRecord & { target: NonNullable<JobRecord["target"]> },
      candidates,
    );
    const affected: JobRecord[] = [];
    for (const job of candidates) {
      const paused = this.update(job, {
        state: "paused",
        stateReason: "credentials",
        resumeState: resumableState(job.state),
        resumeReason:
          job.state === "paused" ? job.stateReason : job.stateReason,
        lease: null,
        failure: job.id === source.id ? failure : job.failure,
      });
      this.history.append(paused, "paused", {
        fromState: job.state,
        toState: "paused",
        reason: "credentials",
        noteCode: failure.category,
      });
      affected.push(paused);
    }
    return affected.find((job) => job.id === source.id)!;
  }

  private activateStorage(
    source: JobRecord,
    failure: NonNullable<JobRecord["failure"]>,
    detectedAt: string,
  ): JobRecord {
    let sourceResult: JobRecord | null = null;
    const ownedJobIds: string[] = [];
    for (const job of this.repository.list()) {
      if (!isStoragePausable(job)) continue;
      const paused = this.update(job, {
        state: "paused",
        stateReason: "storage",
        resumeState: resumableState(job.state),
        resumeReason: job.state === "paused" ? job.stateReason : null,
        lease: null,
        failure: job.id === source.id ? failure : job.failure,
      });
      this.history.append(paused, "paused", {
        fromState: job.state,
        toState: "paused",
        reason: "storage",
        noteCode: failure.category,
      });
      ownedJobIds.push(paused.id);
      if (job.id === source.id) sourceResult = paused;
    }
    this.history.openStorageIncident({
      reason: failure.category as NonNullable<StorageControl["reason"]>,
      detectedAt,
      ownedJobIds,
    });
    if (!sourceResult) throw new JobError("JOB_STORAGE_SOURCE_MISSING");
    return sourceResult;
  }

  private recordFailedStorageProbe(input: StorageResumeInput): void {
    this.repository.transaction(() => {
      confirmStorageResume(
        this.history.storageStatus(),
        this.repository.list(),
        input,
      );
      this.history.updateStorage({
        lastProbeAt: this.nowIso(),
        lastProbeStatus: "failed",
      });
    });
  }

  private commitStorageResume(input: StorageResumeInput): string[] {
    return this.repository.transaction(() => {
      const affected = confirmStorageResume(
        this.history.storageStatus(),
        this.repository.list(),
        input,
      );
      for (const job of affected) this.restoreStorageJob(job);
      this.history.updateStorage({
        active: false,
        reason: null,
        incidentId: null,
        ownedJobIds: [],
        detectedAt: null,
        lastProbeAt: this.nowIso(),
        lastProbeStatus: "succeeded",
      });
      this.promoteReady();
      return affected.map((job) => job.id);
    });
  }

  private restoreStorageJob(job: JobRecord): void {
    const resumed = this.update(job, restoreState(job));
    this.history.append(resumed, "resumed", {
      fromState: "paused",
      toState: resumed.state,
      reason: "storage",
    });
  }

  private expected(id: string, input: ExpectedJobState): JobRecord {
    const current = this.requireJob(id);
    if (current.revision !== input.expectedRevision)
      throw new JobError("JOB_REVISION_CONFLICT");
    if (current.state !== input.expectedState)
      throw new JobError("JOB_STATE_CONFLICT");
    return current;
  }

  private requireJob(id: string): JobRecord {
    const job = this.repository.get(id);
    if (!job) throw new JobError("JOB_NOT_FOUND", 404);
    return job;
  }

  private update(current: JobRecord, changes: Partial<JobRecord>): JobRecord {
    return this.repository.update(current, {
      ...current,
      ...changes,
      updatedAt: this.nowIso(),
      revision: current.revision + 1,
    });
  }
}

export { assertOwned } from "./control-helpers.js";

import { randomUUID } from "node:crypto";

import { ulid } from "ulid";

import type { DocumentStore } from "../domain/repository/document-store.js";
import type { NormalizedFailure } from "../providers/failures.js";
import { assertOwned, JobControls, type QueueSnapshot } from "./controls.js";
import { JobError } from "./errors.js";
import { JobHistory } from "./history.js";
import { JobRepository } from "./repository.js";
import {
  type CredentialIncident,
  type CredentialRemediationAudit,
  type JobEvent,
  type JobRecord,
  type JobTarget,
  type ProviderTargetChangeAudit,
  type QuotaDecisionAudit,
  type QuotaIncident,
  type StorageControl,
} from "./schemas.js";
import {
  isExpired,
  projectActionImpact as calculateProjectActionImpact,
  validateClaimOptions,
} from "./scheduler-core.js";
import { JobEnqueuer } from "./scheduler-enqueuer.js";
import {
  assertQuotaResumeImpact,
  credentialImpact,
  credentialIncidentJobs,
  forceCheckQuotaTargets,
  quotaDecisionRequestHash,
  quotaImpact,
  quotaIncidentJobs,
  quotaResumeImpact,
  quotaResumeRequestHash,
  quotaScopeJobs,
  quotaSuccessorInput,
  sameTargets,
} from "./scheduler-incidents.js";
import { JobRetargeter } from "./scheduler-retargeter.js";
import { linkSupersedingSuccessor } from "./scheduler-successors.js";
import type {
  ClaimOptions,
  CommitSuccessInput,
  CredentialAvailabilityPort,
  EnqueueJobInput,
  ExpectedJobState,
  FailureTiming,
  HeartbeatOptions,
  JobFence,
  JobSchedulerOptions,
  ProgressInput,
  QuotaAvailabilityPort,
  QuotaDecisionInput,
  ResumeQuotaInput,
  ResumeCredentialsInput,
  RetargetInput,
  RetargetPreview,
  StorageResumeImpact,
  StorageResumeInput,
} from "./types.js";

export class JobScheduler {
  private readonly repository: JobRepository;
  private readonly history: JobHistory;
  private readonly enqueuer: JobEnqueuer;
  private readonly retargeter: JobRetargeter;
  private readonly controls: JobControls;
  private readonly nowIso: () => string;
  private readonly idFactory: () => string;
  private readonly claimTokenFactory: () => string;

  constructor(store: DocumentStore, options: JobSchedulerOptions) {
    this.repository = new JobRepository(store);
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
    this.claimTokenFactory = options.claimTokenFactory ?? randomUUID;
    this.history = new JobHistory(store, this.nowIso);
    this.enqueuer = new JobEnqueuer(
      this.repository,
      this.history,
      new Map(options.registeredJobs.map((item) => [item.jobType, item])),
      this.nowIso,
      this.idFactory,
    );
    this.retargeter = new JobRetargeter(
      this.repository,
      this.history,
      this.enqueuer,
      this.nowIso,
      this.idFactory,
    );
    this.controls = new JobControls(
      this.repository,
      this.history,
      this.nowIso,
      () => this.enqueuer.promoteReady(),
    );
  }

  enqueue(input: EnqueueJobInput): JobRecord {
    return this.enqueueMany([input])[0];
  }

  enqueueMany(inputs: readonly EnqueueJobInput[]): JobRecord[] {
    return this.repository.transaction(() =>
      this.enqueuer.enqueueInTransaction(inputs),
    );
  }

  get(id: string): JobRecord | null {
    return this.repository.get(id);
  }

  list(): JobRecord[] {
    return this.repository.list();
  }

  events(jobId: string): JobEvent[] {
    return this.controls.events(jobId);
  }

  quotaIncidents(): QuotaIncident[] {
    return this.controls.quotaIncidents();
  }

  credentialIncidents(): CredentialIncident[] {
    return this.controls.credentialIncidents();
  }

  credentialAuditEvents(): CredentialRemediationAudit[] {
    return this.controls.credentialAuditEvents();
  }

  auditEvents(): QuotaDecisionAudit[] {
    return this.controls.auditEvents();
  }

  targetChangeAudits(): ProviderTargetChangeAudit[] {
    return this.history.targetChangeAudits();
  }

  storageStatus(): StorageControl {
    return this.controls.storageStatus();
  }

  updateRuntimeStatus(input: {
    workerStatus: StorageControl["workerStatus"];
    bootId: string;
    lastRecoveryAt?: string;
  }): StorageControl {
    return this.controls.updateRuntimeStatus(input);
  }

  setPriority(
    id: string,
    input: ExpectedJobState & { priority: number },
  ): JobRecord {
    return this.controls.setPriority(id, input);
  }

  pause(id: string, input: ExpectedJobState): JobRecord {
    return this.controls.pause(id, input);
  }

  pauseOwnedForIntegrity(
    id: string,
    input: { expectedRevision: number },
    ownerVerify: (job: JobRecord) => boolean,
  ): JobRecord {
    return this.controls.pauseOwnedForIntegrity(id, input, ownerVerify);
  }

  releaseOwnedIntegrityPause(
    id: string,
    input: { expectedRevision: number },
    ownerVerify: (job: JobRecord) => boolean,
  ): JobRecord {
    return this.controls.releaseOwnedIntegrityPause(id, input, ownerVerify);
  }

  resume(id: string, input: ExpectedJobState): JobRecord {
    return this.controls.resume(id, input);
  }

  retry(id: string, input: ExpectedJobState): JobRecord {
    return this.controls.retry(id, input);
  }

  projectActionImpact(
    projectId: string,
    action: "pause" | "resume",
  ): { impactHash: string; affectedCount: number } {
    return calculateProjectActionImpact(
      this.repository.list(),
      projectId,
      action,
    );
  }

  pauseProject(projectId: string, expectedImpactHash?: string): string[] {
    return this.applyProjectAction(projectId, "pause", expectedImpactHash);
  }

  resumeProject(projectId: string, expectedImpactHash?: string): string[] {
    return this.applyProjectAction(projectId, "resume", expectedImpactHash);
  }

  quotaDecisionImpact(
    incidentId: string,
    scope: Pick<QuotaDecisionInput, "projectId" | "standaloneScopeId">,
  ): { impactHash: string; affectedCount: number } {
    const incident = this.history.quotaIncident(incidentId);
    const affected = quotaScopeJobs(this.repository.list(), incident, scope);
    return quotaImpact(incident, scope, affected);
  }

  quotaResumeImpact(incidentId: string): {
    impactHash: string;
    affectedCount: number;
  } {
    const incident = this.history.quotaIncident(incidentId);
    return quotaResumeImpact(
      incident,
      quotaIncidentJobs(this.repository.list(), incident),
    );
  }

  credentialResumeImpact(incidentId: string): {
    impactHash: string;
    affectedCount: number;
  } {
    const incident = this.history.credentialIncident(incidentId);
    const affected = credentialIncidentJobs(this.repository.list(), incident);
    return credentialImpact(incident, affected);
  }

  cancel(id: string, input: ExpectedJobState): JobRecord {
    return this.controls.cancel(id, input);
  }

  recordProgress(id: string, fence: JobFence, input: ProgressInput): JobRecord {
    return this.controls.recordProgress(id, fence, input);
  }

  queueSnapshot(nowMonoMs: number, stallThresholdMs?: number): QueueSnapshot {
    return this.controls.queueSnapshot(nowMonoMs, stallThresholdMs);
  }

  recordFailure(
    id: string,
    fence: JobFence,
    failure: NormalizedFailure,
    timing: FailureTiming,
  ): JobRecord {
    return this.controls.recordFailure(id, fence, failure, timing);
  }

  storageResumeImpact(): StorageResumeImpact {
    return this.controls.storageResumeImpact();
  }

  resumeStorage(input: StorageResumeInput, probe: () => boolean): string[] {
    return this.controls.resumeStorage(input, probe);
  }

  completeHumanGate(
    id: string,
    input: { expectedRevision: number; targetVersionId: string },
    ownerVerify: (job: JobRecord) => boolean,
  ): JobRecord {
    return this.controls.completeHumanGate(id, input, ownerVerify);
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
    return this.controls.cancelOwnedHumanGate(id, input, ownerVerify);
  }

  decideQuota(incidentId: string, input: QuotaDecisionInput): JobRecord[] {
    const requestHash = quotaDecisionRequestHash(incidentId, input);
    return this.repository.transaction(() => {
      const replay = this.replayQuotaAction(input.actionId, requestHash);
      if (replay) return replay;
      const incident = this.requireOpenQuotaIncident(
        incidentId,
        input.expectedRevision,
      );
      if (this.history.quotaDecisionForScope({ incidentId, ...input }))
        throw new JobError("JOB_QUOTA_SCOPE_DECIDED");
      const affected = quotaScopeJobs(this.repository.list(), incident, input);
      if (
        quotaImpact(incident, input, affected).impactHash !== input.impactHash
      )
        throw new JobError("JOB_IMPACT_CONFLICT");
      if (input.decision === "wait") {
        this.appendQuotaAudit(incidentId, input, requestHash, affected, []);
        return [];
      }
      const successors = this.continueQuota(incident, input, affected);
      this.appendQuotaAudit(
        incidentId,
        input,
        requestHash,
        affected,
        successors,
      );
      return successors;
    });
  }

  async resumeQuota(
    incidentId: string,
    input: ResumeQuotaInput,
    availability: QuotaAvailabilityPort,
  ): Promise<JobRecord[]> {
    const requestHash = quotaResumeRequestHash(incidentId, input);
    const replay = this.replayQuotaAction(input.actionId, requestHash);
    if (replay) return replay;
    const snapshot = this.requireOpenQuotaIncident(
      incidentId,
      input.expectedRevision,
    );
    const snapshotImpact = quotaResumeImpact(
      snapshot,
      quotaIncidentJobs(this.repository.list(), snapshot),
    );
    assertQuotaResumeImpact(snapshotImpact, input);
    await forceCheckQuotaTargets(snapshot.originalTargets, availability);
    return this.commitQuotaResume(snapshot, input, requestHash);
  }

  private commitQuotaResume(
    snapshot: QuotaIncident,
    input: ResumeQuotaInput,
    requestHash: string,
  ): JobRecord[] {
    return this.repository.transaction(() => {
      const repeated = this.replayQuotaAction(input.actionId, requestHash);
      if (repeated) return repeated;
      const current = this.requireOpenQuotaIncident(
        snapshot.id,
        input.expectedRevision,
      );
      if (!sameTargets(current.originalTargets, snapshot.originalTargets))
        throw new JobError("JOB_REVISION_CONFLICT");
      const currentImpact = quotaResumeImpact(
        current,
        quotaIncidentJobs(this.repository.list(), current),
      );
      assertQuotaResumeImpact(currentImpact, input);
      const restored = this.restoreQuotaIncident(current);
      this.history.appendAudit({
        actionId: input.actionId,
        requestHash,
        incidentId: current.id,
        projectId: null,
        standaloneScopeId: null,
        decision: "resume",
        impactHash: input.impactHash,
        alternateTarget: null,
        affectedJobIds: restored.map((job) => job.id),
        successorJobIds: [],
      });
      return restored;
    });
  }

  async resumeCredentials(
    incidentId: string,
    input: ResumeCredentialsInput,
    availability: CredentialAvailabilityPort,
  ): Promise<JobRecord[]> {
    const snapshot = this.requireOpenCredentialIncident(
      incidentId,
      input.expectedRevision,
    );
    const affected = credentialIncidentJobs(this.repository.list(), snapshot);
    if (credentialImpact(snapshot, affected).impactHash !== input.impactHash)
      throw new JobError("JOB_IMPACT_CONFLICT");
    for (const target of snapshot.originalTargets) {
      let available: boolean;
      try {
        available = await availability.forceCheckExact(target);
      } catch {
        throw new JobError("JOB_CREDENTIAL_AVAILABILITY_CHECK_FAILED");
      }
      if (!available) throw new JobError("JOB_CREDENTIAL_TARGET_UNAVAILABLE");
    }
    return this.repository.transaction(() => {
      const current = this.requireOpenCredentialIncident(
        incidentId,
        input.expectedRevision,
      );
      if (!sameTargets(current.originalTargets, snapshot.originalTargets))
        throw new JobError("JOB_REVISION_CONFLICT");
      const currentAffected = credentialIncidentJobs(
        this.repository.list(),
        current,
      );
      if (
        credentialImpact(current, currentAffected).impactHash !==
        input.impactHash
      )
        throw new JobError("JOB_IMPACT_CONFLICT");
      return this.restoreCredentialIncident(
        current,
        currentAffected,
        input.impactHash,
      );
    });
  }

  previewRetarget(
    targets: readonly NonNullable<JobRecord["target"]>[],
  ): RetargetPreview {
    return this.retargeter.preview(targets);
  }

  hasRetargetableOperation(operation: JobTarget["operation"]): boolean {
    return this.retargeter.hasRetargetableOperation(operation);
  }

  retargetRemaining<T extends { updatedAt: string }>(
    input: RetargetInput & { expectedSettingsUpdatedAt: string },
    commitSettings: () => T,
  ): { settings: T; successors: JobRecord[] } {
    return this.retargeter.retargetRemaining(input, commitSettings);
  }

  claimNext(options: ClaimOptions): JobRecord | null {
    validateClaimOptions(options);
    return this.repository.transaction(() => {
      if (this.history.storageStatus().active) return null;
      this.enqueuer.promoteReady();
      const claimed = this.repository.claimNext(
        options,
        {
          workerId: options.workerId,
          bootId: options.bootId,
          claimToken: this.claimTokenFactory(),
          claimedAtMono: options.nowMonoMs,
          expiresAtMono: options.nowMonoMs + options.leaseTtlMs,
        },
        new Date(options.nowWallMs).toISOString(),
      );
      if (claimed)
        this.history.append(claimed, "claimed", {
          fromState: "queued",
          toState: "claimed",
        });
      return claimed;
    });
  }

  markRunning(id: string, fence: JobFence, nowMonoMs: number): JobRecord {
    return this.repository.transaction(() => {
      const current = this.requireJob(id);
      assertOwned(current, fence, nowMonoMs, "claimed");
      const running = this.repository.update(current, {
        ...current,
        state: "running",
        updatedAt: this.nowIso(),
        revision: current.revision + 1,
      });
      this.history.append(running, "running", {
        fromState: "claimed",
        toState: "running",
      });
      return running;
    });
  }

  heartbeat(id: string, fence: JobFence, options: HeartbeatOptions): JobRecord {
    return this.repository.transaction(() => {
      const current = this.requireJob(id);
      assertOwned(current, fence, options.nowMonoMs, "running");
      const heartbeat = this.repository.update(current, {
        ...current,
        updatedAt: options.wallNowIso,
        revision: current.revision + 1,
        lease: {
          ...current.lease!,
          expiresAtMono: options.nowMonoMs + options.leaseTtlMs,
        },
      });
      return heartbeat;
    });
  }

  recoverExpiredLeases(currentBootId: string, nowMonoMs: number): string[] {
    return this.repository.transaction(() => {
      const recovered: string[] = [];
      for (const job of this.repository.list()) {
        if (!isExpired(job, currentBootId, nowMonoMs)) continue;
        const queued = this.repository.update(job, {
          ...job,
          state: "queued",
          stateReason: "recovered",
          lease: null,
          updatedAt: this.nowIso(),
          revision: job.revision + 1,
        });
        this.history.append(queued, "recovered", {
          fromState: job.state,
          toState: "queued",
          reason: "recovered",
        });
        recovered.push(job.id);
      }
      return recovered;
    });
  }

  commitSuccess(
    id: string,
    fence: JobFence,
    resultRefs: string[],
    nowMonoMs?: number,
  ): JobRecord {
    return this.commitWith(id, fence, nowMonoMs, () => ({
      resultRefs,
      provenance: null,
    }));
  }

  commitWith(
    id: string,
    fence: JobFence,
    nowMonoMs: number | undefined,
    ownerCommit: (job: Readonly<JobRecord>) => CommitSuccessInput,
  ): JobRecord {
    return this.repository.transaction(() => {
      const current = this.requireJob(id);
      assertOwned(current, fence, nowMonoMs, "running");
      const committed = ownerCommit(current);
      const succeeded = this.repository.update(current, {
        ...current,
        state: "succeeded",
        stateReason: null,
        lease: null,
        progress: null,
        failure: null,
        resultRefs: committed.resultRefs,
        provenance: committed.provenance ?? null,
        updatedAt: this.nowIso(),
        revision: current.revision + 1,
      });
      this.history.append(succeeded, "succeeded", {
        fromState: "running",
        toState: "succeeded",
      });
      this.enqueuer.promoteReady();
      return succeeded;
    });
  }

  recordCommitRejected(id: string, fence: JobFence): void {
    this.repository.transaction(() => {
      const current = this.requireJob(id);
      const staleAttempt =
        current.attempts !== fence.attempt ||
        (current.lease !== null &&
          (current.lease.bootId !== fence.bootId ||
            current.lease.workerId !== fence.workerId ||
            current.lease.claimToken !== fence.claimToken));
      this.history.append(
        current,
        "commit_rejected",
        {
          fromState: current.state,
          toState: current.state,
          reason: staleAttempt ? "stale_commit" : "late_commit",
          noteCode: "commit_precondition",
        },
        fence.attempt,
      );
    });
  }

  requeueOwned(id: string, fence: JobFence, nowMonoMs: number): JobRecord {
    return this.repository.transaction(() => {
      const current = this.requireJob(id);
      if (current.state !== "claimed" && current.state !== "running")
        throw new JobError("JOB_FENCE_MISMATCH");
      assertOwned(current, fence, nowMonoMs, current.state);
      const queued = this.repository.update(current, {
        ...current,
        state: "queued",
        stateReason: "shutdown",
        lease: null,
        updatedAt: this.nowIso(),
        revision: current.revision + 1,
      });
      this.history.append(queued, "recovered", {
        fromState: current.state,
        toState: "queued",
        reason: "shutdown",
      });
      return queued;
    });
  }

  private applyProjectAction(
    projectId: string,
    action: "pause" | "resume",
    expectedImpactHash?: string,
  ): string[] {
    return this.repository.transaction(() => {
      const impact = this.projectActionImpact(projectId, action);
      if (
        expectedImpactHash !== undefined &&
        impact.impactHash !== expectedImpactHash
      )
        throw new JobError("JOB_IMPACT_CONFLICT");
      return action === "pause"
        ? this.controls.pauseProject(projectId)
        : this.controls.resumeProject(projectId);
    });
  }

  private continueQuota(
    incident: QuotaIncident,
    input: QuotaDecisionInput,
    affected: readonly JobRecord[],
  ): JobRecord[] {
    const target = input.alternateTarget;
    if (
      !target ||
      target.providerId === incident.providerId ||
      target.operation !== incident.operation
    )
      throw new JobError("JOB_QUOTA_ALTERNATE_INVALID", 400);
    if (affected.length === 0) throw new JobError("JOB_QUOTA_SCOPE_EMPTY", 409);
    const ids = new Map(affected.map((job) => [job.id, this.idFactory()]));
    const successors = this.enqueuer.enqueueInTransaction(
      affected.map((job) => quotaSuccessorInput(job, target, incident.id, ids)),
    );
    affected.forEach((original, index) => {
      const successor = successors[index];
      if (!successor) throw new JobError("JOB_TARGET_SUCCESSOR_MISSING");
      linkSupersedingSuccessor(
        this.repository,
        this.history,
        this.nowIso,
        original,
        successor,
      );
    });
    return successors;
  }

  private appendQuotaAudit(
    incidentId: string,
    input: QuotaDecisionInput,
    requestHash: string,
    affected: readonly JobRecord[],
    successors: readonly JobRecord[],
  ): void {
    this.history.appendAudit({
      actionId: input.actionId,
      requestHash,
      incidentId,
      projectId: input.projectId,
      standaloneScopeId: input.standaloneScopeId,
      decision: input.decision,
      impactHash: input.impactHash,
      alternateTarget: input.alternateTarget ?? null,
      affectedJobIds: affected.map((job) => job.id),
      successorJobIds: successors.map((job) => job.id),
    });
  }

  private replayQuotaAction(
    actionId: string,
    requestHash: string,
  ): JobRecord[] | null {
    const audit = this.history.quotaAuditByActionId(actionId);
    if (!audit) return null;
    if (audit.requestHash !== requestHash)
      throw new JobError("JOB_ACTION_ID_COLLISION");
    const resultIds =
      audit.decision === "continue"
        ? audit.successorJobIds
        : audit.decision === "resume"
          ? audit.affectedJobIds
          : [];
    return resultIds.map((id) => this.requireJob(id));
  }

  private requireOpenQuotaIncident(
    incidentId: string,
    expectedRevision: number,
  ): QuotaIncident {
    const incident = this.history.quotaIncident(incidentId);
    if (incident.status !== "open")
      throw new JobError("JOB_QUOTA_INCIDENT_RESOLVED");
    if (incident.revision !== expectedRevision)
      throw new JobError("JOB_REVISION_CONFLICT");
    return incident;
  }

  private requireOpenCredentialIncident(
    incidentId: string,
    expectedRevision: number,
  ): CredentialIncident {
    const incident = this.history.credentialIncident(incidentId);
    if (incident.status !== "open")
      throw new JobError("JOB_CREDENTIAL_INCIDENT_RESOLVED");
    if (incident.revision !== expectedRevision)
      throw new JobError("JOB_REVISION_CONFLICT");
    return incident;
  }

  private restoreQuotaIncident(incident: QuotaIncident): JobRecord[] {
    const owned = new Set(incident.ownedJobIds);
    const restored: JobRecord[] = [];
    for (const job of this.repository.list()) {
      if (
        !owned.has(job.id) ||
        job.state !== "paused" ||
        job.stateReason !== "quota"
      )
        continue;
      const resumed = this.repository.update(job, {
        ...job,
        state: job.resumeState ?? "queued",
        stateReason: job.resumeReason ?? null,
        resumeState: null,
        resumeReason: null,
        updatedAt: this.nowIso(),
        revision: job.revision + 1,
      });
      this.history.append(resumed, "resumed", {
        fromState: "paused",
        toState: resumed.state,
        reason: "quota",
      });
      restored.push(resumed);
    }
    this.history.resolveQuotaIncident(incident);
    this.enqueuer.promoteReady();
    return restored;
  }

  private restoreCredentialIncident(
    incident: CredentialIncident,
    affected: readonly JobRecord[],
    impactHash: string,
  ): JobRecord[] {
    const restored = affected.map((job) => {
      const resumed = this.repository.update(job, {
        ...job,
        state: job.resumeState ?? "queued",
        stateReason: job.resumeReason ?? null,
        resumeState: null,
        resumeReason: null,
        failure: null,
        updatedAt: this.nowIso(),
        revision: job.revision + 1,
      });
      this.history.append(resumed, "resumed", {
        fromState: "paused",
        toState: resumed.state,
        reason: "credentials",
      });
      return resumed;
    });
    this.history.resolveCredentialIncident(incident);
    this.history.appendCredentialAudit({
      incidentId: incident.id,
      impactHash,
      affectedJobIds: restored.map((job) => job.id),
      checkedTargetCount: incident.originalTargets.length,
    });
    this.enqueuer.promoteReady();
    return restored;
  }

  private requireJob(id: string): JobRecord {
    const job = this.repository.get(id);
    if (!job) throw new JobError("JOB_NOT_FOUND", 404);
    return job;
  }
}

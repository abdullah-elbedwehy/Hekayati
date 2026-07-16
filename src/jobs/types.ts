import type { Provenance } from "../providers/contract.js";
import type { NormalizedFailure } from "../providers/failures.js";
import type { JobRecord, JobRequest, JobState, JobTarget } from "./schemas.js";

export interface EnqueueJobInput {
  id?: string;
  jobType: string;
  projectId: string | null;
  standaloneScopeId: string | null;
  dependsOn: string[];
  priority: number;
  intentId: string;
  target: JobTarget | null;
  request: JobRequest;
  inputSnapshot: Record<string, string>;
  supersedesJobId?: string | null;
}

export interface ClaimOptions {
  workerId: string;
  bootId: string;
  nowMonoMs: number;
  nowWallMs: number;
  leaseTtlMs: number;
  concurrencyPerProvider: number;
}

export interface HeartbeatOptions {
  nowMonoMs: number;
  wallNowIso: string;
  leaseTtlMs: number;
}

export interface JobFence {
  workerId: string;
  bootId: string;
  claimToken: string;
  attempt: number;
}

export interface JobSchedulerOptions {
  registeredJobs: readonly JobRegistration[];
  nowIso?: () => string;
  idFactory?: () => string;
  claimTokenFactory?: () => string;
  scopeAdmission?: JobScopeAdmissionPort;
}

export type JobScopeAdmissionPurpose =
  | "scheduler_enqueue"
  | "scheduler_claim"
  | "scheduler_promote"
  | "scheduler_resume"
  | "scheduler_run"
  | "scheduler_commit";

export interface JobScopeAdmissionPort {
  assertInTransaction(
    job: Readonly<JobRecord>,
    purpose: JobScopeAdmissionPurpose,
  ): void;
  isAdmittedInTransaction(
    job: Readonly<JobRecord>,
    purpose: JobScopeAdmissionPurpose,
  ): boolean;
}

export interface JobRequestParser {
  parse(value: unknown): JobRequest;
}

export interface JobRegistration {
  jobType: string;
  requestSchema: JobRequestParser;
  /** Metadata/current-state guard only. Must not load bytes or call a provider. */
  validateEnqueue(input: Readonly<EnqueueJobInput>): void;
}

export interface CommitSuccessInput {
  resultRefs: string[];
  provenance?: Provenance | null;
}

export interface ExpectedJobState {
  expectedRevision: number;
  expectedState: JobState;
}

export interface FailureTiming {
  nowMonoMs: number;
  wallNowIso: string;
}

export interface ProgressInput extends FailureTiming {
  percent: number;
  noteCode: string;
}

export interface QuotaDecisionInput {
  actionId: string;
  expectedRevision: number;
  impactHash: string;
  projectId: string | null;
  standaloneScopeId: string | null;
  decision: "wait" | "continue";
  alternateTarget?: JobTarget;
}

export interface QuotaAvailabilityPort {
  forceCheckExact(target: JobTarget): Promise<boolean>;
}

export interface CredentialAvailabilityPort {
  forceCheckExact(target: JobTarget): Promise<boolean>;
}

export interface ResumeQuotaInput {
  actionId: string;
  expectedRevision: number;
  impactHash: string;
  confirmedAffectedCount: number;
}

export interface ResumeCredentialsInput {
  expectedRevision: number;
  impactHash: string;
}

export type {
  StorageResumeConfirmation as StorageResumeInput,
  StorageResumeImpact,
} from "./storage-resume.js";

export interface RetargetPreviewEntry {
  id: string;
  revision: number;
  state: JobState;
  projectId: string | null;
  standaloneScopeId: string | null;
  fromTarget: JobTarget;
  toTarget: JobTarget;
}

export interface RetargetPreview {
  impactHash: string;
  affected: RetargetPreviewEntry[];
}

export interface RetargetInput {
  targets: readonly JobTarget[];
  expectedImpactHash: string;
  isTargetAvailable(target: JobTarget): boolean;
}

export type JobExecutionResult =
  | { ok: true; value: unknown; provenance?: Provenance }
  | { ok: false; failure: NormalizedFailure };

export interface JobExecutionContext {
  job: Readonly<JobRecord>;
  prepared: unknown;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface JobCommitContext {
  job: Readonly<JobRecord>;
  value: unknown;
  provenance: Provenance | null;
}

export interface RegisteredJobDefinition extends JobRegistration {
  prepare(job: Readonly<JobRecord>, batchId: string): Promise<unknown>;
  execute(context: JobExecutionContext): Promise<JobExecutionResult>;
  commit(context: JobCommitContext): CommitSuccessInput;
  discard?(value: unknown): Promise<void> | void;
  normalizeError?(error: unknown): NormalizedFailure;
}

export interface JobClock {
  monotonicNow(): number;
  wallNowIso(): string;
}

export type { JobRecord };

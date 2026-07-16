import type { DocumentStore } from "../repository/document-store.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../contracts/canonical-json.js";
import { JobRepository } from "../../jobs/repository.js";
import type { JobRecord } from "../../jobs/schemas.js";
import {
  PortabilityLedgerRepository,
  PortabilityScopeLockRepository,
  assertPortabilityTransaction,
} from "./repositories.js";
import {
  ScopeAdmissionService,
  operationScopeCapability,
} from "./scope-locks.js";
import type { PortabilityScope } from "./schemas.js";

const terminalStates = new Set(["succeeded", "failed", "canceled"]);

export interface ForcedJobCancellation {
  canceledJobIds: readonly string[];
  currentJobs: ReadonlyMap<string, JobRecord>;
}

export type ForcedJobCancellationContext =
  | Readonly<{
      mode: "permanent_delete";
      phase: "draining";
      reason: "permanent_delete";
    }>
  | Readonly<{
      mode: "replace_import";
      phase: "draining";
      reason: "replace_import";
    }>;

const permanentDeletionCancellation = Object.freeze({
  mode: "permanent_delete" as const,
  phase: "draining" as const,
  reason: "permanent_delete" as const,
});

export class OperationJobCanceler {
  private readonly jobs: JobRepository;
  private readonly admission: ScopeAdmissionService;

  constructor(private readonly store: DocumentStore) {
    this.jobs = new JobRepository(store);
    this.admission = new ScopeAdmissionService(
      store,
      new PortabilityScopeLockRepository(store),
      new PortabilityLedgerRepository(store),
    );
  }

  forceCancelInTransaction(input: {
    operationId: string;
    scope: PortabilityScope;
    expected: readonly {
      jobId: string;
      revision: number;
      revisionHash: string;
    }[];
    nowIso: string;
    context?: ForcedJobCancellationContext;
  }): ForcedJobCancellation {
    assertPortabilityTransaction(this.store);
    const context = input.context ?? permanentDeletionCancellation;
    const currentJobs = new Map<string, JobRecord>();
    const canceledJobIds: string[] = [];
    for (const expected of [...input.expected].sort((a, b) =>
      a.jobId.localeCompare(b.jobId),
    )) {
      this.assertCancelAdmission(input.operationId, input.scope, context);
      const current = this.jobs.get(expected.jobId);
      if (
        !current ||
        current.revision !== expected.revision ||
        hash(current) !== expected.revisionHash
      )
        throw new Error("DELETION_JOB_REVISION_CONFLICT");
      if (terminalStates.has(current.state)) {
        currentJobs.set(current.id, current);
        continue;
      }
      const canceled = this.jobs.update(
        current,
        canceledJob(current, input.nowIso, context.reason),
      );
      currentJobs.set(canceled.id, canceled);
      canceledJobIds.push(canceled.id);
    }
    return {
      canceledJobIds: Object.freeze(canceledJobIds),
      currentJobs,
    };
  }

  private assertCancelAdmission(
    operationId: string,
    scope: PortabilityScope,
    context: ForcedJobCancellationContext,
  ): void {
    this.admission.assertAdmittedInTransaction({
      scope,
      purpose: "scope_cancel",
      operation: operationScopeCapability({
        operationId,
        purpose: "scope_cancel",
        mode: context.mode,
        phase: context.phase,
      }),
    });
  }
}

/** Backward-compatible name for permanent-deletion callers. */
export class DeletionJobCanceler extends OperationJobCanceler {}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canceledJob(
  current: JobRecord,
  nowIso: string,
  reason: ForcedJobCancellationContext["reason"],
): JobRecord {
  return {
    ...current,
    updatedAt: nowIso,
    revision: current.revision + 1,
    state: "canceled",
    stateReason: reason,
    lease: null,
    retrySchedule: null,
    resumeState: null,
    resumeReason: null,
    progress: null,
  };
}

import { ulid } from "ulid";

import type { DocumentStore } from "../repository/document-store.js";
import type {
  PortabilityLedgerRepository,
  PortabilityScopeLockRepository,
} from "./repositories.js";
import {
  PortabilityStorageError,
  assertPortabilityTransaction,
  scopesOverlap,
} from "./repositories.js";
import {
  portabilityScopeLockModeSchema,
  portabilityScopeLockPhaseSchema,
  portabilityScopeSchema,
  type PortabilityScope,
  type PortabilityScopeLock,
  type PortabilityScopeLockMode,
  type PortabilityScopeLockPhase,
} from "./schemas.js";

export interface ScopeLockAcquisition {
  operationId: string;
  scope: PortabilityScope;
  mode: PortabilityScopeLockMode;
  phase: PortabilityScopeLockPhase;
  capturedAttemptLedgerRoot: string;
  capturedAttemptCount: number;
}

export type ScopeAdmissionPurpose =
  | "domain_mutation"
  | "scheduler_enqueue"
  | "scheduler_claim"
  | "scheduler_promote"
  | "scheduler_resume"
  | "scheduler_run"
  | "scheduler_commit"
  | "scope_pause"
  | "scope_cancel"
  | "snapshot_freeze"
  | "operation_record"
  | "lock_maintenance";

export interface OperationScopeCapabilityInput {
  operationId: string;
  purpose: OperationAdmissionPurpose;
  mode: PortabilityScopeLockMode;
  phase: PortabilityScopeLockPhase;
}

const operationCapabilityBrand: unique symbol = Symbol(
  "hekayati.operation-scope-capability",
);

export type OperationScopeCapability = Readonly<
  OperationScopeCapabilityInput & {
    readonly [operationCapabilityBrand]: true;
  }
>;

export interface ScopeAdmissionRequest {
  scope: PortabilityScope;
  purpose: ScopeAdmissionPurpose;
  operation?: OperationScopeCapability;
  job?: { jobId: string; attempt: number };
}

export interface ScopeAdmissionOptions {
  nowIso?: () => string;
  idFactory?: () => string;
}

type OperationAdmissionPurpose = Extract<
  ScopeAdmissionPurpose,
  | "domain_mutation"
  | "scope_pause"
  | "scope_cancel"
  | "snapshot_freeze"
  | "operation_record"
  | "lock_maintenance"
>;

const operationPurposes = new Set<OperationAdmissionPurpose>([
  "domain_mutation",
  "scope_pause",
  "scope_cancel",
  "snapshot_freeze",
  "operation_record",
  "lock_maintenance",
]);

export function operationScopeCapability(
  input: OperationScopeCapabilityInput,
): OperationScopeCapability {
  if (!input.operationId || !operationPurposes.has(input.purpose))
    fail("PORTABILITY_SCOPE_ADMISSION_DENIED");
  return Object.freeze({
    operationId: input.operationId,
    purpose: input.purpose,
    mode: portabilityScopeLockModeSchema.parse(input.mode),
    phase: portabilityScopeLockPhaseSchema.parse(input.phase),
    [operationCapabilityBrand]: true as const,
  });
}

export class ScopeAdmissionService {
  private readonly nowIso: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: DocumentStore,
    private readonly locks: PortabilityScopeLockRepository,
    private readonly ledgers: PortabilityLedgerRepository,
    options: ScopeAdmissionOptions = {},
  ) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
  }

  acquire(input: ScopeLockAcquisition): PortabilityScopeLock {
    return this.acquireMany([input])[0];
  }

  acquireMany(inputs: readonly ScopeLockAcquisition[]): PortabilityScopeLock[] {
    return this.store.transactionImmediate(() =>
      this.acquireManyInTransaction(inputs),
    );
  }

  acquireManyInTransaction(
    inputs: readonly ScopeLockAcquisition[],
  ): PortabilityScopeLock[] {
    assertPortabilityTransaction(this.store);
    const ordered = [...inputs].map(parseAcquisition).sort(compareAcquisition);
    assertDistinctScopes(ordered);
    return ordered.map((input) => this.acquireOneInTransaction(input));
  }

  transitionInTransaction(
    lockId: string,
    operationId: string,
    expectedRevision: number,
    phase: PortabilityScopeLockPhase,
  ): PortabilityScopeLock {
    assertPortabilityTransaction(this.store);
    const current = this.requireLock(lockId);
    if (current.operationId !== operationId)
      fail("PORTABILITY_SCOPE_ADMISSION_DENIED");
    if (current.revision !== expectedRevision)
      fail("PORTABILITY_LOCK_REVISION_CONFLICT");
    const nextPhase = portabilityScopeLockPhaseSchema.parse(phase);
    if (!mayTransition(current.mode, current.phase, nextPhase))
      fail("PORTABILITY_LOCK_STATE_INVALID");
    return this.locks.updateInTransaction(current, {
      ...current,
      phase: nextPhase,
      revision: current.revision + 1,
      updatedAt: this.nowIso(),
    });
  }

  transition(
    lockId: string,
    operationId: string,
    expectedRevision: number,
    phase: PortabilityScopeLockPhase,
  ): PortabilityScopeLock {
    return this.store.transactionImmediate(() =>
      this.transitionInTransaction(
        lockId,
        operationId,
        expectedRevision,
        phase,
      ),
    );
  }

  releaseInTransaction(
    lockId: string,
    operationId: string,
    expectedRevision: number,
  ): void {
    assertPortabilityTransaction(this.store);
    const current = this.requireLock(lockId);
    if (current.operationId !== operationId)
      fail("PORTABILITY_SCOPE_ADMISSION_DENIED");
    if (current.phase !== "releasing") fail("PORTABILITY_LOCK_STATE_INVALID");
    this.locks.deleteInTransaction(lockId, operationId, expectedRevision);
  }

  release(lockId: string, operationId: string, expectedRevision: number): void {
    this.store.transactionImmediate(() =>
      this.releaseInTransaction(lockId, operationId, expectedRevision),
    );
  }

  assertAdmittedInTransaction(input: ScopeAdmissionRequest): void {
    assertPortabilityTransaction(this.store);
    const request = {
      ...input,
      scope: portabilityScopeSchema.parse(input.scope),
    };
    assertCapabilityMatchesPurpose(request);
    const overlapping = this.locks.findOverlapping(request.scope);
    if (overlapping.length === 0) {
      if (request.operation) fail("PORTABILITY_SCOPE_ADMISSION_DENIED");
      return;
    }
    if (overlapping.length !== 1) fail("PORTABILITY_SCOPE_BUSY");
    const lock = overlapping[0];
    if (
      request.operation &&
      admitsOperationCapability(request, request.operation, lock)
    )
      return;
    if (
      (request.purpose === "scheduler_run" ||
        request.purpose === "scheduler_commit") &&
      lock.phase === "draining" &&
      request.job &&
      this.ledgers.hasCapturedAttempt(
        lock.operationId,
        request.job.jobId,
        request.job.attempt,
      )
    )
      return;
    fail("PORTABILITY_SCOPE_ADMISSION_DENIED");
  }

  overlapping(scope: PortabilityScope): PortabilityScopeLock[] {
    return this.locks.findOverlapping(portabilityScopeSchema.parse(scope));
  }

  private acquireOneInTransaction(
    input: ScopeLockAcquisition,
  ): PortabilityScopeLock {
    assertInitialPhase(input.mode, input.phase);
    this.assertCapturedLedger(input);
    const overlapping = this.locks.findOverlapping(input.scope);
    if (overlapping.length > 0) return replayOrConflict(overlapping, input);
    const acquiredAt = this.nowIso();
    return this.locks.insertInTransaction({
      id: this.idFactory(),
      schemaVersion: 1,
      createdAt: acquiredAt,
      updatedAt: acquiredAt,
      operationId: input.operationId,
      scope: input.scope,
      mode: input.mode,
      phase: input.phase,
      revision: 0,
      capturedAttemptLedgerRoot: input.capturedAttemptLedgerRoot,
      capturedAttemptCount: input.capturedAttemptCount,
      acquiredAt,
    });
  }

  private assertCapturedLedger(input: ScopeLockAcquisition): void {
    const root = this.ledgers.root(input.operationId, "captured_attempts");
    if (
      root.rootHash !== input.capturedAttemptLedgerRoot ||
      root.entryCount !== input.capturedAttemptCount
    )
      fail("PORTABILITY_CAPTURE_LEDGER_MISMATCH");
  }

  private requireLock(lockId: string): PortabilityScopeLock {
    const lock = this.locks.get(lockId);
    if (!lock) fail("PORTABILITY_LOCK_NOT_FOUND");
    return lock;
  }
}

function assertCapabilityMatchesPurpose(input: ScopeAdmissionRequest): void {
  if (!input.operation) return;
  if (
    input.operation[operationCapabilityBrand] !== true ||
    input.operation.purpose !== input.purpose
  )
    fail("PORTABILITY_SCOPE_ADMISSION_DENIED");
}

function admitsOperationCapability(
  request: ScopeAdmissionRequest,
  capability: OperationScopeCapability,
  lock: PortabilityScopeLock,
): boolean {
  return (
    capability.operationId === lock.operationId &&
    capability.mode === lock.mode &&
    capability.phase === lock.phase &&
    operationPurposeAllowed(request.purpose, lock.mode, lock.phase)
  );
}

function operationPurposeAllowed(
  purpose: ScopeAdmissionPurpose,
  mode: PortabilityScopeLockMode,
  phase: PortabilityScopeLockPhase,
): boolean {
  if (purpose === "domain_mutation")
    return mode !== "export_snapshot" && phase === "exclusive";
  if (purpose === "scope_pause") return phase === "draining";
  if (purpose === "scope_cancel")
    return phase === "draining" || phase === "exclusive";
  if (purpose === "snapshot_freeze")
    return mode === "export_snapshot" && phase === "snapshot";
  return purpose === "operation_record" || purpose === "lock_maintenance";
}

function parseAcquisition(input: ScopeLockAcquisition): ScopeLockAcquisition {
  return {
    operationId: input.operationId,
    scope: portabilityScopeSchema.parse(input.scope),
    mode: portabilityScopeLockModeSchema.parse(input.mode),
    phase: portabilityScopeLockPhaseSchema.parse(input.phase),
    capturedAttemptLedgerRoot: input.capturedAttemptLedgerRoot,
    capturedAttemptCount: input.capturedAttemptCount,
  };
}

function assertDistinctScopes(inputs: readonly ScopeLockAcquisition[]): void {
  for (let left = 0; left < inputs.length; left += 1) {
    for (let right = left + 1; right < inputs.length; right += 1) {
      if (scopesOverlap(inputs[left].scope, inputs[right].scope))
        fail("PORTABILITY_SCOPE_REQUEST_CONFLICT");
    }
  }
}

function compareAcquisition(
  left: ScopeLockAcquisition,
  right: ScopeLockAcquisition,
): number {
  return (
    scopeRank(left.scope) - scopeRank(right.scope) ||
    left.scope.id.localeCompare(right.scope.id)
  );
}

function scopeRank(scope: PortabilityScope): number {
  if (scope.kind === "template_catalog") return 0;
  return scope.kind === "customer" ? 1 : 2;
}

function replayOrConflict(
  locks: readonly PortabilityScopeLock[],
  input: ScopeLockAcquisition,
): PortabilityScopeLock {
  if (locks.length !== 1) fail("PORTABILITY_SCOPE_BUSY");
  const lock = locks[0];
  if (
    lock.operationId === input.operationId &&
    lock.scope.kind === input.scope.kind &&
    lock.scope.id === input.scope.id &&
    lock.mode === input.mode &&
    lock.phase === input.phase &&
    lock.capturedAttemptLedgerRoot === input.capturedAttemptLedgerRoot &&
    lock.capturedAttemptCount === input.capturedAttemptCount
  )
    return lock;
  fail("PORTABILITY_SCOPE_BUSY");
}

function assertInitialPhase(
  mode: PortabilityScopeLockMode,
  phase: PortabilityScopeLockPhase,
): void {
  const valid =
    mode === "import_commit" ? phase === "exclusive" : phase === "draining";
  if (!valid) fail("PORTABILITY_LOCK_STATE_INVALID");
}

function mayTransition(
  mode: PortabilityScopeLockMode,
  current: PortabilityScopeLockPhase,
  next: PortabilityScopeLockPhase,
): boolean {
  if (next === current) return false;
  if (current === "releasing") return false;
  if (next === "releasing") return true;
  if (mode === "export_snapshot")
    return current === "draining" && next === "snapshot";
  if (mode === "replace_import" || mode === "permanent_delete")
    return current === "draining" && next === "exclusive";
  return false;
}

function fail(
  code: ConstructorParameters<typeof PortabilityStorageError>[0],
): never {
  throw new PortabilityStorageError(code);
}

import { ulid } from "ulid";

import type { DocumentStore } from "../repository/document-store.js";
import type {
  PortabilityActionRepository,
  PortabilityLedgerRepository,
  PortabilityLedgerRoot,
} from "./repositories.js";
import {
  PortabilityStorageError,
  assertPortabilityTransaction,
  hashLedgerPage,
  portabilityActionRequestHash,
} from "./repositories.js";
import {
  PORTABILITY_LEDGER_PAGE_SIZE,
  portabilityActionInputSchema,
  portabilityActionKindSchema,
  portabilityActionResultSchema,
  portabilityHashSchema,
  portabilityIdempotencyKeySchema,
  portabilityOperationScopeSchema,
  type PortabilityAction,
  type PortabilityActionInput,
  type PortabilityActionKind,
  type PortabilityActionResult,
  type PortabilityOperationScope,
} from "./schemas.js";

export interface PortabilityActionBoundaryInput {
  operationScope: PortabilityOperationScope;
  action: PortabilityActionKind;
  idempotencyKey: string;
  requestHash: string;
  input: PortabilityActionInput;
}

export interface PortabilityActionBoundaryResult {
  action: PortabilityAction;
  replayed: boolean;
}

export interface PortabilityActionIdentity {
  id: string;
  recordedAt: string;
}

export { portabilityActionRequestHash } from "./repositories.js";

export interface OperationLedgerOptions {
  nowIso?: () => string;
  idFactory?: () => string;
}

export class PortabilityActionBoundary {
  private readonly nowIso: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: DocumentStore,
    private readonly repository: PortabilityActionRepository,
    options: OperationLedgerOptions = {},
  ) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
  }

  run(
    input: PortabilityActionBoundaryInput,
    effect: (identity: PortabilityActionIdentity) => PortabilityActionResult,
  ): PortabilityActionBoundaryResult {
    return this.store.transactionImmediate(() =>
      this.runInTransaction(input, effect),
    );
  }

  runInTransaction(
    input: PortabilityActionBoundaryInput,
    effect: (identity: PortabilityActionIdentity) => PortabilityActionResult,
  ): PortabilityActionBoundaryResult {
    assertPortabilityTransaction(this.store);
    const parsed = parseBoundaryInput(input);
    const existing = this.repository.find(
      parsed.operationScope,
      parsed.action,
      parsed.idempotencyKey,
    );
    if (existing) {
      if (existing.requestHash !== parsed.requestHash)
        throw new PortabilityStorageError(
          "PORTABILITY_ACTION_IDEMPOTENCY_COLLISION",
        );
      return { action: existing, replayed: true };
    }
    const recordedAt = this.nowIso();
    const id = this.idFactory();
    const result = portabilityActionResultSchema.parse(
      effect(Object.freeze({ id, recordedAt })),
    );
    return this.repository.recordInTransaction({
      id,
      schemaVersion: 1,
      createdAt: recordedAt,
      updatedAt: recordedAt,
      operationScope: parsed.operationScope,
      action: parsed.action,
      idempotencyKey: parsed.idempotencyKey,
      requestHash: parsed.requestHash,
      input: parsed.input,
      result,
      recordedAt,
    });
  }
}

export class CapturedAttemptLedger {
  private readonly nowIso: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: DocumentStore,
    private readonly repository: PortabilityLedgerRepository,
    options: OperationLedgerOptions = {},
  ) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
  }

  writeInTransaction(
    operationId: string,
    attempts: readonly { jobId: string; attempt: number }[],
  ): PortabilityLedgerRoot {
    assertPortabilityTransaction(this.store);
    const ordered = normalizeAttempts(attempts);
    const now = this.nowIso();
    const chunks = chunk(ordered, PORTABILITY_LEDGER_PAGE_SIZE);
    for (const [pageIndex, entries] of chunks.entries()) {
      this.repository.appendPageInTransaction({
        id: this.idFactory(),
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        operationId,
        ledgerKind: "captured_attempts",
        pageIndex,
        entries: entries.map((entry) => ({
          entryType: "job_attempt" as const,
          ...entry,
        })),
        pageHash: hashLedgerPage({
          operationId,
          ledgerKind: "captured_attempts",
          pageIndex,
          entries: entries.map((entry) => ({
            entryType: "job_attempt" as const,
            ...entry,
          })),
        }),
      });
    }
    const root = this.repository.root(operationId, "captured_attempts");
    if (root.pageCount !== chunks.length || root.entryCount !== ordered.length)
      throw new PortabilityStorageError("PORTABILITY_LEDGER_PAGE_CONFLICT");
    return root;
  }

  write(
    operationId: string,
    attempts: readonly { jobId: string; attempt: number }[],
  ): PortabilityLedgerRoot {
    return this.store.transactionImmediate(() =>
      this.writeInTransaction(operationId, attempts),
    );
  }

  has(operationId: string, jobId: string, attempt: number): boolean {
    return this.repository.hasCapturedAttempt(operationId, jobId, attempt);
  }
}

function parseBoundaryInput(
  input: PortabilityActionBoundaryInput,
): PortabilityActionBoundaryInput {
  const parsed = {
    operationScope: portabilityOperationScopeSchema.parse(input.operationScope),
    action: portabilityActionKindSchema.parse(input.action),
    idempotencyKey: portabilityIdempotencyKeySchema.parse(input.idempotencyKey),
    requestHash: portabilityHashSchema.parse(input.requestHash),
    input: portabilityActionInputSchema.parse(input.input),
  };
  if (parsed.requestHash !== portabilityActionRequestHash(parsed))
    throw new PortabilityStorageError(
      "PORTABILITY_ACTION_REQUEST_HASH_MISMATCH",
    );
  return parsed;
}

function normalizeAttempts(
  attempts: readonly { jobId: string; attempt: number }[],
): { jobId: string; attempt: number }[] {
  const ordered = [...attempts].sort(
    (left, right) =>
      left.jobId.localeCompare(right.jobId) || left.attempt - right.attempt,
  );
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    if (!Number.isInteger(current.attempt) || current.attempt < 1)
      throw new PortabilityStorageError("PORTABILITY_LEDGER_PAGE_CONFLICT");
    const previous = ordered[index - 1];
    if (
      previous?.jobId === current.jobId &&
      previous.attempt === current.attempt
    )
      throw new PortabilityStorageError("PORTABILITY_LEDGER_PAGE_CONFLICT");
  }
  return ordered;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    chunks.push(items.slice(index, index + size));
  return chunks;
}

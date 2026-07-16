import { createHash } from "node:crypto";

import type { DocumentStore } from "../repository/document-store.js";
import { canonicalJson } from "../../contracts/canonical-json.js";
import {
  portabilityActionSchema,
  portabilityLedgerPageSchema,
  portabilityScopeLockSchema,
  type PortabilityAction,
  type PortabilityLedgerEntry,
  type PortabilityLedgerKind,
  type PortabilityLedgerPage,
  type PortabilityOperationScope,
  type PortabilityScope,
  type PortabilityScopeLock,
} from "./schemas.js";

export const portabilityCollections = {
  actions: "portability_actions",
  ledgerPages: "portability_ledger_pages",
  scopeLocks: "portability_scope_locks",
} as const;

export type PortabilityStorageErrorCode =
  | "PORTABILITY_TRANSACTION_REQUIRED"
  | "PORTABILITY_ACTION_ID_CONFLICT"
  | "PORTABILITY_ACTION_IDEMPOTENCY_COLLISION"
  | "PORTABILITY_ACTION_REQUEST_HASH_MISMATCH"
  | "PORTABILITY_LEDGER_PAGE_CONFLICT"
  | "PORTABILITY_LEDGER_PAGE_GAP"
  | "PORTABILITY_LEDGER_PAGE_HASH_MISMATCH"
  | "PORTABILITY_CAPTURE_LEDGER_MISMATCH"
  | "PORTABILITY_LOCK_CONFLICT"
  | "PORTABILITY_LOCK_IMMUTABLE_FIELD_CHANGED"
  | "PORTABILITY_LOCK_NOT_FOUND"
  | "PORTABILITY_LOCK_REVISION_CONFLICT"
  | "PORTABILITY_LOCK_STATE_INVALID"
  | "PORTABILITY_SCOPE_ADMISSION_DENIED"
  | "PORTABILITY_SCOPE_BUSY"
  | "PORTABILITY_SCOPE_REQUEST_CONFLICT";

export class PortabilityStorageError extends Error {
  readonly name = "PortabilityStorageError";

  constructor(readonly code: PortabilityStorageErrorCode) {
    super(code);
  }
}

interface StoredDocumentRow {
  doc: string;
}

export interface PortabilityLedgerRoot {
  operationId: string;
  ledgerKind: PortabilityLedgerKind;
  pageCount: number;
  entryCount: number;
  rootHash: string;
}

export class PortabilityActionRepository {
  constructor(private readonly store: DocumentStore) {
    initializeIndexes(store, actionIndexes);
  }

  get(id: string): PortabilityAction | null {
    return readById(this.store, portabilityCollections.actions, id, (value) =>
      this.parse(value),
    );
  }

  list(): PortabilityAction[] {
    return readCollection(this.store, portabilityCollections.actions, (value) =>
      this.parse(value),
    );
  }

  find(
    scope: PortabilityOperationScope,
    action: PortabilityAction["action"],
    idempotencyKey: string,
  ): PortabilityAction | null {
    const row = this.store.database
      .prepare(
        `SELECT doc FROM documents
         WHERE collection = ?
           AND json_extract(doc, '$.operationScope.kind') = ?
           AND json_extract(doc, '$.operationScope.id') = ?
           AND json_extract(doc, '$.action') = ?
           AND json_extract(doc, '$.idempotencyKey') = ?
         LIMIT 1`,
      )
      .get(
        portabilityCollections.actions,
        scope.kind,
        scope.id,
        action,
        idempotencyKey,
      ) as StoredDocumentRow | undefined;
    return row ? this.parse(JSON.parse(row.doc)) : null;
  }

  recordInTransaction(action: PortabilityAction): {
    action: PortabilityAction;
    replayed: boolean;
  } {
    assertTransaction(this.store);
    const parsed = portabilityActionSchema.parse(action);
    assertActionRequestHash(parsed);
    const existing = this.find(
      parsed.operationScope,
      parsed.action,
      parsed.idempotencyKey,
    );
    if (existing) {
      if (existing.requestHash !== parsed.requestHash)
        fail("PORTABILITY_ACTION_IDEMPOTENCY_COLLISION");
      return { action: existing, replayed: true };
    }
    if (this.get(parsed.id)) fail("PORTABILITY_ACTION_ID_CONFLICT");
    insertDocument(this.store, portabilityCollections.actions, parsed);
    return { action: parsed, replayed: false };
  }

  private parse(value: unknown): PortabilityAction {
    const parsed = portabilityActionSchema.parse(value);
    this.store.assertSafeForPersistence(parsed);
    assertActionRequestHash(parsed);
    return parsed;
  }
}

export function portabilityActionRequestHash(
  input: Pick<PortabilityAction, "operationScope" | "action" | "input">,
): string {
  return createHash("sha256")
    .update("HekayatiPortabilityActionRequest/v1\n")
    .update(
      canonicalJson({
        operationScope: input.operationScope,
        action: input.action,
        input: input.input,
      }),
    )
    .digest("hex");
}

function assertActionRequestHash(action: PortabilityAction): void {
  if (action.requestHash !== portabilityActionRequestHash(action))
    fail("PORTABILITY_ACTION_REQUEST_HASH_MISMATCH");
}

export class PortabilityLedgerRepository {
  constructor(private readonly store: DocumentStore) {
    initializeIndexes(store, ledgerIndexes);
  }

  page(
    operationId: string,
    ledgerKind: PortabilityLedgerKind,
    pageIndex: number,
  ): PortabilityLedgerPage | null {
    const row = this.store.database
      .prepare(
        `SELECT doc FROM documents
         WHERE collection = ?
           AND json_extract(doc, '$.operationId') = ?
           AND json_extract(doc, '$.ledgerKind') = ?
           AND json_extract(doc, '$.pageIndex') = ?
         LIMIT 1`,
      )
      .get(
        portabilityCollections.ledgerPages,
        operationId,
        ledgerKind,
        pageIndex,
      ) as StoredDocumentRow | undefined;
    return row ? this.parse(row.doc) : null;
  }

  pages(
    operationId: string,
    ledgerKind: PortabilityLedgerKind,
  ): PortabilityLedgerPage[] {
    const rows = this.store.database
      .prepare(
        `SELECT doc FROM documents
         WHERE collection = ?
           AND json_extract(doc, '$.operationId') = ?
           AND json_extract(doc, '$.ledgerKind') = ?
         ORDER BY CAST(json_extract(doc, '$.pageIndex') AS INTEGER)`,
      )
      .all(
        portabilityCollections.ledgerPages,
        operationId,
        ledgerKind,
      ) as StoredDocumentRow[];
    return rows.map((row) => this.parse(row.doc));
  }

  appendPageInTransaction(page: PortabilityLedgerPage): PortabilityLedgerPage {
    assertTransaction(this.store);
    const parsed = portabilityLedgerPageSchema.parse(page);
    if (parsed.pageHash !== hashLedgerPage(parsed))
      fail("PORTABILITY_LEDGER_PAGE_HASH_MISMATCH");
    const existing = this.page(
      parsed.operationId,
      parsed.ledgerKind,
      parsed.pageIndex,
    );
    if (existing) {
      if (existing.pageHash !== parsed.pageHash)
        fail("PORTABILITY_LEDGER_PAGE_CONFLICT");
      return existing;
    }
    const pages = this.pages(parsed.operationId, parsed.ledgerKind);
    if (parsed.pageIndex !== pages.length) fail("PORTABILITY_LEDGER_PAGE_GAP");
    insertDocument(this.store, portabilityCollections.ledgerPages, parsed);
    return parsed;
  }

  root(
    operationId: string,
    ledgerKind: PortabilityLedgerKind,
  ): PortabilityLedgerRoot {
    const pages = this.pages(operationId, ledgerKind);
    const entryCount = pages.reduce(
      (total, page) => total + page.entries.length,
      0,
    );
    return {
      operationId,
      ledgerKind,
      pageCount: pages.length,
      entryCount,
      rootHash: hashLedgerRoot(
        operationId,
        ledgerKind,
        pages.map((page) => ({
          pageIndex: page.pageIndex,
          pageHash: page.pageHash,
          entryCount: page.entries.length,
        })),
      ),
    };
  }

  hasCapturedAttempt(
    operationId: string,
    jobId: string,
    attempt: number,
  ): boolean {
    return this.pages(operationId, "captured_attempts").some((page) =>
      page.entries.some(
        (entry) =>
          entry.entryType === "job_attempt" &&
          entry.jobId === jobId &&
          entry.attempt === attempt,
      ),
    );
  }

  private parse(value: string): PortabilityLedgerPage {
    const parsed = portabilityLedgerPageSchema.parse(JSON.parse(value));
    this.store.assertSafeForPersistence(parsed);
    if (parsed.pageHash !== hashLedgerPage(parsed))
      fail("PORTABILITY_LEDGER_PAGE_HASH_MISMATCH");
    return parsed;
  }
}

export class PortabilityScopeLockRepository {
  constructor(private readonly store: DocumentStore) {
    initializeIndexes(store, lockIndexes);
  }

  get(id: string): PortabilityScopeLock | null {
    return readById(
      this.store,
      portabilityCollections.scopeLocks,
      id,
      (value) => portabilityScopeLockSchema.parse(value),
    );
  }

  list(): PortabilityScopeLock[] {
    return readCollection(
      this.store,
      portabilityCollections.scopeLocks,
      (value) => portabilityScopeLockSchema.parse(value),
    );
  }

  findExact(scope: PortabilityScope): PortabilityScopeLock | null {
    return (
      this.list().find(
        (lock) => lock.scope.kind === scope.kind && lock.scope.id === scope.id,
      ) ?? null
    );
  }

  findOverlapping(scope: PortabilityScope): PortabilityScopeLock[] {
    return this.list().filter((lock) => scopesOverlap(lock.scope, scope));
  }

  insertInTransaction(lock: PortabilityScopeLock): PortabilityScopeLock {
    assertTransaction(this.store);
    const parsed = portabilityScopeLockSchema.parse(lock);
    if (this.get(parsed.id)) fail("PORTABILITY_LOCK_CONFLICT");
    try {
      insertDocument(this.store, portabilityCollections.scopeLocks, parsed);
    } catch (error) {
      if (isConstraintFailure(error)) fail("PORTABILITY_LOCK_CONFLICT");
      throw error;
    }
    return parsed;
  }

  updateInTransaction(
    current: PortabilityScopeLock,
    next: PortabilityScopeLock,
  ): PortabilityScopeLock {
    assertTransaction(this.store);
    const persisted = this.get(current.id);
    if (!persisted) fail("PORTABILITY_LOCK_NOT_FOUND");
    if (canonicalJson(persisted) !== canonicalJson(current))
      fail("PORTABILITY_LOCK_REVISION_CONFLICT");
    const parsed = portabilityScopeLockSchema.parse(next);
    assertLockImmutable(persisted, parsed);
    if (parsed.revision !== persisted.revision + 1)
      fail("PORTABILITY_LOCK_REVISION_CONFLICT");
    this.store.assertSafeForPersistence(parsed);
    const result = this.store.database
      .prepare(
        `UPDATE documents
         SET doc = ?, schema_version = ?, updated_at = ?
         WHERE collection = ? AND id = ?
           AND json_extract(doc, '$.revision') = ?`,
      )
      .run(
        JSON.stringify(parsed),
        parsed.schemaVersion,
        parsed.updatedAt,
        portabilityCollections.scopeLocks,
        parsed.id,
        persisted.revision,
      );
    if (result.changes !== 1) fail("PORTABILITY_LOCK_REVISION_CONFLICT");
    return parsed;
  }

  deleteInTransaction(
    id: string,
    operationId: string,
    expectedRevision: number,
  ): void {
    assertTransaction(this.store);
    const result = this.store.database
      .prepare(
        `DELETE FROM documents
         WHERE collection = ? AND id = ?
           AND json_extract(doc, '$.operationId') = ?
           AND json_extract(doc, '$.revision') = ?`,
      )
      .run(
        portabilityCollections.scopeLocks,
        id,
        operationId,
        expectedRevision,
      );
    if (result.changes !== 1) fail("PORTABILITY_LOCK_REVISION_CONFLICT");
  }
}

export function hashLedgerPage(input: {
  operationId: string;
  ledgerKind: PortabilityLedgerKind;
  pageIndex: number;
  entries: readonly PortabilityLedgerEntry[];
}): string {
  return sha256({
    operationId: input.operationId,
    ledgerKind: input.ledgerKind,
    pageIndex: input.pageIndex,
    entries: input.entries,
  });
}

export function hashLedgerRoot(
  operationId: string,
  ledgerKind: PortabilityLedgerKind,
  pages: readonly {
    pageIndex: number;
    pageHash: string;
    entryCount: number;
  }[],
): string {
  return sha256({ operationId, ledgerKind, pages });
}

export function scopesOverlap(
  left: PortabilityScope,
  right: PortabilityScope,
): boolean {
  if (left.kind === "template_catalog" || right.kind === "template_catalog")
    return (
      left.kind === "template_catalog" && right.kind === "template_catalog"
    );
  if (left.kind === "customer" && right.kind === "customer")
    return left.customerId === right.customerId;
  if (left.kind === "project" && right.kind === "project")
    return left.projectId === right.projectId;
  const customer = left.kind === "customer" ? left : right;
  const project = left.kind === "project" ? left : right;
  return customer.customerId === project.customerId;
}

export function assertPortabilityTransaction(store: DocumentStore): void {
  assertTransaction(store);
}

function assertLockImmutable(
  current: PortabilityScopeLock,
  next: PortabilityScopeLock,
): void {
  const fields = [
    "id",
    "schemaVersion",
    "createdAt",
    "operationId",
    "scope",
    "mode",
    "capturedAttemptLedgerRoot",
    "capturedAttemptCount",
    "acquiredAt",
  ] as const;
  for (const field of fields) {
    if (canonicalJson(current[field]) !== canonicalJson(next[field]))
      fail("PORTABILITY_LOCK_IMMUTABLE_FIELD_CHANGED");
  }
}

function insertDocument(
  store: DocumentStore,
  collection: string,
  document: {
    id: string;
    schemaVersion: number;
    createdAt: string;
    updatedAt: string;
  },
): void {
  store.assertSafeForPersistence(document);
  store.database
    .prepare(
      `INSERT INTO documents(collection, id, doc, schema_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      collection,
      document.id,
      JSON.stringify(document),
      document.schemaVersion,
      document.createdAt,
      document.updatedAt,
    );
}

function readById<T>(
  store: DocumentStore,
  collection: string,
  id: string,
  parse: (value: unknown) => T,
): T | null {
  const row = store.database
    .prepare("SELECT doc FROM documents WHERE collection = ? AND id = ?")
    .get(collection, id) as StoredDocumentRow | undefined;
  return row ? parseStored(store, row.doc, parse) : null;
}

function readCollection<T>(
  store: DocumentStore,
  collection: string,
  parse: (value: unknown) => T,
): T[] {
  const rows = store.database
    .prepare(
      "SELECT doc FROM documents WHERE collection = ? ORDER BY created_at, id",
    )
    .all(collection) as StoredDocumentRow[];
  return rows.map((row) => parseStored(store, row.doc, parse));
}

function parseStored<T>(
  store: DocumentStore,
  value: string,
  parse: (value: unknown) => T,
): T {
  const parsed = parse(JSON.parse(value));
  store.assertSafeForPersistence(parsed);
  return parsed;
}

function initializeIndexes(store: DocumentStore, sql: string): void {
  const apply = () => store.database.exec(sql);
  if (store.database.inTransaction) apply();
  else store.transactionImmediate(apply);
}

function assertTransaction(store: DocumentStore): void {
  if (!store.database.inTransaction) fail("PORTABILITY_TRANSACTION_REQUIRED");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isConstraintFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

function fail(code: PortabilityStorageErrorCode): never {
  throw new PortabilityStorageError(code);
}

const actionIndexes = `
  CREATE UNIQUE INDEX IF NOT EXISTS portability_action_scope_key_unique
    ON documents(
      json_extract(doc, '$.operationScope.kind'),
      json_extract(doc, '$.operationScope.id'),
      json_extract(doc, '$.action'),
      json_extract(doc, '$.idempotencyKey')
    ) WHERE collection = 'portability_actions';
`;

const ledgerIndexes = `
  CREATE UNIQUE INDEX IF NOT EXISTS portability_ledger_page_unique
    ON documents(
      json_extract(doc, '$.operationId'),
      json_extract(doc, '$.ledgerKind'),
      json_extract(doc, '$.pageIndex')
    ) WHERE collection = 'portability_ledger_pages';
`;

const lockIndexes = `
  CREATE UNIQUE INDEX IF NOT EXISTS portability_scope_lock_exact_unique
    ON documents(
      json_extract(doc, '$.scope.kind'),
      json_extract(doc, '$.scope.id')
    ) WHERE collection = 'portability_scope_locks';
  CREATE INDEX IF NOT EXISTS portability_scope_lock_operation
    ON documents(json_extract(doc, '$.operationId'))
    WHERE collection = 'portability_scope_locks';
`;

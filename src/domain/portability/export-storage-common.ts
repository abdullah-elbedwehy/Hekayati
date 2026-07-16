import { createHash } from "node:crypto";

import { canonicalJson } from "../../contracts/canonical-json.js";
import type { DocumentStore } from "../repository/document-store.js";
import type {
  ExportOperation,
  ManagedExport,
  PortabilitySnapshot,
} from "./export-model.js";

export type ExportStorageErrorCode =
  | "PORTABILITY_EXPORT_ID_CONFLICT"
  | "PORTABILITY_EXPORT_IDEMPOTENCY_COLLISION"
  | "PORTABILITY_EXPORT_IMMUTABLE_FIELD_CHANGED"
  | "PORTABILITY_EXPORT_NOT_FOUND"
  | "PORTABILITY_EXPORT_REVISION_CONFLICT"
  | "PORTABILITY_EXPORT_STATE_TRANSITION_INVALID"
  | "PORTABILITY_MANAGED_EXPORT_MISMATCH"
  | "PORTABILITY_SNAPSHOT_CONFLICT"
  | "PORTABILITY_SNAPSHOT_DOCUMENT_HASH_MISMATCH"
  | "PORTABILITY_SNAPSHOT_ENTRY_DUPLICATE"
  | "PORTABILITY_SNAPSHOT_ENTRY_ORDER_INVALID"
  | "PORTABILITY_SNAPSHOT_ENTRY_SET_INVALID"
  | "PORTABILITY_SNAPSHOT_FROZEN"
  | "PORTABILITY_SNAPSHOT_HASH_MISMATCH"
  | "PORTABILITY_SNAPSHOT_NOT_FOUND"
  | "PORTABILITY_SNAPSHOT_REGISTRY_MISMATCH"
  | "PORTABILITY_SNAPSHOT_SCHEMA_VERSION_MISMATCH"
  | "PORTABILITY_SNAPSHOT_STATE_INVALID"
  | "PORTABILITY_MEDIA_CATALOG_ROLE_INVALID"
  | "PORTABILITY_MEDIA_ENTRY_MISSING"
  | "PORTABILITY_MEDIA_HOLD_CONFLICT"
  | "PORTABILITY_MEDIA_HOLD_INCOMPLETE";

export class ExportStorageError extends Error {
  readonly name = "ExportStorageError";

  constructor(readonly code: ExportStorageErrorCode) {
    super(code);
  }
}

export interface StoredRow {
  doc: string;
}

export function readById<T>(
  store: DocumentStore,
  collection: string,
  id: string,
  parse: (value: unknown) => T,
): T | null {
  const row = store.database
    .prepare("SELECT doc FROM documents WHERE collection = ? AND id = ?")
    .get(collection, id) as StoredRow | undefined;
  return row ? parseStored(store, row.doc, parse) : null;
}

export function readCollection<T>(
  store: DocumentStore,
  collection: string,
  parse: (value: unknown) => T,
): T[] {
  const rows = store.database
    .prepare(
      "SELECT doc FROM documents WHERE collection = ? ORDER BY created_at, id",
    )
    .all(collection) as StoredRow[];
  return rows.map((row) => parseStored(store, row.doc, parse));
}

export function parseStored<T>(
  store: DocumentStore,
  value: string,
  parse: (value: unknown) => T,
): T {
  const parsed = parse(JSON.parse(value));
  store.assertSafeForPersistence(parsed);
  return parsed;
}

export function insertDocument(
  store: DocumentStore,
  collection: string,
  document: StoredDocument,
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

export function updateDocument<T extends UpdatedDocument>(
  store: DocumentStore,
  collection: string,
  document: T,
): void {
  store.assertSafeForPersistence(document);
  const result = store.database
    .prepare(
      `UPDATE documents SET doc = ?, schema_version = ?, updated_at = ?
       WHERE collection = ? AND id = ?`,
    )
    .run(
      JSON.stringify(document),
      document.schemaVersion,
      document.updatedAt,
      collection,
      document.id,
    );
  if (result.changes !== 1) fail("PORTABILITY_SNAPSHOT_NOT_FOUND");
}

export function updateDocumentCas(
  store: DocumentStore,
  collection: string,
  document: ExportOperation,
  expectedRevision: number,
): void {
  updateRevisionedDocumentCas(
    store,
    collection,
    document,
    expectedRevision,
    "PORTABILITY_EXPORT_REVISION_CONFLICT",
  );
}

export function updateRevisionedDocumentCas<
  T extends UpdatedDocument & { revision: number },
>(
  store: DocumentStore,
  collection: string,
  document: T,
  expectedRevision: number,
  conflictCode: ExportStorageErrorCode,
): void {
  store.assertSafeForPersistence(document);
  const result = store.database
    .prepare(
      `UPDATE documents SET doc = ?, schema_version = ?, updated_at = ?
       WHERE collection = ? AND id = ?
         AND json_extract(doc, '$.revision') = ?`,
    )
    .run(
      JSON.stringify(document),
      document.schemaVersion,
      document.updatedAt,
      collection,
      document.id,
      expectedRevision,
    );
  if (result.changes !== 1) fail(conflictCode);
}

export function initializeIndexes(store: DocumentStore, sql: string): void {
  const apply = () => store.database.exec(sql);
  if (store.database.inTransaction) apply();
  else store.transactionImmediate(apply);
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Value(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

export function isConstraintFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

export function fail(code: ExportStorageErrorCode): never {
  throw new ExportStorageError(code);
}

interface StoredDocument extends UpdatedDocument {
  createdAt: string;
}

interface UpdatedDocument {
  id: string;
  schemaVersion: number;
  updatedAt: string;
}

export const allowedExportTransitions: Readonly<
  Record<ExportOperation["state"], readonly ExportOperation["state"][]>
> = {
  waiting_pause: ["waiting_quiescence", "failed"],
  waiting_quiescence: ["acquiring_lock", "failed"],
  acquiring_lock: ["freezing_snapshot", "failed"],
  freezing_snapshot: ["staging", "failed"],
  staging: ["packaging", "failed"],
  packaging: ["secret_scanning", "failed"],
  secret_scanning: ["ready", "failed"],
  ready: ["stale"],
  failed: [],
  stale: [],
};

export function assertOperationImmutable(
  current: ExportOperation,
  next: ExportOperation,
): void {
  const fields = [
    "id",
    "schemaVersion",
    "createdAt",
    "projectId",
    "customerId",
    "familyId",
    "idempotencyKey",
    "requestHash",
    "projectRevision",
  ] as const;
  for (const field of fields)
    if (canonicalJson(current[field]) !== canonicalJson(next[field]))
      fail("PORTABILITY_EXPORT_IMMUTABLE_FIELD_CHANGED");
}

export const allowedSnapshotTransitions: Readonly<
  Record<PortabilitySnapshot["state"], readonly PortabilitySnapshot["state"][]>
> = {
  freezing: ["failed"],
  frozen: ["staging", "failed"],
  staging: ["staged", "failed"],
  staged: ["released", "failed"],
  released: [],
  failed: [],
};

export function assertSnapshotImmutable(
  current: PortabilitySnapshot,
  next: PortabilitySnapshot,
): void {
  const mutable = new Set(["updatedAt", "revision", "state", "failureCode"]);
  const currentIdentity = Object.fromEntries(
    Object.entries(current).filter(([field]) => !mutable.has(field)),
  );
  const nextIdentity = Object.fromEntries(
    Object.entries(next).filter(([field]) => !mutable.has(field)),
  );
  if (canonicalJson(currentIdentity) !== canonicalJson(nextIdentity))
    fail("PORTABILITY_SNAPSHOT_CONFLICT");
}

export function managedMatchesOperation(
  record: ManagedExport,
  operation: ExportOperation,
): boolean {
  return (
    operation.state === "ready" &&
    record.operationId === operation.id &&
    record.projectId === operation.projectId &&
    record.customerId === operation.customerId &&
    record.familyId === operation.familyId &&
    record.archiveKey === operation.archiveKey &&
    record.snapshotHash === operation.snapshotHash &&
    record.manifestHash === operation.manifestHash &&
    record.archiveChecksum === operation.archiveChecksum &&
    record.bytes === operation.archiveBytes
  );
}

export function rowsForSnapshot(
  store: DocumentStore,
  collection: string,
  snapshotId: string,
  orderField: "ordinal" | "mediaId",
): StoredRow[] {
  return store.database
    .prepare(
      `SELECT doc FROM documents
       WHERE collection = ? AND json_extract(doc, '$.snapshotId') = ?
       ORDER BY json_extract(doc, ?)`,
    )
    .all(collection, snapshotId, `$.${orderField}`) as StoredRow[];
}

export const operationIndexes = `
  CREATE UNIQUE INDEX IF NOT EXISTS portability_export_project_key_unique
    ON documents(
      json_extract(doc, '$.projectId'),
      json_extract(doc, '$.idempotencyKey')
    ) WHERE collection = 'export_operations';
`;

export const snapshotIndexes = `
  CREATE UNIQUE INDEX IF NOT EXISTS portability_snapshot_operation_unique
    ON documents(json_extract(doc, '$.operationId'))
    WHERE collection = 'portability_snapshots';
  CREATE UNIQUE INDEX IF NOT EXISTS portability_snapshot_ordinal_unique
    ON documents(
      json_extract(doc, '$.snapshotId'), json_extract(doc, '$.ordinal')
    ) WHERE collection = 'portability_snapshot_entries';
  CREATE UNIQUE INDEX IF NOT EXISTS portability_snapshot_archive_entry_unique
    ON documents(
      json_extract(doc, '$.snapshotId'), json_extract(doc, '$.archiveEntry')
    ) WHERE collection = 'portability_snapshot_entries';
  CREATE UNIQUE INDEX IF NOT EXISTS portability_media_hold_unique
    ON documents(
      json_extract(doc, '$.snapshotId'),
      json_extract(doc, '$.namespace'),
      json_extract(doc, '$.mediaId')
    ) WHERE collection = 'portability_media_holds';
`;

export const managedExportIndexes = `
  CREATE UNIQUE INDEX IF NOT EXISTS portability_managed_export_operation_unique
    ON documents(json_extract(doc, '$.operationId'))
    WHERE collection = 'managed_exports';
  CREATE UNIQUE INDEX IF NOT EXISTS portability_managed_export_key_unique
    ON documents(json_extract(doc, '$.archiveKey'))
    WHERE collection = 'managed_exports';
`;

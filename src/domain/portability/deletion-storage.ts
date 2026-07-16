import { canonicalJson } from "../../contracts/canonical-json.js";
import type {
  BaseDocument,
  DocumentStore,
} from "../repository/document-store.js";
import {
  DomainMutationAdmission,
  operationOwnedMutation,
} from "./domain-mutation-admission.js";
import {
  deletionInventorySchema,
  deletionOperationSchema,
  deletionReportSchema,
  type DeletionInventory,
  type DeletionOperation,
  type DeletionOperationState,
  type DeletionReport,
} from "./deletion-model.js";
import type { PortabilityRegistry } from "./participants.js";
import { assertPortabilityTransaction } from "./repositories.js";

export const deletionCollections = {
  inventories: "deletion_inventories",
  operations: "deletion_operations",
  reports: "deletion_reports",
} as const;

interface StoredRow {
  doc: string;
}

export class DeletionInventoryRepository {
  constructor(private readonly store: DocumentStore) {}

  get(id: string): DeletionInventory | null {
    return readById(this.store, deletionCollections.inventories, id, (value) =>
      deletionInventorySchema.parse(value),
    );
  }

  insertInTransaction(inventory: DeletionInventory): DeletionInventory {
    assertPortabilityTransaction(this.store);
    const parsed = deletionInventorySchema.parse(inventory);
    const existing = this.get(parsed.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(parsed))
        fail("DELETION_INVENTORY_CONFLICT");
      return existing;
    }
    insertDocument(this.store, deletionCollections.inventories, parsed);
    return parsed;
  }
}

export class DeletionOperationRepository {
  constructor(private readonly store: DocumentStore) {
    initializeIndexes(store);
  }

  get(id: string): DeletionOperation | null {
    return readById(this.store, deletionCollections.operations, id, (value) =>
      deletionOperationSchema.parse(value),
    );
  }

  listRecoverable(): DeletionOperation[] {
    return readCollection(this.store, deletionCollections.operations, (value) =>
      deletionOperationSchema.parse(value),
    ).filter((operation) => operation.state !== "verified");
  }

  insertInTransaction(operation: DeletionOperation): DeletionOperation {
    assertPortabilityTransaction(this.store);
    const parsed = deletionOperationSchema.parse(operation);
    if (this.get(parsed.id)) fail("DELETION_OPERATION_CONFLICT");
    insertDocument(this.store, deletionCollections.operations, parsed);
    return parsed;
  }

  updateInTransaction(
    current: DeletionOperation,
    next: DeletionOperation,
  ): DeletionOperation {
    assertPortabilityTransaction(this.store);
    const persisted = this.get(current.id);
    if (!persisted || canonicalJson(persisted) !== canonicalJson(current))
      fail("DELETION_OPERATION_REVISION_CONFLICT");
    const parsed = deletionOperationSchema.parse(next);
    assertOperationImmutable(persisted, parsed);
    if (parsed.revision !== persisted.revision + 1)
      fail("DELETION_OPERATION_REVISION_CONFLICT");
    if (!allowedTransitions[persisted.state].has(parsed.state))
      fail("DELETION_OPERATION_STATE_INVALID");
    updateDocument(
      this.store,
      deletionCollections.operations,
      parsed,
      persisted.revision,
    );
    return parsed;
  }
}

export class DeletionReportRepository {
  constructor(private readonly store: DocumentStore) {}

  get(operationId: string): DeletionReport | null {
    return readById(
      this.store,
      deletionCollections.reports,
      operationId,
      (value) => deletionReportSchema.parse(value),
    );
  }

  insertInTransaction(report: DeletionReport): DeletionReport {
    assertPortabilityTransaction(this.store);
    const parsed = deletionReportSchema.parse(report);
    const existing = this.get(parsed.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(parsed))
        fail("DELETION_REPORT_CONFLICT");
      return existing;
    }
    insertDocument(this.store, deletionCollections.reports, parsed);
    return parsed;
  }
}

export class ParticipantDeletionStorage {
  private readonly admission: DomainMutationAdmission;

  constructor(
    private readonly store: DocumentStore,
    private readonly registry: PortabilityRegistry,
  ) {
    this.admission = new DomainMutationAdmission(store, registry, {
      allowExtendedParticipantWriters: true,
    });
  }

  deleteInTransaction(input: {
    operationId: string;
    collection: string;
    id: string;
    document: BaseDocument;
  }): void {
    assertPortabilityTransaction(this.store);
    const participant = this.registry.forCollection(input.collection);
    const document = participant.schema.parse(input.document);
    this.admission.assertInTransaction({
      writer: "portability.deletion-storage",
      collection: input.collection,
      mutation: "delete",
      before: document,
      after: null,
      operation: operationOwnedMutation({
        operationId: input.operationId,
        purpose: "deletion_confirm",
        phase: "exclusive",
        writer: "portability.deletion-storage",
        collection: input.collection,
        mutation: "delete",
      }),
    });
    const current = readRaw(this.store, input.collection, input.id);
    if (!current || canonicalJson(current) !== canonicalJson(document))
      fail("DELETION_DOCUMENT_REVISION_CONFLICT");
    const result = this.store.database
      .prepare("DELETE FROM documents WHERE collection = ? AND id = ?")
      .run(input.collection, input.id);
    if (result.changes !== 1) fail("DELETION_DOCUMENT_REVISION_CONFLICT");
  }
}

const allowedTransitions: Readonly<
  Record<DeletionOperationState, ReadonlySet<DeletionOperationState>>
> = {
  committing: new Set(["unlinking", "cleanup_required"]),
  unlinking: new Set([
    "unlinking",
    "verifying",
    "verified",
    "cleanup_required",
  ]),
  verifying: new Set(["verified", "cleanup_required"]),
  verified: new Set(),
  cleanup_required: new Set([
    "unlinking",
    "verifying",
    "verified",
    "cleanup_required",
  ]),
};

function assertOperationImmutable(
  current: DeletionOperation,
  next: DeletionOperation,
): void {
  for (const field of [
    "id",
    "schemaVersion",
    "createdAt",
    "target",
    "inventoryId",
    "inventoryHash",
    "idempotencyKey",
    "requestHash",
    "lockId",
    "inventoryLedgerRoot",
    "blockerLedgerRoot",
  ] as const)
    if (canonicalJson(current[field]) !== canonicalJson(next[field]))
      fail("DELETION_OPERATION_IMMUTABLE_FIELD_CHANGED");
}

function insertDocument(
  store: DocumentStore,
  collection: string,
  document: BaseDocument,
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

function updateDocument(
  store: DocumentStore,
  collection: string,
  document: DeletionOperation,
  expectedRevision: number,
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
  if (result.changes !== 1) fail("DELETION_OPERATION_REVISION_CONFLICT");
}

function readById<T>(
  store: DocumentStore,
  collection: string,
  id: string,
  parse: (value: unknown) => T,
): T | null {
  const value = readRaw(store, collection, id);
  if (!value) return null;
  const parsed = parse(value);
  store.assertSafeForPersistence(parsed);
  return parsed;
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
    .all(collection) as StoredRow[];
  return rows.map((row) => {
    const parsed = parse(JSON.parse(row.doc));
    store.assertSafeForPersistence(parsed);
    return parsed;
  });
}

function readRaw(
  store: DocumentStore,
  collection: string,
  id: string,
): unknown {
  const row = store.database
    .prepare("SELECT doc FROM documents WHERE collection = ? AND id = ?")
    .get(collection, id) as StoredRow | undefined;
  return row ? JSON.parse(row.doc) : null;
}

function initializeIndexes(store: DocumentStore): void {
  const apply = () =>
    store.database.exec(`
    CREATE INDEX IF NOT EXISTS deletion_operation_target
      ON documents(
        json_extract(doc, '$.target.kind'),
        json_extract(doc, '$.target.id')
      ) WHERE collection = 'deletion_operations';
  `);
  if (store.database.inTransaction) apply();
  else store.transactionImmediate(apply);
}

function fail(code: string): never {
  throw new Error(code);
}

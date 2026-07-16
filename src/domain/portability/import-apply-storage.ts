import { canonicalJson } from "../../contracts/canonical-json.js";
import type {
  BaseDocument,
  DocumentStore,
} from "../repository/document-store.js";
import {
  DomainMutationAdmission,
  operationOwnedMutation,
  type OperationOwnedMutationPurpose,
} from "./domain-mutation-admission.js";
import {
  preparedImportMediaSchema,
  type PreparedImportMedia,
} from "./import-apply-model.js";
import type { PortabilityRegistry } from "./participants.js";
import { assertPortabilityTransaction } from "./repositories.js";

const preparedTable = "portability_import_prepared_media";

export class PreparedImportMediaRepository {
  constructor(private readonly store: DocumentStore) {
    initializePreparedTable(store);
  }

  get(id: string): PreparedImportMedia | null {
    const row = this.store.database
      .prepare(`SELECT doc FROM ${preparedTable} WHERE id = ?`)
      .get(id) as { doc: string } | undefined;
    return row ? this.parse(row.doc) : null;
  }

  list(operationId: string): PreparedImportMedia[] {
    const rows = this.store.database
      .prepare(
        `SELECT doc FROM ${preparedTable}
         WHERE operation_id = ? ORDER BY namespace, source_id`,
      )
      .all(operationId) as Array<{ doc: string }>;
    return rows.map((row) => this.parse(row.doc));
  }

  insertInTransaction(media: PreparedImportMedia): PreparedImportMedia {
    assertPortabilityTransaction(this.store);
    const parsed = preparedImportMediaSchema.parse(media);
    const existing = this.get(parsed.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(parsed))
        fail("IMPORT_PREPARED_MEDIA_CONFLICT");
      return existing;
    }
    this.store.assertSafeForPersistence(parsed);
    try {
      this.store.database
        .prepare(
          `INSERT INTO ${preparedTable}(
             id, operation_id, plan_id, namespace, source_id, target_id,
             doc, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.operationId,
          parsed.planId,
          parsed.namespace,
          parsed.sourceId,
          parsed.targetId,
          JSON.stringify(parsed),
          parsed.revision,
          parsed.createdAt,
          parsed.updatedAt,
        );
    } catch (error) {
      throw new Error("IMPORT_PREPARED_MEDIA_CONFLICT", { cause: error });
    }
    return parsed;
  }

  updateInTransaction(
    current: PreparedImportMedia,
    next: PreparedImportMedia,
  ): PreparedImportMedia {
    assertPortabilityTransaction(this.store);
    const persisted = this.get(current.id);
    if (!persisted || canonicalJson(persisted) !== canonicalJson(current))
      fail("IMPORT_PREPARED_MEDIA_REVISION_CONFLICT");
    const parsed = preparedImportMediaSchema.parse(next);
    assertPreparedImmutable(persisted, parsed);
    if (parsed.revision !== persisted.revision + 1)
      fail("IMPORT_PREPARED_MEDIA_REVISION_CONFLICT");
    if (!preparedTransitions[persisted.state].has(parsed.state))
      fail("IMPORT_PREPARED_MEDIA_STATE_INVALID");
    this.store.assertSafeForPersistence(parsed);
    const result = this.store.database
      .prepare(
        `UPDATE ${preparedTable}
         SET doc = ?, revision = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        JSON.stringify(parsed),
        parsed.revision,
        parsed.updatedAt,
        parsed.id,
        persisted.revision,
      );
    if (result.changes !== 1)
      fail("IMPORT_PREPARED_MEDIA_REVISION_CONFLICT");
    return parsed;
  }

  private parse(value: string): PreparedImportMedia {
    const parsed = preparedImportMediaSchema.parse(JSON.parse(value));
    this.store.assertSafeForPersistence(parsed);
    return parsed;
  }
}

export class ParticipantImportStorage {
  private readonly admission: DomainMutationAdmission;

  constructor(
    private readonly store: DocumentStore,
    private readonly registry: PortabilityRegistry,
  ) {
    this.admission = new DomainMutationAdmission(store, registry, {
      allowExtendedParticipantWriters: true,
    });
  }

  insertInTransaction(input: {
    operationId: string;
    purpose: Extract<
      OperationOwnedMutationPurpose,
      "import_commit" | "replace_commit"
    >;
    collection: string;
    document: BaseDocument;
  }): void {
    assertPortabilityTransaction(this.store);
    const document = this.registry
      .forCollection(input.collection)
      .schema.parse(input.document);
    this.assertMutation(input, "insert", null, document);
    if (readRaw(this.store, input.collection, document.id))
      fail("IMPORT_DOCUMENT_CONFLICT");
    this.store.assertSafeForPersistence(document);
    this.store.database
      .prepare(
        `INSERT INTO documents(
           collection, id, doc, schema_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.collection,
        document.id,
        JSON.stringify(document),
        document.schemaVersion,
        document.createdAt,
        document.updatedAt,
      );
  }

  deleteInTransaction(input: {
    operationId: string;
    collection: string;
    document: BaseDocument;
  }): void {
    assertPortabilityTransaction(this.store);
    const document = this.registry
      .forCollection(input.collection)
      .schema.parse(input.document);
    this.assertMutation(
      { ...input, purpose: "replace_commit" },
      "delete",
      document,
      null,
    );
    const current = readRaw(this.store, input.collection, document.id);
    if (!current || canonicalJson(current) !== canonicalJson(document))
      fail("IMPORT_DOCUMENT_REVISION_CONFLICT");
    const result = this.store.database
      .prepare("DELETE FROM documents WHERE collection = ? AND id = ?")
      .run(input.collection, document.id);
    if (result.changes !== 1) fail("IMPORT_DOCUMENT_REVISION_CONFLICT");
  }

  private assertMutation(
    input: {
      operationId: string;
      purpose: Extract<
        OperationOwnedMutationPurpose,
        "import_commit" | "replace_commit"
      >;
      collection: string;
    },
    mutation: "insert" | "delete",
    before: BaseDocument | null,
    after: BaseDocument | null,
  ): void {
    const writer = "portability.import-storage" as const;
    this.admission.assertInTransaction({
      writer,
      collection: input.collection,
      mutation,
      before,
      after,
      operation: operationOwnedMutation({
        operationId: input.operationId,
        purpose: input.purpose,
        phase: "exclusive",
        writer,
        collection: input.collection,
        mutation,
      }),
    });
  }
}

const preparedTransitions: Readonly<
  Record<PreparedImportMedia["state"], ReadonlySet<PreparedImportMedia["state"]>>
> = {
  reserved: new Set(["written", "discarded"]),
  written: new Set(["committed", "discarded"]),
  committed: new Set(),
  discarded: new Set(),
};

function assertPreparedImmutable(
  current: PreparedImportMedia,
  next: PreparedImportMedia,
): void {
  for (const field of [
    "id",
    "schemaVersion",
    "createdAt",
    "operationId",
    "planId",
    "namespace",
    "sourceId",
    "targetId",
    "checksum",
    "bytes",
    "metadataHash",
    "managedKey",
    "wasPreexisting",
    "record",
  ] as const)
    if (canonicalJson(current[field]) !== canonicalJson(next[field]))
      fail("IMPORT_PREPARED_MEDIA_IMMUTABLE_FIELD_CHANGED");
}

function initializePreparedTable(store: DocumentStore): void {
  const apply = () =>
    store.database.exec(`
      CREATE TABLE IF NOT EXISTS ${preparedTable} (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        doc TEXT NOT NULL CHECK(json_valid(doc)),
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(operation_id, namespace, source_id),
        UNIQUE(operation_id, namespace, target_id)
      );
      CREATE INDEX IF NOT EXISTS portability_import_prepared_operation
      ON ${preparedTable}(operation_id, namespace, source_id);
    `);
  if (store.database.inTransaction) apply();
  else store.transactionImmediate(apply);
}

function readRaw(
  store: DocumentStore,
  collection: string,
  id: string,
): BaseDocument | null {
  const row = store.database
    .prepare("SELECT doc FROM documents WHERE collection = ? AND id = ?")
    .get(collection, id) as { doc: string } | undefined;
  return row ? (JSON.parse(row.doc) as BaseDocument) : null;
}

function fail(code: string): never {
  throw new Error(code);
}

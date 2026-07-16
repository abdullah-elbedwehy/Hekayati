import { ulid } from "ulid";

import { canonicalJson } from "../../contracts/canonical-json.js";
import { entityIdSchema } from "../library/schemas.js";
import type { DocumentStore } from "../repository/document-store.js";
import {
  importOperationSchema,
  type ImportOperation,
  type ImportOperationState,
} from "./import-model.js";
import type { ImportCommitProgress } from "./import-apply-model.js";

export const importPortabilityCollections = Object.freeze({
  operations: "import_operations",
  validationRows: "import_validation_rows",
} as const);

const operationTable = "portability_import_operations";
const installationTable = "portability_installation_identity";

export class ImportOperationRepository {
  constructor(
    private readonly store: DocumentStore,
    private readonly idFactory: () => string = ulid,
  ) {
    initialize(this.store);
  }

  installationId(): string {
    const current = this.readInstallationId();
    if (current) return entityIdSchema.parse(current);
    return this.store.transactionImmediate(() => {
      const raced = this.readInstallationId();
      if (raced) return entityIdSchema.parse(raced);
      const id = entityIdSchema.parse(this.idFactory());
      this.store.database
        .prepare(
          `INSERT INTO ${installationTable}(singleton, installation_id)
           VALUES (1, ?)`,
        )
        .run(id);
      return id;
    });
  }

  get(id: string): ImportOperation | null {
    const row = this.store.database
      .prepare(`SELECT doc FROM ${operationTable} WHERE id = ?`)
      .get(id) as { doc: string } | undefined;
    return row ? this.parse(row.doc) : null;
  }

  list(): ImportOperation[] {
    const rows = this.store.database
      .prepare(`SELECT doc FROM ${operationTable} ORDER BY created_at, id`)
      .all() as Array<{ doc: string }>;
    return rows.map((row) => this.parse(row.doc));
  }

  referencedReservationKeys(): ReadonlySet<string> {
    return new Set(
      this.list().flatMap((operation) =>
        operation.reservationKey ? [operation.reservationKey] : [],
      ),
    );
  }

  referencedStagingKeys(): ReadonlySet<string> {
    return new Set(
      this.list().flatMap((operation) =>
        operation.stagingKey ? [operation.stagingKey] : [],
      ),
    );
  }

  insertInTransaction(operation: ImportOperation): ImportOperation {
    assertTransaction(this.store);
    const parsed = importOperationSchema.parse(operation);
    if (
      parsed.revision !== 0 ||
      parsed.state !== "uploaded" ||
      parsed.createdAt !== parsed.updatedAt
    )
      throw new Error("IMPORT_OPERATION_INITIAL_STATE_INVALID");
    this.store.assertSafeForPersistence(parsed);
    this.store.database
      .prepare(
        `INSERT INTO ${operationTable}(id, doc, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        JSON.stringify(parsed),
        parsed.revision,
        parsed.createdAt,
        parsed.updatedAt,
      );
    return parsed;
  }

  replaceInTransaction(
    operation: ImportOperation,
    expectedRevision: number,
  ): ImportOperation {
    assertTransaction(this.store);
    const current = this.get(operation.id);
    if (!current || current.revision !== expectedRevision)
      throw new Error("IMPORT_OPERATION_REVISION_CONFLICT");
    const parsed = importOperationSchema.parse(operation);
    if (parsed.revision !== expectedRevision + 1)
      throw new Error("IMPORT_OPERATION_REVISION_INVALID");
    assertOperationTransition(current, parsed);
    this.store.assertSafeForPersistence(parsed);
    const result = this.store.database
      .prepare(
        `UPDATE ${operationTable}
         SET doc = ?, revision = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        JSON.stringify(parsed),
        parsed.revision,
        parsed.updatedAt,
        parsed.id,
        expectedRevision,
      );
    if (result.changes !== 1)
      throw new Error("IMPORT_OPERATION_REVISION_CONFLICT");
    return parsed;
  }

  private readInstallationId(): string | null {
    const row = this.store.database
      .prepare(
        `SELECT installation_id AS id FROM ${installationTable}
         WHERE singleton = 1`,
      )
      .get() as { id: string } | undefined;
    return row?.id ?? null;
  }

  private parse(value: string): ImportOperation {
    const parsed = importOperationSchema.parse(JSON.parse(value));
    this.store.assertSafeForPersistence(parsed);
    return parsed;
  }
}

function initialize(store: DocumentStore): void {
  const apply = () =>
    store.database.exec(`
    CREATE TABLE IF NOT EXISTS ${operationTable} (
      id TEXT PRIMARY KEY,
      doc TEXT NOT NULL CHECK(json_valid(doc)),
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portability_import_operations_updated
    ON ${operationTable}(updated_at, id);
    CREATE TABLE IF NOT EXISTS ${installationTable} (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      installation_id TEXT NOT NULL UNIQUE
    );
  `);
  if (store.database.inTransaction) apply();
  else store.transactionImmediate(apply);
}

function assertTransaction(store: DocumentStore): void {
  if (!store.database.inTransaction)
    throw new Error("IMPORT_TRANSACTION_REQUIRED");
}

const allowedTransitions: Readonly<
  Record<ImportOperationState, ReadonlySet<ImportOperationState>>
> = {
  uploaded: new Set(["validating", "failed", "cleanup_required"]),
  validating: new Set([
    "validating",
    "plan_ready",
    "failed",
    "cleanup_required",
  ]),
  plan_ready: new Set(["plan_ready", "committing", "failed"]),
  committing: new Set([
    "committing",
    "imported",
    "rolled_back",
    "cleanup_required",
  ]),
  imported: new Set(["imported", "cleanup_required"]),
  rolled_back: new Set(["rolled_back", "cleanup_required"]),
  failed: new Set(),
  cleanup_required: new Set([
    "cleanup_required",
    "validating",
    "failed",
    "imported",
    "rolled_back",
  ]),
};

function assertOperationTransition(
  current: ImportOperation,
  next: ImportOperation,
): void {
  if (!allowedTransitions[current.state].has(next.state))
    throw new Error("IMPORT_OPERATION_STATE_TRANSITION_INVALID");
  for (const field of [
    "id",
    "schemaVersion",
    "createdAt",
    "sourceArchiveHash",
    "sourceArchiveBytes",
  ] as const)
    if (canonicalJson(current[field]) !== canonicalJson(next[field]))
      throw new Error("IMPORT_OPERATION_IMMUTABLE_FIELD_CHANGED");
  if (
    current.actionRefs.uploadActionId !== next.actionRefs.uploadActionId ||
    keyChanged(current.reservationKey, next.reservationKey) ||
    keyChanged(current.stagingKey, next.stagingKey)
  )
    throw new Error("IMPORT_OPERATION_IMMUTABLE_FIELD_CHANGED");
  if (current.normalizedManifestHash !== null)
    assertPinnedValidationFacts(current, next);
  assertCommitFacts(current, next);
}

function keyChanged(current: string | null, next: string | null): boolean {
  return current !== null && next !== null && current !== next;
}

function assertPinnedValidationFacts(
  current: ImportOperation,
  next: ImportOperation,
): void {
  for (const field of [
    "manifestVersion",
    "normalizedManifestHash",
    "sourceSnapshotHash",
    "participantRegistryHash",
    "archiveMode",
    "documentCount",
    "mediaCount",
    "totalUncompressedBytes",
    "diskFacts",
    "migrationSummary",
  ] as const)
    if (canonicalJson(current[field]) !== canonicalJson(next[field]))
      throw new Error("IMPORT_OPERATION_VALIDATION_FACT_CHANGED");
}

function assertCommitFacts(
  current: ImportOperation,
  next: ImportOperation,
): void {
  if (!current.commit) {
    if (!next.commit) return;
    if (
      current.state !== "plan_ready" ||
      next.state !== "committing" ||
      next.commit.expectedOperationRevision !== current.revision
    )
      throw new Error("IMPORT_COMMIT_BINDING_INVALID");
    return;
  }
  if (!next.commit) throw new Error("IMPORT_COMMIT_BINDING_CHANGED");
  assertCommitImmutable(current.commit, next.commit);
  if (!commitTransitions[current.commit.phase].has(next.commit.phase))
    throw new Error("IMPORT_COMMIT_PHASE_INVALID");
  if (
    (current.commit.phase === "cleanup_required" ||
      next.commit.phase === "cleanup_required") &&
    next.commit.result !== null &&
    current.commit.result === null
  )
    throw new Error("IMPORT_COMMIT_RECOVERY_BRANCH_CHANGED");
  if (
    current.actionRefs.commitActionId !== null &&
    current.actionRefs.commitActionId !== next.actionRefs.commitActionId
  )
    throw new Error("IMPORT_COMMIT_ACTION_CHANGED");
}

const commitTransitions: Readonly<
  Record<
    ImportCommitProgress["phase"],
    ReadonlySet<ImportCommitProgress["phase"]>
  >
> = {
  preparing: new Set([
    "preparing",
    "graph_committed",
    "rolling_back",
    "cleanup_required",
  ]),
  graph_committed: new Set(["graph_committed", "complete", "cleanup_required"]),
  rolling_back: new Set(["rolling_back", "rolled_back", "cleanup_required"]),
  cleanup_required: new Set(["cleanup_required", "complete", "rolled_back"]),
  complete: new Set(),
  rolled_back: new Set(),
};

function assertCommitImmutable(
  current: ImportCommitProgress,
  next: ImportCommitProgress,
): void {
  for (const field of [
    "action",
    "idempotencyKey",
    "requestHash",
    "expectedOperationRevision",
    "planConfirmationHash",
    "preparedCount",
  ] as const)
    if (canonicalJson(current[field]) !== canonicalJson(next[field]))
      throw new Error("IMPORT_COMMIT_IMMUTABLE_FIELD_CHANGED");
  for (const field of ["id", "mode", "scope"] as const)
    if (canonicalJson(current.lock[field]) !== canonicalJson(next.lock[field]))
      throw new Error("IMPORT_COMMIT_LOCK_CHANGED");
  assertPinnedHash(current.sourceProofHash, next.sourceProofHash);
  assertPinnedHash(current.targetSnapshotHash, next.targetSnapshotHash);
  if (current.result) assertCommitResultImmutable(current.result, next.result);
}

function assertPinnedHash(current: string | null, next: string | null): void {
  if (current !== null && current !== next)
    throw new Error("IMPORT_COMMIT_IMMUTABLE_FIELD_CHANGED");
}

function assertCommitResultImmutable(
  current: NonNullable<ImportCommitProgress["result"]>,
  next: ImportCommitProgress["result"],
): void {
  if (!next) throw new Error("IMPORT_COMMIT_RESULT_CHANGED");
  for (const field of [
    "graphHash",
    "targetRootIds",
    "documentCount",
    "preparedMediaCount",
    "canceledJobCount",
    "committedAt",
  ] as const)
    if (canonicalJson(current[field]) !== canonicalJson(next[field]))
      throw new Error("IMPORT_COMMIT_RESULT_CHANGED");
}

import { chmodSync } from "node:fs";

import Database from "better-sqlite3";
import type { ZodType } from "zod";

import { SecretRegistry } from "../../security/secret-registry.js";

export interface BaseDocument {
  id: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

interface StoredRow {
  doc: string;
}

interface StoredMigrationRow extends StoredRow {
  id: string;
  schema_version: number;
}

export interface DocumentMigration {
  from: number;
  to: number;
  migrate(document: unknown): unknown;
}

const COLLECTION_PATTERN = /^[a-z][a-z0-9_]*$/;
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export class DocumentStore {
  readonly database: Database.Database;

  constructor(
    readonly filePath: string,
    readonly secretRegistry = new SecretRegistry(),
  ) {
    this.database = new Database(filePath);
    try {
      this.configure();
      this.migrate();
      chmodSync(filePath, 0o600);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  isHealthy(): boolean {
    return this.database.prepare("SELECT 1 AS ok").get() !== undefined;
  }

  transaction<T>(operation: () => T): T {
    return this.database.transaction(() => synchronousResult(operation))();
  }

  transactionImmediate<T>(operation: () => T): T {
    const execute = this.database.transaction(() =>
      synchronousResult(operation),
    );
    return execute.immediate();
  }

  assertSafeForPersistence(value: unknown): void {
    this.secretRegistry.assertSafeForPersistence(value);
  }

  migrateDocuments<T extends BaseDocument>(
    collection: string,
    targetVersion: number,
    schema: ZodType<T>,
    migrations: readonly DocumentMigration[],
  ): number {
    if (!COLLECTION_PATTERN.test(collection) || targetVersion < 1)
      throw new Error("INVALID_DOCUMENT_MIGRATION");
    const steps = migrationSteps(migrations);
    return this.transaction(() => {
      const rows = this.database
        .prepare(
          "SELECT id, doc, schema_version FROM documents WHERE collection = ? ORDER BY id",
        )
        .all(collection) as StoredMigrationRow[];
      let migrated = 0;
      for (const row of rows) {
        if (row.schema_version > targetVersion)
          throw new Error("FUTURE_DOCUMENT_VERSION");
        if (row.schema_version === targetVersion) {
          this.assertSafeForPersistence(schema.parse(JSON.parse(row.doc)));
          continue;
        }
        const document = applyMigrations(row, targetVersion, steps, schema);
        this.updateMigratedDocument(collection, document);
        migrated += 1;
      }
      return migrated;
    });
  }

  currentMigration(): number {
    const row = this.database
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    return row.version ?? 0;
  }

  private updateMigratedDocument(
    collection: string,
    document: BaseDocument,
  ): void {
    this.assertSafeForPersistence(document);
    this.database
      .prepare(
        `UPDATE documents
         SET doc = ?, schema_version = ?, updated_at = ?
         WHERE collection = ? AND id = ?`,
      )
      .run(
        JSON.stringify(document),
        document.schemaVersion,
        document.updatedAt,
        collection,
        document.id,
      );
  }

  private configure(): void {
    this.database.pragma("busy_timeout = 250");
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("locking_mode = EXCLUSIVE");
    this.database.pragma("synchronous = FULL");
    this.database.pragma("foreign_keys = ON");
    this.database.exec("BEGIN EXCLUSIVE; COMMIT;");
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS documents (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        doc TEXT NOT NULL CHECK(json_valid(doc)),
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      );
      CREATE INDEX IF NOT EXISTS documents_collection_updated
      ON documents(collection, updated_at);
    `);
    if (this.currentMigration() < 1) {
      this.database
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
        )
        .run(1, new Date().toISOString());
    }
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    return false;
  return "then" in value && typeof value.then === "function";
}

function synchronousResult<T>(operation: () => T): T {
  const result = operation();
  if (isThenable(result)) throw new Error("ASYNC_TRANSACTION_FORBIDDEN");
  return result;
}

function migrationSteps(
  migrations: readonly DocumentMigration[],
): Map<number, DocumentMigration> {
  const steps = new Map<number, DocumentMigration>();
  for (const migration of migrations) {
    if (
      migration.from < 0 ||
      migration.to !== migration.from + 1 ||
      steps.has(migration.from)
    ) {
      throw new Error("INVALID_DOCUMENT_MIGRATION");
    }
    steps.set(migration.from, migration);
  }
  return steps;
}

function applyMigrations<T extends BaseDocument>(
  row: StoredMigrationRow,
  targetVersion: number,
  steps: Map<number, DocumentMigration>,
  schema: ZodType<T>,
): T {
  let document: unknown = JSON.parse(row.doc);
  let version = row.schema_version;
  while (version < targetVersion) {
    const step = steps.get(version);
    if (!step) throw new Error("MISSING_DOCUMENT_MIGRATION");
    document = step.migrate(document);
    if (
      !document ||
      typeof document !== "object" ||
      (document as { schemaVersion?: unknown }).schemaVersion !== step.to
    ) {
      throw new Error("INVALID_DOCUMENT_MIGRATION_RESULT");
    }
    version = step.to;
  }
  const parsed = schema.parse(document);
  if (parsed.id !== row.id) throw new Error("DOCUMENT_ID_MIGRATION_FORBIDDEN");
  return parsed;
}

export class DocumentRepository<T extends BaseDocument> {
  constructor(
    private readonly store: DocumentStore,
    private readonly collection: string,
    private readonly schema: ZodType<T>,
  ) {
    if (!COLLECTION_PATTERN.test(collection))
      throw new Error("INVALID_COLLECTION_NAME");
  }

  get(id: string): T | null {
    const row = this.store.database
      .prepare("SELECT doc FROM documents WHERE collection = ? AND id = ?")
      .get(this.collection, id) as StoredRow | undefined;
    return row ? this.parse(row.doc) : null;
  }

  list(): T[] {
    const rows = this.store.database
      .prepare(
        "SELECT doc FROM documents WHERE collection = ? ORDER BY created_at, id",
      )
      .all(this.collection) as StoredRow[];
    return rows.map((row) => this.parse(row.doc));
  }

  queryByField(field: string, value: string | number | boolean): T[] {
    if (!FIELD_PATTERN.test(field)) throw new Error("INVALID_QUERY_FIELD");
    const jsonPath = `$.${field}`;
    const rows = this.store.database
      .prepare(
        "SELECT doc FROM documents WHERE collection = ? AND json_extract(doc, ?) = ? ORDER BY id",
      )
      .all(this.collection, jsonPath, value) as StoredRow[];
    return rows.map((row) => this.parse(row.doc));
  }

  put(document: T): T {
    const parsed = this.schema.parse(document);
    this.store.assertSafeForPersistence(parsed);
    this.store.database
      .prepare(
        `INSERT INTO documents(collection, id, doc, schema_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(collection, id) DO UPDATE SET
           doc = excluded.doc,
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at`,
      )
      .run(
        this.collection,
        parsed.id,
        JSON.stringify(parsed),
        parsed.schemaVersion,
        parsed.createdAt,
        parsed.updatedAt,
      );
    return parsed;
  }

  delete(id: string): boolean {
    const result = this.store.database
      .prepare("DELETE FROM documents WHERE collection = ? AND id = ?")
      .run(this.collection, id);
    return result.changes > 0;
  }

  private parse(value: string): T {
    const parsed = this.schema.parse(JSON.parse(value));
    this.store.assertSafeForPersistence(parsed);
    return parsed;
  }
}

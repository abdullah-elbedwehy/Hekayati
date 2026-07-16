import type { DocumentStore } from "../repository/document-store.js";
import { importPlanSchema, type ImportPlan } from "./import-plan-model.js";

const planTable = "portability_import_plans";

export class ImportPlanRepository {
  constructor(private readonly store: DocumentStore) {
    initialize(store);
  }

  get(id: string): ImportPlan | null {
    const row = this.store.database
      .prepare(`SELECT doc FROM ${planTable} WHERE id = ?`)
      .get(id) as { doc: string } | undefined;
    return row ? this.parse(row.doc) : null;
  }

  listByOperation(operationId: string): ImportPlan[] {
    const rows = this.store.database
      .prepare(
        `SELECT doc FROM ${planTable}
         WHERE operation_id = ? ORDER BY created_at, id`,
      )
      .all(operationId) as Array<{ doc: string }>;
    return rows.map((row) => this.parse(row.doc));
  }

  insertInTransaction(plan: ImportPlan): ImportPlan {
    assertTransaction(this.store);
    const parsed = importPlanSchema.parse(plan);
    this.store.assertSafeForPersistence(parsed);
    this.store.database
      .prepare(
        `INSERT INTO ${planTable}(id, operation_id, doc, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.operationId,
        JSON.stringify(parsed),
        parsed.createdAt,
      );
    return parsed;
  }

  private parse(value: string): ImportPlan {
    const parsed = importPlanSchema.parse(JSON.parse(value));
    this.store.assertSafeForPersistence(parsed);
    return parsed;
  }
}

function initialize(store: DocumentStore): void {
  const apply = () =>
    store.database.exec(`
      CREATE TABLE IF NOT EXISTS ${planTable} (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        doc TEXT NOT NULL CHECK(json_valid(doc)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS portability_import_plans_operation
      ON ${planTable}(operation_id, created_at, id);
    `);
  if (store.database.inTransaction) apply();
  else store.transactionImmediate(apply);
}

function assertTransaction(store: DocumentStore): void {
  if (!store.database.inTransaction)
    throw new Error("IMPORT_PLAN_TRANSACTION_REQUIRED");
}

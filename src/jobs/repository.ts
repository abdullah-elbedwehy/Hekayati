import type { DocumentStore } from "../domain/repository/document-store.js";
import { JobError } from "./errors.js";
import { jobRecordSchema, type JobRecord } from "./schemas.js";
import type { ClaimOptions } from "./types.js";

interface StoredRow {
  doc: string;
}

const immutableFields = [
  "id",
  "schemaVersion",
  "createdAt",
  "jobType",
  "projectId",
  "standaloneScopeId",
  "dependsOn",
  "createdSequence",
  "intentId",
  "idempotencyKey",
  "requestHash",
  "target",
  "request",
  "inputSnapshot",
] as const;

const atomicClaimSql = `WITH candidate AS (
  SELECT queued.id
  FROM documents AS queued
  WHERE queued.collection = 'jobs'
    AND json_extract(queued.doc, '$.state') = 'queued'
    AND (
      json_type(queued.doc, '$.retrySchedule') = 'null'
      OR (
        json_extract(queued.doc, '$.retrySchedule.bootId') = @bootId
        AND CAST(json_extract(queued.doc, '$.retrySchedule.nextEligibleAtMono') AS INTEGER) <= @nowMonoMs
      )
      OR (
        json_extract(queued.doc, '$.retrySchedule.bootId') <> @bootId
        AND json_extract(queued.doc, '$.retrySchedule.nextEligibleAt') <= @nowWallIso
      )
    )
    AND (
      json_type(queued.doc, '$.target') = 'null'
      OR (
        SELECT COUNT(*)
        FROM documents AS active
        WHERE active.collection = 'jobs'
          AND json_extract(active.doc, '$.state') IN ('claimed', 'running')
          AND json_extract(active.doc, '$.target.providerId') =
            json_extract(queued.doc, '$.target.providerId')
      ) < @concurrencyPerProvider
    )
  ORDER BY
    CAST(json_extract(queued.doc, '$.priority') AS INTEGER) DESC,
    CAST(json_extract(queued.doc, '$.createdSequence') AS INTEGER),
    queued.id
  LIMIT 1
)
UPDATE documents
SET doc = json_set(
      doc,
      '$.state', 'claimed',
      '$.stateReason', NULL,
      '$.lease', json(@lease),
      '$.attempts', CAST(json_extract(doc, '$.attempts') AS INTEGER) + 1,
      '$.retrySchedule', NULL,
      '$.progress', NULL,
      '$.updatedAt', @updatedAt,
      '$.revision', CAST(json_extract(doc, '$.revision') AS INTEGER) + 1
    ),
    updated_at = @updatedAt
WHERE collection = 'jobs'
  AND id = (SELECT id FROM candidate)
  AND json_extract(doc, '$.state') = 'queued'
RETURNING doc`;

export class JobRepository {
  constructor(private readonly store: DocumentStore) {
    this.createIndexes();
  }

  transaction<T>(operation: () => T): T {
    return this.store.transaction(operation);
  }

  get(id: string): JobRecord | null {
    const row = this.store.database
      .prepare("SELECT doc FROM documents WHERE collection = 'jobs' AND id = ?")
      .get(id) as StoredRow | undefined;
    return row ? this.parse(row.doc) : null;
  }

  list(): JobRecord[] {
    const rows = this.store.database
      .prepare(
        "SELECT doc FROM documents WHERE collection = 'jobs' ORDER BY created_at, id",
      )
      .all() as StoredRow[];
    return rows.map((row) => this.parse(row.doc));
  }

  findByIdempotencyKey(key: string): JobRecord | null {
    const row = this.store.database
      .prepare(
        "SELECT doc FROM documents WHERE collection = 'jobs' AND json_extract(doc, '$.idempotencyKey') = ? LIMIT 1",
      )
      .get(key) as StoredRow | undefined;
    return row ? this.parse(row.doc) : null;
  }

  nextCreatedSequence(): number {
    const row = this.store.database
      .prepare(
        `SELECT MAX(CAST(json_extract(doc, '$.createdSequence') AS INTEGER)) AS sequence
         FROM documents WHERE collection = 'jobs'`,
      )
      .get() as { sequence: number | null };
    return (row.sequence ?? -1) + 1;
  }

  claimNext(
    options: ClaimOptions,
    lease: NonNullable<JobRecord["lease"]>,
    updatedAt: string,
  ): JobRecord | null {
    const row = this.store.database.prepare(atomicClaimSql).get({
      bootId: options.bootId,
      nowMonoMs: options.nowMonoMs,
      nowWallIso: new Date(options.nowWallMs).toISOString(),
      concurrencyPerProvider: options.concurrencyPerProvider,
      lease: JSON.stringify(lease),
      updatedAt,
    }) as StoredRow | undefined;
    return row ? this.parse(row.doc) : null;
  }

  insert(input: JobRecord): JobRecord {
    const job = jobRecordSchema.parse(input);
    this.store.assertSafeForPersistence(job);
    try {
      this.store.database
        .prepare(
          `INSERT INTO documents(collection, id, doc, schema_version, created_at, updated_at)
           VALUES ('jobs', ?, ?, ?, ?, ?)`,
        )
        .run(
          job.id,
          JSON.stringify(job),
          job.schemaVersion,
          job.createdAt,
          job.updatedAt,
        );
    } catch (error) {
      throw new JobError("JOB_INSERT_CONFLICT", 409, { cause: error });
    }
    return job;
  }

  update(current: JobRecord, input: JobRecord): JobRecord {
    const next = jobRecordSchema.parse(input);
    assertImmutable(current, next);
    if (next.revision !== current.revision + 1)
      throw new JobError("JOB_REVISION_INVALID");
    this.store.assertSafeForPersistence(next);
    const result = this.store.database
      .prepare(
        `UPDATE documents
         SET doc = ?, schema_version = ?, updated_at = ?
         WHERE collection = 'jobs' AND id = ?
           AND json_extract(doc, '$.revision') = ?`,
      )
      .run(
        JSON.stringify(next),
        next.schemaVersion,
        next.updatedAt,
        next.id,
        current.revision,
      );
    if (result.changes !== 1) throw new JobError("JOB_REVISION_CONFLICT");
    return next;
  }

  private parse(json: string): JobRecord {
    const job = jobRecordSchema.parse(JSON.parse(json));
    this.store.assertSafeForPersistence(job);
    return job;
  }

  private createIndexes(): void {
    this.store.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_unique
        ON documents(json_extract(doc, '$.idempotencyKey'))
        WHERE collection = 'jobs';
      CREATE INDEX IF NOT EXISTS jobs_claim_eligibility
        ON documents(
          json_extract(doc, '$.state'),
          json_extract(doc, '$.priority') DESC,
          created_at,
          id
        ) WHERE collection = 'jobs';
      CREATE INDEX IF NOT EXISTS jobs_retry_eligibility
        ON documents(
          json_extract(doc, '$.state'),
          json_extract(doc, '$.retrySchedule.bootId'),
          json_extract(doc, '$.retrySchedule.nextEligibleAtMono'),
          json_extract(doc, '$.retrySchedule.nextEligibleAt')
        ) WHERE collection = 'jobs';
      CREATE INDEX IF NOT EXISTS jobs_provider_state
        ON documents(
          json_extract(doc, '$.target.providerId'),
          json_extract(doc, '$.state')
        ) WHERE collection = 'jobs';
      CREATE INDEX IF NOT EXISTS jobs_project_state
        ON documents(
          json_extract(doc, '$.projectId'),
          json_extract(doc, '$.state')
        ) WHERE collection = 'jobs';
    `);
  }
}

function assertImmutable(current: JobRecord, next: JobRecord): void {
  for (const field of immutableFields) {
    if (JSON.stringify(current[field]) !== JSON.stringify(next[field]))
      throw new JobError("JOB_IMMUTABLE_FIELD_CHANGED");
  }
}

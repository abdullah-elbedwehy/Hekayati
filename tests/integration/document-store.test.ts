import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import {
  DocumentRepository,
  DocumentStore,
} from "../../src/domain/repository/document-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const fixtureSchema = z
  .object({
    id: z.string(),
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    familyId: z.string(),
    value: z.string(),
  })
  .strict();
type Fixture = z.infer<typeof fixtureSchema>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("document repository", () => {
  it("validates, persists, lists, and queries flexible JSON documents", async () => {
    const fixture = await databaseFixture();
    const repository = new DocumentRepository<Fixture>(
      fixture.store,
      "fixtures",
      fixtureSchema,
    );
    const document = makeDocument("one", "family-a");
    repository.put(document);

    expect(repository.get("one")).toEqual(document);
    expect(repository.list()).toEqual([document]);
    expect(repository.queryByField("familyId", "family-a")).toEqual([document]);
    expect(() =>
      repository.queryByField("familyId') OR 1=1 --", "family-a"),
    ).toThrow("INVALID_QUERY_FIELD");
    expect(() =>
      repository.put({ ...document, value: 42 } as unknown as Fixture),
    ).toThrow();
  });

  it("rejects secret material hidden in free-form document keys", async () => {
    const fixture = await databaseFixture();
    const mapSchema = fixtureSchema.extend({
      labels: z.record(z.string(), z.string()),
    });
    const repository = new DocumentRepository(
      fixture.store,
      "secret_key_fixtures",
      mapSchema,
    );
    const canary = "AIza1234567890123456789012345";
    const document = {
      ...makeDocument("secret-key", "family-safe"),
      labels: { [canary]: "ordinary-value" },
    };

    expect(() => repository.put(document)).toThrow(
      "SECRET_PERSISTENCE_FORBIDDEN",
    );
    const count = fixture.store.database
      .prepare(
        "SELECT COUNT(*) AS count FROM documents WHERE collection = 'secret_key_fixtures'",
      )
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  it("uses WAL and FULL durability, migrates once, and survives reopen", async () => {
    const fixture = await databaseFixture();
    const repository = new DocumentRepository<Fixture>(
      fixture.store,
      "fixtures",
      fixtureSchema,
    );
    repository.put(makeDocument("restart", "family-b"));
    expect(
      fixture.store.database.pragma("journal_mode", { simple: true }),
    ).toBe("wal");
    expect(fixture.store.database.pragma("synchronous", { simple: true })).toBe(
      2,
    );
    expect(fixture.store.currentMigration()).toBe(1);
    fixture.store.close();

    const reopened = new DocumentStore(fixture.paths.database);
    const reopenedRepository = new DocumentRepository<Fixture>(
      reopened,
      "fixtures",
      fixtureSchema,
    );
    expect(reopened.currentMigration()).toBe(1);
    expect(reopenedRepository.get("restart")?.value).toBe("value-restart");
    reopened.close();
  });

  it("atomically migrates legacy document schema versions through registered steps", async () => {
    const fixture = await databaseFixture();
    const now = new Date().toISOString();
    fixture.store.database
      .prepare(
        `INSERT INTO documents(collection, id, doc, schema_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "fixtures",
        "legacy",
        JSON.stringify({
          id: "legacy",
          schemaVersion: 0,
          createdAt: now,
          updatedAt: now,
          familyId: "family-legacy",
          legacyValue: "migrated-value",
        }),
        0,
        now,
        now,
      );

    const migrated = fixture.store.migrateDocuments(
      "fixtures",
      1,
      fixtureSchema,
      [
        {
          from: 0,
          to: 1,
          migrate: (input) => {
            const legacy = input as Record<string, unknown>;
            const { legacyValue, ...document } = legacy;
            return { ...document, schemaVersion: 1, value: legacyValue };
          },
        },
      ],
    );
    const repository = new DocumentRepository(
      fixture.store,
      "fixtures",
      fixtureSchema,
    );

    expect(migrated).toBe(1);
    expect(repository.get("legacy")?.value).toBe("migrated-value");
    expect(
      fixture.store.migrateDocuments("fixtures", 1, fixtureSchema, []),
    ).toBe(0);
  });

  it("rolls back when a required document migration step is missing", async () => {
    const fixture = await databaseFixture();
    const now = new Date().toISOString();
    fixture.store.database
      .prepare(
        `INSERT INTO documents(collection, id, doc, schema_version, created_at, updated_at)
         VALUES ('fixtures', 'unmigrated', ?, 0, ?, ?)`,
      )
      .run(JSON.stringify({ id: "unmigrated", schemaVersion: 0 }), now, now);

    expect(() =>
      fixture.store.migrateDocuments("fixtures", 1, fixtureSchema, []),
    ).toThrow("MISSING_DOCUMENT_MIGRATION");
    const row = fixture.store.database
      .prepare(
        "SELECT schema_version FROM documents WHERE collection = 'fixtures' AND id = 'unmigrated'",
      )
      .get() as { schema_version: number };
    expect(row.schema_version).toBe(0);
  });

  it("rolls back an earlier document update when a later migration fails", async () => {
    const fixture = await databaseFixture();
    const now = new Date().toISOString();
    const originals = ["rollback-a", "rollback-b"].map((id) => ({
      id,
      schemaVersion: 0,
      createdAt: now,
      updatedAt: now,
      familyId: "family-rollback",
      legacyValue: `legacy-${id}`,
    }));
    const insert = fixture.store.database.prepare(
      `INSERT INTO documents(collection, id, doc, schema_version, created_at, updated_at)
       VALUES ('fixtures', ?, ?, 0, ?, ?)`,
    );
    for (const document of originals)
      insert.run(document.id, JSON.stringify(document), now, now);

    expect(() =>
      fixture.store.migrateDocuments("fixtures", 1, fixtureSchema, [
        {
          from: 0,
          to: 1,
          migrate: (input) => {
            const legacy = input as (typeof originals)[number];
            const { legacyValue, ...document } = legacy;
            return {
              ...document,
              schemaVersion: 1,
              value: legacy.id === "rollback-b" ? 42 : legacyValue,
            };
          },
        },
      ]),
    ).toThrow();
    const rows = fixture.store.database
      .prepare(
        "SELECT id, doc, schema_version FROM documents WHERE collection = 'fixtures' ORDER BY id",
      )
      .all() as Array<{ id: string; doc: string; schema_version: number }>;
    expect(rows).toEqual(
      originals.map((document) => ({
        id: document.id,
        doc: JSON.stringify(document),
        schema_version: 0,
      })),
    );
  });

  it("keeps a committed document after an ungraceful worker SIGKILL", async () => {
    const directory = await temporaryDirectory("hekayati-crash-");
    cleanups.push(directory.cleanup);
    const database = join(directory.path, "crash.db");
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "tests/fixtures/write-and-crash.ts", database],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(child.signal).toBe("SIGKILL");

    const store = new DocumentStore(database);
    const schema = fixtureSchema
      .omit({ familyId: true })
      .extend({ value: z.string() });
    const repository = new DocumentRepository(store, "crash_fixture", schema);
    expect(repository.get("durable")?.value).toBe("committed-before-kill");
    store.close();
  });

  it("creates private data directories and database files", async () => {
    const fixture = await databaseFixture();
    expect((await stat(fixture.paths.root)).mode & 0o777).toBe(0o700);
    expect((await stat(fixture.paths.assets)).mode & 0o777).toBe(0o700);
    expect((await stat(fixture.paths.database)).mode & 0o777).toBe(0o600);
  });
});

async function databaseFixture() {
  const directory = await temporaryDirectory();
  cleanups.push(directory.cleanup);
  const paths = resolveDataPaths(join(directory.path, "data"));
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  return { paths, store };
}

function makeDocument(id: string, familyId: string): Fixture {
  const now = new Date().toISOString();
  return {
    id,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    familyId,
    value: `value-${id}`,
  };
}

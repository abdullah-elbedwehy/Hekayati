import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ulid } from "ulid";

import { CreativeRepository } from "../../src/domain/creative/repositories.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-14T00:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

const testDocumentSchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    ownerId: z.string().min(1),
    value: z.string().min(1),
  })
  .strict();

type TestDocument = z.infer<typeof testDocumentSchema>;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("creative repository strict write behavior", () => {
  it("rejects duplicate, missing-update, and malformed documents", async () => {
    const fixture = await repositoryFixture("creative_repository_edges");
    const document = testDocument();

    expect(fixture.repository.insert(document)).toEqual(document);
    expect(() => fixture.repository.insert(document)).toThrowError(
      expect.objectContaining({
        code: "CREATIVE_DUPLICATE_ENTITY",
        statusCode: 409,
      }),
    );
    expect(() =>
      fixture.repository.update({ ...document, id: ulid() }),
    ).toThrowError(
      expect.objectContaining({
        code: "CREATIVE_ENTITY_NOT_FOUND",
        statusCode: 404,
      }),
    );
    expect(() =>
      fixture.repository.insert({
        ...testDocument(),
        value: "",
      }),
    ).toThrow();
    fixture.close();
  });

  it("normalizes a database uniqueness constraint to the domain error", async () => {
    const fixture = await repositoryFixture("creative_constraint_edges");
    fixture.store.database.exec(`
      CREATE TRIGGER creative_constraint_edges_insert
      BEFORE INSERT ON documents
      WHEN NEW.collection = 'creative_constraint_edges'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic constraint');
      END;
    `);

    expect(() => fixture.repository.insert(testDocument())).toThrowError(
      expect.objectContaining({
        code: "CREATIVE_DUPLICATE_ENTITY",
        statusCode: 409,
      }),
    );
    expect(fixture.repository.list()).toEqual([]);
    fixture.close();
  });

  it("rethrows a non-constraint database failure unchanged", async () => {
    const fixture = await repositoryFixture("creative_runtime_edges");
    fixture.store.database.exec(`
      CREATE TRIGGER creative_runtime_edges_insert
      BEFORE INSERT ON documents
      WHEN NEW.collection = 'creative_runtime_edges'
      BEGIN
        SELECT creative_missing_sql_function();
      END;
    `);

    expect(() => fixture.repository.insert(testDocument())).toThrowError(
      /creative_missing_sql_function|no such function/i,
    );
    expect(fixture.repository.list()).toEqual([]);
    fixture.close();
  });
});

async function repositoryFixture(collection: string) {
  const temp = await temporaryDirectory("hekayati-creative-repository-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "creative.db"));
  return {
    store,
    repository: new CreativeRepository(store, collection, testDocumentSchema),
    close: () => store.close(),
  };
}

function testDocument(): TestDocument {
  return {
    id: ulid(),
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    ownerId: ulid(),
    value: "synthetic",
  };
}

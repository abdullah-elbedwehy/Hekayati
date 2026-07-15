import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { projectSchema } from "../../src/domain/authoring/schemas.js";
import { pageSchema } from "../../src/domain/creative/schemas.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import {
  initializeLayoutPersistence,
  type LayoutMigrationResult,
} from "../../src/domain/layout/migrations.js";
import {
  A4_COMPOSITION_PROFILE,
  A4_COMPOSITION_PROFILE_ID,
} from "../../src/domain/layout/policy.js";
import {
  compositionProfileSchema,
  pageLayoutHeadSchema,
} from "../../src/domain/layout/schemas.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-14T00:00:00.000Z";
const ids = Array.from(
  { length: 20 },
  (_, index) => `01J${String(index + 1).padStart(23, "0")}`,
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("layout persistence migration", () => {
  it("atomically migrates Project/Page and preserves a legacy layout pointer", async () => {
    const fixture = await database();
    insertRaw(fixture.store, "projects", legacyProject(), 1);
    insertRaw(fixture.store, "pages", legacyPage(ids[8]), 1);

    expect(initializeLayoutPersistence(fixture.store)).toEqual({
      projectsMigrated: 1,
      pagesMigrated: 1,
      layoutHeadsMigrated: 1,
      compositionProfileSeeded: true,
    } satisfies LayoutMigrationResult);

    const project = read(fixture.store, "projects", ids[0]);
    expect(projectSchema.parse(project)).toMatchObject({
      schemaVersion: 2,
      revision: 0,
      compositionProfileId: A4_COMPOSITION_PROFILE_ID,
      currentCoverCompositionVersionId: null,
      currentPreviewOutputId: null,
      currentPreviewCycleId: null,
      currentContentApprovalId: null,
      printerProfileId: ids[7],
      updatedAt: at,
    });
    expect(
      pageSchema.parse(read(fixture.store, "pages", ids[4])),
    ).toMatchObject({
      schemaVersion: 2,
      revision: 9,
      locked: true,
      reviewStatus: "approved",
    });
    expect(
      pageLayoutHeadSchema.parse(
        read(fixture.store, "page_layout_heads", ids[4]),
      ),
    ).toMatchObject({
      id: ids[4],
      pageId: ids[4],
      currentLayoutVersionId: ids[8],
      revision: 0,
    });
    expect(
      compositionProfileSchema.parse(
        read(fixture.store, "composition_profiles", A4_COMPOSITION_PROFILE_ID),
      ),
    ).toMatchObject(A4_COMPOSITION_PROFILE);

    expect(initializeLayoutPersistence(fixture.store)).toEqual({
      projectsMigrated: 0,
      pagesMigrated: 0,
      layoutHeadsMigrated: 0,
      compositionProfileSeeded: false,
    });
    fixture.store.close();
    const reopened = new DocumentStore(fixture.path);
    expect(initializeLayoutPersistence(reopened).projectsMigrated).toBe(0);
    reopened.close();
  });

  it("rolls back both document migrations and the head when A4 verification fails late", async () => {
    const fixture = await database();
    insertRaw(fixture.store, "projects", legacyProject(), 1);
    insertRaw(fixture.store, "pages", legacyPage(ids[8]), 1);
    insertRaw(
      fixture.store,
      "composition_profiles",
      {
        ...A4_COMPOSITION_PROFILE,
        hash: "f".repeat(64),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
      },
      1,
    );

    expect(() => initializeLayoutPersistence(fixture.store)).toThrow(
      "LAYOUT_PROFILE_MISMATCH",
    );
    expect(version(fixture.store, "projects", ids[0])).toBe(1);
    expect(version(fixture.store, "pages", ids[4])).toBe(1);
    expect(readOptional(fixture.store, "page_layout_heads", ids[4])).toBeNull();
    fixture.store.close();
  });

  it("rejects a partial legacy head without mutating either source document", async () => {
    const fixture = await database();
    insertRaw(fixture.store, "projects", legacyProject(), 1);
    insertRaw(fixture.store, "pages", legacyPage(ids[8]), 1);
    insertRaw(
      fixture.store,
      "page_layout_heads",
      {
        id: ids[4],
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        revision: 0,
        pageId: ids[4],
        currentLayoutVersionId: ids[9],
      },
      1,
    );

    expect(() => initializeLayoutPersistence(fixture.store)).toThrow(
      "LAYOUT_MIGRATION_CONFLICT",
    );
    expect(version(fixture.store, "projects", ids[0])).toBe(1);
    expect(version(fixture.store, "pages", ids[4])).toBe(1);
    fixture.store.close();
  });
});

async function database() {
  const temp = await temporaryDirectory("hekayati-layout-migration-");
  cleanups.push(temp.cleanup);
  const path = join(temp.path, "layout.db");
  return { path, store: new DocumentStore(path) };
}

function legacyProject() {
  return {
    id: ids[0],
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    customerId: ids[1],
    familyId: ids[2],
    status: "internal_review",
    priority: 7,
    paused: true,
    currentVersionId: ids[3],
    bookVersion: 11,
    printerProfileId: ids[7],
  };
}

function legacyPage(layoutVersionId: string | null) {
  return {
    id: ids[4],
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    revision: 9,
    projectId: ids[0],
    pageNumber: 3,
    storyPageIndex: 1,
    kind: "story",
    locked: true,
    reviewStatus: "approved",
    staleState: "current",
    staleReasons: [],
    currentTextVersionId: ids[5],
    currentPromptVersionId: ids[6],
    currentIllustrationVersionId: ids[7],
    currentLayoutVersionId: layoutVersionId,
  };
}

function insertRaw(
  store: DocumentStore,
  collection: string,
  document: {
    id: string;
    createdAt: string;
    updatedAt: string;
    [key: string]: unknown;
  },
  schemaVersion: number,
): void {
  store.database
    .prepare(
      `INSERT INTO documents(collection, id, doc, schema_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      collection,
      document.id,
      JSON.stringify(document),
      schemaVersion,
      document.createdAt,
      document.updatedAt,
    );
}

function read(store: DocumentStore, collection: string, id: string): unknown {
  const row = store.database
    .prepare("SELECT doc FROM documents WHERE collection = ? AND id = ?")
    .get(collection, id) as { doc: string } | undefined;
  if (!row) throw new Error("TEST_DOCUMENT_MISSING");
  return JSON.parse(row.doc);
}

function readOptional(
  store: DocumentStore,
  collection: string,
  id: string,
): unknown {
  const row = store.database
    .prepare("SELECT doc FROM documents WHERE collection = ? AND id = ?")
    .get(collection, id) as { doc: string } | undefined;
  return row ? JSON.parse(row.doc) : null;
}

function version(store: DocumentStore, collection: string, id: string): number {
  const row = store.database
    .prepare(
      "SELECT schema_version FROM documents WHERE collection = ? AND id = ?",
    )
    .get(collection, id) as { schema_version: number };
  return row.schema_version;
}

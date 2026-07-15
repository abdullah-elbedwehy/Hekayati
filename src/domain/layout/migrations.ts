import { canonicalJson } from "../../contracts/canonical-json.js";
import { projectSchema, projectV1Schema } from "../authoring/schemas.js";
import { pageSchema, pageV1Schema, type PageV1 } from "../creative/schemas.js";
import {
  DocumentRepository,
  type DocumentStore,
} from "../repository/document-store.js";
import { failLayout } from "./errors.js";
import { A4_COMPOSITION_PROFILE, A4_COMPOSITION_PROFILE_ID } from "./policy.js";
import {
  compositionProfileSchema,
  pageLayoutHeadSchema,
  type CompositionProfile,
} from "./schemas.js";

const PROJECTS = "projects";
const PAGES = "pages";
const PROFILES = "composition_profiles";
const PAGE_LAYOUT_HEADS = "page_layout_heads";
const PROFILE_SEED_AT = "2026-07-15T00:00:00.000Z";

interface StoredDocumentRow {
  doc: string;
}

interface LegacyPagePointer {
  page: PageV1;
  layoutVersionId: string | null;
}

export interface LayoutMigrationResult {
  projectsMigrated: number;
  pagesMigrated: number;
  layoutHeadsMigrated: number;
  compositionProfileSeeded: boolean;
}

/**
 * Runs the Project/Page migration, legacy-pointer extraction, and A4 seed in
 * one SQLite transaction. Re-entry after success is a verified no-op.
 */
export function initializeLayoutPersistence(
  store: DocumentStore,
): LayoutMigrationResult {
  return store.transaction(() => {
    const legacyPages = readLegacyPages(store);
    rejectPartialPageMigration(store, legacyPages);
    const projectsMigrated = store.migrateDocuments(
      PROJECTS,
      2,
      projectSchema,
      [{ from: 1, to: 2, migrate: migrateProjectV1ToV2 }],
    );
    const pagesMigrated = store.migrateDocuments(PAGES, 2, pageSchema, [
      { from: 1, to: 2, migrate: migratePageV1ToV2 },
    ]);
    const layoutHeadsMigrated = insertLegacyLayoutHeads(store, legacyPages);
    const compositionProfileSeeded = seedOrVerifyA4Profile(store);
    createLayoutIndexes(store);
    return {
      projectsMigrated,
      pagesMigrated,
      layoutHeadsMigrated,
      compositionProfileSeeded,
    };
  });
}

export function migrateProjectV1ToV2(input: unknown) {
  const legacy = projectV1Schema.parse(input);
  return projectSchema.parse({
    ...legacy,
    schemaVersion: 2,
    revision: 0,
    compositionProfileId: A4_COMPOSITION_PROFILE_ID,
    currentCoverCompositionVersionId: null,
    currentPreviewOutputId: null,
    currentPreviewCycleId: null,
    currentContentApprovalId: null,
  });
}

export function migratePageV1ToV2(input: unknown) {
  const legacy = pageV1Schema.parse(input);
  const migrated = { ...legacy } as Record<string, unknown>;
  delete migrated.currentLayoutVersionId;
  migrated.schemaVersion = 2;
  return pageSchema.parse(migrated);
}

function readLegacyPages(store: DocumentStore): LegacyPagePointer[] {
  const rows = store.database
    .prepare(
      `SELECT doc FROM documents
       WHERE collection = ? AND schema_version = 1
       ORDER BY id`,
    )
    .all(PAGES) as StoredDocumentRow[];
  return rows.map((row) => {
    const page = pageV1Schema.parse(JSON.parse(row.doc));
    return { page, layoutVersionId: page.currentLayoutVersionId };
  });
}

function rejectPartialPageMigration(
  store: DocumentStore,
  legacyPages: readonly LegacyPagePointer[],
): void {
  if (legacyPages.length === 0) return;
  const get = store.database.prepare(
    "SELECT 1 FROM documents WHERE collection = ? AND id = ?",
  );
  for (const { page } of legacyPages) {
    if (get.get(PAGE_LAYOUT_HEADS, page.id))
      failLayout("LAYOUT_MIGRATION_CONFLICT");
  }
}

function insertLegacyLayoutHeads(
  store: DocumentStore,
  legacyPages: readonly LegacyPagePointer[],
): number {
  const insert = store.database.prepare(
    `INSERT INTO documents(collection, id, doc, schema_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  for (const { page, layoutVersionId } of legacyPages) {
    if (!layoutVersionId) continue;
    const head = pageLayoutHeadSchema.parse({
      id: page.id,
      schemaVersion: 1,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      revision: 0,
      pageId: page.id,
      currentLayoutVersionId: layoutVersionId,
    });
    store.assertSafeForPersistence(head);
    insert.run(
      PAGE_LAYOUT_HEADS,
      head.id,
      JSON.stringify(head),
      head.schemaVersion,
      head.createdAt,
      head.updatedAt,
    );
    inserted += 1;
  }
  return inserted;
}

function seedOrVerifyA4Profile(store: DocumentStore): boolean {
  const repository = new DocumentRepository<CompositionProfile>(
    store,
    PROFILES,
    compositionProfileSchema,
  );
  const existing = repository.get(A4_COMPOSITION_PROFILE_ID);
  if (existing) {
    if (
      existing.hash !== A4_COMPOSITION_PROFILE.hash ||
      canonicalJson(profileContent(existing)) !==
        canonicalJson(A4_COMPOSITION_PROFILE)
    )
      failLayout("LAYOUT_PROFILE_MISMATCH");
    return false;
  }
  repository.put(
    compositionProfileSchema.parse({
      ...A4_COMPOSITION_PROFILE,
      schemaVersion: 1,
      createdAt: PROFILE_SEED_AT,
      updatedAt: PROFILE_SEED_AT,
    }),
  );
  return true;
}

function profileContent(profile: CompositionProfile) {
  return {
    id: profile.id,
    version: profile.version,
    trimWidthMm: profile.trimWidthMm,
    trimHeightMm: profile.trimHeightMm,
    dimensionToleranceMm: profile.dimensionToleranceMm,
    safeContentRegion: profile.safeContentRegion,
    placementRegions: profile.placementRegions,
    typographyScale: profile.typographyScale,
    hash: profile.hash,
  };
}

function createLayoutIndexes(store: DocumentStore): void {
  store.database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS layout_page_head_page_unique
      ON documents(json_extract(doc, '$.pageId'))
      WHERE collection = 'page_layout_heads';
    CREATE UNIQUE INDEX IF NOT EXISTS layout_cover_project_unique
      ON documents(json_extract(doc, '$.projectId'))
      WHERE collection = 'cover_compositions';
    CREATE UNIQUE INDEX IF NOT EXISTS layout_workflow_project_unique
      ON documents(json_extract(doc, '$.projectId'))
      WHERE collection = 'preview_workflows';
    CREATE UNIQUE INDEX IF NOT EXISTS layout_approval_action_key_unique
      ON documents(
        json_extract(doc, '$.cycleId'),
        json_extract(doc, '$.idempotencyKey')
      ) WHERE collection = 'book_approval_actions';
  `);
}

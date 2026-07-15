import type { ZodType } from "zod";

import { canonicalJson } from "../../contracts/canonical-json.js";
import {
  DocumentRepository,
  type BaseDocument,
  type DocumentStore,
} from "../repository/document-store.js";
import { failLayout } from "./errors.js";
import {
  bookApprovalActionSchema,
  bookApprovalCycleSchema,
  compositionProfileSchema,
  coverCompositionSchema,
  coverCompositionVersionSchema,
  layoutVersionSchema,
  pageLayoutHeadSchema,
  previewOutputSchema,
  previewWorkflowSchema,
  type BookApprovalAction,
  type BookApprovalCycle,
  type CompositionProfile,
  type CoverComposition,
  type CoverCompositionVersion,
  type LayoutVersion,
  type PageLayoutHead,
  type PreviewOutput,
  type PreviewWorkflow,
} from "./schemas.js";

export const layoutCollections = {
  compositionProfiles: "composition_profiles",
  pageLayoutHeads: "page_layout_heads",
  layoutVersions: "layout_versions",
  coverCompositions: "cover_compositions",
  coverCompositionVersions: "cover_composition_versions",
  previewWorkflows: "preview_workflows",
  previewOutputs: "preview_outputs",
  bookApprovalCycles: "book_approval_cycles",
  bookApprovalActions: "book_approval_actions",
} as const;

export class ImmutableLayoutRepository<T extends BaseDocument> {
  private readonly documents: DocumentRepository<T>;

  constructor(
    protected readonly store: DocumentStore,
    readonly collection: string,
    protected readonly schema: ZodType<T>,
  ) {
    this.documents = new DocumentRepository(store, collection, schema);
  }

  get(id: string): T | null {
    return this.documents.get(id);
  }

  list(): T[] {
    return this.documents.list();
  }

  queryByField(field: string, value: string | number | boolean): T[] {
    return this.documents.queryByField(field, value);
  }

  insert(document: T): T {
    const parsed = this.schema.parse(document);
    if (this.get(parsed.id)) failLayout("LAYOUT_DUPLICATE_ENTITY");
    this.store.assertSafeForPersistence(parsed);
    try {
      this.store.database
        .prepare(
          `INSERT INTO documents(collection, id, doc, schema_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.collection,
          parsed.id,
          JSON.stringify(parsed),
          parsed.schemaVersion,
          parsed.createdAt,
          parsed.updatedAt,
        );
    } catch (error) {
      if (constraintFailure(error)) failLayout("LAYOUT_DUPLICATE_ENTITY");
      throw error;
    }
    return parsed;
  }
}

export class RevisionedLayoutRepository<
  T extends BaseDocument & { revision: number },
> extends ImmutableLayoutRepository<T> {
  constructor(
    store: DocumentStore,
    collection: string,
    schema: ZodType<T>,
    private readonly immutableFields: readonly (keyof T)[],
  ) {
    super(store, collection, schema);
  }

  update(expectedRevision: number, document: T): T {
    const next = this.schema.parse(document);
    const current = this.get(next.id);
    if (!current) failLayout("LAYOUT_ENTITY_NOT_FOUND", 404);
    if (current.revision !== expectedRevision)
      failLayout("LAYOUT_REVISION_CONFLICT");
    if (next.revision !== expectedRevision + 1)
      failLayout("LAYOUT_REVISION_INVALID");
    for (const field of this.immutableFields) {
      if (canonicalJson(current[field]) !== canonicalJson(next[field]))
        failLayout("LAYOUT_IMMUTABLE_FIELD_CHANGED");
    }
    this.store.assertSafeForPersistence(next);
    const result = this.store.database
      .prepare(
        `UPDATE documents
         SET doc = ?, schema_version = ?, updated_at = ?
         WHERE collection = ? AND id = ?
           AND json_extract(doc, '$.revision') = ?`,
      )
      .run(
        JSON.stringify(next),
        next.schemaVersion,
        next.updatedAt,
        this.collection,
        next.id,
        expectedRevision,
      );
    if (result.changes !== 1) failLayout("LAYOUT_REVISION_CONFLICT");
    return next;
  }
}

export class LayoutRepositories {
  readonly compositionProfiles: ImmutableLayoutRepository<CompositionProfile>;
  readonly pageLayoutHeads: RevisionedLayoutRepository<PageLayoutHead>;
  readonly layoutVersions: ImmutableLayoutRepository<LayoutVersion>;
  readonly coverCompositions: RevisionedLayoutRepository<CoverComposition>;
  readonly coverCompositionVersions: ImmutableLayoutRepository<CoverCompositionVersion>;
  readonly previewWorkflows: RevisionedLayoutRepository<PreviewWorkflow>;
  readonly previewOutputs: RevisionedLayoutRepository<PreviewOutput>;
  readonly bookApprovalCycles: RevisionedLayoutRepository<BookApprovalCycle>;
  readonly bookApprovalActions: ImmutableLayoutRepository<BookApprovalAction>;

  constructor(store: DocumentStore) {
    this.compositionProfiles = immutable(
      store,
      layoutCollections.compositionProfiles,
      compositionProfileSchema,
    );
    this.pageLayoutHeads = revisioned(
      store,
      layoutCollections.pageLayoutHeads,
      pageLayoutHeadSchema,
      ["id", "schemaVersion", "createdAt", "pageId"],
    );
    this.layoutVersions = immutable(
      store,
      layoutCollections.layoutVersions,
      layoutVersionSchema,
    );
    this.coverCompositions = revisioned(
      store,
      layoutCollections.coverCompositions,
      coverCompositionSchema,
      ["id", "schemaVersion", "createdAt", "projectId"],
    );
    this.coverCompositionVersions = immutable(
      store,
      layoutCollections.coverCompositionVersions,
      coverCompositionVersionSchema,
    );
    this.previewWorkflows = revisioned(
      store,
      layoutCollections.previewWorkflows,
      previewWorkflowSchema,
      ["id", "schemaVersion", "createdAt", "projectId"],
    );
    this.previewOutputs = revisioned(
      store,
      layoutCollections.previewOutputs,
      previewOutputSchema,
      previewOutputImmutableFields,
    );
    this.bookApprovalCycles = revisioned(
      store,
      layoutCollections.bookApprovalCycles,
      bookApprovalCycleSchema,
      approvalCycleImmutableFields,
    );
    this.bookApprovalActions = approvalActions(store);
  }
}

function approvalActions(store: DocumentStore) {
  return immutable(
    store,
    layoutCollections.bookApprovalActions,
    bookApprovalActionSchema,
  );
}

const previewOutputImmutableFields = [
  "id",
  "schemaVersion",
  "createdAt",
  "projectId",
  "assetId",
  "jobId",
  "approvalCycleId",
  "approvalGateJobId",
  "bookVersion",
  "projectVersionId",
  "compositionProfileId",
  "compositionProfileHash",
  "coverCompositionVersionId",
  "customerContentHash",
  "orderedInteriorPages",
  "approvalBundleHash",
  "pageMapHash",
  "previewSnapshotHash",
  "watermarkSettingsHash",
  "previewDerivativePolicyHash",
  "typographySettingsHash",
  "fontManifestHash",
  "rendererVersion",
  "validationReport",
] as const satisfies readonly (keyof PreviewOutput)[];

const approvalCycleImmutableFields = [
  "id",
  "schemaVersion",
  "createdAt",
  "projectId",
  "previewOutputId",
  "approvalGateJobId",
  "targetBookVersion",
  "customerContentHash",
  "approvalBundleHash",
  "pageMapHash",
  "previewSnapshotHash",
  "coverCompositionVersionId",
  "watermarkSettingsHash",
] as const satisfies readonly (keyof BookApprovalCycle)[];

function immutable<T extends BaseDocument>(
  store: DocumentStore,
  collection: string,
  schema: ZodType<T>,
): ImmutableLayoutRepository<T> {
  return new ImmutableLayoutRepository(store, collection, schema);
}

function revisioned<T extends BaseDocument & { revision: number }>(
  store: DocumentStore,
  collection: string,
  schema: ZodType<T>,
  immutableFields: readonly (keyof T)[],
): RevisionedLayoutRepository<T> {
  return new RevisionedLayoutRepository(
    store,
    collection,
    schema,
    immutableFields,
  );
}

function constraintFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

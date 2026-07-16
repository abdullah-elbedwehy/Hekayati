import type { ZodType } from "zod";

import { canonicalJson } from "../../contracts/canonical-json.js";
import {
  DocumentRepository,
  type BaseDocument,
  type DocumentStore,
} from "../repository/document-store.js";
import { failPrint } from "./errors.js";
import {
  convertedProofActionSchema,
  printerProfileSchema,
  printerProfileVersionSchema,
  printArtifactSchema,
  printPreflightReportSchema,
  printProofBundleSchema,
  printRunSchema,
  type ConvertedProofAction,
  type PrinterProfile,
  type PrinterProfileVersion,
  type PrintArtifact,
  type PrintPreflightReport,
  type PrintProofBundle,
  type PrintRun,
} from "./schemas.js";

export const printCollections = {
  profiles: "printer_profiles",
  profileVersions: "printer_profile_versions",
  runs: "print_runs",
  artifacts: "print_artifacts",
  preflightReports: "print_preflight_reports",
  proofActions: "converted_proof_actions",
  proofBundles: "print_proof_bundles",
} as const;

export class ImmutablePrintRepository<T extends BaseDocument> {
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
    if (this.get(parsed.id)) failPrint("PRINT_DUPLICATE_ENTITY");
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
      if (constraintFailure(error)) failPrint("PRINT_DUPLICATE_ENTITY");
      throw error;
    }
    return parsed;
  }
}

export class RevisionedPrintRepository<
  T extends BaseDocument & { revision: number },
> extends ImmutablePrintRepository<T> {
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
    if (!current) failPrint("PRINT_ENTITY_NOT_FOUND");
    if (current.revision !== expectedRevision)
      failPrint("PRINT_REVISION_CONFLICT");
    if (next.revision !== expectedRevision + 1)
      failPrint("PRINT_REVISION_INVALID");
    for (const field of this.immutableFields) {
      if (canonicalJson(current[field]) !== canonicalJson(next[field]))
        failPrint("PRINT_IMMUTABLE_FIELD_CHANGED");
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
    if (result.changes !== 1) failPrint("PRINT_REVISION_CONFLICT");
    return next;
  }
}

export class PrintRepositories {
  readonly profiles: RevisionedPrintRepository<PrinterProfile>;
  readonly profileVersions: ImmutablePrintRepository<PrinterProfileVersion>;
  readonly runs: RevisionedPrintRepository<PrintRun>;
  readonly artifacts: ImmutablePrintRepository<PrintArtifact>;
  readonly preflightReports: ImmutablePrintRepository<PrintPreflightReport>;
  readonly proofActions: ImmutablePrintRepository<ConvertedProofAction>;
  readonly proofBundles: ImmutablePrintRepository<PrintProofBundle>;

  constructor(store: DocumentStore) {
    const repositories = buildRepositories(store);
    this.profiles = repositories.profiles;
    this.profileVersions = repositories.profileVersions;
    this.runs = repositories.runs;
    this.artifacts = repositories.artifacts;
    this.preflightReports = repositories.preflightReports;
    this.proofActions = repositories.proofActions;
    this.proofBundles = repositories.proofBundles;
  }
}

const immutableRunFields: readonly (keyof PrintRun)[] = [
  "id",
  "schemaVersion",
  "createdAt",
  "projectId",
  "familyId",
  "customerId",
  "requestHash",
  "idempotencyKey",
  "contentAuthorizationHash",
  "approvalCycleId",
  "approvalGateJobId",
  "previewOutputId",
  "customerContentHash",
  "compositionProfileId",
  "compositionProfileHash",
  "printerProfileId",
  "printerProfileVersionId",
  "printerProfileHash",
  "sourceSnapshotHash",
  "sourceAssets",
  "interiorJobId",
  "coverJobId",
];

function buildRepositories(store: DocumentStore) {
  return {
    profiles: revisioned(
      store,
      printCollections.profiles,
      printerProfileSchema,
      ["id", "schemaVersion", "createdAt"],
    ),
    profileVersions: immutable(
      store,
      printCollections.profileVersions,
      printerProfileVersionSchema,
    ),
    runs: revisioned(
      store,
      printCollections.runs,
      printRunSchema,
      immutableRunFields,
    ),
    artifacts: immutable(
      store,
      printCollections.artifacts,
      printArtifactSchema,
    ),
    preflightReports: immutable(
      store,
      printCollections.preflightReports,
      printPreflightReportSchema,
    ),
    proofActions: immutable(
      store,
      printCollections.proofActions,
      convertedProofActionSchema,
    ),
    proofBundles: immutable(
      store,
      printCollections.proofBundles,
      printProofBundleSchema,
    ),
  };
}

function immutable<T extends BaseDocument>(
  store: DocumentStore,
  collection: string,
  schema: ZodType<T>,
): ImmutablePrintRepository<T> {
  return new ImmutablePrintRepository(store, collection, schema);
}

function revisioned<T extends BaseDocument & { revision: number }>(
  store: DocumentStore,
  collection: string,
  schema: ZodType<T>,
  immutableFields: readonly (keyof T)[],
): RevisionedPrintRepository<T> {
  return new RevisionedPrintRepository(
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

import type { ZodType } from "zod";

import { canonicalJson } from "../../contracts/canonical-json.js";
import {
  DocumentRepository,
  type BaseDocument,
  type DocumentStore,
} from "../repository/document-store.js";
import {
  domainMutationAdmission,
  type DomainMutationWriterKey,
  type OperationOwnedMutationContext,
} from "../portability/domain-mutation-admission.js";
import { printCollections } from "./collections.js";
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

export { printCollections } from "./collections.js";

export class ImmutablePrintRepository<T extends BaseDocument> {
  private readonly documents: DocumentRepository<T>;

  constructor(
    protected readonly store: DocumentStore,
    readonly collection: string,
    protected readonly schema: ZodType<T>,
    private readonly writer: DomainMutationWriterKey = "print.immutable-document",
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

  insert(document: T, operation?: OperationOwnedMutationContext): T {
    return this.store.transaction(() => {
      const parsed = this.schema.parse(document);
      if (this.get(parsed.id)) failPrint("PRINT_DUPLICATE_ENTITY");
      this.store.assertSafeForPersistence(parsed);
      this.assertMutation("insert", null, parsed, operation);
      try {
        this.insertDocument(parsed);
      } catch (error) {
        if (constraintFailure(error)) failPrint("PRINT_DUPLICATE_ENTITY");
        throw error;
      }
      return parsed;
    });
  }

  delete(id: string, operation?: OperationOwnedMutationContext): boolean {
    return this.store.transaction(() => {
      const current = this.get(id);
      if (!current) return false;
      this.assertMutation("delete", current, null, operation);
      return this.documents.delete(id);
    });
  }

  private insertDocument(document: T): void {
    this.store.database
      .prepare(
        `INSERT INTO documents(collection, id, doc, schema_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.collection,
        document.id,
        JSON.stringify(document),
        document.schemaVersion,
        document.createdAt,
        document.updatedAt,
      );
  }

  protected assertMutation(
    mutation: "insert" | "update" | "delete",
    before: T | null,
    after: T | null,
    operation?: OperationOwnedMutationContext,
  ): void {
    const admission = domainMutationAdmission(this.store);
    admission.assertInTransaction({
      writer: this.writer,
      collection: this.collection,
      mutation,
      before,
      after,
      operation,
    });
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
    super(store, collection, schema, "print.revisioned-document");
  }

  update(
    expectedRevision: number,
    document: T,
    operation?: OperationOwnedMutationContext,
  ): T {
    return this.store.transaction(() => {
      const next = this.schema.parse(document);
      const current = this.get(next.id);
      if (!current) failPrint("PRINT_ENTITY_NOT_FOUND");
      assertRevisionedPrint(
        current,
        next,
        expectedRevision,
        this.immutableFields,
      );
      this.store.assertSafeForPersistence(next);
      this.assertMutation("update", current, next, operation);
      const result = this.updateDocument(expectedRevision, next);
      if (result.changes !== 1) failPrint("PRINT_REVISION_CONFLICT");
      return next;
    });
  }

  private updateDocument(expectedRevision: number, next: T) {
    return this.store.database
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
  }
}

function assertRevisionedPrint<T extends BaseDocument & { revision: number }>(
  current: T,
  next: T,
  expectedRevision: number,
  immutableFields: readonly (keyof T)[],
): void {
  if (current.revision !== expectedRevision)
    failPrint("PRINT_REVISION_CONFLICT");
  if (next.revision !== expectedRevision + 1)
    failPrint("PRINT_REVISION_INVALID");
  for (const field of immutableFields) {
    if (canonicalJson(current[field]) !== canonicalJson(next[field]))
      failPrint("PRINT_IMMUTABLE_FIELD_CHANGED");
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

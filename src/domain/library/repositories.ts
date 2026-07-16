import type { ZodType } from "zod";

import {
  DocumentRepository,
  type BaseDocument,
  type DocumentStore,
} from "../repository/document-store.js";
import {
  domainMutationAdmission,
  type OperationOwnedMutationContext,
} from "../portability/domain-mutation-admission.js";
import { libraryCollections } from "./collections.js";
import { fail, type LibraryErrorCode } from "./errors.js";
import {
  changeEventSchema,
  characterSchema,
  characterVersionSchema,
  customerSchema,
  familySchema,
  invalidationReceiptSchema,
  lookSchema,
  lookVersionSchema,
  originalAssetRecordSchema,
  referencePhotoSchema,
  type ChangeEvent,
  type Character,
  type CharacterVersion,
  type Customer,
  type Family,
  type InvalidationReceipt,
  type Look,
  type LookVersion,
  type OriginalAssetRecord,
  type ReferencePhoto,
} from "./schemas.js";

export { libraryCollections } from "./collections.js";

export class StrictDocumentRepository<T extends BaseDocument> {
  private readonly documents: DocumentRepository<T>;

  constructor(
    private readonly store: DocumentStore,
    readonly collection: string,
    private readonly schema: ZodType<T>,
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

  insert(
    document: T,
    duplicateCode: LibraryErrorCode,
    operation?: OperationOwnedMutationContext,
  ): T {
    return this.store.transaction(() => {
      const parsed = this.schema.parse(document);
      this.store.assertSafeForPersistence(parsed);
      if (this.get(parsed.id)) fail(duplicateCode);
      this.assertMutation("insert", null, parsed, operation);
      try {
        this.insertDocument(parsed);
      } catch (error) {
        if (isConstraintFailure(error)) fail(duplicateCode);
        throw error;
      }
      return parsed;
    });
  }

  update(document: T, operation?: OperationOwnedMutationContext): T {
    return this.store.transaction(() => {
      const parsed = this.schema.parse(document);
      const current = this.get(parsed.id);
      if (!current) throw new Error("DOCUMENT_UPDATE_TARGET_MISSING");
      this.assertMutation("update", current, parsed, operation);
      return this.documents.put(parsed);
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

  private assertMutation(
    mutation: "insert" | "update" | "delete",
    before: T | null,
    after: T | null,
    operation?: OperationOwnedMutationContext,
  ): void {
    const admission = domainMutationAdmission(this.store);
    admission.assertInTransaction({
      writer: "library.document",
      collection: this.collection,
      mutation,
      before,
      after,
      operation,
    });
  }
}

export class LibraryRepositories {
  readonly customers: StrictDocumentRepository<Customer>;
  readonly families: StrictDocumentRepository<Family>;
  readonly characters: StrictDocumentRepository<Character>;
  readonly characterVersions: StrictDocumentRepository<CharacterVersion>;
  readonly looks: StrictDocumentRepository<Look>;
  readonly lookVersions: StrictDocumentRepository<LookVersion>;
  readonly referencePhotos: StrictDocumentRepository<ReferencePhoto>;
  readonly originalAssets: StrictDocumentRepository<OriginalAssetRecord>;
  readonly changeEvents: StrictDocumentRepository<ChangeEvent>;
  readonly invalidationReceipts: StrictDocumentRepository<InvalidationReceipt>;

  constructor(store: DocumentStore) {
    this.customers = repository(
      store,
      libraryCollections.customers,
      customerSchema,
    );
    this.families = repository(
      store,
      libraryCollections.families,
      familySchema,
    );
    this.characters = repository(
      store,
      libraryCollections.characters,
      characterSchema,
    );
    this.characterVersions = repository(
      store,
      libraryCollections.characterVersions,
      characterVersionSchema,
    );
    this.looks = repository(store, libraryCollections.looks, lookSchema);
    this.lookVersions = repository(
      store,
      libraryCollections.lookVersions,
      lookVersionSchema,
    );
    this.referencePhotos = repository(
      store,
      libraryCollections.referencePhotos,
      referencePhotoSchema,
    );
    this.originalAssets = repository(
      store,
      libraryCollections.originalAssets,
      originalAssetRecordSchema,
    );
    this.changeEvents = repository(
      store,
      libraryCollections.changeEvents,
      changeEventSchema,
    );
    this.invalidationReceipts = repository(
      store,
      libraryCollections.invalidationReceipts,
      invalidationReceiptSchema,
    );
  }
}

function repository<T extends BaseDocument>(
  store: DocumentStore,
  collection: string,
  schema: ZodType<T>,
): StrictDocumentRepository<T> {
  return new StrictDocumentRepository(store, collection, schema);
}

function isConstraintFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

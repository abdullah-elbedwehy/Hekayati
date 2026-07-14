import type { ZodType } from "zod";

import {
  DocumentRepository,
  type BaseDocument,
  type DocumentStore,
} from "../repository/document-store.js";
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

export const libraryCollections = {
  customers: "customers",
  families: "families",
  characters: "characters",
  characterVersions: "character_versions",
  looks: "looks",
  lookVersions: "look_versions",
  referencePhotos: "reference_photos",
  originalAssets: "original_assets",
  changeEvents: "change_events",
  invalidationReceipts: "invalidation_receipts",
} as const;

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

  insert(document: T, duplicateCode: LibraryErrorCode): T {
    const parsed = this.schema.parse(document);
    this.store.assertSafeForPersistence(parsed);
    if (this.get(parsed.id)) fail(duplicateCode);
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
      if (isConstraintFailure(error)) fail(duplicateCode);
      throw error;
    }
    return parsed;
  }

  update(document: T): T {
    if (!this.get(document.id))
      throw new Error("DOCUMENT_UPDATE_TARGET_MISSING");
    return this.documents.put(document);
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

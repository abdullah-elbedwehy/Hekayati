import { ulid } from "ulid";

import { canonicalJson } from "../../contracts/canonical-json.js";
import type { DocumentStore } from "../repository/document-store.js";
import {
  exportOperationSchema,
  managedExportSchema,
  portabilityMediaHoldSchema,
  portabilityMediaInputSchema,
  portabilitySnapshotEntrySchema,
  portabilitySnapshotSchema,
  type ExportOperation,
  type ManagedExport,
  type PortabilityMediaHold,
  type PortabilityMediaInput,
  type PortabilitySnapshot,
  type PortabilitySnapshotEntry,
  type SnapshotDocumentEntry,
  type SnapshotMediaEntry,
} from "./export-model.js";
import {
  allowedExportTransitions,
  allowedSnapshotTransitions,
  assertOperationImmutable,
  assertSnapshotImmutable,
  fail,
  initializeIndexes,
  insertDocument,
  isConstraintFailure,
  managedMatchesOperation,
  managedExportIndexes,
  operationIndexes,
  parseStored,
  readById,
  readCollection,
  rowsForSnapshot,
  sha256Text,
  sha256Value,
  snapshotIndexes,
  type StoredRow,
  updateDocument,
  updateDocumentCas,
  updateRevisionedDocumentCas,
} from "./export-storage-common.js";
import type { PortabilityRegistry } from "./participants.js";
import { assertPortabilityTransaction } from "./repositories.js";

export {
  ExportStorageError,
  type ExportStorageErrorCode,
} from "./export-storage-common.js";

export const portabilityExportCollections = {
  operations: "export_operations",
  snapshots: "portability_snapshots",
  snapshotEntries: "portability_snapshot_entries",
  mediaHolds: "portability_media_holds",
  managedExports: "managed_exports",
} as const;

export interface ExportStorageOptions {
  nowIso?: () => string;
  idFactory?: () => string;
}

export interface SnapshotDocumentInput {
  collection: string;
  document: unknown;
  reasons: readonly string[];
}

export class ExportOperationRepository {
  constructor(private readonly store: DocumentStore) {
    initializeIndexes(store, operationIndexes);
  }

  get(id: string): ExportOperation | null {
    return readById(
      this.store,
      portabilityExportCollections.operations,
      id,
      (value) => exportOperationSchema.parse(value),
    );
  }

  list(): ExportOperation[] {
    return readCollection(
      this.store,
      portabilityExportCollections.operations,
      (value) => exportOperationSchema.parse(value),
    );
  }

  find(projectId: string, idempotencyKey: string): ExportOperation | null {
    const row = this.store.database
      .prepare(
        `SELECT doc FROM documents
         WHERE collection = ?
           AND json_extract(doc, '$.projectId') = ?
           AND json_extract(doc, '$.idempotencyKey') = ?
         LIMIT 1`,
      )
      .get(
        portabilityExportCollections.operations,
        projectId,
        idempotencyKey,
      ) as StoredRow | undefined;
    return row
      ? parseStored(this.store, row.doc, (value) =>
          exportOperationSchema.parse(value),
        )
      : null;
  }

  insertInTransaction(operation: ExportOperation): ExportOperation {
    assertPortabilityTransaction(this.store);
    const parsed = exportOperationSchema.parse(operation);
    const existing = this.find(parsed.projectId, parsed.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== parsed.requestHash)
        fail("PORTABILITY_EXPORT_IDEMPOTENCY_COLLISION");
      return existing;
    }
    if (this.get(parsed.id)) fail("PORTABILITY_EXPORT_ID_CONFLICT");
    insertDocument(this.store, portabilityExportCollections.operations, parsed);
    return parsed;
  }

  updateInTransaction(
    current: ExportOperation,
    next: ExportOperation,
  ): ExportOperation {
    assertPortabilityTransaction(this.store);
    const persisted = this.get(current.id);
    if (!persisted) fail("PORTABILITY_EXPORT_NOT_FOUND");
    if (canonicalJson(persisted) !== canonicalJson(current))
      fail("PORTABILITY_EXPORT_REVISION_CONFLICT");
    const parsed = exportOperationSchema.parse(next);
    assertOperationImmutable(persisted, parsed);
    if (parsed.revision !== persisted.revision + 1)
      fail("PORTABILITY_EXPORT_REVISION_CONFLICT");
    if (!allowedExportTransitions[persisted.state].includes(parsed.state))
      fail("PORTABILITY_EXPORT_STATE_TRANSITION_INVALID");
    updateDocumentCas(
      this.store,
      portabilityExportCollections.operations,
      parsed,
      persisted.revision,
    );
    return parsed;
  }
}

export class PortabilitySnapshotRepository {
  private readonly nowIso: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: DocumentStore,
    private readonly registry: PortabilityRegistry,
    options: ExportStorageOptions = {},
  ) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
    initializeIndexes(store, snapshotIndexes);
  }

  get(id: string): PortabilitySnapshot | null {
    return readById(
      this.store,
      portabilityExportCollections.snapshots,
      id,
      (value) => portabilitySnapshotSchema.parse(value),
    );
  }

  entries(snapshotId: string): PortabilitySnapshotEntry[] {
    const rows = rowsForSnapshot(
      this.store,
      portabilityExportCollections.snapshotEntries,
      snapshotId,
      "ordinal",
    );
    return rows.map((row) => this.parseEntry(row.doc));
  }

  holds(snapshotId: string): PortabilityMediaHold[] {
    return rowsForSnapshot(
      this.store,
      portabilityExportCollections.mediaHolds,
      snapshotId,
      "mediaId",
    ).map((row) =>
      parseStored(this.store, row.doc, (value) =>
        portabilityMediaHoldSchema.parse(value),
      ),
    );
  }

  createInTransaction(snapshot: PortabilitySnapshot): PortabilitySnapshot {
    assertPortabilityTransaction(this.store);
    const parsed = portabilitySnapshotSchema.parse(snapshot);
    if (parsed.participantRegistryHash !== this.registry.hash)
      fail("PORTABILITY_SNAPSHOT_REGISTRY_MISMATCH");
    const existing = this.get(parsed.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(parsed))
        fail("PORTABILITY_SNAPSHOT_CONFLICT");
      return existing;
    }
    try {
      insertDocument(
        this.store,
        portabilityExportCollections.snapshots,
        parsed,
      );
    } catch (error) {
      if (isConstraintFailure(error)) fail("PORTABILITY_SNAPSHOT_CONFLICT");
      throw error;
    }
    return parsed;
  }

  appendDocumentInTransaction(
    snapshotId: string,
    input: SnapshotDocumentInput,
  ): SnapshotDocumentEntry {
    assertPortabilityTransaction(this.store);
    const snapshot = this.requireMutableSnapshot(snapshotId);
    const participant = this.registry.forCollection(input.collection);
    const document = participant.schema.parse(input.document);
    if (document.schemaVersion !== participant.currentSchemaVersion)
      fail("PORTABILITY_SNAPSHOT_SCHEMA_VERSION_MISMATCH");
    const canonicalDocument = canonicalJson(document);
    const bytes = Buffer.byteLength(canonicalDocument, "utf8");
    const row = portabilitySnapshotEntrySchema.parse({
      ...this.entryIdentity(snapshot),
      entryType: "document",
      archiveEntry: `data/${input.collection}/${document.id}.json`,
      collection: input.collection,
      documentId: document.id,
      documentSchemaVersion: document.schemaVersion,
      reasons: uniqueSorted(input.reasons),
      canonicalDocument,
      bytes,
      sha256: sha256Text(canonicalDocument),
    });
    if (row.entryType !== "document") throw new Error("UNREACHABLE");
    this.insertEntry(snapshot, row);
    return row;
  }

  appendMediaInTransaction(
    snapshotId: string,
    input: PortabilityMediaInput,
  ): SnapshotMediaEntry {
    assertPortabilityTransaction(this.store);
    const snapshot = this.requireMutableSnapshot(snapshotId);
    const media = this.parseMedia(input);
    const row = portabilitySnapshotEntrySchema.parse({
      ...this.entryIdentity(snapshot),
      entryType: "media",
      archiveEntry: mediaArchiveEntry(media),
      ...media,
    });
    if (row.entryType !== "media") throw new Error("UNREACHABLE");
    this.insertEntry(snapshot, row);
    this.ensureMediaHoldInTransaction(snapshotId, media);
    return row;
  }

  ensureMediaHoldInTransaction(
    snapshotId: string,
    input: PortabilityMediaInput,
  ): PortabilityMediaHold {
    assertPortabilityTransaction(this.store);
    const snapshot = this.requireSnapshot(snapshotId);
    const media = this.parseMedia(input);
    const entry = this.mediaEntry(snapshotId, media.namespace, media.mediaId);
    if (!entry || !sameMedia(entry, media))
      fail("PORTABILITY_MEDIA_ENTRY_MISSING");
    const existing = this.mediaHold(snapshotId, media.namespace, media.mediaId);
    if (existing) {
      if (
        !sameMedia(existing, media) ||
        existing.operationId !== snapshot.operationId
      )
        fail("PORTABILITY_MEDIA_HOLD_CONFLICT");
      return existing;
    }
    const createdAt = this.nowIso();
    const hold = portabilityMediaHoldSchema.parse({
      id: this.idFactory(),
      schemaVersion: 1,
      createdAt,
      updatedAt: createdAt,
      snapshotId,
      operationId: snapshot.operationId,
      ...media,
      state: "held",
      releasedAt: null,
    });
    insertDocument(this.store, portabilityExportCollections.mediaHolds, hold);
    return hold;
  }

  freezeInTransaction(snapshotId: string): PortabilitySnapshot {
    assertPortabilityTransaction(this.store);
    const snapshot = this.requireSnapshot(snapshotId);
    const entries = this.entries(snapshotId);
    const holds = this.holds(snapshotId);
    const summary = this.validateAndSummarize(snapshot, entries, holds);
    if (snapshot.state === "frozen") {
      if (!snapshotMatches(snapshot, summary))
        fail("PORTABILITY_SNAPSHOT_HASH_MISMATCH");
      return snapshot;
    }
    if (snapshot.state !== "freezing")
      fail("PORTABILITY_SNAPSHOT_STATE_INVALID");
    const frozen = portabilitySnapshotSchema.parse({
      ...snapshot,
      updatedAt: this.nowIso(),
      revision: snapshot.revision + 1,
      state: "frozen",
      ...summary,
    });
    updateDocument(this.store, portabilityExportCollections.snapshots, frozen);
    return frozen;
  }

  transitionInTransaction(
    current: PortabilitySnapshot,
    next: PortabilitySnapshot,
  ): PortabilitySnapshot {
    assertPortabilityTransaction(this.store);
    const persisted = this.requireSnapshot(current.id);
    if (canonicalJson(persisted) !== canonicalJson(current))
      fail("PORTABILITY_SNAPSHOT_CONFLICT");
    const parsed = portabilitySnapshotSchema.parse(next);
    assertSnapshotImmutable(persisted, parsed);
    if (parsed.revision !== persisted.revision + 1)
      fail("PORTABILITY_SNAPSHOT_CONFLICT");
    if (!allowedSnapshotTransitions[persisted.state].includes(parsed.state))
      fail("PORTABILITY_SNAPSHOT_STATE_INVALID");
    if (parsed.state === "staged" || parsed.state === "released")
      this.assertAllHoldsReleased(parsed.id);
    updateRevisionedDocumentCas(
      this.store,
      portabilityExportCollections.snapshots,
      parsed,
      persisted.revision,
      "PORTABILITY_SNAPSHOT_CONFLICT",
    );
    return parsed;
  }

  releaseMediaHoldsInTransaction(
    snapshotId: string,
    release: (hold: Readonly<PortabilityMediaHold>) => unknown,
  ): PortabilityMediaHold[] {
    assertPortabilityTransaction(this.store);
    const snapshot = this.requireSnapshot(snapshotId);
    if (!["staging", "staged", "released"].includes(snapshot.state))
      fail("PORTABILITY_SNAPSHOT_STATE_INVALID");
    const media = this.entries(snapshotId).filter(isMediaEntry);
    const holds = this.holds(snapshotId);
    assertHoldInventory(snapshot, media, holds);
    for (const hold of holds) {
      if (hold.state === "released") continue;
      const result = release(hold);
      if (isThenable(result)) throw new Error("ASYNC_TRANSACTION_FORBIDDEN");
      const releasedAt = this.nowIso();
      updateDocument(
        this.store,
        portabilityExportCollections.mediaHolds,
        portabilityMediaHoldSchema.parse({
          ...hold,
          updatedAt: releasedAt,
          state: "released",
          releasedAt,
        }),
      );
    }
    return this.holds(snapshotId);
  }

  private entryIdentity(snapshot: PortabilitySnapshot) {
    const createdAt = this.nowIso();
    return {
      id: this.idFactory(),
      schemaVersion: 1 as const,
      createdAt,
      updatedAt: createdAt,
      snapshotId: snapshot.id,
      operationId: snapshot.operationId,
      ordinal: snapshot.nextOrdinal,
    };
  }

  private insertEntry(
    snapshot: PortabilitySnapshot,
    row: PortabilitySnapshotEntry,
  ): void {
    const existing = this.entries(snapshot.id);
    const previous = existing.at(-1);
    if (row.ordinal !== existing.length || row.ordinal !== snapshot.nextOrdinal)
      fail("PORTABILITY_SNAPSHOT_ENTRY_SET_INVALID");
    if (previous && previous.archiveEntry.localeCompare(row.archiveEntry) >= 0)
      fail("PORTABILITY_SNAPSHOT_ENTRY_ORDER_INVALID");
    try {
      insertDocument(
        this.store,
        portabilityExportCollections.snapshotEntries,
        row,
      );
    } catch (error) {
      if (isConstraintFailure(error))
        fail("PORTABILITY_SNAPSHOT_ENTRY_DUPLICATE");
      throw error;
    }
    updateDocument(
      this.store,
      portabilityExportCollections.snapshots,
      portabilitySnapshotSchema.parse({
        ...snapshot,
        updatedAt: this.nowIso(),
        nextOrdinal: snapshot.nextOrdinal + 1,
      }),
    );
  }

  private parseEntry(value: string): PortabilitySnapshotEntry {
    const parsed = parseStored(this.store, value, (input) =>
      portabilitySnapshotEntrySchema.parse(input),
    );
    if (parsed.entryType === "document") this.verifyDocumentEntry(parsed);
    else this.verifyMediaEntry(parsed);
    return parsed;
  }

  private verifyDocumentEntry(entry: SnapshotDocumentEntry): void {
    let document: unknown;
    try {
      document = JSON.parse(entry.canonicalDocument);
    } catch {
      fail("PORTABILITY_SNAPSHOT_DOCUMENT_HASH_MISMATCH");
    }
    if (
      canonicalJson(document) !== entry.canonicalDocument ||
      Buffer.byteLength(entry.canonicalDocument, "utf8") !== entry.bytes ||
      sha256Text(entry.canonicalDocument) !== entry.sha256 ||
      canonicalJson(entry.reasons) !==
        canonicalJson([...entry.reasons].sort()) ||
      entry.archiveEntry !== `data/${entry.collection}/${entry.documentId}.json`
    )
      fail("PORTABILITY_SNAPSHOT_DOCUMENT_HASH_MISMATCH");
    const participant = this.registry.forCollection(entry.collection);
    const parsed = participant.schema.parse(document);
    if (
      parsed.id !== entry.documentId ||
      parsed.schemaVersion !== entry.documentSchemaVersion ||
      parsed.schemaVersion !== participant.currentSchemaVersion
    )
      fail("PORTABILITY_SNAPSHOT_SCHEMA_VERSION_MISMATCH");
  }

  private verifyMediaEntry(entry: SnapshotMediaEntry): void {
    const parsed = this.parseMedia(entry);
    if (entry.archiveEntry !== mediaArchiveEntry(parsed))
      fail("PORTABILITY_SNAPSHOT_ENTRY_SET_INVALID");
  }

  private parseMedia(input: PortabilityMediaInput): PortabilityMediaInput {
    const parsed = portabilityMediaInputSchema.parse(mediaIdentity(input));
    const role = this.registry.catalog.assetRoles.find(
      (entry) => entry.key === parsed.role,
    );
    if (role?.owner !== "participant")
      fail("PORTABILITY_MEDIA_CATALOG_ROLE_INVALID");
    return parsed;
  }

  private validateAndSummarize(
    snapshot: PortabilitySnapshot,
    entries: readonly PortabilitySnapshotEntry[],
    holds: readonly PortabilityMediaHold[],
  ): FrozenSnapshotSummary {
    assertEntrySet(snapshot, entries);
    assertHoldSet(snapshot, entries, holds);
    const documents = entries.filter(isDocumentEntry);
    const media = entries.filter(isMediaEntry);
    if (documents.length === 0) fail("PORTABILITY_SNAPSHOT_ENTRY_SET_INVALID");
    const documentRootHash = sha256Value(documents.map(documentHashIdentity));
    const mediaRootHash = sha256Value(media.map(mediaHashIdentity));
    const totalUncompressedBytes = entries.reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    const identity = {
      projectId: snapshot.projectId,
      customerId: snapshot.customerId,
      familyId: snapshot.familyId,
      projectRevision: snapshot.projectRevision,
      participantRegistryHash: snapshot.participantRegistryHash,
      documentCount: documents.length,
      mediaCount: media.length,
      totalUncompressedBytes,
      documentRootHash,
      mediaRootHash,
    };
    return {
      ...identity,
      snapshotHash: sha256Value(identity),
      nextOrdinal: entries.length,
    };
  }

  private requireSnapshot(id: string): PortabilitySnapshot {
    const snapshot = this.get(id);
    if (!snapshot) fail("PORTABILITY_SNAPSHOT_NOT_FOUND");
    if (snapshot.participantRegistryHash !== this.registry.hash)
      fail("PORTABILITY_SNAPSHOT_REGISTRY_MISMATCH");
    return snapshot;
  }

  private requireMutableSnapshot(id: string): PortabilitySnapshot {
    const snapshot = this.requireSnapshot(id);
    if (snapshot.state !== "freezing") fail("PORTABILITY_SNAPSHOT_FROZEN");
    return snapshot;
  }

  private mediaEntry(
    snapshotId: string,
    namespace: PortabilityMediaInput["namespace"],
    mediaId: string,
  ): SnapshotMediaEntry | null {
    return (
      this.entries(snapshotId).find(
        (entry): entry is SnapshotMediaEntry =>
          entry.entryType === "media" &&
          entry.namespace === namespace &&
          entry.mediaId === mediaId,
      ) ?? null
    );
  }

  private mediaHold(
    snapshotId: string,
    namespace: PortabilityMediaInput["namespace"],
    mediaId: string,
  ): PortabilityMediaHold | null {
    return (
      this.holds(snapshotId).find(
        (hold) => hold.namespace === namespace && hold.mediaId === mediaId,
      ) ?? null
    );
  }

  private assertAllHoldsReleased(snapshotId: string): void {
    if (this.holds(snapshotId).some((hold) => hold.state !== "released"))
      fail("PORTABILITY_MEDIA_HOLD_INCOMPLETE");
  }
}

export class ManagedExportRepository {
  constructor(private readonly store: DocumentStore) {
    initializeIndexes(store, managedExportIndexes);
  }

  get(id: string): ManagedExport | null {
    return readById(
      this.store,
      portabilityExportCollections.managedExports,
      id,
      (value) => managedExportSchema.parse(value),
    );
  }

  forOperation(operationId: string): ManagedExport | null {
    const row = this.store.database
      .prepare(
        `SELECT doc FROM documents
         WHERE collection = ? AND json_extract(doc, '$.operationId') = ?
         LIMIT 1`,
      )
      .get(portabilityExportCollections.managedExports, operationId) as
      StoredRow | undefined;
    return row
      ? parseStored(this.store, row.doc, (value) =>
          managedExportSchema.parse(value),
        )
      : null;
  }

  recordReadyInTransaction(
    operation: ExportOperation,
    record: ManagedExport,
  ): ManagedExport {
    assertPortabilityTransaction(this.store);
    const parsedOperation = exportOperationSchema.parse(operation);
    const parsed = managedExportSchema.parse(record);
    const persisted = readById(
      this.store,
      portabilityExportCollections.operations,
      parsedOperation.id,
      (value) => exportOperationSchema.parse(value),
    );
    if (
      !persisted ||
      canonicalJson(persisted) !== canonicalJson(parsedOperation) ||
      !managedMatchesOperation(parsed, parsedOperation)
    )
      fail("PORTABILITY_MANAGED_EXPORT_MISMATCH");
    const existing =
      this.forOperation(parsed.operationId) ?? this.get(parsed.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(parsed))
        fail("PORTABILITY_MANAGED_EXPORT_MISMATCH");
      return existing;
    }
    try {
      insertDocument(
        this.store,
        portabilityExportCollections.managedExports,
        parsed,
      );
    } catch (error) {
      if (isConstraintFailure(error))
        fail("PORTABILITY_MANAGED_EXPORT_MISMATCH");
      throw error;
    }
    return parsed;
  }
}

interface FrozenSnapshotSummary {
  documentCount: number;
  mediaCount: number;
  totalUncompressedBytes: number;
  documentRootHash: string;
  mediaRootHash: string;
  snapshotHash: string;
  nextOrdinal: number;
}

function assertEntrySet(
  snapshot: PortabilitySnapshot,
  entries: readonly PortabilitySnapshotEntry[],
): void {
  if (entries.length !== snapshot.nextOrdinal)
    fail("PORTABILITY_SNAPSHOT_ENTRY_SET_INVALID");
  const paths = new Set<string>();
  const identities = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (
      entry.snapshotId !== snapshot.id ||
      entry.operationId !== snapshot.operationId ||
      entry.ordinal !== index ||
      paths.has(entry.archiveEntry)
    )
      fail("PORTABILITY_SNAPSHOT_ENTRY_SET_INVALID");
    if (index > 0 && entries[index - 1].archiveEntry >= entry.archiveEntry)
      fail("PORTABILITY_SNAPSHOT_ENTRY_ORDER_INVALID");
    paths.add(entry.archiveEntry);
    const identity =
      entry.entryType === "document"
        ? `document:${entry.collection}:${entry.documentId}`
        : `media:${entry.namespace}:${entry.mediaId}`;
    if (identities.has(identity)) fail("PORTABILITY_SNAPSHOT_ENTRY_DUPLICATE");
    identities.add(identity);
  }
}

function assertHoldSet(
  snapshot: PortabilitySnapshot,
  entries: readonly PortabilitySnapshotEntry[],
  holds: readonly PortabilityMediaHold[],
): void {
  const media = entries.filter(isMediaEntry);
  assertHoldInventory(snapshot, media, holds);
  if (holds.some((hold) => hold.state !== "held"))
    fail("PORTABILITY_MEDIA_HOLD_INCOMPLETE");
}

function assertHoldInventory(
  snapshot: PortabilitySnapshot,
  media: readonly SnapshotMediaEntry[],
  holds: readonly PortabilityMediaHold[],
): void {
  if (media.length !== holds.length) fail("PORTABILITY_MEDIA_HOLD_INCOMPLETE");
  const byKey = new Map(
    holds.map((hold) => [`${hold.namespace}:${hold.mediaId}`, hold]),
  );
  for (const entry of media) {
    const hold = byKey.get(`${entry.namespace}:${entry.mediaId}`);
    if (
      !hold ||
      hold.snapshotId !== snapshot.id ||
      hold.operationId !== snapshot.operationId ||
      !sameMedia(hold, entry)
    )
      fail("PORTABILITY_MEDIA_HOLD_INCOMPLETE");
  }
}

function snapshotMatches(
  snapshot: PortabilitySnapshot,
  summary: FrozenSnapshotSummary,
): boolean {
  return (
    snapshot.documentCount === summary.documentCount &&
    snapshot.mediaCount === summary.mediaCount &&
    snapshot.totalUncompressedBytes === summary.totalUncompressedBytes &&
    snapshot.documentRootHash === summary.documentRootHash &&
    snapshot.mediaRootHash === summary.mediaRootHash &&
    snapshot.snapshotHash === summary.snapshotHash &&
    snapshot.nextOrdinal === summary.nextOrdinal
  );
}

function documentHashIdentity(entry: SnapshotDocumentEntry) {
  return {
    archiveEntry: entry.archiveEntry,
    collection: entry.collection,
    documentId: entry.documentId,
    documentSchemaVersion: entry.documentSchemaVersion,
    reasons: entry.reasons,
    bytes: entry.bytes,
    sha256: entry.sha256,
  };
}

function mediaHashIdentity(entry: SnapshotMediaEntry) {
  return {
    archiveEntry: entry.archiveEntry,
    ...mediaIdentity(entry),
  };
}

function sameMedia(
  left: PortabilityMediaInput,
  right: PortabilityMediaInput,
): boolean {
  return (
    canonicalJson(mediaIdentity(left)) === canonicalJson(mediaIdentity(right))
  );
}

function mediaIdentity(media: PortabilityMediaInput) {
  return {
    namespace: media.namespace,
    mediaId: media.mediaId,
    role: media.role,
    mime: media.mime,
    extension: media.extension,
    bytes: media.bytes,
    sha256: media.sha256,
    occurrenceCount: media.occurrenceCount,
    ownedCount: media.ownedCount,
    referencedCount: media.referencedCount,
    outsideScopeOccurrenceCount: media.outsideScopeOccurrenceCount,
    preHoldRefCount: media.preHoldRefCount,
    disposition: media.disposition,
  };
}

function mediaArchiveEntry(media: PortabilityMediaInput): string {
  const directory = media.namespace === "asset" ? "assets" : "originals";
  return `media/${directory}/${media.sha256}.${media.extension}`;
}

function isDocumentEntry(
  entry: PortabilitySnapshotEntry,
): entry is SnapshotDocumentEntry {
  return entry.entryType === "document";
}

function isMediaEntry(
  entry: PortabilitySnapshotEntry,
): entry is SnapshotMediaEntry {
  return entry.entryType === "media";
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

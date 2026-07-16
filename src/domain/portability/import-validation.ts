import { createHash } from "node:crypto";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import { canonicalJson } from "../../contracts/canonical-json.js";
import { ArchiveValidationError } from "../../portability/archive-policy.js";
import { inspectImportedMedia } from "../../portability/import-media.js";
import type { ManifestDocumentEntry } from "../../portability/manifest.js";
import {
  readStagedImportEntry,
  type StagedImportArchive,
} from "../../portability/zip-reader.js";
import {
  selectPortabilityGraph,
  type PortabilityStoredDocument,
} from "./graph.js";
import type {
  PortabilityImportValidationContext,
  PortabilityParticipant,
  PortabilityRegistry,
  PortabilityValidatedMediaFacts,
} from "./participants.js";
import type { BaseDocument } from "../repository/document-store.js";

export interface ValidatedImportDocument {
  readonly collection: string;
  readonly id: string;
  readonly schemaVersion: number;
  readonly sourceSha256: string;
  readonly normalizedSha256: string;
  readonly migrationCount: number;
  readonly document: Readonly<BaseDocument>;
}

export interface ValidatedImportBundle {
  readonly documents: readonly ValidatedImportDocument[];
  readonly media: readonly PortabilityValidatedMediaFacts[];
  readonly graphHash: string;
  readonly sourceSnapshotHash: string;
  readonly migratedDocumentCount: number;
}

export async function validateStagedImport(input: {
  registry: PortabilityRegistry;
  archive: StagedImportArchive;
}): Promise<ValidatedImportBundle> {
  assertManifestRoots(input.archive);
  const documents = await validateDocuments(input.registry, input.archive);
  const media = await validateMedia(input.archive);
  const context = validationContext(documents, media);
  for (const item of documents) {
    const participant = input.registry.forCollection(item.collection);
    runParticipantValidation(participant, item.document, context);
  }
  const graphHash = validateClosure(
    input.registry,
    input.archive,
    documents,
    media,
  );
  const identity = {
    sourceManifestVersion: input.archive.sourceVersion,
    normalizedManifestHash: input.archive.manifest.manifestHash,
    participantRegistryHash: input.registry.hash,
    graphHash,
    documents: documents.map(documentIdentity),
    media,
  };
  return Object.freeze({
    documents: Object.freeze(documents),
    media: Object.freeze(media),
    graphHash,
    sourceSnapshotHash: sha256(canonicalJson(identity)),
    migratedDocumentCount: documents.reduce(
      (total, item) => total + item.migrationCount,
      0,
    ),
  });
}

async function validateDocuments(
  registry: PortabilityRegistry,
  archive: StagedImportArchive,
): Promise<ValidatedImportDocument[]> {
  const result: ValidatedImportDocument[] = [];
  for (const entry of archive.manifest.documents) {
    const participant = requireImportParticipant(registry, entry.collection);
    const bytes = await readStagedImportEntry(archive, entry.path);
    assertEntryIntegrity(bytes, entry.bytes, entry.sha256);
    const raw = parseCanonicalDocument(bytes);
    const migrated = migrateDocument(participant, raw, entry);
    result.push(migrated);
  }
  return result;
}

function requireImportParticipant(
  registry: PortabilityRegistry,
  collection: string,
): PortabilityParticipant {
  let participant: PortabilityParticipant;
  try {
    participant = registry.forCollection(collection);
  } catch {
    return fail("IMPORT_ARCHIVE_COLLECTION_UNREGISTERED", "schema");
  }
  if (!participant.exportModes.includes("project"))
    return fail("IMPORT_ARCHIVE_COLLECTION_MODE_FORBIDDEN", "schema");
  return participant;
}

function parseCanonicalDocument(bytes: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("IMPORT_ARCHIVE_DOCUMENT_UTF8_INVALID", "schema");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("IMPORT_ARCHIVE_DOCUMENT_JSON_INVALID", "schema");
  }
  if (canonicalJson(raw) !== text)
    return fail("IMPORT_ARCHIVE_DOCUMENT_NOT_CANONICAL", "schema");
  return raw;
}

function migrateDocument(
  participant: PortabilityParticipant,
  raw: unknown,
  entry: ManifestDocumentEntry,
): ValidatedImportDocument {
  const declared = rawSchemaVersion(raw);
  if (declared !== entry.schemaVersion)
    return fail("IMPORT_ARCHIVE_DOCUMENT_VERSION_MISMATCH", "schema");
  if (declared > participant.currentSchemaVersion)
    return fail("IMPORT_ARCHIVE_DOCUMENT_FUTURE_VERSION", "schema");
  let current = raw;
  let version = declared;
  let migrationCount = 0;
  while (version < participant.currentSchemaVersion) {
    const migration = participant.migrations.find(
      (item) => item.from === version,
    );
    if (!migration)
      return fail("IMPORT_ARCHIVE_DOCUMENT_MIGRATION_MISSING", "schema");
    try {
      current = migration.migrate(current);
    } catch {
      return fail("IMPORT_ARCHIVE_DOCUMENT_MIGRATION_FAILED", "schema");
    }
    if (rawSchemaVersion(current) !== migration.to)
      return fail("IMPORT_ARCHIVE_DOCUMENT_MIGRATION_INVALID", "schema");
    version = migration.to;
    migrationCount += 1;
  }
  let document: BaseDocument;
  try {
    document = participant.schema.parse(current);
  } catch {
    return fail("IMPORT_ARCHIVE_PARTICIPANT_SCHEMA_INVALID", "schema");
  }
  if (document.id !== entry.id)
    return fail("IMPORT_ARCHIVE_DOCUMENT_ID_MISMATCH", "schema");
  const normalized = canonicalJson(document);
  return Object.freeze({
    collection: entry.collection,
    id: document.id,
    schemaVersion: participant.currentSchemaVersion,
    sourceSha256: entry.sha256,
    normalizedSha256: sha256(normalized),
    migrationCount,
    document: Object.freeze(document),
  });
}

async function validateMedia(
  archive: StagedImportArchive,
): Promise<PortabilityValidatedMediaFacts[]> {
  const result: PortabilityValidatedMediaFacts[] = [];
  const logicalIds = new Set<string>();
  for (const entry of archive.manifest.media) {
    const logicalId = `${entry.namespace}:${entry.assetId}`;
    if (logicalIds.has(logicalId))
      return fail("IMPORT_ARCHIVE_MEDIA_ID_DUPLICATE", "media");
    logicalIds.add(logicalId);
    const staged = archive.entries.find(
      (item) => item.archivePath === entry.path,
    );
    if (!staged) return fail("IMPORT_ARCHIVE_MEDIA_ENTRY_MISSING", "media");
    result.push(
      await inspectImportedMedia(
        entry,
        join(archive.directory, staged.managedName),
      ),
    );
  }
  return result;
}

function validationContext(
  documents: readonly ValidatedImportDocument[],
  media: readonly PortabilityValidatedMediaFacts[],
): PortabilityImportValidationContext {
  const documentMap = new Map(
    documents.map((item) => [`${item.collection}:${item.id}`, item.document]),
  );
  const mediaMap = new Map(
    media.map((item) => [`${item.namespace}:${item.id}`, item]),
  );
  return Object.freeze({
    document: (collection: string, id: string) =>
      documentMap.get(`${collection}:${id}`) ?? null,
    media: (namespace: "asset" | "original", id: string) =>
      mediaMap.get(`${namespace}:${id}`) ?? null,
  });
}

function runParticipantValidation(
  participant: PortabilityParticipant,
  document: Readonly<BaseDocument>,
  context: PortabilityImportValidationContext,
): void {
  try {
    participant.validateImport(document, context);
  } catch (error) {
    const code = safeFailureCode(error);
    return fail(
      code ?? "IMPORT_ARCHIVE_PARTICIPANT_VALIDATION_FAILED",
      "media",
    );
  }
}

function validateClosure(
  registry: PortabilityRegistry,
  archive: StagedImportArchive,
  documents: readonly ValidatedImportDocument[],
  media: readonly PortabilityValidatedMediaFacts[],
): string {
  let graph;
  try {
    graph = selectPortabilityGraph({
      registry,
      documents: documents.map((item): PortabilityStoredDocument => ({
        collection: item.collection,
        document: item.document,
      })),
      root: {
        kind: "project",
        projectId: archive.manifest.scope.projectId,
        customerId: archive.manifest.scope.customerId,
        familyId: archive.manifest.scope.familyId,
      },
    });
  } catch (error) {
    const code = safeFailurePrefix(error);
    return fail(code ?? "IMPORT_ARCHIVE_REFERENCE_CLOSURE_INVALID", "closure");
  }
  const selectedDocuments = new Set(
    graph.documents.map((item) => `${item.collection}:${item.id}`),
  );
  const listedDocuments = new Set(
    documents.map((item) => `${item.collection}:${item.id}`),
  );
  if (!sameSet(selectedDocuments, listedDocuments))
    return fail("IMPORT_ARCHIVE_DOCUMENT_CLOSURE_MISMATCH", "closure");
  const selectedMedia = new Set(
    graph.media.map((item) => `${item.namespace}:${item.id}`),
  );
  const listedMedia = new Set(
    media.map((item) => `${item.namespace}:${item.id}`),
  );
  if (!sameSet(selectedMedia, listedMedia))
    return fail("IMPORT_ARCHIVE_MEDIA_CLOSURE_MISMATCH", "closure");
  return graph.hash;
}

function assertManifestRoots(archive: StagedImportArchive): void {
  const roots = new Set(
    archive.manifest.roots.map((root) => `${root.kind}:${root.id}`),
  );
  const required = [
    `project:${archive.manifest.scope.projectId}`,
    `customer:${archive.manifest.scope.customerId}`,
    `family:${archive.manifest.scope.familyId}`,
  ];
  if (
    roots.size !== required.length ||
    required.some((root) => !roots.has(root))
  )
    fail("IMPORT_ARCHIVE_ROOT_SET_INVALID", "closure");
}

function assertEntryIntegrity(
  bytes: Buffer,
  expectedBytes: number,
  expectedHash: string,
): void {
  if (bytes.byteLength !== expectedBytes || sha256(bytes) !== expectedHash)
    fail("IMPORT_STAGING_ENTRY_INTEGRITY_MISMATCH", "integrity");
}

function rawSchemaVersion(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("IMPORT_ARCHIVE_DOCUMENT_SCHEMA_VERSION_INVALID", "schema");
  const version = (value as Record<string, unknown>).schemaVersion;
  if (!Number.isSafeInteger(version) || (version as number) < 1)
    return fail("IMPORT_ARCHIVE_DOCUMENT_SCHEMA_VERSION_INVALID", "schema");
  return version as number;
}

function documentIdentity(item: ValidatedImportDocument) {
  return {
    collection: item.collection,
    id: item.id,
    schemaVersion: item.schemaVersion,
    sourceSha256: item.sourceSha256,
    normalizedSha256: item.normalizedSha256,
    migrationCount: item.migrationCount,
  };
}

function sameSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function safeFailureCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return /^[A-Z][A-Z0-9_:.-]{1,159}$/.test(error.message)
    ? error.message
    : null;
}

function safeFailurePrefix(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return /^([A-Z][A-Z0-9_]{1,79})(?::|$)/u.exec(error.message)?.[1] ?? null;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(
  code: string,
  category: ConstructorParameters<typeof ArchiveValidationError>[1],
): never {
  throw new ArchiveValidationError(code, category);
}

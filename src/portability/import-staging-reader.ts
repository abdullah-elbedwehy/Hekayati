import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import { z } from "zod";

import { canonicalJson } from "../contracts/canonical-json.js";
import type { ImportOperation } from "../domain/portability/import-model.js";
import type { ImportPlanSourceBundle } from "../domain/portability/import-plan-selection.js";
import {
  selectPortabilityGraph,
  type PortabilityStoredDocument,
} from "../domain/portability/graph.js";
import type {
  PortabilityImportValidationContext,
  PortabilityRegistry,
  PortabilityValidatedMediaFacts,
} from "../domain/portability/participants.js";
import type { BaseDocument } from "../domain/repository/document-store.js";
import {
  importValidationIndexSchema,
  readImportValidationIndex,
} from "./import-validation-store.js";
import { parseManifestBytes, type ManifestV2 } from "./manifest.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const stagedEntrySchema = z
  .object({
    archivePath: z.string().min(1).max(240),
    managedName: z.string().regex(/^[0-9]{6}\.entry$/),
    kind: z.enum(["document", "media"]),
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: hashSchema,
  })
  .strict();
const stagingIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(stagedEntrySchema).max(20_000),
  })
  .strict();

type StagedEntry = z.infer<typeof stagedEntrySchema>;

export interface LoadedValidatedImportSource {
  source: ImportPlanSourceBundle;
  manifest: ManifestV2;
  sourceProofHash: string;
  readMedia(namespace: "asset" | "original", id: string): Promise<Buffer>;
}

export async function loadValidatedImportSource(input: {
  directory: string;
  operation: ImportOperation;
  registry: PortabilityRegistry;
}): Promise<LoadedValidatedImportSource> {
  await assertPrivateDirectory(input.directory);
  const normalizedRoot = join(input.directory, "normalized");
  await assertPrivateDirectory(normalizedRoot);
  const manifest = parseManifestBytes(
    await readPrivateFile(join(input.directory, "normalized-manifest.json")),
  );
  const stagingIndex = stagingIndexSchema.parse(
    await readCanonicalJson(join(input.directory, "index.json")),
  );
  const validation = await readImportValidationIndex(input.directory);
  assertPinnedMetadata(input, manifest, stagingIndex, validation);
  const documents = await readNormalizedDocuments(
    normalizedRoot,
    validation.documents,
    input.registry,
  );
  const media = Object.freeze([...validation.media]);
  validateParticipants(input.registry, documents, media);
  const graph = selectPortabilityGraph({
    registry: input.registry,
    documents: documents.map(
      (item): PortabilityStoredDocument => ({
        collection: item.collection,
        document: item.document,
      }),
    ),
    root: {
      kind: "project",
      projectId: manifest.scope.projectId,
      customerId: manifest.scope.customerId,
      familyId: manifest.scope.familyId,
    },
  });
  if (graph.hash !== validation.graphHash)
    throw new Error("IMPORT_VALIDATION_GRAPH_HASH_MISMATCH");
  const source = Object.freeze({
    root: Object.freeze({
      projectId: manifest.scope.projectId,
      customerId: manifest.scope.customerId,
      familyId: manifest.scope.familyId,
    }),
    documents: Object.freeze(documents),
    media,
    graphHash: validation.graphHash,
    sourceSnapshotHash: validation.sourceSnapshotHash,
    migratedDocumentCount: validation.migratedDocumentCount,
  });
  assertSourceSnapshot(input.operation, input.registry, manifest, source);
  const byPath = new Map(
    stagingIndex.entries.map((entry) => [entry.archivePath, entry]),
  );
  return Object.freeze({
    source,
    manifest,
    sourceProofHash: hash({
      operationArchiveHash: input.operation.sourceArchiveHash,
      manifestHash: manifest.manifestHash,
      graphHash: source.graphHash,
      sourceSnapshotHash: source.sourceSnapshotHash,
      validation,
      stagingIndex,
    }),
    readMedia: (namespace: "asset" | "original", id: string) =>
      readMedia(input.directory, manifest, byPath, namespace, id),
  });
}

async function readNormalizedDocuments(
  root: string,
  rows: z.infer<typeof importValidationIndexSchema>["documents"],
  registry: PortabilityRegistry,
) {
  const documents = [];
  for (const row of rows) {
    const bytes = await readPrivateFile(join(root, row.managedName));
    const text = decodeUtf8(bytes);
    if (sha256(bytes) !== row.normalizedSha256)
      throw new Error("IMPORT_NORMALIZED_DOCUMENT_INTEGRITY_MISMATCH");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error("IMPORT_NORMALIZED_DOCUMENT_INTEGRITY_MISMATCH");
    }
    const document = registry.forCollection(row.collection).schema.parse(raw);
    if (
      document.id !== row.id ||
      document.schemaVersion !== row.schemaVersion ||
      canonicalJson(document) !== text
    )
      throw new Error("IMPORT_NORMALIZED_DOCUMENT_INTEGRITY_MISMATCH");
    documents.push(
      Object.freeze({
        collection: row.collection,
        id: row.id,
        schemaVersion: row.schemaVersion,
        sourceSha256: row.sourceSha256,
        normalizedSha256: row.normalizedSha256,
        migrationCount: row.migrationCount,
        document: Object.freeze(document),
      }),
    );
  }
  return documents;
}

function validateParticipants(
  registry: PortabilityRegistry,
  documents: readonly { collection: string; document: BaseDocument }[],
  media: readonly PortabilityValidatedMediaFacts[],
): void {
  const documentMap = new Map(
    documents.map((item) => [
      `${item.collection}:${item.document.id}`,
      item.document,
    ]),
  );
  const mediaMap = new Map(
    media.map((item) => [`${item.namespace}:${item.id}`, item]),
  );
  const context: PortabilityImportValidationContext = {
    document: (collection, id) =>
      documentMap.get(`${collection}:${id}`) ?? null,
    media: (namespace, id) => mediaMap.get(`${namespace}:${id}`) ?? null,
  };
  for (const item of documents)
    registry.forCollection(item.collection).validateImport(item.document, context);
}

function assertPinnedMetadata(
  input: Parameters<typeof loadValidatedImportSource>[0],
  manifest: ManifestV2,
  staging: z.infer<typeof stagingIndexSchema>,
  validation: z.infer<typeof importValidationIndexSchema>,
): void {
  const operation = input.operation;
  if (
    operation.normalizedManifestHash !== manifest.manifestHash ||
    operation.participantRegistryHash !== input.registry.hash ||
    operation.sourceSnapshotHash !== validation.sourceSnapshotHash ||
    operation.documentCount !== manifest.documents.length ||
    operation.documentCount !== validation.documents.length ||
    operation.mediaCount !== manifest.media.length ||
    operation.mediaCount !== validation.media.length ||
    operation.totalUncompressedBytes !== manifest.totalUncompressedBytes
  )
    throw new Error("IMPORT_STAGING_OPERATION_FACT_MISMATCH");
  const expected = new Map(
    [...manifest.documents, ...manifest.media].map((entry) => [
      entry.path,
      {
        kind: "collection" in entry ? "document" : "media",
        bytes: entry.bytes,
        sha256: entry.sha256,
      },
    ]),
  );
  if (expected.size !== staging.entries.length)
    throw new Error("IMPORT_STAGING_INDEX_MISMATCH");
  for (const entry of staging.entries) {
    const wanted = expected.get(entry.archivePath);
    if (
      !wanted ||
      wanted.kind !== entry.kind ||
      wanted.bytes !== entry.bytes ||
      wanted.sha256 !== entry.sha256
    )
      throw new Error("IMPORT_STAGING_INDEX_MISMATCH");
    expected.delete(entry.archivePath);
  }
  if (expected.size !== 0) throw new Error("IMPORT_STAGING_INDEX_MISMATCH");
}

function assertSourceSnapshot(
  operation: ImportOperation,
  registry: PortabilityRegistry,
  manifest: ManifestV2,
  source: ImportPlanSourceBundle,
): void {
  const identity = {
    sourceManifestVersion: operation.manifestVersion,
    normalizedManifestHash: manifest.manifestHash,
    participantRegistryHash: registry.hash,
    graphHash: source.graphHash,
    documents: source.documents.map((item) => ({
      collection: item.collection,
      id: item.id,
      schemaVersion: item.schemaVersion,
      sourceSha256: item.sourceSha256,
      normalizedSha256: item.normalizedSha256,
      migrationCount: item.migrationCount,
    })),
    media: source.media,
  };
  if (hash(identity) !== source.sourceSnapshotHash)
    throw new Error("IMPORT_SOURCE_SNAPSHOT_HASH_MISMATCH");
}

async function readMedia(
  directory: string,
  manifest: ManifestV2,
  entries: ReadonlyMap<string, StagedEntry>,
  namespace: "asset" | "original",
  id: string,
): Promise<Buffer> {
  const listed = manifest.media.find(
    (entry) => entry.namespace === namespace && entry.assetId === id,
  );
  if (!listed) throw new Error("IMPORT_STAGED_MEDIA_NOT_FOUND");
  const staged = entries.get(listed.path);
  if (!staged) throw new Error("IMPORT_STAGED_MEDIA_NOT_FOUND");
  const bytes = await readPrivateFile(join(directory, staged.managedName));
  if (bytes.byteLength !== staged.bytes || sha256(bytes) !== staged.sha256)
    throw new Error("IMPORT_STAGED_MEDIA_INTEGRITY_MISMATCH");
  return bytes;
}

async function readCanonicalJson(path: string): Promise<unknown> {
  const text = decodeUtf8(await readPrivateFile(path));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("IMPORT_STAGING_METADATA_INVALID");
  }
  if (canonicalJson(parsed) !== text)
    throw new Error("IMPORT_STAGING_METADATA_NOT_CANONICAL");
  return parsed;
}

async function readPrivateFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600)
      throw new Error("IMPORT_STAGING_FILE_IDENTITY_INVALID");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new Error("IMPORT_STAGING_DIRECTORY_IDENTITY_INVALID");
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("IMPORT_STAGING_UTF8_INVALID");
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hash(value: unknown): string {
  return sha256(Buffer.from(canonicalJson(value)));
}

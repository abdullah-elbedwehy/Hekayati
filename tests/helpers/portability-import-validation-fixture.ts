import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { z } from "zod";
import { ZipFile } from "yazl";
import { expect } from "vitest";

import { canonicalJson } from "../../src/contracts/canonical-json.js";
import { ImportOperationRepository } from "../../src/domain/portability/import-storage.js";
import { ImportUploadService } from "../../src/domain/portability/import-upload.js";
import { ImportValidationService } from "../../src/domain/portability/import-validation-service.js";
import {
  createPortabilityRegistry,
  definePortabilityParticipant,
  type PortabilityCatalog,
  type PortabilityMigration,
} from "../../src/domain/portability/participants.js";
import { PortabilityActionRepository } from "../../src/domain/portability/repositories.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import type { BaseDocument } from "../../src/domain/repository/document-store.js";
import { calculateImportDiskFacts } from "../../src/portability/disk-preflight.js";
import {
  writeDeterministicArchive,
  type StagedArchiveSource,
} from "../../src/portability/export.js";
import { ManagedImportStore } from "../../src/portability/import.js";
import { createManifest } from "../../src/portability/manifest.js";
import { SecretReleaseGate } from "../../src/portability/secret-scan.js";
import { SecretRegistry } from "../../src/security/secret-registry.js";
import { temporaryDirectory } from "./temp.js";

export const IMPORT_VALIDATION_AT = "2026-07-16T13:00:00.000Z";
export const IMPORT_VALIDATION_ENTITY = {
  installation: "01K10000000000000000000000",
  operation: "01K10000000000000000000001",
  reservation: "01K10000000000000000000002",
  action: "01K10000000000000000000003",
  staging: "01K10000000000000000000004",
  export: "01K10000000000000000000005",
  project: "01K10000000000000000000006",
  customer: "01K10000000000000000000007",
  family: "01K10000000000000000000008",
  asset: "01K10000000000000000000009",
  extra: "01K1000000000000000000000A",
} as const;

const at = IMPORT_VALIDATION_AT;
const entity = IMPORT_VALIDATION_ENTITY;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);
const cleanups: Array<() => Promise<void>> = [];

export async function cleanupImportValidationFixtures(): Promise<void> {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
}

interface SyntheticOptions {
  projectVersion?: 1 | 2;
  migration?: "valid" | "missing" | "throws" | "wrong-version";
  projectExportModes?: readonly ("project" | "customer" | "templates_only")[];
  onAssetValidated?: () => void;
}

export function syntheticRegistry(options: SyntheticOptions = {}) {
  const projectVersion = options.projectVersion ?? 1;
  const projectSchema =
    projectVersion === 2 ? projectV2Schema : projectV1Schema;
  const projectMigrations = syntheticProjectMigrations(
    projectVersion,
    options.migration ?? "valid",
  );
  return createPortabilityRegistry(
    [
      definePortabilityParticipant({
        key: "customers",
        collection: "customers",
        currentSchemaVersion: 1,
        schema: customerSchema,
      }),
      definePortabilityParticipant({
        key: "families",
        collection: "families",
        currentSchemaVersion: 1,
        schema: familySchema,
        dependencies: ["customers"],
        ownerReferences: (document) => [
          {
            collection: "customers",
            id: document.customerId,
            field: "customerId",
          },
        ],
      }),
      definePortabilityParticipant({
        key: "projects",
        collection: "projects",
        currentSchemaVersion: projectVersion,
        schema: projectSchema as z.ZodType<BaseDocument>,
        migrations: projectMigrations,
        exportModes: options.projectExportModes,
        dependencies: ["customers", "families"],
        projectIds: (document) => [document.id],
        customerIds: (document) => [
          projectOwnershipSchema.parse(document).customerId,
        ],
        selectForProject: (document, root) =>
          projectOwnershipSchema.parse(document).id === root.projectId
            ? "project_root"
            : null,
        ownerReferences: (document) => {
          const project = projectOwnershipSchema.parse(document);
          return [
            {
              collection: "customers",
              id: project.customerId,
              field: "customerId",
            },
          ];
        },
        references: (document) => {
          const project = projectOwnershipSchema.parse(document);
          return [
            { collection: "families", id: project.familyId, field: "familyId" },
          ];
        },
        assetReferences: (document) => {
          const project = projectOwnershipSchema.parse(document);
          return [
            { id: project.assetId, field: "assetId", ownership: "owned" },
          ];
        },
      }),
      definePortabilityParticipant({
        key: "assets",
        collection: "assets",
        currentSchemaVersion: 1,
        schema: assetSchema,
        importValidationKey: "synthetic_asset_image:v1",
        validateImport: (document, context) => {
          const asset = assetSchema.parse(document);
          const facts = context.media("asset", asset.id);
          if (
            !facts ||
            facts.sha256 !== asset.sha256 ||
            facts.bytes !== asset.bytes ||
            facts.mime !== asset.mime ||
            facts.extension !== asset.extension ||
            facts.role !== asset.role ||
            facts.inspection.kind !== "image"
          )
            throw new Error("PORTABILITY_IMPORT_SYNTHETIC_ASSET_INVALID");
          options.onAssetValidated?.();
        },
      }),
    ],
    syntheticCatalog,
  );
}

function syntheticProjectMigrations(
  projectVersion: 1 | 2,
  behavior: NonNullable<SyntheticOptions["migration"]>,
): PortabilityMigration<BaseDocument>[] {
  if (projectVersion === 1 || behavior === "missing") return [];
  return [
    {
      from: 1,
      to: 2,
      migrate: (value: unknown) => {
        if (behavior === "throws")
          throw new Error("SYNTHETIC_MIGRATION_FAILURE");
        const source = projectV1Schema.parse(value);
        if (behavior === "wrong-version") return source;
        return projectV2Schema.parse({
          ...source,
          schemaVersion: 2,
          migrated: true,
        });
      },
    },
  ];
}

const base = {
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};
const customerSchema = z
  .object({ ...base, schemaVersion: z.literal(1), name: z.string() })
  .strict();
const familySchema = z
  .object({ ...base, schemaVersion: z.literal(1), customerId: z.string() })
  .strict();
const projectFields = {
  ...base,
  customerId: z.string(),
  familyId: z.string(),
  assetId: z.string(),
  note: z.string(),
};
const projectOwnershipSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  familyId: z.string(),
  assetId: z.string(),
});
const projectV1Schema = z
  .object({ ...projectFields, schemaVersion: z.literal(1) })
  .strict();
const projectV2Schema = z
  .object({
    ...projectFields,
    schemaVersion: z.literal(2),
    migrated: z.literal(true),
  })
  .strict();
const assetSchema = z
  .object({
    ...base,
    schemaVersion: z.literal(1),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mime: z.literal("image/png"),
    extension: z.literal("png"),
    role: z.literal("illustration"),
  })
  .strict();

const syntheticCatalog: PortabilityCatalog = {
  collections: ["customers", "families", "projects", "assets"].map((key) => ({
    key,
    owner: "participant" as const,
  })),
  assetRoles: [],
  jobTypes: [],
  scopedWriters: [],
};

interface ArchiveOptions {
  projectVersion?: 1 | 2;
  projectManifestVersion?: 1 | 2;
  projectManifestId?: string;
  projectCollection?: string;
  projectEncoding?: "invalid-json" | "invalid-utf8" | "noncanonical";
  projectExtra?: Record<string, unknown>;
  projectNote?: string;
  omitFamily?: boolean;
  omitFamilyRoot?: boolean;
  extraCustomer?: boolean;
  mediaBytes?: Buffer;
}

export async function syntheticArchive(options: ArchiveOptions = {}) {
  const mediaBytes = options.mediaBytes ?? png;
  const documents = [
    document("customers", {
      id: entity.customer,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      name: "Synthetic Customer",
    }),
    ...(options.extraCustomer
      ? [
          document("customers", {
            id: entity.extra,
            schemaVersion: 1,
            createdAt: at,
            updatedAt: at,
            name: "Unrelated Synthetic Customer",
          }),
        ]
      : []),
    ...(options.omitFamily
      ? []
      : [
          document("families", {
            id: entity.family,
            schemaVersion: 1,
            createdAt: at,
            updatedAt: at,
            customerId: entity.customer,
          }),
        ]),
    document("assets", {
      id: entity.asset,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      bytes: mediaBytes.byteLength,
      sha256: sha256(mediaBytes),
      mime: "image/png",
      extension: "png",
      role: "illustration",
    }),
  ];
  const projectValue = {
    id: entity.project,
    schemaVersion: options.projectVersion ?? 1,
    createdAt: at,
    updatedAt: at,
    customerId: entity.customer,
    familyId: entity.family,
    assetId: entity.asset,
    note: options.projectNote ?? "Synthetic project",
    ...(options.projectExtra ?? {}),
  };
  const projectBytes = encodedProject(projectValue, options.projectEncoding);
  documents.push({
    collection: options.projectCollection ?? "projects",
    id: options.projectManifestId ?? entity.project,
    schemaVersion:
      options.projectManifestVersion ?? options.projectVersion ?? 1,
    bytes: projectBytes,
  });
  const manifest = createManifest({
    appVersion: "0.1.0",
    createdAt: at,
    exportId: entity.export,
    mode: "project",
    scope: {
      kind: "project",
      projectId: entity.project,
      customerId: entity.customer,
      familyId: entity.family,
    },
    roots: [
      { kind: "project", id: entity.project },
      { kind: "customer", id: entity.customer },
      ...(options.omitFamilyRoot
        ? []
        : [{ kind: "family" as const, id: entity.family }]),
    ],
    documents: documents.map((item) => ({
      collection: item.collection,
      id: item.id,
      schemaVersion: item.schemaVersion,
      bytes: item.bytes.byteLength,
      sha256: sha256(item.bytes),
    })),
    media: [
      {
        namespace: "asset",
        assetId: entity.asset,
        role: "illustration",
        mime: "image/png",
        extension: "png",
        bytes: mediaBytes.byteLength,
        sha256: sha256(mediaBytes),
      },
    ],
    snapshotHash: sha256(Buffer.from("synthetic-snapshot")),
  });
  const sourceByPath = new Map<string, Buffer>();
  for (const item of documents)
    sourceByPath.set(`data/${item.collection}/${item.id}.json`, item.bytes);
  sourceByPath.set(manifest.media[0].path, mediaBytes);
  const sources: StagedArchiveSource[] = [
    ...manifest.documents,
    ...manifest.media,
  ].map((entry) => ({
    path: entry.path,
    bytes: entry.bytes,
    sha256: entry.sha256,
    open: () => Readable.from(sourceByPath.get(entry.path)!),
  }));
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await writeDeterministicArchive(manifest, sources, output);
  return { bytes: Buffer.concat(chunks), manifest, projectBytes, sourceByPath };
}

function encodedProject(
  value: Record<string, unknown>,
  encoding: ArchiveOptions["projectEncoding"],
): Buffer {
  if (encoding === "invalid-json") return Buffer.from("{");
  if (encoding === "invalid-utf8") return Buffer.from([0xff]);
  if (encoding === "noncanonical")
    return Buffer.from(JSON.stringify(value, null, 2));
  return Buffer.from(canonicalJson(value));
}

function document(
  collection: string,
  value: Record<string, unknown>,
): { collection: string; id: string; schemaVersion: number; bytes: Buffer } {
  return {
    collection,
    id: String(value.id),
    schemaVersion: Number(value.schemaVersion),
    bytes: Buffer.from(canonicalJson(value)),
  };
}

export async function harness(
  registry: ReturnType<typeof syntheticRegistry>,
  archive: Awaited<ReturnType<typeof syntheticArchive>>,
  options: { beginOnly?: boolean; failDiskAt?: 1 | 2 } = {},
) {
  const directory = await temporaryDirectory("hekayati-import-validation-");
  const db = new DocumentStore(join(directory.path, "app.sqlite"));
  let cleaned = false;
  const cleanupNow = async () => {
    if (cleaned) return;
    cleaned = true;
    db.close();
    await directory.cleanup();
  };
  cleanups.push(cleanupNow);
  const managed = new ManagedImportStore(join(directory.path, "imports"));
  const operations = new ImportOperationRepository(
    db,
    () => entity.installation,
  );
  const actions = new PortabilityActionRepository(db);
  const upload = new ImportUploadService(db, operations, actions, managed, {
    nowIso: () => at,
    idFactory: sequence([entity.operation, entity.reservation, entity.action]),
  });
  await upload.upload({
    idempotencyKey: "synthetic-upload",
    declaredArchiveHash: sha256(archive.bytes),
    declaredArchiveBytes: archive.bytes.byteLength,
    openSource: () => Readable.from(archive.bytes),
  });
  const diskChecks: unknown[] = [];
  const validation = new ImportValidationService(
    db,
    operations,
    registry,
    managed,
    new SecretReleaseGate(new SecretRegistry()),
    {
      reserveBytes: 1024,
      nowIso: () => at,
      idFactory: () => entity.staging,
      diskPreflight: async (input) => {
        diskChecks.push(input);
        if (diskChecks.length === options.failDiskAt)
          return calculateImportDiskFacts({
            freeBytes: 0,
            reserveBytes: input.reserveBytes,
            declaredUncompressedBytes: input.declaredUncompressedBytes,
            newContentBytes: input.newContentBytes,
            canonicalDocumentBytes: input.canonicalDocumentBytes,
          });
        return calculateImportDiskFacts({
          freeBytes: 32 * 1024 ** 3,
          reserveBytes: input.reserveBytes,
          declaredUncompressedBytes: input.declaredUncompressedBytes,
          newContentBytes: input.newContentBytes,
          canonicalDocumentBytes: input.canonicalDocumentBytes,
        });
      },
    },
  );
  if (options.beginOnly)
    expect(operations.get(entity.operation)?.state).toBe("uploaded");
  return {
    db,
    managed,
    operations,
    validation,
    diskChecks,
    cleanupNow,
  };
}

export function productDocumentCount(store: DocumentStore): number {
  const row = store.database
    .prepare(
      `SELECT COUNT(*) AS count FROM documents
       WHERE collection IN ('customers', 'families', 'projects', 'assets')`,
    )
    .get() as { count: number };
  return row.count;
}

function sequence(values: string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error("SYNTHETIC_ID_SEQUENCE_EXHAUSTED");
    index += 1;
    return value;
  };
}

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function mutateEncryptedArchive(source: Buffer) {
  const result = Buffer.from(source);
  const local = requireSignature(result, 0x04034b50);
  const central = requireSignature(result, 0x02014b50);
  result.writeUInt16LE(result.readUInt16LE(local + 6) | 1, local + 6);
  result.writeUInt16LE(result.readUInt16LE(central + 8) | 1, central + 8);
  return result;
}

export function mutateMultiDiskArchive(source: Buffer) {
  const result = Buffer.from(source);
  const eocd = requireSignature(result, 0x06054b50, true);
  result.writeUInt16LE(1, eocd + 4);
  result.writeUInt16LE(1, eocd + 6);
  return result;
}

export function mutateLocalHeaderName(source: Buffer) {
  const result = Buffer.from(source);
  const local = requireSignature(result, 0x04034b50);
  result[local + 30] ^= 1;
  return result;
}

export function mutateCentralDiskStart(source: Buffer) {
  const result = Buffer.from(source);
  const central = requireSignature(result, 0x02014b50);
  result.writeUInt16LE(1, central + 34);
  return result;
}

export function mutateLocalSignature(source: Buffer) {
  const result = Buffer.from(source);
  const local = requireSignature(result, 0x04034b50);
  result.writeUInt32LE(0, local);
  return result;
}

export function mutateLocalMethod(source: Buffer) {
  const result = Buffer.from(source);
  const local = requireSignature(result, 0x04034b50);
  const current = result.readUInt16LE(local + 8);
  result.writeUInt16LE(current === 0 ? 8 : 0, local + 8);
  return result;
}

export function mutateLocalNameLength(source: Buffer) {
  const result = Buffer.from(source);
  const local = requireSignature(result, 0x04034b50);
  result.writeUInt16LE(result.readUInt16LE(local + 26) + 1, local + 26);
  return result;
}

function requireSignature(
  bytes: Buffer,
  signature: number,
  fromEnd = false,
): number {
  const marker = Buffer.alloc(4);
  marker.writeUInt32LE(signature);
  const index = fromEnd ? bytes.lastIndexOf(marker) : bytes.indexOf(marker);
  if (index < 0) throw new Error("SYNTHETIC_ZIP_SIGNATURE_MISSING");
  return index;
}

export async function expectArchiveRejected(
  archive: Awaited<ReturnType<typeof syntheticArchive>>,
  bytes: Buffer<ArrayBuffer>,
  expected: string,
): Promise<void> {
  const source = Buffer.from(bytes);
  const fixture = await harness(syntheticRegistry(), { ...archive, bytes });
  await expect(fixture.validation.validate(entity.operation)).rejects.toThrow(
    expected,
  );
  await expect(fixture.validation.validate(entity.operation)).rejects.toThrow(
    expected,
  );
  expect(fixture.operations.get(entity.operation)).toMatchObject({
    state: "failed",
    reservationKey: null,
    stagingKey: null,
    cleanupState: "complete",
  });
  expect(await readdir(join(fixture.managed.root, "reservations"))).toEqual([]);
  expect(await readdir(fixture.managed.stagingRoot)).toEqual([]);
  expect(productDocumentCount(fixture.db)).toBe(0);
  expect(bytes).toEqual(source);
  await fixture.cleanupNow();
}

interface SyntheticZipEntry {
  path: string;
  bytes: Buffer;
  mode?: number;
  fileComment?: string;
  forceDosTimestamp?: boolean;
}

export function archiveEntries(
  archive: Awaited<ReturnType<typeof syntheticArchive>>,
): SyntheticZipEntry[] {
  return [
    {
      path: "manifest.json",
      bytes: Buffer.from(canonicalJson(archive.manifest)),
    },
    ...[...archive.manifest.documents, ...archive.manifest.media].map(
      (entry) => ({
        path: entry.path,
        bytes: archive.sourceByPath.get(entry.path)!,
      }),
    ),
  ];
}

export function manifestWithFirstDocumentBytes(
  archive: Awaited<ReturnType<typeof syntheticArchive>>,
  delta: number,
) {
  return createManifest({
    appVersion: archive.manifest.appVersion,
    createdAt: archive.manifest.createdAt,
    exportId: archive.manifest.exportId,
    mode: archive.manifest.mode,
    scope: archive.manifest.scope,
    roots: archive.manifest.roots,
    documents: archive.manifest.documents.map((entry, index) => ({
      collection: entry.collection,
      id: entry.id,
      schemaVersion: entry.schemaVersion,
      bytes: entry.bytes + (index === 0 ? delta : 0),
      sha256: entry.sha256,
    })),
    media: archive.manifest.media.map((entry) => ({
      namespace: entry.namespace,
      assetId: entry.assetId,
      role: entry.role,
      mime: entry.mime,
      extension: entry.extension,
      bytes: entry.bytes,
      sha256: entry.sha256,
    })),
    snapshotHash: archive.manifest.snapshotHash,
  });
}

export function legacyManifestForArchive(
  archive: Awaited<ReturnType<typeof syntheticArchive>>,
) {
  const entries = [
    ...archive.manifest.documents.map((entry) => ({
      kind: "document" as const,
      path: entry.path,
      collection: entry.collection,
      id: entry.id,
      schemaVersion: entry.schemaVersion,
      bytes: entry.bytes,
    })),
    ...archive.manifest.media.map((entry) => ({
      kind: "media" as const,
      path: entry.path,
      namespace: entry.namespace,
      assetId: entry.assetId,
      role: entry.role,
      mime: entry.mime,
      extension: entry.extension,
      bytes: entry.bytes,
    })),
  ];
  return {
    format: "HekayatiArchive",
    schemaVersion: 1,
    appVersion: archive.manifest.appVersion,
    createdAt: archive.manifest.createdAt,
    exportId: archive.manifest.exportId,
    mode: archive.manifest.mode,
    scope: archive.manifest.scope,
    roots: archive.manifest.roots,
    entries,
    checksums: Object.fromEntries(
      [...archive.manifest.documents, ...archive.manifest.media].map(
        (entry) => [entry.path, entry.sha256],
      ),
    ),
    totalUncompressedBytes: archive.manifest.totalUncompressedBytes,
    snapshotHash: archive.manifest.snapshotHash,
  };
}

export async function collectZip(
  entries: readonly SyntheticZipEntry[],
  comment = "",
) {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const completion = pipeline(zip.outputStream as Readable, output);
  for (const entry of entries) {
    const options = {
      mode: entry.mode ?? 0o100600,
      compress: true,
      mtime: new Date(1980, 0, 1),
      forceDosTimestamp: entry.forceDosTimestamp ?? true,
      forceZip64Format: false,
      fileComment: entry.fileComment,
    };
    zip.addBuffer(entry.bytes, entry.path, options);
  }
  zip.end({ forceZip64Format: false, comment });
  await completion;
  return Buffer.concat(chunks);
}

export function prefixedBytes(source: Buffer, prefix: string) {
  const result = Buffer.from(source);
  result.fill(0x20);
  result.write(prefix, 0, "latin1");
  return result;
}

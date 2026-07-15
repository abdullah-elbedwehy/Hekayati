import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { ulid } from "ulid";
import { z } from "zod";

import {
  DocumentRepository,
  type DocumentStore,
} from "../domain/repository/document-store.js";

const extensionPattern = /^[a-z0-9]{1,10}$/;
const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const generationSettingsSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    settingsHash: z.string().regex(sha256Pattern),
    qualityMode: z.enum(["standard", "economy"]).optional(),
    styleId: z.string().regex(safeIdentifierPattern).max(120).optional(),
    referenceBudget: z.number().int().min(0).max(20).optional(),
    economyTier: z.boolean().optional(),
    output: z
      .object({
        minWidthPx: z.number().int().positive(),
        minHeightPx: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

const inputVersionRefsSchema = z
  .record(
    z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/),
    z.string().regex(ulidPattern),
  )
  .refine((refs) => Object.keys(refs).length <= 50, "TOO_MANY_INPUT_REFS");

const assetProvenanceSchema = z
  .object({
    provider: z.enum(["mock", "codex", "gemini"]),
    model: z.string().regex(safeIdentifierPattern).max(120),
    at: z.iso.datetime(),
    jobId: z.string().regex(ulidPattern),
    inputVersionRefs: inputVersionRefsSchema,
    promptVersion: z.string().regex(safeIdentifierPattern).max(80),
    referencedAssetIds: z.array(z.string().regex(ulidPattern)).max(20),
    attempt: z.number().int().positive(),
    settingsSnapshot: generationSettingsSnapshotSchema,
  })
  .strict();

const assetMetadataBaseSchema = z
  .object({
    mime: z.string().min(3).max(120),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    dpi: z.number().positive().optional(),
    role: z.enum([
      "reference_photo",
      "sheet_view",
      "illustration",
      "pdf_preview",
      "pdf_interior",
      "pdf_cover",
      "thumbnail",
      "import_staging",
    ]),
    origin: z.enum(["upload", "generated", "derived"]),
    provenance: assetProvenanceSchema.optional(),
    exifStripped: z.boolean().optional(),
  })
  .strict();

type AssetMetadata = z.infer<typeof assetMetadataBaseSchema>;

const assetMetadataSchema = assetMetadataBaseSchema
  .refine(hasGeneratedProvenance, {
    message: "GENERATED_ASSET_REQUIRES_PROVENANCE",
    path: ["provenance"],
  })
  .refine(hasSanitizedReferencePhoto, {
    message: "REFERENCE_PHOTO_REQUIRES_EXIF_STRIPPING",
    path: ["exifStripped"],
  });

export const assetRecordSchema = assetMetadataBaseSchema
  .extend({
    id: z.string().regex(ulidPattern),
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    sha256: z.string().regex(sha256Pattern),
    extension: z.string().regex(extensionPattern),
    bytes: z.number().int().nonnegative(),
    refCount: z.number().int().positive(),
  })
  .refine(hasGeneratedProvenance, {
    message: "GENERATED_ASSET_REQUIRES_PROVENANCE",
    path: ["provenance"],
  })
  .refine(hasSanitizedReferencePhoto, {
    message: "REFERENCE_PHOTO_REQUIRES_EXIF_STRIPPING",
    path: ["exifStripped"],
  });

export type AssetRecord = z.infer<typeof assetRecordSchema>;

export interface AssetInput {
  bytes: Buffer;
  extension: string;
  mime: string;
  role: AssetRecord["role"];
  origin: AssetRecord["origin"];
  width?: number;
  height?: number;
  dpi?: number;
  provenance?: AssetRecord["provenance"];
  exifStripped?: boolean;
}

export interface IntegrityIssue {
  assetId: string;
  reason: "missing" | "checksum_mismatch";
}

export interface IntegrityReport {
  checked: number;
  healthy: number;
  issues: IntegrityIssue[];
  scannedAt: string;
}

export type AssetIntegrityVerification =
  | {
      assetId: string;
      expectedSha256: string;
      status: "healthy";
      reason: null;
    }
  | {
      assetId: string;
      expectedSha256: string;
      status: "missing";
      reason: "missing";
    }
  | {
      assetId: string;
      expectedSha256: string;
      status: "corrupt";
      reason: "checksum_mismatch";
    };

export interface AssetStoreHooks {
  afterTempSync?(): Promise<void> | void;
  afterRenameSync?(): Promise<void> | void;
}

export interface PreparedAsset {
  record: AssetRecord;
  isNew: boolean;
}

export class AssetStore {
  private readonly repository: DocumentRepository<AssetRecord>;
  private readonly hashLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: DocumentStore,
    readonly root: string,
    private readonly hooks: AssetStoreHooks = {},
  ) {
    this.repository = new DocumentRepository(
      store,
      "assets",
      assetRecordSchema,
    );
  }

  async put(input: AssetInput): Promise<AssetRecord> {
    const extension = normalizeExtension(input.extension);
    const metadata = metadataFromInput(input);
    this.store.assertSafeForPersistence(metadata);
    this.store.secretRegistry.assertSafeBinaryPayload(input.bytes);
    const hash = sha256(input.bytes);
    return this.withHashLock(hash, () =>
      this.putLocked(input.bytes, metadata, extension, hash),
    );
  }

  async prepare(input: AssetInput): Promise<PreparedAsset> {
    const extension = normalizeExtension(input.extension);
    const metadata = metadataFromInput(input);
    this.store.assertSafeForPersistence(metadata);
    this.store.secretRegistry.assertSafeBinaryPayload(input.bytes);
    const hash = sha256(input.bytes);
    const existing = this.findBySha(hash);
    if (existing) {
      assertCompatibleMetadata(existing, extension, metadata);
      await this.atomicWrite(this.pathForRecord(existing), input.bytes, hash);
      return { record: existing, isNew: false };
    }
    const now = new Date().toISOString();
    const record = assetRecordSchema.parse({
      ...metadata,
      id: ulid(),
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      sha256: hash,
      extension,
      bytes: input.bytes.byteLength,
      refCount: 1,
    });
    await this.atomicWrite(this.pathForRecord(record), input.bytes, hash);
    return { record, isNew: true };
  }

  /** Commit inside the caller's DocumentStore transaction. */
  commitPrepared(prepared: PreparedAsset): AssetRecord {
    const parsed = assetRecordSchema.parse(prepared.record);
    const existing = this.findBySha(parsed.sha256);
    if (existing) {
      assertCompatibleMetadata(
        existing,
        parsed.extension,
        metadataFromInput({ ...parsed, bytes: Buffer.alloc(0) }),
      );
      return this.incrementReference(existing);
    }
    return this.repository.put(parsed);
  }

  async discardPrepared(prepared: PreparedAsset): Promise<void> {
    if (!prepared.isNew || this.findBySha(prepared.record.sha256)) return;
    await this.removeUnlinkedFile(prepared.record);
  }

  private async putLocked(
    bytes: Buffer,
    metadata: AssetMetadata,
    extension: string,
    hash: string,
  ): Promise<AssetRecord> {
    const existing = this.findBySha(hash);
    if (existing) {
      assertCompatibleMetadata(existing, extension, metadata);
      await this.atomicWrite(this.pathForRecord(existing), bytes, hash);
      return this.store.transaction(() =>
        this.incrementReference(this.requireHash(hash)),
      );
    }

    const now = new Date().toISOString();
    const record = assetRecordSchema.parse({
      ...metadata,
      id: ulid(),
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      sha256: hash,
      extension,
      bytes: bytes.byteLength,
      refCount: 1,
    });
    const target = this.pathFor(hash, extension);
    await this.atomicWrite(target, bytes, hash);
    return this.store.transaction(() => {
      const raced = this.findBySha(hash);
      if (!raced) return this.repository.put(record);
      assertCompatibleMetadata(raced, extension, metadata);
      return this.incrementReference(raced);
    });
  }

  get(assetId: string): AssetRecord | null {
    return this.repository.get(assetId);
  }

  list(): AssetRecord[] {
    return this.repository.list();
  }

  async read(assetId: string): Promise<Buffer> {
    const record = this.requireRecord(assetId);
    const bytes = await readManagedFile(this.pathForRecord(record));
    if (sha256(bytes) !== record.sha256)
      throw new Error("ASSET_CHECKSUM_MISMATCH");
    return bytes;
  }

  async verifyIntegrity(assetId: string): Promise<AssetIntegrityVerification> {
    return this.verifyRecord(this.requireRecord(assetId));
  }

  retain(assetId: string): AssetRecord {
    return this.store.transaction(() => {
      const record = this.requireRecord(assetId);
      return this.incrementReference(record);
    });
  }

  async release(assetId: string): Promise<AssetRecord | null> {
    const snapshot = this.requireRecord(assetId);
    return this.withHashLock(snapshot.sha256, () =>
      this.releaseLocked(assetId),
    );
  }

  private async releaseLocked(assetId: string): Promise<AssetRecord | null> {
    let unlinked: AssetRecord | null = null;
    const retained = this.store.transaction(() => {
      const record = this.requireRecord(assetId);
      if (record.refCount > 1) {
        return this.repository.put({
          ...record,
          refCount: record.refCount - 1,
          updatedAt: new Date().toISOString(),
        });
      }
      this.repository.delete(assetId);
      unlinked = record;
      return null;
    });
    if (unlinked) await this.removeUnlinkedFile(unlinked);
    return retained;
  }

  pathForRecord(record: AssetRecord): string {
    return this.pathFor(record.sha256, record.extension);
  }

  async scanIntegrity(): Promise<IntegrityReport> {
    const records = this.repository.list();
    const issues: IntegrityIssue[] = [];
    for (const record of records) {
      const verification = await this.verifyRecord(record);
      if (verification.reason) {
        issues.push({ assetId: record.id, reason: verification.reason });
      }
    }
    return {
      checked: records.length,
      healthy: records.length - issues.length,
      issues,
      scannedAt: new Date().toISOString(),
    };
  }

  async garbageCollectOrphans(): Promise<string[]> {
    const indexed = new Set(
      this.repository.list().map((record) => this.pathForRecord(record)),
    );
    const files = await listFiles(this.root);
    const removed: string[] = [];
    for (const file of files) {
      if (indexed.has(file) || !isCollectibleAssetFile(file, this.root))
        continue;
      await rm(file, { force: true });
      removed.push(file);
    }
    return removed;
  }

  private pathFor(hash: string, extension: string): string {
    return join(this.root, hash.slice(0, 2), `${hash}.${extension}`);
  }

  private incrementReference(record: AssetRecord): AssetRecord {
    return this.repository.put({
      ...record,
      refCount: record.refCount + 1,
      updatedAt: new Date().toISOString(),
    });
  }

  private findBySha(hash: string): AssetRecord | null {
    const records = this.repository.queryByField("sha256", hash);
    if (records.length > 1) throw new Error("DUPLICATE_ASSET_HASH");
    return records[0] ?? null;
  }

  private requireHash(hash: string): AssetRecord {
    const record = this.findBySha(hash);
    if (!record) throw new Error("ASSET_NOT_FOUND");
    return record;
  }

  private requireRecord(assetId: string): AssetRecord {
    const record = this.repository.get(assetId);
    if (!record) throw new Error("ASSET_NOT_FOUND");
    return record;
  }

  private async removeUnlinkedFile(record: AssetRecord): Promise<void> {
    const target = this.pathForRecord(record);
    await rm(target, { force: true });
    await syncDirectory(dirname(target));
  }

  private async withHashLock<T>(
    hash: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.hashLocks.get(hash) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.hashLocks.set(hash, current);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.hashLocks.get(hash) === current) this.hashLocks.delete(hash);
    }
  }

  private async atomicWrite(
    target: string,
    bytes: Buffer,
    expectedHash: string,
  ): Promise<void> {
    await prepareManagedDirectory(dirname(target));
    if (await fileMatches(target, expectedHash)) return;

    const temporary = join(dirname(target), `.hekayati-tmp-${randomUUID()}`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.hooks.afterTempSync?.();
      await rename(temporary, target);
      await chmod(target, 0o600);
      await syncDirectory(dirname(target));
      await this.hooks.afterRenameSync?.();
    } catch (error) {
      await removeTemporaryAfterFailure(temporary);
      throw error;
    }
  }

  private async verifyRecord(
    record: AssetRecord,
  ): Promise<AssetIntegrityVerification> {
    const reason = await this.checkRecord(record);
    if (reason === "missing") {
      return {
        assetId: record.id,
        expectedSha256: record.sha256,
        status: "missing",
        reason,
      };
    }
    if (reason === "checksum_mismatch") {
      return {
        assetId: record.id,
        expectedSha256: record.sha256,
        status: "corrupt",
        reason,
      };
    }
    return {
      assetId: record.id,
      expectedSha256: record.sha256,
      status: "healthy",
      reason: null,
    };
  }

  private async checkRecord(
    record: AssetRecord,
  ): Promise<IntegrityIssue["reason"] | null> {
    const target = this.pathForRecord(record);
    try {
      return sha256(await readManagedFile(target)) === record.sha256
        ? null
        : "checksum_mismatch";
    } catch (error) {
      if (isMissing(error)) return "missing";
      throw error instanceof Error
        ? error
        : new Error("ASSET_INTEGRITY_CHECK_FAILED");
    }
  }
}

function normalizeExtension(extension: string): string {
  const normalized = extension.replace(/^\./, "").toLowerCase();
  if (!extensionPattern.test(normalized))
    throw new Error("INVALID_ASSET_EXTENSION");
  return normalized;
}

function isCollectibleAssetFile(file: string, root: string): boolean {
  const name = basename(file);
  const parent = dirname(file);
  const prefix = basename(parent);
  if (dirname(parent) !== root || !/^[a-f0-9]{2}$/.test(prefix)) return false;
  if (/^\.hekayati-tmp-[A-Za-z0-9-]{1,80}$/.test(name)) return true;
  return (
    /^[a-f0-9]{64}\.[a-z0-9]{1,10}$/.test(name) && prefix === name.slice(0, 2)
  );
}

function metadataFromInput(input: AssetInput): AssetMetadata {
  return assetMetadataSchema.parse({
    mime: input.mime,
    width: input.width,
    height: input.height,
    dpi: input.dpi,
    role: input.role,
    origin: input.origin,
    provenance: input.provenance,
    exifStripped: input.exifStripped,
  });
}

function hasGeneratedProvenance(metadata: AssetMetadata): boolean {
  return metadata.origin !== "generated" || metadata.provenance !== undefined;
}

function hasSanitizedReferencePhoto(metadata: AssetMetadata): boolean {
  return metadata.role !== "reference_photo" || metadata.exifStripped === true;
}

function assertCompatibleMetadata(
  record: AssetRecord,
  extension: string,
  metadata: AssetMetadata,
): void {
  const stored = metadataFromInput({
    ...record,
    bytes: Buffer.alloc(0),
  });
  if (record.extension !== extension || !isDeepStrictEqual(stored, metadata))
    throw new Error("ASSET_METADATA_CONFLICT");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileMatches(
  file: string,
  expectedHash: string,
): Promise<boolean> {
  try {
    return sha256(await readManagedFile(file)) === expectedHash;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function prepareManagedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("INVALID_ASSET_DIRECTORY");
  await chmod(directory, 0o700);
}

async function readManagedFile(file: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) throw error;
    throw new Error("INVALID_ASSET_FILE", { cause: error });
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1)
      throw new Error("INVALID_ASSET_FILE");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedSync(error)) throw error;
  } finally {
    await handle.close();
  }
}

async function removeTemporaryAfterFailure(temporary: string): Promise<void> {
  try {
    await rm(temporary, { force: true });
    await syncDirectory(dirname(temporary));
  } catch {
    // Preserve the write failure; startup orphan GC remains the fallback.
  }
}

async function listFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = join(root, entry.name);
      if (entry.isDirectory()) return listFiles(target);
      return entry.isFile() ? [target] : [];
    }),
  );
  return nested
    .flat()
    .filter(
      (file) => basename(file) !== ".DS_Store" && extname(file) !== ".keep",
    );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isUnsupportedSync(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EINVAL" || error.code === "ENOTSUP")
  );
}

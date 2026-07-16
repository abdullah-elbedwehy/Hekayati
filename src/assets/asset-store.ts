import { randomUUID } from "node:crypto";
import { chmod, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { ulid } from "ulid";
import { z } from "zod";

import {
  DocumentRepository,
  type DocumentStore,
} from "../domain/repository/document-store.js";
import {
  fileMatches,
  isCollectibleAssetFile,
  isMissing,
  listFiles,
  prepareManagedDirectory,
  readManagedFile,
  readManagedFileSync,
  removeTemporaryAfterFailure,
  sha256,
  syncDirectory,
} from "./asset-file-operations.js";
import {
  assertMediaCleanupOutsideTransaction,
  assertMediaReferenceTransaction,
  mediaCleanupIntent,
  unlinkManagedCleanupIntentSync,
  validateMediaCleanupIntent,
  type MediaCleanupIntent,
  type MediaCleanupOutcome,
  type MediaHoldClaim,
  type MediaHoldResult,
  type MediaReleaseResult,
} from "./media-reference.js";

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
      "icc_profile",
      "printer_template",
      "print_proof",
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
  })
  .refine(hasValidPrintAssetMetadata, {
    message: "PRINT_ASSET_METADATA_INVALID",
    path: ["role"],
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
  })
  .refine(hasValidPrintAssetMetadata, {
    message: "PRINT_ASSET_METADATA_INVALID",
    path: ["role"],
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
  afterTempSync?(boundary: AssetWriteBoundary): Promise<void> | void;
  afterRenameSync?(boundary: AssetWriteBoundary): Promise<void> | void;
}

export interface AssetWriteBoundary {
  target: string;
  temporary: string;
  expectedHash: string;
  role: AssetRecord["role"];
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
      await this.atomicWrite(
        this.pathForRecord(existing),
        input.bytes,
        hash,
        metadata.role,
      );
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
    await this.atomicWrite(
      this.pathForRecord(record),
      input.bytes,
      hash,
      metadata.role,
    );
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
      await this.atomicWrite(
        this.pathForRecord(existing),
        bytes,
        hash,
        metadata.role,
      );
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
    await this.atomicWrite(target, bytes, hash, metadata.role);
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

  readSync(assetId: string): Buffer {
    const record = this.requireRecord(assetId);
    const bytes = readManagedFileSync(this.pathForRecord(record));
    if (sha256(bytes) !== record.sha256)
      throw new Error("ASSET_CHECKSUM_MISMATCH");
    return bytes;
  }

  async verifyIntegrity(assetId: string): Promise<AssetIntegrityVerification> {
    return this.verifyRecord(this.requireRecord(assetId));
  }

  verifyIntegritySync(assetId: string): AssetIntegrityVerification {
    const record = this.requireRecord(assetId);
    return this.verifyRecordSync(record);
  }

  verifyPreparedIntegritySync(
    prepared: PreparedAsset,
  ): AssetIntegrityVerification {
    return this.verifyRecordSync(prepared.record);
  }

  private verifyRecordSync(record: AssetRecord): AssetIntegrityVerification {
    try {
      if (
        sha256(readManagedFileSync(this.pathForRecord(record))) !==
        record.sha256
      )
        return {
          assetId: record.id,
          expectedSha256: record.sha256,
          status: "corrupt",
          reason: "checksum_mismatch",
        };
      return {
        assetId: record.id,
        expectedSha256: record.sha256,
        status: "healthy",
        reason: null,
      };
    } catch (error) {
      if (isMissing(error))
        return {
          assetId: record.id,
          expectedSha256: record.sha256,
          status: "missing",
          reason: "missing",
        };
      throw error;
    }
  }

  retain(assetId: string): AssetRecord {
    return this.store.transaction(() => this.retainInTransaction(assetId));
  }

  retainInTransaction(assetId: string): AssetRecord {
    assertMediaReferenceTransaction(this.store);
    return this.incrementReference(this.requireRecord(assetId));
  }

  holdInTransaction(
    assetId: string,
    claim: MediaHoldClaim,
  ): MediaHoldResult<AssetRecord> {
    assertMediaReferenceTransaction(this.store);
    const before = this.requireRecord(assetId);
    const disposition = claim();
    if (disposition !== "acquired" && disposition !== "replayed")
      throw new Error("MEDIA_HOLD_DISPOSITION_INVALID");
    const current = this.requireRecord(assetId);
    if (current.sha256 !== before.sha256)
      throw new Error("ASSET_IDENTITY_CHANGED_IN_TRANSACTION");
    return disposition === "acquired"
      ? { record: this.incrementReference(current), acquired: true }
      : { record: current, acquired: false };
  }

  releaseWithoutUnlinkInTransaction(
    assetId: string,
  ): MediaReleaseResult<AssetRecord, "asset"> {
    assertMediaReferenceTransaction(this.store);
    const record = this.requireRecord(assetId);
    if (record.refCount > 1)
      return {
        record: this.repository.put({
          ...record,
          refCount: record.refCount - 1,
          updatedAt: new Date().toISOString(),
        }),
        cleanupIntent: null,
      };
    this.repository.delete(assetId);
    return { record: null, cleanupIntent: mediaCleanupIntent("asset", record) };
  }

  async release(assetId: string): Promise<AssetRecord | null> {
    const snapshot = this.requireRecord(assetId);
    return this.withHashLock(snapshot.sha256, () =>
      this.releaseLocked(assetId),
    );
  }

  private releaseLocked(assetId: string): AssetRecord | null {
    const released = this.store.transaction(() =>
      this.releaseWithoutUnlinkInTransaction(assetId),
    );
    if (released.cleanupIntent)
      this.unlinkCleanupIntentLocked(released.cleanupIntent);
    return released.record;
  }

  unlinkCleanupIntent(
    intent: MediaCleanupIntent<"asset">,
  ): Promise<MediaCleanupOutcome> {
    assertMediaCleanupOutsideTransaction(this.store);
    validateMediaCleanupIntent(intent, "asset");
    return this.withHashLock(intent.checksum, () =>
      this.unlinkCleanupIntentLocked(intent),
    );
  }

  private unlinkCleanupIntentLocked(
    intent: MediaCleanupIntent<"asset">,
  ): MediaCleanupOutcome {
    if (this.repository.get(intent.mediaId) || this.findBySha(intent.checksum))
      return "preserved";
    return unlinkManagedCleanupIntentSync(this.root, intent);
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
    operation: () => T | Promise<T>,
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
    role: AssetRecord["role"],
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
      const boundary = { target, temporary, expectedHash, role };
      await this.hooks.afterTempSync?.(boundary);
      await rename(temporary, target);
      await chmod(target, 0o600);
      await syncDirectory(dirname(target));
      await this.hooks.afterRenameSync?.(boundary);
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

function hasValidPrintAssetMetadata(metadata: AssetMetadata): boolean {
  if (metadata.role === "icc_profile")
    return (
      metadata.mime === "application/vnd.iccprofile" &&
      metadata.origin === "upload"
    );
  if (metadata.role === "printer_template")
    return metadata.mime === "application/pdf" && metadata.origin === "upload";
  if (metadata.role === "pdf_interior" || metadata.role === "pdf_cover")
    return metadata.mime === "application/pdf" && metadata.origin === "derived";
  if (metadata.role === "print_proof")
    return (
      (metadata.mime === "application/pdf" || metadata.mime === "image/png") &&
      metadata.origin === "derived"
    );
  return true;
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

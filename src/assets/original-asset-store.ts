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
import type { IntegrityReport } from "./asset-store.js";

const extensionPattern = /^[a-z0-9]{1,10}$/;
const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export const originalAssetRecordSchema = z
  .object({
    id: z.string().regex(ulidPattern),
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    sha256: z.string().regex(sha256Pattern),
    sourceMime: z.enum(["image/jpeg", "image/png", "image/heic", "image/heif"]),
    extension: z.enum(["heic", "heif", "jpg", "jpeg", "png"]),
    bytes: z.number().int().positive(),
    refCount: z.number().int().positive(),
  })
  .strict()
  .superRefine((record, context) => {
    const expected = sourceExtensions[record.sourceMime];
    if (!expected.includes(record.extension)) {
      context.addIssue({
        code: "custom",
        path: ["extension"],
        message: "ORIGINAL_MIME_EXTENSION_MISMATCH",
      });
    }
  });

export type OriginalAssetRecord = z.infer<typeof originalAssetRecordSchema>;

export interface OriginalAssetInput {
  bytes: Buffer;
  extension: string;
  sourceMime: OriginalAssetRecord["sourceMime"];
}

export interface PreparedOriginalAsset {
  record: OriginalAssetRecord;
  isNew: boolean;
}

/**
 * Exact uploads live here and deliberately have no conversion to AssetRecord.
 * Provider-facing code accepts neither this class nor OriginalAssetRecord IDs.
 */
export class OriginalAssetStore {
  private readonly repository: DocumentRepository<OriginalAssetRecord>;
  private readonly hashLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: DocumentStore,
    readonly root: string,
  ) {
    this.repository = new DocumentRepository(
      store,
      "original_assets",
      originalAssetRecordSchema,
    );
  }

  async put(input: OriginalAssetInput): Promise<OriginalAssetRecord> {
    const extension = normalizeExtension(input.extension);
    this.store.secretRegistry.assertSafeBinaryPayload(input.bytes);
    const hash = sha256(input.bytes);
    return this.withHashLock(hash, () =>
      this.putLocked(input, extension, hash),
    );
  }

  async prepare(input: OriginalAssetInput): Promise<PreparedOriginalAsset> {
    const extension = normalizeExtension(input.extension);
    this.store.secretRegistry.assertSafeBinaryPayload(input.bytes);
    const hash = sha256(input.bytes);
    const existing = this.findBySha(hash);
    if (existing) {
      assertCompatible(
        existing,
        input.sourceMime,
        extension,
        input.bytes.length,
      );
      await this.atomicWrite(this.pathForRecord(existing), input.bytes, hash);
      return { record: existing, isNew: false };
    }
    const now = new Date().toISOString();
    const record = originalAssetRecordSchema.parse({
      id: ulid(),
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      sha256: hash,
      sourceMime: input.sourceMime,
      extension,
      bytes: input.bytes.length,
      refCount: 1,
    });
    this.store.assertSafeForPersistence(record);
    await this.atomicWrite(this.pathForRecord(record), input.bytes, hash);
    return { record, isNew: true };
  }

  /** Commit inside the caller's DocumentStore transaction. */
  commitPrepared(prepared: PreparedOriginalAsset): OriginalAssetRecord {
    const parsed = originalAssetRecordSchema.parse(prepared.record);
    const existing = this.findBySha(parsed.sha256);
    if (existing) {
      assertCompatible(
        existing,
        parsed.sourceMime,
        parsed.extension,
        parsed.bytes,
      );
      return this.incrementReference(existing);
    }
    return this.repository.put(parsed);
  }

  async discardPrepared(prepared: PreparedOriginalAsset): Promise<void> {
    if (!prepared.isNew || this.findBySha(prepared.record.sha256)) return;
    await rm(this.pathForRecord(prepared.record), { force: true });
    await syncDirectory(dirname(this.pathForRecord(prepared.record)));
  }

  get(id: string): OriginalAssetRecord | null {
    return this.repository.get(id);
  }

  list(): OriginalAssetRecord[] {
    return this.repository.list();
  }

  pathForRecord(record: OriginalAssetRecord): string {
    return join(
      this.root,
      record.sha256.slice(0, 2),
      `${record.sha256}.${record.extension}`,
    );
  }

  async read(id: string): Promise<Buffer> {
    const record = this.requireRecord(id);
    const bytes = await readManagedFile(this.pathForRecord(record));
    if (sha256(bytes) !== record.sha256)
      throw new Error("ORIGINAL_ASSET_CHECKSUM_MISMATCH");
    return bytes;
  }

  retain(id: string): OriginalAssetRecord {
    return this.store.transaction(() =>
      this.incrementReference(this.requireRecord(id)),
    );
  }

  async release(id: string): Promise<OriginalAssetRecord | null> {
    const snapshot = this.requireRecord(id);
    return this.withHashLock(snapshot.sha256, async () => {
      let unlinked: OriginalAssetRecord | null = null;
      const retained = this.store.transaction(() => {
        const record = this.requireRecord(id);
        if (record.refCount > 1) {
          return this.repository.put({
            ...record,
            refCount: record.refCount - 1,
            updatedAt: new Date().toISOString(),
          });
        }
        this.repository.delete(id);
        unlinked = record;
        return null;
      });
      if (unlinked) {
        await rm(this.pathForRecord(unlinked), { force: true });
        await syncDirectory(dirname(this.pathForRecord(unlinked)));
      }
      return retained;
    });
  }

  async scanIntegrity(): Promise<IntegrityReport> {
    const records = this.repository.list();
    const issues: IntegrityReport["issues"] = [];
    for (const record of records) {
      try {
        const bytes = await readManagedFile(this.pathForRecord(record));
        if (sha256(bytes) !== record.sha256)
          issues.push({ assetId: record.id, reason: "checksum_mismatch" });
      } catch (error) {
        if (hasCode(error, "ENOENT"))
          issues.push({ assetId: record.id, reason: "missing" });
        else throw error;
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
      this.list().map((record) => this.pathForRecord(record)),
    );
    const files = await listFiles(this.root);
    const removed: string[] = [];
    for (const file of files) {
      if (indexed.has(file) || !isCollectibleOriginal(file, this.root))
        continue;
      await rm(file, { force: true });
      removed.push(file);
    }
    return removed;
  }

  private async putLocked(
    input: OriginalAssetInput,
    extension: string,
    hash: string,
  ): Promise<OriginalAssetRecord> {
    const existing = this.findBySha(hash);
    if (existing) {
      assertCompatible(
        existing,
        input.sourceMime,
        extension,
        input.bytes.length,
      );
      await this.atomicWrite(this.pathForRecord(existing), input.bytes, hash);
      return this.store.transaction(() =>
        this.incrementReference(this.requireHash(hash)),
      );
    }

    const now = new Date().toISOString();
    const record = originalAssetRecordSchema.parse({
      id: ulid(),
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      sha256: hash,
      sourceMime: input.sourceMime,
      extension,
      bytes: input.bytes.length,
      refCount: 1,
    });
    this.store.assertSafeForPersistence(record);
    await this.atomicWrite(this.pathForRecord(record), input.bytes, hash);
    return this.store.transaction(() => {
      const raced = this.findBySha(hash);
      if (!raced) return this.repository.put(record);
      assertCompatible(raced, input.sourceMime, extension, input.bytes.length);
      return this.incrementReference(raced);
    });
  }

  private findBySha(hash: string): OriginalAssetRecord | null {
    const records = this.repository.queryByField("sha256", hash);
    if (records.length > 1) throw new Error("DUPLICATE_ORIGINAL_ASSET_HASH");
    return records[0] ?? null;
  }

  private requireHash(hash: string): OriginalAssetRecord {
    const record = this.findBySha(hash);
    if (!record) throw new Error("ORIGINAL_ASSET_NOT_FOUND");
    return record;
  }

  private requireRecord(id: string): OriginalAssetRecord {
    const record = this.repository.get(id);
    if (!record) throw new Error("ORIGINAL_ASSET_NOT_FOUND");
    return record;
  }

  private incrementReference(record: OriginalAssetRecord): OriginalAssetRecord {
    return this.repository.put({
      ...record,
      refCount: record.refCount + 1,
      updatedAt: new Date().toISOString(),
    });
  }

  private async atomicWrite(
    target: string,
    bytes: Buffer,
    expectedHash: string,
  ): Promise<void> {
    await preparePrefix(dirname(target));
    const existing = await readIfPresent(target);
    if (existing) {
      if (sha256(existing) !== expectedHash)
        throw new Error("ORIGINAL_ASSET_FILE_CONFLICT");
      return;
    }
    const temporary = join(dirname(target), `.hekayati-tmp-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await chmod(target, 0o600);
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
}

function normalizeExtension(extension: string): string {
  const value = extension.replace(/^\./, "").toLowerCase();
  if (!extensionPattern.test(value))
    throw new Error("INVALID_ORIGINAL_EXTENSION");
  return value;
}

const sourceExtensions: Record<
  OriginalAssetRecord["sourceMime"],
  readonly string[]
> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/heic": ["heic"],
  "image/heif": ["heif"],
};

function assertCompatible(
  record: OriginalAssetRecord,
  sourceMime: OriginalAssetRecord["sourceMime"],
  extension: string,
  bytes: number,
): void {
  if (
    !isDeepStrictEqual(
      {
        sourceMime: record.sourceMime,
        extension: record.extension,
        bytes: record.bytes,
      },
      { sourceMime, extension, bytes },
    )
  )
    throw new Error("ORIGINAL_ASSET_METADATA_CONFLICT");
}

async function preparePrefix(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("INVALID_ORIGINAL_ASSET_DIRECTORY");
  await chmod(directory, 0o700);
}

async function readManagedFile(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1)
      throw new Error("INVALID_ORIGINAL_ASSET_FILE");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readIfPresent(file: string): Promise<Buffer | null> {
  try {
    return await readManagedFile(file);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isCollectibleOriginal(file: string, root: string): boolean {
  const name = basename(file);
  const parent = dirname(file);
  const prefix = basename(parent);
  if (dirname(parent) !== root || !/^[a-f0-9]{2}$/.test(prefix)) return false;
  if (/^\.hekayati-tmp-[A-Za-z0-9-]{1,80}$/.test(name)) return true;
  return (
    /^[a-f0-9]{64}\.[a-z0-9]{1,10}$/.test(name) && prefix === name.slice(0, 2)
  );
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
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

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (!hasCode(error, "EINVAL") && !hasCode(error, "ENOTSUP")) throw error;
  } finally {
    await handle.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

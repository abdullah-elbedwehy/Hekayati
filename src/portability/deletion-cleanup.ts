import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { AssetStore } from "../assets/asset-store.js";
import {
  validateMediaCleanupIntent,
  type MediaCleanupIntent,
} from "../assets/media-reference.js";
import type { OriginalAssetStore } from "../assets/original-asset-store.js";
import type { ManagedUnlinkLedgerEntry } from "../domain/portability/deletion-ledger.js";
import type { DocumentStore } from "../domain/repository/document-store.js";

const archiveKeyPattern = /^[0-9A-HJKMNP-TV-Z]{26}-[a-f0-9]{64}\.zip$/;

export interface ManagedDeletionCleanupHooks {
  beforeUnlink?(
    entry: Readonly<ManagedUnlinkLedgerEntry>,
  ): Promise<void> | void;
}

export interface ManagedDeletionCleanupOptions {
  store: DocumentStore;
  assets: AssetStore;
  originals: OriginalAssetStore;
  managedExportsRoot: string;
  hooks?: ManagedDeletionCleanupHooks;
}

export interface ManagedDeletionVerification {
  passed: boolean;
  failureCode: string | null;
}

export class ManagedDeletionCleanup {
  private readonly exportRoot: string;

  constructor(private readonly options: ManagedDeletionCleanupOptions) {
    this.exportRoot = resolve(options.managedExportsRoot);
  }

  async execute(
    entries: readonly ManagedUnlinkLedgerEntry[],
  ): Promise<ManagedUnlinkLedgerEntry[]> {
    const results: ManagedUnlinkLedgerEntry[] = [];
    for (const entry of entries) results.push(await this.executeOne(entry));
    return results;
  }

  async verify(
    entry: ManagedUnlinkLedgerEntry,
  ): Promise<ManagedDeletionVerification> {
    if (entry.state === "pending" || entry.state === "blocked")
      return failed("DELETION_CLEANUP_INCOMPLETE");
    if (entry.namespace === "export") return this.verifyExport(entry);
    return this.verifyMedia(entry);
  }

  private async executeOne(
    entry: ManagedUnlinkLedgerEntry,
  ): Promise<ManagedUnlinkLedgerEntry> {
    if (entry.state === "unlinked" || entry.state === "preserved") return entry;
    try {
      await this.options.hooks?.beforeUnlink?.(entry);
      const outcome =
        entry.namespace === "export"
          ? await this.unlinkExport(entry)
          : await this.unlinkMedia(entry);
      return {
        ...entry,
        state: outcome,
        attempts: entry.attempts + 1,
        failureCode: null,
      };
    } catch (error) {
      return {
        ...entry,
        state: "blocked",
        attempts: entry.attempts + 1,
        failureCode: cleanupFailureCode(error),
      };
    }
  }

  private async unlinkMedia(
    entry: ManagedUnlinkLedgerEntry,
  ): Promise<"unlinked" | "preserved"> {
    if (entry.namespace === "export")
      throw new Error("DELETION_MEDIA_NAMESPACE_INVALID");
    const intent = mediaIntent(entry);
    const outcome =
      entry.namespace === "asset"
        ? await this.options.assets.unlinkCleanupIntent({
            ...intent,
            namespace: "asset",
          })
        : await this.options.originals.unlinkCleanupIntent({
            ...intent,
            namespace: "original",
          });
    return outcome === "preserved" ? "preserved" : "unlinked";
  }

  private async unlinkExport(
    entry: ManagedUnlinkLedgerEntry,
  ): Promise<"unlinked"> {
    validateExportEntry(entry);
    if (documentExists(this.options.store, "managed_exports", entry.mediaId))
      throw new Error("DELETION_EXPORT_INDEX_PRESENT");
    const path = join(this.exportRoot, entry.managedKey);
    const handle = await openForCleanup(path);
    if (!handle) return "unlinked";
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1)
        throw new Error("DELETION_EXPORT_FILE_INVALID");
      const actual = await hashHandle(handle);
      if (actual.sha256 !== entry.checksum || actual.bytes !== entry.bytes)
        throw new Error("DELETION_EXPORT_CHECKSUM_MISMATCH");
    } finally {
      await handle.close();
    }
    const identity = await lstat(path);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1)
      throw new Error("DELETION_EXPORT_FILE_INVALID");
    await unlink(path);
    await syncDirectory(dirname(path));
    return "unlinked";
  }

  private async verifyMedia(
    entry: ManagedUnlinkLedgerEntry,
  ): Promise<ManagedDeletionVerification> {
    const record =
      entry.namespace === "asset"
        ? this.options.assets.get(entry.mediaId)
        : this.options.originals.get(entry.mediaId);
    if (entry.state === "unlinked") {
      if (record) return failed("DELETION_MEDIA_INDEX_PRESENT");
      return (await pathExists(this.mediaPath(entry)))
        ? failed("DELETION_MANAGED_FILE_PRESENT")
        : passed();
    }
    if (!record || record.sha256 !== entry.checksum)
      return failed("DELETION_SHARED_MEDIA_MISSING");
    try {
      const bytes =
        entry.namespace === "asset"
          ? await this.options.assets.read(entry.mediaId)
          : await this.options.originals.read(entry.mediaId);
      return sha256(bytes) === entry.checksum
        ? passed()
        : failed("DELETION_SHARED_MEDIA_CHECKSUM_MISMATCH");
    } catch {
      return failed("DELETION_SHARED_MEDIA_CHECKSUM_MISMATCH");
    }
  }

  private async verifyExport(
    entry: ManagedUnlinkLedgerEntry,
  ): Promise<ManagedDeletionVerification> {
    if (entry.state !== "unlinked")
      return failed("DELETION_EXPORT_NOT_UNLINKED");
    if (documentExists(this.options.store, "managed_exports", entry.mediaId))
      return failed("DELETION_EXPORT_INDEX_PRESENT");
    validateExportEntry(entry);
    return (await pathExists(join(this.exportRoot, entry.managedKey)))
      ? failed("DELETION_MANAGED_FILE_PRESENT")
      : passed();
  }

  private mediaPath(entry: ManagedUnlinkLedgerEntry): string {
    const intent = mediaIntent(entry);
    const root =
      entry.namespace === "asset"
        ? this.options.assets.root
        : this.options.originals.root;
    return join(root, ...intent.managedKey.split("/"));
  }
}

function mediaIntent(
  entry: ManagedUnlinkLedgerEntry,
): MediaCleanupIntent<"asset"> | MediaCleanupIntent<"original"> {
  if (entry.namespace === "export")
    throw new Error("DELETION_MEDIA_NAMESPACE_INVALID");
  const intent = {
    namespace: entry.namespace,
    mediaId: entry.mediaId,
    checksum: entry.checksum,
    managedKey: entry.managedKey,
  };
  validateMediaCleanupIntent(intent, entry.namespace);
  return intent;
}

function validateExportEntry(entry: ManagedUnlinkLedgerEntry): void {
  if (
    entry.namespace !== "export" ||
    entry.bytes === null ||
    !archiveKeyPattern.test(entry.managedKey) ||
    entry.managedKey !== `${entry.mediaId}-${entry.checksum}.zip`
  )
    throw new Error("DELETION_EXPORT_INTENT_INVALID");
}

async function openForCleanup(path: string) {
  try {
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function hashHandle(handle: Awaited<ReturnType<typeof open>>) {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = handle.createReadStream({ autoClose: false, start: 0 });
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    hash.update(value);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } catch (error) {
    if (!hasCode(error, "EINVAL") && !hasCode(error, "ENOTSUP")) throw error;
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function documentExists(
  store: DocumentStore,
  collection: string,
  id: string,
): boolean {
  return (
    store.database
      .prepare("SELECT 1 FROM documents WHERE collection = ? AND id = ?")
      .get(collection, id) !== undefined
  );
}

function cleanupFailureCode(error: unknown): string {
  if (hasCode(error, "EACCES") || hasCode(error, "EPERM"))
    return "DELETION_CLEANUP_EACCES";
  if (hasCode(error, "ENOSPC")) return "DELETION_CLEANUP_ENOSPC";
  const message = error instanceof Error ? error.message : "";
  if (message.includes("CHECKSUM")) return "DELETION_CLEANUP_CHECKSUM_MISMATCH";
  if (message.includes("INDEX_PRESENT"))
    return "DELETION_CLEANUP_INDEX_PRESENT";
  if (message.includes("INVALID")) return "DELETION_CLEANUP_INVALID_FILE";
  return "DELETION_CLEANUP_FAILED";
}

function passed(): ManagedDeletionVerification {
  return { passed: true, failureCode: null };
}

function failed(failureCode: string): ManagedDeletionVerification {
  return { passed: false, failureCode };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

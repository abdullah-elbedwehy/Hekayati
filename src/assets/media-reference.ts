import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { DocumentStore } from "../domain/repository/document-store.js";

export type MediaNamespace = "asset" | "original";
export type MediaHoldDisposition = "acquired" | "replayed";
export type MediaCleanupOutcome = "unlinked" | "absent" | "preserved";

/**
 * Runs inside the caller's transaction. Return `acquired` only after inserting
 * the operation-owned durable hold row; an existing same hold returns `replayed`.
 */
export type MediaHoldClaim = () => MediaHoldDisposition;

export interface MediaCleanupIntent<
  Namespace extends MediaNamespace = MediaNamespace,
> {
  namespace: Namespace;
  mediaId: string;
  checksum: string;
  managedKey: string;
}

export interface MediaHoldResult<Record> {
  record: Record;
  acquired: boolean;
}

export interface MediaReleaseResult<Record, Namespace extends MediaNamespace> {
  record: Record | null;
  cleanupIntent: MediaCleanupIntent<Namespace> | null;
}

interface CleanupRecord {
  id: string;
  sha256: string;
  extension: string;
}

const mediaIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const checksumPattern = /^[a-f0-9]{64}$/;
const extensionPattern = /^[a-z0-9]{1,10}$/;

export function assertMediaReferenceTransaction(store: DocumentStore): void {
  if (!store.database.inTransaction)
    throw new Error("MEDIA_REFERENCE_TRANSACTION_REQUIRED");
}

export function assertMediaCleanupOutsideTransaction(
  store: DocumentStore,
): void {
  if (store.database.inTransaction)
    throw new Error("MEDIA_CLEANUP_TRANSACTION_FORBIDDEN");
}

export function mediaCleanupIntent<Namespace extends MediaNamespace>(
  namespace: Namespace,
  record: CleanupRecord,
): MediaCleanupIntent<Namespace> {
  return {
    namespace,
    mediaId: record.id,
    checksum: record.sha256,
    managedKey: managedKey(record),
  };
}

export function validateMediaCleanupIntent<Namespace extends MediaNamespace>(
  intent: MediaCleanupIntent<Namespace>,
  namespace: Namespace,
): void {
  if (
    !intent ||
    intent.namespace !== namespace ||
    typeof intent.mediaId !== "string" ||
    !mediaIdPattern.test(intent.mediaId) ||
    typeof intent.checksum !== "string" ||
    !checksumPattern.test(intent.checksum)
  )
    throw new Error("MEDIA_CLEANUP_INTENT_INVALID");
  const prefix = intent.checksum.slice(0, 2);
  const start = `${prefix}/${intent.checksum}.`;
  if (
    typeof intent.managedKey !== "string" ||
    !intent.managedKey.startsWith(start)
  )
    throw new Error("MEDIA_CLEANUP_INTENT_INVALID");
  const extension = intent.managedKey.slice(start.length);
  if (
    !extensionPattern.test(extension) ||
    (namespace === "original" &&
      !["heic", "heif", "jpg", "jpeg", "png"].includes(extension)) ||
    intent.managedKey !== `${start}${extension}`
  )
    throw new Error("MEDIA_CLEANUP_INTENT_INVALID");
}

export function unlinkManagedCleanupIntentSync(
  root: string,
  intent: MediaCleanupIntent,
): Exclude<MediaCleanupOutcome, "preserved"> {
  const target = join(root, ...intent.managedKey.split("/"));
  let descriptor: number;
  try {
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return "absent";
    throw new Error("INVALID_MEDIA_CLEANUP_FILE", { cause: error });
  }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1)
      throw new Error("INVALID_MEDIA_CLEANUP_FILE");
    const checksum = createHash("sha256")
      .update(readFileSync(descriptor))
      .digest("hex");
    if (checksum !== intent.checksum)
      throw new Error("MEDIA_CLEANUP_CHECKSUM_MISMATCH");
  } finally {
    closeSync(descriptor);
  }
  unlinkSync(target);
  syncDirectorySync(dirname(target));
  return "unlinked";
}

function managedKey(record: CleanupRecord): string {
  return `${record.sha256.slice(0, 2)}/${record.sha256}.${record.extension}`;
}

function syncDirectorySync(directory: string): void {
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } catch (error) {
    if (!hasCode(error, "EINVAL") && !hasCode(error, "ENOTSUP")) throw error;
  } finally {
    closeSync(descriptor);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

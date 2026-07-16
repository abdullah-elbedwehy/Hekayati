import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  createReadStream,
  fstatSync,
  openSync,
  type ReadStream,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import type {
  PortabilitySnapshotEntry,
  SnapshotMediaEntry,
} from "../domain/portability/export-model.js";
import type { StagedArchiveSource } from "./export.js";

export interface SnapshotMediaRoots {
  assetRoot: string;
  originalRoot: string;
}

export function snapshotArchiveSources(
  entries: readonly PortabilitySnapshotEntry[],
  roots: SnapshotMediaRoots,
): StagedArchiveSource[] {
  const normalizedRoots = {
    assetRoot: resolve(roots.assetRoot),
    originalRoot: resolve(roots.originalRoot),
  };
  return [...entries]
    .sort((left, right) => left.archiveEntry.localeCompare(right.archiveEntry))
    .map((entry) =>
      entry.entryType === "document"
        ? documentSource(entry)
        : mediaSource(entry, normalizedRoots),
    );
}

function documentSource(
  entry: Extract<PortabilitySnapshotEntry, { entryType: "document" }>,
): StagedArchiveSource {
  const bytes = Buffer.from(entry.canonicalDocument, "utf8");
  if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256)
    throw new Error("PORTABILITY_SNAPSHOT_DOCUMENT_SOURCE_MISMATCH");
  return {
    path: entry.archiveEntry,
    bytes: entry.bytes,
    sha256: entry.sha256,
    open: () => Readable.from(bytes),
  };
}

function mediaSource(
  entry: SnapshotMediaEntry,
  roots: SnapshotMediaRoots,
): StagedArchiveSource {
  const root =
    entry.namespace === "asset" ? roots.assetRoot : roots.originalRoot;
  const target = resolve(
    join(root, entry.sha256.slice(0, 2), `${entry.sha256}.${entry.extension}`),
  );
  if (!target.startsWith(`${root}${sep}`))
    throw new Error("PORTABILITY_SNAPSHOT_MEDIA_PATH_INVALID");
  return {
    path: entry.archiveEntry,
    bytes: entry.bytes,
    sha256: entry.sha256,
    open: () => openPrivateMedia(target, entry),
  };
}

function openPrivateMedia(
  target: string,
  entry: SnapshotMediaEntry,
): ReadStream {
  const descriptor = openSync(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = fstatSync(descriptor);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size !== entry.bytes ||
      (info.mode & 0o077) !== 0
    )
      throw new Error("PORTABILITY_SNAPSHOT_MEDIA_FILE_INVALID");
    return createReadStream(target, { fd: descriptor, autoClose: true });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

import { createHash } from "node:crypto";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import type { PortabilitySnapshotEntry } from "../../src/domain/portability/export-model.js";
import { snapshotArchiveSources } from "../../src/portability/snapshot-sources.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-16T00:00:00.000Z";
const snapshotId = "01KZX48ZM9N74CRKFWQTJ76X2S";
const operationId = "01KZX48ZM9N74CRKFWQTJ76X2O";
const documentId = "01KZX48ZM9N74CRKFWQTJ76X2D";
const mediaId = "01KZX48ZM9N74CRKFWQTJ76X2M";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("snapshot archive sources", () => {
  it("opens only canonical frozen rows and exact private held media", async () => {
    const fixture = await sourceFixture();
    const document = Buffer.from('{"safe":true}');
    const media = Buffer.from("held-private-media");
    const frozenDocument = documentEntry(document);
    const frozenMedia = mediaEntry(media);
    const entries = [frozenDocument, frozenMedia];
    await writeManaged(fixture.assetRoot, frozenMedia, media);

    const sources = snapshotArchiveSources([...entries].reverse(), fixture);
    expect(sources.map((source) => source.path)).toEqual(
      [frozenDocument.archiveEntry, frozenMedia.archiveEntry].sort(),
    );
    await expect(readAll(sources[0].open())).resolves.toEqual(document);
    await expect(readAll(sources[1].open())).resolves.toEqual(media);
  });

  it("rejects drifted metadata and no-follow media violations", async () => {
    const fixture = await sourceFixture();
    const document = Buffer.from('{"safe":true}');
    expect(() =>
      snapshotArchiveSources(
        [{ ...documentEntry(document), sha256: "f".repeat(64) }],
        fixture,
      ),
    ).toThrow("PORTABILITY_SNAPSHOT_DOCUMENT_SOURCE_MISMATCH");

    const media = Buffer.from("held-private-media");
    const entry = mediaEntry(media);
    const target = managedPath(fixture.assetRoot, entry);
    await mkdir(join(fixture.assetRoot, entry.sha256.slice(0, 2)), {
      recursive: true,
      mode: 0o700,
    });
    const external = join(fixture.root, "external.bin");
    await writeFile(external, media, { mode: 0o600 });
    await symlink(external, target);
    const source = snapshotArchiveSources([entry], fixture)[0];
    expect(() => source.open()).toThrow();
  });
});

async function sourceFixture() {
  const directory = await temporaryDirectory("hekayati-snapshot-source-");
  cleanups.push(directory.cleanup);
  const assetRoot = join(directory.path, "assets");
  const originalRoot = join(directory.path, "originals");
  await mkdir(assetRoot, { recursive: true, mode: 0o700 });
  await mkdir(originalRoot, { recursive: true, mode: 0o700 });
  return { root: directory.path, assetRoot, originalRoot };
}

async function writeManaged(
  root: string,
  entry: Extract<PortabilitySnapshotEntry, { entryType: "media" }>,
  bytes: Buffer,
): Promise<void> {
  const target = managedPath(root, entry);
  await mkdir(join(root, entry.sha256.slice(0, 2)), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(target, bytes, { mode: 0o600 });
  await chmod(target, 0o600);
}

function managedPath(
  root: string,
  entry: Extract<PortabilitySnapshotEntry, { entryType: "media" }>,
): string {
  return join(
    root,
    entry.sha256.slice(0, 2),
    `${entry.sha256}.${entry.extension}`,
  );
}

function documentEntry(
  bytes: Buffer,
): Extract<PortabilitySnapshotEntry, { entryType: "document" }> {
  return {
    id: "01KZX48ZM9N74CRKFWQTJ76X2A",
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    snapshotId,
    operationId,
    ordinal: 0,
    entryType: "document",
    archiveEntry: `data/projects/${documentId}.json`,
    collection: "projects",
    documentId,
    documentSchemaVersion: 1,
    reasons: ["direct:project"],
    canonicalDocument: bytes.toString("utf8"),
    bytes: bytes.byteLength,
    sha256: hash(bytes),
  };
}

function mediaEntry(
  bytes: Buffer,
): Extract<PortabilitySnapshotEntry, { entryType: "media" }> {
  const checksum = hash(bytes);
  return {
    id: "01KZX48ZM9N74CRKFWQTJ76X2B",
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    snapshotId,
    operationId,
    ordinal: 1,
    entryType: "media",
    archiveEntry: `media/assets/${checksum}.bin`,
    namespace: "asset",
    mediaId,
    role: "thumbnail",
    mime: "application/octet-stream",
    extension: "bin",
    bytes: bytes.byteLength,
    sha256: checksum,
    occurrenceCount: 1,
    ownedCount: 1,
    referencedCount: 0,
    outsideScopeOccurrenceCount: 0,
    preHoldRefCount: 1,
    disposition: "scope_only",
  };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

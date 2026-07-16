import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  openSync,
} from "node:fs";
import { Readable, Transform, type TransformCallback } from "node:stream";

import { fromFdPromise, type Entry, type ZipFile } from "yauzl";

import { canonicalJson } from "../contracts/canonical-json.js";
import type { StagedArchiveSource, WrittenArchive } from "./export.js";
import { parseManifestBytes, type ManifestV2 } from "./manifest.js";
import type { SecretReleaseGate, SecretScanFinding } from "./secret-scan.js";

export type ArchiveReleaseVerification =
  | { ok: true; archive: WrittenArchive }
  | { ok: false; finding: SecretScanFinding };

interface ExpectedEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export async function scanStagedArchive(
  candidateManifest: ManifestV2,
  sources: ReadonlyArray<StagedArchiveSource>,
  gate: SecretReleaseGate,
): Promise<SecretScanFinding | null> {
  const manifestBytes = Buffer.from(canonicalJson(candidateManifest), "utf8");
  const manifest = parseManifestBytes(manifestBytes);
  const expected = buildExpectedEntries(manifest, manifestBytes);
  const byPath = indexStagedSources(sources);
  if (byPath.size !== expected.length - 1)
    throw new Error("PORTABILITY_ARCHIVE_SOURCE_SET_MISMATCH");
  const manifestFinding = await scanReadable(
    "manifest.json",
    Readable.from(manifestBytes),
    expected[0],
    gate,
  );
  if (manifestFinding) return manifestFinding;
  for (const entry of expected.slice(1)) {
    const source = byPath.get(entry.path);
    if (!source) throw new Error("PORTABILITY_ARCHIVE_SOURCE_SET_MISMATCH");
    if (source.bytes !== entry.bytes || source.sha256 !== entry.sha256)
      throw new Error("PORTABILITY_ARCHIVE_SOURCE_METADATA_MISMATCH");
    const nameFinding = gate.scanEntryName(entry.path);
    if (nameFinding) return nameFinding;
    const finding = await scanReadable(
      entry.path,
      openSource(source),
      entry,
      gate,
    );
    if (finding) return finding;
  }
  return null;
}

export async function verifyFinalizedArchive(
  archivePath: string,
  candidateManifest: ManifestV2,
  expectedArchive: WrittenArchive,
  gate: SecretReleaseGate,
): Promise<ArchiveReleaseVerification> {
  const manifestBytes = Buffer.from(canonicalJson(candidateManifest), "utf8");
  const manifest = parseManifestBytes(manifestBytes);
  const descriptor = openSync(
    archivePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let transferred = false;
  try {
    assertPrivateRegularFile(descriptor);
    await assertExpectedArchive(descriptor, expectedArchive);
    transferred = true;
    const result = await scanZipEntries(
      descriptor,
      manifest,
      manifestBytes,
      expectedArchive,
      gate,
    );
    return result.finding
      ? { ok: false, finding: result.finding }
      : { ok: true, archive: result.archive };
  } finally {
    if (!transferred) closeSync(descriptor);
  }
}

async function scanZipEntries(
  descriptor: number,
  manifest: ManifestV2,
  manifestBytes: Buffer,
  expectedArchive: WrittenArchive,
  gate: SecretReleaseGate,
): Promise<
  | { finding: SecretScanFinding; archive?: never }
  | { finding?: never; archive: WrittenArchive }
> {
  let zip: ZipFile;
  try {
    zip = await fromFdPromise(descriptor, {
      autoClose: false,
      validateEntrySizes: true,
      strictFileNames: true,
    });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  try {
    if (zip.fileSize !== expectedArchive.bytes)
      throw new Error("PORTABILITY_ARCHIVE_CHECKSUM_MISMATCH");
    const expectedEntries = buildExpectedEntries(manifest, manifestBytes);
    let index = 0;
    for await (const entry of zip.eachEntry()) {
      const expected = expectedEntries[index];
      if (!expected || entry.fileName !== expected.path)
        throw new Error("PORTABILITY_ARCHIVE_ENTRY_SET_MISMATCH");
      const finding = await scanEntry(zip, entry, expected, gate);
      if (finding) return { finding };
      index += 1;
    }
    if (index !== expectedEntries.length)
      throw new Error("PORTABILITY_ARCHIVE_ENTRY_SET_MISMATCH");
    assertPrivateRegularFile(descriptor);
    return {
      archive: await assertExpectedArchive(descriptor, expectedArchive),
    };
  } finally {
    await closeZip(zip);
  }
}

async function assertExpectedArchive(
  descriptor: number,
  expectedArchive: WrittenArchive,
): Promise<WrittenArchive> {
  const actual = await hashFile(descriptor);
  if (
    actual.bytes !== expectedArchive.bytes ||
    actual.sha256 !== expectedArchive.sha256
  )
    throw new Error("PORTABILITY_ARCHIVE_CHECKSUM_MISMATCH");
  return actual;
}

async function scanEntry(
  zip: ZipFile,
  entry: Entry,
  expected: ExpectedEntry,
  gate: SecretReleaseGate,
): Promise<SecretScanFinding | null> {
  if (
    entry.isEncrypted() ||
    !entry.canDecodeFileData() ||
    entry.uncompressedSize !== expected.bytes ||
    !isRegularFile(entry.externalFileAttributes)
  )
    throw new Error("PORTABILITY_ARCHIVE_ENTRY_INVALID");
  const nameFinding = gate.scanEntryName(entry.fileName);
  if (nameFinding) return nameFinding;
  const source = await zip.openReadStreamPromise(entry);
  return scanReadable(entry.fileName, source, expected, gate);
}

async function scanReadable(
  entry: string,
  source: Readable,
  expected: ExpectedEntry,
  gate: SecretReleaseGate,
): Promise<SecretScanFinding | null> {
  const verifier = new EntryIntegrityVerifier(expected);
  source.once("error", (error: unknown) => verifier.destroy(toError(error)));
  source.pipe(verifier);
  const finding = await gate.scanStream(entry, verifier);
  if (finding) source.destroy();
  return finding;
}

function indexStagedSources(
  sources: ReadonlyArray<StagedArchiveSource>,
): Map<string, StagedArchiveSource> {
  const indexed = new Map<string, StagedArchiveSource>();
  for (const source of sources) {
    if (indexed.has(source.path))
      throw new Error("PORTABILITY_ARCHIVE_DUPLICATE_SOURCE");
    indexed.set(source.path, source);
  }
  return indexed;
}

function openSource(source: StagedArchiveSource): Readable {
  try {
    return source.open();
  } catch (error) {
    throw new Error("PORTABILITY_ARCHIVE_SOURCE_OPEN_FAILED", {
      cause: error,
    });
  }
}

function buildExpectedEntries(
  manifest: ManifestV2,
  manifestBytes: Buffer,
): ExpectedEntry[] {
  return [
    {
      path: "manifest.json",
      bytes: manifestBytes.byteLength,
      sha256: sha256(manifestBytes),
    },
    ...manifest.documents,
    ...manifest.media,
  ];
}

class EntryIntegrityVerifier extends Transform {
  readonly #expected: ExpectedEntry;
  readonly #hash = createHash("sha256");
  #bytes = 0;

  constructor(expected: ExpectedEntry) {
    super();
    this.#expected = expected;
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.#bytes += bytes.byteLength;
    this.#hash.update(bytes);
    callback(null, bytes);
  }

  override _flush(callback: TransformCallback): void {
    if (this.#bytes !== this.#expected.bytes) {
      callback(new Error("PORTABILITY_ARCHIVE_ENTRY_BYTES_MISMATCH"));
      return;
    }
    if (this.#hash.digest("hex") !== this.#expected.sha256) {
      callback(new Error("PORTABILITY_ARCHIVE_ENTRY_CHECKSUM_MISMATCH"));
      return;
    }
    callback();
  }
}

async function hashFile(descriptor: number): Promise<WrittenArchive> {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream("", {
    fd: descriptor,
    autoClose: false,
    start: 0,
  });
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    hash.update(value);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function assertPrivateRegularFile(descriptor: number): void {
  const info = fstatSync(descriptor);
  if (!info.isFile() || info.nlink !== 1)
    throw new Error("PORTABILITY_ARCHIVE_FILE_INVALID");
  if ((info.mode & 0o777) !== 0o600)
    throw new Error("PORTABILITY_ARCHIVE_PERMISSIONS_INVALID");
}

async function closeZip(zip: ZipFile): Promise<void> {
  if (!zip.isOpen) return;
  const closed = once(zip, "close");
  zip.close();
  await closed;
}

function isRegularFile(externalFileAttributes: number): boolean {
  const mode = externalFileAttributes >>> 16;
  return (mode & 0o170000) === 0o100000;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

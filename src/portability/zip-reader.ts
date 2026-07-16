import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import { openPromise, type Entry, type ZipFile } from "yauzl";

import { canonicalJson } from "../contracts/canonical-json.js";
import type { SecretReleaseGate } from "./secret-scan.js";
import {
  ARCHIVE_POLICY_V1,
  ArchivePolicyMeter,
  ArchiveValidationError,
  assertSafeEntryPrefix,
  safeArchiveEntry,
  type ValidatedArchiveEntry,
} from "./archive-policy.js";
import {
  normalizeImportManifestBytes,
  type NormalizedImportManifest,
} from "./import-manifest.js";
import type { ManifestV2 } from "./manifest.js";

export interface StagedImportEntry {
  archivePath: string;
  managedName: string;
  kind: "document" | "media";
  bytes: number;
  sha256: string;
}

export interface StagedImportArchive extends NormalizedImportManifest {
  stagingKey: string;
  directory: string;
  entries: readonly StagedImportEntry[];
  canonicalDocumentBytes: number;
  newContentBytes: number;
}

export interface ImportArchivePreflightFacts {
  declaredUncompressedBytes: number;
  canonicalDocumentBytes: number;
  newContentBytes: number;
}

interface InspectedEntry {
  zipEntry: Entry;
  policy: ValidatedArchiveEntry;
}

interface StageListedEntriesInput {
  archive: {
    zip: ZipFile;
    centralHandle: FileHandle;
    entries: InspectedEntry[];
  };
  manifest: ManifestV2;
  directory: string;
  secretGate: SecretReleaseGate;
}

export async function stageImportArchive(input: {
  sourcePath: string;
  stagingRoot: string;
  stagingKey: string;
  secretGate: SecretReleaseGate;
  preflight(facts: ImportArchivePreflightFacts): Promise<void> | void;
}): Promise<StagedImportArchive> {
  const archive = await inspectArchive(input.sourcePath);
  const stagingDirectory = join(input.stagingRoot, input.stagingKey);
  try {
    const normalized = await readAndNormalizeManifest(
      archive,
      input.secretGate,
    );
    assertListedEntrySet(archive.entries, normalized.manifest);
    const diskFacts = manifestDiskFacts(normalized.manifest);
    await input.preflight(diskFacts);
    await createPrivateStagingDirectory(stagingDirectory);
    const entries = await stageListedEntries({
      archive,
      manifest: normalized.manifest,
      directory: stagingDirectory,
      secretGate: input.secretGate,
    });
    await writeStagingMetadata(stagingDirectory, normalized, entries);
    return {
      ...normalized,
      stagingKey: input.stagingKey,
      directory: stagingDirectory,
      entries: Object.freeze(entries),
      canonicalDocumentBytes: diskFacts.canonicalDocumentBytes,
      newContentBytes: diskFacts.newContentBytes,
    };
  } catch (error) {
    await removeRecognizedStaging(stagingDirectory);
    throw normalizeZipError(error);
  } finally {
    archive.zip.close();
    await archive.centralHandle.close();
  }
}

export async function readStagedImportEntry(
  archive: Pick<StagedImportArchive, "directory" | "entries">,
  archivePath: string,
): Promise<Buffer> {
  const entry = archive.entries.find(
    (candidate) => candidate.archivePath === archivePath,
  );
  if (!entry)
    throw new ArchiveValidationError(
      "IMPORT_ARCHIVE_ENTRY_MISSING",
      "integrity",
      safeArchiveEntry(archivePath),
    );
  return readPrivateStagedFile(join(archive.directory, entry.managedName));
}

async function inspectArchive(sourcePath: string): Promise<{
  zip: ZipFile;
  centralHandle: FileHandle;
  entries: InspectedEntry[];
}> {
  const zip = await openArchive(sourcePath);
  assertArchiveEnvelope(zip);
  const centralHandle = await open(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const meter = new ArchivePolicyMeter();
  const entries: InspectedEntry[] = [];
  try {
    for await (const entry of zip.eachEntry()) {
      await assertEntrySingleDisk(centralHandle, zip, entry);
      assertSupportedCentralMetadata(entry);
      entries.push({ zipEntry: entry, policy: meter.add(entry) });
    }
    if (entries.length !== zip.entryCount)
      throw new ArchiveValidationError(
        "IMPORT_ARCHIVE_CENTRAL_DIRECTORY_TRUNCATED",
        "envelope",
      );
    return { zip, centralHandle, entries };
  } catch (error) {
    zip.close();
    await centralHandle.close();
    throw normalizeZipError(error);
  }
}

async function openArchive(sourcePath: string): Promise<ZipFile> {
  try {
    return await openPromise(sourcePath, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });
  } catch (error) {
    throw normalizeZipError(error);
  }
}

function assertArchiveEnvelope(zip: ZipFile): void {
  if (zip.entryCount > ARCHIVE_POLICY_V1.maxEntries) {
    zip.close();
    throw new ArchiveValidationError("IMPORT_ARCHIVE_ENTRY_LIMIT", "resource");
  }
  if (Buffer.byteLength(String(zip.comment ?? ""), "utf8") !== 0) {
    zip.close();
    throw new ArchiveValidationError(
      "IMPORT_ARCHIVE_COMMENT_UNSUPPORTED",
      "envelope",
    );
  }
}

function assertSupportedCentralMetadata(entry: Entry): void {
  if (entry.fileCommentLength !== 0)
    throw new ArchiveValidationError(
      "IMPORT_ARCHIVE_ENTRY_COMMENT_UNSUPPORTED",
      "envelope",
      safeArchiveEntry(entry.fileName),
    );
  assertExtraFields(parseExtraFieldBuffer(entry.extraFieldRaw), entry.fileName);
}

async function assertEntrySingleDisk(
  handle: FileHandle,
  zip: ZipFile,
  entry: Entry,
): Promise<void> {
  const cursor = Number(
    (zip as unknown as { readEntryCursor: number }).readEntryCursor,
  );
  const rowStart =
    cursor -
    (46 +
      entry.fileNameLength +
      entry.extraFieldLength +
      entry.fileCommentLength);
  const buffer = Buffer.alloc(2);
  const result = await handle.read(buffer, 0, 2, rowStart + 34);
  if (result.bytesRead !== 2)
    throw new ArchiveValidationError(
      "IMPORT_ARCHIVE_CENTRAL_DIRECTORY_TRUNCATED",
      "envelope",
    );
  if (buffer.readUInt16LE(0) !== 0)
    throw new ArchiveValidationError("IMPORT_ARCHIVE_MULTI_DISK", "envelope");
}

async function readAndNormalizeManifest(
  archive: {
    zip: ZipFile;
    centralHandle: FileHandle;
    entries: InspectedEntry[];
  },
  gate?: SecretReleaseGate,
): Promise<NormalizedImportManifest> {
  const manifestEntries = archive.entries.filter(
    (entry) => entry.policy.kind === "manifest",
  );
  if (manifestEntries.length !== 1)
    throw new ArchiveValidationError(
      "IMPORT_ARCHIVE_MANIFEST_MISSING",
      "manifest",
    );
  const entry = manifestEntries[0];
  await assertLocalHeader(archive.centralHandle, entry.zipEntry);
  const bytes = await readZipEntryBytes(
    archive.zip,
    entry.zipEntry,
    ARCHIVE_POLICY_V1.maxManifestBytes,
  );
  if (bytes.byteLength !== entry.policy.uncompressedBytes)
    throw new ArchiveValidationError(
      "IMPORT_ARCHIVE_MANIFEST_BYTES_MISMATCH",
      "integrity",
    );
  if (gate) {
    const finding =
      gate.scanEntryName("manifest.json") ??
      (await gate.scanStream("manifest.json", Readable.from([bytes])));
    if (finding)
      throw new ArchiveValidationError(
        "IMPORT_ARCHIVE_SECRET_FOUND",
        "secret",
        "entry-manifest",
      );
  }
  return normalizeImportManifestBytes(bytes);
}

function assertListedEntrySet(
  entries: readonly InspectedEntry[],
  manifest: ManifestV2,
): void {
  const expected = new Map(
    [...manifest.documents, ...manifest.media].map((entry) => [
      entry.path,
      entry,
    ]),
  );
  const actual = entries.filter((entry) => entry.policy.kind !== "manifest");
  if (actual.length !== expected.size)
    throw new ArchiveValidationError(
      "IMPORT_ARCHIVE_LISTED_ENTRY_SET_MISMATCH",
      "manifest",
    );
  let total = 0;
  for (const item of actual) {
    const listed = expected.get(item.policy.path);
    if (!listed)
      throw new ArchiveValidationError(
        "IMPORT_ARCHIVE_UNLISTED_ENTRY",
        "manifest",
        safeArchiveEntry(item.policy.path),
      );
    if (listed.bytes !== item.policy.uncompressedBytes)
      throw new ArchiveValidationError(
        "IMPORT_ARCHIVE_DECLARED_BYTES_MISMATCH",
        "integrity",
        safeArchiveEntry(item.policy.path),
      );
    total = safeAdd(total, listed.bytes);
    expected.delete(item.policy.path);
  }
  if (expected.size !== 0 || total !== manifest.totalUncompressedBytes)
    throw new ArchiveValidationError(
      "IMPORT_ARCHIVE_LISTED_ENTRY_SET_MISMATCH",
      "manifest",
    );
}

function manifestDiskFacts(manifest: ManifestV2): ImportArchivePreflightFacts {
  return {
    declaredUncompressedBytes: manifest.totalUncompressedBytes,
    canonicalDocumentBytes: sum(manifest.documents.map((entry) => entry.bytes)),
    newContentBytes: sum(manifest.media.map((entry) => entry.bytes)),
  };
}

async function stageListedEntries(
  input: StageListedEntriesInput,
): Promise<StagedImportEntry[]> {
  const byPath = new Map(
    input.archive.entries.map((entry) => [entry.policy.path, entry]),
  );
  const listed = [...input.manifest.documents, ...input.manifest.media].sort(
    (left, right) => left.path.localeCompare(right.path),
  );
  const result: StagedImportEntry[] = [];
  for (const [ordinal, manifestEntry] of listed.entries()) {
    const entry = byPath.get(manifestEntry.path);
    if (!entry)
      throw new ArchiveValidationError(
        "IMPORT_ARCHIVE_ENTRY_MISSING",
        "integrity",
        safeArchiveEntry(manifestEntry.path),
      );
    result.push(await stageListedEntry(input, entry, manifestEntry, ordinal));
  }
  return result;
}

async function stageListedEntry(
  input: StageListedEntriesInput,
  entry: InspectedEntry,
  manifestEntry: ManifestV2["documents"][number] | ManifestV2["media"][number],
  ordinal: number,
): Promise<StagedImportEntry> {
  await assertEntryContentSafe(
    input.archive.zip,
    input.archive.centralHandle,
    entry.zipEntry,
  );
  const managedName = `${ordinal.toString().padStart(6, "0")}.entry`;
  const target = join(input.directory, managedName);
  const staged = await stageOneEntry(
    input.archive.zip,
    entry.zipEntry,
    target,
    manifestEntry.bytes,
    manifestEntry.sha256,
  );
  await scanStagedEntry(input.secretGate, manifestEntry.path, target);
  return {
    archivePath: manifestEntry.path,
    managedName,
    kind: entry.policy.kind as "document" | "media",
    ...staged,
  };
}

async function assertEntryContentSafe(
  zip: ZipFile,
  archiveHandle: FileHandle,
  entry: Entry,
): Promise<void> {
  await assertLocalHeader(archiveHandle, entry);
  const stream = await openEntryStream(zip, entry);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const value = readableChunk(chunk);
      const remaining = 512 - bytes;
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      bytes += Math.min(value.byteLength, Math.max(remaining, 0));
      if (bytes >= 512) break;
    }
  } finally {
    stream.destroy();
  }
  assertSafeEntryPrefix(entry.fileName, Buffer.concat(chunks));
}

async function assertLocalHeader(
  handle: FileHandle,
  entry: Entry,
): Promise<void> {
  const fixed = await readExact(handle, 30, entry.relativeOffsetOfLocalHeader);
  if (fixed.readUInt32LE(0) !== 0x04034b50)
    failEnvelope("IMPORT_ARCHIVE_LOCAL_HEADER_INVALID");
  if (
    fixed.readUInt16LE(6) !== entry.generalPurposeBitFlag ||
    fixed.readUInt16LE(8) !== entry.compressionMethod
  )
    failEnvelope("IMPORT_ARCHIVE_LOCAL_HEADER_MISMATCH");
  const nameBytes = fixed.readUInt16LE(26);
  const extraBytes = fixed.readUInt16LE(28);
  if (
    nameBytes !== entry.fileNameLength ||
    extraBytes > ARCHIVE_POLICY_V1.maxEntryExtraFieldBytes
  )
    failEnvelope("IMPORT_ARCHIVE_LOCAL_HEADER_MISMATCH");
  const variable = await readExact(
    handle,
    nameBytes + extraBytes,
    entry.relativeOffsetOfLocalHeader + 30,
  );
  if (!variable.subarray(0, nameBytes).equals(entry.fileNameRaw))
    failEnvelope("IMPORT_ARCHIVE_LOCAL_HEADER_MISMATCH");
  assertExtraFields(
    parseExtraFieldBuffer(variable.subarray(nameBytes)),
    entry.fileName,
  );
}

async function readExact(
  handle: FileHandle,
  bytes: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(bytes);
  const result = await handle.read(buffer, 0, bytes, position);
  if (result.bytesRead !== bytes)
    failEnvelope("IMPORT_ARCHIVE_LOCAL_HEADER_TRUNCATED");
  return buffer;
}

function parseExtraFieldBuffer(
  value: Uint8Array,
): Array<{ id: number; bytes: Uint8Array }> {
  const buffer = Buffer.from(value);
  const fields: Array<{ id: number; bytes: Uint8Array }> = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    if (cursor + 4 > buffer.length)
      failEnvelope("IMPORT_ARCHIVE_EXTRA_FIELD_INVALID");
    const id = buffer.readUInt16LE(cursor);
    const length = buffer.readUInt16LE(cursor + 2);
    const end = cursor + 4 + length;
    if (end > buffer.length) failEnvelope("IMPORT_ARCHIVE_EXTRA_FIELD_INVALID");
    fields.push({ id, bytes: buffer.subarray(cursor + 4, end) });
    cursor = end;
  }
  return fields;
}

function assertExtraFields(
  fields: readonly { id: number; bytes: Uint8Array }[],
  entryName: string,
): void {
  const ids = new Set<number>();
  for (const field of fields) {
    if (
      field.id !== 0x0001 ||
      ids.has(field.id) ||
      field.bytes.byteLength < 4 ||
      field.bytes.byteLength > 32
    )
      throw new ArchiveValidationError(
        "IMPORT_ARCHIVE_EXTRA_FIELD_UNSUPPORTED",
        "envelope",
        safeArchiveEntry(entryName),
      );
    ids.add(field.id);
  }
}

async function stageOneEntry(
  zip: ZipFile,
  entry: Entry,
  target: string,
  expectedBytes: number,
  expectedHash: string,
): Promise<{ bytes: number; sha256: string }> {
  const handle = await open(
    target,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  const meter = new EntryVerifier(expectedBytes, expectedHash);
  const output = createWriteStream(target, { fd: handle.fd, autoClose: false });
  try {
    await pipeline(await openEntryStream(zip, entry), meter, output);
    const result = meter.result();
    await handle.chmod(0o600);
    await handle.sync();
    return result;
  } finally {
    await handle.close();
  }
}

class EntryVerifier extends Transform {
  readonly #expectedBytes: number;
  readonly #expectedHash: string;
  readonly #hash = createHash("sha256");
  #bytes = 0;

  constructor(expectedBytes: number, expectedHash: string) {
    super();
    this.#expectedBytes = expectedBytes;
    this.#expectedHash = expectedHash;
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.#bytes += value.byteLength;
    if (this.#bytes > this.#expectedBytes) {
      callback(
        new ArchiveValidationError(
          "IMPORT_ARCHIVE_STREAM_BYTES_LIMIT",
          "resource",
        ),
      );
      return;
    }
    this.#hash.update(value);
    callback(null, value);
  }

  result(): { bytes: number; sha256: string } {
    const sha256 = this.#hash.digest("hex");
    if (this.#bytes !== this.#expectedBytes)
      throw new ArchiveValidationError(
        "IMPORT_ARCHIVE_ENTRY_BYTES_MISMATCH",
        "integrity",
      );
    if (sha256 !== this.#expectedHash)
      throw new ArchiveValidationError(
        "IMPORT_ARCHIVE_ENTRY_CHECKSUM_MISMATCH",
        "integrity",
      );
    return { bytes: this.#bytes, sha256 };
  }
}

async function scanStagedEntry(
  gate: SecretReleaseGate,
  archivePath: string,
  target: string,
): Promise<void> {
  const nameFinding = gate.scanEntryName(archivePath);
  const finding =
    nameFinding ??
    (await gate.scanStream(
      safeArchiveEntry(archivePath),
      createReadStream(target),
    ));
  if (finding)
    throw new ArchiveValidationError(
      "IMPORT_ARCHIVE_SECRET_FOUND",
      "secret",
      safeArchiveEntry(archivePath),
    );
}

async function writeStagingMetadata(
  directory: string,
  normalized: NormalizedImportManifest,
  entries: readonly StagedImportEntry[],
): Promise<void> {
  const manifestPath = join(directory, "normalized-manifest.json");
  const indexPath = join(directory, "index.json");
  await writeFile(manifestPath, canonicalJson(normalized.manifest), {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(indexPath, canonicalJson({ schemaVersion: 1, entries }), {
    mode: 0o600,
    flag: "wx",
  });
  await chmod(manifestPath, 0o600);
  await chmod(indexPath, 0o600);
  await syncDirectory(directory);
}

async function createPrivateStagingDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: false, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("IMPORT_STAGING_DIRECTORY_INVALID");
  await chmod(path, 0o700);
}

async function removeRecognizedStaging(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("IMPORT_STAGING_DIRECTORY_INVALID");
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

async function readZipEntryBytes(
  zip: ZipFile,
  entry: Entry,
  maximum: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of await openEntryStream(zip, entry)) {
    const value = readableChunk(chunk);
    bytes += value.byteLength;
    if (bytes > maximum)
      throw new ArchiveValidationError(
        "IMPORT_ARCHIVE_MANIFEST_LIMIT",
        "resource",
      );
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytes);
}

function readableChunk(value: unknown): Buffer {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new ArchiveValidationError("IMPORT_ARCHIVE_STREAM_INVALID", "envelope");
}

async function readPrivateStagedFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600)
      throw new ArchiveValidationError(
        "IMPORT_STAGING_FILE_IDENTITY_INVALID",
        "integrity",
      );
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function openEntryStream(zip: ZipFile, entry: Entry) {
  try {
    return await zip.openReadStreamPromise(entry);
  } catch (error) {
    throw normalizeZipError(error);
  }
}

function normalizeZipError(error: unknown): Error {
  if (error instanceof ArchiveValidationError) return error;
  const message = error instanceof Error ? error.message : "";
  const code = /multi-disk/iu.test(message)
    ? "IMPORT_ARCHIVE_MULTI_DISK"
    : /encrypted|encryption/iu.test(message)
      ? "IMPORT_ARCHIVE_ENCRYPTED"
      : /invalid characters in fileName|absolute path|invalid relative path/iu.test(
            message,
          )
        ? "IMPORT_ARCHIVE_PATH_INVALID"
        : "IMPORT_ARCHIVE_CORRUPT";
  return new ArchiveValidationError(
    code,
    code === "IMPORT_ARCHIVE_PATH_INVALID" ? "name" : "envelope",
  );
}

function failEnvelope(code: string): never {
  throw new ArchiveValidationError(code, "envelope");
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total = safeAdd(total, value);
  return total;
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total))
    throw new ArchiveValidationError(
      "IMPORT_ARCHIVE_SIZE_OVERFLOW",
      "resource",
    );
  return total;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
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

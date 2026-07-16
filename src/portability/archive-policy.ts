import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const ARCHIVE_POLICY_V1 = Object.freeze({
  version: 1 as const,
  maxCompressedUploadBytes: 8 * 1024 ** 3,
  maxEntries: 20_000,
  maxEntryNameBytes: 240,
  maxEntryExtraFieldBytes: 256,
  maxManifestBytes: 8 * 1024 ** 2,
  maxCanonicalDocumentBytes: 16 * 1024 ** 2,
  maxMediaBytes: 2 * 1024 ** 3,
  maxAggregateUncompressedBytes: 16 * 1024 ** 3,
  maxCompressionRatio: 200,
  maxCentralDirectoryBytes: 20_000 * (46 + 240 + 256),
});

export type ArchiveEntryKind = "manifest" | "document" | "media";

export type ArchiveValidationCategory =
  | "envelope"
  | "name"
  | "type"
  | "resource"
  | "manifest"
  | "integrity"
  | "schema"
  | "closure"
  | "media"
  | "secret"
  | "disk";

export class ArchiveValidationError extends Error {
  readonly name = "ArchiveValidationError";

  constructor(
    readonly code: string,
    readonly category: ArchiveValidationCategory,
    readonly entry: string | null = null,
  ) {
    super(code);
  }
}

export interface ArchiveCentralEntry {
  fileName: string;
  fileNameRaw?: Uint8Array;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  generalPurposeBitFlag: number;
  externalFileAttributes: number;
  versionMadeBy: number;
  extraFieldLength?: number;
  fileCommentLength?: number;
}

export interface ValidatedArchiveEntry {
  path: string;
  kind: ArchiveEntryKind;
  compressedBytes: number;
  uncompressedBytes: number;
}

export class ArchivePolicyMeter {
  readonly #canonicalNames = new Set<string>();
  #entryCount = 0;
  #compressedBytes = 0;
  #uncompressedBytes = 0;
  #centralDirectoryBytes = 0;

  add(entry: ArchiveCentralEntry): ValidatedArchiveEntry {
    this.#entryCount += 1;
    if (this.#entryCount > ARCHIVE_POLICY_V1.maxEntries)
      fail("IMPORT_ARCHIVE_ENTRY_LIMIT", "resource");
    const path = validateArchivePath(
      entry.fileName,
      entry.fileNameRaw,
      entry.generalPurposeBitFlag,
    );
    this.assertUniqueName(path);
    validateEntryEnvelope(entry, path);
    this.#centralDirectoryBytes = safeAdd(
      this.#centralDirectoryBytes,
      centralEntryBytes(entry),
      "IMPORT_ARCHIVE_CENTRAL_DIRECTORY_OVERFLOW",
    );
    const kind = classifyArchivePath(path);
    validateEntrySize(kind, entry, path);
    this.addResourceUsage(entry);
    return {
      path,
      kind,
      compressedBytes: entry.compressedSize,
      uncompressedBytes: entry.uncompressedSize,
    };
  }

  private addResourceUsage(entry: ArchiveCentralEntry): void {
    if (
      this.#centralDirectoryBytes > ARCHIVE_POLICY_V1.maxCentralDirectoryBytes
    )
      fail("IMPORT_ARCHIVE_CENTRAL_DIRECTORY_LIMIT", "resource");
    this.#compressedBytes = safeAdd(
      this.#compressedBytes,
      entry.compressedSize,
      "IMPORT_ARCHIVE_SIZE_OVERFLOW",
    );
    if (this.#compressedBytes > ARCHIVE_POLICY_V1.maxCompressedUploadBytes)
      fail("IMPORT_ARCHIVE_COMPRESSED_LIMIT", "resource");
    this.#uncompressedBytes = safeAdd(
      this.#uncompressedBytes,
      entry.uncompressedSize,
      "IMPORT_ARCHIVE_SIZE_OVERFLOW",
    );
    if (
      this.#uncompressedBytes > ARCHIVE_POLICY_V1.maxAggregateUncompressedBytes
    )
      fail("IMPORT_ARCHIVE_AGGREGATE_LIMIT", "resource");
    assertRatio(
      this.#compressedBytes,
      this.#uncompressedBytes,
      "IMPORT_ARCHIVE_AGGREGATE_RATIO_LIMIT",
      null,
    );
  }

  summary(): {
    entryCount: number;
    compressedBytes: number;
    uncompressedBytes: number;
    centralDirectoryBytes: number;
  } {
    return {
      entryCount: this.#entryCount,
      compressedBytes: this.#compressedBytes,
      uncompressedBytes: this.#uncompressedBytes,
      centralDirectoryBytes: this.#centralDirectoryBytes,
    };
  }

  private assertUniqueName(path: string): void {
    const canonical = archiveCanonicalNameV1(path);
    if (this.#canonicalNames.has(canonical))
      fail("IMPORT_ARCHIVE_NAME_COLLISION", "name", path);
    this.#canonicalNames.add(canonical);
  }
}

export function assertUploadDeclaration(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 1)
    fail("IMPORT_UPLOAD_BYTES_INVALID", "resource");
  if (bytes > ARCHIVE_POLICY_V1.maxCompressedUploadBytes)
    fail("IMPORT_UPLOAD_COMPRESSED_LIMIT", "resource");
}

export function assertSafeEntryPrefix(path: string, prefix: Uint8Array): void {
  const bytes = Buffer.from(prefix);
  if (isExecutableMagic(bytes))
    fail("IMPORT_ARCHIVE_EXECUTABLE_CONTENT", "type", path);
  if (isNestedArchiveMagic(bytes))
    fail("IMPORT_ARCHIVE_NESTED_ARCHIVE", "type", path);
}

export function safeArchiveEntry(value: string): string {
  return `entry-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function validateArchivePath(
  value: string,
  raw: Uint8Array | undefined,
  generalPurposeBitFlag: number,
): string {
  assertFilenameEncoding(value, raw, generalPurposeBitFlag);
  const byteLength = Math.max(
    raw?.byteLength ?? 0,
    Buffer.byteLength(value, "utf8"),
  );
  if (byteLength < 1 || byteLength > ARCHIVE_POLICY_V1.maxEntryNameBytes)
    fail("IMPORT_ARCHIVE_NAME_BYTES_LIMIT", "name");
  if (value.normalize("NFC") !== value)
    fail("IMPORT_ARCHIVE_NAME_NOT_NFC", "name", value);
  const segments = value.split("/");
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /^[A-Za-z]:/u.test(value) ||
    segments.some((segment) =>
      segment === "" || segment === "." || segment === ".." ? true : false,
    )
  )
    fail("IMPORT_ARCHIVE_PATH_INVALID", "name", value);
  if (hasExecutableExtension(value))
    fail("IMPORT_ARCHIVE_EXECUTABLE_NAME", "type", value);
  if (hasNestedArchiveExtension(value))
    fail("IMPORT_ARCHIVE_NESTED_ARCHIVE", "type", value);
  return value;
}

export function archiveCanonicalNameV1(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replaceAll("ß", "ss")
    .replaceAll("ς", "σ");
}

function assertFilenameEncoding(
  value: string,
  raw: Uint8Array | undefined,
  generalPurposeBitFlag: number,
): void {
  if (value.includes("\uFFFD"))
    fail("IMPORT_ARCHIVE_NAME_ENCODING_INVALID", "name");
  if (!raw || (generalPurposeBitFlag & 0x800) === 0) return;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (decoded !== value) fail("IMPORT_ARCHIVE_NAME_ENCODING_INVALID", "name");
  } catch (error) {
    if (error instanceof ArchiveValidationError) throw error;
    fail("IMPORT_ARCHIVE_NAME_ENCODING_INVALID", "name");
  }
}

function validateEntryEnvelope(entry: ArchiveCentralEntry, path: string): void {
  if ((entry.generalPurposeBitFlag & 1) !== 0)
    fail("IMPORT_ARCHIVE_ENCRYPTED", "envelope", path);
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
    fail("IMPORT_ARCHIVE_COMPRESSION_UNSUPPORTED", "envelope", path);
  if (
    !Number.isSafeInteger(entry.compressedSize) ||
    entry.compressedSize < 0 ||
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.uncompressedSize < 0
  )
    fail("IMPORT_ARCHIVE_SIZE_INVALID", "resource", path);
  const extraBytes = entry.extraFieldLength ?? 0;
  const commentBytes = entry.fileCommentLength ?? 0;
  if (
    !Number.isSafeInteger(extraBytes) ||
    extraBytes < 0 ||
    extraBytes > ARCHIVE_POLICY_V1.maxEntryExtraFieldBytes
  )
    fail("IMPORT_ARCHIVE_CENTRAL_DIRECTORY_LIMIT", "resource", path);
  if (!Number.isSafeInteger(commentBytes) || commentBytes !== 0)
    fail("IMPORT_ARCHIVE_ENTRY_COMMENT_UNSUPPORTED", "envelope", path);
  assertRegularMode(entry, path);
}

function centralEntryBytes(entry: ArchiveCentralEntry): number {
  return safeAdd(
    46 + (entry.fileNameRaw?.byteLength ?? Buffer.byteLength(entry.fileName)),
    (entry.extraFieldLength ?? 0) + (entry.fileCommentLength ?? 0),
    "IMPORT_ARCHIVE_CENTRAL_DIRECTORY_OVERFLOW",
  );
}

function assertRegularMode(entry: ArchiveCentralEntry, path: string): void {
  const sourceSystem = entry.versionMadeBy >>> 8;
  if ((entry.externalFileAttributes & 0x10) !== 0)
    fail("IMPORT_ARCHIVE_NON_REGULAR", "type", path);
  if (sourceSystem !== 3) return;
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const type = mode & 0o170000;
  if (type !== 0 && type !== 0o100000)
    fail("IMPORT_ARCHIVE_NON_REGULAR", "type", path);
  if ((mode & 0o111) !== 0)
    fail("IMPORT_ARCHIVE_EXECUTABLE_MODE", "type", path);
}

function classifyArchivePath(path: string): ArchiveEntryKind {
  if (path === "manifest.json") return "manifest";
  if (/^data\/[a-z][a-z0-9_]{0,47}\/[A-Za-z0-9._:-]+\.json$/u.test(path))
    return "document";
  if (
    /^media\/(?:assets|originals)\/[a-f0-9]{64}\.(?:heic|heif|icc|jpeg|jpg|pdf|png|webp)$/u.test(
      path,
    )
  )
    return "media";
  return fail("IMPORT_ARCHIVE_PATH_KIND_UNLISTED", "type", path);
}

function validateEntrySize(
  kind: ArchiveEntryKind,
  entry: ArchiveCentralEntry,
  path: string,
): void {
  const maximum =
    kind === "manifest"
      ? ARCHIVE_POLICY_V1.maxManifestBytes
      : kind === "document"
        ? ARCHIVE_POLICY_V1.maxCanonicalDocumentBytes
        : ARCHIVE_POLICY_V1.maxMediaBytes;
  if (entry.uncompressedSize > maximum)
    fail(`IMPORT_ARCHIVE_${kind.toUpperCase()}_LIMIT`, "resource", path);
  assertRatio(
    entry.compressedSize,
    entry.uncompressedSize,
    "IMPORT_ARCHIVE_ENTRY_RATIO_LIMIT",
    path,
  );
}

function assertRatio(
  compressed: number,
  uncompressed: number,
  code: string,
  path: string | null,
): void {
  if (uncompressed === 0) return;
  if (
    compressed === 0 ||
    uncompressed > compressed * ARCHIVE_POLICY_V1.maxCompressionRatio
  )
    fail(code, "resource", path);
}

function hasExecutableExtension(path: string): boolean {
  return /\.(?:app|bat|cmd|com|dll|dylib|exe|js|mjs|ps1|scr|sh|so)$/iu.test(
    path,
  );
}

function hasNestedArchiveExtension(path: string): boolean {
  return /\.(?:7z|bz2|gz|rar|tar|tgz|xz|zip)$/iu.test(path);
}

function isExecutableMagic(bytes: Buffer): boolean {
  const hex = bytes.subarray(0, 4).toString("hex");
  return (
    bytes.subarray(0, 2).toString("ascii") === "MZ" ||
    bytes.subarray(0, 4).toString("ascii") === "\x7fELF" ||
    bytes.subarray(0, 2).toString("ascii") === "#!" ||
    ["feedface", "feedfacf", "cefaedfe", "cffaedfe"].includes(hex)
  );
}

function isNestedArchiveMagic(bytes: Buffer): boolean {
  const hex = bytes.subarray(0, 8).toString("hex");
  return (
    hex.startsWith("504b0304") ||
    hex.startsWith("1f8b08") ||
    hex.startsWith("526172211a0700") ||
    hex.startsWith("377abcaf271c") ||
    bytes.subarray(257, 262).toString("ascii") === "ustar"
  );
}

function safeAdd(left: number, right: number, code: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) fail(code, "resource");
  return result;
}

function fail(
  code: string,
  category: ArchiveValidationCategory,
  entry: string | null = null,
): never {
  throw new ArchiveValidationError(
    code,
    category,
    entry === null ? null : safeArchiveEntry(entry),
  );
}

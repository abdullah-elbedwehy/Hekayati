import { createHash, type Hash } from "node:crypto";
import {
  Transform,
  type Readable,
  type TransformCallback,
  type Writable,
} from "node:stream";
import { pipeline } from "node:stream/promises";

import { ZipFile } from "yazl";

import { canonicalJson } from "../contracts/canonical-json.js";
import { parseManifestBytes, type ManifestV2 } from "./manifest.js";

const deterministicMtime = new Date(1980, 0, 1, 0, 0, 0, 0);
const deterministicEntryOptions = {
  mtime: deterministicMtime,
  mode: 0o100600,
  compressionLevel: 9,
  forceDosTimestamp: true,
  forceZip64Format: false,
} as const;

export interface StagedArchiveSource {
  path: string;
  bytes: number;
  sha256: string;
  open(): Readable;
}

export interface WrittenArchive {
  bytes: number;
  sha256: string;
}

export async function writeDeterministicArchive(
  candidateManifest: ManifestV2,
  sources: ReadonlyArray<StagedArchiveSource>,
  output: Writable,
): Promise<WrittenArchive> {
  const manifestBytes = Buffer.from(canonicalJson(candidateManifest), "utf8");
  const manifest = parseManifestBytes(manifestBytes);
  const orderedSources = validateSources(manifest, sources);
  const archiveMeter = new HashingPassThrough();
  const zip = new ZipFile();
  const zipOutput = zip.outputStream as Readable;
  zip.once("error", (error: unknown) => zipOutput.destroy(toError(error)));
  const completion = pipeline(zipOutput, archiveMeter, output);

  try {
    zip.addBuffer(manifestBytes, "manifest.json", deterministicEntryOptions);
    for (const source of orderedSources) addVerifiedSource(zip, source);
    zip.end({ forceZip64Format: false, comment: "" });
    await completion;
  } catch (error) {
    zipOutput.destroy(toError(error));
    await completion.catch(() => undefined);
    throw error;
  }

  return archiveMeter.result();
}

function validateSources(
  manifest: ManifestV2,
  sources: ReadonlyArray<StagedArchiveSource>,
): StagedArchiveSource[] {
  const byPath = new Map<string, StagedArchiveSource>();
  for (const source of sources) {
    if (byPath.has(source.path))
      throw new Error(`PORTABILITY_ARCHIVE_DUPLICATE_SOURCE:${source.path}`);
    byPath.set(source.path, source);
  }

  const expectedEntries = [...manifest.documents, ...manifest.media];
  if (byPath.size !== expectedEntries.length)
    throw new Error("PORTABILITY_ARCHIVE_SOURCE_SET_MISMATCH");

  return expectedEntries.map((entry) => {
    const source = byPath.get(entry.path);
    if (!source)
      throw new Error(`PORTABILITY_ARCHIVE_SOURCE_SET_MISMATCH:${entry.path}`);
    if (source.bytes !== entry.bytes || source.sha256 !== entry.sha256)
      throw new Error(
        `PORTABILITY_ARCHIVE_SOURCE_METADATA_MISMATCH:${entry.path}`,
      );
    return source;
  });
}

function addVerifiedSource(zip: ZipFile, source: StagedArchiveSource): void {
  zip.addReadStreamLazy(
    source.path,
    { ...deterministicEntryOptions, size: source.bytes },
    (callback) => {
      let input: Readable;
      try {
        input = source.open();
      } catch (error) {
        callback(toError(error), null as never);
        return;
      }
      const verifier = new SourceVerifier(source);
      input.once("error", (error: unknown) => verifier.destroy(toError(error)));
      verifier.once("error", (error: unknown) => zip.emit("error", error));
      input.pipe(verifier);
      callback(null, verifier);
    },
  );
}

class SourceVerifier extends Transform {
  readonly #source: StagedArchiveSource;
  readonly #hash = createHash("sha256");
  #bytes = 0;

  constructor(source: StagedArchiveSource) {
    super();
    this.#source = source;
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
    if (this.#bytes !== this.#source.bytes) {
      callback(
        new Error(
          `PORTABILITY_ARCHIVE_SOURCE_BYTES_MISMATCH:${this.#source.path}`,
        ),
      );
      return;
    }
    if (this.#hash.digest("hex") !== this.#source.sha256) {
      callback(
        new Error(
          `PORTABILITY_ARCHIVE_SOURCE_HASH_MISMATCH:${this.#source.path}`,
        ),
      );
      return;
    }
    callback();
  }
}

class HashingPassThrough extends Transform {
  readonly #hash: Hash = createHash("sha256");
  #bytes = 0;

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

  result(): WrittenArchive {
    return { bytes: this.#bytes, sha256: this.#hash.digest("hex") };
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

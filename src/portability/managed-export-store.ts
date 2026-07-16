import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";

import type { WrittenArchive } from "./export.js";
import type { ArchiveReleaseVerification } from "./release-gate.js";
import type { SecretScanFinding } from "./secret-scan.js";

const exportIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const archiveKeyPattern = /^[0-9A-HJKMNP-TV-Z]{26}-[a-f0-9]{64}\.zip$/;

export interface ManagedExportPublishInput {
  exportId: string;
  write(output: Writable): Promise<WrittenArchive>;
  verify(
    candidatePath: string,
    archive: WrittenArchive,
  ): Promise<ArchiveReleaseVerification>;
}

export interface PublishedManagedExport {
  archiveKey: string;
  archive: WrittenArchive;
}

export class ManagedExportReleaseError extends Error {
  readonly name = "ManagedExportReleaseError";

  constructor(readonly finding: SecretScanFinding) {
    super("PORTABILITY_EXPORT_SECRET_FOUND");
  }
}

export class ManagedExportDownload {
  #streamCreated = false;

  constructor(private readonly handle: FileHandle) {}

  createReadStream(): Readable {
    if (this.#streamCreated)
      throw new Error("PORTABILITY_DOWNLOAD_STREAM_ALREADY_OPENED");
    this.#streamCreated = true;
    return this.handle.createReadStream({ autoClose: false, start: 0 });
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

export class ManagedExportStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#root);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("PORTABILITY_EXPORT_ROOT_INVALID");
    await chmod(this.#root, 0o700);
  }

  async publish(
    input: ManagedExportPublishInput,
  ): Promise<PublishedManagedExport> {
    if (!exportIdPattern.test(input.exportId))
      throw new Error("PORTABILITY_EXPORT_ID_INVALID");
    await this.initialize();
    const candidate = join(this.#root, `.candidate-${randomUUID()}.tmp`);
    const prepared = await prepareManagedCandidate(candidate, (output) =>
      input.write(output),
    );

    try {
      const verification = await input.verify(candidate, prepared.archive);
      if (!verification.ok)
        throw new ManagedExportReleaseError(verification.finding);
      if (
        verification.archive.bytes !== prepared.archive.bytes ||
        verification.archive.sha256 !== prepared.archive.sha256
      )
        throw new Error("PORTABILITY_EXPORT_VERIFICATION_MISMATCH");
      await assertPrivateRegularFile(prepared.handle);
      await assertWrittenArchive(prepared.handle, prepared.archive);

      const archiveKey = `${input.exportId}-${prepared.archive.sha256}.zip`;
      await this.publishCandidate(
        candidate,
        archiveKey,
        prepared.archive,
        prepared.handle,
        prepared.identity,
      );
      return { archiveKey, archive: prepared.archive };
    } catch (error) {
      await removeOwnedPath(candidate, prepared.identity);
      await syncDirectory(this.#root);
      throw error;
    } finally {
      await closeFileHandle(prepared.handle);
    }
  }

  async openDownload(
    archiveKey: string,
    expected: WrittenArchive,
  ): Promise<ManagedExportDownload> {
    if (!archiveKeyPattern.test(archiveKey))
      throw new Error("PORTABILITY_ARCHIVE_KEY_INVALID");
    if (!archiveKey.endsWith(`-${expected.sha256}.zip`))
      throw new Error("PORTABILITY_ARCHIVE_KEY_CHECKSUM_MISMATCH");
    await this.initialize();
    const handle = await open(
      join(this.#root, archiveKey),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await assertPrivateRegularFile(handle);
      const actual = await hashHandle(handle);
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
        throw new Error("PORTABILITY_DOWNLOAD_INTEGRITY_MISMATCH");
      return new ManagedExportDownload(handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async publishCandidate(
    candidate: string,
    archiveKey: string,
    archive: WrittenArchive,
    candidateHandle: FileHandle,
    identity: { dev: number; ino: number },
  ): Promise<void> {
    const target = join(this.#root, archiveKey);
    try {
      await link(candidate, target);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const download = await this.openDownload(archiveKey, archive);
      await download.close();
      if (!(await removeOwnedPath(candidate, identity)))
        throw new Error("PORTABILITY_EXPORT_CANDIDATE_IDENTITY_MISMATCH", {
          cause: error,
        });
      await syncDirectory(this.#root);
      return;
    }

    try {
      const targetInfo = await lstat(target);
      if (targetInfo.dev !== identity.dev || targetInfo.ino !== identity.ino)
        throw new Error("PORTABILITY_EXPORT_CANDIDATE_IDENTITY_MISMATCH");
      await assertPrivateRegularFile(candidateHandle, 2);
      if (!(await removeOwnedPath(candidate, identity)))
        throw new Error("PORTABILITY_EXPORT_CANDIDATE_IDENTITY_MISMATCH");
      await assertPrivateRegularFile(candidateHandle);
      await syncDirectory(this.#root);
    } catch (error) {
      await removeOwnedPath(target, identity);
      throw error;
    }
  }
}

async function prepareManagedCandidate(
  candidate: string,
  write: ManagedExportPublishInput["write"],
): Promise<{
  archive: WrittenArchive;
  handle: FileHandle;
  identity: { dev: number; ino: number };
}> {
  const handle = await open(
    candidate,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_RDWR |
      constants.O_NOFOLLOW,
    0o600,
  );
  const identity = await handle.stat();
  const output = createWriteStream(candidate, {
    fd: handle.fd,
    autoClose: false,
  });
  try {
    const archive = await write(output);
    await finished(output);
    await handle.chmod(0o600);
    await assertPrivateRegularFile(handle);
    await handle.sync();
    await assertWrittenArchive(handle, archive);
    return { archive, handle, identity };
  } catch (error) {
    if (!output.writableFinished) {
      output.destroy();
      await finished(output).catch(() => undefined);
    }
    await removeOwnedPath(candidate, identity);
    await closeFileHandle(handle);
    await syncDirectory(dirname(candidate));
    throw error;
  }
}

async function closeFileHandle(handle: FileHandle): Promise<void> {
  await handle.close().catch((error: unknown) => {
    if (!hasCode(error, "EBADF")) throw error;
  });
}

async function assertPrivateRegularFile(
  handle: FileHandle,
  expectedLinks = 1,
): Promise<void> {
  const info = await handle.stat();
  if (!info.isFile() || info.nlink !== expectedLinks)
    throw new Error("PORTABILITY_EXPORT_FILE_INVALID");
  if ((info.mode & 0o777) !== 0o600)
    throw new Error("PORTABILITY_EXPORT_FILE_PERMISSIONS_INVALID");
}

async function assertWrittenArchive(
  handle: FileHandle,
  expected: WrittenArchive,
): Promise<void> {
  const actual = await hashHandle(handle);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
    throw new Error("PORTABILITY_EXPORT_WRITER_INTEGRITY_MISMATCH");
}

async function hashHandle(handle: FileHandle): Promise<WrittenArchive> {
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

async function removeOwnedPath(
  path: string,
  identity: { dev: number; ino: number },
): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.dev !== identity.dev || info.ino !== identity.ino) return false;
    await rm(path, { force: true });
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }
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

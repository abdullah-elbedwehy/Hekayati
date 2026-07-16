import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Transform, type Readable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  ArchiveValidationError,
  assertUploadDeclaration,
} from "./archive-policy.js";

const reservationKeyPattern = /^[0-9A-HJKMNP-TV-Z]{26}\.zip$/;
const incomingKeyPattern = /^\.incoming-[a-f0-9-]{36}\.tmp$/;
const stagingKeyPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface ImportUploadDeclaration {
  bytes: number;
  sha256: string;
}

export interface CapturedImportReservation extends ImportUploadDeclaration {
  key: string;
}

export interface ImportReconciliationResult {
  removedReservations: number;
  removedStagingDirectories: number;
}

export class ManagedImportStore {
  readonly #root: string;
  readonly #reservationRoot: string;
  readonly #stagingRoot: string;

  constructor(root: string) {
    this.#root = resolve(root);
    this.#reservationRoot = join(this.#root, "reservations");
    this.#stagingRoot = join(this.#root, "staging");
  }

  get root(): string {
    return this.#root;
  }

  get stagingRoot(): string {
    return this.#stagingRoot;
  }

  async initialize(): Promise<void> {
    for (const directory of [
      this.#root,
      this.#reservationRoot,
      this.#stagingRoot,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("IMPORT_MANAGED_ROOT_INVALID");
      await chmod(directory, 0o700);
    }
  }

  async capture(input: {
    key: string;
    declaration: ImportUploadDeclaration;
    openSource(): Readable;
  }): Promise<CapturedImportReservation> {
    assertReservationKey(input.key);
    assertUploadDeclaration(input.declaration.bytes);
    assertSha256(input.declaration.sha256);
    await this.initialize();
    const candidate = join(
      this.#reservationRoot,
      `.incoming-${randomUUID()}.tmp`,
    );
    const target = join(this.#reservationRoot, input.key);
    const handle = await open(
      candidate,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600,
    );
    const identity = await identityOf(handle);
    try {
      const actual = await writeVerifiedUpload(
        handle,
        candidate,
        () => input.openSource(),
        input.declaration,
      );
      await publishReservation(candidate, target, identity);
      await syncDirectory(this.#reservationRoot);
      return { key: input.key, ...actual };
    } catch (error) {
      await removeByIdentity(candidate, identity);
      await removeByIdentity(target, identity);
      await syncDirectory(this.#reservationRoot);
      throw error;
    } finally {
      await closeHandle(handle);
    }
  }

  async openReservation(key: string): Promise<FileHandle> {
    assertReservationKey(key);
    await this.initialize();
    const handle = await open(
      join(this.#reservationRoot, key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await assertPrivateFileHandle(handle);
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async verifyReservation(
    key: string,
    expected: ImportUploadDeclaration,
  ): Promise<void> {
    const handle = await this.openReservation(key);
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of handle.createReadStream({
        autoClose: false,
        start: 0,
      })) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > expected.bytes)
          throw new ArchiveValidationError(
            "IMPORT_RESERVATION_BYTES_MISMATCH",
            "integrity",
          );
        hash.update(value);
      }
      if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256)
        throw new ArchiveValidationError(
          "IMPORT_RESERVATION_INTEGRITY_MISMATCH",
          "integrity",
        );
    } finally {
      await handle.close();
    }
  }

  async reconcile(input: {
    referencedReservations: ReadonlySet<string>;
    referencedStaging: ReadonlySet<string>;
  }): Promise<ImportReconciliationResult> {
    await this.initialize();
    let removedReservations = 0;
    let removedStagingDirectories = 0;
    const reservationNames = await readdir(this.#reservationRoot);
    for (const name of reservationNames.filter((item) =>
      incomingKeyPattern.test(item),
    )) {
      await removeRecognizedIncoming(join(this.#reservationRoot, name));
      removedReservations += 1;
    }
    for (const name of reservationNames.filter((item) =>
      reservationKeyPattern.test(item),
    )) {
      if (input.referencedReservations.has(name)) continue;
      await removeRecognizedFile(join(this.#reservationRoot, name));
      removedReservations += 1;
    }
    for (const name of await readdir(this.#stagingRoot)) {
      if (!stagingKeyPattern.test(name) || input.referencedStaging.has(name))
        continue;
      await removeRecognizedDirectory(join(this.#stagingRoot, name));
      removedStagingDirectories += 1;
    }
    if (removedReservations > 0) await syncDirectory(this.#reservationRoot);
    if (removedStagingDirectories > 0) await syncDirectory(this.#stagingRoot);
    return { removedReservations, removedStagingDirectories };
  }

  reservationPath(key: string): string {
    assertReservationKey(key);
    return join(this.#reservationRoot, key);
  }

  async removeReservation(key: string): Promise<void> {
    assertReservationKey(key);
    await this.initialize();
    await removeRecognizedFile(join(this.#reservationRoot, key));
    await syncDirectory(this.#reservationRoot);
  }

  async removeStaging(key: string): Promise<void> {
    if (!stagingKeyPattern.test(key))
      throw new Error("IMPORT_STAGING_KEY_INVALID");
    await this.initialize();
    await removeRecognizedDirectory(join(this.#stagingRoot, key));
    await syncDirectory(this.#stagingRoot);
  }
}

async function publishReservation(
  candidate: string,
  target: string,
  identity: { dev: number; ino: number },
): Promise<void> {
  try {
    await link(candidate, target);
  } catch (error) {
    if (hasCode(error, "EEXIST"))
      throw new Error("IMPORT_RESERVATION_KEY_CONFLICT", { cause: error });
    throw error;
  }
  await assertPrivateOwnedFile(candidate, identity, 2);
  await assertPrivateOwnedFile(target, identity, 2);
  if (!(await removeByIdentity(candidate, identity)))
    throw new Error("IMPORT_RESERVATION_IDENTITY_INVALID");
  await assertPrivateOwnedFile(target, identity);
}

class UploadVerifier extends Transform {
  readonly #expected: ImportUploadDeclaration;
  readonly #hash = createHash("sha256");
  #bytes = 0;

  constructor(expected: ImportUploadDeclaration) {
    super();
    this.#expected = expected;
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.#bytes += value.byteLength;
    if (this.#bytes > this.#expected.bytes) {
      callback(
        new ArchiveValidationError("IMPORT_UPLOAD_BYTES_MISMATCH", "integrity"),
      );
      return;
    }
    this.#hash.update(value);
    callback(null, value);
  }

  result(): ImportUploadDeclaration {
    if (this.#bytes !== this.#expected.bytes)
      throw new ArchiveValidationError(
        "IMPORT_UPLOAD_BYTES_MISMATCH",
        "integrity",
      );
    const sha256 = this.#hash.digest("hex");
    if (sha256 !== this.#expected.sha256)
      throw new ArchiveValidationError(
        "IMPORT_UPLOAD_CHECKSUM_MISMATCH",
        "integrity",
      );
    return { bytes: this.#bytes, sha256 };
  }
}

async function writeVerifiedUpload(
  handle: FileHandle,
  candidate: string,
  openSource: () => Readable,
  expected: ImportUploadDeclaration,
): Promise<ImportUploadDeclaration> {
  const verifier = new UploadVerifier(expected);
  const output = createWriteStream(candidate, {
    fd: handle.fd,
    autoClose: false,
    start: 0,
  });
  let source: Readable;
  try {
    source = openSource();
  } catch (error) {
    output.destroy();
    throw error;
  }
  await pipeline(source, verifier, output);
  const actual = verifier.result();
  await handle.chmod(0o600);
  await handle.sync();
  await assertPrivateFileHandle(handle);
  return actual;
}

async function assertPrivateOwnedFile(
  path: string,
  expected: { dev: number; ino: number },
  expectedLinks = 1,
): Promise<void> {
  const info = await lstat(path);
  if (
    info.dev !== expected.dev ||
    info.ino !== expected.ino ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== expectedLinks ||
    (info.mode & 0o777) !== 0o600
  )
    throw new Error("IMPORT_RESERVATION_IDENTITY_INVALID");
}

async function assertPrivateFileHandle(handle: FileHandle): Promise<void> {
  const info = await handle.stat();
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600)
    throw new Error("IMPORT_RESERVATION_IDENTITY_INVALID");
}

async function removeRecognizedFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error("IMPORT_RESERVATION_IDENTITY_INVALID");
    await rm(path, { force: true });
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

async function removeRecognizedIncoming(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 2)
      throw new Error("IMPORT_RESERVATION_IDENTITY_INVALID");
    await rm(path, { force: true });
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

async function removeRecognizedDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("IMPORT_STAGING_IDENTITY_INVALID");
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

async function removeByIdentity(
  path: string,
  expected: { dev: number; ino: number },
): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.dev === expected.dev && info.ino === expected.ino) {
      await rm(path, { force: true });
      return true;
    }
    return false;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }
}

async function identityOf(
  handle: FileHandle,
): Promise<{ dev: number; ino: number }> {
  const info = await handle.stat();
  return { dev: info.dev, ino: info.ino };
}

async function closeHandle(handle: FileHandle): Promise<void> {
  await handle.close().catch((error: unknown) => {
    if (!hasCode(error, "EBADF")) throw error;
  });
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

function assertReservationKey(key: string): void {
  if (!reservationKeyPattern.test(key))
    throw new Error("IMPORT_RESERVATION_KEY_INVALID");
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new ArchiveValidationError(
      "IMPORT_UPLOAD_CHECKSUM_INVALID",
      "integrity",
    );
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

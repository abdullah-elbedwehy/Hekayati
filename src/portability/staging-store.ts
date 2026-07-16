import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  fstatSync,
  openSync,
} from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { StagedArchiveSource } from "./export.js";

const snapshotIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const documentPathPattern =
  /^data\/[a-z][a-z0-9_]{0,47}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,159}\.json$/;
const mediaPathPattern =
  /^media\/(?:assets|originals)\/[a-f0-9]{64}\.[a-z0-9]{1,10}$/;

export type StagedArchiveMetadata = Pick<
  StagedArchiveSource,
  "path" | "bytes" | "sha256"
>;

export class SnapshotStagingStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async initialize(): Promise<void> {
    await preparePrivateDirectory(this.#root);
  }

  async stage(
    snapshotId: string,
    input: ReadonlyArray<StagedArchiveSource>,
  ): Promise<StagedArchiveSource[]> {
    assertSnapshotId(snapshotId);
    const entries = validateEntries(input);
    await this.initialize();
    const snapshotRoot = this.snapshotRoot(snapshotId);
    let createdSnapshotRoot = false;
    try {
      createdSnapshotRoot = await preparePrivateChildDirectory(
        snapshotRoot,
        this.#root,
      );
      for (const entry of entries) await stageEntry(snapshotRoot, entry);
      return entries.map((entry) => stagedSource(snapshotRoot, entry));
    } catch (error) {
      if (createdSnapshotRoot) {
        await rm(snapshotRoot, { recursive: true, force: true });
        await syncDirectory(this.#root);
      }
      throw error;
    }
  }

  async cleanup(snapshotId: string): Promise<void> {
    assertSnapshotId(snapshotId);
    await this.initialize();
    await rm(this.snapshotRoot(snapshotId), { recursive: true, force: true });
    await syncDirectory(this.#root);
  }

  async openStaged(
    snapshotId: string,
    input: ReadonlyArray<StagedArchiveMetadata>,
  ): Promise<StagedArchiveSource[]> {
    assertSnapshotId(snapshotId);
    const entries = validateEntries(input);
    await this.initialize();
    const snapshotRoot = this.snapshotRoot(snapshotId);
    try {
      await assertCompleteStagedSnapshot(snapshotRoot, entries);
    } catch (error) {
      throw new Error("PORTABILITY_STAGING_SNAPSHOT_INCOMPLETE", {
        cause: error,
      });
    }
    return entries.map((entry) => stagedSource(snapshotRoot, entry));
  }

  private snapshotRoot(snapshotId: string): string {
    return join(this.#root, `.snapshot-${snapshotId}`);
  }
}

function validateEntries<T extends StagedArchiveMetadata>(
  input: ReadonlyArray<T>,
): T[] {
  const entries = [...input].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!isGeneratedPath(entry.path))
      throw new Error("PORTABILITY_STAGING_PATH_INVALID");
    if (paths.has(entry.path))
      throw new Error("PORTABILITY_STAGING_PATH_DUPLICATE");
    if (
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error("PORTABILITY_STAGING_METADATA_INVALID");
    paths.add(entry.path);
  }
  return entries;
}

async function stageEntry(
  snapshotRoot: string,
  entry: StagedArchiveSource,
): Promise<void> {
  const target = join(snapshotRoot, entry.path);
  await preparePrivateSubdirectories(snapshotRoot, dirname(entry.path));
  if (await fileMatches(target, entry)) return;
  if (await pathExists(target))
    throw new Error("PORTABILITY_STAGING_FILE_CONFLICT");
  const temporary = join(dirname(target), `.stage-${randomUUID()}.tmp`);
  try {
    const source = openSource(entry);
    await pipeline(
      source,
      new IntegrityVerifier(entry),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    const handle = await open(
      temporary,
      constants.O_RDWR | constants.O_NOFOLLOW,
    );
    try {
      await handle.chmod(0o600);
      await assertPrivateStagingFile(handle);
      await handle.sync();
      await installStagedFile(temporary, target, entry, await handle.stat());
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(temporary, { force: true });
    await syncDirectory(dirname(target));
    throw error;
  }
}

class IntegrityVerifier extends Transform {
  readonly #entry: StagedArchiveSource;
  readonly #hash = createHash("sha256");
  #bytes = 0;

  constructor(entry: StagedArchiveSource) {
    super();
    this.#entry = entry;
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
    if (this.#bytes !== this.#entry.bytes) {
      callback(new Error("PORTABILITY_STAGING_BYTES_MISMATCH"));
      return;
    }
    if (this.#hash.digest("hex") !== this.#entry.sha256) {
      callback(new Error("PORTABILITY_STAGING_HASH_MISMATCH"));
      return;
    }
    callback();
  }
}

function stagedSource(
  snapshotRoot: string,
  entry: StagedArchiveMetadata,
): StagedArchiveSource {
  const target = join(snapshotRoot, entry.path);
  return {
    path: entry.path,
    bytes: entry.bytes,
    sha256: entry.sha256,
    open: () => {
      let descriptor: number | undefined;
      try {
        descriptor = openSync(
          target,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const info = fstatSync(descriptor);
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600)
          throw new Error("PORTABILITY_STAGING_FILE_INVALID");
        return createReadStream(target, {
          fd: descriptor,
          autoClose: true,
        });
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        throw error;
      }
    },
  };
}

async function assertCompleteStagedSnapshot(
  snapshotRoot: string,
  entries: ReadonlyArray<StagedArchiveMetadata>,
): Promise<void> {
  const actualPaths = await collectPrivateStagedPaths(
    snapshotRoot,
    snapshotRoot,
  );
  const expectedPaths = entries.map((entry) => entry.path);
  actualPaths.sort();
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((path, index) => path !== expectedPaths[index])
  )
    throw new Error("PORTABILITY_STAGING_FILE_SET_MISMATCH");
  for (const entry of entries) {
    if (!(await fileMatches(join(snapshotRoot, entry.path), entry)))
      throw new Error("PORTABILITY_STAGING_FILE_INTEGRITY_MISMATCH");
  }
}

async function collectPrivateStagedPaths(
  snapshotRoot: string,
  directory: string,
): Promise<string[]> {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new Error("PORTABILITY_STAGING_DIRECTORY_INVALID");
  const paths: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, item.name);
    const childInfo = await lstat(child);
    if (childInfo.isSymbolicLink())
      throw new Error("PORTABILITY_STAGING_FILE_INVALID");
    if (childInfo.isDirectory()) {
      paths.push(...(await collectPrivateStagedPaths(snapshotRoot, child)));
      continue;
    }
    if (!childInfo.isFile())
      throw new Error("PORTABILITY_STAGING_FILE_INVALID");
    paths.push(relative(snapshotRoot, child).split(sep).join("/"));
  }
  return paths;
}

async function fileMatches(
  target: string,
  expected: StagedArchiveMetadata,
): Promise<boolean> {
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size !== expected.bytes ||
      (info.mode & 0o777) !== 0o600
    )
      return false;
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false, start: 0 });
    for await (const chunk of stream as AsyncIterable<Buffer>)
      hash.update(chunk);
    return hash.digest("hex") === expected.sha256;
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

async function preparePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("PORTABILITY_STAGING_DIRECTORY_INVALID");
  await chmod(path, 0o700);
}

async function preparePrivateChildDirectory(
  path: string,
  parent: string,
): Promise<boolean> {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("PORTABILITY_STAGING_DIRECTORY_INVALID");
  await chmod(path, 0o700);
  if (created) await syncDirectory(parent);
  return created;
}

async function preparePrivateSubdirectories(
  root: string,
  relativeDirectory: string,
): Promise<void> {
  let parent = root;
  for (const segment of relativeDirectory.split("/")) {
    const child = join(parent, segment);
    await preparePrivateChildDirectory(child, parent);
    parent = child;
  }
}

async function installStagedFile(
  temporary: string,
  target: string,
  expected: StagedArchiveSource,
  identity: { dev: number; ino: number },
): Promise<void> {
  try {
    await link(temporary, target);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    if (!(await fileMatches(target, expected)))
      throw new Error("PORTABILITY_STAGING_FILE_CONFLICT", { cause: error });
    await rm(temporary, { force: true });
    await syncDirectory(dirname(target));
    return;
  }

  try {
    const targetInfo = await lstat(target);
    if (targetInfo.dev !== identity.dev || targetInfo.ino !== identity.ino)
      throw new Error("PORTABILITY_STAGING_FILE_IDENTITY_MISMATCH");
    await rm(temporary, { force: true });
    await syncDirectory(dirname(target));
  } catch (error) {
    await removeOwnedStagedPath(target, identity);
    await syncDirectory(dirname(target));
    throw error;
  }
}

async function removeOwnedStagedPath(
  path: string,
  identity: { dev: number; ino: number },
): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.dev === identity.dev && info.ino === identity.ino)
      await rm(path, { force: true });
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

async function assertPrivateStagingFile(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  const info = await handle.stat();
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600)
    throw new Error("PORTABILITY_STAGING_FILE_INVALID");
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

function isGeneratedPath(path: string): boolean {
  return (
    Buffer.byteLength(path, "utf8") <= 240 &&
    path.normalize("NFC") === path &&
    (documentPathPattern.test(path) || mediaPathPattern.test(path))
  );
}

function assertSnapshotId(snapshotId: string): void {
  if (!snapshotIdPattern.test(snapshotId))
    throw new Error("PORTABILITY_SNAPSHOT_ID_INVALID");
}

function openSource(entry: StagedArchiveSource) {
  try {
    return entry.open();
  } catch (error) {
    throw new Error("PORTABILITY_STAGING_SOURCE_OPEN_FAILED", { cause: error });
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

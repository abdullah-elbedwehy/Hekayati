import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isCollectibleAssetFile(file: string, root: string): boolean {
  const name = basename(file);
  const parent = dirname(file);
  const prefix = basename(parent);
  if (dirname(parent) !== root || !/^[a-f0-9]{2}$/.test(prefix)) return false;
  if (/^\.hekayati-tmp-[A-Za-z0-9-]{1,80}$/.test(name)) return true;
  return (
    /^[a-f0-9]{64}\.[a-z0-9]{1,10}$/.test(name) && prefix === name.slice(0, 2)
  );
}

export async function fileMatches(
  file: string,
  expectedHash: string,
): Promise<boolean> {
  try {
    return sha256(await readManagedFile(file)) === expectedHash;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function prepareManagedDirectory(
  directory: string,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("INVALID_ASSET_DIRECTORY");
  await chmod(directory, 0o700);
}

export async function readManagedFile(file: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) throw error;
    throw new Error("INVALID_ASSET_FILE", { cause: error });
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1)
      throw new Error("INVALID_ASSET_FILE");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export function readManagedFileSync(file: string): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) throw error;
    throw new Error("INVALID_ASSET_FILE", { cause: error });
  }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1)
      throw new Error("INVALID_ASSET_FILE");
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedSync(error)) throw error;
  } finally {
    await handle.close();
  }
}

export async function removeTemporaryAfterFailure(
  temporary: string,
): Promise<void> {
  try {
    await rm(temporary, { force: true });
    await syncDirectory(dirname(temporary));
  } catch {
    // Preserve the write failure; startup orphan GC remains the fallback.
  }
}

export async function listFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = join(root, entry.name);
      if (entry.isDirectory()) return listFiles(target);
      return entry.isFile() ? [target] : [];
    }),
  );
  return nested
    .flat()
    .filter(
      (file) => basename(file) !== ".DS_Store" && extname(file) !== ".keep",
    );
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isUnsupportedSync(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EINVAL" || error.code === "ENOTSUP")
  );
}

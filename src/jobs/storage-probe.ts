import { constants } from "node:fs";
import { lstat, open, rename, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { resolveDataPaths, type DataPaths } from "../config/paths.js";

const OWNERSHIP_MARKER = JSON.stringify({
  product: "Hekayati",
  schemaVersion: 1,
});
const PROBE_PAYLOAD = "HEKAYATI_STORAGE_PROBE";

export interface StorageProbeDatabase {
  isHealthy(): boolean;
  transaction<T>(operation: () => T): T;
}

export interface SchedulerStorageProbeInput {
  paths: DataPaths;
  database: StorageProbeDatabase;
  minimumFreeBytes: number;
}

export async function probeSchedulerStorage(
  input: SchedulerStorageProbeInput,
): Promise<boolean> {
  if (!validMinimumFreeBytes(input.minimumFreeBytes)) return false;
  try {
    if (!probeDatabase(input.database)) return false;
    await verifyManagedDataPaths(input.paths);
    if (!(await hasConfiguredFreeSpace(input))) return false;
    await durableWriteProbe(input.paths.root);
    return true;
  } catch {
    return false;
  }
}

function probeDatabase(database: StorageProbeDatabase): boolean {
  return database.transaction(() => database.isHealthy());
}

async function verifyManagedDataPaths(paths: DataPaths): Promise<void> {
  assertCanonicalPaths(paths);
  await verifyDirectory(paths.root);
  await verifyOwnershipMarker(paths.ownershipMarker);
  for (const directory of [paths.assets, paths.originals, paths.logs])
    await verifyDirectory(directory);
  await verifyDatabaseFile(paths.database);
}

function assertCanonicalPaths(paths: DataPaths): void {
  const expected = resolveDataPaths(paths.root);
  for (const key of Object.keys(expected) as Array<keyof DataPaths>) {
    if (paths[key] !== expected[key]) throw new Error("INVALID_DATA_PATHS");
  }
}

async function verifyDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) throw new Error("INVALID_DATA_DIRECTORY");
  } finally {
    await handle.close();
  }
}

async function verifyOwnershipMarker(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    const content = await handle.readFile("utf8");
    if (!info.isFile() || info.nlink !== 1 || content !== OWNERSHIP_MARKER)
      throw new Error("INVALID_DATA_ROOT_MARKER");
  } finally {
    await handle.close();
  }
}

async function verifyDatabaseFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error("INVALID_DATABASE_FILE");
}

async function hasConfiguredFreeSpace(
  input: SchedulerStorageProbeInput,
): Promise<boolean> {
  const disk = await statfs(input.paths.root);
  return disk.bavail * disk.bsize >= input.minimumFreeBytes;
}

async function durableWriteProbe(root: string): Promise<void> {
  const token = randomUUID();
  const temporary = join(root, `.hekayati-storage-probe-${token}.tmp`);
  const committed = join(root, `.hekayati-storage-probe-${token}.ok`);
  const directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await writeAndSync(temporary);
    await rename(temporary, committed);
    await directory.sync();
    await unlink(committed);
    await directory.sync();
  } catch (error) {
    await cleanupProbeFiles(temporary, committed);
    throw error;
  } finally {
    await directory.close();
  }
}

async function writeAndSync(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(PROBE_PAYLOAD);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanupProbeFiles(...paths: readonly string[]): Promise<void> {
  await Promise.allSettled(paths.map((path) => unlink(path)));
}

function validMinimumFreeBytes(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

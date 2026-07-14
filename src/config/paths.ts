import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface DataPaths {
  root: string;
  assets: string;
  originals: string;
  logs: string;
  database: string;
  ownershipMarker: string;
}

const ownershipMarker = JSON.stringify({
  product: "Hekayati",
  schemaVersion: 1,
});

export function resolveDataPaths(override?: string): DataPaths {
  const root = resolve(
    override ??
      process.env.HEKAYATI_DATA_DIR ??
      join(homedir(), "Library", "Application Support", "Hekayati"),
  );
  return {
    root,
    assets: join(root, "assets"),
    originals: join(root, "originals"),
    logs: join(root, "logs"),
    database: join(root, "hekayati.db"),
    ownershipMarker: join(root, ".hekayati-data-root.json"),
  };
}

export async function prepareDataPaths(paths: DataPaths): Promise<void> {
  process.umask(0o077);
  await prepareOwnedRoot(paths);
  for (const directory of [paths.assets, paths.originals, paths.logs])
    await preparePrivateDirectory(directory);
}

export async function secureFile(file: string): Promise<void> {
  const handle = await open(file, "a", 0o600);
  await handle.close();
  await chmod(file, 0o600);
}

async function prepareOwnedRoot(paths: DataPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const info = await lstat(paths.root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("INVALID_DATA_ROOT");
  if (!(await hasOwnershipMarker(paths.ownershipMarker))) {
    const entries = await readdir(paths.root);
    if (entries.length > 0) throw new Error("UNOWNED_DATA_ROOT");
    await createOwnershipMarker(paths.ownershipMarker);
  }
  await chmod(paths.root, 0o700);
}

async function hasOwnershipMarker(marker: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    if (hasCode(error, "ELOOP"))
      throw new Error("INVALID_DATA_ROOT_MARKER", { cause: error });
    throw error;
  }
  try {
    const info = await handle.stat();
    const content = await handle.readFile("utf8");
    if (!info.isFile() || info.nlink !== 1 || content !== ownershipMarker)
      throw new Error("INVALID_DATA_ROOT_MARKER");
    await handle.chmod(0o600);
    return true;
  } finally {
    await handle.close();
  }
}

async function createOwnershipMarker(marker: string): Promise<void> {
  try {
    await writeFile(marker, ownershipMarker, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (hasCode(error, "EEXIST") && (await hasOwnershipMarker(marker))) return;
    throw error;
  }
}

async function preparePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("INVALID_DATA_DIRECTORY");
  await chmod(directory, 0o700);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

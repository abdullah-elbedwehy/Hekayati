import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { normalizePhotoIntakeError, PhotoIntakeError } from "./errors.js";
import type { HeicConverter } from "./types.js";

const execFileAsync = promisify(execFile);

export class SipsHeicConverter implements HeicConverter {
  constructor(
    private readonly binary = "/usr/bin/sips",
    private readonly temporaryRoot = tmpdir(),
  ) {}

  async convertToPng(bytes: Buffer, maxPixels?: number): Promise<Buffer> {
    const directory = await createPrivateTemporaryDirectory(this.temporaryRoot);
    const input = join(directory, ".hekayati-tmp-input.heic");
    const output = join(directory, ".hekayati-tmp-output.png");
    try {
      await writeFile(input, bytes, { flag: "wx", mode: 0o600 });
      await assertSipsPixelLimit(this.binary, input, maxPixels);
      await execFileAsync(
        this.binary,
        ["-s", "format", "png", input, "--out", output],
        { timeout: 30_000, maxBuffer: 64 * 1024 },
      );
      await chmod(output, 0o600);
      const converted = await readFile(output);
      if (converted.byteLength === 0)
        throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
      return converted;
    } catch (error) {
      throw normalizePhotoIntakeError(error);
    } finally {
      await removePrivateTemporaryDirectory(directory);
    }
  }
}

async function createPrivateTemporaryDirectory(root: string): Promise<string> {
  try {
    const directory = await mkdtemp(join(root, ".hekayati-heic-"));
    await chmod(directory, 0o700);
    return directory;
  } catch {
    throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
  }
}

async function assertSipsPixelLimit(
  binary: string,
  input: string,
  maxPixels?: number,
): Promise<void> {
  if (maxPixels === undefined) return;
  const { stdout } = await execFileAsync(
    binary,
    ["-g", "pixelWidth", "-g", "pixelHeight", input],
    { timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8" },
  );
  const width = readSipsDimension(stdout, "pixelWidth");
  const height = readSipsDimension(stdout, "pixelHeight");
  if (BigInt(width) * BigInt(height) > BigInt(maxPixels))
    throw new PhotoIntakeError("PHOTO_PIXEL_LIMIT_EXCEEDED");
}

function readSipsDimension(output: string, key: string): number {
  const match = new RegExp(`(?:^|\\n)\\s*${key}:\\s*(\\d+)\\s*(?:$|\\n)`).exec(
    output,
  );
  const value = Number(match?.[1]);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
  return value;
}

async function removePrivateTemporaryDirectory(
  directory: string,
): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    try {
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
    } catch {
      throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
    }
  }
}

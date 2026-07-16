import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

const run = promisify(execFile);

export interface PrintProofRaster {
  kind: "interior" | "cover";
  bytes: Buffer;
  widthPx: number;
  heightPx: number;
}

export async function createPrintProofRasters(
  interiorPdf: Buffer,
  coverPdf: Buffer,
  pdftoppm = "pdftoppm",
): Promise<[PrintProofRaster, PrintProofRaster]> {
  const directory = await mkdtemp(join(tmpdir(), "hekayati-print-proof-"));
  try {
    const interior = await rasterOne(
      "interior",
      interiorPdf,
      directory,
      pdftoppm,
    );
    const cover = await rasterOne("cover", coverPdf, directory, pdftoppm);
    return [interior, cover];
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function rasterOne(
  kind: "interior" | "cover",
  pdf: Buffer,
  directory: string,
  pdftoppm: string,
): Promise<PrintProofRaster> {
  const input = join(directory, `${kind}.pdf`);
  const prefix = join(directory, `${kind}-proof`);
  const output = `${prefix}.png`;
  await writeFile(input, pdf, { mode: 0o600 });
  try {
    await run(
      pdftoppm,
      ["-f", "1", "-l", "1", "-singlefile", "-png", "-r", "72", input, prefix],
      { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
    );
  } catch (error) {
    throw new Error("PRINT_PROOF_RASTER_FAILED", { cause: error });
  }
  const bytes = await readFile(output);
  const metadata = await sharp(bytes, { failOn: "error" }).metadata();
  if (
    metadata.format !== "png" ||
    !metadata.width ||
    !metadata.height ||
    bytes.length > 16 * 1024 * 1024
  )
    throw new Error("PRINT_PROOF_RASTER_INVALID");
  return { kind, bytes, widthPx: metadata.width, heightPx: metadata.height };
}

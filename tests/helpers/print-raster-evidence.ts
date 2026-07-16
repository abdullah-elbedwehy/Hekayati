import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

import type {
  CropMarkSegment,
  MillimeterBox,
} from "../../src/domain/print/geometry.js";

const run = promisify(execFile);

export const ARABIC_PRINT_RASTER_GOLDENS = [
  [
    2,
    "long-name title",
    "763c16b7a928b44d571ed3a25f72ea2c1147d6afc2c65ba558a17293fb53af1c",
  ],
  [
    3,
    "connected forms",
    "f04a701e0a6fd3f6823d03d97027450211b9f4c67b635479612f71cbc8913597",
  ],
  [
    4,
    "lam-alef",
    "d50666cbb812a204a97639dcbc22ffc656b5da4a08b08f1099015bd73628f947",
  ],
  [
    5,
    "tashkeel and punctuation",
    "bbd1cd791c859f0da31af55d102c5ef939c2c0b6f6a6a10340ac81cadd3c7294",
  ],
  [
    6,
    "mixed BiDi",
    "9f2732b75b0f8362f5e213c0b37dfcc72dc6a1c69647360c3f349653ee82db59",
  ],
] as const;

export interface PdfRasterPage {
  pageNumber: number;
  bytes: Buffer;
  widthPx: number;
  heightPx: number;
}

export interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface InkEvidence {
  count: number;
  bounds: PixelBox | null;
  normalizedHash: string;
}

export async function rasterizePdf(
  pdfBytes: Buffer,
  dpi = 96,
): Promise<PdfRasterPage[]> {
  const directory = await mkdtemp(join(tmpdir(), "hekayati-raster-evidence-"));
  const input = join(directory, "input.pdf");
  const prefix = join(directory, "page");
  try {
    await writeFile(input, pdfBytes, { mode: 0o600 });
    await run("pdftoppm", ["-png", "-r", String(dpi), input, prefix], {
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    const names = (await readdir(directory))
      .filter((name) => /^page-\d+\.png$/u.test(name))
      .sort((left, right) => pageNumber(left) - pageNumber(right));
    return await Promise.all(
      names.map(async (name) => {
        const bytes = await readFile(join(directory, name));
        const metadata = await sharp(bytes).metadata();
        if (!metadata.width || !metadata.height)
          throw new Error("PRINT_RASTER_DIMENSIONS_MISSING");
        return {
          pageNumber: pageNumber(name),
          bytes,
          widthPx: metadata.width,
          heightPx: metadata.height,
        };
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function millimeterBoxToPixels(
  box: MillimeterBox,
  raster: Pick<PdfRasterPage, "widthPx" | "heightPx">,
  media: MillimeterBox,
  insetPx = 0,
): PixelBox {
  const scaleX = raster.widthPx / media.width;
  const scaleY = raster.heightPx / media.height;
  const left = Math.round(box.x * scaleX) + insetPx;
  const top = Math.round(box.y * scaleY) + insetPx;
  const right = Math.round((box.x + box.width) * scaleX) - insetPx;
  const bottom = Math.round((box.y + box.height) * scaleY) - insetPx;
  if (right <= left || bottom <= top)
    throw new Error("PRINT_RASTER_PIXEL_BOX_INVALID");
  return { left, top, width: right - left, height: bottom - top };
}

export function normalizedBox(
  outer: MillimeterBox,
  region: { x: number; y: number; width: number; height: number },
): MillimeterBox {
  return {
    x: outer.x + outer.width * region.x,
    y: outer.y + outer.height * region.y,
    width: outer.width * region.width,
    height: outer.height * region.height,
  };
}

export function cropMarkPixelBox(
  mark: CropMarkSegment,
  raster: Pick<PdfRasterPage, "widthPx" | "heightPx">,
  media: MillimeterBox,
): PixelBox {
  const scaleX = raster.widthPx / media.width;
  const scaleY = raster.heightPx / media.height;
  const left = Math.floor(Math.min(mark.from.x, mark.to.x) * scaleX) - 1;
  const top = Math.floor(Math.min(mark.from.y, mark.to.y) * scaleY) - 1;
  const right = Math.ceil(Math.max(mark.from.x, mark.to.x) * scaleX) + 2;
  const bottom = Math.ceil(Math.max(mark.from.y, mark.to.y) * scaleY) + 2;
  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
    width: Math.max(2, Math.min(raster.widthPx, right) - Math.max(0, left)),
    height: Math.max(2, Math.min(raster.heightPx, bottom) - Math.max(0, top)),
  };
}

export function trimBoundaryStrips(
  trim: PixelBox,
  edge: "top" | "right" | "bottom" | "left",
  thickness = 2,
): { inside: PixelBox; outside: PixelBox } {
  const horizontalInset = Math.round(trim.width * 0.25);
  const verticalInset = Math.round(trim.height * 0.25);
  if (edge === "left" || edge === "right") {
    const top = trim.top + verticalInset;
    const height = trim.height - verticalInset * 2;
    const boundary = edge === "left" ? trim.left : trim.left + trim.width;
    return {
      inside: {
        left: edge === "left" ? boundary + 1 : boundary - thickness - 1,
        top,
        width: thickness,
        height,
      },
      outside: {
        left: edge === "left" ? boundary - thickness - 1 : boundary + 1,
        top,
        width: thickness,
        height,
      },
    };
  }
  const left = trim.left + horizontalInset;
  const width = trim.width - horizontalInset * 2;
  const boundary = edge === "top" ? trim.top : trim.top + trim.height;
  return {
    inside: {
      left,
      top: edge === "top" ? boundary + 1 : boundary - thickness - 1,
      width,
      height: thickness,
    },
    outside: {
      left,
      top: edge === "top" ? boundary - thickness - 1 : boundary + 1,
      width,
      height: thickness,
    },
  };
}

export async function meanRgb(
  raster: Buffer,
  box: PixelBox,
): Promise<[number, number, number]> {
  const pixels = await rawCrop(raster, box);
  const sum = [0, 0, 0];
  for (let index = 0; index < pixels.length; index += 3) {
    sum[0] += pixels[index] ?? 0;
    sum[1] += pixels[index + 1] ?? 0;
    sum[2] += pixels[index + 2] ?? 0;
  }
  const count = pixels.length / 3;
  return [sum[0] / count, sum[1] / count, sum[2] / count];
}

export function maximumChannelDelta(
  left: readonly number[],
  right: readonly number[],
): number {
  return Math.max(
    ...left.map((value, index) => Math.abs(value - right[index])),
  );
}

export async function approvedTrimMeanError(input: {
  raster: Buffer;
  trim: PixelBox;
  approvedImage: Buffer;
}): Promise<number> {
  const actual = await rawCrop(input.raster, inset(input.trim, 2));
  const expected = await sharp(input.approvedImage)
    .resize(input.trim.width, input.trim.height, { fit: "cover" })
    .extract({
      left: 2,
      top: 2,
      width: input.trim.width - 4,
      height: input.trim.height - 4,
    })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();
  if (actual.length !== expected.length)
    throw new Error("PRINT_RASTER_TRIM_COMPARISON_INVALID");
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1)
    difference += Math.abs(actual[index] - expected[index]);
  return difference / actual.length;
}

export async function inkEvidence(
  raster: Buffer,
  box: PixelBox,
  darkThreshold = 105,
): Promise<InkEvidence> {
  const pixels = await rawCrop(raster, box);
  let left = box.width;
  let right = -1;
  let top = box.height;
  let bottom = -1;
  let count = 0;
  const mask = Buffer.alloc(box.width * box.height, 255);
  for (let y = 0; y < box.height; y += 1) {
    for (let x = 0; x < box.width; x += 1) {
      const source = (y * box.width + x) * 3;
      const dark =
        (pixels[source] ?? 255) < darkThreshold &&
        (pixels[source + 1] ?? 255) < darkThreshold &&
        (pixels[source + 2] ?? 255) < darkThreshold;
      if (!dark) continue;
      mask[y * box.width + x] = 0;
      count += 1;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  const bounds =
    count === 0
      ? null
      : { left, top, width: right - left + 1, height: bottom - top + 1 };
  return {
    count,
    bounds,
    normalizedHash: bounds ? await normalizedMaskHash(mask, box, bounds) : "",
  };
}

export async function darkFraction(
  raster: Buffer,
  box: PixelBox,
  threshold = 105,
): Promise<number> {
  const pixels = await rawCrop(raster, box);
  let dark = 0;
  for (let index = 0; index < pixels.length; index += 3) {
    if (
      (pixels[index] ?? 255) < threshold &&
      (pixels[index + 1] ?? 255) < threshold &&
      (pixels[index + 2] ?? 255) < threshold
    )
      dark += 1;
  }
  return dark / (pixels.length / 3);
}

export async function rasterStructureComparison(
  left: Buffer,
  right: Buffer,
): Promise<{
  correlation: number;
  grayscaleMeanAbsoluteDifference: number;
  rgbMeanAbsoluteDifference: number;
}> {
  const [leftPixels, rightPixels, leftRgb, rightRgb] = await Promise.all([
    grayscale64(left),
    grayscale64(right),
    rgb64(left),
    rgb64(right),
  ]);
  const leftMean = average(leftPixels);
  const rightMean = average(rightPixels);
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  let absoluteDifference = 0;
  for (let index = 0; index < leftPixels.length; index += 1) {
    const leftDelta = leftPixels[index] - leftMean;
    const rightDelta = rightPixels[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
    absoluteDifference += Math.abs(leftPixels[index] - rightPixels[index]);
  }
  return {
    correlation: numerator / Math.sqrt(leftVariance * rightVariance),
    grayscaleMeanAbsoluteDifference: absoluteDifference / leftPixels.length,
    rgbMeanAbsoluteDifference: meanAbsoluteBufferDifference(leftRgb, rightRgb),
  };
}

async function rawCrop(raster: Buffer, box: PixelBox): Promise<Buffer> {
  return await sharp(raster)
    .extract(box)
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();
}

async function normalizedMaskHash(
  mask: Buffer,
  outer: PixelBox,
  bounds: PixelBox,
): Promise<string> {
  const normalized = await sharp(mask, {
    raw: { width: outer.width, height: outer.height, channels: 1 },
  })
    .extract(bounds)
    .resize(160, 56, {
      fit: "contain",
      background: "#fff",
      kernel: sharp.kernel.nearest,
    })
    .threshold(128)
    .raw()
    .toBuffer();
  return createHash("sha256").update(normalized).digest("hex");
}

async function grayscale64(bytes: Buffer): Promise<Buffer> {
  return await sharp(bytes)
    .resize(64, 64, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
}

async function rgb64(bytes: Buffer): Promise<Buffer> {
  return await sharp(bytes)
    .resize(64, 64, { fit: "fill" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();
}

function inset(box: PixelBox, pixels: number): PixelBox {
  return {
    left: box.left + pixels,
    top: box.top + pixels,
    width: box.width - pixels * 2,
    height: box.height - pixels * 2,
  };
}

function average(values: Buffer): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanAbsoluteBufferDifference(left: Buffer, right: Buffer): number {
  if (left.length !== right.length)
    throw new Error("PRINT_RASTER_COMPARISON_INVALID");
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference += Math.abs(left[index] - right[index]);
  return difference / left.length;
}

function pageNumber(name: string): number {
  const matched = /-(\d+)\.png$/u.exec(name);
  if (!matched) throw new Error("PRINT_RASTER_PAGE_NAME_INVALID");
  return Number(matched[1]);
}

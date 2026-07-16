import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

import type {
  CropMarkSegment,
  MillimeterBox,
} from "../domain/print/geometry.js";

const run = promisify(execFile);
const RASTER_DPI = 96;
const MAX_RASTER_PAGES = 40;

export interface CropMarkPageEvidence {
  pageNumber: number;
  detectedSegmentCount: number;
}

interface CropInspectionPage {
  pageNumber: number;
  mediaBoxMm: MillimeterBox | null;
  bleedBoxMm: MillimeterBox | null;
}

export async function inspectCropMarkSegments(input: {
  pdfPath: string;
  pdftoppm: string;
  pageBoxes: Array<{
    pageNumber: number;
    mediaBoxMm: MillimeterBox | null;
    bleedBoxMm: MillimeterBox | null;
  }>;
  expectedSegments: readonly CropMarkSegment[];
}): Promise<CropMarkPageEvidence[]> {
  const pages = input.pageBoxes.slice(0, MAX_RASTER_PAGES);
  if (input.expectedSegments.length === 0)
    return pages.map((page) => evidence(page.pageNumber, 0));
  const directory = await mkdtemp(join(tmpdir(), "hekayati-crop-evidence-"));
  const prefix = join(directory, "page");
  try {
    await rasterizePages(input, prefix, pages.length);
    const files = (await readdir(directory))
      .filter((file) => /^page-\d+\.png$/u.test(file))
      .sort((left, right) => pageIndex(left) - pageIndex(right));
    return await Promise.all(
      pages.map((page, index) =>
        inspectCropPage(directory, files[index], page, input.expectedSegments),
      ),
    );
  } catch {
    return pages.map((page) => evidence(page.pageNumber, 0));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function rasterizePages(
  input: { pdfPath: string; pdftoppm: string },
  prefix: string,
  pageCount: number,
): Promise<void> {
  await run(
    input.pdftoppm,
    [
      "-f",
      "1",
      "-l",
      String(pageCount),
      "-r",
      String(RASTER_DPI),
      "-png",
      input.pdfPath,
      prefix,
    ],
    { timeout: 60_000, maxBuffer: 512 * 1024, windowsHide: true },
  );
}

async function inspectCropPage(
  directory: string,
  file: string | undefined,
  page: CropInspectionPage,
  expectedSegments: readonly CropMarkSegment[],
): Promise<CropMarkPageEvidence> {
  const mediaBox = page.mediaBoxMm;
  if (!file || !mediaBox) return evidence(page.pageNumber, 0);
  const raster = await sharp(join(directory, file))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const count = expectedSegments.filter((segment) =>
    segmentHasInk(
      raster.data,
      raster.info.width,
      raster.info.height,
      raster.info.channels,
      mediaBox,
      page.bleedBoxMm,
      segment,
    ),
  ).length;
  return evidence(page.pageNumber, count);
}

function segmentHasInk(
  pixels: Buffer,
  width: number,
  height: number,
  channels: number,
  media: MillimeterBox,
  bleed: MillimeterBox | null,
  segment: CropMarkSegment,
): boolean {
  const samples = Array.from({ length: 17 }, (_, index) => {
    const ratio = index / 16;
    return {
      x: segment.from.x + (segment.to.x - segment.from.x) * ratio,
      y: segment.from.y + (segment.to.y - segment.from.y) * ratio,
    };
  });
  const outsideBleed = bleed
    ? samples.filter((point) => !contains(bleed, point.x, point.y, 0.05))
    : samples;
  const inspected = outsideBleed.length >= 3 ? outsideBleed : samples;
  const xScale = width / media.width;
  const yScale = height / media.height;
  const inked = inspected.filter((point) => {
    const x = Math.round((point.x - media.x) * xScale);
    const y = Math.round((point.y - media.y) * yScale);
    return nearbyInk(pixels, width, height, channels, x, y);
  }).length;
  return inked >= Math.max(2, Math.ceil(inspected.length * 0.4));
}

function nearbyInk(
  pixels: Buffer,
  width: number,
  height: number,
  channels: number,
  centerX: number,
  centerY: number,
): boolean {
  for (let y = centerY - 2; y <= centerY + 2; y += 1) {
    for (let x = centerX - 2; x <= centerX + 2; x += 1) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const offset = (y * width + x) * channels;
      const red = pixels[offset] ?? 255;
      const green = pixels[offset + 1] ?? red;
      const blue = pixels[offset + 2] ?? red;
      if ((red + green + blue) / 3 < 225) return true;
    }
  }
  return false;
}

function contains(
  box: MillimeterBox,
  x: number,
  y: number,
  tolerance: number,
): boolean {
  return (
    x >= box.x - tolerance &&
    y >= box.y - tolerance &&
    x <= box.x + box.width + tolerance &&
    y <= box.y + box.height + tolerance
  );
}

function evidence(
  pageNumber: number,
  detectedSegmentCount: number,
): CropMarkPageEvidence {
  return { pageNumber, detectedSegmentCount };
}

function pageIndex(file: string): number {
  return Number.parseInt(/(\d+)/u.exec(file)?.[1] ?? "0", 10);
}

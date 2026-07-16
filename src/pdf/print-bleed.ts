import { createHash } from "node:crypto";

import sharp, { type Sharp } from "sharp";

import type { MillimeterBox } from "../domain/print/geometry.js";
import type { PrintDocumentImage } from "./print-document.js";

const MAX_INPUT_PIXELS = 100_000_000;
const MAX_OUTPUT_PIXELS = 120_000_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface BleedMarginsMm {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type PrintBleedImageCache = Map<string, Promise<PrintDocumentImage>>;

export function createPrintBleedImageCache(): PrintBleedImageCache {
  return new Map();
}

export async function extendPrintImageForBleed(input: {
  image: PrintDocumentImage;
  trimBoxMm: Pick<MillimeterBox, "width" | "height">;
  marginsMm: BleedMarginsMm;
  cache: PrintBleedImageCache;
}): Promise<PrintDocumentImage> {
  const key = cacheKey(input.image, input.trimBoxMm, input.marginsMm);
  const existing = input.cache.get(key);
  if (existing) return await existing;
  const pending = extend(input.image, input.trimBoxMm, input.marginsMm);
  input.cache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    input.cache.delete(key);
    throw error;
  }
}

async function extend(
  image: PrintDocumentImage,
  trim: Pick<MillimeterBox, "width" | "height">,
  margins: BleedMarginsMm,
): Promise<PrintDocumentImage> {
  try {
    validateGeometry(image, trim, margins);
    const metadata = await sharp(image.bytes, sharpOptions()).metadata();
    if (
      metadata.width !== image.widthPx ||
      metadata.height !== image.heightPx ||
      !matchesMime(metadata.format, image.mime)
    )
      fail();
    const crop = centerCoverCrop(image.widthPx, image.heightPx, trim);
    const extension = extensionPixels(crop, trim, margins);
    assertOutputBounds(crop, extension);
    const pipeline = sharp(image.bytes, sharpOptions())
      .extract(crop)
      .extend({ ...extension, extendWith: "copy" });
    const bytes = await encode(pipeline, image.mime);
    if (bytes.length === 0 || bytes.length > MAX_OUTPUT_BYTES) fail();
    const widthPx = crop.width + extension.left + extension.right;
    const heightPx = crop.height + extension.top + extension.bottom;
    return {
      ...image,
      bytes,
      widthPx,
      heightPx,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      effectivePpi: Math.min(
        crop.width / (trim.width / 25.4),
        crop.height / (trim.height / 25.4),
      ),
    };
  } catch (error) {
    if (error instanceof PrintBleedExtensionError) throw error;
    throw new PrintBleedExtensionError(error);
  }
}

function validateGeometry(
  image: PrintDocumentImage,
  trim: Pick<MillimeterBox, "width" | "height">,
  margins: BleedMarginsMm,
): void {
  const values = [
    image.widthPx,
    image.heightPx,
    trim.width,
    trim.height,
    margins.top,
    margins.right,
    margins.bottom,
    margins.left,
  ];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    image.widthPx <= 0 ||
    image.heightPx <= 0 ||
    trim.width <= 0 ||
    trim.height <= 0 ||
    Object.values(margins).some((value) => value < 0) ||
    image.widthPx * image.heightPx > MAX_INPUT_PIXELS
  )
    fail();
}

function centerCoverCrop(
  width: number,
  height: number,
  trim: Pick<MillimeterBox, "width" | "height">,
) {
  const sourceAspect = width / height;
  const targetAspect = trim.width / trim.height;
  if (sourceAspect > targetAspect) {
    const cropWidth = Math.max(
      1,
      Math.min(width, Math.round(height * targetAspect)),
    );
    return {
      left: Math.floor((width - cropWidth) / 2),
      top: 0,
      width: cropWidth,
      height,
    };
  }
  const cropHeight = Math.max(
    1,
    Math.min(height, Math.round(width / targetAspect)),
  );
  return {
    left: 0,
    top: Math.floor((height - cropHeight) / 2),
    width,
    height: cropHeight,
  };
}

function extensionPixels(
  crop: { width: number; height: number },
  trim: Pick<MillimeterBox, "width" | "height">,
  margins: BleedMarginsMm,
) {
  return {
    top: Math.round((crop.height * margins.top) / trim.height),
    right: Math.round((crop.width * margins.right) / trim.width),
    bottom: Math.round((crop.height * margins.bottom) / trim.height),
    left: Math.round((crop.width * margins.left) / trim.width),
  };
}

function assertOutputBounds(
  crop: { width: number; height: number },
  extension: { top: number; right: number; bottom: number; left: number },
): void {
  const width = crop.width + extension.left + extension.right;
  const height = crop.height + extension.top + extension.bottom;
  if (width <= 0 || height <= 0 || width * height > MAX_OUTPUT_PIXELS) fail();
}

async function encode(
  pipeline: Sharp,
  mime: PrintDocumentImage["mime"],
): Promise<Buffer> {
  return mime === "image/png"
    ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
    : await pipeline
        .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
        .toBuffer();
}

function matchesMime(
  format: string | undefined,
  mime: PrintDocumentImage["mime"],
): boolean {
  return (
    (mime === "image/png" && format === "png") ||
    (mime === "image/jpeg" && format === "jpeg")
  );
}

function cacheKey(
  image: PrintDocumentImage,
  trim: Pick<MillimeterBox, "width" | "height">,
  margins: BleedMarginsMm,
): string {
  return [
    image.checksum,
    image.mime,
    image.widthPx,
    image.heightPx,
    fixed(trim.width),
    fixed(trim.height),
    fixed(margins.top),
    fixed(margins.right),
    fixed(margins.bottom),
    fixed(margins.left),
  ].join(":");
}

function fixed(value: number): string {
  return value.toFixed(6);
}

function sharpOptions() {
  return { failOn: "error" as const, limitInputPixels: MAX_INPUT_PIXELS };
}

function fail(): never {
  throw new PrintBleedExtensionError();
}

export class PrintBleedExtensionError extends Error {
  readonly name = "PrintBleedExtensionError";
  constructor(cause?: unknown) {
    super("PRINT_BLEED_EXTENSION_FAILED", cause === undefined ? {} : { cause });
  }
}

import { createHash } from "node:crypto";

import sharp, { type Metadata } from "sharp";

const millimetresPerInch = 25.4;
const maximumSourceBytes = 100 * 1024 * 1024;
const maximumSourcePixels = 80_000_000;

export const previewDerivativePolicyV1 = Object.freeze({
  schemaVersion: 1 as const,
  policyId: "PreviewDerivativePolicy/v1",
  targetPpi: 150,
  format: "jpeg" as const,
  quality: 82,
  chromaSubsampling: "4:4:4",
  progressive: false,
  optimiseScans: false,
  kernel: "lanczos3" as const,
  background: "#fff8e8",
  thumbnail: Object.freeze({
    maxWidthPx: 320,
    maxHeightPx: 452,
    quality: 72,
  }),
});

export const previewDerivativePolicyHash = createHash("sha256")
  .update(JSON.stringify(previewDerivativePolicyV1))
  .digest("hex");

export interface PreviewDerivativeRequest {
  sourceBytes: Uint8Array;
  placedWidthMm: number;
  placedHeightMm: number;
  fit?: "cover" | "contain";
}

export interface PreviewImageDerivative {
  bytes: Buffer;
  mime: "image/jpeg";
  widthPx: number;
  heightPx: number;
  xPpi: number;
  yPpi: number;
  sha256: string;
  policyHash: string;
}

export interface PreviewThumbnail {
  bytes: Buffer;
  mime: "image/jpeg";
  widthPx: number;
  heightPx: number;
  sha256: string;
}

export async function createPreviewImageDerivative(
  request: PreviewDerivativeRequest,
): Promise<PreviewImageDerivative> {
  assertDerivativeRequest(request);
  const widthPx = millimetresToPixels(request.placedWidthMm);
  const heightPx = millimetresToPixels(request.placedHeightMm);
  const image = sharp(Buffer.from(request.sourceBytes), sharpOptions());
  const metadata = await image.metadata();
  const source = orientedDimensions(metadata);
  assertEnoughResolution(source, { widthPx, heightPx }, request.fit ?? "cover");
  const output = await image
    .rotate()
    .flatten({ background: previewDerivativePolicyV1.background })
    .resize({
      width: widthPx,
      height: heightPx,
      fit: request.fit ?? "cover",
      position: "centre",
      kernel: previewDerivativePolicyV1.kernel,
      withoutEnlargement: false,
      background: previewDerivativePolicyV1.background,
    })
    .jpeg(jpegOptions(previewDerivativePolicyV1.quality))
    .toBuffer({ resolveWithObject: true });
  return derivativeResult(
    output.data,
    output.info.width,
    output.info.height,
    request,
  );
}

export async function createPreviewPageThumbnail(
  watermarkedPageRaster: Uint8Array,
): Promise<PreviewThumbnail> {
  assertSourceBytes(watermarkedPageRaster);
  const output = await sharp(Buffer.from(watermarkedPageRaster), sharpOptions())
    .rotate()
    .flatten({ background: previewDerivativePolicyV1.background })
    .resize({
      width: previewDerivativePolicyV1.thumbnail.maxWidthPx,
      height: previewDerivativePolicyV1.thumbnail.maxHeightPx,
      fit: "inside",
      kernel: previewDerivativePolicyV1.kernel,
      withoutEnlargement: true,
    })
    .jpeg(jpegOptions(previewDerivativePolicyV1.thumbnail.quality))
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: output.data,
    mime: "image/jpeg",
    widthPx: output.info.width,
    heightPx: output.info.height,
    sha256: sha256(output.data),
  };
}

function derivativeResult(
  bytes: Buffer,
  widthPx: number,
  heightPx: number,
  request: PreviewDerivativeRequest,
): PreviewImageDerivative {
  return {
    bytes,
    mime: "image/jpeg",
    widthPx,
    heightPx,
    xPpi: roundPpi(widthPx, request.placedWidthMm),
    yPpi: roundPpi(heightPx, request.placedHeightMm),
    sha256: sha256(bytes),
    policyHash: previewDerivativePolicyHash,
  };
}

function assertDerivativeRequest(request: PreviewDerivativeRequest): void {
  assertSourceBytes(request.sourceBytes);
  for (const value of [request.placedWidthMm, request.placedHeightMm]) {
    if (!Number.isFinite(value) || value <= 0 || value > 1_000)
      throw new Error("PREVIEW_PLACEMENT_DIMENSIONS_INVALID");
  }
}

function assertSourceBytes(bytes: Uint8Array): void {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumSourceBytes)
    throw new Error("PREVIEW_IMAGE_SOURCE_INVALID");
}

function sharpOptions() {
  return {
    failOn: "error" as const,
    limitInputPixels: maximumSourcePixels,
    sequentialRead: true,
  };
}

function orientedDimensions(metadata: Metadata) {
  if (!metadata.width || !metadata.height)
    throw new Error("PREVIEW_IMAGE_SOURCE_INVALID");
  const swapsAxes =
    metadata.orientation !== undefined && metadata.orientation >= 5;
  return {
    widthPx: swapsAxes ? metadata.height : metadata.width,
    heightPx: swapsAxes ? metadata.width : metadata.height,
  };
}

function assertEnoughResolution(
  source: { widthPx: number; heightPx: number },
  target: { widthPx: number; heightPx: number },
  fit: "cover" | "contain",
): void {
  const scale =
    fit === "cover"
      ? Math.max(
          target.widthPx / source.widthPx,
          target.heightPx / source.heightPx,
        )
      : Math.min(
          target.widthPx / source.widthPx,
          target.heightPx / source.heightPx,
        );
  if (scale > 1) throw new Error("PREVIEW_SOURCE_RESOLUTION_TOO_LOW");
}

function jpegOptions(quality: number) {
  return {
    quality,
    chromaSubsampling: previewDerivativePolicyV1.chromaSubsampling,
    progressive: previewDerivativePolicyV1.progressive,
    optimiseScans: previewDerivativePolicyV1.optimiseScans,
    mozjpeg: false,
  };
}

function millimetresToPixels(value: number): number {
  return Math.max(
    1,
    Math.round(
      (value / millimetresPerInch) * previewDerivativePolicyV1.targetPpi,
    ),
  );
}

function roundPpi(pixels: number, millimetres: number): number {
  return Math.round((pixels / (millimetres / millimetresPerInch)) * 10) / 10;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

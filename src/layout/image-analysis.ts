import sharp from "sharp";

import type { NormalizedRegion } from "./measure.js";

export const IMAGE_ANALYSIS_VERSION = "hekayati.image-analysis.v1";

export interface RegionAnalysis {
  quietness: number;
  contrast: number;
  meanLuminance: number;
}

export async function analyzeImageRegions<
  T extends Record<string, NormalizedRegion>,
>(
  bytes: Uint8Array,
  regions: T,
): Promise<
  { [K in keyof T]: RegionAnalysis } & {
    analysisVersion: typeof IMAGE_ANALYSIS_VERSION;
  }
> {
  const decoded = await sharp(bytes, { failOn: "warning" })
    .rotate()
    .removeAlpha()
    .greyscale()
    .resize(128, 128, { fit: "fill", kernel: "nearest" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const result: Record<string, RegionAnalysis | string> = {
    analysisVersion: IMAGE_ANALYSIS_VERSION,
  };
  for (const [name, region] of Object.entries(regions))
    result[name] = analyzeRegion(
      decoded.data,
      decoded.info.width,
      decoded.info.height,
      region,
    );
  return result as { [K in keyof T]: RegionAnalysis } & {
    analysisVersion: typeof IMAGE_ANALYSIS_VERSION;
  };
}

function analyzeRegion(
  data: Buffer,
  width: number,
  height: number,
  region: NormalizedRegion,
): RegionAnalysis {
  assertRegion(region);
  const x0 = Math.floor(region.x * width);
  const y0 = Math.floor(region.y * height);
  const x1 = Math.max(x0 + 1, Math.ceil((region.x + region.width) * width));
  const y1 = Math.max(y0 + 1, Math.ceil((region.y + region.height) * height));
  const values: number[] = [];
  let edge = 0;
  let comparisons = 0;
  for (let y = y0; y < Math.min(y1, height); y += 1) {
    for (let x = x0; x < Math.min(x1, width); x += 1) {
      const value = data[y * width + x] ?? 0;
      values.push(value);
      if (x + 1 < Math.min(x1, width)) {
        edge += Math.abs(value - (data[y * width + x + 1] ?? value));
        comparisons += 1;
      }
      if (y + 1 < Math.min(y1, height)) {
        edge += Math.abs(value - (data[(y + 1) * width + x] ?? value));
        comparisons += 1;
      }
    }
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const edgeRatio = comparisons ? edge / comparisons / 255 : 0;
  const varianceRatio = Math.min(1, variance / (255 * 255 * 0.25));
  const quietness = clamp(1 - edgeRatio * 0.7 - varianceRatio * 0.3);
  const luminance = mean / 255;
  const contrastWithBlack = (luminance + 0.05) / 0.05;
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  return {
    quietness: round(quietness),
    contrast: round(Math.max(contrastWithBlack, contrastWithWhite)),
    meanLuminance: round(luminance),
  };
}

function assertRegion(region: NormalizedRegion): void {
  if (
    ![region.x, region.y, region.width, region.height].every(Number.isFinite) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width <= 0 ||
    region.height <= 0 ||
    region.x + region.width > 1 ||
    region.y + region.height > 1
  )
    throw new Error("LAYOUT_REGION_INVALID");
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

import { hashCanonical } from "../layout/hashes.js";
import type { PrinterProfileVersion } from "./schemas.js";

export function interiorProfileHash(version: PrinterProfileVersion): string {
  return hashCanonical({
    trim: version.trim,
    bleedMm: version.bleedMm,
    safeContentRegion: version.safeContentRegion,
    dpiMin: version.dpiMin,
    color: version.color,
    cropMarks: version.cropMarks,
    requiredBlankPages: version.requiredBlankPages,
  });
}

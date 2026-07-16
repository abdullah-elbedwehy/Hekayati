import type { PrintPreflightReport } from "../../src/domain/print/schemas.js";

export function persistedPdfFactsFixture(
  pageCount: number,
): PrintPreflightReport["measurements"]["interior"] {
  return {
    pageCount,
    encrypted: false,
    parseable: true,
    mediaBoxMm: null,
    bleedBoxMm: null,
    trimBoxMm: null,
    pageBoxes: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      rotation: 0,
      mediaBoxMm: null,
      bleedBoxMm: null,
      trimBoxMm: null,
      portrait: pageCount !== 1,
    })),
    fonts: [],
    imageCount: pageCount,
    imagePpi: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      imageCount: 1,
      minimumPpi: 300,
    })),
    minimumImagePpi: 300,
    textBounds: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      wordCount: 0,
      boundsMm: null,
      unsafeWordCount: 0,
      firstUnsafeWordBoundsMm: null,
    })),
    cropMarkSegments: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      detectedSegmentCount: 0,
    })),
    hasArabicText: true,
    arabicGlyphCount: 1,
    unmappedGlyphCount: 0,
    watermarkCount: 0,
    watermarkPages: [],
    prohibitedFeatureCount: 0,
    externalResourceCount: 0,
    hasDeviceRgb: true,
    hasDeviceCmyk: false,
  };
}

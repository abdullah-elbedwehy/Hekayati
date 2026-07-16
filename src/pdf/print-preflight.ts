import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanPreflightFacts,
  evaluatePreflightFacts,
  type PrintPreflightCode,
  type PrintPreflightEvaluation,
  type PrintPreflightFacts,
} from "../domain/print/preflight.js";
import type {
  CropMarkSegment,
  MillimeterBox,
  OutputPageMapEntry,
} from "../domain/print/geometry.js";
import type { PrinterProfileVersion } from "../domain/print/schemas.js";
import {
  collectToolVersions,
  inspectPdf,
  resolvedTools,
  type PdfMechanicalFacts,
  type PrintPreflightTools,
} from "./print-preflight-inspection.js";
import {
  firstBoxMismatch,
  firstLowPpi,
  firstOrientationMismatch,
} from "./print-preflight-geometry-evidence.js";
import {
  firstCropMarkMismatch,
  firstSafeMarginViolation,
} from "./print-preflight-layout-evidence.js";
import type {
  PrintCoverRenderResult,
  PrintRenderResult,
} from "./print-renderer.js";

export type {
  PdfMechanicalFacts,
  PdfPageBoxFacts,
  PdfPageImagePpiFacts,
  PrintPreflightTools,
} from "./print-preflight-inspection.js";

export interface PrintPreflightInput {
  interiorPdf: Buffer;
  coverPdf: Buffer;
  interiorRender: PrintRenderResult;
  coverRender: PrintCoverRenderResult;
  profile: PrinterProfileVersion;
  interiorGeometry: ExpectedPdfGeometry;
  coverGeometry: ExpectedCoverPdfGeometry;
  pageMap: OutputPageMapEntry[];
  expectedPageMapHash: string;
  actualPageMapHash: string;
  blanksMatch: boolean;
  sourceAssetsPresent: boolean;
  sourceChecksumsMatch: boolean;
  previewWatermarkPresent: boolean;
  expectedContentAuthorizationHash: string;
  actualContentAuthorizationHash: string;
  expectedProfileHash: string;
  actualProfileHash: string;
  cmyk?: {
    conversionPassed: boolean;
    iccPresent: boolean;
    outputIntentMatches: boolean;
    cmykOnly: boolean;
  };
  tools?: Partial<PrintPreflightTools>;
}

interface ExpectedPdfGeometry {
  mediaBoxMm: MillimeterBox;
  bleedBoxMm: MillimeterBox;
  trimBoxMm: MillimeterBox;
  safeBoxMm: MillimeterBox;
  cropMarks: CropMarkSegment[];
}

interface ExpectedCoverPdfGeometry extends ExpectedPdfGeometry {
  panels: Array<{
    safeBoxMm: MillimeterBox;
  }>;
}

interface InspectedDocument {
  artifact: "interior" | "cover";
  actual: PdfMechanicalFacts;
}

export interface MechanicalPrintPreflightReport {
  evaluation: PrintPreflightEvaluation;
  facts: PrintPreflightFacts;
  interior: PdfMechanicalFacts;
  cover: PdfMechanicalFacts;
  toolVersions: Record<string, string>;
}

export async function preflightPrintBundle(
  input: PrintPreflightInput,
): Promise<MechanicalPrintPreflightReport> {
  const directory = await mkdtemp(join(tmpdir(), "hekayati-print-preflight-"));
  const interiorPath = join(directory, "interior.pdf");
  const coverPath = join(directory, "cover.pdf");
  try {
    await Promise.all([
      writeFile(interiorPath, input.interiorPdf, { mode: 0o600 }),
      writeFile(coverPath, input.coverPdf, { mode: 0o600 }),
    ]);
    const tools = resolvedTools(input.tools);
    const [interior, cover, toolVersions] = await Promise.all([
      inspectPdf(interiorPath, tools, input.interiorGeometry.cropMarks, [
        input.interiorGeometry.safeBoxMm,
      ]),
      inspectPdf(
        coverPath,
        tools,
        input.coverGeometry.cropMarks,
        input.coverGeometry.panels.map((panel) => panel.safeBoxMm),
      ),
      collectToolVersions(tools),
    ]);
    return {
      ...evaluatePrintMechanicalFacts(input, interior, cover),
      interior,
      cover,
      toolVersions,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function evaluatePrintMechanicalFacts(
  input: PrintPreflightInput,
  interior: PdfMechanicalFacts,
  cover: PdfMechanicalFacts,
): Pick<MechanicalPrintPreflightReport, "evaluation" | "facts"> {
  const facts = buildFacts(input, interior, cover);
  return { evaluation: evaluatePreflightFacts(facts), facts };
}

function buildFacts(
  input: PrintPreflightInput,
  interior: PdfMechanicalFacts,
  cover: PdfMechanicalFacts,
): PrintPreflightFacts {
  const facts = cloneCleanFacts();
  const geometry = documentFacts(facts, input, interior, cover);
  sourceAndQualityFacts(facts, input, interior, cover);
  fontFacts(facts, input, interior, cover);
  coverFacts(facts, input, interior, cover, geometry);
  colorFacts(facts, input, interior, cover);
  securityFacts(facts, input, interior, cover);
  bindingFacts(facts, input);
  return facts;
}

function documentFacts(
  facts: PrintPreflightFacts,
  input: PrintPreflightInput,
  interior: PdfMechanicalFacts,
  cover: PdfMechanicalFacts,
): { dimensionsMatch: boolean; bleedMatches: boolean } {
  pdfValidityFacts(facts, [interior, cover]);
  const dimensions = pageGeometryFacts(facts, input, interior, cover);
  pageMappingFacts(facts, input, interior, cover);
  const bleed = bleedFact(facts, input, interior, cover);
  return { dimensionsMatch: dimensions === null, bleedMatches: bleed === null };
}

function pdfValidityFacts(
  facts: PrintPreflightFacts,
  documents: PdfMechanicalFacts[],
): void {
  set(
    facts,
    "PDF_CORRUPT",
    documents.every((item) => item.parseable),
    documents.filter((item) => !item.parseable).length,
  );
  set(
    facts,
    "PDF_ENCRYPTED",
    documents.every((item) => !item.encrypted),
    documents.filter((item) => item.encrypted).length,
  );
}

function pageGeometryFacts(
  facts: PrintPreflightFacts,
  input: PrintPreflightInput,
  interior: PdfMechanicalFacts,
  cover: PdfMechanicalFacts,
) {
  const dimensions =
    firstBoxMismatch(interior, input.interiorGeometry, "interior", [
      "mediaBoxMm",
      "trimBoxMm",
    ]) ??
    firstBoxMismatch(cover, input.coverGeometry, "cover", [
      "mediaBoxMm",
      "trimBoxMm",
    ]);
  set(
    facts,
    "PAGE_DIMENSIONS_MISMATCH",
    dimensions === null,
    dimensions?.actual ?? "all_page_boxes_match",
    dimensions ?? undefined,
  );

  const orientation =
    firstOrientationMismatch(interior, "interior", true) ??
    firstOrientationMismatch(cover, "cover", false);
  set(
    facts,
    "PAGE_ORIENTATION_INVALID",
    orientation === null,
    orientation?.actual ?? "all_page_orientations_match",
    orientation ?? undefined,
  );
  return dimensions;
}

function pageMappingFacts(
  facts: PrintPreflightFacts,
  input: PrintPreflightInput,
  interior: PdfMechanicalFacts,
  cover: PdfMechanicalFacts,
): void {
  const countMismatch =
    interior.pageCount !== input.pageMap.length
      ? evidence("interior", null, input.pageMap.length, interior.pageCount)
      : cover.pageCount !== 1
        ? evidence("cover", null, 1, cover.pageCount)
        : null;
  set(
    facts,
    "PAGE_COUNT_MISMATCH",
    countMismatch === null,
    countMismatch?.actual ?? `${interior.pageCount}+${cover.pageCount}`,
    countMismatch ?? undefined,
  );
  set(
    facts,
    "PAGE_MAP_MISMATCH",
    input.expectedPageMapHash === input.actualPageMapHash,
    "page_map_hash_mismatch",
  );
  set(facts, "PRINTER_BLANK_MISMATCH", input.blanksMatch, "blank_map_mismatch");
}

function bleedFact(
  facts: PrintPreflightFacts,
  input: PrintPreflightInput,
  interior: PdfMechanicalFacts,
  cover: PdfMechanicalFacts,
) {
  const bleed =
    firstBoxMismatch(interior, input.interiorGeometry, "interior", [
      "bleedBoxMm",
    ]) ?? firstBoxMismatch(cover, input.coverGeometry, "cover", ["bleedBoxMm"]);
  set(
    facts,
    "BLEED_MISSING",
    bleed === null,
    bleed?.actual ?? "all_bleed_boxes_match",
    bleed ?? undefined,
  );
  return bleed;
}

function sourceAndQualityFacts(
  facts: PrintPreflightFacts,
  input: PrintPreflightInput,
  interior: PdfMechanicalFacts,
  cover: PdfMechanicalFacts,
): void {
  sourceAssetFacts(facts, input, interior, cover);
  imagePpiFact(facts, input, interior, cover);
  overflowFacts(facts, input, interior, cover);
}

function sourceAssetFacts(
  facts: PrintPreflightFacts,
  input: PrintPreflightInput,
  interior: PdfMechanicalFacts,
  cover: PdfMechanicalFacts,
): void {
  const imageCountsMatch =
    (input.interiorRender.minimumImagePpi === null ||
      interior.imageCount > 0) &&
    (input.coverRender.minimumImagePpi === null || cover.imageCount > 0);
  const missingArtifact = interior.imageCount === 0 ? "interior" : "cover";
  set(
    facts,
    "SOURCE_ASSET_MISSING",
    input.sourceAssetsPresent && imageCountsMatch,
    input.sourceAssetsPresent
      ? `interior=${interior.imageCount};cover=${cover.imageCount}`
      : "source_manifest_missing",
    {
      artifact: missingArtifact,
      page: null,
      expected: "every rendered source has a PDF image",
    },
  );
  set(
    facts,
    "SOURCE_CHECKSUM_MISMATCH",
    input.sourceChecksumsMatch,
    "source_checksum_mismatch",
  );
}

function imagePpiFact(
  facts: PrintPreflightFacts,
  input: PrintPreflightInput,
  interior: PdfMechanicalFacts,
  cover: PdfMechanicalFacts,
): void {
  const lowPpi =
    firstLowPpi(interior, "interior", input.profile.dpiMin) ??
    firstLowPpi(cover, "cover", input.profile.dpiMin);
  const expectedAnyImage =
    input.interiorRender.minimumImagePpi !== null ||
    input.coverRender.minimumImagePpi !== null;
  const parsedMinimum = minimum([
    interior.minimumImagePpi,
    cover.minimumImagePpi,
  ]);
  const missingPpi = expectedAnyImage && parsedMinimum === null;
  const ppiEvidence =
    lowPpi ??
    (missingPpi
      ? evidence("bundle", null, input.profile.dpiMin, "missing")
      : null);
  set(
    facts,
    "IMAGE_PPI_LOW",
    ppiEvidence === null,
    ppiEvidence?.actual ?? parsedMinimum ?? 0,
    ppiEvidence ?? undefined,
  );
}

function overflowFacts(
  facts: PrintPreflightFacts,
  input: PrintPreflightInput,
  interior: PdfMechanicalFacts,
  cover: PdfMechanicalFacts,
): void {
  const overflow = firstPageEvidence(
    input.interiorRender.overflowPageNumbers,
    input.coverRender.overflowPageNumbers,
  );
  const overflowCount =
    input.interiorRender.overflowPageNumbers.length +
    input.coverRender.overflowPageNumbers.length;
  set(
    facts,
    "TEXT_OVERFLOW",
    overflow === null,
    overflowCount,
    overflow ?? undefined,
  );
  const unsafe =
    firstSafeMarginViolation(
      interior,
      [input.interiorGeometry.safeBoxMm],
      "interior",
    ) ??
    firstSafeMarginViolation(
      cover,
      input.coverGeometry.panels.map((panel) => panel.safeBoxMm),
      "cover",
    );
  set(
    facts,
    "SAFE_MARGIN_VIOLATION",
    unsafe === null,
    unsafe?.actual ?? "all_text_inside_safe_box",
    unsafe ?? undefined,
  );
}

function fontFacts(
  facts: PrintPreflightFacts,
  input: PrintPreflightInput,
  interior: PdfMechanicalFacts,
  cover: PdfMechanicalFacts,
): void {
  const documents: InspectedDocument[] = [
    { artifact: "interior", actual: interior },
    { artifact: "cover", actual: cover },
  ];
  missingFontFact(facts, input, documents);
  fontIntegrityFacts(facts, documents);
  glyphFact(facts, documents);
}

function missingFontFact(
  facts: PrintPreflightFacts,
  input: PrintPreflightInput,
  documents: InspectedDocument[],
): void {
  const requiredFonts = [
    ...new Set([
      ...input.interiorRender.fontNames,
      ...input.coverRender.fontNames,
    ]),
  ];
  const actualFonts = documents.flatMap((document) => document.actual.fonts);
  const missing = requiredFonts.filter(
    (required) =>
      !actualFonts.some((font) => fontMatchesRequired(font.name, required)),
  );
  set(
    facts,
    "FONT_MISSING",
    missing.length === 0,
    missing.length,
    missing[0] ? evidence("bundle", null, missing[0], "missing") : undefined,
  );
}

function fontIntegrityFacts(
  facts: PrintPreflightFacts,
  documents: InspectedDocument[],
): void {
  const fonts = documents.flatMap((document) =>
    document.actual.fonts.map((font) => ({
      artifact: document.artifact,
      font,
    })),
  );
  setFontBooleanFact(facts, "FONT_NOT_EMBEDDED", fonts, "embedded");
  setFontBooleanFact(facts, "FONT_NOT_SUBSETTED", fonts, "subset");
  setFontBooleanFact(facts, "FONT_TOUNICODE_MISSING", fonts, "toUnicode");
}

function glyphFact(
  facts: PrintPreflightFacts,
  documents: InspectedDocument[],
): void {
  const glyphFailure = documents.find(
    (document) =>
      !document.actual.hasArabicText ||
      document.actual.arabicGlyphCount === 0 ||
      document.actual.unmappedGlyphCount > 0 ||
      document.actual.fonts.some((font) => !isApprovedFontIdentity(font.name)),
  );
  const unmapped = glyphFailure?.actual.unmappedGlyphCount ?? 0;
  set(
    facts,
    "GLYPH_COVERAGE_MISSING",
    !glyphFailure,
    glyphFailure
      ? unmapped > 0
        ? unmapped
        : "missing_or_unapproved_arabic_glyphs"
      : 0,
    glyphFailure
      ? evidence(glyphFailure.artifact, null, 0, unmapped)
      : undefined,
  );
}

function coverFacts(
  facts: PrintPreflightFacts,
  input: PrintPreflightInput,
  interior: PdfMechanicalFacts,
  cover: PdfMechanicalFacts,
  geometry: { dimensionsMatch: boolean; bleedMatches: boolean },
): void {
  const cropMismatch =
    firstCropMarkMismatch(
      interior,
      input.interiorGeometry.cropMarks.length,
      "interior",
    ) ??
    firstCropMarkMismatch(cover, input.coverGeometry.cropMarks.length, "cover");
  set(
    facts,
    "CROP_MARKS_INVALID",
    cropMismatch === null,
    cropMismatch?.actual ?? "all_crop_segments_detected",
    cropMismatch ?? undefined,
  );
  set(
    facts,
    "COVER_SPREAD_INVALID",
    geometry.dimensionsMatch && geometry.bleedMatches && cover.pageCount === 1,
    cover.pageCount,
    { artifact: "cover", page: 1, expected: 1 },
  );
  const panelOrder = input.coverRender.panelOrder.join("-");
  set(
    facts,
    "COVER_PANEL_ORDER_INVALID",
    panelOrder === "back-spine-front",
    panelOrder,
    { artifact: "cover", page: 1, expected: "back-spine-front" },
  );
  set(
    facts,
    "SPINE_WIDTH_UNKNOWN",
    (input.profile.spine.widthMm ?? 0) > 0,
    input.profile.spine.widthMm ?? 0,
    { artifact: "cover", page: 1, expected: ">0mm" },
  );
}

function colorFacts(
  facts: PrintPreflightFacts,
  input: PrintPreflightInput,
  interior: PdfMechanicalFacts,
  cover: PdfMechanicalFacts,
): void {
  const both = [interior, cover];
  if (input.profile.color.mode === "rgb") {
    set(
      facts,
      "COLOR_MODE_MISMATCH",
      both.every((item) => !item.hasDeviceCmyk),
      both.filter((item) => item.hasDeviceCmyk).length,
    );
    set(facts, "ICC_PROFILE_MISSING", true, "not_applicable_rgb");
    set(facts, "ICC_OUTPUT_INTENT_MISMATCH", true, "not_applicable_rgb");
    set(facts, "COLOR_CONVERSION_FAILED", true, "not_applicable_rgb");
    return;
  }
  const cmyk = input.cmyk;
  set(facts, "COLOR_MODE_MISMATCH", Boolean(cmyk?.cmykOnly), false);
  set(facts, "ICC_PROFILE_MISSING", Boolean(cmyk?.iccPresent), false);
  set(
    facts,
    "ICC_OUTPUT_INTENT_MISMATCH",
    Boolean(cmyk?.outputIntentMatches),
    false,
  );
  set(facts, "COLOR_CONVERSION_FAILED", Boolean(cmyk?.conversionPassed), false);
}

function securityFacts(
  facts: PrintPreflightFacts,
  input: PrintPreflightInput,
  interior: PdfMechanicalFacts,
  cover: PdfMechanicalFacts,
): void {
  const documents: InspectedDocument[] = [
    { artifact: "interior", actual: interior },
    { artifact: "cover", actual: cover },
  ];
  watermarkFact(facts, documents);
  set(
    facts,
    "PREVIEW_WATERMARK_MISSING",
    input.previewWatermarkPresent,
    input.previewWatermarkPresent,
    { artifact: "preview", page: 1, expected: true },
  );
  set(
    facts,
    "PDF_PROHIBITED_FEATURE",
    documents.every((document) => document.actual.prohibitedFeatureCount === 0),
    documents.reduce(
      (sum, document) => sum + document.actual.prohibitedFeatureCount,
      0,
    ),
  );
  set(
    facts,
    "EXTERNAL_RESOURCE_PRESENT",
    documents.every((document) => document.actual.externalResourceCount === 0),
    documents.reduce(
      (sum, document) => sum + document.actual.externalResourceCount,
      0,
    ),
  );
}

function watermarkFact(
  facts: PrintPreflightFacts,
  documents: InspectedDocument[],
): void {
  const watermarked = documents.find(
    (document) => document.actual.printWatermarkCount > 0,
  );
  set(
    facts,
    "PRINT_WATERMARK_PRESENT",
    !watermarked,
    documents.reduce(
      (sum, document) => sum + document.actual.printWatermarkCount,
      0,
    ),
    watermarked
      ? {
          artifact: watermarked.artifact,
          page: watermarked.actual.printWatermarkPages[0] ?? null,
          expected: 0,
        }
      : undefined,
  );
}

function bindingFacts(
  facts: PrintPreflightFacts,
  input: PrintPreflightInput,
): void {
  set(
    facts,
    "AUTHORIZATION_MISMATCH",
    input.expectedContentAuthorizationHash ===
      input.actualContentAuthorizationHash,
    "authorization_hash_mismatch",
  );
  set(
    facts,
    "PROFILE_VERSION_MISMATCH",
    input.expectedProfileHash === input.actualProfileHash,
    "profile_hash_mismatch",
  );
}

type FindingEvidence = {
  artifact: "interior" | "cover" | "preview" | "bundle";
  page: number | null;
  expected: string | number | boolean;
  actual?: string | number | boolean;
};

function setFontBooleanFact(
  facts: PrintPreflightFacts,
  code: "FONT_NOT_EMBEDDED" | "FONT_NOT_SUBSETTED" | "FONT_TOUNICODE_MISSING",
  fonts: Array<{
    artifact: "interior" | "cover";
    font: PdfMechanicalFacts["fonts"][number];
  }>,
  field: "embedded" | "subset" | "toUnicode",
): void {
  const failed = fonts.find((entry) => !entry.font[field]);
  set(
    facts,
    code,
    !failed,
    failed?.font.name ?? false,
    failed
      ? evidence(failed.artifact, null, true, failed.font.name)
      : undefined,
  );
}

function fontMatchesRequired(
  actualName: string,
  requiredName: string,
): boolean {
  const actual = normalizedFontName(actualName);
  return requiredFontIdentities(requiredName).includes(actual);
}

function isApprovedFontIdentity(actualName: string): boolean {
  const actual = normalizedFontName(actualName);
  return [
    ...requiredFontIdentities("Hekayati Arabic"),
    ...requiredFontIdentities("Hekayati Brand"),
  ].includes(actual);
}

function requiredFontIdentities(requiredName: string): string[] {
  const required = normalizedFontName(requiredName);
  const aliases: Record<string, string[]> = {
    hekayatiarabic: [
      "ibmplexsansarabic",
      "ibmplexsansarabicregular",
      "ibmplexsansarabicbold",
    ],
    hekayatibrand: ["lemonada", "lemonadabold"],
  };
  return aliases[required] ?? [required];
}

function cloneCleanFacts(): PrintPreflightFacts {
  return {
    policyVersion: cleanPreflightFacts.policyVersion,
    checks: Object.fromEntries(
      Object.entries(cleanPreflightFacts.checks).map(([code, fact]) => [
        code,
        { ...fact },
      ]),
    ) as PrintPreflightFacts["checks"],
  };
}

function firstPageEvidence(
  interior: number[],
  cover: number[],
): FindingEvidence | null {
  if (interior[0] !== undefined) return evidence("interior", interior[0], 0, 1);
  if (cover[0] !== undefined) return evidence("cover", cover[0], 0, 1);
  return null;
}

function normalizedFontName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function evidence(
  artifact: FindingEvidence["artifact"],
  page: number | null,
  expected: FindingEvidence["expected"],
  actual: FindingEvidence["actual"],
): FindingEvidence {
  return { artifact, page, expected, actual };
}

function set(
  facts: PrintPreflightFacts,
  code: PrintPreflightCode,
  passed: boolean,
  actual: string | number | boolean,
  finding?: FindingEvidence,
): void {
  facts.checks[code] = passed
    ? { passed, actual }
    : {
        passed,
        actual,
        ...(finding
          ? {
              artifact: finding.artifact,
              page: finding.page,
              expected: finding.expected,
            }
          : {}),
      };
}

function minimum(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value !== null);
  return finite.length ? Math.min(...finite) : null;
}

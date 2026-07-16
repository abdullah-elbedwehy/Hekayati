import { describe, expect, it } from "vitest";

import {
  compileCoverGeometry,
  compileInteriorGeometry,
  type MillimeterBox,
  type OutputPageMapEntry,
} from "../../src/domain/print/geometry.js";
import { PRINT_PREFLIGHT_CODES } from "../../src/domain/print/preflight.js";
import {
  createDefaultPrinterProfileDraft,
  finalizePrinterProfileVersion,
  type PrinterProfileVersion,
} from "../../src/domain/print/schemas.js";
import {
  evaluatePrintMechanicalFacts,
  type PdfMechanicalFacts,
  type PrintPreflightInput,
} from "../../src/pdf/print-preflight.js";
import {
  parsePdfImages,
  parsePdfInfo,
  parsePdfText,
  parsePdfTextBounds,
} from "../../src/pdf/print-preflight-inspection.js";
import {
  PRINT_FONT_POLICY_VERSION,
  PRINT_RENDERER_VERSION,
  type PrintRenderResult,
} from "../../src/pdf/print-renderer.js";

const at = "2026-07-15T00:00:00.000Z";
const id = (index: number) => `01J${String(index).padStart(23, "0")}`;

describe("mechanical print preflight detection", () => {
  it("passes clean RGB and CMYK facts", () => {
    const rgb = cleanBundle(readyProfile("rgb"));
    expect(
      evaluatePrintMechanicalFacts(rgb.input, rgb.interior, rgb.cover)
        .evaluation,
    ).toEqual(expect.objectContaining({ passed: true, findings: [] }));

    const cmyk = cleanBundle(readyProfile("cmyk"));
    cmyk.interior.hasDeviceRgb = false;
    cmyk.interior.hasDeviceCmyk = true;
    cmyk.cover.hasDeviceRgb = false;
    cmyk.cover.hasDeviceCmyk = true;
    cmyk.input.cmyk = {
      conversionPassed: true,
      iccPresent: true,
      outputIntentMatches: true,
      cmykOnly: true,
    };
    expect(
      evaluatePrintMechanicalFacts(cmyk.input, cmyk.interior, cmyk.cover)
        .evaluation,
    ).toEqual(expect.objectContaining({ passed: true, findings: [] }));
  });

  it("catches one seeded failure for every closed registry row", () => {
    expect(seeds.map((seed) => seed.code)).toEqual(PRINT_PREFLIGHT_CODES);

    for (const seed of seeds) {
      const bundle = cleanBundle(
        readyProfile(seed.code.startsWith("ICC_") ? "cmyk" : "rgb"),
      );
      if (bundle.input.profile.color.mode === "cmyk") {
        bundle.interior.hasDeviceRgb = false;
        bundle.interior.hasDeviceCmyk = true;
        bundle.cover.hasDeviceRgb = false;
        bundle.cover.hasDeviceCmyk = true;
        bundle.input.cmyk = {
          conversionPassed: true,
          iccPresent: true,
          outputIntentMatches: true,
          cmykOnly: true,
        };
      }
      seed.mutate(bundle);
      const evaluation = evaluatePrintMechanicalFacts(
        bundle.input,
        bundle.interior,
        bundle.cover,
      ).evaluation;
      expect(evaluation.passed, seed.code).toBe(false);
      expect(
        evaluation.findings.map((finding) => finding.code),
        seed.code,
      ).toContain(seed.code);
    }
  });

  it("attributes a bad later-page box, low PPI, and watermark to exact pages", () => {
    const bundle = cleanBundle(readyProfile());
    bundle.interior.pageBoxes[7].trimBoxMm!.width -= 2;
    bundle.interior.imagePpi[10].minimumPpi = 149;
    bundle.interior.minimumImagePpi = 149;
    bundle.interior.printWatermarkCount = 1;
    bundle.interior.printWatermarkPages = [12];

    const findings = evaluatePrintMechanicalFacts(
      bundle.input,
      bundle.interior,
      bundle.cover,
    ).evaluation.findings;
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PAGE_DIMENSIONS_MISMATCH",
          artifact: "interior",
          page: 8,
        }),
        expect.objectContaining({
          code: "IMAGE_PPI_LOW",
          artifact: "interior",
          page: 11,
          actual: 149,
        }),
        expect.objectContaining({
          code: "PRINT_WATERMARK_PRESENT",
          artifact: "interior",
          page: 12,
        }),
      ]),
    );
  });

  it("rejects lookalike font names instead of accepting prefix matches", () => {
    const bundle = cleanBundle(readyProfile());
    for (const document of [bundle.interior, bundle.cover]) {
      document.fonts[0].name = "IBMPlexSansArabicUntrusted";
      document.fonts[1].name = "LemonadaClone";
    }

    const findings = evaluatePrintMechanicalFacts(
      bundle.input,
      bundle.interior,
      bundle.cover,
    ).evaluation.findings;
    expect(findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["FONT_MISSING", "GLYPH_COVERAGE_MISSING"]),
    );
  });
});

describe("bounded PDF inspection parsers", () => {
  it("parses boxes and rotation for every page", () => {
    const facts = parsePdfInfo(`Pages:           2
Encrypted:       no
Page    1 rot:   0
Page    1 MediaBox:  0.00 0.00 612.00 858.90
Page    1 BleedBox:  19.84 19.84 592.16 839.06
Page    1 TrimBox:   28.35 28.35 583.65 830.55
Page    2 rot:   0
Page    2 MediaBox:  0.00 0.00 612.00 858.90
Page    2 BleedBox:  19.84 19.84 592.16 839.06
Page    2 TrimBox:   28.35 28.35 583.65 830.55`);

    expect(facts).toMatchObject({ pageCount: 2, encrypted: false });
    expect(facts.pageBoxes).toHaveLength(2);
    expect(facts.pageBoxes[1]).toMatchObject({
      pageNumber: 2,
      rotation: 0,
      mediaBoxMm: { width: 215.9, height: 303.001 },
      bleedBoxMm: { width: 201.902, height: 289.003 },
      trimBoxMm: { width: 195.897, height: 282.998 },
    });
  });

  it("parses bounded per-image PPI and per-page text glyph facts", () => {
    const images =
      parsePdfImages(`page   num  type   width height color comp bpc enc interp object ID x-ppi y-ppi size ratio
--------------------------------------------------------------------------------------------
   1     0 image    3000  4300  rgb     3   8  jpeg   no       12  0   353   360  1M  8%
   2     1 image    1200  1800  rgb     3   8  jpeg   no       22  0   149   151  1M  8%`);
    expect(images).toEqual({
      count: 2,
      minimumPpi: 149,
      pages: [
        { pageNumber: 1, imageCount: 1, minimumPpi: 353 },
        { pageNumber: 2, imageCount: 1, minimumPpi: 149 },
      ],
    });

    expect(parsePdfText("حِكاية ليلى\fنص � غير مخصصة للطباعة\f")).toEqual({
      extractedTextLength: 35,
      hasArabicText: true,
      arabicGlyphCount: 27,
      unmappedGlyphCount: 1,
      printWatermarkCount: 1,
      printWatermarkPages: [2],
    });
    expect(
      parsePdfTextBounds(
        '<page width="100" height="200"><word xMin="10" yMin="20" xMax="30" yMax="40">حكاية</word><word xMin="1" yMin="199" xMax="2" yMax="199.1">extractor-debris</word></page>',
      ),
    ).toEqual([
      {
        pageNumber: 1,
        wordCount: 1,
        boundsMm: { x: 3.528, y: 7.056, width: 7.056, height: 7.056 },
        unsafeWordCount: 0,
        firstUnsafeWordBoundsMm: null,
      },
    ]);
  });
});

interface Bundle {
  input: PrintPreflightInput;
  interior: PdfMechanicalFacts;
  cover: PdfMechanicalFacts;
}

interface Seed {
  code: (typeof PRINT_PREFLIGHT_CODES)[number];
  mutate: (bundle: Bundle) => void;
}

const seeds: Seed[] = [
  seed("PDF_CORRUPT", ({ interior }) => (interior.parseable = false)),
  seed("PDF_ENCRYPTED", ({ cover }) => (cover.encrypted = true)),
  seed("PAGE_DIMENSIONS_MISMATCH", ({ interior }) => {
    interior.pageBoxes[5].mediaBoxMm!.width -= 1;
  }),
  seed("PAGE_ORIENTATION_INVALID", ({ interior }) => {
    interior.pageBoxes[3].rotation = 90;
  }),
  seed("PAGE_COUNT_MISMATCH", ({ interior }) => (interior.pageCount = 15)),
  seed("PAGE_MAP_MISMATCH", ({ input }) => {
    input.actualPageMapHash = "0".repeat(64);
  }),
  seed("PRINTER_BLANK_MISMATCH", ({ input }) => (input.blanksMatch = false)),
  seed("SOURCE_ASSET_MISSING", ({ input }) => {
    input.sourceAssetsPresent = false;
  }),
  seed("SOURCE_CHECKSUM_MISMATCH", ({ input }) => {
    input.sourceChecksumsMatch = false;
  }),
  seed("IMAGE_PPI_LOW", ({ interior }) => {
    interior.minimumImagePpi = 149;
    interior.imagePpi[6].minimumPpi = 149;
  }),
  seed("TEXT_OVERFLOW", ({ input }) => {
    input.interiorRender.overflowPageNumbers = [7];
  }),
  seed("FONT_MISSING", ({ interior, cover }) => {
    interior.fonts = interior.fonts.filter((font) => font.name !== "Lemonada");
    cover.fonts = cover.fonts.filter((font) => font.name !== "Lemonada");
  }),
  seed("FONT_NOT_EMBEDDED", ({ interior }) => {
    interior.fonts[0].embedded = false;
  }),
  seed("FONT_NOT_SUBSETTED", ({ interior }) => {
    interior.fonts[0].subset = false;
  }),
  seed("FONT_TOUNICODE_MISSING", ({ cover }) => {
    cover.fonts[1].toUnicode = false;
  }),
  seed("GLYPH_COVERAGE_MISSING", ({ cover }) => {
    cover.unmappedGlyphCount = 1;
  }),
  seed("BLEED_MISSING", ({ interior }) => {
    interior.pageBoxes[4].bleedBoxMm!.width -= 2;
  }),
  seed("SAFE_MARGIN_VIOLATION", ({ cover }) => {
    const unsafe = { x: 0, y: 0, width: 5, height: 5 };
    cover.textBounds[0].boundsMm = unsafe;
    cover.textBounds[0].unsafeWordCount = 1;
    cover.textBounds[0].firstUnsafeWordBoundsMm = unsafe;
  }),
  seed("CROP_MARKS_INVALID", ({ interior }) => {
    interior.cropMarkSegments[0].detectedSegmentCount = 1;
  }),
  seed("COVER_SPREAD_INVALID", ({ cover }) => (cover.pageCount = 2)),
  seed("COVER_PANEL_ORDER_INVALID", ({ input }) => {
    input.coverRender.panelOrder = ["front", "spine", "back"] as never;
  }),
  seed("SPINE_WIDTH_UNKNOWN", ({ input }) => {
    input.profile.spine.widthMm = null;
  }),
  seed("COLOR_MODE_MISMATCH", ({ interior }) => {
    interior.hasDeviceCmyk = true;
  }),
  seed("ICC_PROFILE_MISSING", ({ input }) => {
    input.cmyk!.iccPresent = false;
  }),
  seed("ICC_OUTPUT_INTENT_MISMATCH", ({ input }) => {
    input.cmyk!.outputIntentMatches = false;
  }),
  seed("COLOR_CONVERSION_FAILED", ({ input }) => {
    input.profile = readyProfile("cmyk");
    input.cmyk = {
      conversionPassed: false,
      iccPresent: true,
      outputIntentMatches: true,
      cmykOnly: true,
    };
  }),
  seed("PRINT_WATERMARK_PRESENT", ({ cover }) => {
    cover.printWatermarkCount = 1;
    cover.printWatermarkPages = [1];
  }),
  seed("PREVIEW_WATERMARK_MISSING", ({ input }) => {
    input.previewWatermarkPresent = false;
  }),
  seed("PDF_PROHIBITED_FEATURE", ({ interior }) => {
    interior.prohibitedFeatureCount = 1;
  }),
  seed("EXTERNAL_RESOURCE_PRESENT", ({ cover }) => {
    cover.externalResourceCount = 1;
  }),
  seed("AUTHORIZATION_MISMATCH", ({ input }) => {
    input.actualContentAuthorizationHash = "0".repeat(64);
  }),
  seed("PROFILE_VERSION_MISMATCH", ({ input }) => {
    input.actualProfileHash = "0".repeat(64);
  }),
];

function seed(code: Seed["code"], mutate: Seed["mutate"]): Seed {
  return { code, mutate };
}

function cleanBundle(profile: PrinterProfileVersion): Bundle {
  const interiorGeometry = compileInteriorGeometry(profile);
  const coverGeometry = compileCoverGeometry(profile);
  const pageMap = Array.from({ length: 16 }, (_, index) => page(index));
  return {
    input: {
      interiorPdf: Buffer.alloc(0),
      coverPdf: Buffer.alloc(0),
      interiorRender: renderFacts(16, 320),
      coverRender: {
        ...renderFacts(1, 320),
        panelOrder: ["back", "spine", "front"],
      },
      profile,
      interiorGeometry,
      coverGeometry,
      pageMap,
      expectedPageMapHash: "a".repeat(64),
      actualPageMapHash: "a".repeat(64),
      blanksMatch: true,
      sourceAssetsPresent: true,
      sourceChecksumsMatch: true,
      previewWatermarkPresent: true,
      expectedContentAuthorizationHash: "b".repeat(64),
      actualContentAuthorizationHash: "b".repeat(64),
      expectedProfileHash: profile.profileHash,
      actualProfileHash: profile.profileHash,
    },
    interior: mechanicalFacts(16, interiorGeometry, true),
    cover: mechanicalFacts(1, coverGeometry, false),
  };
}

function mechanicalFacts(
  pageCount: number,
  geometry: {
    mediaBoxMm: MillimeterBox;
    bleedBoxMm: MillimeterBox;
    trimBoxMm: MillimeterBox;
    safeBoxMm: MillimeterBox;
    cropMarks: unknown[];
  },
  portrait: boolean,
): PdfMechanicalFacts {
  return {
    pageCount,
    encrypted: false,
    parseable: true,
    mediaBoxMm: { ...geometry.mediaBoxMm },
    bleedBoxMm: { ...geometry.bleedBoxMm },
    trimBoxMm: { ...geometry.trimBoxMm },
    pageBoxes: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      rotation: 0,
      mediaBoxMm: { ...geometry.mediaBoxMm },
      bleedBoxMm: { ...geometry.bleedBoxMm },
      trimBoxMm: { ...geometry.trimBoxMm },
      portrait,
    })),
    fonts: [font("IBMPlexSansArabic"), font("Lemonada")],
    imageCount: pageCount,
    imagePpi: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      imageCount: 1,
      minimumPpi: 320,
    })),
    minimumImagePpi: 320,
    textBounds: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      wordCount: 1,
      boundsMm: { ...geometry.safeBoxMm },
      unsafeWordCount: 0,
      firstUnsafeWordBoundsMm: null,
    })),
    cropMarkSegments: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      detectedSegmentCount: geometry.cropMarks.length,
    })),
    extractedTextLength: 80,
    hasArabicText: true,
    arabicGlyphCount: 40,
    unmappedGlyphCount: 0,
    printWatermarkCount: 0,
    printWatermarkPages: [],
    prohibitedFeatureCount: 0,
    externalResourceCount: 0,
    hasDeviceRgb: true,
    hasDeviceCmyk: false,
  };
}

function font(name: string) {
  return { name, embedded: true, subset: true, toUnicode: true };
}

function page(index: number): OutputPageMapEntry {
  return {
    kind: "customer",
    outputPageNumber: index + 1,
    customerPageNumber: index + 1,
    pageId: id(index + 10),
    label: null,
  };
}

function renderFacts(pageCount: number, ppi: number): PrintRenderResult {
  return {
    pdfBytes: Buffer.alloc(0),
    pageCount,
    egressRequestCount: 0,
    blockedRequests: [],
    overflowPageNumbers: [],
    watermarkCount: 0,
    minimumImagePpi: ppi,
    fontNames: ["Hekayati Arabic", "Hekayati Brand"],
    rendererVersion: PRINT_RENDERER_VERSION,
    fontPolicyVersion: PRINT_FONT_POLICY_VERSION,
    renderFactsHash: "c".repeat(64),
  };
}

function readyProfile(mode: "rgb" | "cmyk" = "rgb") {
  return finalizePrinterProfileVersion({
    id: id(mode === "rgb" ? 1 : 3),
    profileId: id(mode === "rgb" ? 2 : 4),
    previousVersionId: null,
    createdAt: at,
    updatedAt: at,
    draft: {
      ...createDefaultPrinterProfileDraft(),
      spine: { source: "explicit", widthMm: 8 },
      ...(mode === "cmyk"
        ? {
            color: {
              mode: "cmyk" as const,
              iccAssetId: id(5),
              iccChecksum: "d".repeat(64),
            },
          }
        : {}),
    },
  });
}

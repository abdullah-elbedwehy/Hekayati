import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import sharp from "sharp";

import {
  compileCoverGeometry,
  compileInteriorGeometry,
  compileOutputPageMap,
} from "../../src/domain/print/geometry.js";
import { hashCanonical } from "../../src/domain/layout/hashes.js";
import {
  createDefaultPrinterProfileDraft,
  finalizePrinterProfileVersion,
} from "../../src/domain/print/schemas.js";
import type {
  PrintCoverDocument,
  PrintDocumentImage,
  PrintInteriorDocument,
} from "../../src/pdf/print-document.js";
import { preflightPrintBundle } from "../../src/pdf/print-preflight.js";
import { createPrintProofRasters } from "../../src/pdf/print-proof.js";
import {
  renderPrintCover,
  renderPrintInterior,
} from "../../src/pdf/print-renderer.js";
import { convertPdfToCmyk } from "../../src/print/cmyk.js";
import { inspectIccProfile } from "../../src/print/icc.js";
import {
  ARABIC_PRINT_RASTER_GOLDENS,
  approvedTrimMeanError,
  cropMarkPixelBox,
  darkFraction,
  inkEvidence,
  maximumChannelDelta,
  meanRgb,
  millimeterBoxToPixels,
  normalizedBox,
  rasterizePdf,
  rasterStructureComparison,
  trimBoundaryStrips,
  type PdfRasterPage,
  type PixelBox,
} from "../helpers/print-raster-evidence.js";

const run = promisify(execFile);
const temporary: string[] = [];
const at = "2026-07-15T00:00:00.000Z";
const id = (index: number) => `01J${String(index).padStart(23, "0")}`;
const iccPath = "/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc";
const textRegion = { x: 0.08, y: 0.65, width: 0.84, height: 0.25 };

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("rendered Arabic print evidence", () => {
  it("renders 24 approved customer pages plus declared blanks and raster-verifies the exact print geometry", async () => {
    const profile = readyMarkedProfile();
    const image = await fullResolutionImage();
    const map = compileOutputPageMap(
      Array.from({ length: 24 }, (_, index) => ({
        customerPageNumber: index + 1,
        pageId: id(index + 10),
      })),
      profile.requiredBlankPages,
    );
    const interior = interiorDocument(profile, image, map);
    const cover = coverDocument(profile, image, await backPanelImage(image));
    const browser = await chromium.launch({ headless: true });
    try {
      const renderedInterior = await renderPrintInterior(interior, { browser });
      const renderedCover = await renderPrintCover(cover, { browser });

      expect(renderedInterior).toMatchObject({
        pageCount: 26,
        minimumImagePpi: image.effectivePpi,
        overflowPageNumbers: [],
        watermarkCount: 0,
        egressRequestCount: 0,
      });
      expect(renderedCover).toMatchObject({
        pageCount: 1,
        panelOrder: ["back", "spine", "front"],
        minimumImagePpi: image.effectivePpi,
        overflowPageNumbers: [],
        watermarkCount: 0,
        egressRequestCount: 0,
      });
      expect(
        map
          .filter((entry) => entry.kind === "customer")
          .map((entry) => entry.customerPageNumber),
      ).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
      expect(map.filter((entry) => entry.kind === "printer_blank")).toEqual([
        expect.objectContaining({
          outputPageNumber: 1,
          customerPageNumber: null,
          label: "technical-front",
        }),
        expect.objectContaining({
          outputPageNumber: 26,
          customerPageNumber: null,
          label: "technical-back",
        }),
      ]);

      const preflight = await preflightPrintBundle({
        interiorPdf: renderedInterior.pdfBytes,
        coverPdf: renderedCover.pdfBytes,
        interiorRender: renderedInterior,
        coverRender: renderedCover,
        profile,
        interiorGeometry: interior.geometry,
        coverGeometry: cover.geometry,
        pageMap: map,
        expectedPageMapHash: hashCanonical(map),
        actualPageMapHash: hashCanonical(map),
        blanksMatch: true,
        sourceAssetsPresent: true,
        sourceChecksumsMatch: true,
        previewWatermarkPresent: true,
        expectedContentAuthorizationHash: "a".repeat(64),
        actualContentAuthorizationHash: "a".repeat(64),
        expectedProfileHash: profile.profileHash,
        actualProfileHash: profile.profileHash,
      });
      expect(preflight.evaluation).toEqual(
        expect.objectContaining({ passed: true, findings: [] }),
      );
      expect(preflight.interior).toMatchObject({
        pageCount: 26,
        encrypted: false,
        parseable: true,
        hasArabicText: true,
        unmappedGlyphCount: 0,
        printWatermarkCount: 0,
        printWatermarkPages: [],
      });
      expect(preflight.cover).toMatchObject({
        pageCount: 1,
        encrypted: false,
        parseable: true,
        hasArabicText: true,
        unmappedGlyphCount: 0,
        printWatermarkCount: 0,
        printWatermarkPages: [],
      });
      expect(preflight.interior.pageBoxes).toHaveLength(26);
      expect(preflight.cover.pageBoxes).toHaveLength(1);
      expect(
        preflight.interior.pageBoxes.every(
          (page, index) => page.pageNumber === index + 1 && page.portrait,
        ),
      ).toBe(true);
      expect(preflight.cover.pageBoxes[0]).toMatchObject({
        pageNumber: 1,
        rotation: 0,
        portrait: false,
      });
      expectBoxWithin(
        preflight.interior.mediaBoxMm,
        interior.geometry.mediaBoxMm,
        0.2,
      );
      expectBoxWithin(
        preflight.interior.bleedBoxMm,
        interior.geometry.bleedBoxMm,
        0.01,
      );
      expectBoxWithin(
        preflight.interior.trimBoxMm,
        interior.geometry.trimBoxMm,
        0.01,
      );
      expectBoxWithin(
        preflight.cover.mediaBoxMm,
        cover.geometry.mediaBoxMm,
        0.2,
      );
      expectBoxWithin(
        preflight.cover.bleedBoxMm,
        cover.geometry.bleedBoxMm,
        0.01,
      );
      expectBoxWithin(
        preflight.cover.trimBoxMm,
        cover.geometry.trimBoxMm,
        0.01,
      );
      expect(
        [...preflight.interior.fonts, ...preflight.cover.fonts].every(
          (font) => font.embedded && font.subset && font.toUnicode,
        ),
      ).toBe(true);
      const fontNames = new Set(
        [...preflight.interior.fonts, ...preflight.cover.fonts].map((font) =>
          font.name.replace(/[^A-Za-z]/gu, ""),
        ),
      );
      expect(
        [...fontNames].some((name) =>
          /^IBMPlexSansArabic(?:Regular|Bold)?$/u.test(name),
        ),
      ).toBe(true);
      expect(
        [...fontNames].some((name) => /^Lemonada(?:Bold)?$/u.test(name)),
      ).toBe(true);
      expect(preflight.interior.arabicGlyphCount).toBeGreaterThan(0);
      expect(preflight.cover.arabicGlyphCount).toBeGreaterThan(0);
      expect(preflight.interior.imagePpi).toHaveLength(24);
      expect(preflight.cover.imagePpi).toHaveLength(1);
      expect(
        [...preflight.interior.imagePpi, ...preflight.cover.imagePpi].every(
          (page) =>
            page.minimumPpi !== null && page.minimumPpi >= profile.dpiMin,
        ),
      ).toBe(true);

      const rasters = await createPrintProofRasters(
        renderedInterior.pdfBytes,
        renderedCover.pdfBytes,
      );
      expect(rasters.map((raster) => raster.kind)).toEqual([
        "interior",
        "cover",
      ]);
      expectRasterDimensions(rasters[0], interior.geometry.mediaBoxMm);
      expectRasterDimensions(rasters[1], cover.geometry.mediaBoxMm);
      for (const raster of rasters) {
        const stats = await sharp(raster.bytes).stats();
        expect(
          stats.channels.some(
            (channel) => channel.min < 32 && channel.max > 240,
          ),
        ).toBe(true);
        expect(raster.bytes.byteLength).toBeLessThan(16 * 1024 * 1024);
      }

      const interiorRasters = await rasterizePdf(renderedInterior.pdfBytes, 96);
      const coverRasters = await rasterizePdf(renderedCover.pdfBytes, 96);
      expect(interiorRasters).toHaveLength(26);
      expect(coverRasters).toHaveLength(1);
      await expectArabicVisualGoldens(interiorRasters, interior.geometry);
      await expectBlankMapping(interiorRasters, interior.geometry);
      await expectCropMarkPixels(interiorRasters[6], interior.geometry);
      await expectAllInteriorKinds(interiorRasters, interior);
      await expectRtlCoverRaster(coverRasters[0], cover);
      await expectApprovedTrimAndBleed(
        interiorRasters[6],
        interior.geometry,
        image.bytes,
      );

      const text = await extractText(renderedInterior.pdfBytes);
      expect(text).toContain("الحروف العربية متصلة");
      // pdftotext reports RTL ligature codepoints in visual extraction order;
      // the pinned rasters above are the authoritative shaping/order evidence.
      for (const extractedLamAlef of ["ال", "أل", "إل", "آل"])
        expect(text).toContain(extractedLamAlef);
      expect(text).toMatch(/[ًٌٍَُِّْ]/u);
      expect(text).toContain("HK-2048");
      // Poppler may swap the first lam/alef codepoints while extracting an
      // otherwise-correct RTL glyph run. The raster golden above verifies the
      // exact visual name; this assertion only proves the text remains present.
      expect(text).toMatch(/عبدالرحمن الطويل (?:الاسم|االسم)/u);
      expect(text).not.toContain("معاينة");
      expect(text).not.toContain("غير مخصصة للطباعة");
    } finally {
      await browser.close();
    }
  }, 90_000);

  it("raster-compares the RGB and exact-ICC CMYK cover proofs without claiming physical color approval", async () => {
    const profile = readyMarkedProfile();
    const image = await proofComparisonImage();
    const rgb = await renderPrintCover(
      coverDocument(profile, image, await backPanelImage(image)),
    );
    const iccBytes = await readFile(iccPath);
    const icc = inspectIccProfile(iccBytes);
    const cmyk = await convertPdfToCmyk({
      pdfBytes: rgb.pdfBytes,
      iccBytes,
      expectedIccChecksum: icc.checksum,
    });
    const [rgbRaster] = await rasterizePdf(rgb.pdfBytes, 72);
    const [cmykRaster] = await rasterizePdf(cmyk.pdfBytes, 72);
    expect(rgbRaster).toMatchObject({ pageNumber: 1 });
    expect(cmykRaster).toMatchObject({
      pageNumber: 1,
      widthPx: rgbRaster.widthPx,
      heightPx: rgbRaster.heightPx,
    });
    const comparison = await rasterStructureComparison(
      rgbRaster.bytes,
      cmykRaster.bytes,
    );
    expect(comparison.correlation).toBeGreaterThan(0.96);
    expect(comparison.grayscaleMeanAbsoluteDifference).toBeLessThan(36);
    expect(comparison.rgbMeanAbsoluteDifference).toBeGreaterThan(0.1);
    expect(comparison.rgbMeanAbsoluteDifference).toBeLessThan(70);
    expect(cmyk).toMatchObject({
      cmykOnly: true,
      outputIntentMatches: true,
      geometryPreserved: true,
      fontsPreserved: true,
      iccChecksum: icc.checksum,
    });
  }, 60_000);
});

function readyMarkedProfile() {
  return finalizePrinterProfileVersion({
    id: id(1),
    profileId: id(2),
    previousVersionId: null,
    createdAt: at,
    updatedAt: at,
    draft: {
      ...createDefaultPrinterProfileDraft(),
      cropMarks: {
        enabled: true,
        offsetMm: 2,
        lengthMm: 5,
        strokePt: 0.25,
      },
      spine: { source: "explicit", widthMm: 8 },
      requiredBlankPages: [
        {
          position: "before_interior",
          count: 1,
          label: "technical-front",
        },
        {
          position: "after_interior",
          count: 1,
          label: "technical-back",
        },
      ],
    },
  });
}

async function fullResolutionImage(): Promise<PrintDocumentImage> {
  const widthPx = 2_600;
  const heightPx = 3_677;
  const bytes = await sharp({
    create: {
      width: widthPx,
      height: heightPx,
      channels: 3,
      background: { r: 255, g: 248, b: 232 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="2600" height="3677"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#BDEAF2"/><stop offset="0.5" stop-color="#FFF0A6"/><stop offset="1" stop-color="#FFC38A"/></linearGradient></defs><rect width="2600" height="3677" fill="url(#g)"/><rect width="2600" height="12" fill="#E53935"/><rect y="3665" width="2600" height="12" fill="#E53935"/><rect width="12" height="3677" fill="#E53935"/><rect x="2588" width="12" height="3677" fill="#E53935"/><circle cx="650" cy="1300" r="360" fill="#39B77A"/><circle cx="1950" cy="2420" r="360" fill="#FF8A1F"/></svg>',
        ),
      },
    ])
    .png({ compressionLevel: 6 })
    .toBuffer();
  const effectivePpi = Math.min(
    widthPx / (216 / 25.4),
    heightPx / (303 / 25.4),
  );
  expect(effectivePpi).toBeGreaterThanOrEqual(300);
  return {
    bytes,
    mime: "image/png",
    widthPx,
    heightPx,
    assetId: id(3),
    checksum: "c".repeat(64),
    effectivePpi,
  };
}

function interiorDocument(
  profile: ReturnType<typeof readyMarkedProfile>,
  image: PrintDocumentImage,
  map: ReturnType<typeof compileOutputPageMap>,
): PrintInteriorDocument {
  return {
    kind: "interior",
    profile,
    geometry: compileInteriorGeometry(profile),
    sourceSnapshotHash: "d".repeat(64),
    fontManifestHash: "e".repeat(64),
    pages: map.map((entry) => {
      if (entry.kind === "printer_blank")
        return {
          map: entry,
          pageKind: "printer_blank" as const,
          image: null,
          text: null,
          bubbles: [],
        };
      return {
        map: entry,
        pageKind: pageKind(entry.customerPageNumber),
        image,
        text:
          entry.customerPageNumber === 6
            ? null
            : {
                text: pageText(entry.customerPageNumber),
                region: textRegion,
                fontSizePt: 18,
                style: entry.customerPageNumber === 1 ? "heading" : "body",
                aid: "panel",
              },
        bubbles:
          entry.customerPageNumber === 12
            ? [
                {
                  speakerLabel: "ليلى",
                  text: "يلا نكمل الحكاية!",
                  region: { x: 0.58, y: 0.12, width: 0.3, height: 0.18 },
                },
              ]
            : [],
      };
    }),
  };
}

function pageKind(
  pageNumber: number,
): "title" | "dedication" | "story" | "ending1" | "ending2" {
  if (pageNumber === 1) return "title";
  if (pageNumber === 2) return "dedication";
  if (pageNumber === 23) return "ending1";
  if (pageNumber === 24) return "ending2";
  return "story";
}

function pageText(pageNumber: number): string {
  if (pageNumber === 1)
    return "حِكايَة عبدالرحمن الطويل الاسم في مَلْعَب اللَّيْمُون";
  if (pageNumber === 2)
    return "الحروف العربية متصلة: بسم الله نبدأ الحكاية الجميلة";
  if (pageNumber === 3)
    return "لا، لأ، لإ، لآ — قال لؤي: «لا تقلق، فاللقاء قريب».";
  if (pageNumber === 4)
    return "الشَّمْسُ سَاطِعَةٌ، وَالطِّفْلَةُ تَقْرَأُ قِصَّةً! أَنَبْدَأُ الآن؟";
  if (pageNumber === 5)
    return "رقم الطلب HK-2048، مع Mira 24، والموعد 14/07/2026.";
  if (pageNumber === 23) return "وهنا انتهت الرحلة، ونلقاكم في حكاية جديدة.";
  if (pageNumber === 24) return "صُنع خصيصًا لعبدالرحمن الطويل الاسم";
  return `قالت لَيْلَى: لَأَلْعَبَنَّ مع Mira ${pageNumber} — أهلاً!`;
}

function coverDocument(
  profile: ReturnType<typeof readyMarkedProfile>,
  frontImage: PrintDocumentImage,
  backImage: PrintDocumentImage,
): PrintCoverDocument {
  return {
    kind: "cover",
    profile,
    geometry: compileCoverGeometry(profile),
    sourceSnapshotHash: "d".repeat(64),
    fontManifestHash: "e".repeat(64),
    panels: [
      {
        kind: "back",
        image: backImage,
        text: coverText("حكايتي — حكاية معمولة بحب", "heading"),
      },
      {
        kind: "spine",
        image: null,
        text: {
          text: "حكايتي",
          region: { x: 0.1, y: 0.05, width: 0.8, height: 0.9 },
          fontSizePt: 10,
          style: "heading",
          aid: "none",
        },
      },
      {
        kind: "front",
        image: frontImage,
        text: coverText("حِكايَة لَيْلَى", "heading"),
      },
    ],
  };
}

async function backPanelImage(
  source: PrintDocumentImage,
): Promise<PrintDocumentImage> {
  const bytes = await sharp({
    create: {
      width: source.widthPx,
      height: source.heightPx,
      channels: 3,
      background: { r: 72, g: 191, b: 214 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${source.widthPx}" height="${source.heightPx}"><circle cx="${Math.round(source.widthPx / 2)}" cy="${Math.round(source.heightPx * 0.62)}" r="420" fill="#2F9E6A"/></svg>`,
        ),
      },
    ])
    .png({ compressionLevel: 6 })
    .toBuffer();
  return {
    ...source,
    bytes,
    assetId: id(4),
    checksum: "b".repeat(64),
  };
}

async function proofComparisonImage(): Promise<PrintDocumentImage> {
  const fullResolution = await fullResolutionImage();
  const widthPx = 900;
  const heightPx = 1_273;
  return {
    ...fullResolution,
    bytes: await sharp(fullResolution.bytes)
      .resize(widthPx, heightPx, { fit: "cover" })
      .png({ compressionLevel: 6 })
      .toBuffer(),
    widthPx,
    heightPx,
    effectivePpi: Math.min(widthPx / (216 / 25.4), heightPx / (303 / 25.4)),
    assetId: id(5),
    checksum: "f".repeat(64),
  };
}

function coverText(text: string, style: "heading" | "body") {
  return {
    text,
    region: { x: 0.08, y: 0.08, width: 0.84, height: 0.28 },
    fontSizePt: style === "heading" ? 18 : 16,
    style,
    aid: "panel" as const,
  };
}

async function extractText(bytes: Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hekayati-print-text-"));
  temporary.push(directory);
  const path = join(directory, "interior.pdf");
  await writeFile(path, bytes, { mode: 0o600 });
  return (
    await run("pdftotext", ["-enc", "UTF-8", path, "-"], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    })
  ).stdout;
}

function expectBoxWithin(
  actual: { x: number; y: number; width: number; height: number } | null,
  expected: { x: number; y: number; width: number; height: number },
  tolerance: number,
): void {
  if (!actual) throw new Error("PRINT_EVIDENCE_BOX_MISSING");
  for (const key of ["x", "y", "width", "height"] as const)
    expect(Math.abs(actual[key] - expected[key]), key).toBeLessThanOrEqual(
      tolerance,
    );
}

function expectRasterDimensions(
  raster: { widthPx: number; heightPx: number },
  media: { width: number; height: number },
): void {
  const widthAt72Dpi = (media.width * 72) / 25.4;
  const heightAt72Dpi = (media.height * 72) / 25.4;
  expect(Math.abs(raster.widthPx - widthAt72Dpi)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(raster.heightPx - heightAt72Dpi)).toBeLessThanOrEqual(1.5);
}

async function expectBlankMapping(
  rasters: PdfRasterPage[],
  geometry: ReturnType<typeof compileInteriorGeometry>,
): Promise<void> {
  for (const pageNumber of [1, 26]) {
    const raster = rasters[pageNumber - 1];
    const trim = millimeterBoxToPixels(
      geometry.trimBoxMm,
      raster,
      geometry.mediaBoxMm,
      2,
    );
    const color = await meanRgb(raster.bytes, trim);
    expect(
      Math.min(...color),
      `blank output page ${pageNumber}`,
    ).toBeGreaterThan(253);
    expect(await darkFraction(raster.bytes, trim)).toBe(0);
  }
}

async function expectCropMarkPixels(
  raster: PdfRasterPage,
  geometry: ReturnType<typeof compileInteriorGeometry>,
): Promise<void> {
  expect(geometry.cropMarks).toHaveLength(8);
  for (const [index, mark] of geometry.cropMarks.entries()) {
    const pixels = cropMarkPixelBox(mark, raster, geometry.mediaBoxMm);
    expect(
      await darkFraction(raster.bytes, pixels, 140),
      `crop mark ${index + 1}`,
    ).toBeGreaterThan(0.015);
  }
}

async function expectApprovedTrimAndBleed(
  raster: PdfRasterPage,
  geometry: ReturnType<typeof compileInteriorGeometry>,
  approvedImage: Buffer,
): Promise<void> {
  const trim = millimeterBoxToPixels(
    geometry.trimBoxMm,
    raster,
    geometry.mediaBoxMm,
  );
  expect(
    await approvedTrimMeanError({
      raster: raster.bytes,
      trim,
      approvedImage,
    }),
  ).toBeLessThan(7);
  for (const edge of ["top", "right", "bottom", "left"] as const) {
    const strips = trimBoundaryStrips(trim, edge);
    const [inside, outside] = await Promise.all([
      meanRgb(raster.bytes, strips.inside),
      meanRgb(raster.bytes, strips.outside),
    ]);
    expect(
      maximumChannelDelta(inside, outside),
      `${edge} bleed boundary continuity`,
    ).toBeLessThan(24);
  }
}

async function expectArabicVisualGoldens(
  rasters: PdfRasterPage[],
  geometry: ReturnType<typeof compileInteriorGeometry>,
): Promise<void> {
  const textBoxMm = normalizedBox(geometry.trimBoxMm, textRegion);
  const actual: Array<{ label: string; hash: string }> = [];
  for (const [pageNumber, label] of ARABIC_PRINT_RASTER_GOLDENS) {
    const raster = rasters[pageNumber - 1];
    const textBox = millimeterBoxToPixels(
      textBoxMm,
      raster,
      geometry.mediaBoxMm,
    );
    const evidence = await inkEvidence(raster.bytes, textBox);
    expect(evidence.count, label).toBeGreaterThan(100);
    expect(evidence.bounds, label).not.toBeNull();
    expectInkInside(evidence.bounds!, textBox, label);
    actual.push({ label, hash: evidence.normalizedHash });
  }
  expect(actual).toEqual(
    ARABIC_PRINT_RASTER_GOLDENS.map(([, label, hash]) => ({ label, hash })),
  );
}

function expectInkInside(
  bounds: PixelBox,
  outer: PixelBox,
  label: string,
): void {
  expect(bounds.left, `${label} left inset`).toBeGreaterThan(4);
  expect(bounds.top, `${label} top inset`).toBeGreaterThan(4);
  expect(
    outer.width - bounds.left - bounds.width,
    `${label} right inset`,
  ).toBeGreaterThan(4);
  expect(
    outer.height - bounds.top - bounds.height,
    `${label} bottom inset`,
  ).toBeGreaterThan(4);
}

async function expectAllInteriorKinds(
  rasters: PdfRasterPage[],
  document: PrintInteriorDocument,
): Promise<void> {
  expect(new Set(document.pages.map((page) => page.pageKind))).toEqual(
    new Set([
      "title",
      "dedication",
      "story",
      "ending1",
      "ending2",
      "printer_blank",
    ]),
  );
  const customerKindPages = [2, 3, 4, 24, 25];
  for (const pageNumber of customerKindPages) {
    const raster = rasters[pageNumber - 1];
    const trim = millimeterBoxToPixels(
      document.geometry.trimBoxMm,
      raster,
      document.geometry.mediaBoxMm,
      4,
    );
    const color = await meanRgb(raster.bytes, trim);
    expect(
      maximumChannelDelta(color, [255, 255, 255]),
      `interior kind output page ${pageNumber}`,
    ).toBeGreaterThan(15);
  }
}

async function expectRtlCoverRaster(
  raster: PdfRasterPage,
  document: PrintCoverDocument,
): Promise<void> {
  const [back, spine, front] = document.geometry.panels.map((panel) =>
    millimeterBoxToPixels(panel.boxMm, raster, document.geometry.mediaBoxMm),
  );
  expect(back.left).toBeLessThan(spine.left);
  expect(spine.left).toBeLessThan(front.left);
  const [backColor, frontColor] = await Promise.all([
    meanRgb(raster.bytes, lowerPanelSample(back)),
    meanRgb(raster.bytes, lowerPanelSample(front)),
  ]);
  expect(maximumChannelDelta(backColor, [72, 191, 214])).toBeLessThan(28);
  expect(maximumChannelDelta(backColor, frontColor)).toBeGreaterThan(45);
  const spineText = document.panels[1].text;
  if (!spineText) throw new Error("PRINT_EVIDENCE_SPINE_TEXT_MISSING");
  const spineTextBox = millimeterBoxToPixels(
    normalizedBox(document.geometry.panels[1].boxMm, spineText.region),
    raster,
    document.geometry.mediaBoxMm,
  );
  const textRight = spineTextBox.left + spineTextBox.width;
  const spineRight = spine.left + spine.width;
  expect(spineTextBox.left - spine.left).toBeGreaterThanOrEqual(3);
  expect(spineRight - textRight).toBeGreaterThanOrEqual(3);
  const spineInk = await inkEvidence(raster.bytes, spineTextBox, 120);
  expect(spineInk.count).toBeGreaterThan(10);
  expect(spineInk.bounds).not.toBeNull();
  await expectCropMarkPixels(raster, document.geometry);
}

function lowerPanelSample(panel: PixelBox): PixelBox {
  return {
    left: panel.left + Math.round(panel.width * 0.32),
    top: panel.top + Math.round(panel.height * 0.78),
    width: Math.max(2, Math.round(panel.width * 0.36)),
    height: Math.max(2, Math.round(panel.height * 0.08)),
  };
}

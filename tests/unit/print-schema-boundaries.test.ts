import { describe, expect, it } from "vitest";

import { hashCanonical } from "../../src/domain/layout/hashes.js";
import {
  createDefaultPrinterProfileDraft,
  finalizePrinterProfileVersion,
  printerProfileDraftSchema,
  printerProfileVersionSchema,
  printArtifactSchema,
  printNormalizedRegionSchema,
  printPreflightReportSchema,
  printProofBundleSchema,
} from "../../src/domain/print/schemas.js";
import { persistedPdfFactsFixture } from "../helpers/print-preflight-fixtures.js";

const at = "2026-07-15T00:00:00.000Z";
const id = (index: number) => `01J${String(index).padStart(23, "0")}`;
const hash = (value: string) => value.repeat(64).slice(0, 64);

describe("strict print persistence contracts", () => {
  it.each([
    { x: 0.9, y: 0, width: 0.2, height: 1 },
    { x: 0, y: 0.9, width: 1, height: 0.2 },
    { x: Number.NaN, y: 0, width: 1, height: 1 },
  ])("rejects non-finite or escaping normalized regions", (region) => {
    expect(() => printNormalizedRegionSchema.parse(region)).toThrow();
  });

  it("rejects unknown sensitive fields, non-finite mechanics, and conflicting template truth", () => {
    const base = {
      ...createDefaultPrinterProfileDraft(),
      spine: { source: "explicit" as const, widthMm: 8 },
    };
    expect(() =>
      printerProfileDraftSchema.parse({
        ...base,
        sourcePath: "/Users/operator/printer.icc",
        geminiKey: "synthetic-secret",
      }),
    ).toThrow();
    expect(() =>
      printerProfileDraftSchema.parse({
        ...base,
        bleedMm: Number.POSITIVE_INFINITY,
      }),
    ).toThrow();

    const width = 428;
    const template = {
      assetId: id(1),
      checksum: hash("a"),
      pageWidthMm: width,
      pageHeightMm: 297,
      backRegion: { x: 0, y: 0, width: 210 / width, height: 1 },
      spineRegion: { x: 210 / width, y: 0, width: 8 / width, height: 1 },
      frontRegion: { x: 218 / width, y: 0, width: 210 / width, height: 1 },
      toleranceMm: 0.5,
    };
    expect(() =>
      printerProfileDraftSchema.parse({ ...base, coverTemplate: template }),
    ).not.toThrow();
    expect(() =>
      printerProfileDraftSchema.parse({
        ...base,
        coverTemplate: {
          ...template,
          backRegion: { ...template.backRegion, width: 200 / width },
          spineRegion: { ...template.spineRegion, x: 200 / width },
          frontRegion: {
            ...template.frontRegion,
            x: 208 / width,
            width: 220 / width,
          },
        },
      }),
    ).toThrow("COVER_TEMPLATE_PANEL_GEOMETRY_INVALID");
    expect(() =>
      printerProfileDraftSchema.parse({
        ...base,
        spine: { source: "template", widthMm: 9 },
        coverTemplate: template,
      }),
    ).toThrow("COVER_TEMPLATE_SPINE_MISMATCH");
    expect(() =>
      printerProfileDraftSchema.parse({
        ...base,
        coverTemplate: { ...template, pageWidthMm: 430 },
      }),
    ).toThrow("COVER_TEMPLATE_DIMENSIONS_MISMATCH");
    expect(() =>
      printerProfileDraftSchema.parse({
        ...base,
        coverTemplate: {
          ...template,
          backRegion: { ...template.backRegion, y: 0.1 },
        },
      }),
    ).toThrow("COVER_TEMPLATE_PANEL_GEOMETRY_INVALID");
  });

  it("binds immutable profile readiness and hash to the exact draft", () => {
    const version = readyProfile();
    expect(() =>
      printerProfileVersionSchema.parse({
        ...version,
        profileHash: hash("b"),
      }),
    ).toThrow("PRINTER_PROFILE_HASH_MISMATCH");
    expect(() =>
      printerProfileVersionSchema.parse({
        ...version,
        readiness: "incomplete",
        blockingReasons: ["SPINE_WIDTH_UNKNOWN"],
      }),
    ).toThrow("PRINTER_PROFILE_READINESS_MISMATCH");
  });

  it("rejects impossible RGB/CMYK and interior/cover artifact state pairs", () => {
    const artifact = validArtifact();
    const conversionFacts = {
      outputConditionIdentifier: "Synthetic CMYK",
      embeddedIccChecksum: hash("c"),
      embeddedIccBytes: 132,
      imageCount: 1,
      contentStreamCount: 1,
      cmykOnly: true as const,
      outputIntentMatches: true as const,
      geometryPreserved: true as const,
      fontsPreserved: true as const,
    };
    expect(() =>
      printArtifactSchema.parse({
        ...artifact,
        iccChecksum: hash("c"),
        conversionFacts,
      }),
    ).toThrow("PRINT_ARTIFACT_FACT_STATE_MISMATCH");
    expect(() =>
      printArtifactSchema.parse({ ...artifact, kind: "cover" }),
    ).toThrow("PRINT_ARTIFACT_FACT_STATE_MISMATCH");
    expect(() =>
      printArtifactSchema.parse({
        ...artifact,
        renderFacts: {
          ...artifact.renderFacts,
          panelOrder: ["back", "spine", "front"],
        },
      }),
    ).toThrow("PRINT_ARTIFACT_FACT_STATE_MISMATCH");
  });

  it("binds preflight pass state and measurement hash and enforces proof representatives", () => {
    const report = validReport();
    expect(() =>
      printPreflightReportSchema.parse({ ...report, passed: false }),
    ).toThrow("PRINT_PREFLIGHT_STATE_MISMATCH");
    expect(() =>
      printPreflightReportSchema.parse({
        ...report,
        measurementsHash: hash("f"),
      }),
    ).toThrow("PRINT_PREFLIGHT_MEASUREMENTS_HASH_MISMATCH");

    const representative = {
      kind: "interior" as const,
      assetId: id(20),
      checksum: hash("2"),
    };
    expect(() =>
      printProofBundleSchema.parse({
        id: id(21),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        projectId: id(4),
        runId: id(5),
        gateJobId: id(22),
        interiorArtifactId: id(6),
        interiorChecksum: hash("d"),
        coverArtifactId: id(7),
        coverChecksum: hash("e"),
        iccChecksum: hash("c"),
        printerProfileHash: readyProfile().profileHash,
        contentAuthorizationHash: hash("9"),
        representativeAssets: [
          representative,
          { ...representative, assetId: id(23) },
        ],
        bundleHash: hash("8"),
      }),
    ).toThrow("PRINT_PROOF_REPRESENTATIVE_DUPLICATE");
  });

  it("bounds persisted PDF facts and rejects raw extracted text", () => {
    const report = validReport();
    const parseInterior = (interior: unknown) => {
      const measurements = { ...report.measurements, interior };
      return printPreflightReportSchema.parse({
        ...report,
        measurements,
        measurementsHash: hashCanonical(measurements),
      });
    };
    const interior = report.measurements.interior;

    expect(() =>
      parseInterior({
        ...interior,
        pageBoxes: interior.pageBoxes.slice(1),
      }),
    ).toThrow("PRINT_PREFLIGHT_PAGE_BOX_FACTS_INVALID");
    expect(() =>
      parseInterior({
        ...interior,
        imagePpi: [interior.imagePpi[1], interior.imagePpi[0]],
      }),
    ).toThrow("PRINT_PREFLIGHT_IMAGE_PPI_FACTS_INVALID");
    expect(() => parseInterior({ ...interior, watermarkPages: [17] })).toThrow(
      "PRINT_PREFLIGHT_WATERMARK_PAGE_FACTS_INVALID",
    );
    expect(() =>
      parseInterior({ ...interior, extractedText: "SYNTHETIC_RAW_TEXT" }),
    ).toThrow();
    expect(() =>
      parseInterior({
        ...interior,
        fonts: Array.from({ length: 41 }, (_, index) => ({
          name: `Synthetic Font ${index}`,
          embedded: true,
          subset: true,
          toUnicode: true,
        })),
      }),
    ).toThrow();
  });
});

function readyProfile() {
  return finalizePrinterProfileVersion({
    id: id(2),
    profileId: id(3),
    previousVersionId: null,
    createdAt: at,
    updatedAt: at,
    draft: {
      ...createDefaultPrinterProfileDraft(),
      spine: { source: "explicit", widthMm: 8 },
    },
  });
}

function validArtifact() {
  return {
    id: id(6),
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
    projectId: id(4),
    runId: id(5),
    jobId: id(8),
    kind: "interior" as const,
    assetId: id(9),
    checksum: hash("d"),
    bytes: 128,
    contentAuthorizationHash: hash("9"),
    printerProfileVersionId: id(2),
    printerProfileHash: readyProfile().profileHash,
    sourceSnapshotHash: hash("7"),
    pageMapHash: hash("6"),
    colorMode: "rgb" as const,
    iccChecksum: null,
    rendererVersion: "hekayati.print.chromium.v1",
    converterVersion: null,
    fontPolicyVersion: "hekayati.print-fonts.v1",
    renderFactsHash: hash("5"),
    renderFacts: {
      pageCount: 16,
      egressRequestCount: 0 as const,
      overflowPageNumbers: [],
      watermarkCount: 0 as const,
      minimumImagePpi: 300,
      fontNames: ["Hekayati Arabic", "Hekayati Brand"],
      panelOrder: null,
    },
    conversionFacts: null,
    reusedFromArtifactId: null,
  };
}

function validReport() {
  const measurements = {
    pageMap: [],
    interior: persistedPdfFactsFixture(16),
    cover: persistedPdfFactsFixture(1),
    sourceAssets: [{ role: "artwork", assetId: id(9), checksum: hash("d") }],
    outputChecksums: { interior: hash("d"), cover: hash("e") },
    coverSpread: {
      panelOrder: ["back", "spine", "front"] as ["back", "spine", "front"],
      spineWidthMm: 8,
      panels: [
        {
          kind: "back" as const,
          boxMm: { x: 3, y: 3, width: 210, height: 297 },
        },
        {
          kind: "spine" as const,
          boxMm: { x: 213, y: 3, width: 8, height: 297 },
        },
        {
          kind: "front" as const,
          boxMm: { x: 221, y: 3, width: 210, height: 297 },
        },
      ],
      foldLinesMm: [213, 221] as [number, number],
    },
    cropMarks: {
      enabled: false,
      offsetMm: 0,
      lengthMm: 0,
      strokePt: 0.25,
      interiorSegmentCount: 0,
      coverSegmentCount: 0,
    },
    colorMode: "rgb" as const,
    iccChecksum: null,
    outputIntentMatches: true,
  };
  return {
    id: id(10),
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
    projectId: id(4),
    runId: id(5),
    interiorArtifactId: id(6),
    interiorChecksum: hash("d"),
    coverArtifactId: id(7),
    coverChecksum: hash("e"),
    contentAuthorizationHash: hash("9"),
    printerProfileVersionId: id(2),
    printerProfileHash: readyProfile().profileHash,
    policyVersion: "hekayati.print-preflight.v1",
    toolVersions: { qpdf: "fixture" },
    findings: [],
    measurements,
    measurementsHash: hashCanonical(measurements),
    passed: true,
  };
}

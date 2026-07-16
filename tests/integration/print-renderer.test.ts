import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  compileCoverGeometry,
  compileInteriorGeometry,
  compileOutputPageMap,
} from "../../src/domain/print/geometry.js";
import {
  createDefaultPrinterProfileDraft,
  finalizePrinterProfileVersion,
} from "../../src/domain/print/schemas.js";
import { hashCanonical } from "../../src/domain/layout/hashes.js";
import type {
  PrintCoverDocument,
  PrintDocumentImage,
  PrintInteriorDocument,
} from "../../src/pdf/print-document.js";
import {
  renderPrintCover,
  renderPrintInterior,
} from "../../src/pdf/print-renderer.js";
import { preflightPrintBundle } from "../../src/pdf/print-preflight.js";

const run = promisify(execFile);
const at = "2026-07-15T00:00:00.000Z";
const ids = Array.from(
  { length: 40 },
  (_, index) => `01J${String(index + 1).padStart(23, "0")}`,
);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("offline full-resolution print renderer", () => {
  it("renders separate watermark-free interior and RTL cover PDFs with explicit boxes", async () => {
    const profile = readyProfile();
    const image = await sourceImage();
    const map = compileOutputPageMap(
      Array.from({ length: 16 }, (_, index) => ({
        customerPageNumber: index + 1,
        pageId: ids[index + 3],
      })),
      profile.requiredBlankPages,
    );
    const interior: PrintInteriorDocument = {
      kind: "interior",
      profile,
      geometry: compileInteriorGeometry(profile),
      sourceSnapshotHash: "a".repeat(64),
      fontManifestHash: "b".repeat(64),
      pages: map.map((entry, index) => ({
        map: entry,
        pageKind: index === 0 ? "title" : "story",
        image,
        bubbles: [],
        text: {
          text:
            index === 0
              ? "حِكايَة لَيْلَى في مَلْعَب اللَّيْمُون"
              : `قالت ليلى: لَأَلْعَبَنَّ مع Mira في الصفحة ${index + 1}!`,
          region: { x: 0.1, y: 0.66, width: 0.8, height: 0.24 },
          fontSizePt: 20,
          style: index === 0 ? "heading" : "body",
          aid: "panel",
        },
      })),
    };
    const cover: PrintCoverDocument = {
      kind: "cover",
      profile,
      geometry: compileCoverGeometry(profile),
      sourceSnapshotHash: "a".repeat(64),
      fontManifestHash: "b".repeat(64),
      panels: [
        {
          kind: "back",
          image: null,
          text: text("حكايتي — حكاية معمولة بحب", "body"),
        },
        {
          kind: "spine",
          image: null,
          text: {
            ...text("حكايتي", "heading"),
            region: { x: 0, y: 0.05, width: 1, height: 0.9 },
            fontSizePt: 12,
            aid: "none",
          },
        },
        {
          kind: "front",
          image,
          text: text("حِكايَة لَيْلَى", "heading"),
        },
      ],
    };

    const renderedInterior = await renderPrintInterior(interior);
    const renderedCover = await renderPrintCover(cover);
    expect(renderedInterior).toMatchObject({
      egressRequestCount: 0,
      pageCount: 16,
      watermarkCount: 0,
      minimumImagePpi: expect.any(Number),
      overflowPageNumbers: [],
    });
    expect(renderedCover).toMatchObject({
      egressRequestCount: 0,
      pageCount: 1,
      watermarkCount: 0,
      panelOrder: ["back", "spine", "front"],
      overflowPageNumbers: [],
    });

    const interiorFacts = await mechanical(
      renderedInterior.pdfBytes,
      "interior.pdf",
    );
    const coverFacts = await mechanical(renderedCover.pdfBytes, "cover.pdf");
    expect(interiorFacts.info).toMatch(/^Pages:\s+16$/mu);
    expect(interiorFacts.info).toContain("TrimBox:");
    expect(interiorFacts.info).toContain("BleedBox:");
    expect(interiorFacts.fonts).toMatch(/yes\s+yes/iu);
    expect(interiorFacts.text).not.toContain("معاينة");
    expect(interiorFacts.text).not.toContain("غير مخصصة للطباعة");
    expect(coverFacts.info).toMatch(/^Pages:\s+1$/mu);
    expect(coverFacts.info).toContain("TrimBox:");
    expect(coverFacts.text).not.toContain("معاينة");

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
      expectedContentAuthorizationHash: "d".repeat(64),
      actualContentAuthorizationHash: "d".repeat(64),
      expectedProfileHash: profile.profileHash,
      actualProfileHash: profile.profileHash,
    });
    expect(preflight.evaluation).toMatchObject({ passed: true, findings: [] });
    expect(preflight.interior).toMatchObject({
      pageCount: 16,
      encrypted: false,
      parseable: true,
      printWatermarkCount: 0,
      prohibitedFeatureCount: 0,
      externalResourceCount: 0,
    });
    expect(preflight.interior.imageCount).toBeGreaterThanOrEqual(32);
    expect(preflight.cover.imageCount).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

function readyProfile() {
  return finalizePrinterProfileVersion({
    id: ids[0],
    profileId: ids[1],
    previousVersionId: null,
    createdAt: at,
    updatedAt: at,
    draft: {
      ...createDefaultPrinterProfileDraft(),
      spine: { source: "explicit", widthMm: 10 },
    },
  });
}

async function sourceImage(): Promise<PrintDocumentImage> {
  const bytes = await sharp({
    create: {
      width: 2_600,
      height: 3_677,
      channels: 3,
      background: { r: 255, g: 212, b: 59 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="2600" height="3677"><circle cx="1300" cy="1360" r="735" fill="#2F9E6A"/><path d="M315 3145 Q1300 2305 2285 3145" fill="#FF8A1F"/></svg>',
        ),
      },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
  return {
    bytes,
    mime: "image/jpeg",
    widthPx: 2_600,
    heightPx: 3_677,
    assetId: ids[2],
    checksum: "c".repeat(64),
    effectivePpi: 300,
  };
}

function text(value: string, style: "heading" | "body") {
  return {
    text: value,
    region: { x: 0.1, y: 0.1, width: 0.8, height: 0.3 },
    fontSizePt: 20,
    style,
    aid: "panel" as const,
  };
}

async function mechanical(bytes: Buffer, name: string) {
  const directory = await mkdtemp(join(tmpdir(), "hekayati-print-render-"));
  temporary.push(directory);
  const path = join(directory, name);
  await writeFile(path, bytes, { mode: 0o600 });
  const [info, fonts, text] = await Promise.all([
    run("pdfinfo", ["-box", path]).then((result) => result.stdout),
    run("pdffonts", [path]).then((result) => result.stdout),
    run("pdftotext", ["-enc", "UTF-8", path, "-"]).then(
      (result) => result.stdout,
    ),
  ]);
  return { info, fonts, text };
}

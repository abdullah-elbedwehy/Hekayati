import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { compileCoverGeometry } from "../../src/domain/print/geometry.js";
import {
  createDefaultPrinterProfileDraft,
  finalizePrinterProfileVersion,
} from "../../src/domain/print/schemas.js";
import type { PrintCoverDocument } from "../../src/pdf/print-document.js";
import { renderPrintCover } from "../../src/pdf/print-renderer.js";
import { convertPdfToCmyk } from "../../src/print/cmyk.js";
import { inspectIccProfile } from "../../src/print/icc.js";

const iccPath = "/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc";
const at = "2026-07-15T00:00:00.000Z";
const ids = Array.from(
  { length: 6 },
  (_, index) => `01J${String(index + 1).padStart(23, "0")}`,
);

describe("argument-safe CMYK conversion", () => {
  it("embeds the exact four-channel ICC and preserves geometry/fonts", async () => {
    const profile = finalizePrinterProfileVersion({
      id: ids[0],
      profileId: ids[1],
      previousVersionId: null,
      createdAt: at,
      updatedAt: at,
      draft: {
        ...createDefaultPrinterProfileDraft(),
        spine: { source: "explicit", widthMm: 8 },
      },
    });
    const imageBytes = await sharp({
      create: {
        width: 2_100,
        height: 2_970,
        channels: 3,
        background: { r: 255, g: 212, b: 59 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="2100" height="2970"><circle cx="1050" cy="1300" r="650" fill="#2F9E6A"/><rect x="250" y="2300" width="1600" height="350" fill="#FF8A1F"/></svg>',
          ),
        },
      ])
      .jpeg({ quality: 88 })
      .toBuffer();
    const image = {
      bytes: imageBytes,
      mime: "image/jpeg" as const,
      widthPx: 2_100,
      heightPx: 2_970,
      assetId: ids[2],
      checksum: "a".repeat(64),
      effectivePpi: 254,
    };
    const document: PrintCoverDocument = {
      kind: "cover",
      profile,
      geometry: compileCoverGeometry(profile),
      sourceSnapshotHash: "b".repeat(64),
      fontManifestHash: "c".repeat(64),
      panels: [
        { kind: "back", image, text: text("حكاية معمولة بحب") },
        { kind: "spine", image: null, text: null },
        { kind: "front", image, text: text("لَيْلَى ومَلْعَب اللَّيْمُون") },
      ],
    };
    const rgb = await renderPrintCover(document);
    const iccBytes = await readFile(iccPath);
    const icc = inspectIccProfile(iccBytes);
    expect(icc).toMatchObject({ channels: 4, dataColorSpace: "CMYK" });

    const converted = await convertPdfToCmyk({
      pdfBytes: rgb.pdfBytes,
      iccBytes,
      expectedIccChecksum: icc.checksum,
    });
    expect(converted).toMatchObject({
      iccChecksum: icc.checksum,
      embeddedIccChecksum: icc.checksum,
      pageCount: 1,
      cmykOnly: true,
      outputIntentMatches: true,
      geometryPreserved: true,
      fontsPreserved: true,
      imageCount: expect.any(Number),
      contentStreamCount: expect.any(Number),
    });
    expect(converted.pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    await expect(
      convertPdfToCmyk({
        pdfBytes: rgb.pdfBytes,
        iccBytes,
        expectedIccChecksum: "0".repeat(64),
      }),
    ).rejects.toThrow("CMYK_ICC_INVALID");
    await expect(
      convertPdfToCmyk({
        pdfBytes: rgb.pdfBytes,
        iccBytes,
        expectedIccChecksum: icc.checksum,
        tools: { ghostscript: "hekayati-missing-ghostscript" },
      }),
    ).rejects.toThrow("CMYK_TOOL_UNAVAILABLE");
  }, 45_000);
});

function text(value: string) {
  return {
    text: value,
    region: { x: 0.08, y: 0.1, width: 0.84, height: 0.25 },
    fontSizePt: 18,
    style: "heading" as const,
    aid: "panel" as const,
  };
}

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildPreviewCompositionDocument,
  type PreviewFontFile,
} from "../../src/pdf/composition-document.js";
import { canonicalPreviewPages } from "../helpers/preview-fixtures.js";

describe("preview composition document", () => {
  it("builds the exact customer-proof order with escaped hostile text and visible marks", () => {
    const result = buildPreviewCompositionDocument({
      pages: canonicalPreviewPages(undefined, true),
      watermarkText: "حكايتي",
      fonts: fixtureFonts(),
    });

    expect(result.pageMap).toHaveLength(18);
    expect(result.pageMap[0]).toMatchObject({
      kind: "front_cover",
      visibleLabel: "غلاف أمامي",
    });
    expect(result.pageMap.at(-1)).toMatchObject({
      kind: "back_cover",
      visibleLabel: "غلاف خلفي",
    });
    expect(result.html).toContain(
      "&lt;script src=&quot;https://outside.invalid/leak.js&quot;&gt;",
    );
    expect(result.html).not.toContain('<script src="https://outside.invalid');
    expect(result.html.match(/class="preview-watermark"/gu)).toHaveLength(18);
    expect(result.html.match(/معاينة — غير مخصصة للطباعة/gu)).toHaveLength(18);
    expect(result.documentHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed on unsafe bidi controls and noncanonical page order", () => {
    const bidiPages = canonicalPreviewPages();
    bidiPages[3].text!.body = "نص\u202eمقلوب";
    expect(() =>
      buildPreviewCompositionDocument({
        pages: bidiPages,
        watermarkText: "حكايتي",
        fonts: fixtureFonts(),
      }),
    ).toThrow("PREVIEW_TEXT_INVALID");

    const wrongOrder = canonicalPreviewPages();
    [wrongOrder[1], wrongOrder[2]] = [wrongOrder[2], wrongOrder[1]];
    expect(() =>
      buildPreviewCompositionDocument({
        pages: wrongOrder,
        watermarkText: "حكايتي",
        fonts: fixtureFonts(),
      }),
    ).toThrow("PREVIEW_PAGE_ORDER_INVALID");
  });

  it("rejects unsafe document, font, image, region, and bubble inputs before HTML exists", () => {
    const base = canonicalPreviewPages();
    expectBuildFailure(base.slice(0, -1), "PREVIEW_PAGE_COUNT_INVALID");
    expectBuildFailure(
      base.map((page, index) =>
        index === 0 ? { ...page, interiorPageNumber: 1 } : page,
      ),
      "PREVIEW_PAGE_NUMBER_INVALID",
    );
    expectBuildFailure(
      base.map((page, index) =>
        index === 3 ? { ...page, text: undefined, image: undefined } : page,
      ),
      "PREVIEW_PAGE_CONTENT_REQUIRED",
    );
    expectBuildFailure(
      base.map((page, index) =>
        index === 3
          ? {
              ...page,
              image: {
                bytes: Buffer.alloc(0),
                mime: "image/png" as const,
                alt: "صورة",
                widthPx: 1,
                heightPx: 1,
              },
            }
          : page,
      ),
      "PREVIEW_IMAGE_INVALID",
    );
    expectBuildFailure(
      base.map((page, index) =>
        index === 3
          ? {
              ...page,
              text: {
                heading: "نص",
                region: { x: 0.8, y: 0, width: 0.3, height: 1 },
                fontSizePt: 11,
                aid: "none" as const,
              },
            }
          : page,
      ),
      "PREVIEW_FONT_SIZE_INVALID",
    );
    expectBuildFailure(
      base.map((page, index) =>
        index === 3
          ? {
              ...page,
              bubbles: Array.from({ length: 13 }, () => ({
                speakerLabel: "نور",
                body: "هيا",
                region: { x: 0, y: 0, width: 0.2, height: 0.2 },
              })),
            }
          : page,
      ),
      "PREVIEW_BUBBLE_COUNT_INVALID",
    );
    expect(() =>
      buildPreviewCompositionDocument({
        pages: base,
        watermarkText: "حكايتي",
        footerText: "غير آمن\u0000",
        fonts: fixtureFonts(),
      }),
    ).toThrow("PREVIEW_FOOTER_INVALID");
    expect(() =>
      buildPreviewCompositionDocument({
        pages: base,
        watermarkText: " ",
        fonts: fixtureFonts(),
      }),
    ).toThrow("PREVIEW_WATERMARK_INVALID");
    expect(() =>
      buildPreviewCompositionDocument({
        pages: base,
        watermarkText: "حكايتي",
        fonts: [{ ...fixtureFonts()[0], sha256: "0".repeat(64) }],
      }),
    ).toThrow("PREVIEW_FONT_SET_INVALID");
    expect(() =>
      buildPreviewCompositionDocument({
        pages: base,
        watermarkText: "حكايتي",
        fonts: [
          { ...fixtureFonts()[0], sha256: "0".repeat(64) },
          fixtureFonts()[1],
        ],
      }),
    ).toThrow("PREVIEW_FONT_HASH_MISMATCH");
  });
});

function expectBuildFailure(
  pages: ReturnType<typeof canonicalPreviewPages>,
  code: string,
): void {
  expect(() =>
    buildPreviewCompositionDocument({
      pages,
      watermarkText: "حكايتي",
      fonts: fixtureFonts(),
    }),
  ).toThrow(code);
}

function fixtureFonts(): PreviewFontFile[] {
  return [font("Hekayati Arabic", 400, 1), font("Hekayati Brand", 700, 2)];
}

function font(
  family: PreviewFontFile["family"],
  weight: PreviewFontFile["weight"],
  seed: number,
): PreviewFontFile {
  const bytes = Buffer.alloc(1_024, seed);
  return {
    family,
    weight,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

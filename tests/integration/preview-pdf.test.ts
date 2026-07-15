import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createPreviewImageDerivative } from "../../src/pdf/preview-derivatives.js";
import { renderPreviewPdf } from "../../src/pdf/preview-renderer.js";
import {
  assertPreviewPdfValid,
  PreviewPdfValidationError,
  validatePreviewPdf,
} from "../../src/pdf/preview-validator.js";
import {
  canonicalPreviewPages,
  syntheticPreviewSource,
} from "../helpers/preview-fixtures.js";

describe("offline customer preview PDF", () => {
  it("renders deterministically with no egress and passes the mechanical ready gate", async () => {
    const image = await fullPageDerivative();
    const input = {
      pages: canonicalPreviewPages(image, true),
      watermarkText: "حكايتي",
    };
    const first = await renderPreviewPdf(input, {
      thumbnailPageNumbers: [1, 3, 18],
    });
    const second = await renderPreviewPdf(input, {
      thumbnailPageNumbers: [1, 3, 18],
    });

    expect(first.pdfBytes.subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(hash(first.pdfBytes)).toBe(hash(second.pdfBytes));
    expect(first.documentHash).toBe(second.documentHash);
    expect(first.egressRequestCount).toBe(0);
    expect(first.blockedRequests).toEqual([]);
    expect(first.thumbnails).toHaveLength(3);
    expect(first.thumbnails.map((item) => item.sha256)).toEqual(
      second.thumbnails.map((item) => item.sha256),
    );
    expect(first.thumbnails[0]).toMatchObject({
      mime: "image/jpeg",
      page: { pageNumber: 1, kind: "front_cover" },
    });

    const expectation = validationExpectation(first);
    const report = await assertPreviewPdfValid(first.pdfBytes, expectation);
    expect(report).toMatchObject({
      passed: true,
      pageCount: 18,
      expectedPageCount: 18,
      egressRequestCount: 0,
    });
    expect(report.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(report.pageResults.every((page) => page.watermarkPresent)).toBe(
      true,
    );
    expect(report.pageResults.every((page) => page.footerPresent)).toBe(true);
    expect(report.pageResults.every((page) => page.pageLabelPresent)).toBe(
      true,
    );
    expect(report.fonts.every((font) => font.embedded && font.toUnicode)).toBe(
      true,
    );
  }, 90_000);

  it("returns bounded stable findings and refuses a non-ready preview", async () => {
    const image = await fullPageDerivative();
    const rendered = await renderPreviewPdf({
      pages: canonicalPreviewPages(image),
      watermarkText: "حكايتي",
    });
    const expectation = {
      ...validationExpectation(rendered),
      watermarkText: "علامة غير موجودة",
      maximumBytes: 100,
      egressRequestCount: 1,
    };

    const report = await validatePreviewPdf(rendered.pdfBytes, expectation);
    expect(report.passed).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "WATERMARK_MISSING",
        "PDF_SIZE_EXCEEDED",
        "RENDER_EGRESS_DETECTED",
      ]),
    );
    await expect(
      assertPreviewPdfValid(rendered.pdfBytes, expectation),
    ).rejects.toBeInstanceOf(PreviewPdfValidationError);

    const corrupt = await validatePreviewPdf(
      Buffer.from("not a pdf"),
      validationExpectation(rendered),
    );
    expect(corrupt.passed).toBe(false);
    expect(corrupt.findings[0]?.code).toBe("PDF_PARSE_FAILED");
    expect(
      corrupt.findings.every((finding) => finding.pages.length <= 32),
    ).toBe(true);
  }, 60_000);

  it("validates the complete 24-page interior plus both cover proofs and records optional visual evidence", async () => {
    const image = await fullPageDerivative();
    const rendered = await renderPreviewPdf(
      {
        pages: canonicalPreviewPages(image, false, 24),
        watermarkText: "حكايتي",
      },
      { thumbnailPageNumbers: [1, 2, 4, 5, 6, 7, 8, 26] },
    );
    const report = await assertPreviewPdfValid(
      rendered.pdfBytes,
      validationExpectation(rendered),
    );

    expect(report).toMatchObject({
      passed: true,
      pageCount: 26,
      expectedPageCount: 26,
      egressRequestCount: 0,
    });
    expect(report.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(report.pageResults).toHaveLength(26);
    expect(
      report.pageResults.every(
        (page) =>
          page.watermarkPresent &&
          page.footerPresent &&
          page.pageLabelPresent &&
          Boolean(
            page.mediaBoxMm &&
            Math.abs(page.mediaBoxMm.width - 210) <= 0.5 &&
            Math.abs(page.mediaBoxMm.height - 297) <= 0.5,
          ),
      ),
    ).toBe(true);
    expect(report.fonts.every((font) => font.embedded && font.toUnicode)).toBe(
      true,
    );
    expect(rendered.blockedRequests).toEqual([]);
    await persistEvidence(rendered, report);
  }, 90_000);

  it("rejects invalid thumbnail scopes and fails closed when canonicalization is unavailable", async () => {
    const input = {
      pages: canonicalPreviewPages(),
      watermarkText: "حكايتي",
    };
    await expect(
      renderPreviewPdf(input, { thumbnailPageNumbers: [0] }),
    ).rejects.toThrow("PREVIEW_THUMBNAIL_PAGE_INVALID");
    await expect(
      renderPreviewPdf(input, {
        thumbnailPageNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      }),
    ).rejects.toThrow("PREVIEW_THUMBNAIL_PAGE_INVALID");
    await expect(
      renderPreviewPdf(input, { qpdfPath: "missing-qpdf-synthetic" }),
    ).rejects.toThrow("PREVIEW_PDF_CANONICALIZATION_FAILED");
  }, 30_000);
});

async function fullPageDerivative() {
  const derivative = await createPreviewImageDerivative({
    sourceBytes: await syntheticPreviewSource(),
    placedWidthMm: 210,
    placedHeightMm: 297,
    fit: "cover",
  });
  return {
    bytes: derivative.bytes,
    mime: derivative.mime,
    alt: "رسم توضيحي اصطناعي",
    widthPx: derivative.widthPx,
    heightPx: derivative.heightPx,
  };
}

function validationExpectation(
  rendered: Awaited<ReturnType<typeof renderPreviewPdf>>,
) {
  return {
    pageMap: rendered.pageMap,
    watermarkText: "حكايتي",
    composition: { widthMm: 210, heightMm: 297, toleranceMm: 0.5 },
    maximumBytes: 16 * 1024 * 1024,
    minimumImagePpi: 140,
    maximumImagePpi: 160,
    requiredTextSamples: ["لَأَلْعَبَنَّ", "2026", "حكايتي"],
    egressRequestCount: rendered.egressRequestCount,
  };
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function persistEvidence(
  rendered: Awaited<ReturnType<typeof renderPreviewPdf>>,
  report: Awaited<ReturnType<typeof assertPreviewPdfValid>>,
): Promise<void> {
  const directory = process.env.HEKAYATI_LAYOUT_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "008-preview-24.pdf"), rendered.pdfBytes, {
    mode: 0o600,
  });
  await writeFile(
    join(directory, "008-preview-24-validation.json"),
    JSON.stringify(report, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  await Promise.all(
    rendered.thumbnails.map((thumbnail) =>
      writeFile(
        join(
          directory,
          `008-preview-page-${String(thumbnail.page.pageNumber).padStart(2, "0")}.jpg`,
        ),
        thumbnail.bytes,
        { mode: 0o600 },
      ),
    ),
  );
}

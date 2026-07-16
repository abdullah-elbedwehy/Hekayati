import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";

import { AssetStore } from "../../src/assets/asset-store.js";
import { PrinterProfileService } from "../../src/domain/print/profiles.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { inspectCoverTemplatePdf } from "../../src/print/template.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("hostile cover-template import", () => {
  it("mechanically inspects and indexes only a safe one-page spread", async () => {
    const bytes = await pdf(1);
    const inspection = await inspectCoverTemplatePdf(bytes);
    expect(inspection).toMatchObject({
      pageCount: 1,
      encrypted: false,
      prohibitedFeatureCount: 0,
      externalResourceCount: 0,
      pageWidthMm: expect.any(Number),
      pageHeightMm: expect.any(Number),
    });
    expect(Math.abs(inspection.pageWidthMm - 428)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(inspection.pageHeightMm - 297)).toBeLessThanOrEqual(0.2);

    const temp = await temporaryDirectory("hekayati-template-import-");
    cleanups.push(temp.cleanup);
    const store = new DocumentStore(join(temp.path, "print.db"));
    const assets = new AssetStore(store, join(temp.path, "assets"));
    const service = new PrinterProfileService(store, assets);
    const result = await service.importCoverTemplate({
      bytes,
      backRegion: region(0, 210 / 428),
      spineRegion: region(210 / 428, 8 / 428),
      frontRegion: region(218 / 428, 210 / 428),
      toleranceMm: 0.2,
    });
    expect(result.asset).toMatchObject({
      role: "printer_template",
      mime: "application/pdf",
      origin: "upload",
    });
    expect(result.facts).not.toHaveProperty("sourcePath");
    expect(JSON.stringify(result)).not.toContain(temp.path);
    store.close();
  });

  it("rejects active content and extra pages before indexing", async () => {
    const safe = await pdf(1);
    await expect(
      inspectCoverTemplatePdf(
        Buffer.concat([safe, Buffer.from("\n/OpenAction")]),
      ),
    ).rejects.toThrow("COVER_TEMPLATE_PROHIBITED_FEATURE");
    await expect(inspectCoverTemplatePdf(await pdf(2))).rejects.toThrow(
      "COVER_TEMPLATE_PAGE_COUNT_INVALID",
    );
  });
});

async function pdf(pages: number): Promise<Buffer> {
  const page = await browser.newPage({ javaScriptEnabled: false });
  try {
    await page.setContent(
      `<style>@page{size:428mm 297mm;margin:0}body{margin:0}.p{width:428mm;height:297mm;break-after:page;background:#fff}</style>${Array.from(
        { length: pages },
        (_, index) => `<div class="p">synthetic-${index + 1}</div>`,
      ).join("")}`,
    );
    return Buffer.from(
      await page.pdf({
        width: "428mm",
        height: "297mm",
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
      }),
    );
  } finally {
    await page.close();
  }
}

function region(x: number, width: number) {
  return { x, y: 0, width, height: 1 };
}

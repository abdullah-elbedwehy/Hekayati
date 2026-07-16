import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  Browser,
  BrowserContext,
  Page as BrowserPage,
  Request,
  Route,
} from "playwright";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  compileCoverGeometry,
  compileInteriorGeometry,
  type OutputPageMapEntry,
} from "../../src/domain/print/geometry.js";
import {
  createDefaultPrinterProfileDraft,
  finalizePrinterProfileVersion,
  type PrinterProfileVersion,
} from "../../src/domain/print/schemas.js";
import type {
  PrintCoverDocument,
  PrintDocumentImage,
  PrintInteriorDocument,
  PrintTextContent,
} from "../../src/pdf/print-document.js";
import {
  preflightPrintBundle,
  type PrintPreflightInput,
} from "../../src/pdf/print-preflight.js";
import {
  PRINT_FONT_POLICY_VERSION,
  PRINT_RENDERER_VERSION,
  renderPrintCover,
  renderPrintInterior,
  type PrintCoverRenderResult,
  type PrintRenderResult,
} from "../../src/pdf/print-renderer.js";

const at = "2026-07-15T00:00:00.000Z";
const execute = promisify(execFile);
const ids = Array.from(
  { length: 80 },
  (_, index) => `01J${String(index + 1).padStart(23, "0")}`,
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("print PDF contracts", () => {
  it("rejects invalid page, panel, geometry, and control-text contracts before browser startup", async () => {
    const tooShort = interiorDocument(15);
    const tooLong = interiorDocument(41);
    const badMap = interiorDocument();
    badMap.pages[7] = {
      ...badMap.pages[7],
      map: { ...badMap.pages[7].map, outputPageNumber: 99 },
    };

    const badPanelOrder = coverDocument();
    badPanelOrder.panels = [
      badPanelOrder.panels[2],
      badPanelOrder.panels[1],
      badPanelOrder.panels[0],
    ];

    const badPanelGeometry = coverDocument();
    badPanelGeometry.geometry = {
      ...badPanelGeometry.geometry,
      panels: [
        { ...badPanelGeometry.geometry.panels[0], kind: "front" },
        badPanelGeometry.geometry.panels[1],
        badPanelGeometry.geometry.panels[2],
      ],
    };

    const badText = interiorDocument();
    badText.pages[0] = {
      ...badText.pages[0],
      text: textContent("bad\u0000text"),
    };
    const badSpeaker = interiorDocument();
    badSpeaker.pages[0] = {
      ...badSpeaker.pages[0],
      bubbles: [
        {
          speakerLabel: "bad\u0001speaker",
          text: "نص سليم",
          region: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
        },
      ],
    };
    const badBubbleText = interiorDocument();
    badBubbleText.pages[0] = {
      ...badBubbleText.pages[0],
      bubbles: [
        {
          speakerLabel: "ليلى",
          text: "bad\u0002bubble",
          region: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
        },
      ],
    };
    const badBidiControl = interiorDocument();
    badBidiControl.pages[0] = {
      ...badBidiControl.pages[0],
      text: textContent("حكاية\u202eexe.invalid"),
    };

    const cases: Array<{
      expected: string;
      render: (browser: Browser) => Promise<unknown>;
    }> = [
      {
        expected: "PRINT_INTERIOR_PAGE_COUNT_INVALID",
        render: (browser) => renderPrintInterior(tooShort, { browser }),
      },
      {
        expected: "PRINT_INTERIOR_PAGE_COUNT_INVALID",
        render: (browser) => renderPrintInterior(tooLong, { browser }),
      },
      {
        expected: "PRINT_INTERIOR_PAGE_MAP_INVALID",
        render: (browser) => renderPrintInterior(badMap, { browser }),
      },
      {
        expected: "PRINT_COVER_PANEL_ORDER_INVALID",
        render: (browser) => renderPrintCover(badPanelOrder, { browser }),
      },
      {
        expected: "PRINT_COVER_PANEL_ORDER_INVALID",
        render: (browser) => renderPrintCover(badPanelGeometry, { browser }),
      },
      {
        expected: "PRINT_TEXT_CONTROL_INVALID",
        render: (browser) => renderPrintInterior(badText, { browser }),
      },
      {
        expected: "PRINT_TEXT_CONTROL_INVALID",
        render: (browser) => renderPrintInterior(badSpeaker, { browser }),
      },
      {
        expected: "PRINT_TEXT_CONTROL_INVALID",
        render: (browser) => renderPrintInterior(badBubbleText, { browser }),
      },
      {
        expected: "PRINT_TEXT_CONTROL_INVALID",
        render: (browser) => renderPrintInterior(badBidiControl, { browser }),
      },
    ];

    for (const contract of cases) {
      let browserStarts = 0;
      const browser = {
        newContext: async () => {
          browserStarts += 1;
          throw new Error("UNEXPECTED_BROWSER_START");
        },
      } as unknown as Browser;
      await expect(contract.render(browser)).rejects.toThrow(contract.expected);
      expect(browserStarts).toBe(0);
    }
  });

  it("renders crop, null, image, text, and bubble branches through a supplied offline browser", async () => {
    const qpdfPath = await fakeQpdf();
    const profile = readyProfile("rgb", true);
    const interior = interiorDocument(16, profile);
    interior.pages[1] = {
      ...interior.pages[1],
      image: await printImage(),
      text: textContent(`حكاية & <مغامرة> "ليلى" 'اليوم'`),
      bubbles: [
        {
          speakerLabel: "ليلى & ميرا",
          text: "يلا <نلعب>",
          region: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
        },
      ],
    };
    interior.pages[2] = {
      ...interior.pages[2],
      text: textContent("سطر مرتفع"),
    };
    interior.pages[3] = {
      ...interior.pages[3],
      text: textContent("سطر عريض"),
    };
    interior.pages[4] = {
      ...interior.pages[4],
      text: textContent(
        '<img src="file:///synthetic-child.jpg"> internalId=fixture contact=synthetic consent=false provenance=mock',
      ),
    };
    const interiorBrowser = offlineBrowser();

    const renderedInterior = await renderPrintInterior(interior, {
      browser: interiorBrowser.browser,
      qpdfPath,
    });

    expect(renderedInterior).toMatchObject({
      pageCount: 16,
      minimumImagePpi: 300,
      overflowPageNumbers: [3, 4],
      blockedRequests: [],
      egressRequestCount: 0,
    });
    expect(renderedInterior.pdfBytes.toString("latin1")).toContain("/BleedBox");
    expect(renderedInterior.pdfBytes.toString("latin1")).toContain("/TrimBox");
    expect(interiorBrowser.evidence.html).toContain(
      "حكاية &amp; &lt;مغامرة&gt; &quot;ليلى&quot; &#39;اليوم&#39;",
    );
    expect(interiorBrowser.evidence.html).toContain("ليلى &amp; ميرا");
    expect(interiorBrowser.evidence.html).toContain("يلا &lt;نلعب&gt;");
    expect(interiorBrowser.evidence.html).toContain(
      "&lt;img src=&quot;file:///synthetic-child.jpg&quot;&gt; internalId=fixture contact=synthetic consent=false provenance=mock",
    );
    expect(interiorBrowser.evidence.html).not.toContain(
      '<img src="file:///synthetic-child.jpg">',
    );
    expect(
      interiorBrowser.evidence.html.match(/class="crop-mark"/gu),
    ).toHaveLength(16 * 8);
    expect(
      interiorBrowser.evidence.html.match(/class="bleed-art"/gu),
    ).toHaveLength(1);
    expect(
      interiorBrowser.evidence.html.match(/class="trim-art"/gu),
    ).toHaveLength(1);
    expect(
      interiorBrowser.evidence.html.match(/class="text-block/gu),
    ).toHaveLength(4);
    expect(interiorBrowser.evidence.html).toContain('class="dialogue-bubble"');
    expect(interiorBrowser.evidence).toMatchObject({
      continuedRoutes: 1,
      abortedRoutes: 1,
      closedContexts: 1,
    });

    const coverBrowser = offlineBrowser();
    const renderedCover = await renderPrintCover(coverDocument(profile), {
      browser: coverBrowser.browser,
      qpdfPath,
    });
    expect(renderedCover).toMatchObject({
      pageCount: 1,
      minimumImagePpi: null,
      panelOrder: ["back", "spine", "front"],
      overflowPageNumbers: [],
    });
    expect(coverBrowser.evidence.html).not.toContain("<img ");
    expect(coverBrowser.evidence.html).toContain("panel-back");
    expect(coverBrowser.evidence.html).toContain("panel-spine");
    expect(coverBrowser.evidence.html).toContain("panel-front");
    expect(
      coverBrowser.evidence.html.match(/class="crop-mark"/gu),
    ).toHaveLength(8);
  });

  it("fails the browser render contract for page-count, watermark, and blocked-egress evidence", async () => {
    const cases: OfflineBrowserOptions[] = [
      { pageCountOffset: -1 },
      { watermarkCount: 1 },
      { emittedRequest: "https://example.invalid/private-child-image.png" },
    ];
    for (const options of cases) {
      const offline = offlineBrowser(options);
      await expect(
        renderPrintInterior(interiorDocument(), {
          browser: offline.browser,
          qpdfPath: "/not-used-before-contract-rejection",
        }),
      ).rejects.toThrow("PRINT_RENDER_CONTRACT_VIOLATION");
      expect(offline.evidence.closedContexts).toBe(1);
    }
  });

  it.each([
    ["http://example.invalid/image.png", "image"],
    ["file:///synthetic/private.png", "image"],
    ["ws://example.invalid/socket", "websocket"],
    ["blob:synthetic-worker", "worker"],
    ["hekayati-unsafe://synthetic/resource", "other"],
  ])(
    "blocks the %s %s request before PDF emission",
    async (url, resourceType) => {
      const offline = offlineBrowser({
        emittedRequests: [{ url, resourceType }],
      });
      await expect(
        renderPrintInterior(interiorDocument(), {
          browser: offline.browser,
          qpdfPath: "/not-used-before-contract-rejection",
        }),
      ).rejects.toThrow("PRINT_RENDER_CONTRACT_VIOLATION");
      expect(offline.evidence.closedContexts).toBe(1);
    },
  );

  it("fails closed when canonicalized output has no MediaBox", async () => {
    const qpdfPath = await fakeQpdf();
    const offline = offlineBrowser({
      pdfBytes: Buffer.from("%PDF-1.4\n%%EOF\n", "latin1"),
    });
    await expect(
      renderPrintInterior(interiorDocument(), {
        browser: offline.browser,
        qpdfPath,
      }),
    ).rejects.toThrow("PRINT_PDF_CANONICALIZATION_FAILED");
    expect(offline.evidence.closedContexts).toBe(1);
  });

  it("reports corrupt PDFs with nullable mechanical facts and no false clean bundle", async () => {
    const report = await preflightPrintBundle(
      preflightInput(readyProfile(), Buffer.from("%PDF-1.7\ncorrupt\n")),
    );

    expect(report.toolVersions.qpdf).not.toBe("unavailable");
    expect(report.interior).toMatchObject({
      parseable: false,
      pageCount: 0,
      mediaBoxMm: null,
      bleedBoxMm: null,
      trimBoxMm: null,
      fonts: [],
      imageCount: 0,
      hasArabicText: false,
    });
    expect(report.cover).toEqual(report.interior);
    expect(report.evaluation.passed).toBe(false);
    expect(report.evaluation.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "PDF_CORRUPT",
        "PAGE_DIMENSIONS_MISMATCH",
        "PAGE_ORIENTATION_INVALID",
        "PAGE_COUNT_MISMATCH",
        "FONT_MISSING",
        "GLYPH_COVERAGE_MISSING",
      ]),
    );
    expect(report.facts.checks.IMAGE_PPI_LOW).toEqual({
      passed: true,
      actual: 0,
    });
  });

  it("fails closed when mechanical tools and optional CMYK evidence are absent", async () => {
    const directory = await temporaryDirectory("hekayati-missing-pdf-tools-");
    const missingTool = join(directory, "not-installed");
    const report = await preflightPrintBundle({
      ...preflightInput(readyProfile("cmyk"), Buffer.from("not-inspectable")),
      tools: {
        qpdf: missingTool,
        pdfinfo: missingTool,
        pdffonts: missingTool,
        pdfimages: missingTool,
        pdftotext: missingTool,
        pdftoppm: missingTool,
      },
    });

    expect(Object.values(report.toolVersions)).toEqual(
      Array.from({ length: 6 }, () => "unavailable"),
    );
    expect(report.interior.parseable).toBe(false);
    expect(report.facts.checks.COLOR_MODE_MISMATCH.passed).toBe(false);
    expect(report.facts.checks.ICC_PROFILE_MISSING.passed).toBe(false);
    expect(report.facts.checks.ICC_OUTPUT_INTENT_MISMATCH.passed).toBe(false);
    expect(report.facts.checks.COLOR_CONVERSION_FAILED.passed).toBe(false);
    expect(report.evaluation.passed).toBe(false);
  });

  it("detects encryption from actual PDF bytes before content inspection", async () => {
    const directory = await temporaryDirectory("hekayati-encrypted-pdf-");
    const plainPath = join(directory, "plain.pdf");
    const encryptedPath = join(directory, "encrypted.pdf");
    await writeFile(plainPath, minimalPdf(), { mode: 0o600 });
    await execute(
      "qpdf",
      [
        "--encrypt",
        "synthetic-user",
        "synthetic-owner",
        "256",
        "--",
        plainPath,
        encryptedPath,
      ],
      { timeout: 10_000, maxBuffer: 256 * 1024, windowsHide: true },
    );
    const encrypted = await readFile(encryptedPath);

    const report = await preflightPrintBundle(
      preflightInput(readyProfile(), encrypted),
    );

    expect(report.interior).toMatchObject({ encrypted: true });
    expect(report.cover).toMatchObject({ encrypted: true });
    expect(report.evaluation.passed).toBe(false);
    expect(report.evaluation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PDF_ENCRYPTED" }),
      ]),
    );
  });
});

function readyProfile(
  mode: "rgb" | "cmyk" = "rgb",
  cropMarks = false,
): PrinterProfileVersion {
  const color =
    mode === "cmyk"
      ? {
          mode: "cmyk" as const,
          iccAssetId: ids[70],
          iccChecksum: "c".repeat(64),
        }
      : { mode: "rgb" as const, iccAssetId: null, iccChecksum: null };
  return finalizePrinterProfileVersion({
    id: ids[0],
    profileId: ids[1],
    previousVersionId: null,
    createdAt: at,
    updatedAt: at,
    draft: {
      ...createDefaultPrinterProfileDraft(),
      color,
      cropMarks: cropMarks
        ? { enabled: true, offsetMm: 2, lengthMm: 5, strokePt: 0.25 }
        : { enabled: false, offsetMm: 0, lengthMm: 0, strokePt: 0.25 },
      spine: { source: "explicit", widthMm: 8 },
    },
  });
}

function interiorDocument(
  pageCount = 16,
  profile = readyProfile(),
): PrintInteriorDocument {
  return {
    kind: "interior",
    profile,
    geometry: compileInteriorGeometry(profile),
    sourceSnapshotHash: "a".repeat(64),
    fontManifestHash: "b".repeat(64),
    pages: Array.from({ length: pageCount }, (_, index) => ({
      map: customerMap(index),
      pageKind: index === 0 ? "title" : "story",
      image: null,
      text: null,
      bubbles: [],
    })),
  };
}

function coverDocument(profile = readyProfile()): PrintCoverDocument {
  return {
    kind: "cover",
    profile,
    geometry: compileCoverGeometry(profile),
    sourceSnapshotHash: "a".repeat(64),
    fontManifestHash: "b".repeat(64),
    panels: [
      { kind: "back", image: null, text: textContent("نبذة عن الحكاية") },
      { kind: "spine", image: null, text: null },
      { kind: "front", image: null, text: textContent("حكاية ليلى") },
    ],
  };
}

function customerMap(index: number): OutputPageMapEntry {
  return {
    kind: "customer",
    outputPageNumber: index + 1,
    customerPageNumber: index + 1,
    pageId: ids[index + 2],
    label: null,
  };
}

function textContent(text: string): PrintTextContent {
  return {
    text,
    region: { x: 0.1, y: 0.1, width: 0.8, height: 0.3 },
    fontSizePt: 18,
    style: "body",
    aid: "panel",
  };
}

async function printImage(): Promise<PrintDocumentImage> {
  const widthPx = 210;
  const heightPx = 297;
  return {
    bytes: await sharp({
      create: {
        width: widthPx,
        height: heightPx,
        channels: 3,
        background: { r: 246, g: 166, b: 35 },
      },
    })
      .png()
      .toBuffer(),
    mime: "image/png",
    widthPx,
    heightPx,
    assetId: ids[69],
    checksum: "d".repeat(64),
    effectivePpi: 300,
  };
}

interface OfflineBrowserEvidence {
  html: string;
  continuedRoutes: number;
  abortedRoutes: number;
  closedContexts: number;
}

interface OfflineBrowserOptions {
  pageCountOffset?: number;
  watermarkCount?: number;
  emittedRequest?: string;
  emittedRequests?: Array<{ url: string; resourceType: string }>;
  pdfBytes?: Buffer;
}

function offlineBrowser(options: OfflineBrowserOptions = {}): {
  browser: Browser;
  evidence: OfflineBrowserEvidence;
} {
  const evidence: OfflineBrowserEvidence = {
    html: "",
    continuedRoutes: 0,
    abortedRoutes: 0,
    closedContexts: 0,
  };
  let pageCount = 0;
  let requestListener: ((request: Request) => void) | undefined;
  const page = {
    setContent: async (html: string) => {
      evidence.html = html;
      pageCount = html.match(/<section class="print-page/gu)?.length ?? 0;
    },
    evaluate: async () => undefined,
    emulateMedia: async () => undefined,
    locator: (selector: string) => ({
      count: async () => {
        if (selector === ".print-page")
          return pageCount + (options.pageCountOffset ?? 0);
        if (selector === ".preview-watermark")
          return options.watermarkCount ?? 0;
        return 0;
      },
      evaluateAll: async (callback: (elements: HTMLElement[]) => number[]) =>
        callback(overflowElements(pageCount)),
    }),
    pdf: async () =>
      options.pdfBytes ??
      Buffer.from(
        "%PDF-1.4\n1 0 obj\n<< /Type /Page /MediaBox [ 0 0 100 100 ] >>\nendobj\n%%EOF\n",
        "latin1",
      ),
  };
  const context = {
    on: (event: string, listener: (request: Request) => void) => {
      if (event === "request") requestListener = listener;
      return context;
    },
    route: async (
      _pattern: string,
      handler: (route: Route) => Promise<void>,
    ) => {
      requestListener?.(fakeRequest("about:blank"));
      requestListener?.(fakeRequest("data:image/png;base64,AA=="));
      if (options.emittedRequest)
        requestListener?.(fakeRequest(options.emittedRequest));
      for (const request of options.emittedRequests ?? [])
        requestListener?.(fakeRequest(request.url, request.resourceType));
      await handler(fakeRoute("data:image/png;base64,AA==", evidence));
      await handler(fakeRoute("https://example.invalid/blocked", evidence));
    },
    newPage: async () => page as unknown as BrowserPage,
    close: async () => {
      evidence.closedContexts += 1;
    },
  };
  const browser = {
    newContext: async () => context as unknown as BrowserContext,
  } as unknown as Browser;
  return { browser, evidence };
}

function overflowElements(pageCount: number): HTMLElement[] {
  return Array.from({ length: pageCount }, (_, index) => {
    const text =
      index === 1
        ? [overflowText(false, false)]
        : index === 2
          ? [overflowText(true, false)]
          : index === 3
            ? [overflowText(false, true)]
            : [];
    return { querySelectorAll: () => text } as unknown as HTMLElement;
  });
}

function overflowText(height: boolean, width: boolean): HTMLElement {
  return {
    scrollHeight: height ? 12 : 10,
    clientHeight: 10,
    scrollWidth: width ? 12 : 10,
    clientWidth: 10,
  } as unknown as HTMLElement;
}

function fakeRequest(url: string, resourceType = "image"): Request {
  return {
    url: () => url,
    resourceType: () => resourceType,
  } as unknown as Request;
}

function fakeRoute(url: string, evidence: OfflineBrowserEvidence): Route {
  return {
    request: () => fakeRequest(url),
    continue: async () => {
      evidence.continuedRoutes += 1;
    },
    abort: async () => {
      evidence.abortedRoutes += 1;
    },
  } as unknown as Route;
}

async function fakeQpdf(): Promise<string> {
  const directory = await temporaryDirectory("hekayati-fake-qpdf-");
  const path = join(directory, "qpdf");
  await writeFile(
    path,
    [
      "#!/bin/sh",
      'if [ "$1" = "--check" ]; then exit 0; fi',
      'previous=""',
      'last=""',
      'for argument in "$@"; do',
      '  previous="$last"',
      '  last="$argument"',
      "done",
      'cp "$previous" "$last"',
    ].join("\n"),
    { mode: 0o700 },
  );
  return path;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function preflightInput(
  profile: PrinterProfileVersion,
  pdf: Buffer,
): PrintPreflightInput {
  const map = Array.from({ length: 16 }, (_, index) => customerMap(index));
  const interiorRender = renderFacts(16, null);
  const coverRender: PrintCoverRenderResult = {
    ...renderFacts(1, null),
    panelOrder: ["back", "spine", "front"],
  };
  return {
    interiorPdf: pdf,
    coverPdf: pdf,
    interiorRender,
    coverRender,
    profile,
    interiorGeometry: compileInteriorGeometry(profile),
    coverGeometry: compileCoverGeometry(profile),
    pageMap: map,
    expectedPageMapHash: "e".repeat(64),
    actualPageMapHash: "e".repeat(64),
    blanksMatch: true,
    sourceAssetsPresent: true,
    sourceChecksumsMatch: true,
    previewWatermarkPresent: true,
    expectedContentAuthorizationHash: "f".repeat(64),
    actualContentAuthorizationHash: "f".repeat(64),
    expectedProfileHash: profile.profileHash,
    actualProfileHash: profile.profileHash,
  };
}

function minimalPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let body = "%PDF-1.4\n% synthetic-encryption-fixture\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function renderFacts(
  pageCount: number,
  minimumImagePpi: number | null,
): PrintRenderResult {
  return {
    pdfBytes: Buffer.alloc(0),
    pageCount,
    egressRequestCount: 0,
    blockedRequests: [],
    overflowPageNumbers: [],
    watermarkCount: 0,
    minimumImagePpi,
    fontNames: ["Hekayati Arabic", "Hekayati Brand"],
    rendererVersion: PRINT_RENDERER_VERSION,
    fontPolicyVersion: PRINT_FONT_POLICY_VERSION,
    renderFactsHash: "9".repeat(64),
  };
}

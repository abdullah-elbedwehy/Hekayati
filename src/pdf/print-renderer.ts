import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
} from "playwright";

import type {
  CropMarkSegment,
  MillimeterBox,
} from "../domain/print/geometry.js";
import type {
  PrintCoverDocument,
  PrintDocumentImage,
  PrintInteriorDocument,
  PrintTextContent,
} from "./print-document.js";
import {
  createPrintBleedImageCache,
  extendPrintImageForBleed,
  type BleedMarginsMm,
} from "./print-bleed.js";

const run = promisify(execFile);
const MM_TO_PT = 72 / 25.4;
const FONT_FILES = [
  [
    "IBMPlexSansArabic-Regular.ttf",
    "Hekayati Arabic",
    400,
    "8e0f1046c736bf939d4939ee3ae0116acf61cbcd6592deae7656761627080981",
  ],
  [
    "IBMPlexSansArabic-Bold.ttf",
    "Hekayati Arabic",
    700,
    "b74f809dead12442ed56e02a12c3bcc02076c9ad4e32f17d0a9ca6fc1aafc89e",
  ],
  [
    "Lemonada-Bold.ttf",
    "Hekayati Brand",
    700,
    "9e6490332990d1c055d698d2216dc039ebfc0207a4b2cb54af45a97c655ba19e",
  ],
] as const;

export const PRINT_RENDERER_VERSION = "hekayati.print.chromium.v2";
export const PRINT_FONT_POLICY_VERSION = "hekayati.print-fonts.v1";

export interface PrintRenderOptions {
  qpdfPath?: string;
  browser?: Browser;
  signal?: AbortSignal;
}

export interface PrintRenderResult {
  pdfBytes: Buffer;
  pageCount: number;
  egressRequestCount: 0;
  blockedRequests: Array<{ scheme: string; resourceType: string }>;
  overflowPageNumbers: number[];
  watermarkCount: 0;
  minimumImagePpi: number | null;
  fontNames: string[];
  rendererVersion: string;
  fontPolicyVersion: typeof PRINT_FONT_POLICY_VERSION;
  renderFactsHash: string;
}

export interface PrintCoverRenderResult extends PrintRenderResult {
  panelOrder: ["back", "spine", "front"];
}

interface RenderContract {
  html: string;
  media: MillimeterBox;
  bleed: MillimeterBox;
  trim: MillimeterBox;
  expectedPages: number;
  images: Array<PrintDocumentImage | null>;
  qpdfPath: string;
}

export async function renderPrintInterior(
  document: PrintInteriorDocument,
  options: PrintRenderOptions = {},
): Promise<PrintRenderResult> {
  throwIfAborted(options.signal);
  assertInterior(document);
  const html = await interiorHtml(document);
  throwIfAborted(options.signal);
  return renderDocument(
    {
      html,
      media: document.geometry.mediaBoxMm,
      bleed: document.geometry.bleedBoxMm,
      trim: document.geometry.trimBoxMm,
      expectedPages: document.pages.length,
      images: document.pages.map((page) => page.image),
      qpdfPath: options.qpdfPath ?? "qpdf",
    },
    options.browser,
    options.signal,
  );
}

export async function renderPrintCover(
  document: PrintCoverDocument,
  options: PrintRenderOptions = {},
): Promise<PrintCoverRenderResult> {
  throwIfAborted(options.signal);
  assertCover(document);
  const html = await coverHtml(document);
  throwIfAborted(options.signal);
  const rendered = await renderDocument(
    {
      html,
      media: document.geometry.mediaBoxMm,
      bleed: document.geometry.bleedBoxMm,
      trim: document.geometry.trimBoxMm,
      expectedPages: 1,
      images: document.panels.map((panel) => panel.image),
      qpdfPath: options.qpdfPath ?? "qpdf",
    },
    options.browser,
    options.signal,
  );
  return { ...rendered, panelOrder: ["back", "spine", "front"] };
}

async function renderDocument(
  contract: RenderContract,
  suppliedBrowser?: Browser,
  signal?: AbortSignal,
): Promise<PrintRenderResult> {
  throwIfAborted(signal);
  if (suppliedBrowser)
    return renderInBrowser(suppliedBrowser, contract, signal);

  const pendingBrowser = chromium.launch({ headless: true });
  let ownedBrowser: Browser;
  try {
    ownedBrowser = await raceWithAbort(pendingBrowser, signal);
  } catch (error) {
    if (isAbortError(error)) closeLateBrowser(pendingBrowser);
    throw error;
  }
  try {
    return await renderInBrowser(ownedBrowser, contract, signal);
  } finally {
    await ownedBrowser.close().catch(() => undefined);
  }
}

async function renderInBrowser(
  browser: Browser,
  contract: RenderContract,
  signal?: AbortSignal,
): Promise<PrintRenderResult> {
  throwIfAborted(signal);
  const blockedRequests: Array<{ scheme: string; resourceType: string }> = [];
  const pendingContext = browser.newContext({
    javaScriptEnabled: false,
    locale: "ar-EG",
    offline: true,
    serviceWorkers: "block",
    viewport: { width: 1600, height: 1200 },
  });
  let context: BrowserContext;
  try {
    context = await raceWithAbort(pendingContext, signal);
  } catch (error) {
    if (isAbortError(error)) closeLateContext(pendingContext);
    throw error;
  }
  const closeOnAbort = () => {
    void context.close().catch(() => undefined);
  };
  signal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    await raceWithAbort(
      denyExternalResources(context, blockedRequests),
      signal,
    );
    return await raceWithAbort(
      renderInContext(context, contract, blockedRequests, signal),
      signal,
    );
  } finally {
    signal?.removeEventListener("abort", closeOnAbort);
    await context.close().catch(() => undefined);
  }
}

async function renderInContext(
  context: BrowserContext,
  contract: RenderContract,
  blockedRequests: Array<{ scheme: string; resourceType: string }>,
  signal?: AbortSignal,
): Promise<PrintRenderResult> {
  throwIfAborted(signal);
  const page = await context.newPage();
  await page.setContent(contract.html, { waitUntil: "load" });
  await page.evaluate(async () => await globalThis.document.fonts.ready);
  await page.emulateMedia({ media: "print" });
  const overflowPageNumbers = await detectOverflow(page);
  const pageCount = await page.locator(".print-page").count();
  const watermarkCount = await page.locator(".preview-watermark").count();
  if (
    pageCount !== contract.expectedPages ||
    watermarkCount !== 0 ||
    blockedRequests.length !== 0
  )
    throw new Error("PRINT_RENDER_CONTRACT_VIOLATION");
  throwIfAborted(signal);
  const chromiumPdf = await chromiumPdfBytes(page, contract.media);
  throwIfAborted(signal);
  const pdfBytes = await canonicalizeWithBoxes(
    chromiumPdf,
    contract.bleed,
    contract.trim,
    contract.qpdfPath,
    signal,
  );
  return renderResult(
    contract,
    pdfBytes,
    pageCount,
    overflowPageNumbers,
    blockedRequests,
  );
}

async function chromiumPdfBytes(
  page: Page,
  media: MillimeterBox,
): Promise<Buffer> {
  return Buffer.from(
    await page.pdf({
      width: `${media.width}mm`,
      height: `${media.height}mm`,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      tagged: false,
      outline: false,
    }),
  );
}

function renderResult(
  contract: RenderContract,
  pdfBytes: Buffer,
  pageCount: number,
  overflowPageNumbers: number[],
  blockedRequests: Array<{ scheme: string; resourceType: string }>,
): PrintRenderResult {
  const minimumImagePpi = minimumPpi(contract.images);
  const fontNames = ["Hekayati Arabic", "Hekayati Brand"];
  const facts = {
    pageCount,
    overflowPageNumbers,
    watermarkCount: 0,
    minimumImagePpi,
    fontNames,
    media: contract.media,
    bleed: contract.bleed,
    trim: contract.trim,
    rendererVersion: PRINT_RENDERER_VERSION,
    fontPolicyVersion: PRINT_FONT_POLICY_VERSION,
  };
  return {
    pdfBytes,
    pageCount,
    egressRequestCount: 0,
    blockedRequests,
    overflowPageNumbers,
    watermarkCount: 0,
    minimumImagePpi,
    fontNames,
    rendererVersion: PRINT_RENDERER_VERSION,
    fontPolicyVersion: PRINT_FONT_POLICY_VERSION,
    renderFactsHash: createHash("sha256")
      .update(JSON.stringify(facts))
      .digest("hex"),
  };
}

async function interiorHtml(document: PrintInteriorDocument): Promise<string> {
  const fontFaces = await embeddedFontFaces();
  const bleedCache = createPrintBleedImageCache();
  const trimContentBox = {
    x: 0,
    y: 0,
    width: document.geometry.trimBoxMm.width,
    height: document.geometry.trimBoxMm.height,
  };
  const pages = (
    await Promise.all(
      document.pages.map(async (page) => {
        const bleedImage = page.image
          ? imageElement(
              await extendPrintImageForBleed({
                image: page.image,
                trimBoxMm: document.geometry.trimBoxMm,
                marginsMm: marginsBetween(
                  document.geometry.trimBoxMm,
                  document.geometry.bleedBoxMm,
                ),
                cache: bleedCache,
              }),
              document.geometry.bleedBoxMm,
              "bleed-art",
            )
          : "";
        const trimImage = page.image
          ? imageElement(page.image, trimContentBox, "trim-art")
          : "";
        const text = page.text ? textElement(page.text, trimContentBox) : "";
        const bubbles = page.bubbles
          .map((bubble) => bubbleElement(bubble, trimContentBox))
          .join("");
        const marks = cropMarkElements(document.geometry.cropMarks);
        return `<section class="print-page kind-${page.pageKind}" data-output-page="${page.map.outputPageNumber}" data-page-kind="${page.map.kind}">${bleedImage}${marks}<div class="trim-canvas">${trimImage}${text}${bubbles}</div></section>`;
      }),
    )
  ).join("");
  return htmlDocument(
    fontFaces,
    pageCss(document.geometry.mediaBoxMm, document.geometry.trimBoxMm),
    pages,
  );
}

async function coverHtml(document: PrintCoverDocument): Promise<string> {
  const fontFaces = await embeddedFontFaces();
  const bleedImages = await coverBleedImages(document);
  const panels = document.panels
    .map((panel, index) => {
      const geometry = document.geometry.panels[index];
      if (!geometry || geometry.kind !== panel.kind)
        throw new Error("PRINT_COVER_PANEL_ORDER_INVALID");
      const local = {
        x: geometry.boxMm.x - document.geometry.trimBoxMm.x,
        y: geometry.boxMm.y - document.geometry.trimBoxMm.y,
        width: geometry.boxMm.width,
        height: geometry.boxMm.height,
      };
      const contentBox = {
        x: 0,
        y: 0,
        width: geometry.boxMm.width,
        height: geometry.boxMm.height,
      };
      const image = panel.image
        ? imageElement(panel.image, contentBox, "panel-art")
        : "";
      const text = panel.text
        ? textElement(panel.text, contentBox, panel.kind)
        : "";
      return `<div class="cover-panel panel-${panel.kind}" style="${boxStyle(local)}">${image}${text}</div>`;
    })
    .join("");
  return htmlDocument(
    fontFaces,
    pageCss(document.geometry.mediaBoxMm, document.geometry.trimBoxMm),
    `<section class="print-page kind-cover" data-output-page="1">${bleedImages}<div class="trim-canvas">${panels}</div>${cropMarkElements(document.geometry.cropMarks)}</section>`,
  );
}

async function coverBleedImages(document: PrintCoverDocument): Promise<string> {
  const cache = createPrintBleedImageCache();
  const images = await Promise.all(
    document.panels.map(async (panel, index) => {
      const geometry = document.geometry.panels[index];
      if (!panel.image || !geometry || panel.kind === "spine") return "";
      const bleedBox = coverPanelBleedBox(
        geometry.boxMm,
        document.geometry.bleedBoxMm,
        panel.kind,
      );
      const image = await extendPrintImageForBleed({
        image: panel.image,
        trimBoxMm: geometry.boxMm,
        marginsMm: marginsBetween(geometry.boxMm, bleedBox),
        cache,
      });
      return imageElement(image, bleedBox, "cover-bleed-art");
    }),
  );
  return images.join("");
}

function coverPanelBleedBox(
  panel: MillimeterBox,
  bleed: MillimeterBox,
  kind: "back" | "front",
): MillimeterBox {
  const panelRight = panel.x + panel.width;
  const bleedRight = bleed.x + bleed.width;
  return {
    x: kind === "back" ? bleed.x : panel.x,
    y: bleed.y,
    width: kind === "back" ? panelRight - bleed.x : bleedRight - panel.x,
    height: bleed.height,
  };
}

function marginsBetween(
  inner: MillimeterBox,
  outer: MillimeterBox,
): BleedMarginsMm {
  return {
    top: inner.y - outer.y,
    right: outer.x + outer.width - (inner.x + inner.width),
    bottom: outer.y + outer.height - (inner.y + inner.height),
    left: inner.x - outer.x,
  };
}

function htmlDocument(fontFaces: string, css: string, body: string): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'"><style>${fontFaces}${css}</style></head><body>${body}</body></html>`;
}

function pageCss(media: MillimeterBox, trim: MillimeterBox): string {
  return `@page{size:${media.width}mm ${media.height}mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#17212b;font-family:"Hekayati Arabic",sans-serif}body{direction:rtl}.print-page{position:relative;width:${media.width}mm;height:${media.height}mm;overflow:hidden;break-after:page;page-break-after:always}.print-page:last-child{break-after:auto;page-break-after:auto}.trim-canvas{position:absolute;${boxStyle(trim)};overflow:hidden}.bleed-art,.trim-art,.panel-art,.cover-bleed-art{position:absolute;display:block}.bleed-art,.cover-bleed-art{object-fit:fill}.trim-art,.panel-art{object-fit:cover}.cover-panel{position:absolute;overflow:hidden}.panel-spine .text-block{writing-mode:vertical-rl;text-orientation:mixed;padding:.5mm;line-height:1}.text-block,.dialogue-bubble{position:absolute;display:flex;align-items:center;justify-content:center;text-align:right;line-height:1.65;overflow:hidden;padding:3mm;white-space:pre-wrap;unicode-bidi:plaintext}.dialogue-bubble{display:block;padding:2mm;background:#fff;border:.35mm solid #17212b;border-radius:4mm;font-size:12pt}.dialogue-speaker{display:block;font-weight:700}.text-heading{font-family:"Hekayati Brand","Hekayati Arabic",sans-serif;font-weight:700;text-align:center}.text-body{font-weight:400}.aid-panel{background:rgba(255,248,232,.92);border:0.35mm solid rgba(23,33,43,.12);border-radius:4mm}.panel-spine .aid-panel{border-radius:1mm}.aid-gradient{background:linear-gradient(180deg,rgba(255,255,255,.15),rgba(255,255,255,.9))}.crop-mark{position:absolute;background:#000;transform-origin:0 0}`;
}

function imageElement(
  image: PrintDocumentImage,
  box: MillimeterBox,
  className: string,
): string {
  const src = `data:${image.mime};base64,${image.bytes.toString("base64")}`;
  return `<img class="${className}" src="${src}" alt="" width="${image.widthPx}" height="${image.heightPx}" style="${boxStyle(box)}">`;
}

function textElement(
  text: PrintTextContent,
  outer: MillimeterBox,
  panel?: "back" | "spine" | "front",
): string {
  const region = {
    x: outer.x + outer.width * text.region.x,
    y: outer.y + outer.height * text.region.y,
    width: outer.width * text.region.width,
    height: outer.height * text.region.height,
  };
  const panelClass = panel ? ` panel-text-${panel}` : "";
  return `<div class="text-block text-${text.style} aid-${text.aid}${panelClass}" style="${boxStyle(region)}font-size:${text.fontSizePt}pt">${escapeHtml(text.text)}</div>`;
}

function bubbleElement(
  bubble: {
    speakerLabel: string;
    text: string;
    region: { x: number; y: number; width: number; height: number };
  },
  outer: MillimeterBox,
): string {
  const region = {
    x: outer.width * bubble.region.x,
    y: outer.height * bubble.region.y,
    width: outer.width * bubble.region.width,
    height: outer.height * bubble.region.height,
  };
  return `<div class="dialogue-bubble" style="${boxStyle(region)}"><span class="dialogue-speaker">${escapeHtml(bubble.speakerLabel)}</span>${escapeHtml(bubble.text)}</div>`;
}

function cropMarkElements(marks: CropMarkSegment[]): string {
  return marks
    .map((mark) => {
      const horizontal = Math.abs(mark.from.y - mark.to.y) < 1e-9;
      const length = horizontal
        ? Math.abs(mark.to.x - mark.from.x)
        : Math.abs(mark.to.y - mark.from.y);
      const left = Math.min(mark.from.x, mark.to.x);
      const top = Math.min(mark.from.y, mark.to.y);
      return `<span class="crop-mark" aria-hidden="true" style="left:${left}mm;top:${top}mm;width:${horizontal ? length : mark.strokePt / MM_TO_PT}mm;height:${horizontal ? mark.strokePt / MM_TO_PT : length}mm"></span>`;
    })
    .join("");
}

async function embeddedFontFaces(): Promise<string> {
  const faces = await Promise.all(
    FONT_FILES.map(async ([filename, family, weight, expected]) => {
      const bytes = await readFile(
        new URL(`../ui/fonts/${filename}`, import.meta.url),
      );
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== expected) throw new Error("PRINT_FONT_HASH_MISMATCH");
      return `@font-face{font-family:"${family}";src:url("data:font/ttf;base64,${bytes.toString("base64")}") format("truetype");font-weight:${weight};font-style:normal;font-display:block}`;
    }),
  );
  return faces.join("");
}

async function denyExternalResources(
  context: BrowserContext,
  blocked: Array<{ scheme: string; resourceType: string }>,
): Promise<void> {
  context.on("request", (request) => captureBlockedRequest(request, blocked));
  await context.route("**/*", async (route) => {
    if (inMemoryUrl(route.request().url())) await route.continue();
    else await route.abort("blockedbyclient");
  });
}

function captureBlockedRequest(
  request: Request,
  blocked: Array<{ scheme: string; resourceType: string }>,
): void {
  if (inMemoryUrl(request.url())) return;
  blocked.push({
    scheme: request.url().split(":", 1)[0]?.slice(0, 24) ?? "unknown",
    resourceType: request.resourceType().slice(0, 32),
  });
}

function inMemoryUrl(value: string): boolean {
  return value === "about:blank" || value.startsWith("data:");
}

async function detectOverflow(page: Page): Promise<number[]> {
  return page.locator(".print-page").evaluateAll((pages) =>
    pages.flatMap((element, index) => {
      const overflow = [
        ...element.querySelectorAll<HTMLElement>(".text-block"),
      ].some(
        (text) =>
          text.scrollHeight > text.clientHeight + 1 ||
          text.scrollWidth > text.clientWidth + 1,
      );
      return overflow ? [index + 1] : [];
    }),
  );
}

async function canonicalizeWithBoxes(
  bytes: Buffer,
  bleed: MillimeterBox,
  trim: MillimeterBox,
  qpdf: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  throwIfAborted(signal);
  const directory = await mkdtemp(join(tmpdir(), "hekayati-print-pdf-"));
  const input = join(directory, "input.pdf");
  const qdf = join(directory, "expanded.pdf");
  const modified = join(directory, "boxed.pdf");
  const output = join(directory, "output.pdf");
  try {
    throwIfAborted(signal);
    await writeFile(input, bytes, { mode: 0o600 });
    await run(
      qpdf,
      ["--qdf", "--object-streams=disable", input, qdf],
      toolOptions(signal),
    );
    const source = (await readFile(qdf)).toString("latin1");
    const boxed = injectBoxes(source, bleed, trim);
    await writeFile(modified, Buffer.from(boxed, "latin1"), { mode: 0o600 });
    await run(
      qpdf,
      [
        "--remove-info",
        "--remove-metadata",
        "--deterministic-id",
        "--object-streams=disable",
        "--warning-exit-0",
        modified,
        output,
      ],
      toolOptions(signal),
    );
    await run(qpdf, ["--check", output], toolOptions(signal));
    throwIfAborted(signal);
    return await readFile(output);
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw abortError();
    throw new Error("PRINT_PDF_CANONICALIZATION_FAILED", { cause: error });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function injectBoxes(
  source: string,
  bleed: MillimeterBox,
  trim: MillimeterBox,
): string {
  const mediaPattern = /(\/MediaBox\s*\[[^\]]+\])/gu;
  if (!mediaPattern.test(source)) throw new Error("PRINT_PDF_MEDIABOX_MISSING");
  mediaPattern.lastIndex = 0;
  return source.replace(
    mediaPattern,
    (media) =>
      `${media}\n  /BleedBox ${pdfBox(bleed)}\n  /TrimBox ${pdfBox(trim)}`,
  );
}

function pdfBox(box: MillimeterBox): string {
  return `[ ${pt(box.x)} ${pt(box.y)} ${pt(box.x + box.width)} ${pt(box.y + box.height)} ]`;
}

function pt(mm: number): string {
  return (mm * MM_TO_PT).toFixed(4);
}

function toolOptions(signal?: AbortSignal) {
  return {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    ...(signal ? { signal } : {}),
  };
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("ABORT_ERR");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message === "ABORT_ERR" ||
      ("code" in error && error.code === "ABORT_ERR"))
  );
}

function closeLateBrowser(browser: Promise<Browser>): void {
  void browser
    .then(async (value) => await value.close())
    .catch(() => undefined);
}

function closeLateContext(context: Promise<BrowserContext>): void {
  void context
    .then(async (value) => await value.close())
    .catch(() => undefined);
}

function boxStyle(box: MillimeterBox): string {
  return `left:${box.x}mm;top:${box.y}mm;width:${box.width}mm;height:${box.height}mm;`;
}

function escapeHtml(value: string): string {
  if (/[^\P{C}\n\t]/u.test(value))
    throw new Error("PRINT_TEXT_CONTROL_INVALID");
  return value
    .normalize("NFC")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function minimumPpi(images: Array<PrintDocumentImage | null>): number | null {
  const values = images.flatMap((image) => (image ? [image.effectivePpi] : []));
  return values.length ? Math.min(...values) : null;
}

function assertInterior(document: PrintInteriorDocument): void {
  if (document.pages.length < 16 || document.pages.length > 40)
    throw new Error("PRINT_INTERIOR_PAGE_COUNT_INVALID");
  if (
    document.pages.some(
      (page, index) => page.map.outputPageNumber !== index + 1,
    )
  )
    throw new Error("PRINT_INTERIOR_PAGE_MAP_INVALID");
}

function assertCover(document: PrintCoverDocument): void {
  if (
    document.panels.map((panel) => panel.kind).join(",") !== "back,spine,front"
  )
    throw new Error("PRINT_COVER_PANEL_ORDER_INVALID");
}

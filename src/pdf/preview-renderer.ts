import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  chromium,
  type BrowserContext,
  type Page,
  type Request,
} from "playwright";

import {
  buildPreviewCompositionDocument,
  type PreviewCompositionDocument,
  type PreviewCompositionDocumentInput,
  type PreviewFontFile,
  type PreviewPageMapEntry,
} from "./composition-document.js";
import {
  createPreviewPageThumbnail,
  type PreviewThumbnail,
} from "./preview-derivatives.js";

const run = promisify(execFile);
const regularFontHash =
  "8e0f1046c736bf939d4939ee3ae0116acf61cbcd6592deae7656761627080981";
const boldFontHash =
  "b74f809dead12442ed56e02a12c3bcc02076c9ad4e32f17d0a9ca6fc1aafc89e";
const brandFontHash =
  "9e6490332990d1c055d698d2216dc039ebfc0207a4b2cb54af45a97c655ba19e";

export const previewRendererPolicyV1 = Object.freeze({
  schemaVersion: 1 as const,
  rendererId: "PreviewRenderer/Chromium149/v1",
  widthMm: 210,
  heightMm: 297,
  javaScriptEnabled: false,
  offline: true,
  serviceWorkers: "block",
  canonicalizer:
    "qpdf/remove-info+remove-metadata+fixed-moddate+content-derived-id",
});

export const previewRendererPolicyHash = createHash("sha256")
  .update(JSON.stringify(previewRendererPolicyV1))
  .digest("hex");

export type PreviewRenderInput = Omit<PreviewCompositionDocumentInput, "fonts">;

export interface PreviewRenderOptions {
  thumbnailPageNumbers?: number[];
  qpdfPath?: string;
}

export interface RenderedPreviewThumbnail extends PreviewThumbnail {
  page: PreviewPageMapEntry;
}

export interface PreviewRenderResult {
  pdfBytes: Buffer;
  pageMap: PreviewPageMapEntry[];
  documentHash: string;
  rendererPolicyHash: string;
  egressRequestCount: number;
  blockedRequests: Array<{ scheme: string; resourceType: string }>;
  thumbnails: RenderedPreviewThumbnail[];
}

export async function renderPreviewPdf(
  input: PreviewRenderInput,
  options: PreviewRenderOptions = {},
): Promise<PreviewRenderResult> {
  const fonts = await loadVerifiedPreviewFonts();
  const document = buildPreviewCompositionDocument({ ...input, fonts });
  const thumbnailPages = normalizeThumbnailPages(
    options.thumbnailPageNumbers ?? [],
    document.pageMap.length,
  );
  const browser = await chromium.launch({ headless: true });
  try {
    return await renderInBrowser(browser, document, thumbnailPages, options);
  } finally {
    await browser.close();
  }
}

async function renderInBrowser(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  document: PreviewCompositionDocument,
  thumbnailPages: number[],
  options: PreviewRenderOptions,
): Promise<PreviewRenderResult> {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    locale: "ar-EG",
    offline: true,
    serviceWorkers: "block",
    viewport: { width: 800, height: 1200 },
  });
  const blockedRequests: Array<{ scheme: string; resourceType: string }> = [];
  try {
    await installDenyAllResourceGuard(context, blockedRequests);
    const page = await context.newPage();
    await page.setContent(document.html, { waitUntil: "load" });
    await page.evaluate(async () => await globalThis.document.fonts.ready);
    await page.emulateMedia({ media: "print" });
    assertNoEgress(blockedRequests);
    const thumbnails = await renderThumbnails(page, document, thumbnailPages);
    const chromiumBytes = await page.pdf(pdfOptions());
    const pdfBytes = await canonicalizePdf(
      Buffer.from(chromiumBytes),
      options.qpdfPath ?? "qpdf",
    );
    assertNoEgress(blockedRequests);
    return renderResult(document, pdfBytes, blockedRequests, thumbnails);
  } finally {
    await context.close();
  }
}

async function installDenyAllResourceGuard(
  context: BrowserContext,
  blocked: Array<{ scheme: string; resourceType: string }>,
): Promise<void> {
  context.on("request", (request) => captureBlockedRequest(request, blocked));
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (isInMemoryUrl(request.url())) await route.continue();
    else await route.abort("blockedbyclient");
  });
}

function captureBlockedRequest(
  request: Request,
  blocked: Array<{ scheme: string; resourceType: string }>,
): void {
  if (isInMemoryUrl(request.url())) return;
  blocked.push({
    scheme: safeScheme(request.url()),
    resourceType: request.resourceType().slice(0, 32),
  });
}

function isInMemoryUrl(value: string): boolean {
  return value === "about:blank" || value.startsWith("data:");
}

function safeScheme(value: string): string {
  const match = /^([a-z][a-z0-9+.-]*):/iu.exec(value);
  return (match?.[1] ?? "unknown").toLowerCase().slice(0, 24);
}

function assertNoEgress(
  blocked: Array<{ scheme: string; resourceType: string }>,
): void {
  if (blocked.length > 0) throw new Error("PREVIEW_RENDER_EGRESS_BLOCKED");
}

async function renderThumbnails(
  page: Page,
  document: PreviewCompositionDocument,
  pageNumbers: number[],
): Promise<RenderedPreviewThumbnail[]> {
  const pages = page.locator(".preview-page");
  if ((await pages.count()) !== document.pageMap.length)
    throw new Error("PREVIEW_RENDER_PAGE_COUNT_MISMATCH");
  return Promise.all(
    pageNumbers.map(async (pageNumber) => {
      const raster = await pages.nth(pageNumber - 1).screenshot({
        type: "png",
        animations: "disabled",
        caret: "hide",
        scale: "css",
      });
      return {
        ...(await createPreviewPageThumbnail(raster)),
        page: document.pageMap[pageNumber - 1],
      };
    }),
  );
}

function pdfOptions() {
  return {
    width: `${previewRendererPolicyV1.widthMm}mm`,
    height: `${previewRendererPolicyV1.heightMm}mm`,
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
    tagged: false,
    outline: false,
  } as const;
}

async function canonicalizePdf(
  bytes: Buffer,
  qpdfPath: string,
): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "hekayati-preview-pdf-"));
  const input = join(directory, "input.pdf");
  const output = join(directory, "output.pdf");
  try {
    await writeFile(input, bytes, { mode: 0o600 });
    await run(
      qpdfPath,
      [
        "--remove-info",
        "--remove-metadata",
        "--deterministic-id",
        "--object-streams=disable",
        input,
        output,
      ],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return normalizeQpdfDocument(await readFile(output));
  } catch (error) {
    throw new Error("PREVIEW_PDF_CANONICALIZATION_FAILED", { cause: error });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function normalizeQpdfDocument(bytes: Buffer): Buffer {
  const source = bytes.toString("latin1");
  const pattern = /\/ModDate\s*\(D:\d{14}[+-]\d{2}'\d{2}'\)/u;
  const match = pattern.exec(source)?.[0];
  if (!match) throw new Error("PREVIEW_PDF_MODIFICATION_DATE_MISSING");
  const replacement = "/ModDate (D:20000101000000+00'00')";
  if (replacement.length !== match.length)
    throw new Error("PREVIEW_PDF_MODIFICATION_DATE_LENGTH_MISMATCH");
  const dated = source.replace(pattern, replacement);
  const idPattern = /\/ID\s*\[<[a-f0-9]{32}><[a-f0-9]{32}>\]/iu;
  const idMatch = idPattern.exec(dated)?.[0];
  if (!idMatch) throw new Error("PREVIEW_PDF_DOCUMENT_ID_MISSING");
  const zeroId =
    "/ID [<00000000000000000000000000000000><00000000000000000000000000000000>]";
  if (zeroId.length !== idMatch.length)
    throw new Error("PREVIEW_PDF_DOCUMENT_ID_LENGTH_MISMATCH");
  const neutral = dated.replace(idPattern, zeroId);
  const contentId = createHash("sha256")
    .update(Buffer.from(neutral, "latin1"))
    .digest("hex")
    .slice(0, 32);
  const contentDerivedId = `/ID [<${contentId}><${contentId}>]`;
  return Buffer.from(neutral.replace(zeroId, contentDerivedId), "latin1");
}

function renderResult(
  document: PreviewCompositionDocument,
  pdfBytes: Buffer,
  blockedRequests: Array<{ scheme: string; resourceType: string }>,
  thumbnails: RenderedPreviewThumbnail[],
): PreviewRenderResult {
  return {
    pdfBytes,
    pageMap: document.pageMap,
    documentHash: document.documentHash,
    rendererPolicyHash: previewRendererPolicyHash,
    egressRequestCount: blockedRequests.length,
    blockedRequests: [...blockedRequests],
    thumbnails,
  };
}

function normalizeThumbnailPages(
  values: number[],
  pageCount: number,
): number[] {
  const unique = [...new Set(values)].sort((left, right) => left - right);
  if (
    unique.length > 8 ||
    unique.some(
      (value) => !Number.isInteger(value) || value < 1 || value > pageCount,
    )
  )
    throw new Error("PREVIEW_THUMBNAIL_PAGE_INVALID");
  return unique;
}

async function loadVerifiedPreviewFonts(): Promise<PreviewFontFile[]> {
  const definitions = [
    ["IBMPlexSansArabic-Regular.ttf", "Hekayati Arabic", 400, regularFontHash],
    ["IBMPlexSansArabic-Bold.ttf", "Hekayati Arabic", 700, boldFontHash],
    ["Lemonada-Bold.ttf", "Hekayati Brand", 700, brandFontHash],
  ] as const;
  return Promise.all(
    definitions.map(async ([filename, family, weight, sha256]) => ({
      family,
      weight,
      sha256,
      bytes: await readFile(
        new URL(`../ui/fonts/${filename}`, import.meta.url),
      ),
    })),
  );
}

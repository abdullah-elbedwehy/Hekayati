import { createHash } from "node:crypto";

import { previewCompositionCss } from "./preview-css.js";

const prohibitedBidiControls =
  /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const maximumTextLength = 5_000;
const maximumImageBytes = 16 * 1024 * 1024;

export type PreviewPageKind =
  | "front_cover"
  | "title"
  | "dedication"
  | "story"
  | "farewell"
  | "brand"
  | "back_cover";

export interface NormalizedRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewDocumentImage {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
  alt: string;
  widthPx: number;
  heightPx: number;
}

export interface PreviewTextBlock {
  heading?: string;
  body?: string;
  region: NormalizedRectangle;
  fontSizePt: number;
  aid: "none" | "gradient" | "panel";
}

export interface PreviewDialogueBubble {
  speakerLabel: string;
  body: string;
  region: NormalizedRectangle;
  pointer?: { x: number; y: number };
}

export interface PreviewCompositionPage {
  kind: PreviewPageKind;
  interiorPageNumber: number | null;
  image?: PreviewDocumentImage;
  text?: PreviewTextBlock;
  bubbles?: PreviewDialogueBubble[];
}

export interface PreviewFontFile {
  family: "Hekayati Arabic" | "Hekayati Brand";
  weight: 400 | 600 | 700;
  bytes: Uint8Array;
  sha256: string;
}

export interface PreviewCompositionDocumentInput {
  pages: PreviewCompositionPage[];
  watermarkText: string;
  footerText?: string;
  fonts: PreviewFontFile[];
}

export interface PreviewPageMapEntry {
  pageNumber: number;
  kind: PreviewPageKind;
  interiorPageNumber: number | null;
  visibleLabel: string;
}

export interface PreviewCompositionDocument {
  html: string;
  pageMap: PreviewPageMapEntry[];
  fontNames: string[];
  imageCount: number;
  documentHash: string;
}

export function buildPreviewCompositionDocument(
  input: PreviewCompositionDocumentInput,
): PreviewCompositionDocument {
  assertDocumentInput(input);
  const pageMap = createPageMap(input.pages);
  const footer = input.footerText ?? "معاينة — غير مخصصة للطباعة";
  assertSafeText(footer, "PREVIEW_FOOTER_INVALID");
  const fontFaces = input.fonts.map(fontFace).join("\n");
  const pages = input.pages
    .map((page, index) => pageHtml(page, pageMap[index], input, footer))
    .join("\n");
  const html = documentHtml(fontFaces, pages);
  return {
    html,
    pageMap,
    fontNames: [...new Set(input.fonts.map((font) => font.family))],
    imageCount: input.pages.filter((page) => page.image !== undefined).length,
    documentHash: createHash("sha256").update(html).digest("hex"),
  };
}

function assertDocumentInput(input: PreviewCompositionDocumentInput): void {
  assertCanonicalPageOrder(input.pages);
  assertSafeText(input.watermarkText, "PREVIEW_WATERMARK_INVALID");
  if (!input.watermarkText.trim() || input.watermarkText.length > 80)
    throw new Error("PREVIEW_WATERMARK_INVALID");
  if (input.fonts.length < 2 || input.fonts.length > 8)
    throw new Error("PREVIEW_FONT_SET_INVALID");
  for (const font of input.fonts) assertFont(font);
  for (const page of input.pages) assertPage(page);
}

function assertCanonicalPageOrder(pages: PreviewCompositionPage[]): void {
  const interiorCount = pages.length - 2;
  if (interiorCount !== 16 && interiorCount !== 24)
    throw new Error("PREVIEW_PAGE_COUNT_INVALID");
  if (pages[0]?.kind !== "front_cover" || pages.at(-1)?.kind !== "back_cover")
    throw new Error("PREVIEW_PAGE_ORDER_INVALID");
  const interior = pages.slice(1, -1);
  if (
    interior[0]?.kind !== "title" ||
    interior[1]?.kind !== "dedication" ||
    interior.at(-2)?.kind !== "farewell" ||
    interior.at(-1)?.kind !== "brand" ||
    interior.slice(2, -2).some((page) => page.kind !== "story")
  )
    throw new Error("PREVIEW_PAGE_ORDER_INVALID");
  if (
    interior.some((page, index) => page.interiorPageNumber !== index + 1) ||
    pages[0].interiorPageNumber !== null ||
    pages.at(-1)!.interiorPageNumber !== null
  )
    throw new Error("PREVIEW_PAGE_NUMBER_INVALID");
}

function assertPage(page: PreviewCompositionPage): void {
  if (!page.text && !page.image)
    throw new Error("PREVIEW_PAGE_CONTENT_REQUIRED");
  if (page.image) assertImage(page.image);
  if (page.text) assertTextBlock(page.text);
  if ((page.bubbles?.length ?? 0) > 12)
    throw new Error("PREVIEW_BUBBLE_COUNT_INVALID");
  for (const bubble of page.bubbles ?? []) assertBubble(bubble);
}

function assertImage(image: PreviewDocumentImage): void {
  assertSafeText(image.alt, "PREVIEW_IMAGE_INVALID");
  if (
    image.bytes.byteLength === 0 ||
    image.bytes.byteLength > maximumImageBytes ||
    !Number.isInteger(image.widthPx) ||
    !Number.isInteger(image.heightPx) ||
    image.widthPx <= 0 ||
    image.heightPx <= 0
  )
    throw new Error("PREVIEW_IMAGE_INVALID");
}

function assertTextBlock(text: PreviewTextBlock): void {
  if (text.heading !== undefined)
    assertSafeText(text.heading, "PREVIEW_TEXT_INVALID");
  if (text.body !== undefined)
    assertSafeText(text.body, "PREVIEW_TEXT_INVALID");
  if (!text.heading?.trim() && !text.body?.trim())
    throw new Error("PREVIEW_TEXT_INVALID");
  if (text.fontSizePt < 12 || text.fontSizePt > 72)
    throw new Error("PREVIEW_FONT_SIZE_INVALID");
  assertRectangle(text.region);
}

function assertBubble(bubble: PreviewDialogueBubble): void {
  assertSafeText(bubble.speakerLabel, "PREVIEW_BUBBLE_INVALID");
  assertSafeText(bubble.body, "PREVIEW_BUBBLE_INVALID");
  if (!bubble.speakerLabel.trim() || !bubble.body.trim())
    throw new Error("PREVIEW_BUBBLE_INVALID");
  assertRectangle(bubble.region);
  if (bubble.pointer) {
    assertUnit(bubble.pointer.x);
    assertUnit(bubble.pointer.y);
  }
}

function assertRectangle(region: NormalizedRectangle): void {
  assertUnit(region.x);
  assertUnit(region.y);
  assertUnit(region.width, false);
  assertUnit(region.height, false);
  if (region.x + region.width > 1 || region.y + region.height > 1)
    throw new Error("PREVIEW_REGION_INVALID");
}

function assertUnit(value: number, zeroAllowed = true): void {
  if (
    !Number.isFinite(value) ||
    value < (zeroAllowed ? 0 : Number.EPSILON) ||
    value > 1
  )
    throw new Error("PREVIEW_REGION_INVALID");
}

function assertFont(font: PreviewFontFile): void {
  const actual = createHash("sha256").update(font.bytes).digest("hex");
  if (!/^[a-f0-9]{64}$/u.test(font.sha256) || actual !== font.sha256)
    throw new Error("PREVIEW_FONT_HASH_MISMATCH");
  if (font.bytes.byteLength < 1_000 || font.bytes.byteLength > 10_000_000)
    throw new Error("PREVIEW_FONT_SET_INVALID");
}

function assertSafeText(value: string, code: string): void {
  if (
    value.length > maximumTextLength ||
    prohibitedBidiControls.test(value) ||
    containsProhibitedControlCharacter(value)
  )
    throw new Error(code);
}

function containsProhibitedControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    )
      return true;
  }
  return false;
}

function createPageMap(pages: PreviewCompositionPage[]): PreviewPageMapEntry[] {
  return pages.map((page, index) => ({
    pageNumber: index + 1,
    kind: page.kind,
    interiorPageNumber: page.interiorPageNumber,
    visibleLabel: visiblePageLabel(page),
  }));
}

function visiblePageLabel(page: PreviewCompositionPage): string {
  if (page.kind === "front_cover") return "غلاف أمامي";
  if (page.kind === "back_cover") return "غلاف خلفي";
  return `صفحة ${page.interiorPageNumber}`;
}

function fontFace(font: PreviewFontFile): string {
  const bytes = Buffer.from(font.bytes).toString("base64");
  return `@font-face {
    font-family: "${font.family}";
    src: url("data:font/ttf;base64,${bytes}") format("truetype");
    font-weight: ${font.weight};
    font-style: normal;
    font-display: block;
  }`;
}

function pageHtml(
  page: PreviewCompositionPage,
  map: PreviewPageMapEntry,
  input: PreviewCompositionDocumentInput,
  footer: string,
): string {
  const image = page.image ? imageHtml(page.image) : "";
  const text = page.text ? textHtml(page.text) : "";
  const bubbles = (page.bubbles ?? []).map(bubbleHtml).join("\n");
  return `<section class="preview-page kind-${page.kind}">
    ${image}<div class="page-shade"></div>${text}${bubbles}
    <div class="preview-watermark">${escapeHtml(input.watermarkText)}</div>
    <footer class="preview-footer"><span>${escapeHtml(footer)}</span><span>${escapeHtml(map.visibleLabel)}</span></footer>
  </section>`;
}

function imageHtml(image: PreviewDocumentImage): string {
  const source = `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`;
  return `<img class="page-art" src="${source}" alt="${escapeHtml(image.alt)}" width="${image.widthPx}" height="${image.heightPx}">`;
}

function textHtml(text: PreviewTextBlock): string {
  const heading = text.heading ? `<h1>${escapeHtml(text.heading)}</h1>` : "";
  const body = text.body ? `<p>${escapeHtml(text.body)}</p>` : "";
  const style = `${rectangleStyle(text.region)}font-size:${text.fontSizePt}pt`;
  return `<div class="text-block aid-${text.aid}" style="${style}">${heading}${body}</div>`;
}

function bubbleHtml(bubble: PreviewDialogueBubble): string {
  const pointer = bubble.pointer
    ? `<span class="dialogue-pointer" style="left:${percent(bubble.pointer.x)};top:${percent(bubble.pointer.y)}"></span>`
    : "";
  return `<div class="dialogue-bubble" style="${rectangleStyle(bubble.region)}">
    <span class="dialogue-speaker">${escapeHtml(bubble.speakerLabel)}</span>${escapeHtml(bubble.body)}${pointer}
  </div>`;
}

function rectangleStyle(region: NormalizedRectangle): string {
  return `left:${percent(region.x)};top:${percent(region.y)};width:${percent(region.width)};height:${percent(region.height)};`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(4)}%`;
}

function documentHtml(fontFaces: string, pages: string): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="light">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'">
  <style>${fontFaces}\n${previewCompositionCss}</style>
</head>
<body>${pages}</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .normalize("NFC")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

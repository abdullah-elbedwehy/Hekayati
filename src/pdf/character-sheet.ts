import { readFile } from "node:fs/promises";

import { chromium } from "playwright";
import { characterSheetCss } from "./character-sheet-css.js";

export interface SheetPdfImage {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
  alt: string;
}

export interface CharacterSheetPdfInput {
  characterName: string;
  views: {
    face: SheetPdfImage;
    front: SheetPdfImage;
    threeQuarter: SheetPdfImage;
    fullBody: SheetPdfImage;
    mainOutfit: SheetPdfImage;
  };
  referenceThumbnails: SheetPdfImage[];
}

const labels = {
  face: "الوجه",
  front: "من الأمام",
  threeQuarter: "زاوية ثلاثة أرباع",
  fullBody: "الجسم كاملًا",
  mainOutfit: "الملابس الرئيسية",
} as const;

export async function renderCharacterSheetPdf(
  input: CharacterSheetPdfInput,
): Promise<Buffer> {
  assertInput(input);
  const font = await readFile(
    new URL("../ui/fonts/IBMPlexSansArabic-Regular.ttf", import.meta.url),
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      locale: "ar-EG",
    });
    const page = await context.newPage();
    await page.route(/^https?:\/\//u, (route) =>
      route.abort("blockedbyclient"),
    );
    await page.setContent(documentHtml(input, font), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const bytes = await page.pdf({
      format: "A5",
      landscape: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
      printBackground: true,
      preferCSSPageSize: true,
    });
    await context.close();
    return Buffer.from(bytes);
  } finally {
    await browser.close();
  }
}

function assertInput(input: CharacterSheetPdfInput): void {
  if (!input.characterName.trim() || input.characterName.length > 240)
    throw new Error("SHEET_PDF_NAME_INVALID");
  const images = [...Object.values(input.views), ...input.referenceThumbnails];
  if (
    input.referenceThumbnails.length > 20 ||
    images.some((image) => image.bytes.byteLength === 0)
  )
    throw new Error("SHEET_PDF_IMAGE_INVALID");
}

function documentHtml(input: CharacterSheetPdfInput, font: Buffer): string {
  const views = (Object.keys(labels) as Array<keyof typeof labels>)
    .map(
      (view) => `
        <figure class="view-card view-${view}">
          <img src="${dataUrl(input.views[view])}" alt="${escapeHtml(input.views[view].alt)}">
          <figcaption>${labels[view]}</figcaption>
        </figure>`,
    )
    .join("");
  const references = input.referenceThumbnails.length
    ? input.referenceThumbnails
        .map(
          (image) =>
            `<img src="${dataUrl(image)}" alt="${escapeHtml(image.alt)}">`,
        )
        .join("")
    : `<p class="description-only">مرجع وصفي فقط</p>`;
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <style>
    @font-face {
      font-family: "Hekayati Arabic";
      src: url("data:font/ttf;base64,${font.toString("base64")}") format("truetype");
      font-display: block;
    }
    ${characterSheetCss}
  </style>
</head>
<body>
  <main aria-label="ورقة شخصية ${escapeHtml(input.characterName)}">
    <header>
      <h1>${escapeHtml(input.characterName)}</h1>
      <span class="brand">حكايتي · ورقة اعتماد الشخصية</span>
    </header>
    <aside>
      <h2>الصور المرجعية</h2>
      <div class="references">${references}</div>
    </aside>
    <section class="views" aria-label="مناظر الشخصية">${views}</section>
  </main>
</body>
</html>`;
}

function dataUrl(image: SheetPdfImage): string {
  return `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  CropMarkSegment,
  MillimeterBox,
} from "../domain/print/geometry.js";
import {
  inspectCropMarkSegments,
  type CropMarkPageEvidence,
} from "./print-preflight-raster.js";

const run = promisify(execFile);
const MM_PER_POINT = 25.4 / 72;
const MAX_INSPECTED_PAGES = 40;
const MAX_TOOL_OUTPUT_BYTES = 4 * 1024 * 1024;
// Ghostscript CMYK output can include invisible extraction fragments at the
// page edge (observed <= 1.062 pt). Poppler exposes them as words although they
// paint no raster ink, so only text at >= 0.5 mm is visual safe-margin evidence.
// Hekayati's minimum print text is 12 pt.
const MIN_VISIBLE_WORD_HEIGHT_MM = 0.5;
const PROHIBITED = [
  "/JavaScript",
  "/OpenAction",
  "/AcroForm",
  "/EmbeddedFiles",
  "/Launch",
  "/RichMedia",
] as const;

export interface PrintPreflightTools {
  qpdf: string;
  pdfinfo: string;
  pdffonts: string;
  pdfimages: string;
  pdftotext: string;
  pdftoppm: string;
}

export interface PdfPageBoxFacts {
  pageNumber: number;
  rotation: number | null;
  mediaBoxMm: MillimeterBox | null;
  bleedBoxMm: MillimeterBox | null;
  trimBoxMm: MillimeterBox | null;
  portrait: boolean;
}

export interface PdfPageImagePpiFacts {
  pageNumber: number;
  imageCount: number;
  minimumPpi: number | null;
}

export interface PdfPageTextBoundsFacts {
  pageNumber: number;
  wordCount: number;
  boundsMm: MillimeterBox | null;
  unsafeWordCount: number;
  firstUnsafeWordBoundsMm: MillimeterBox | null;
}

export interface PdfMechanicalFacts {
  pageCount: number;
  encrypted: boolean;
  parseable: boolean;
  mediaBoxMm: MillimeterBox | null;
  bleedBoxMm: MillimeterBox | null;
  trimBoxMm: MillimeterBox | null;
  pageBoxes: PdfPageBoxFacts[];
  fonts: Array<{
    name: string;
    embedded: boolean;
    subset: boolean;
    toUnicode: boolean;
  }>;
  imageCount: number;
  imagePpi: PdfPageImagePpiFacts[];
  minimumImagePpi: number | null;
  extractedTextLength: number;
  textBounds: PdfPageTextBoundsFacts[];
  hasArabicText: boolean;
  arabicGlyphCount: number;
  unmappedGlyphCount: number;
  printWatermarkCount: number;
  printWatermarkPages: number[];
  cropMarkSegments: CropMarkPageEvidence[];
  prohibitedFeatureCount: number;
  externalResourceCount: number;
  hasDeviceRgb: boolean;
  hasDeviceCmyk: boolean;
}

export async function collectToolVersions(
  tools: PrintPreflightTools,
): Promise<Record<string, string>> {
  const commands: Array<[string, string, string[]]> = [
    ["qpdf", tools.qpdf, ["--version"]],
    ["pdfinfo", tools.pdfinfo, ["-v"]],
    ["pdffonts", tools.pdffonts, ["-v"]],
    ["pdfimages", tools.pdfimages, ["-v"]],
    ["pdftotext", tools.pdftotext, ["-v"]],
    ["pdftoppm", tools.pdftoppm, ["-v"]],
  ];
  const entries = await Promise.all(
    commands.map(async ([name, tool, args]) => {
      try {
        const result = await run(tool, args, {
          timeout: 10_000,
          maxBuffer: 256 * 1024,
          windowsHide: true,
        });
        const version = `${result.stdout}\n${result.stderr}`
          .trim()
          .split(/\r?\n/u)[0]
          ?.slice(0, 120);
        return [name, version || "unknown"] as const;
      } catch {
        return [name, "unavailable"] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

export async function inspectPdf(
  path: string,
  tools: PrintPreflightTools,
  expectedCropMarks: readonly CropMarkSegment[],
  safeBoxes: readonly MillimeterBox[],
): Promise<PdfMechanicalFacts> {
  const encrypted = await inspectEncryption(path, tools.qpdf);
  if (!(await isParseable(path, tools.qpdf)))
    return emptyMechanicalFacts(encrypted);
  try {
    const firstInfo = await runTool(tools.pdfinfo, ["-box", path]);
    const initial = parsePdfInfo(firstInfo);
    if (encrypted || initial.encrypted) return emptyMechanicalFacts(true, true);
    const outputs = await readPdfOutputs(
      path,
      tools,
      firstInfo,
      initial.pageCount,
      expectedCropMarks,
    );
    return mechanicalFacts(initial.pageCount, outputs, safeBoxes);
  } catch {
    return emptyMechanicalFacts(encrypted);
  }
}

async function readPdfOutputs(
  path: string,
  tools: PrintPreflightTools,
  firstInfo: string,
  pageCount: number,
  expectedCropMarks: readonly CropMarkSegment[],
) {
  const lastPage = Math.min(pageCount, MAX_INSPECTED_PAGES);
  const detailedInfo =
    lastPage > 0
      ? await runTool(tools.pdfinfo, [
          "-box",
          "-f",
          "1",
          "-l",
          String(lastPage),
          path,
        ])
      : firstInfo;
  const pageBoxes = parsePdfInfo(detailedInfo).pageBoxes;
  const [fonts, images, text, textLayout, structure, cropMarkSegments] =
    await Promise.all([
      runTool(tools.pdffonts, [path]),
      runTool(tools.pdfimages, ["-list", path]),
      runTool(tools.pdftotext, ["-enc", "UTF-8", path, "-"]),
      runTool(tools.pdftotext, ["-bbox-layout", "-enc", "UTF-8", path, "-"]),
      runTool(tools.qpdf, ["--json", "--json-stream-data=none", path]),
      inspectCropMarkSegments({
        pdfPath: path,
        pdftoppm: tools.pdftoppm,
        pageBoxes,
        expectedSegments: expectedCropMarks,
      }),
    ]);
  return {
    detailedInfo,
    fonts,
    images,
    text,
    textLayout,
    structure,
    cropMarkSegments,
  };
}

function mechanicalFacts(
  pageCount: number,
  outputs: Awaited<ReturnType<typeof readPdfOutputs>>,
  safeBoxes: readonly MillimeterBox[],
): PdfMechanicalFacts {
  const info = parsePdfInfo(outputs.detailedInfo);
  const imageFacts = parsePdfImages(outputs.images);
  const firstPage = info.pageBoxes[0];
  return {
    pageCount,
    encrypted: false,
    parseable: true,
    mediaBoxMm: firstPage?.mediaBoxMm ?? null,
    bleedBoxMm: firstPage?.bleedBoxMm ?? null,
    trimBoxMm: firstPage?.trimBoxMm ?? null,
    pageBoxes: info.pageBoxes,
    fonts: parsePdfFonts(outputs.fonts),
    imageCount: imageFacts.count,
    imagePpi: imageFacts.pages,
    minimumImagePpi: imageFacts.minimumPpi,
    textBounds: parsePdfTextBounds(outputs.textLayout, safeBoxes),
    ...parsePdfText(outputs.text),
    cropMarkSegments: outputs.cropMarkSegments,
    prohibitedFeatureCount: PROHIBITED.filter((token) =>
      outputs.structure.includes(`"${token}"`),
    ).length,
    externalResourceCount: hasExternalResource(outputs.structure) ? 1 : 0,
    hasDeviceRgb: outputs.structure.includes("/DeviceRGB"),
    hasDeviceCmyk: outputs.structure.includes("/DeviceCMYK"),
  };
}

function hasExternalResource(structure: string): boolean {
  return ["/URI", "/GoToR", "/Launch"].some((token) =>
    structure.includes(`"${token}"`),
  );
}

export function parsePdfInfo(output: string): {
  pageCount: number;
  encrypted: boolean;
  pageBoxes: PdfPageBoxFacts[];
} {
  const pageCount = integer(output, /^Pages:\s+(\d+)/mu) ?? 0;
  const encrypted = /^Encrypted:\s+yes/imu.test(output);
  const pages = new Map<
    number,
    Omit<PdfPageBoxFacts, "pageNumber" | "portrait">
  >();
  for (const line of output.split(/\r?\n/u)) {
    const rotation = /^(?:Page\s+(\d+)\s+)?(?:Page\s+)?rot:\s+(-?\d+)/u.exec(
      line.trim(),
    );
    if (rotation) {
      const pageNumber = Number.parseInt(rotation[1] ?? "1", 10);
      page(pages, pageNumber).rotation = Number.parseInt(rotation[2], 10);
      continue;
    }
    const box =
      /^(?:Page\s+(\d+)\s+)?(MediaBox|BleedBox|TrimBox):\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+)/u.exec(
        line.trim(),
      );
    if (!box) continue;
    const pageNumber = Number.parseInt(box[1] ?? "1", 10);
    const parsed = pointBox(box.slice(3));
    const target = page(pages, pageNumber);
    if (box[2] === "MediaBox") target.mediaBoxMm = parsed;
    if (box[2] === "BleedBox") target.bleedBoxMm = parsed;
    if (box[2] === "TrimBox") target.trimBoxMm = parsed;
  }
  return {
    pageCount,
    encrypted,
    pageBoxes: [...pages.entries()]
      .sort(([left], [right]) => left - right)
      .slice(0, MAX_INSPECTED_PAGES)
      .map(([pageNumber, boxes]) => ({
        pageNumber,
        ...boxes,
        portrait: Boolean(
          boxes.mediaBoxMm &&
          boxes.mediaBoxMm.width < boxes.mediaBoxMm.height &&
          normalizedRotation(boxes.rotation) === 0,
        ),
      })),
  };
}

export function parsePdfFonts(output: string): PdfMechanicalFacts["fonts"] {
  return output.split(/\r?\n/u).flatMap((line) => {
    const match =
      /^(\S+)\s+.+\s+(yes|no)\s+(yes|no)\s+(yes|no)\s+\d+\s+\d+\s*$/u.exec(
        line.trim(),
      );
    if (!match) return [];
    return [
      {
        name: match[1].replace(/^[A-Z]{6}\+/u, "").slice(0, 120),
        embedded: match[2] === "yes",
        subset: match[3] === "yes",
        toUnicode: match[4] === "yes",
      },
    ];
  });
}

export function parsePdfImages(output: string): {
  count: number;
  minimumPpi: number | null;
  pages: PdfPageImagePpiFacts[];
} {
  const images: Array<{ pageNumber: number; ppi: number | null }> = [];
  for (const line of output.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (
      columns.length < 14 ||
      !/^\d+$/u.test(columns[0] ?? "") ||
      !/^\d+$/u.test(columns[1] ?? "") ||
      columns[2] !== "image"
    )
      continue;
    const xPpi = Number(columns[12]);
    const yPpi = Number(columns[13]);
    images.push({
      pageNumber: Number.parseInt(columns[0], 10),
      ppi:
        Number.isFinite(xPpi) && Number.isFinite(yPpi)
          ? Math.min(xPpi, yPpi)
          : null,
    });
  }
  const byPage = new Map<number, Array<number | null>>();
  for (const image of images)
    byPage.set(image.pageNumber, [
      ...(byPage.get(image.pageNumber) ?? []),
      image.ppi,
    ]);
  return {
    count: images.length,
    minimumPpi: minimum(images.map((image) => image.ppi)),
    pages: [...byPage.entries()]
      .sort(([left], [right]) => left - right)
      .slice(0, MAX_INSPECTED_PAGES)
      .map(([pageNumber, values]) => ({
        pageNumber,
        imageCount: values.length,
        minimumPpi: minimum(values),
      })),
  };
}

export function parsePdfText(
  output: string,
): Pick<
  PdfMechanicalFacts,
  | "extractedTextLength"
  | "hasArabicText"
  | "arabicGlyphCount"
  | "unmappedGlyphCount"
  | "printWatermarkCount"
  | "printWatermarkPages"
> {
  const normalized = output.normalize("NFC");
  const pages = textPages(normalized);
  return {
    extractedTextLength: normalized.length,
    hasArabicText: /[\u0600-\u06ff]/u.test(normalized),
    arabicGlyphCount: normalized.match(/[\u0600-\u06ff]/gu)?.length ?? 0,
    unmappedGlyphCount: [...normalized].filter(
      (character) => character === "\0" || character === "\ufffd",
    ).length,
    printWatermarkCount:
      occurrences(normalized, "معاينة") +
      occurrences(normalized, "غير مخصصة للطباعة"),
    printWatermarkPages: pages.flatMap((text, index) =>
      text.includes("معاينة") || text.includes("غير مخصصة للطباعة")
        ? [index + 1]
        : [],
    ),
  };
}

export function parsePdfTextBounds(
  output: string,
  safeBoxes: readonly MillimeterBox[] = [],
): PdfPageTextBoundsFacts[] {
  const pages: PdfPageTextBoundsFacts[] = [];
  const pagePattern = /<page\b[^>]*>([\s\S]*?)<\/page>/gu;
  for (const pageMatch of output.matchAll(pagePattern)) {
    if (pages.length >= MAX_INSPECTED_PAGES) break;
    const words: MillimeterBox[] = [];
    const wordPattern =
      /<word\b[^>]*xMin="([0-9.-]+)"\s+yMin="([0-9.-]+)"\s+xMax="([0-9.-]+)"\s+yMax="([0-9.-]+)"[^>]*>/gu;
    for (const word of pageMatch[1].matchAll(wordPattern)) {
      const bounds = pointBox(word.slice(1, 5));
      if (
        bounds &&
        bounds.width > 0 &&
        bounds.height >= MIN_VISIBLE_WORD_HEIGHT_MM
      )
        words.push(bounds);
    }
    const unsafeWords = safeBoxes.length
      ? words.filter(
          (word) => !safeBoxes.some((safeBox) => contains(safeBox, word, 0.5)),
        )
      : [];
    pages.push({
      pageNumber: pages.length + 1,
      wordCount: words.length,
      boundsMm: union(words),
      unsafeWordCount: unsafeWords.length,
      firstUnsafeWordBoundsMm: unsafeWords[0] ?? null,
    });
  }
  return pages;
}

export function resolvedTools(
  overrides: Partial<PrintPreflightTools> | undefined,
): PrintPreflightTools {
  return {
    qpdf: overrides?.qpdf ?? "qpdf",
    pdfinfo: overrides?.pdfinfo ?? "pdfinfo",
    pdffonts: overrides?.pdffonts ?? "pdffonts",
    pdfimages: overrides?.pdfimages ?? "pdfimages",
    pdftotext: overrides?.pdftotext ?? "pdftotext",
    pdftoppm: overrides?.pdftoppm ?? "pdftoppm",
  };
}

function page(
  pages: Map<number, Omit<PdfPageBoxFacts, "pageNumber" | "portrait">>,
  pageNumber: number,
) {
  const existing = pages.get(pageNumber);
  if (existing) return existing;
  const created = {
    rotation: null,
    mediaBoxMm: null,
    bleedBoxMm: null,
    trimBoxMm: null,
  };
  pages.set(pageNumber, created);
  return created;
}

function pointBox(values: string[]): MillimeterBox | null {
  const numbers = values.map(Number);
  if (numbers.length !== 4 || numbers.some((value) => !Number.isFinite(value)))
    return null;
  const [x1, y1, x2, y2] = numbers as [number, number, number, number];
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);
  return {
    x: round(left * MM_PER_POINT),
    y: round(top * MM_PER_POINT),
    width: round((right - left) * MM_PER_POINT),
    height: round((bottom - top) * MM_PER_POINT),
  };
}

async function inspectEncryption(path: string, qpdf: string): Promise<boolean> {
  try {
    await run(qpdf, ["--is-encrypted", path], {
      timeout: 20_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function isParseable(path: string, qpdf: string): Promise<boolean> {
  try {
    await runTool(qpdf, ["--check", path]);
    return true;
  } catch {
    return false;
  }
}

async function runTool(tool: string, args: string[]): Promise<string> {
  const result = await run(tool, args, {
    timeout: 20_000,
    maxBuffer: MAX_TOOL_OUTPUT_BYTES,
    windowsHide: true,
  });
  return result.stdout;
}

function emptyMechanicalFacts(
  encrypted: boolean,
  parseable = false,
): PdfMechanicalFacts {
  return {
    pageCount: 0,
    encrypted,
    parseable,
    mediaBoxMm: null,
    bleedBoxMm: null,
    trimBoxMm: null,
    pageBoxes: [],
    fonts: [],
    imageCount: 0,
    imagePpi: [],
    minimumImagePpi: null,
    extractedTextLength: 0,
    textBounds: [],
    hasArabicText: false,
    arabicGlyphCount: 0,
    unmappedGlyphCount: 0,
    printWatermarkCount: 0,
    printWatermarkPages: [],
    cropMarkSegments: [],
    prohibitedFeatureCount: 0,
    externalResourceCount: 0,
    hasDeviceRgb: false,
    hasDeviceCmyk: false,
  };
}

function textPages(value: string): string[] {
  const pages = value.split("\f");
  if (pages.at(-1) === "") pages.pop();
  return pages.length ? pages.slice(0, MAX_INSPECTED_PAGES) : [value];
}

function integer(value: string, pattern: RegExp): number | null {
  const parsed = Number.parseInt(pattern.exec(value)?.[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function minimum(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value !== null);
  return finite.length ? Math.min(...finite) : null;
}

function union(boxes: readonly MillimeterBox[]): MillimeterBox | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return {
    x: round(left),
    y: round(top),
    width: round(right - left),
    height: round(bottom - top),
  };
}

function contains(
  outer: MillimeterBox,
  inner: MillimeterBox,
  tolerance: number,
): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

function normalizedRotation(value: number | null): number | null {
  if (value === null) return null;
  return ((value % 360) + 360) % 360;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

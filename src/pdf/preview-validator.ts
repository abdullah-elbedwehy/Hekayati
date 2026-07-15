import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PreviewPageMapEntry } from "./composition-document.js";

const run = promisify(execFile);
const pointsPerInch = 72;
const millimetresPerInch = 25.4;
const defaultMaximumBytes = 16 * 1024 * 1024;
const maximumReportPages = 32;
const prohibitedPdfTokens = [
  "/JavaScript",
  "/JS",
  "/OpenAction",
  "/AA",
  "/AcroForm",
  "/EmbeddedFiles",
  "/Filespec",
  "/Launch",
  "/URI",
  "/SubmitForm",
  "/RichMedia",
  "/GoToR",
] as const;

export const previewExpectedPdfFontNames = [
  "IBMPlexSansArabic",
  "Lemonada",
] as const;

export type PreviewValidationCode =
  | "PDF_PARSE_FAILED"
  | "PDF_ENCRYPTED"
  | "PAGE_COUNT_MISMATCH"
  | "PAGE_GEOMETRY_MISMATCH"
  | "PAGE_NOT_PORTRAIT"
  | "PAGE_MAP_MISMATCH"
  | "FONT_MISSING"
  | "FONT_NOT_EMBEDDED"
  | "FONT_TOUNICODE_MISSING"
  | "ARABIC_GLYPH_COVERAGE_MISSING"
  | "WATERMARK_MISSING"
  | "FOOTER_MISSING"
  | "IMAGE_PPI_OUT_OF_RANGE"
  | "PDF_SIZE_EXCEEDED"
  | "PROHIBITED_PDF_FEATURE"
  | "REMOTE_REFERENCE_PRESENT"
  | "LOCAL_PATH_PRESENT"
  | "RENDER_EGRESS_DETECTED";

export interface PreviewValidationFinding {
  code: PreviewValidationCode;
  pages: number[];
  measured?: number;
  expected?: number;
}

export interface PreviewPageValidation {
  pageNumber: number;
  mediaBoxMm: { width: number; height: number } | null;
  trimBoxMm: { width: number; height: number } | null;
  rotation: number | null;
  watermarkPresent: boolean;
  footerPresent: boolean;
  pageLabelPresent: boolean;
  minimumImagePpi: number | null;
}

export interface PreviewFontValidation {
  name: string;
  embedded: boolean;
  subset: boolean;
  toUnicode: boolean;
}

export interface PreviewMechanicalValidationReport {
  schemaVersion: 1;
  passed: boolean;
  bytes: number;
  pageCount: number;
  expectedPageCount: number;
  pageResults: PreviewPageValidation[];
  fonts: PreviewFontValidation[];
  imageCount: number;
  egressRequestCount: number;
  findings: PreviewValidationFinding[];
  validatedAt: string;
}

export interface PreviewValidationExpectation {
  pageMap: PreviewPageMapEntry[];
  watermarkText: string;
  footerText?: string;
  composition: {
    widthMm: number;
    heightMm: number;
    toleranceMm: number;
  };
  maximumBytes?: number;
  minimumImagePpi?: number;
  maximumImagePpi?: number;
  expectedFontNames?: string[];
  requiredTextSamples?: string[];
  forbiddenTextSamples?: string[];
  egressRequestCount: number;
  tools?: Partial<PreviewValidationTools>;
}

export interface PreviewValidationTools {
  qpdf: string;
  pdfinfo: string;
  pdffonts: string;
  pdfimages: string;
  pdftotext: string;
}

export class PreviewPdfValidationError extends Error {
  readonly code = "PREVIEW_PDF_VALIDATION_FAILED";

  constructor(readonly report: PreviewMechanicalValidationReport) {
    super("PREVIEW_PDF_VALIDATION_FAILED");
  }
}

interface ValidationFacts {
  pageCount: number;
  encrypted: boolean;
  boxes: Map<number, PageBoxFacts>;
  pageTexts: string[];
  fonts: PreviewFontValidation[];
  images: ImageFacts[];
  activeContent: boolean;
  remoteReference: boolean;
  parseFailed: boolean;
}

interface PageBoxFacts {
  media: { width: number; height: number } | null;
  trim: { width: number; height: number } | null;
  rotation: number | null;
}

interface ImageFacts {
  pageNumber: number;
  xPpi: number;
  yPpi: number;
}

export async function validatePreviewPdf(
  pdfBytes: Uint8Array,
  expectation: PreviewValidationExpectation,
): Promise<PreviewMechanicalValidationReport> {
  assertExpectation(expectation);
  const directory = await mkdtemp(join(tmpdir(), "hekayati-validate-pdf-"));
  const pdfPath = join(directory, "preview.pdf");
  try {
    await writeFile(pdfPath, pdfBytes, { mode: 0o600 });
    const facts = await collectFacts(
      pdfPath,
      expectation.tools,
      expectation.pageMap.length,
    );
    return buildReport(Buffer.byteLength(pdfBytes), facts, expectation);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function assertPreviewPdfValid(
  pdfBytes: Uint8Array,
  expectation: PreviewValidationExpectation,
): Promise<PreviewMechanicalValidationReport> {
  const report = await validatePreviewPdf(pdfBytes, expectation);
  if (!report.passed) throw new PreviewPdfValidationError(report);
  return report;
}

async function collectFacts(
  pdfPath: string,
  overrides: Partial<PreviewValidationTools> | undefined,
  expectedPageCount: number,
): Promise<ValidationFacts> {
  const tools = resolvedTools(overrides);
  const parseFailed = !(await qpdfCheck(tools.qpdf, pdfPath));
  if (parseFailed) return emptyFacts();
  const [info, fonts, images, text, urls, scripts, structure] =
    await Promise.all([
      runTool(tools.pdfinfo, [
        "-box",
        "-f",
        "1",
        "-l",
        String(expectedPageCount),
        pdfPath,
      ]),
      runTool(tools.pdffonts, [pdfPath]),
      runTool(tools.pdfimages, ["-list", pdfPath]),
      runTool(tools.pdftotext, ["-enc", "UTF-8", "-layout", pdfPath, "-"]),
      runTool(tools.pdfinfo, ["-url", pdfPath]),
      runTool(tools.pdfinfo, ["-js", pdfPath]),
      pdfStructure(tools.qpdf, pdfPath),
    ]);
  return parseFacts(info, fonts, images, text, urls, scripts, structure);
}

function parseFacts(
  info: string,
  fonts: string,
  images: string,
  text: string,
  urls: string,
  scripts: string,
  structure: string,
): ValidationFacts {
  const pageTexts = splitPageText(text);
  return {
    pageCount: parseInteger(info, /^Pages:\s+(\d+)/mu) ?? pageTexts.length,
    encrypted: /^Encrypted:\s+yes/imu.test(info),
    boxes: parsePageBoxes(info),
    pageTexts,
    fonts: parseFonts(fonts),
    images: parseImages(images),
    activeContent:
      prohibitedPdfTokens.some((token) => structure.includes(`"${token}"`)) ||
      scripts.trim().length > 0,
    remoteReference: /\b(?:https?|ftp):\/\//iu.test(urls),
    parseFailed: false,
  };
}

function buildReport(
  bytes: number,
  facts: ValidationFacts,
  expectation: PreviewValidationExpectation,
): PreviewMechanicalValidationReport {
  const pageResults = createPageResults(facts, expectation);
  const findings = collectFindings(bytes, facts, expectation, pageResults);
  return {
    schemaVersion: 1,
    passed: findings.length === 0,
    bytes,
    pageCount: facts.pageCount,
    expectedPageCount: expectation.pageMap.length,
    pageResults,
    fonts: facts.fonts,
    imageCount: facts.images.length,
    egressRequestCount: expectation.egressRequestCount,
    findings,
    validatedAt: new Date().toISOString(),
  };
}

function createPageResults(
  facts: ValidationFacts,
  expectation: PreviewValidationExpectation,
): PreviewPageValidation[] {
  return expectation.pageMap.slice(0, maximumReportPages).map((expected) => {
    const box = facts.boxes.get(expected.pageNumber) ?? emptyBox();
    const text = normalizedText(facts.pageTexts[expected.pageNumber - 1] ?? "");
    const pageImages = facts.images.filter(
      (image) => image.pageNumber === expected.pageNumber,
    );
    return {
      pageNumber: expected.pageNumber,
      mediaBoxMm: box.media,
      trimBoxMm: box.trim,
      rotation: box.rotation,
      watermarkPresent:
        includesNormalized(text, expectation.watermarkText) ||
        includesArabicMultiset(text, expectation.watermarkText),
      footerPresent: includesNormalized(
        text,
        expectation.footerText ?? "معاينة — غير مخصصة للطباعة",
      ),
      pageLabelPresent: includesNormalized(text, expected.visibleLabel),
      minimumImagePpi: minimumPpi(pageImages),
    };
  });
}

function collectFindings(
  bytes: number,
  facts: ValidationFacts,
  expectation: PreviewValidationExpectation,
  pages: PreviewPageValidation[],
): PreviewValidationFinding[] {
  const findings: PreviewValidationFinding[] = [];
  basicFindings(findings, bytes, facts, expectation);
  geometryFindings(findings, pages, expectation);
  contentFindings(findings, facts, pages, expectation);
  fontFindings(findings, facts.fonts, expectation.expectedFontNames);
  imageFindings(findings, facts.images, expectation);
  return findings;
}

function basicFindings(
  findings: PreviewValidationFinding[],
  bytes: number,
  facts: ValidationFacts,
  expectation: PreviewValidationExpectation,
): void {
  if (facts.parseFailed) addFinding(findings, "PDF_PARSE_FAILED");
  if (facts.encrypted) addFinding(findings, "PDF_ENCRYPTED");
  if (facts.pageCount !== expectation.pageMap.length)
    addFinding(
      findings,
      "PAGE_COUNT_MISMATCH",
      [],
      facts.pageCount,
      expectation.pageMap.length,
    );
  const maximum = expectation.maximumBytes ?? defaultMaximumBytes;
  if (bytes > maximum)
    addFinding(findings, "PDF_SIZE_EXCEEDED", [], bytes, maximum);
  if (facts.activeContent) addFinding(findings, "PROHIBITED_PDF_FEATURE");
  if (facts.remoteReference) addFinding(findings, "REMOTE_REFERENCE_PRESENT");
  if (expectation.egressRequestCount !== 0)
    addFinding(
      findings,
      "RENDER_EGRESS_DETECTED",
      [],
      expectation.egressRequestCount,
      0,
    );
}

function geometryFindings(
  findings: PreviewValidationFinding[],
  pages: PreviewPageValidation[],
  expectation: PreviewValidationExpectation,
): void {
  const mismatch: number[] = [];
  const landscape: number[] = [];
  for (const page of pages) {
    const boxes = [page.mediaBoxMm, page.trimBoxMm].filter(
      (box): box is { width: number; height: number } => box !== null,
    );
    if (boxes.length < 2 || boxes.some((box) => !matchesBox(box, expectation)))
      mismatch.push(page.pageNumber);
    if (boxes.some((box) => box.width >= box.height) || page.rotation !== 0)
      landscape.push(page.pageNumber);
  }
  if (mismatch.length) addFinding(findings, "PAGE_GEOMETRY_MISMATCH", mismatch);
  if (landscape.length) addFinding(findings, "PAGE_NOT_PORTRAIT", landscape);
}

function contentFindings(
  findings: PreviewValidationFinding[],
  facts: ValidationFacts,
  pages: PreviewPageValidation[],
  expectation: PreviewValidationExpectation,
): void {
  const missingWatermark = pages
    .filter((page) => !page.watermarkPresent)
    .map(pageNumber);
  const missingFooter = pages
    .filter((page) => !page.footerPresent)
    .map(pageNumber);
  const badMap = pages.filter((page) => !page.pageLabelPresent).map(pageNumber);
  if (missingWatermark.length)
    addFinding(findings, "WATERMARK_MISSING", missingWatermark);
  if (missingFooter.length)
    addFinding(findings, "FOOTER_MISSING", missingFooter);
  if (badMap.length) addFinding(findings, "PAGE_MAP_MISMATCH", badMap);
  const allText = normalizedText(facts.pageTexts.join(" "));
  if (
    (expectation.requiredTextSamples ?? []).some(
      (sample) => !includesNormalized(allText, sample),
    )
  )
    addFinding(findings, "ARABIC_GLYPH_COVERAGE_MISSING");
  if (
    (expectation.forbiddenTextSamples ?? []).some((sample) =>
      includesNormalized(allText, sample),
    )
  )
    addFinding(findings, "LOCAL_PATH_PRESENT");
  if (/\bfile:\/\/|\b\/Users\/|\b[A-Z]:\\/u.test(allText))
    addFinding(findings, "LOCAL_PATH_PRESENT");
}

function fontFindings(
  findings: PreviewValidationFinding[],
  fonts: PreviewFontValidation[],
  expected: readonly string[] = previewExpectedPdfFontNames,
): void {
  const missing = expected.filter(
    (expectedName) =>
      !fonts.some((font) =>
        normalizedFont(font.name).includes(normalizedFont(expectedName)),
      ),
  );
  if (missing.length)
    addFinding(findings, "FONT_MISSING", [], missing.length, 0);
  if (fonts.some((font) => !font.embedded))
    addFinding(findings, "FONT_NOT_EMBEDDED");
  if (fonts.some((font) => !font.toUnicode))
    addFinding(findings, "FONT_TOUNICODE_MISSING");
}

function imageFindings(
  findings: PreviewValidationFinding[],
  images: ImageFacts[],
  expectation: PreviewValidationExpectation,
): void {
  const minimum = expectation.minimumImagePpi ?? 140;
  const maximum = expectation.maximumImagePpi ?? 160;
  const pages = images
    .filter((image) =>
      [image.xPpi, image.yPpi].some((ppi) => ppi < minimum || ppi > maximum),
    )
    .map((image) => image.pageNumber);
  if (pages.length)
    addFinding(
      findings,
      "IMAGE_PPI_OUT_OF_RANGE",
      [...new Set(pages)],
      minimum,
      maximum,
    );
}

function matchesBox(
  box: { width: number; height: number },
  expectation: PreviewValidationExpectation,
): boolean {
  const { widthMm, heightMm, toleranceMm } = expectation.composition;
  return (
    Math.abs(box.width - widthMm) <= toleranceMm &&
    Math.abs(box.height - heightMm) <= toleranceMm
  );
}

async function qpdfCheck(command: string, pdfPath: string): Promise<boolean> {
  try {
    const output = await run(command, ["--check", pdfPath], toolOptions());
    return !/WARNING:/u.test(`${output.stdout}${output.stderr}`);
  } catch {
    return false;
  }
}

async function pdfStructure(command: string, pdfPath: string): Promise<string> {
  return await runTool(command, ["--json", "--json-stream-data=none", pdfPath]);
}

async function runTool(command: string, args: string[]): Promise<string> {
  try {
    const output = await run(command, args, toolOptions());
    return output.stdout;
  } catch (error) {
    throw new Error("PREVIEW_VALIDATION_TOOL_FAILED", { cause: error });
  }
}

function toolOptions() {
  return {
    encoding: "utf8" as const,
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  };
}

function parsePageBoxes(output: string): Map<number, PageBoxFacts> {
  const pages = new Map<number, PageBoxFacts>();
  for (const line of output.split(/\r?\n/u)) {
    const rotation = /^Page\s+(\d+)\s+rot:\s+(-?\d+)/u.exec(line);
    if (rotation)
      pageBox(pages, Number(rotation[1])).rotation = Number(rotation[2]);
    const box =
      /^Page\s+(\d+)\s+(MediaBox|TrimBox):\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/u.exec(
        line,
      );
    if (box) assignBox(pages, box);
  }
  return pages;
}

function assignBox(
  pages: Map<number, PageBoxFacts>,
  match: RegExpExecArray,
): void {
  const number = Number(match[1]);
  const width = pointsToMillimetres(Number(match[5]) - Number(match[3]));
  const height = pointsToMillimetres(Number(match[6]) - Number(match[4]));
  const key = match[2] === "MediaBox" ? "media" : "trim";
  pageBox(pages, number)[key] = { width, height };
}

function pageBox(
  pages: Map<number, PageBoxFacts>,
  number: number,
): PageBoxFacts {
  const current = pages.get(number) ?? emptyBox();
  pages.set(number, current);
  return current;
}

function parseFonts(output: string): PreviewFontValidation[] {
  return output.split(/\r?\n/u).flatMap((line) => {
    const match =
      /^(\S+)\s+.+\s+(yes|no)\s+(yes|no)\s+(yes|no)\s+\d+\s+\d+\s*$/u.exec(
        line.trim(),
      );
    if (!match) return [];
    return [
      {
        name: match[1].replace(/^[A-Z]{6}\+/u, "").slice(0, 100),
        embedded: match[2] === "yes",
        subset: match[3] === "yes",
        toUnicode: match[4] === "yes",
      },
    ];
  });
}

function parseImages(output: string): ImageFacts[] {
  return output.split(/\r?\n/u).flatMap((line) => {
    const fields = line.trim().split(/\s+/u);
    if (!/^\d+$/u.test(fields[0] ?? "") || fields[2] !== "image") return [];
    const xPpi = Number(fields.at(-4));
    const yPpi = Number(fields.at(-3));
    if (!Number.isFinite(xPpi) || !Number.isFinite(yPpi)) return [];
    return [{ pageNumber: Number(fields[0]), xPpi, yPpi }];
  });
}

function splitPageText(value: string): string[] {
  const pages = value.split("\f");
  if (pages.at(-1)?.trim() === "") pages.pop();
  return pages;
}

function normalizedText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/gu, "")
    .toLowerCase();
}

function includesNormalized(haystack: string, needle: string): boolean {
  const normalizedHaystack = normalizedText(haystack);
  const normalizedNeedle = normalizedText(needle);
  if (normalizedHaystack.includes(normalizedNeedle)) return true;
  const needleLetters = arabicLetters(normalizedNeedle);
  if (needleLetters.length < 2) return false;
  const haystackLetters = arabicLetters(normalizedHaystack);
  const signature = sortedCodePoints(needleLetters);
  for (
    let index = 0;
    index <= haystackLetters.length - needleLetters.length;
    index += 1
  ) {
    const candidate = haystackLetters.slice(
      index,
      index + needleLetters.length,
    );
    if (sortedCodePoints(candidate) === signature) return true;
  }
  return false;
}

function arabicLetters(value: string): string[] {
  return [...value.normalize("NFD")].filter((character) =>
    /\p{Script=Arabic}/u.test(character),
  );
}

function sortedCodePoints(values: readonly string[]): string {
  return [...values].sort().join("");
}

function includesArabicMultiset(haystack: string, needle: string): boolean {
  const required = counts(arabicLetters(needle));
  if (required.size === 0) return false;
  const available = counts(arabicLetters(haystack));
  return [...required].every(
    ([character, count]) => (available.get(character) ?? 0) >= count,
  );
}

function counts(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function normalizedFont(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function minimumPpi(images: ImageFacts[]): number | null {
  if (images.length === 0) return null;
  return Math.min(...images.flatMap((image) => [image.xPpi, image.yPpi]));
}

function pointsToMillimetres(value: number): number {
  return Math.round((value / pointsPerInch) * millimetresPerInch * 100) / 100;
}

function parseInteger(value: string, pattern: RegExp): number | null {
  const match = pattern.exec(value);
  return match ? Number(match[1]) : null;
}

function pageNumber(page: PreviewPageValidation): number {
  return page.pageNumber;
}

function addFinding(
  findings: PreviewValidationFinding[],
  code: PreviewValidationCode,
  pages: number[] = [],
  measured?: number,
  expected?: number,
): void {
  findings.push({
    code,
    pages: [...new Set(pages)].slice(0, maximumReportPages),
    measured,
    expected,
  });
}

function emptyBox(): PageBoxFacts {
  return { media: null, trim: null, rotation: null };
}

function emptyFacts(): ValidationFacts {
  return {
    pageCount: 0,
    encrypted: false,
    boxes: new Map(),
    pageTexts: [],
    fonts: [],
    images: [],
    activeContent: false,
    remoteReference: false,
    parseFailed: true,
  };
}

function resolvedTools(
  overrides: Partial<PreviewValidationTools> | undefined,
): PreviewValidationTools {
  return {
    qpdf: overrides?.qpdf ?? "qpdf",
    pdfinfo: overrides?.pdfinfo ?? "pdfinfo",
    pdffonts: overrides?.pdffonts ?? "pdffonts",
    pdfimages: overrides?.pdfimages ?? "pdfimages",
    pdftotext: overrides?.pdftotext ?? "pdftotext",
  };
}

function assertExpectation(expectation: PreviewValidationExpectation): void {
  if (
    (expectation.pageMap.length !== 18 && expectation.pageMap.length !== 26) ||
    expectation.pageMap.length > maximumReportPages ||
    !expectation.watermarkText.trim() ||
    expectation.watermarkText.length > 80 ||
    expectation.composition.widthMm <= 0 ||
    expectation.composition.heightMm <= 0 ||
    expectation.composition.toleranceMm < 0 ||
    expectation.composition.toleranceMm > 5 ||
    expectation.egressRequestCount < 0
  )
    throw new Error("PREVIEW_VALIDATION_EXPECTATION_INVALID");
}

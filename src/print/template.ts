import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_TEMPLATE_BYTES = 32 * 1024 * 1024;
const POINTS_PER_INCH = 72;
const MILLIMETRES_PER_INCH = 25.4;
const PROHIBITED_TOKENS = [
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

export interface CoverTemplateTools {
  qpdf: string;
  pdfinfo: string;
}

export interface CoverTemplateInspection {
  bytes: number;
  pageCount: 1;
  pageWidthMm: number;
  pageHeightMm: number;
  encrypted: false;
  prohibitedFeatureCount: 0;
  externalResourceCount: 0;
}

export type CoverTemplateInspectionCode =
  | "COVER_TEMPLATE_SIZE_INVALID"
  | "COVER_TEMPLATE_SIGNATURE_INVALID"
  | "COVER_TEMPLATE_PARSE_FAILED"
  | "COVER_TEMPLATE_ENCRYPTED"
  | "COVER_TEMPLATE_PAGE_COUNT_INVALID"
  | "COVER_TEMPLATE_GEOMETRY_INVALID"
  | "COVER_TEMPLATE_PROHIBITED_FEATURE"
  | "COVER_TEMPLATE_EXTERNAL_RESOURCE";

export class CoverTemplateInspectionError extends Error {
  readonly name = "CoverTemplateInspectionError";
  constructor(
    readonly code: CoverTemplateInspectionCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export async function inspectCoverTemplatePdf(
  bytes: Buffer,
  overrides: Partial<CoverTemplateTools> = {},
): Promise<CoverTemplateInspection> {
  if (bytes.length < 64 || bytes.length > MAX_TEMPLATE_BYTES)
    fail("COVER_TEMPLATE_SIZE_INVALID");
  if (!bytes.subarray(0, 8).toString("ascii").startsWith("%PDF-"))
    fail("COVER_TEMPLATE_SIGNATURE_INVALID");
  const directText = bytes.toString("latin1");
  assertNoExternalReferences(directText);
  assertNoProhibitedFeatures(directText);
  const directory = await mkdtemp(join(tmpdir(), "hekayati-template-"));
  const input = join(directory, "input.pdf");
  try {
    await writeFile(input, bytes, { mode: 0o600 });
    const tools = {
      qpdf: overrides.qpdf ?? "qpdf",
      pdfinfo: overrides.pdfinfo ?? "pdfinfo",
    };
    return await inspectStoredTemplate(input, bytes.length, tools);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function inspectStoredTemplate(
  input: string,
  byteLength: number,
  tools: CoverTemplateTools,
): Promise<CoverTemplateInspection> {
  await qpdfCheck(tools.qpdf, input);
  const encryption = await runBounded(tools.qpdf, ["--show-encryption", input]);
  if (!/File is not encrypted/iu.test(encryption))
    fail("COVER_TEMPLATE_ENCRYPTED");
  const pageCountText = await runBounded(tools.qpdf, ["--show-npages", input]);
  if (Number.parseInt(pageCountText.trim(), 10) !== 1)
    fail("COVER_TEMPLATE_PAGE_COUNT_INVALID");
  const dimensions = parsePageDimensions(
    await runBounded(tools.pdfinfo, ["-box", input]),
  );
  const structure = await runBounded(tools.qpdf, [
    "--json",
    "--json-stream-data=none",
    input,
  ]);
  assertNoProhibitedFeatures(structure);
  assertNoExternalReferences(structure);
  return {
    bytes: byteLength,
    pageCount: 1,
    pageWidthMm: dimensions.widthMm,
    pageHeightMm: dimensions.heightMm,
    encrypted: false,
    prohibitedFeatureCount: 0,
    externalResourceCount: 0,
  };
}

async function qpdfCheck(tool: string, input: string): Promise<void> {
  try {
    await run(tool, ["--check", input], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    throw new CoverTemplateInspectionError("COVER_TEMPLATE_PARSE_FAILED", {
      cause: error,
    });
  }
}

async function runBounded(tool: string, args: string[]): Promise<string> {
  try {
    const result = await run(tool, args, {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    throw new CoverTemplateInspectionError("COVER_TEMPLATE_PARSE_FAILED", {
      cause: error,
    });
  }
}

function parsePageDimensions(info: string): {
  widthMm: number;
  heightMm: number;
} {
  const match = /^Page size:\s+([0-9.]+) x ([0-9.]+) pts/mu.exec(info);
  if (!match) fail("COVER_TEMPLATE_GEOMETRY_INVALID");
  const widthPt = Number(match[1]);
  const heightPt = Number(match[2]);
  if (
    !Number.isFinite(widthPt) ||
    !Number.isFinite(heightPt) ||
    widthPt <= 0 ||
    heightPt <= 0 ||
    widthPt > 20_000 ||
    heightPt > 20_000
  )
    fail("COVER_TEMPLATE_GEOMETRY_INVALID");
  return {
    widthMm: roundMm((widthPt / POINTS_PER_INCH) * MILLIMETRES_PER_INCH),
    heightMm: roundMm((heightPt / POINTS_PER_INCH) * MILLIMETRES_PER_INCH),
  };
}

function assertNoProhibitedFeatures(value: string): void {
  if (PROHIBITED_TOKENS.some((token) => hasPdfName(value, token)))
    fail("COVER_TEMPLATE_PROHIBITED_FEATURE");
}

function hasPdfName(value: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}(?=[\\s<>\\[\\]()/]|$)`, "u").test(value);
}

function assertNoExternalReferences(value: string): void {
  if (
    /\b(?:https?|ftp|file):\/\//iu.test(value) ||
    /(?:\/Users\/|[A-Za-z]:\\)/u.test(value)
  )
    fail("COVER_TEMPLATE_EXTERNAL_RESOURCE");
}

function roundMm(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function fail(code: CoverTemplateInspectionCode): never {
  throw new CoverTemplateInspectionError(code);
}

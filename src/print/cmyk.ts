import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { requireCmykIccProfile } from "./icc.js";

const run = promisify(execFile);

export interface CmykTools {
  ghostscript: string;
  qpdf: string;
  pdfinfo: string;
  pdffonts: string;
}

export interface CmykConversionResult {
  pdfBytes: Buffer;
  iccChecksum: string;
  outputConditionIdentifier: string;
  embeddedIccChecksum: string;
  embeddedIccBytes: number;
  imageCount: number;
  contentStreamCount: number;
  pageCount: number;
  cmykOnly: true;
  outputIntentMatches: true;
  geometryPreserved: true;
  fontsPreserved: true;
  converterVersion: string;
}

export type CmykConversionErrorCode =
  | "CMYK_ICC_INVALID"
  | "CMYK_TOOL_UNAVAILABLE"
  | "CMYK_CONVERSION_FAILED"
  | "CMYK_CONVERSION_TIMEOUT"
  | "CMYK_OUTPUT_INVALID"
  | "CMYK_OUTPUT_INTENT_INVALID"
  | "CMYK_COLOR_SPACE_INVALID"
  | "CMYK_GEOMETRY_CHANGED"
  | "CMYK_FONT_CHANGED";

export class CmykConversionError extends Error {
  readonly name = "CmykConversionError";
  constructor(readonly code: CmykConversionErrorCode) {
    super(code);
  }
}

interface ConversionPaths {
  rgb: string;
  icc: string;
  definition: string;
  candidate: string;
}

interface ExecutionBudget {
  signal?: AbortSignal;
  deadlineAt: number;
}

interface QpdfDocument {
  qpdf?: unknown;
  pages?: unknown;
}

interface QpdfPage {
  contents: unknown[];
  images: Array<{ colorspace?: unknown }>;
}

export async function convertPdfToCmyk(input: {
  pdfBytes: Buffer;
  iccBytes: Buffer;
  expectedIccChecksum: string;
  tools?: Partial<CmykTools>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CmykConversionResult> {
  const icc = validatedIcc(input.iccBytes, input.expectedIccChecksum);
  const tools = resolvedTools(input.tools);
  const budget = executionBudget(input.signal, input.timeoutMs);
  assertBudget(budget);
  const directory = await mkdtemp(join(tmpdir(), "hekayati-cmyk-"));
  const paths = conversionPaths(directory);
  try {
    await writeConversionInputs(
      paths,
      input.pdfBytes,
      input.iccBytes,
      icc.checksum,
    );
    const baseline = await conversionBaseline(paths.rgb, tools, budget);
    await convert(
      tools.ghostscript,
      paths.rgb,
      paths.candidate,
      paths.icc,
      paths.definition,
      budget,
    );
    const result = await validateCandidate({
      candidatePath: paths.candidate,
      iccChecksum: icc.checksum,
      tools,
      budget,
      ...baseline,
    });
    return { ...result, pdfBytes: await readFile(paths.candidate) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function validatedIcc(bytes: Buffer, expectedChecksum: string) {
  let icc: ReturnType<typeof requireCmykIccProfile>;
  try {
    icc = requireCmykIccProfile(bytes);
  } catch {
    fail("CMYK_ICC_INVALID");
  }
  if (icc.checksum !== expectedChecksum) fail("CMYK_ICC_INVALID");
  return icc;
}

function conversionPaths(directory: string): ConversionPaths {
  return {
    rgb: join(directory, "input.pdf"),
    icc: join(directory, "profile.icc"),
    definition: join(directory, "output-intent.ps"),
    candidate: join(directory, "candidate.pdf"),
  };
}

async function writeConversionInputs(
  paths: ConversionPaths,
  pdfBytes: Buffer,
  iccBytes: Buffer,
  checksum: string,
): Promise<void> {
  await Promise.all([
    writeFile(paths.rgb, pdfBytes, { mode: 0o600 }),
    writeFile(paths.icc, iccBytes, { mode: 0o600 }),
    writeFile(paths.definition, outputIntentDefinition(paths.icc, checksum), {
      mode: 0o600,
    }),
  ]);
  await Promise.all(
    [paths.rgb, paths.icc, paths.definition].map((path) => chmod(path, 0o600)),
  );
}

async function conversionBaseline(
  rgbPath: string,
  tools: CmykTools,
  budget: ExecutionBudget,
) {
  const [beforeInfo, beforeFonts, converterVersion] = await Promise.all([
    requiredTool(tools.pdfinfo, ["-box", rgbPath], budget),
    requiredTool(tools.pdffonts, [rgbPath], budget),
    requiredTool(tools.ghostscript, ["--version"], budget),
  ]);
  return {
    beforeInfo,
    beforeFonts,
    converterVersion: converterVersion.trim().slice(0, 80),
  };
}

async function convert(
  ghostscript: string,
  input: string,
  output: string,
  icc: string,
  definition: string,
  budget: ExecutionBudget,
): Promise<void> {
  try {
    await run(
      ghostscript,
      [
        "-q",
        "-dBATCH",
        "-dNOPAUSE",
        "-dSAFER",
        `--permit-file-read=${icc}`,
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.6",
        "-dPDFSETTINGS=/prepress",
        "-dEmbedAllFonts=true",
        "-dSubsetFonts=true",
        "-dAutoRotatePages=/None",
        "-sColorConversionStrategy=CMYK",
        "-dProcessColorModel=/DeviceCMYK",
        `-sOutputICCProfile=${icc}`,
        `-sOutputFile=${output}`,
        definition,
        input,
      ],
      options(budgetTimeout(budget, 120_000), 4 * 1024 * 1024, budget.signal),
    );
  } catch (error) {
    if (error instanceof CmykConversionError) throw error;
    if (toolMissing(error)) fail("CMYK_TOOL_UNAVAILABLE");
    if (timedOut(error, budget.signal)) fail("CMYK_CONVERSION_TIMEOUT");
    fail("CMYK_CONVERSION_FAILED");
  }
}

async function validateCandidate(input: {
  candidatePath: string;
  iccChecksum: string;
  tools: CmykTools;
  beforeInfo: string;
  beforeFonts: string;
  converterVersion: string;
  budget: ExecutionBudget;
}): Promise<Omit<CmykConversionResult, "pdfBytes">> {
  try {
    const inspected = await inspectCandidateFiles(input);
    assertGeometryPreserved(input.beforeInfo, inspected.afterInfo);
    assertFontsPreserved(input.beforeFonts, inspected.afterFonts);
    const inspection = await inspectCmykPdf(
      input.candidatePath,
      inspected.json,
      input.iccChecksum,
      input.tools.qpdf,
      input.budget,
    );
    return {
      iccChecksum: input.iccChecksum,
      ...inspection,
      pageCount: geometryFacts(inspected.afterInfo).pageCount,
      cmykOnly: true,
      outputIntentMatches: true,
      geometryPreserved: true,
      fontsPreserved: true,
      converterVersion: input.converterVersion,
    };
  } catch (error) {
    if (error instanceof CmykConversionError) throw error;
    if (toolMissing(error)) fail("CMYK_TOOL_UNAVAILABLE");
    if (timedOut(error, input.budget.signal)) fail("CMYK_CONVERSION_TIMEOUT");
    fail("CMYK_OUTPUT_INVALID");
  }
}

async function inspectCandidateFiles(input: {
  candidatePath: string;
  tools: CmykTools;
  budget: ExecutionBudget;
}): Promise<{ afterInfo: string; afterFonts: string; json: string }> {
  await requiredTool(
    input.tools.qpdf,
    ["--check", input.candidatePath],
    input.budget,
  );
  const [afterInfo, afterFonts, json] = await Promise.all([
    requiredTool(
      input.tools.pdfinfo,
      ["-box", input.candidatePath],
      input.budget,
    ),
    requiredTool(input.tools.pdffonts, [input.candidatePath], input.budget),
    requiredTool(
      input.tools.qpdf,
      ["--json", "--json-stream-data=inline", input.candidatePath],
      input.budget,
      64 * 1024 * 1024,
    ),
  ]);
  return { afterInfo, afterFonts, json };
}

function assertGeometryPreserved(before: string, after: string): void {
  if (
    JSON.stringify(geometryFacts(before)) !==
    JSON.stringify(geometryFacts(after))
  )
    fail("CMYK_GEOMETRY_CHANGED");
}

function assertFontsPreserved(before: string, after: string): void {
  const beforeFacts = fontFacts(before);
  const afterFacts = fontFacts(after);
  if (
    beforeFacts.length === 0 ||
    JSON.stringify(beforeFacts) !== JSON.stringify(afterFacts) ||
    afterFacts.some((font) => !font.embedded || !font.toUnicode)
  )
    fail("CMYK_FONT_CHANGED");
}

async function inspectCmykPdf(
  pdf: string,
  qpdfJson: string,
  expectedIccChecksum: string,
  qpdf: string,
  budget: ExecutionBudget,
): Promise<{
  outputConditionIdentifier: string;
  embeddedIccChecksum: string;
  embeddedIccBytes: number;
  imageCount: number;
  contentStreamCount: number;
}> {
  const document = parseQpdfDocument(qpdfJson);
  const table = objectTable(document);
  const outputIntent = inspectOutputIntent(table, expectedIccChecksum);
  const pages = requireQpdfPages(document);
  const images = pages.flatMap((page) => page.images);
  assertCmykImages(images);
  assertCmykColorResources(table);
  const contents = [
    ...pages.flatMap((page) => page.contents),
    ...nestedPaintStreams(table),
  ];
  await assertCmykContentStreams(contents, pdf, qpdf, budget);
  return {
    ...outputIntent,
    imageCount: images.length,
    contentStreamCount: contents.length,
  };
}

function inspectOutputIntent(
  table: Record<string, unknown>,
  expectedIccChecksum: string,
) {
  const catalog = Object.values(table)
    .filter(record)
    .find((entry) => dictionary(entry)["/Type"] === "/Catalog");
  if (!catalog) fail("CMYK_OUTPUT_INTENT_INVALID");
  const intents = dictionary(catalog)["/OutputIntents"];
  if (!unknownArray(intents) || intents.length !== 1)
    fail("CMYK_OUTPUT_INTENT_INVALID");
  const intent = dictionary(reference(table, intents[0]));
  const expectedIdentifier = `u:hekayati-profile-${expectedIccChecksum}`;
  if (
    intent["/Type"] !== "/OutputIntent" ||
    intent["/S"] !== "/GTS_PDFX" ||
    intent["/OutputConditionIdentifier"] !== expectedIdentifier
  )
    fail("CMYK_OUTPUT_INTENT_INVALID");
  const stream = reference(table, intent["/DestOutputProfile"]).stream;
  if (!record(stream) || !record(stream.dict) || stream.dict["/N"] !== 4)
    fail("CMYK_OUTPUT_INTENT_INVALID");
  if (typeof stream.data !== "string") fail("CMYK_OUTPUT_INTENT_INVALID");
  const embedded = Buffer.from(stream.data, "base64");
  const embeddedIccChecksum = sha256(embedded);
  if (embeddedIccChecksum !== expectedIccChecksum)
    fail("CMYK_OUTPUT_INTENT_INVALID");
  return {
    outputConditionIdentifier: expectedIdentifier.slice(2),
    embeddedIccChecksum,
    embeddedIccBytes: embedded.length,
  };
}

async function assertCmykContentStreams(
  contents: unknown[],
  pdf: string,
  qpdf: string,
  budget: ExecutionBudget,
): Promise<void> {
  if (contents.length === 0) fail("CMYK_COLOR_SPACE_INVALID");
  let sawCmyk = false;
  for (const content of contents) {
    if (typeof content !== "string" || !/^\d+ \d+ R$/u.test(content))
      fail("CMYK_COLOR_SPACE_INVALID");
    const number = content.split(" ")[0];
    const streamText = await requiredTool(
      qpdf,
      [`--show-object=${number}`, "--filtered-stream-data", pdf],
      budget,
    );
    if (
      /(^|\s)(?:rg|RG)(?=\s|$)/mu.test(streamText) ||
      /\/(?:CS|ColorSpace)\s+\/(?:RGB|DeviceRGB|CalRGB)(?=\s|$)/mu.test(
        streamText,
      )
    )
      fail("CMYK_COLOR_SPACE_INVALID");
    sawCmyk ||= /(^|\s)(?:k|K)(?=\s|$)/mu.test(streamText);
  }
  if (!sawCmyk) fail("CMYK_COLOR_SPACE_INVALID");
}

function assertCmykImages(images: QpdfPage["images"]): void {
  if (
    images.length === 0 ||
    images.some((image) => image.colorspace !== "/DeviceCMYK")
  )
    fail("CMYK_COLOR_SPACE_INVALID");
}

function assertCmykColorResources(table: Record<string, unknown>): void {
  walkColorValue(table, table, new Set());
}

function walkColorValue(
  value: unknown,
  table: Record<string, unknown>,
  seenReferences: Set<string>,
): void {
  if (typeof value === "string") {
    if (["/DeviceRGB", "/CalRGB", "/Lab"].includes(value))
      fail("CMYK_COLOR_SPACE_INVALID");
    return;
  }
  if (unknownArray(value)) {
    if (value[0] === "/ICCBased") {
      assertFourChannelIccReference(value[1], table, seenReferences);
      return;
    }
    if (value[0] === "/Indexed") {
      walkColorValue(value[1], table, seenReferences);
      return;
    }
    for (const item of value) walkColorValue(item, table, seenReferences);
    return;
  }
  if (!record(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "data") continue;
    walkColorValue(nested, table, seenReferences);
  }
}

function assertFourChannelIccReference(
  value: unknown,
  table: Record<string, unknown>,
  seenReferences: Set<string>,
): void {
  if (typeof value !== "string" || !/^\d+ \d+ R$/u.test(value))
    fail("CMYK_COLOR_SPACE_INVALID");
  if (seenReferences.has(value)) return;
  seenReferences.add(value);
  const target = table[`obj:${value}`];
  if (
    !record(target) ||
    !record(target.stream) ||
    !record(target.stream.dict) ||
    target.stream.dict["/N"] !== 4
  )
    fail("CMYK_COLOR_SPACE_INVALID");
}

function nestedPaintStreams(table: Record<string, unknown>): string[] {
  return Object.entries(table).flatMap(([key, value]) => {
    if (!key.startsWith("obj:") || !record(value) || !record(value.stream))
      return [];
    const dict = value.stream.dict;
    if (
      !record(dict) ||
      !["/Form", "/Pattern"].includes(String(dict["/Subtype"]))
    )
      return [];
    const reference = key.slice(4);
    return /^\d+ \d+ R$/u.test(reference) ? [reference] : [];
  });
}

function parseQpdfDocument(json: string): QpdfDocument {
  const parsed: unknown = JSON.parse(json);
  if (!record(parsed)) fail("CMYK_OUTPUT_INVALID");
  return { qpdf: parsed.qpdf, pages: parsed.pages };
}

function requireQpdfPages(document: QpdfDocument): QpdfPage[] {
  if (!unknownArray(document.pages) || document.pages.length === 0)
    fail("CMYK_COLOR_SPACE_INVALID");
  return document.pages.map((page) => {
    if (!record(page)) fail("CMYK_COLOR_SPACE_INVALID");
    const contents = unknownArray(page.contents) ? page.contents : [];
    const rawImages = unknownArray(page.images) ? page.images : [];
    const images = rawImages.map((image) => {
      if (!record(image)) fail("CMYK_COLOR_SPACE_INVALID");
      return { colorspace: image.colorspace };
    });
    return { contents, images };
  });
}

function outputIntentDefinition(path: string, checksum: string): string {
  const profile = escapePostScript(path);
  return `%!\n/ICCProfile (${profile}) def\n[/_objdef {icc_PDFX} /type /stream /OBJ pdfmark\n[{icc_PDFX} << /N 4 >> /PUT pdfmark\n[{icc_PDFX} ICCProfile (r) file /PUT pdfmark\n[/_objdef {OutputIntent_PDFX} /type /dict /OBJ pdfmark\n[{OutputIntent_PDFX} << /Type /OutputIntent /S /GTS_PDFX /OutputCondition (Hekayati printer conversion) /Info (Hekayati local printer profile) /OutputConditionIdentifier (hekayati-profile-${checksum}) /RegistryName (http://www.color.org) /DestOutputProfile {icc_PDFX} >> /PUT pdfmark\n[{Catalog} << /OutputIntents [{OutputIntent_PDFX}] >> /PUT pdfmark\n`;
}

function geometryFacts(output: string) {
  const pageCount = number(output, /^Pages:\s+(\d+)/mu);
  const boxes = ["MediaBox", "CropBox", "BleedBox", "TrimBox", "ArtBox"].map(
    (name) => [name, boxLines(output, name)] as const,
  );
  if (pageCount === null) fail("CMYK_OUTPUT_INVALID");
  return { pageCount, boxes };
}

function boxLines(output: string, name: string): string[] {
  const pattern = new RegExp(`^(?:Page\\s+\\d+\\s+)?${name}:\\s+(.+)$`, "gmu");
  return [...output.matchAll(pattern)].map((match) => match[1].trim());
}

function fontFacts(output: string) {
  return output.split(/\r?\n/u).flatMap((line) => {
    const match =
      /^(\S+)\s+.+\s+(yes|no)\s+(yes|no)\s+(yes|no)\s+\d+\s+\d+\s*$/u.exec(
        line.trim(),
      );
    if (!match) return [];
    return [
      {
        name: match[1].replace(/^[A-Z]{6}\+/u, ""),
        embedded: match[2] === "yes",
        subset: match[3] === "yes",
        toUnicode: match[4] === "yes",
      },
    ];
  });
}

function objectTable(value: unknown): Record<string, unknown> {
  if (!record(value) || !unknownArray(value.qpdf))
    fail("CMYK_OUTPUT_INTENT_INVALID");
  const table = value.qpdf.find(
    (entry: unknown) =>
      record(entry) && Object.keys(entry).some((key) => key.startsWith("obj:")),
  );
  if (!record(table)) fail("CMYK_OUTPUT_INTENT_INVALID");
  return table;
}

function reference(table: Record<string, unknown>, value: unknown) {
  if (typeof value !== "string" || !/^\d+ \d+ R$/u.test(value))
    fail("CMYK_OUTPUT_INTENT_INVALID");
  const target = table[`obj:${value}`];
  if (!record(target)) fail("CMYK_OUTPUT_INTENT_INVALID");
  return target;
}

function dictionary(value: Record<string, unknown>): Record<string, unknown> {
  if (!record(value.value)) fail("CMYK_OUTPUT_INTENT_INVALID");
  return value.value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

async function requiredTool(
  tool: string,
  args: string[],
  budget: ExecutionBudget,
  maxBuffer = 8 * 1024 * 1024,
): Promise<string> {
  try {
    const result = await run(
      tool,
      args,
      options(budgetTimeout(budget, 30_000), maxBuffer, budget.signal),
    );
    return result.stdout;
  } catch (error) {
    if (error instanceof CmykConversionError) throw error;
    if (toolMissing(error)) fail("CMYK_TOOL_UNAVAILABLE");
    if (timedOut(error, budget.signal)) fail("CMYK_CONVERSION_TIMEOUT");
    fail("CMYK_OUTPUT_INVALID");
  }
}

function resolvedTools(overrides: Partial<CmykTools> | undefined): CmykTools {
  return {
    ghostscript: overrides?.ghostscript ?? "gs",
    qpdf: overrides?.qpdf ?? "qpdf",
    pdfinfo: overrides?.pdfinfo ?? "pdfinfo",
    pdffonts: overrides?.pdffonts ?? "pdffonts",
  };
}

function options(timeout: number, maxBuffer: number, signal?: AbortSignal) {
  return {
    encoding: "utf8" as const,
    timeout,
    maxBuffer,
    windowsHide: true,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    signal,
  };
}

function executionBudget(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): ExecutionBudget {
  const requested = Math.min(Math.max(timeoutMs ?? 120_000, 500), 600_000);
  return {
    signal,
    deadlineAt: Date.now() + Math.max(250, requested - 2_500),
  };
}

function assertBudget(budget: ExecutionBudget): void {
  if (budget.signal?.aborted || Date.now() >= budget.deadlineAt)
    fail("CMYK_CONVERSION_TIMEOUT");
}

function budgetTimeout(budget: ExecutionBudget, ceiling: number): number {
  assertBudget(budget);
  return Math.max(1, Math.min(ceiling, budget.deadlineAt - Date.now()));
}

function timedOut(error: unknown, signal: AbortSignal | undefined): boolean {
  return Boolean(
    signal?.aborted ||
    (error instanceof Error &&
      (error.name === "AbortError" ||
        ("code" in error &&
          ["ABORT_ERR", "ETIMEDOUT"].includes(String(error.code))) ||
        ("killed" in error && error.killed === true))),
  );
}

function escapePostScript(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function number(value: string, pattern: RegExp): number | null {
  const parsed = Number.parseInt(pattern.exec(value)?.[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toolMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function fail(code: CmykConversionErrorCode): never {
  throw new CmykConversionError(code);
}

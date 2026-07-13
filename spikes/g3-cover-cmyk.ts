import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const spikeRoot = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(spikeRoot, "fixtures");
const artifactRoot = resolve(spikeRoot, ".local-artifacts", "g3");
const defaultIccCandidates = [
  "/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc",
  "/Library/ColorSync/Profiles/Generic CMYK Profile.icc",
];

type CommandResult = { status: number; stdout: string; stderr: string };
type Geometry = { left: number; top: number; width: number; height: number };
type CmykInspection = {
  outputConditionIdentifier: string;
  embeddedIccSha256: string;
  embeddedIccBytes: number;
  imageCount: number;
  contentStreams: number;
};

function cliOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function numberOption(name: string, envName: string, fallback: number): number {
  const raw = cliOption(name) ?? process.env[envName];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function requireFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fontDataUri(path: string): string {
  return `data:font/ttf;base64,${readFileSync(path).toString("base64")}`;
}

function run(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${command} unavailable: ${result.error.message}`);
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runRequired(command: string, args: string[]): CommandResult {
  const result = run(command, args);
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim().slice(0, 1200);
    throw new Error(`${command} failed with status ${result.status}: ${detail}`);
  }
  return result;
}

function writeCommandEvidence(name: string, result: CommandResult): void {
  writeFileSync(
    resolve(artifactRoot, name),
    [`exit=${result.status}`, "--- stdout ---", result.stdout, "--- stderr ---", result.stderr].join("\n"),
  );
}

function parsePdfInfo(output: string): { pages: number; widthPt: number; heightPt: number } {
  const pages = output.match(/^Pages:\s+(\d+)/m);
  const size = output.match(/^Page size:\s+([\d.]+) x ([\d.]+) pts/m);
  if (!pages || !size) throw new Error("pdfinfo did not report page count and point dimensions");
  return { pages: Number(pages[1]), widthPt: Number(size[1]), heightPt: Number(size[2]) };
}

function assertPdfGeometry(
  actual: { pages: number; widthPt: number; heightPt: number },
  widthMm: number,
  heightMm: number,
): { widthPt: number; heightPt: number; tolerancePt: number } {
  const expected = { widthPt: widthMm * 72 / 25.4, heightPt: heightMm * 72 / 25.4, tolerancePt: 0.75 };
  if (actual.pages !== 1) throw new Error(`Expected a one-page cover spread; received ${actual.pages} pages`);
  if (
    Math.abs(actual.widthPt - expected.widthPt) > expected.tolerancePt ||
    Math.abs(actual.heightPt - expected.heightPt) > expected.tolerancePt
  ) {
    throw new Error(
      `Cover is ${actual.widthPt} x ${actual.heightPt} pt; expected ${expected.widthPt} x ${expected.heightPt} pt`,
    );
  }
  return expected;
}

function assertEmbeddedFonts(output: string): number {
  const rows = output
    .split("\n")
    .filter((line) => /^\S/.test(line) && !line.startsWith("name") && !line.startsWith("---"));
  if (rows.length < 1) throw new Error("Cover PDF has no reported embedded font");
  for (const row of rows) {
    const flags = row.match(/\s+(yes|no)\s+(yes|no)\s+(yes|no)\s+\d+\s+\d+\s*$/i);
    if (!flags || flags[1].toLowerCase() !== "yes" || flags[2].toLowerCase() !== "yes") {
      throw new Error(`Font is not both embedded and subsetted: ${row}`);
    }
  }
  return rows.length;
}

function assertCmykCoverage(output: string): { c: number; m: number; y: number; k: number } {
  const matches = [...output.matchAll(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+CMYK/gi)];
  const match = matches.at(-1);
  if (!match) throw new Error("Ghostscript inkcov did not report CMYK coverage");
  const coverage = { c: Number(match[1]), m: Number(match[2]), y: Number(match[3]), k: Number(match[4]) };
  if (Object.values(coverage).some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error(`Expected non-zero C, M, Y, and K coverage; received ${JSON.stringify(coverage)}`);
  }
  return coverage;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function qpdfObjectTable(document: unknown): Record<string, unknown> {
  if (typeof document !== "object" || document === null) throw new Error("qpdf JSON is not an object");
  const entries = (document as { qpdf?: unknown }).qpdf;
  if (!Array.isArray(entries)) throw new Error("qpdf JSON has no object table");
  const table = entries.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && Object.keys(entry).some((key) => key.startsWith("obj:")),
  );
  if (!table) throw new Error("qpdf JSON object table is empty");
  return table;
}

function referencedObject(table: Record<string, unknown>, reference: unknown, label: string): Record<string, unknown> {
  if (typeof reference !== "string" || !/^\d+ \d+ R$/.test(reference)) {
    throw new Error(`${label} is not an indirect PDF reference`);
  }
  const object = table[`obj:${reference}`];
  if (typeof object !== "object" || object === null) throw new Error(`${label} object ${reference} is missing`);
  return object as Record<string, unknown>;
}

function objectValue(object: Record<string, unknown>, label: string): Record<string, unknown> {
  const value = object.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a PDF dictionary`);
  }
  return value as Record<string, unknown>;
}

function assertCmykPdf(
  pdf: string,
  qpdfJson: string,
  expectedIccSha256: string,
): CmykInspection {
  const document = JSON.parse(qpdfJson) as {
    pages?: Array<{ contents?: unknown[]; images?: Array<{ colorspace?: unknown }> }>;
  };
  const table = qpdfObjectTable(document);
  const catalog = Object.values(table)
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    .find((value) => {
      const dictionary = value.value;
      return typeof dictionary === "object" && dictionary !== null && (dictionary as Record<string, unknown>)["/Type"] === "/Catalog";
    });
  if (!catalog) throw new Error("CMYK PDF has no catalog dictionary");
  const catalogValue = objectValue(catalog, "catalog");
  const outputIntents = catalogValue["/OutputIntents"];
  if (!Array.isArray(outputIntents) || outputIntents.length !== 1) {
    throw new Error("CMYK PDF must contain exactly one output intent");
  }
  const intent = objectValue(referencedObject(table, outputIntents[0], "output intent"), "output intent");
  if (intent["/Type"] !== "/OutputIntent" || intent["/S"] !== "/GTS_PDFX") {
    throw new Error("CMYK PDF output intent is not a PDF/X output intent");
  }
  const expectedIdentifier = `u:hekayati-synthetic-${expectedIccSha256}`;
  if (intent["/OutputConditionIdentifier"] !== expectedIdentifier) {
    throw new Error("CMYK PDF output intent is not bound to the selected ICC hash");
  }
  const profile = referencedObject(table, intent["/DestOutputProfile"], "destination ICC profile");
  const stream = profile.stream;
  if (typeof stream !== "object" || stream === null) throw new Error("Destination ICC profile is not embedded");
  const streamRecord = stream as { dict?: unknown; data?: unknown };
  if (
    typeof streamRecord.dict !== "object" ||
    streamRecord.dict === null ||
    (streamRecord.dict as Record<string, unknown>)["/N"] !== 4 ||
    typeof streamRecord.data !== "string"
  ) {
    throw new Error("Embedded destination profile is missing four-channel stream data");
  }
  const embeddedIcc = Buffer.from(streamRecord.data, "base64");
  const embeddedIccSha256 = sha256Bytes(embeddedIcc);
  if (embeddedIccSha256 !== expectedIccSha256) {
    throw new Error(`Embedded ICC hash ${embeddedIccSha256} does not match selected profile ${expectedIccSha256}`);
  }

  if (!Array.isArray(document.pages) || document.pages.length !== 1) {
    throw new Error("qpdf did not report exactly one CMYK cover page");
  }
  const images = document.pages.flatMap((page) => page.images ?? []);
  if (images.length === 0 || images.some((image) => image.colorspace !== "/DeviceCMYK")) {
    throw new Error("Every cover image must be encoded in DeviceCMYK");
  }
  const serialized = JSON.stringify(document);
  if (serialized.includes("/DeviceRGB")) throw new Error("CMYK PDF still contains a DeviceRGB resource");

  const contentReferences = document.pages.flatMap((page) => page.contents ?? []);
  if (contentReferences.length === 0) throw new Error("CMYK PDF has no page content stream");
  let sawCmykOperator = false;
  for (const reference of contentReferences) {
    if (typeof reference !== "string" || !/^\d+ \d+ R$/.test(reference)) {
      throw new Error("CMYK page content is not an indirect stream");
    }
    const objectNumber = reference.split(" ")[0];
    const content = runRequired("qpdf", [`--show-object=${objectNumber}`, "--filtered-stream-data", pdf]).stdout;
    if (/(^|\s)(?:rg|RG)(?=\s|$)/m.test(content)) {
      throw new Error(`CMYK page content ${reference} contains an RGB color operator`);
    }
    sawCmykOperator ||= /(^|\s)(?:k|K)(?=\s|$)/m.test(content);
  }
  if (!sawCmykOperator) throw new Error("CMYK page content has no CMYK color operator");

  return {
    outputConditionIdentifier: expectedIdentifier.slice(2),
    embeddedIccSha256,
    embeddedIccBytes: embeddedIcc.byteLength,
    imageCount: images.length,
    contentStreams: contentReferences.length,
  };
}

function assertClose(actual: number, expected: number, label: string, tolerance = 0.08): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label} measured ${actual} mm; expected ${expected} mm (tolerance ${tolerance} mm)`);
  }
}

function gsConversionArgs(input: string, output: string, icc: string, pdfxDefinition: string): string[] {
  return [
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
    pdfxDefinition,
    input,
  ];
}

function escapePostScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function relativeArtifact(path: string): string {
  return relative(spikeRoot, path);
}

async function main(): Promise<void> {
  mkdirSync(artifactRoot, { recursive: true });

  const trimWidthMm = numberOption("--trim-width-mm", "G3_TRIM_WIDTH_MM", 210);
  const trimHeightMm = numberOption("--trim-height-mm", "G3_TRIM_HEIGHT_MM", 297);
  const bleedMm = numberOption("--bleed-mm", "G3_BLEED_MM", 3);
  const spineWidthMm = numberOption("--spine-width-mm", "G3_SPINE_WIDTH_MM", 10);
  const spreadWidthMm = trimWidthMm * 2 + spineWidthMm + bleedMm * 2;
  const spreadHeightMm = trimHeightMm + bleedMm * 2;
  const bodyFont = resolve(
    cliOption("--body-font") ??
      process.env.G3_BODY_FONT ??
      resolve(fixtureRoot, "fonts", "IBMPlexSansArabic-Regular.ttf"),
  );
  const requestedIcc = cliOption("--icc") ?? process.env.G3_CMYK_ICC;
  const icc = resolve(requestedIcc ?? defaultIccCandidates.find(existsSync) ?? defaultIccCandidates[0]);
  const htmlFixture = resolve(fixtureRoot, "g3-cover-spread.html");
  const pdfxFixture = resolve(fixtureRoot, "g3-pdfx-def.ps");

  requireFile(bodyFont, "Arabic body font");
  requireFile(icc, "Generic CMYK ICC profile");
  requireFile(htmlFixture, "Cover spread fixture");
  requireFile(pdfxFixture, "PDF/X output-intent fixture");

  const html = readFileSync(htmlFixture, "utf8")
    .replaceAll("{{BODY_FONT_DATA_URI}}", fontDataUri(bodyFont))
    .replaceAll("{{TRIM_WIDTH_MM}}", String(trimWidthMm))
    .replaceAll("{{TRIM_HEIGHT_MM}}", String(trimHeightMm))
    .replaceAll("{{BLEED_MM}}", String(bleedMm))
    .replaceAll("{{SPINE_WIDTH_MM}}", String(spineWidthMm))
    .replaceAll("{{SPREAD_WIDTH_MM}}", String(spreadWidthMm))
    .replaceAll("{{SPREAD_HEIGHT_MM}}", String(spreadHeightMm));

  const resolvedHtml = resolve(artifactRoot, "cover-spread.resolved.html");
  const rgbPdf = resolve(artifactRoot, "cover-spread-rgb.pdf");
  const cmykPdf = resolve(artifactRoot, "cover-spread-cmyk.pdf");
  const cmykTempPdf = resolve(artifactRoot, ".cover-spread-cmyk.tmp.pdf");
  const resolvedPdfxDefinition = resolve(artifactRoot, "cover-pdfx-def.resolved.ps");
  writeFileSync(resolvedHtml, html);
  const iccSha256 = sha256(icc);
  writeFileSync(
    resolvedPdfxDefinition,
    readFileSync(pdfxFixture, "utf8")
      .replaceAll("{{ICC_PATH}}", escapePostScriptString(icc))
      .replaceAll("{{ICC_SHA256}}", iccSha256),
  );

  const externalRequests = new Set<string>();
  let chromiumVersion = "unknown";
  let browserFontLoaded = false;
  let domGeometry: Record<string, Geometry> = {};
  const browser = await chromium.launch({ headless: true });
  try {
    chromiumVersion = browser.version();
    const context = await browser.newContext({
      offline: true,
      viewport: { width: 1800, height: 1300 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    context.on("request", (request) => {
      if (/^https?:/i.test(request.url())) externalRequests.add(request.url());
    });
    await context.route(/^https?:\/\//i, async (route) => route.abort("blockedbyclient"));
    const page = await context.newPage();
    await page.emulateMedia({ media: "print" });
    await page.setContent(html, { waitUntil: "load" });
    browserFontLoaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.status === "loaded" && document.fonts.check('16px "G3Body"', "حكايتي");
    });
    if (!browserFontLoaded) throw new Error("Local Arabic body font did not load for the cover fixture");

    domGeometry = await page.evaluate(() => {
      const pxToMm = 25.4 / 96;
      return Object.fromEntries(
        [...document.querySelectorAll<HTMLElement>("[data-region]")].map((element) => {
          const rect = element.getBoundingClientRect();
          return [element.dataset.region ?? "unknown", {
            left: rect.left * pxToMm,
            top: rect.top * pxToMm,
            width: rect.width * pxToMm,
            height: rect.height * pxToMm,
          }];
        }),
      );
    });
    await page.pdf({ path: rgbPdf, printBackground: true, preferCSSPageSize: true });
    await page.close();
    await context.close();
  } finally {
    await browser.close();
  }

  if (externalRequests.size > 0) {
    throw new Error(`Network request attempted during local-only render: ${[...externalRequests].join(", ")}`);
  }

  const expectedRegions: Record<string, Geometry> = {
    spread: { left: 0, top: 0, width: spreadWidthMm, height: spreadHeightMm },
    back: { left: bleedMm, top: bleedMm, width: trimWidthMm, height: trimHeightMm },
    spine: { left: bleedMm + trimWidthMm, top: bleedMm, width: spineWidthMm, height: trimHeightMm },
    front: {
      left: bleedMm + trimWidthMm + spineWidthMm,
      top: bleedMm,
      width: trimWidthMm,
      height: trimHeightMm,
    },
  };
  for (const [region, expected] of Object.entries(expectedRegions)) {
    const actual = domGeometry[region];
    if (!actual) throw new Error(`Missing DOM geometry for ${region}`);
    for (const key of ["left", "top", "width", "height"] as const) {
      assertClose(actual[key], expected[key], `${region}.${key}`);
    }
  }

  const rgbInfo = runRequired("pdfinfo", [rgbPdf]);
  const rgbFonts = runRequired("pdffonts", [rgbPdf]);
  writeCommandEvidence("cover-rgb-pdfinfo.txt", rgbInfo);
  writeCommandEvidence("cover-rgb-pdffonts.txt", rgbFonts);
  const rgbGeometry = parsePdfInfo(rgbInfo.stdout);
  const expectedPdfGeometry = assertPdfGeometry(rgbGeometry, spreadWidthMm, spreadHeightMm);
  const rgbEmbeddedFontCount = assertEmbeddedFonts(rgbFonts.stdout);

  const invalidIcc = resolve(artifactRoot, "missing-profile.icc");
  const invalidOutput = resolve(artifactRoot, ".invalid-icc-output.tmp.pdf");
  if (existsSync(invalidIcc)) unlinkSync(invalidIcc);
  if (existsSync(invalidOutput)) unlinkSync(invalidOutput);
  const invalidPdfxDefinition = resolve(artifactRoot, "cover-invalid-pdfx-def.resolved.ps");
  writeFileSync(
    invalidPdfxDefinition,
    readFileSync(pdfxFixture, "utf8")
      .replaceAll("{{ICC_PATH}}", escapePostScriptString(invalidIcc))
      .replaceAll("{{ICC_SHA256}}", "0".repeat(64)),
  );
  const invalidConversion = run("gs", gsConversionArgs(rgbPdf, invalidOutput, invalidIcc, invalidPdfxDefinition));
  writeCommandEvidence("cover-invalid-icc.txt", invalidConversion);
  const invalidPartialCreated = existsSync(invalidOutput);
  if (invalidPartialCreated) unlinkSync(invalidOutput);
  if (invalidConversion.status === 0) {
    throw new Error("Ghostscript unexpectedly accepted a missing ICC profile; fail-closed path is not proven");
  }

  if (existsSync(cmykTempPdf)) unlinkSync(cmykTempPdf);
  const conversion = runRequired("gs", gsConversionArgs(rgbPdf, cmykTempPdf, icc, resolvedPdfxDefinition));
  writeCommandEvidence("cover-gs-cmyk.txt", conversion);
  requireFile(cmykTempPdf, "Ghostscript temporary CMYK PDF");
  const tempInfo = runRequired("pdfinfo", [cmykTempPdf]);
  const cmykGeometry = parsePdfInfo(tempInfo.stdout);
  assertPdfGeometry(cmykGeometry, spreadWidthMm, spreadHeightMm);
  const cmykFonts = runRequired("pdffonts", [cmykTempPdf]);
  const cmykEmbeddedFontCount = assertEmbeddedFonts(cmykFonts.stdout);
  const qpdfCheck = runRequired("qpdf", ["--check", cmykTempPdf]);
  const qpdfJson = runRequired("qpdf", ["--json", "--json-stream-data=inline", cmykTempPdf]);
  const cmykInspection = assertCmykPdf(cmykTempPdf, qpdfJson.stdout, iccSha256);
  const inkCoverage = runRequired("gs", ["-q", "-o", "-", "-sDEVICE=inkcov", cmykTempPdf]);
  const coverage = assertCmykCoverage(`${inkCoverage.stdout}\n${inkCoverage.stderr}`);

  const rgbRaster = runRequired("pdftoppm", ["-png", "-r", "72", rgbPdf, resolve(artifactRoot, "cover-rgb-raster")]);
  const cmykRaster = runRequired("pdftoppm", [
    "-png",
    "-r",
    "72",
    cmykTempPdf,
    resolve(artifactRoot, "cover-cmyk-raster"),
  ]);
  const rasterFiles = readdirSync(artifactRoot)
    .filter((name) => /^cover-(rgb|cmyk)-raster-\d+\.png$/.test(name))
    .sort();
  if (rasterFiles.length !== 2) throw new Error(`Expected RGB and CMYK cover rasters; received ${rasterFiles.length}`);
  renameSync(cmykTempPdf, cmykPdf);

  writeCommandEvidence("cover-cmyk-pdfinfo.txt", tempInfo);
  writeCommandEvidence("cover-cmyk-pdffonts.txt", cmykFonts);
  writeCommandEvidence("cover-cmyk-qpdf-check.txt", qpdfCheck);
  writeCommandEvidence("cover-cmyk-inkcov.txt", inkCoverage);
  writeCommandEvidence("cover-rgb-pdftoppm.txt", rgbRaster);
  writeCommandEvidence("cover-cmyk-pdftoppm.txt", cmykRaster);
  const gsVersion = runRequired("gs", ["--version"]);
  const qpdfVersion = runRequired("qpdf", ["--version"]);
  const result = {
    gate: "G3",
    task: "T-P0-07",
    status: "MECHANICAL_CHECKS_PASS_MANUAL_REVIEW_PENDING",
    generatedAt: new Date().toISOString(),
    tools: { chromium: chromiumVersion, ghostscript: gsVersion.stdout.trim(), qpdf: qpdfVersion.stdout.trim() },
    localOnly: { externalHttpRequests: [...externalRequests], offlineContext: true },
    font: {
      file: relativeArtifact(bodyFont),
      sha256: sha256(bodyFont),
      browserLoaded: browserFontLoaded,
      rgbEmbeddedFontCount,
      cmykEmbeddedFontCount,
    },
    printerFixture: {
      trimWidthMm,
      trimHeightMm,
      bleedMm,
      spineWidthMm,
      spreadWidthMm,
      spreadHeightMm,
      expectedRegions,
      measuredRegions: domGeometry,
    },
    pdf: {
      expected: expectedPdfGeometry,
      rgb: { file: relativeArtifact(rgbPdf), sha256: sha256(rgbPdf), geometry: rgbGeometry },
      cmyk: { file: relativeArtifact(cmykPdf), sha256: sha256(cmykPdf), geometry: cmykGeometry },
    },
    cmyk: {
      iccFile: icc,
      iccSha256,
      inspection: cmykInspection,
      coverage,
      missingIccRejected: true,
      invalidAttemptCreatedPartialTemp: invalidPartialCreated,
      finalOutputCommittedOnlyAfterCompleteTemporaryPreflight: true,
      finalReplacementUsesAtomicRename: true,
    },
    rasters: rasterFiles.map((name) => `.local-artifacts/g3/${name}`),
    manualReviewRequired: [
      "back-left, spine-center, front-right physical order",
      "fold/crop marks and bleed continuity",
      "Arabic shaping on front, back, and spine",
      "RGB-to-CMYK proof color shift acceptability",
    ],
  };
  writeFileSync(resolve(artifactRoot, "cover-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`G3 cover/CMYK mechanical checks passed; inspect ${relativeArtifact(cmykPdf)} and rasters.\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(
    resolve(artifactRoot, "cover-failure.json"),
    `${JSON.stringify({ gate: "G3", task: "T-P0-07", status: "FAIL", message }, null, 2)}\n`,
  );
  process.stderr.write(`G3 cover/CMYK probe failed: ${message}\n`);
  process.exitCode = 1;
});

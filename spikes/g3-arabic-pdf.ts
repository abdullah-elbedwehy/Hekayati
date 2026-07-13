import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const spikeRoot = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(spikeRoot, "fixtures");
const artifactRoot = resolve(spikeRoot, ".local-artifacts", "g3");
const expectedPageMm = { width: 216, height: 303 };
const expectedArt = { widthPx: 1800, heightPx: 1200, widthMm: 152.4, heightMm: 101.6 };

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type ArtPlacement = { widthMm: number; heightMm: number };

function cliOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function resolveInput(option: string, envName: string, fallback: string): string {
  return resolve(cliOption(option) ?? process.env[envName] ?? fallback);
}

function requireFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} is missing: ${path}`);
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function dataUri(path: string, mime: string): string {
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

function run(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${command} unavailable: ${result.error.message}`);
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
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

function assertPageGeometry(
  actual: { pages: number; widthPt: number; heightPt: number },
): { expectedWidthPt: number; expectedHeightPt: number; tolerancePt: number } {
  const expectedWidthPt = expectedPageMm.width * 72 / 25.4;
  const expectedHeightPt = expectedPageMm.height * 72 / 25.4;
  const tolerancePt = 0.75;
  if (actual.pages !== 2) throw new Error(`Expected 2 PDF pages; received ${actual.pages}`);
  if (
    Math.abs(actual.widthPt - expectedWidthPt) > tolerancePt ||
    Math.abs(actual.heightPt - expectedHeightPt) > tolerancePt
  ) {
    throw new Error(
      `PDF page is ${actual.widthPt} x ${actual.heightPt} pt; expected ${expectedWidthPt} x ${expectedHeightPt} pt`,
    );
  }
  return { expectedWidthPt, expectedHeightPt, tolerancePt };
}

function assertEmbeddedFonts(output: string): { count: number; identities: string[] } {
  const rows = output
    .split("\n")
    .filter((line) => /^\S/.test(line) && !line.startsWith("name") && !line.startsWith("---"));
  if (rows.length !== 2) throw new Error(`Expected exactly two embedded fonts; pdffonts reported ${rows.length}`);
  const identities: string[] = [];
  for (const row of rows) {
    const flags = row.match(/\s+(yes|no)\s+(yes|no)\s+(yes|no)\s+\d+\s+\d+\s*$/i);
    if (!flags) throw new Error(`Could not parse pdffonts row: ${row}`);
    if (
      flags[1].toLowerCase() !== "yes" ||
      flags[2].toLowerCase() !== "yes" ||
      flags[3].toLowerCase() !== "yes"
    ) {
      throw new Error(`Font is not embedded, subsetted, and mapped to Unicode: ${row}`);
    }
    identities.push((row.trim().split(/\s+/)[0] ?? "").replace(/^[A-Z]{6}\+/, ""));
  }
  const expected = ["IBMPlexSansArabic", "Lemonada-SemiBold"].sort();
  if (JSON.stringify(identities.sort()) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected embedded font identities: ${identities.join(", ")}`);
  }
  return { count: rows.length, identities };
}

function assertArtResolution(output: string): { xPpi: number; yPpi: number } {
  const candidates = output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => /^\d+$/.test(columns[0] ?? "") && columns[2] === "image")
    .map((columns) => ({
      width: Number(columns[3]),
      height: Number(columns[4]),
      xPpi: Number(columns[12]),
      yPpi: Number(columns[13]),
    }));
  const art = candidates.find(
    (candidate) => candidate.width === expectedArt.widthPx && candidate.height === expectedArt.heightPx,
  );
  if (!art) throw new Error("pdfimages did not find the 1800 x 1200 synthetic art image");
  if (art.xPpi < 299 || art.xPpi > 301 || art.yPpi < 299 || art.yPpi > 301) {
    throw new Error(`Synthetic art did not resolve within 300 ±1 PPI: ${art.xPpi} x ${art.yPpi} PPI`);
  }
  return { xPpi: art.xPpi, yPpi: art.yPpi };
}

function assertArtPlacement(actual: ArtPlacement): void {
  const toleranceMm = 0.08;
  if (
    Math.abs(actual.widthMm - expectedArt.widthMm) > toleranceMm ||
    Math.abs(actual.heightMm - expectedArt.heightMm) > toleranceMm
  ) {
    throw new Error(
      `Synthetic art placement is ${actual.widthMm} x ${actual.heightMm} mm; expected ${expectedArt.widthMm} x ${expectedArt.heightMm} mm`,
    );
  }
}

function readPngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("Synthetic art screenshot is not a PNG");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function relativeArtifact(path: string): string {
  return relative(spikeRoot, path);
}

async function main(): Promise<void> {
  mkdirSync(artifactRoot, { recursive: true });

  const bodyFont = resolveInput(
    "--body-font",
    "G3_BODY_FONT",
    resolve(fixtureRoot, "fonts", "IBMPlexSansArabic-Regular.ttf"),
  );
  const displayFont = resolveInput(
    "--display-font",
    "G3_DISPLAY_FONT",
    resolve(fixtureRoot, "fonts", "Lemonada-SemiBold.ttf"),
  );
  const htmlFixture = resolve(fixtureRoot, "g3-arabic-corpus.html");
  const artFixture = resolve(fixtureRoot, "g3-synthetic-art.svg");

  requireFile(bodyFont, "Arabic body font");
  requireFile(displayFont, "Arabic display font");
  requireFile(htmlFixture, "Arabic corpus fixture");
  requireFile(artFixture, "Synthetic art fixture");

  const artPng = resolve(artifactRoot, "synthetic-art-1800x1200.png");
  const resolvedHtml = resolve(artifactRoot, "arabic-corpus.resolved.html");
  const outputPdf = resolve(artifactRoot, "arabic-corpus-216x303mm.pdf");
  const externalRequests = new Set<string>();
  let chromiumVersion = "unknown";
  let fontChecks = { body: false, display: false, status: "unloaded" };
  let artPlacement: ArtPlacement = { widthMm: 0, heightMm: 0 };

  const browser = await chromium.launch({ headless: true });
  try {
    chromiumVersion = browser.version();
    const context = await browser.newContext({
      offline: true,
      viewport: { width: expectedArt.widthPx, height: expectedArt.heightPx },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    context.on("request", (request) => {
      if (/^https?:/i.test(request.url())) externalRequests.add(request.url());
    });
    await context.route(/^https?:\/\//i, async (route) => route.abort("blockedbyclient"));

    const artPage = await context.newPage();
    await artPage.goto(pathToFileURL(artFixture).href, { waitUntil: "load" });
    await artPage.screenshot({ path: artPng, animations: "disabled" });
    await artPage.close();

    const pngDimensions = readPngDimensions(artPng);
    if (pngDimensions.width !== expectedArt.widthPx || pngDimensions.height !== expectedArt.heightPx) {
      throw new Error(`Synthetic art is ${pngDimensions.width} x ${pngDimensions.height}; expected 1800 x 1200`);
    }

    const html = readFileSync(htmlFixture, "utf8")
      .replaceAll("{{BODY_FONT_DATA_URI}}", dataUri(bodyFont, "font/ttf"))
      .replaceAll("{{DISPLAY_FONT_DATA_URI}}", dataUri(displayFont, "font/ttf"))
      .replaceAll("{{ART_DATA_URI}}", dataUri(artPng, "image/png"));
    writeFileSync(resolvedHtml, html);

    const page = await context.newPage();
    await page.setViewportSize({ width: 1100, height: 1300 });
    await page.emulateMedia({ media: "print" });
    await page.setContent(html, { waitUntil: "load" });
    fontChecks = await page.evaluate(async () => {
      await document.fonts.ready;
      return {
        body: document.fonts.check('16px "G3Body"', "العربية"),
        display: document.fonts.check('16px "G3Display"', "العربية"),
        status: document.fonts.status,
      };
    });
    if (!fontChecks.body || !fontChecks.display || fontChecks.status !== "loaded") {
      throw new Error(`Local font load failed: ${JSON.stringify(fontChecks)}`);
    }
    artPlacement = await page.evaluate(() => {
      const art = document.querySelector<HTMLElement>(".art-frame img");
      if (!art) throw new Error("Synthetic art element is missing");
      const rect = art.getBoundingClientRect();
      const pxToMm = 25.4 / 96;
      return { widthMm: rect.width * pxToMm, heightMm: rect.height * pxToMm };
    });
    assertArtPlacement(artPlacement);
    await page.pdf({ path: outputPdf, printBackground: true, preferCSSPageSize: true });
    await page.close();
    await context.close();
  } finally {
    await browser.close();
  }

  if (externalRequests.size > 0) {
    throw new Error(`Network request attempted during local-only render: ${[...externalRequests].join(", ")}`);
  }

  const pdfInfo = runRequired("pdfinfo", [outputPdf]);
  const pdfFonts = runRequired("pdffonts", [outputPdf]);
  const pdfImages = runRequired("pdfimages", ["-list", outputPdf]);
  const pdfText = runRequired("pdftotext", ["-layout", outputPdf, "-"]);
  writeCommandEvidence("arabic-pdfinfo.txt", pdfInfo);
  writeCommandEvidence("arabic-pdffonts.txt", pdfFonts);
  writeCommandEvidence("arabic-pdfimages.txt", pdfImages);
  writeCommandEvidence("arabic-pdftotext.txt", pdfText);

  const geometry = parsePdfInfo(pdfInfo.stdout);
  const expectedGeometry = assertPageGeometry(geometry);
  const embeddedFonts = assertEmbeddedFonts(pdfFonts.stdout);
  const effectivePpi = assertArtResolution(pdfImages.stdout);

  const rasterPrefix = resolve(artifactRoot, "arabic-raster");
  const raster = runRequired("pdftoppm", ["-png", "-r", "144", outputPdf, rasterPrefix]);
  writeCommandEvidence("arabic-pdftoppm.txt", raster);
  const rasterFiles = readdirSync(artifactRoot)
    .filter((name) => /^arabic-raster-\d+\.png$/.test(name))
    .sort();
  if (rasterFiles.length !== 2) throw new Error(`Expected 2 Poppler rasters; received ${rasterFiles.length}`);

  const result = {
    gate: "G3",
    task: "T-P0-06",
    status: "MECHANICAL_CHECKS_PASS_MANUAL_REVIEW_PENDING",
    generatedAt: new Date().toISOString(),
    nodeVersion: process.versions.node,
    chromiumVersion,
    localOnly: { externalHttpRequests: [...externalRequests], offlineContext: true },
    fonts: {
      body: { file: relativeArtifact(bodyFont), sha256: sha256(bodyFont) },
      display: { file: relativeArtifact(displayFont), sha256: sha256(displayFont) },
      browserChecks: fontChecks,
      embeddedFontCount: embeddedFonts.count,
      embeddedFontIdentities: embeddedFonts.identities,
    },
    pdf: {
      file: relativeArtifact(outputPdf),
      sha256: sha256(outputPdf),
      actual: geometry,
      expected: expectedGeometry,
    },
    syntheticArt: {
      source: relativeArtifact(artFixture),
      sourceSha256: sha256(artFixture),
      png: relativeArtifact(artPng),
      pngSha256: sha256(artPng),
      ...expectedArt,
      measuredPlacement: artPlacement,
      effectivePpi,
    },
    rasters: rasterFiles.map((name) => `.local-artifacts/g3/${name}`),
    manualReviewRequired: [
      "connected Arabic forms and lam-alef",
      "tashkeel placement and punctuation",
      "mixed Arabic/Latin/numeric BiDi order",
      "no clipping at trim/safe guides",
      "synthetic art sharpness at printed size",
    ],
  };
  writeFileSync(resolve(artifactRoot, "arabic-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`G3 Arabic mechanical checks passed; inspect ${relativeArtifact(outputPdf)} and rasters.\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(
    resolve(artifactRoot, "arabic-failure.json"),
    `${JSON.stringify({ gate: "G3", task: "T-P0-06", status: "FAIL", message }, null, 2)}\n`,
  );
  process.stderr.write(`G3 Arabic PDF probe failed: ${message}\n`);
  process.exitCode = 1;
});

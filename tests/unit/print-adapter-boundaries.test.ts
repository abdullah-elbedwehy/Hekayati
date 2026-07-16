import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  convertPdfToCmyk,
  type CmykConversionError,
  type CmykTools,
} from "../../src/print/cmyk.js";
import {
  MAX_ICC_PROFILE_BYTES,
  inspectIccProfile,
  requireCmykIccProfile,
  type IccInspectionError,
} from "../../src/print/icc.js";
import {
  inspectCoverTemplatePdf,
  type CoverTemplateInspectionError,
  type CoverTemplateTools,
} from "../../src/print/template.js";
import { paddedTestIcc, validTestIcc } from "../helpers/icc-profile.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("ICC adapter boundaries", () => {
  it("rejects header-only profiles and enforces maximum, declared-length, and tag bounds", () => {
    expectIccError(Buffer.alloc(131), "ICC_SIZE_INVALID");

    const headerOnly = Buffer.alloc(132);
    headerOnly.writeUInt32BE(headerOnly.length, 0);
    headerOnly.writeUInt8(2, 8);
    headerOnly.write("prtr", 12, 4, "ascii");
    headerOnly.write("CMYK", 16, 4, "ascii");
    headerOnly.write("Lab ", 20, 4, "ascii");
    headerOnly.write("acsp", 36, 4, "ascii");
    expectIccError(headerOnly, "ICC_STRUCTURE_INVALID");

    const valid = validTestIcc("CMYK");
    expect(inspectIccProfile(valid)).toMatchObject({
      bytes: valid.length,
      declaredBytes: valid.length,
      dataColorSpace: "CMYK",
      channels: 4,
      profileClass: "output",
    });

    const maximum = paddedTestIcc("CMYK", MAX_ICC_PROFILE_BYTES);
    expect(inspectIccProfile(maximum).bytes).toBe(MAX_ICC_PROFILE_BYTES);
    expectIccError(Buffer.alloc(MAX_ICC_PROFILE_BYTES + 1), "ICC_SIZE_INVALID");

    const declaredShort = Buffer.from(valid);
    declaredShort.writeUInt32BE(valid.length - 1, 0);
    expectIccError(declaredShort, "ICC_LENGTH_MISMATCH");
    const declaredLong = Buffer.from(valid);
    declaredLong.writeUInt32BE(valid.length + 1, 0);
    expectIccError(declaredLong, "ICC_LENGTH_MISMATCH");

    const truncatedTags = Buffer.from(valid.subarray(0, 132));
    truncatedTags.writeUInt32BE(truncatedTags.length, 0);
    truncatedTags.writeUInt32BE(1, 128);
    expectIccError(truncatedTags, "ICC_LENGTH_MISMATCH");
    const overflowingTags = Buffer.from(valid);
    overflowingTags.writeUInt32BE(0xff_ff_ff_ff, 128);
    expectIccError(overflowingTags, "ICC_STRUCTURE_INVALID");

    const badOffset = Buffer.from(valid);
    badOffset.writeUInt32BE(133, 136);
    expectIccError(badOffset, "ICC_STRUCTURE_INVALID");
  });

  it("rejects bad signatures and unsupported or non-CMYK color spaces", () => {
    const badSignature = syntheticIcc("CMYK");
    badSignature.write("zzzz", 36, 4, "ascii");
    expectIccError(badSignature, "ICC_SIGNATURE_INVALID");

    const unsupported = syntheticIcc("GRAY");
    expectIccError(unsupported, "ICC_COLOR_SPACE_UNSUPPORTED");

    const rgb = syntheticIcc("RGB ");
    expect(inspectIccProfile(rgb)).toMatchObject({
      dataColorSpace: "RGB",
      channels: 3,
    });
    expect(() => requireCmykIccProfile(rgb)).toThrowError(
      expect.objectContaining({ code: "ICC_COLOR_SPACE_UNSUPPORTED" }),
    );
  });
});

describe("cover-template adapter boundaries", () => {
  it("rejects short, oversized, and wrongly signed inputs before tools run", async () => {
    await expectTemplateError(
      inspectCoverTemplatePdf(Buffer.alloc(63)),
      "COVER_TEMPLATE_SIZE_INVALID",
    );
    await expectTemplateError(
      inspectCoverTemplatePdf(Buffer.alloc(32 * 1024 * 1024 + 1)),
      "COVER_TEMPLATE_SIZE_INVALID",
    );
    await expectTemplateError(
      inspectCoverTemplatePdf(Buffer.alloc(64, 0x20)),
      "COVER_TEMPLATE_SIGNATURE_INVALID",
    );
  });

  it.each([
    "/JavaScript",
    "/JS ",
    "/OpenAction<<>>",
    "/AA[",
    "/AcroForm/",
    "/EmbeddedFiles ",
    "/Filespec ",
    "/Launch ",
    "/URI ",
    "/SubmitForm ",
    "/RichMedia ",
    "/GoToR ",
  ])("rejects the prohibited PDF name %s", async (token) => {
    await expectTemplateError(
      inspectCoverTemplatePdf(templateBytes(token)),
      "COVER_TEMPLATE_PROHIBITED_FEATURE",
    );
  });

  it.each([
    "https://example.invalid/a",
    "HTTP://example.invalid/a",
    "ftp://example.invalid/a",
    "file:///tmp/a",
    "/Users/operator/a",
    String.raw`C:\\private\\a`,
  ])("rejects the external reference %s", async (reference) => {
    await expectTemplateError(
      inspectCoverTemplatePdf(templateBytes(reference)),
      "COVER_TEMPLATE_EXTERNAL_RESOURCE",
    );
  });

  it("accepts a safe one-page result and ignores PDF-name prefix lookalikes", async () => {
    const tools = await templateTools({});
    const result = await inspectCoverTemplatePdf(
      templateBytes("/JavaScriptX /URIX https-no-colon"),
      tools,
    );

    expect(result).toEqual({
      bytes: 64,
      pageCount: 1,
      pageWidthMm: 215.9,
      pageHeightMm: 279.4,
      encrypted: false,
      prohibitedFeatureCount: 0,
      externalResourceCount: 0,
    });
  });

  it.each([
    ["encrypted", { qpdf: "encrypted" }, "COVER_TEMPLATE_ENCRYPTED"],
    ["two pages", { qpdf: "two-pages" }, "COVER_TEMPLATE_PAGE_COUNT_INVALID"],
    [
      "invalid page count",
      { qpdf: "invalid-pages" },
      "COVER_TEMPLATE_PAGE_COUNT_INVALID",
    ],
    [
      "missing dimensions",
      { pdfinfo: "missing-size" },
      "COVER_TEMPLATE_GEOMETRY_INVALID",
    ],
    [
      "zero dimensions",
      { pdfinfo: "zero-size" },
      "COVER_TEMPLATE_GEOMETRY_INVALID",
    ],
    [
      "huge dimensions",
      { pdfinfo: "huge-size" },
      "COVER_TEMPLATE_GEOMETRY_INVALID",
    ],
    [
      "non-finite dimensions",
      { pdfinfo: "infinite-size" },
      "COVER_TEMPLATE_GEOMETRY_INVALID",
    ],
    [
      "qpdf check failure",
      { qpdf: "check-fail" },
      "COVER_TEMPLATE_PARSE_FAILED",
    ],
    [
      "qpdf inspection failure",
      { qpdf: "inspect-fail" },
      "COVER_TEMPLATE_PARSE_FAILED",
    ],
    [
      "pdfinfo failure",
      { pdfinfo: "exit-fail" },
      "COVER_TEMPLATE_PARSE_FAILED",
    ],
    [
      "decompressed active content",
      { qpdf: "json-prohibited" },
      "COVER_TEMPLATE_PROHIBITED_FEATURE",
    ],
    [
      "decompressed external reference",
      { qpdf: "json-external" },
      "COVER_TEMPLATE_EXTERNAL_RESOURCE",
    ],
  ] as const)("rejects %s", async (_name, scenario, code) => {
    const tools = await templateTools(scenario);
    await expectTemplateError(
      inspectCoverTemplatePdf(templateBytes(), tools),
      code,
    );
  });

  it("normalizes missing qpdf and pdfinfo binaries as parse failures", async () => {
    const tools = await templateTools({});
    await expectTemplateError(
      inspectCoverTemplatePdf(templateBytes(), {
        ...tools,
        qpdf: join("/missing", "hekayati-qpdf"),
      }),
      "COVER_TEMPLATE_PARSE_FAILED",
    );
    await expectTemplateError(
      inspectCoverTemplatePdf(templateBytes(), {
        ...tools,
        pdfinfo: join("/missing", "hekayati-pdfinfo"),
      }),
      "COVER_TEMPLATE_PARSE_FAILED",
    );
  });
});

describe("CMYK adapter boundaries", () => {
  it("rejects malformed, RGB, and checksum-mismatched ICC input before conversion", async () => {
    const pdfBytes = templateBytes();
    const malformed = Buffer.alloc(131);
    await expectCmykError(
      convertPdfToCmyk({
        pdfBytes,
        iccBytes: malformed,
        expectedIccChecksum: sha256(malformed),
      }),
      "CMYK_ICC_INVALID",
    );

    const rgb = syntheticIcc("RGB ");
    await expectCmykError(
      convertPdfToCmyk({
        pdfBytes,
        iccBytes: rgb,
        expectedIccChecksum: sha256(rgb),
      }),
      "CMYK_ICC_INVALID",
    );

    const cmyk = syntheticIcc("CMYK");
    await expectCmykError(
      convertPdfToCmyk({
        pdfBytes,
        iccBytes: cmyk,
        expectedIccChecksum: "0".repeat(64),
      }),
      "CMYK_ICC_INVALID",
    );
  });

  it.each([
    ["missing baseline tool", { pdfinfo: "missing" }, "CMYK_TOOL_UNAVAILABLE"],
    ["non-zero baseline tool", { pdfinfo: "exit-fail" }, "CMYK_OUTPUT_INVALID"],
    [
      "missing converter",
      { ghostscript: "missing-convert" },
      "CMYK_TOOL_UNAVAILABLE",
    ],
    [
      "non-zero converter",
      { ghostscript: "convert-fail" },
      "CMYK_CONVERSION_FAILED",
    ],
    ["invalid qpdf JSON", { qpdf: "invalid-json" }, "CMYK_OUTPUT_INVALID"],
    ["missing page facts", { qpdf: "no-pages" }, "CMYK_COLOR_SPACE_INVALID"],
    ["changed geometry", { pdfinfo: "changed-after" }, "CMYK_GEOMETRY_CHANGED"],
    ["missing fonts", { pdffonts: "missing-after" }, "CMYK_FONT_CHANGED"],
    [
      "invalid output intent",
      { qpdf: "bad-intent" },
      "CMYK_OUTPUT_INTENT_INVALID",
    ],
    [
      "missing output intents",
      { qpdf: "no-intents" },
      "CMYK_OUTPUT_INTENT_INVALID",
    ],
    [
      "invalid qpdf object table",
      { qpdf: "bad-qpdf-shape" },
      "CMYK_OUTPUT_INTENT_INVALID",
    ],
    [
      "invalid output-intent reference",
      { qpdf: "bad-intent-ref" },
      "CMYK_OUTPUT_INTENT_INVALID",
    ],
    [
      "wrong ICC channel count",
      { qpdf: "bad-profile-channel" },
      "CMYK_OUTPUT_INTENT_INVALID",
    ],
    [
      "wrong embedded ICC",
      { qpdf: "bad-profile-data" },
      "CMYK_OUTPUT_INTENT_INVALID",
    ],
    ["RGB image", { qpdf: "rgb-image" }, "CMYK_COLOR_SPACE_INVALID"],
    ["CalRGB resource", { qpdf: "calrgb" }, "CMYK_COLOR_SPACE_INVALID"],
    ["Lab resource", { qpdf: "lab" }, "CMYK_COLOR_SPACE_INVALID"],
    ["Indexed RGB base", { qpdf: "indexed-rgb" }, "CMYK_COLOR_SPACE_INVALID"],
    [
      "three-channel ICCBased resource",
      { qpdf: "icc-rgb" },
      "CMYK_COLOR_SPACE_INVALID",
    ],
    [
      "nested form RGB operator",
      { qpdf: "nested-rgb-content" },
      "CMYK_COLOR_SPACE_INVALID",
    ],
    [
      "malformed image",
      { qpdf: "malformed-image" },
      "CMYK_COLOR_SPACE_INVALID",
    ],
    [
      "malformed content reference",
      { qpdf: "bad-content-ref" },
      "CMYK_COLOR_SPACE_INVALID",
    ],
    [
      "RGB content operator",
      { qpdf: "rgb-content" },
      "CMYK_COLOR_SPACE_INVALID",
    ],
    [
      "no CMYK content operator",
      { qpdf: "no-cmyk-content" },
      "CMYK_COLOR_SPACE_INVALID",
    ],
  ] as const)(
    "normalizes %s and preserves caller-owned input",
    async (_name, scenario, code) => {
      const pdfBytes = templateBytes("caller-owned");
      const before = Buffer.from(pdfBytes);
      const iccBytes = syntheticIcc("CMYK");
      const tools = await cmykTools(scenario);

      await expectCmykError(
        convertPdfToCmyk({
          pdfBytes,
          iccBytes,
          expectedIccChecksum: sha256(iccBytes),
          tools,
        }),
        code,
      );
      expect(pdfBytes).toEqual(before);
    },
    10_000,
  );

  it("accepts a mechanically valid fake conversion result", async () => {
    const pdfBytes = templateBytes();
    const iccBytes = syntheticIcc("CMYK");
    const checksum = sha256(iccBytes);
    const result = await convertPdfToCmyk({
      pdfBytes,
      iccBytes,
      expectedIccChecksum: checksum,
      tools: await cmykTools({}),
    });

    expect(result).toMatchObject({
      iccChecksum: checksum,
      embeddedIccChecksum: checksum,
      embeddedIccBytes: iccBytes.length,
      imageCount: 1,
      contentStreamCount: 1,
      pageCount: 1,
      cmykOnly: true,
      outputIntentMatches: true,
      geometryPreserved: true,
      fontsPreserved: true,
      converterVersion: "10.04.0-fake",
    });
    expect(result.pdfBytes.toString("ascii")).toContain("%PDF-fake-cmyk");
  }, 10_000);

  it("kills an in-flight converter when the worker aborts", async () => {
    const iccBytes = syntheticIcc("CMYK");
    const controller = new AbortController();
    const conversion = convertPdfToCmyk({
      pdfBytes: templateBytes(),
      iccBytes,
      expectedIccChecksum: sha256(iccBytes),
      tools: await cmykTools({ ghostscript: "slow-convert" }),
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    setTimeout(() => controller.abort(), 50);
    await expectCmykError(conversion, "CMYK_CONVERSION_TIMEOUT");
  }, 2_000);
});

function syntheticIcc(colorSpace: "CMYK" | "RGB " | "GRAY"): Buffer {
  const bytes = validTestIcc(colorSpace === "CMYK" ? "CMYK" : "RGB ");
  if (colorSpace === "GRAY") bytes.write("GRAY", 16, 4, "ascii");
  return bytes;
}

function templateBytes(suffix = ""): Buffer {
  const bytes = Buffer.alloc(64, 0x20);
  bytes.write("%PDF-1.7\n", 0, "ascii");
  if (suffix) bytes.write(suffix, 10, "latin1");
  return bytes;
}

function expectIccError(
  bytes: Buffer,
  code: InstanceType<typeof IccInspectionError>["code"],
): void {
  expect(() => inspectIccProfile(bytes)).toThrowError(
    expect.objectContaining({ code }),
  );
}

async function expectTemplateError(
  promise: Promise<unknown>,
  code: InstanceType<typeof CoverTemplateInspectionError>["code"],
): Promise<void> {
  await expect(promise).rejects.toThrowError(expect.objectContaining({ code }));
}

async function expectCmykError(
  promise: Promise<unknown>,
  code: InstanceType<typeof CmykConversionError>["code"],
): Promise<void> {
  await expect(promise).rejects.toThrowError(expect.objectContaining({ code }));
}

async function templateTools(scenario: {
  qpdf?: string;
  pdfinfo?: string;
}): Promise<CoverTemplateTools> {
  const directory = await toolDirectory("hekayati-template-tools-");
  return {
    qpdf: await executable(
      directory,
      "qpdf",
      templateQpdfScript(scenario.qpdf ?? "safe"),
    ),
    pdfinfo: await executable(
      directory,
      "pdfinfo",
      templatePdfinfoScript(scenario.pdfinfo ?? "safe"),
    ),
  };
}

function templateQpdfScript(mode: string): string {
  return `
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (args.includes("--check")) {
  process.exit(mode === "check-fail" ? 7 : 0);
}
if (mode === "inspect-fail") process.exit(8);
if (args.includes("--show-encryption")) {
  process.stdout.write(mode === "encrypted" ? "encrypted" : "File is not encrypted");
} else if (args.includes("--show-npages")) {
  process.stdout.write(mode === "two-pages" ? "2" : mode === "invalid-pages" ? "nope" : "1");
} else if (args.includes("--json")) {
  process.stdout.write(mode === "json-prohibited" ? "/OpenAction " : mode === "json-external" ? "https://example.invalid" : "{}");
}
`;
}

function templatePdfinfoScript(mode: string): string {
  const outputs: Record<string, string> = {
    safe: "Page size: 612 x 792 pts\\n",
    "missing-size": "Pages: 1\\n",
    "zero-size": "Page size: 0 x 792 pts\\n",
    "huge-size": "Page size: 20001 x 792 pts\\n",
    "infinite-size": `Page size: ${"9".repeat(400)} x 792 pts\\n`,
  };
  return `
const mode = ${JSON.stringify(mode)};
if (mode === "exit-fail") process.exit(9);
process.stdout.write(${JSON.stringify(outputs[mode] ?? outputs.safe)});
`;
}

async function cmykTools(scenario: {
  ghostscript?: string;
  qpdf?: string;
  pdfinfo?: string;
  pdffonts?: string;
}): Promise<Partial<CmykTools>> {
  const directory = await toolDirectory("hekayati-cmyk-tools-");
  const ghostscript = scenario.ghostscript ?? "safe";
  const pdfinfo = scenario.pdfinfo ?? "safe";
  const pdffonts = scenario.pdffonts ?? "safe";
  return {
    ghostscript:
      ghostscript === "missing-convert"
        ? join(directory, "missing-gs")
        : await executable(directory, "gs", cmykGhostscriptScript(ghostscript)),
    qpdf: await executable(
      directory,
      "qpdf",
      cmykQpdfScript(scenario.qpdf ?? "safe"),
    ),
    pdfinfo:
      pdfinfo === "missing"
        ? join(directory, "missing-pdfinfo")
        : await executable(directory, "pdfinfo", cmykPdfinfoScript(pdfinfo)),
    pdffonts: await executable(
      directory,
      "pdffonts",
      cmykPdffontsScript(pdffonts),
    ),
  };
}

function cmykGhostscriptScript(mode: string): string {
  return `
const fs = require("node:fs");
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("10.04.0-fake\\n");
  process.exit(0);
}
if (mode === "convert-fail") process.exit(11);
if (mode === "slow-convert") {
  setTimeout(() => undefined, 60_000);
  return;
}
const output = args.find((value) => value.startsWith("-sOutputFile="));
if (!output) process.exit(12);
fs.writeFileSync(output.slice("-sOutputFile=".length), "%PDF-fake-cmyk\\n");
`;
}

function cmykPdfinfoScript(mode: string): string {
  return `
const mode = ${JSON.stringify(mode)};
const candidate = process.argv.at(-1).endsWith("candidate.pdf");
const width = mode === "changed-after" && candidate ? 613 : 612;
process.stdout.write([
  "Pages: 1",
  "Page size: " + width + " x 792 pts",
  "MediaBox: 0 0 " + width + " 792",
  "CropBox: 0 0 " + width + " 792",
  "BleedBox: 0 0 " + width + " 792",
  "TrimBox: 0 0 " + width + " 792",
  "ArtBox: 0 0 " + width + " 792",
].join("\\n") + "\\n");
if (mode === "exit-fail") process.exit(13);
`;
}

function cmykPdffontsScript(mode: string): string {
  return `
const mode = ${JSON.stringify(mode)};
const candidate = process.argv.at(-1).endsWith("candidate.pdf");
if (mode === "missing-after" && candidate) process.stdout.write("no fonts\\n");
else process.stdout.write("ABCDEF+NotoSans Type0 yes yes yes 1 0\\n");
`;
}

function cmykQpdfScript(mode: string): string {
  return `
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
const candidate = args.at(-1);
if (args.includes("--check")) process.exit(0);
if (args.some((value) => value.startsWith("--show-object="))) {
  const object = args.find((value) => value.startsWith("--show-object="));
  process.stdout.write(mode === "rgb-content" || (mode === "nested-rgb-content" && object === "--show-object=5") ? "0.1 0.2 0.3 rg" : mode === "no-cmyk-content" ? "1 0 0 m" : "0 0 0 1 k");
  process.exit(0);
}
if (!args.includes("--json")) process.exit(14);
if (mode === "invalid-json") {
  process.stdout.write("not-json");
  process.exit(0);
}
if (mode === "bad-qpdf-shape") {
  process.stdout.write(JSON.stringify({ qpdf: {}, pages: [] }));
  process.exit(0);
}
const icc = fs.readFileSync(path.join(path.dirname(candidate), "profile.icc"));
const checksum = crypto.createHash("sha256").update(icc).digest("hex");
const embedded = mode === "bad-profile-data" ? Buffer.from("wrong") : icc;
const profileChannel = mode === "bad-profile-channel" ? 3 : 4;
const table = {
  "obj:1 0 R": { value: { "/Type": "/Catalog", "/OutputIntents": mode === "no-intents" ? [] : [mode === "bad-intent-ref" ? 2 : "2 0 R"] } },
  "obj:2 0 R": { value: {
    "/Type": "/OutputIntent",
    "/S": "/GTS_PDFX",
    "/OutputConditionIdentifier": "u:hekayati-profile-" + checksum,
    "/DestOutputProfile": "3 0 R",
  } },
  "obj:3 0 R": { stream: { dict: { "/N": profileChannel }, data: embedded.toString("base64") } },
};
if (mode === "calrgb") table["obj:1 0 R"].value["/Resources"] = { "/ColorSpace": { "/CS1": ["/CalRGB", {}] } };
if (mode === "lab") table["obj:1 0 R"].value["/Resources"] = { "/ColorSpace": { "/CS1": ["/Lab", {}] } };
if (mode === "indexed-rgb") table["obj:1 0 R"].value["/Resources"] = { "/ColorSpace": { "/CS1": ["/Indexed", "/DeviceRGB", 1, "u:lookup"] } };
if (mode === "icc-rgb") {
  table["obj:1 0 R"].value["/Resources"] = { "/ColorSpace": { "/CS1": ["/ICCBased", "6 0 R"] } };
  table["obj:6 0 R"] = { stream: { dict: { "/N": 3 }, data: "" } };
}
if (mode === "nested-rgb-content") table["obj:5 0 R"] = { stream: { dict: { "/Subtype": "/Form", "/Resources": {} }, data: "" } };
if (mode === "bad-intent") table["obj:2 0 R"].value["/S"] = "/GTS_PDFA1";
const image = mode === "malformed-image" ? "bad-image" : { colorspace: mode === "rgb-image" ? "/DeviceRGB" : "/DeviceCMYK" };
const pages = mode === "no-pages" ? [] : [{ contents: [mode === "bad-content-ref" ? "bad-ref" : "4 0 R"], images: [image] }];
process.stdout.write(JSON.stringify({ qpdf: [{ jsonversion: 2 }, table], pages }));
`;
}

async function toolDirectory(prefix: string): Promise<string> {
  const temp = await temporaryDirectory(prefix);
  cleanups.push(temp.cleanup);
  const directory = join(temp.path, "bin");
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

async function executable(
  directory: string,
  name: string,
  body: string,
): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

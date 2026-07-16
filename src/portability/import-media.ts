import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { fileTypeFromFile } from "file-type";
import sharp from "sharp";

import type { PortabilityValidatedMediaFacts } from "../domain/portability/participants.js";
import { inspectIccProfile } from "../print/icc.js";
import { inspectCoverTemplatePdf } from "../print/template.js";
import { ArchiveValidationError } from "./archive-policy.js";
import type { ManifestMediaEntry } from "./manifest.js";

const run = promisify(execFile);
const prohibitedPdfNames = [
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

export async function inspectImportedMedia(
  entry: ManifestMediaEntry,
  path: string,
): Promise<PortabilityValidatedMediaFacts> {
  const base = {
    namespace: entry.namespace,
    id: entry.assetId,
    bytes: entry.bytes,
    sha256: entry.sha256,
    mime: entry.mime,
    extension: entry.extension,
    role: entry.role,
  } as const;
  if (entry.role === "icc_profile") {
    const facts = inspectIcc(entry, await readFile(path));
    return { ...base, inspection: facts };
  }
  if (entry.mime === "application/pdf") {
    const facts =
      entry.role === "printer_template"
        ? await inspectTemplate(await readFile(path))
        : await inspectPdf(path);
    return { ...base, inspection: facts };
  }
  if (entry.mime.startsWith("image/")) {
    return { ...base, inspection: await inspectImage(entry, path) };
  }
  throw new ArchiveValidationError(
    "IMPORT_ARCHIVE_MEDIA_KIND_UNSUPPORTED",
    "media",
  );
}

async function inspectImage(
  entry: ManifestMediaEntry,
  path: string,
): Promise<PortabilityValidatedMediaFacts["inspection"]> {
  let detected: Awaited<ReturnType<typeof fileTypeFromFile>>;
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    [detected, metadata] = await Promise.all([
      fileTypeFromFile(path),
      sharp(path, {
        failOn: "error",
        limitInputPixels: 268_402_689,
      }).metadata(),
    ]);
  } catch {
    return fail("IMPORT_ARCHIVE_IMAGE_DECODE_FAILED");
  }
  const format = imageFormat(entry, detected?.mime, metadata.format);
  if (!metadata.width || !metadata.height)
    return fail("IMPORT_ARCHIVE_IMAGE_DIMENSIONS_INVALID");
  return {
    kind: "image",
    decoded: true,
    format,
    width: metadata.width,
    height: metadata.height,
  };
}

function imageFormat(
  entry: ManifestMediaEntry,
  detectedMime: string | undefined,
  sharpFormat: string | undefined,
): "heic" | "heif" | "jpeg" | "png" | "webp" {
  const expected = expectedImageFormat(entry.mime, entry.extension);
  const detected = detectedImageFormat(
    detectedMime,
    sharpFormat,
    entry.extension,
  );
  if (!expected || detected !== expected)
    return fail("IMPORT_ARCHIVE_MEDIA_MAGIC_MISMATCH");
  return expected;
}

function expectedImageFormat(
  mime: string,
  extension: string,
): "heic" | "heif" | "jpeg" | "png" | "webp" | null {
  if (mime === "image/jpeg" && ["jpg", "jpeg"].includes(extension))
    return "jpeg";
  if (mime === "image/png" && extension === "png") return "png";
  if (mime === "image/webp" && extension === "webp") return "webp";
  if (mime === "image/heic" && extension === "heic") return "heic";
  if (mime === "image/heif" && extension === "heif") return "heif";
  return null;
}

function detectedImageFormat(
  mime: string | undefined,
  sharpFormat: string | undefined,
  extension: string,
): "heic" | "heif" | "jpeg" | "png" | "webp" | null {
  if (mime === "image/jpeg" && sharpFormat === "jpeg") return "jpeg";
  if (mime === "image/png" && sharpFormat === "png") return "png";
  if (mime === "image/webp" && sharpFormat === "webp") return "webp";
  if (
    ["image/heic", "image/heif"].includes(mime ?? "") &&
    sharpFormat === "heif"
  )
    return extension === "heic" ? "heic" : "heif";
  return null;
}

function inspectIcc(
  entry: ManifestMediaEntry,
  bytes: Buffer,
): PortabilityValidatedMediaFacts["inspection"] {
  if (entry.mime !== "application/vnd.iccprofile" || entry.extension !== "icc")
    return fail("IMPORT_ARCHIVE_ICC_METADATA_INVALID");
  try {
    const facts = inspectIccProfile(bytes);
    if (facts.checksum !== entry.sha256)
      return fail("IMPORT_ARCHIVE_ICC_CHECKSUM_MISMATCH");
    return {
      kind: "icc",
      signature: facts.signature,
      channels: facts.channels,
      profileClass: facts.profileClass,
      checksum: facts.checksum,
    };
  } catch (error) {
    if (error instanceof ArchiveValidationError) throw error;
    return fail("IMPORT_ARCHIVE_ICC_INVALID");
  }
}

async function inspectTemplate(
  bytes: Buffer,
): Promise<PortabilityValidatedMediaFacts["inspection"]> {
  try {
    await inspectCoverTemplatePdf(bytes);
    return cleanPdfFacts();
  } catch {
    return fail("IMPORT_ARCHIVE_TEMPLATE_INVALID");
  }
}

async function inspectPdf(
  path: string,
): Promise<PortabilityValidatedMediaFacts["inspection"]> {
  const detected = await fileTypeFromFile(path).catch(() => undefined);
  if (detected?.mime !== "application/pdf")
    return fail("IMPORT_ARCHIVE_PDF_MAGIC_MISMATCH");
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (info.size < 32) return fail("IMPORT_ARCHIVE_PDF_INVALID");
    const header = Buffer.alloc(Math.min(16, info.size));
    const tail = Buffer.alloc(Math.min(8192, info.size));
    await handle.read(header, 0, header.length, 0);
    await handle.read(tail, 0, tail.length, info.size - tail.length);
    if (!/^%PDF-[12]\.[0-9]/u.test(header.toString("ascii")))
      return fail("IMPORT_ARCHIVE_PDF_INVALID");
    const tailText = tail.toString("latin1");
    if (!/startxref[\s\S]*%%EOF\s*$/u.test(tailText))
      return fail("IMPORT_ARCHIVE_PDF_INVALID");
  } finally {
    await handle.close();
  }
  await assertPdfStreamSafe(path);
  await assertPdfToolFacts(path);
  return cleanPdfFacts();
}

async function assertPdfStreamSafe(path: string): Promise<void> {
  let carry = "";
  for await (const chunk of createReadStream(path)) {
    const text = carry + Buffer.from(chunk).toString("latin1");
    if (hasProhibitedPdfName(text) || hasPdfName(text, "/Encrypt"))
      return fail("IMPORT_ARCHIVE_PDF_PROHIBITED");
    carry = text.slice(-64);
  }
}

async function assertPdfToolFacts(path: string): Promise<void> {
  try {
    await runPdfTool(["--check", path]);
    const encryption = await runPdfTool(["--show-encryption", path]);
    if (!/File is not encrypted/iu.test(encryption))
      return fail("IMPORT_ARCHIVE_PDF_ENCRYPTED");
    const structure = await runPdfTool([
      "--json",
      "--json-stream-data=none",
      path,
    ]);
    if (hasProhibitedPdfName(structure))
      return fail("IMPORT_ARCHIVE_PDF_PROHIBITED");
  } catch (error) {
    if (error instanceof ArchiveValidationError) throw error;
    return fail("IMPORT_ARCHIVE_PDF_PARSE_FAILED");
  }
}

async function runPdfTool(args: readonly string[]): Promise<string> {
  const result = await run("qpdf", [...args], {
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  return `${result.stdout}\n${result.stderr}`;
}

function hasProhibitedPdfName(value: string): boolean {
  return prohibitedPdfNames.some((name) => hasPdfName(value, name));
}

function hasPdfName(value: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}(?=[\\s<>\\[\\]()/]|$)`, "u").test(value);
}

function cleanPdfFacts(): PortabilityValidatedMediaFacts["inspection"] {
  return {
    kind: "pdf",
    parseable: true,
    encrypted: false,
    prohibitedFeatureCount: 0,
  };
}

function fail(code: string): never {
  throw new ArchiveValidationError(code, "media");
}

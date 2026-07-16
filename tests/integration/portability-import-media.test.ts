import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import { inspectImportedMedia } from "../../src/portability/import-media.js";
import {
  createManifest,
  type ManifestMediaEntry,
} from "../../src/portability/manifest.js";
import { temporaryDirectory } from "../helpers/temp.js";
import { validTestIcc } from "../helpers/icc-profile.js";

const at = "2026-07-16T14:00:00.000Z";
const ids = {
  export: "01K30000000000000000000001",
  project: "01K30000000000000000000002",
  customer: "01K30000000000000000000003",
  family: "01K30000000000000000000004",
  asset: "01K30000000000000000000005",
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("imported media inspection", () => {
  it("requires image magic, declared format, and successful decode", async () => {
    const path = await stagedFile(png, "image.entry");
    await expect(
      inspectImportedMedia(mediaEntry(png), path),
    ).resolves.toMatchObject({
      inspection: { kind: "image", decoded: true, format: "png" },
    });
    await expect(
      inspectImportedMedia(
        mediaEntry(png, { mime: "image/jpeg", extension: "jpg" }),
        path,
      ),
    ).rejects.toThrow("IMPORT_ARCHIVE_MEDIA_MAGIC_MISMATCH");
    for (const format of ["heic", "heif"] as const)
      await expect(
        inspectImportedMedia(
          mediaEntry(png, { mime: `image/${format}`, extension: format }),
          path,
        ),
      ).rejects.toThrow("IMPORT_ARCHIVE_MEDIA_MAGIC_MISMATCH");
    const corrupt = Buffer.from("synthetic-not-an-image");
    await expect(
      inspectImportedMedia(
        mediaEntry(corrupt),
        await stagedFile(corrupt, "corrupt-image.entry"),
      ),
    ).rejects.toThrow("IMPORT_ARCHIVE_IMAGE_DECODE_FAILED");
  });

  it("accepts both JPEG extensions and WebP while rejecting non-media kinds", async () => {
    const source = sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    });
    const jpeg = await source.clone().jpeg().toBuffer();
    const webp = await source.clone().webp().toBuffer();
    for (const extension of ["jpg", "jpeg"] as const)
      await expect(
        inspectImportedMedia(
          mediaEntry(jpeg, { mime: "image/jpeg", extension }),
          await stagedFile(jpeg, `image-${extension}.entry`),
        ),
      ).resolves.toMatchObject({ inspection: { format: "jpeg" } });
    await expect(
      inspectImportedMedia(
        mediaEntry(webp, { mime: "image/webp", extension: "webp" }),
        await stagedFile(webp, "image-webp.entry"),
      ),
    ).resolves.toMatchObject({ inspection: { format: "webp" } });
    await expect(
      inspectImportedMedia(
        mediaEntry(png, { mime: "application/octet-stream" }),
        await stagedFile(png, "unsupported.entry"),
      ),
    ).rejects.toThrow("IMPORT_ARCHIVE_MEDIA_KIND_UNSUPPORTED");
  });

  it("requires exact ICC metadata, signature, channels, and checksum", async () => {
    const icc = validTestIcc("CMYK");
    const path = await stagedFile(icc, "profile.entry");
    await expect(
      inspectImportedMedia(
        mediaEntry(icc, {
          role: "icc_profile",
          mime: "application/vnd.iccprofile",
          extension: "icc",
        }),
        path,
      ),
    ).resolves.toMatchObject({
      inspection: {
        kind: "icc",
        signature: "acsp",
        channels: 4,
        profileClass: "output",
        checksum: sha256(icc),
      },
    });
    await expect(
      inspectImportedMedia(mediaEntry(icc, { role: "icc_profile" }), path),
    ).rejects.toThrow("IMPORT_ARCHIVE_ICC_METADATA_INVALID");
    const corrupt = Buffer.from(icc);
    corrupt.fill(0, 36, 40);
    await expect(
      inspectImportedMedia(
        mediaEntry(corrupt, {
          role: "icc_profile",
          mime: "application/vnd.iccprofile",
          extension: "icc",
        }),
        await stagedFile(corrupt, "corrupt-profile.entry"),
      ),
    ).rejects.toThrow("IMPORT_ARCHIVE_ICC_INVALID");
    await expect(
      inspectImportedMedia(
        {
          ...mediaEntry(icc, {
            role: "icc_profile",
            mime: "application/vnd.iccprofile",
            extension: "icc",
          }),
          sha256: "f".repeat(64),
        },
        path,
      ),
    ).rejects.toThrow("IMPORT_ARCHIVE_ICC_CHECKSUM_MISMATCH");
  });

  it("mechanically parses ordinary PDFs and one-page printer templates", async () => {
    const pdf = minimalPdf();
    const path = await stagedFile(pdf, "document.entry");
    const clean = {
      kind: "pdf",
      parseable: true,
      encrypted: false,
      prohibitedFeatureCount: 0,
    } as const;
    await expect(
      inspectImportedMedia(
        mediaEntry(pdf, {
          role: "pdf_preview",
          mime: "application/pdf",
          extension: "pdf",
        }),
        path,
      ),
    ).resolves.toMatchObject({ inspection: clean });
    await expect(
      inspectImportedMedia(
        mediaEntry(pdf, {
          role: "printer_template",
          mime: "application/pdf",
          extension: "pdf",
        }),
        path,
      ),
    ).resolves.toMatchObject({ inspection: clean });
  });

  it("rejects PDF spoofing, active content, malformed files, and bad templates", async () => {
    const spoof = Buffer.from("synthetic-not-a-pdf");
    await expect(
      inspectImportedMedia(
        mediaEntry(spoof, {
          role: "pdf_preview",
          mime: "application/pdf",
          extension: "pdf",
        }),
        await stagedFile(spoof, "spoof.entry"),
      ),
    ).rejects.toThrow("IMPORT_ARCHIVE_PDF_MAGIC_MISMATCH");
    const active = minimalPdf("/OpenAction 4 0 R");
    await expect(
      inspectImportedMedia(
        mediaEntry(active, {
          role: "pdf_preview",
          mime: "application/pdf",
          extension: "pdf",
        }),
        await stagedFile(active, "active.entry"),
      ),
    ).rejects.toThrow("IMPORT_ARCHIVE_PDF_PROHIBITED");
    await expect(
      inspectImportedMedia(
        mediaEntry(spoof, {
          role: "printer_template",
          mime: "application/pdf",
          extension: "pdf",
        }),
        await stagedFile(spoof, "bad-template.entry"),
      ),
    ).rejects.toThrow("IMPORT_ARCHIVE_TEMPLATE_INVALID");
  });

  it("rejects invalid PDF headers, missing EOF markers, and parser failures", async () => {
    const header = replaceBytes(minimalPdf(), "%PDF-1.4", "%PDF-3.0");
    const noEof = replaceBytes(minimalPdf(), "%%EOF", "     ");
    const badXref = replaceBytes(minimalPdf(), "xref", "xrez");
    for (const [bytes, expected, name] of [
      [header, "IMPORT_ARCHIVE_PDF_INVALID", "header"],
      [noEof, "IMPORT_ARCHIVE_PDF_INVALID", "eof"],
      [badXref, "IMPORT_ARCHIVE_PDF_PARSE_FAILED", "xref"],
    ] as const)
      await expect(
        inspectImportedMedia(
          mediaEntry(bytes, {
            role: "pdf_preview",
            mime: "application/pdf",
            extension: "pdf",
          }),
          await stagedFile(bytes, `invalid-${name}.entry`),
        ),
      ).rejects.toThrow(expected);
  });
});

async function stagedFile(bytes: Buffer, name: string): Promise<string> {
  const directory = await temporaryDirectory("hekayati-import-media-");
  cleanups.push(directory.cleanup);
  const path = join(directory.path, name);
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  return path;
}

function mediaEntry(
  bytes: Buffer,
  overrides: Partial<
    Omit<ManifestMediaEntry, "path" | "bytes" | "sha256">
  > = {},
): ManifestMediaEntry {
  const manifest = createManifest({
    appVersion: "0.1.0",
    createdAt: at,
    exportId: ids.export,
    mode: "project",
    scope: {
      kind: "project",
      projectId: ids.project,
      customerId: ids.customer,
      familyId: ids.family,
    },
    roots: [
      { kind: "customer", id: ids.customer },
      { kind: "family", id: ids.family },
      { kind: "project", id: ids.project },
    ],
    documents: [],
    media: [
      {
        namespace: "asset",
        assetId: ids.asset,
        role: "illustration",
        mime: "image/png",
        extension: "png",
        ...overrides,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      },
    ],
    snapshotHash: "f".repeat(64),
  });
  return manifest.media[0];
}

function minimalPdf(catalogExtension = ""): Buffer {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${catalogExtension} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function replaceBytes(source: Buffer, from: string, to: string): Buffer {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to))
    throw new Error("SYNTHETIC_REPLACEMENT_LENGTH_MISMATCH");
  const result = Buffer.from(source);
  const offset = result.indexOf(from, 0, "latin1");
  if (offset < 0) throw new Error("SYNTHETIC_REPLACEMENT_MISSING");
  result.write(to, offset, "latin1");
  return result;
}

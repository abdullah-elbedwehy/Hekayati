import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { canonicalJson } from "../contracts/canonical-json.js";
import type { ValidatedImportBundle } from "../domain/portability/import-validation.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const normalizedDocumentSchema = z
  .object({
    collection: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    id: z.string().min(1).max(160),
    schemaVersion: z.number().int().positive(),
    sourceSha256: hashSchema,
    normalizedSha256: hashSchema,
    migrationCount: z.number().int().nonnegative(),
    managedName: z.string().regex(/^document-[0-9]{6}\.json$/),
  })
  .strict();
const imageInspectionSchema = z
  .object({
    kind: z.literal("image"),
    decoded: z.literal(true),
    format: z.enum(["heic", "heif", "jpeg", "png", "webp"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
const pdfInspectionSchema = z
  .object({
    kind: z.literal("pdf"),
    parseable: z.literal(true),
    encrypted: z.literal(false),
    prohibitedFeatureCount: z.literal(0),
  })
  .strict();
const iccInspectionSchema = z
  .object({
    kind: z.literal("icc"),
    signature: z.literal("acsp"),
    channels: z.union([z.literal(3), z.literal(4)]),
    profileClass: z.enum(["display", "output"]),
    checksum: hashSchema,
  })
  .strict();
const binaryInspectionSchema = z
  .object({ kind: z.literal("binary"), executable: z.literal(false) })
  .strict();
const validatedMediaFactsSchema = z
  .object({
    namespace: z.enum(["asset", "original"]),
    id: z.string().min(1).max(160),
    bytes: z.number().int().positive(),
    sha256: hashSchema,
    mime: z.string().min(3).max(120),
    extension: z.string().regex(/^[a-z0-9]{1,10}$/),
    role: z.string().min(1).max(80),
    inspection: z.discriminatedUnion("kind", [
      imageInspectionSchema,
      pdfInspectionSchema,
      iccInspectionSchema,
      binaryInspectionSchema,
    ]),
  })
  .strict();

export const importValidationIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    graphHash: hashSchema,
    sourceSnapshotHash: hashSchema,
    migratedDocumentCount: z.number().int().nonnegative(),
    documents: z.array(normalizedDocumentSchema).max(20_000),
    media: z.array(validatedMediaFactsSchema).max(20_000),
  })
  .strict();

export type ImportValidationIndex = z.infer<typeof importValidationIndexSchema>;

export async function writeImportValidationBundle(
  directory: string,
  bundle: ValidatedImportBundle,
): Promise<ImportValidationIndex> {
  const normalizedRoot = join(directory, "normalized");
  await mkdir(normalizedRoot, { recursive: false, mode: 0o700 });
  await chmod(normalizedRoot, 0o700);
  const documents = [];
  for (const [ordinal, item] of bundle.documents.entries()) {
    const managedName = `document-${ordinal.toString().padStart(6, "0")}.json`;
    const target = join(normalizedRoot, managedName);
    await writeFile(target, canonicalJson(item.document), {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(target, 0o600);
    documents.push({
      collection: item.collection,
      id: item.id,
      schemaVersion: item.schemaVersion,
      sourceSha256: item.sourceSha256,
      normalizedSha256: item.normalizedSha256,
      migrationCount: item.migrationCount,
      managedName,
    });
  }
  const index = importValidationIndexSchema.parse({
    schemaVersion: 1,
    graphHash: bundle.graphHash,
    sourceSnapshotHash: bundle.sourceSnapshotHash,
    migratedDocumentCount: bundle.migratedDocumentCount,
    documents,
    media: bundle.media,
  });
  const indexPath = join(directory, "validation-index.json");
  await writeFile(indexPath, canonicalJson(index), {
    flag: "wx",
    mode: 0o600,
  });
  await chmod(indexPath, 0o600);
  await syncDirectory(normalizedRoot);
  await syncDirectory(directory);
  return index;
}

export async function readImportValidationIndex(
  directory: string,
): Promise<ImportValidationIndex> {
  const path = join(directory, "validation-index.json");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600)
      throw new Error("IMPORT_VALIDATION_INDEX_IDENTITY_INVALID");
    const bytes = await readFile(handle);
    const text = bytes.toString("utf8");
    const parsed = importValidationIndexSchema.parse(JSON.parse(text));
    if (canonicalJson(parsed) !== text)
      throw new Error("IMPORT_VALIDATION_INDEX_NOT_CANONICAL");
    return parsed;
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    if (!hasCode(error, "EINVAL") && !hasCode(error, "ENOTSUP")) throw error;
  } finally {
    await handle.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

import { TextDecoder } from "node:util";

import { z } from "zod";

import { canonicalJson } from "../contracts/canonical-json.js";
import { ArchiveValidationError, ARCHIVE_POLICY_V1 } from "./archive-policy.js";
import {
  createManifest,
  parseManifestBytes,
  type ManifestV2,
} from "./manifest.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const byteSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pathSchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 240);
const v1MediaRoleSchema = z.enum([
  "reference_photo",
  "sheet_view",
  "illustration",
  "pdf_preview",
  "pdf_interior",
  "pdf_cover",
  "icc_profile",
  "printer_template",
  "print_proof",
  "thumbnail",
]);

const v1DocumentEntrySchema = z
  .object({
    kind: z.literal("document"),
    path: pathSchema,
    collection: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
    id: identifierSchema,
    schemaVersion: z.number().int().positive(),
    bytes: byteSchema,
  })
  .strict();

const v1MediaEntrySchema = z
  .object({
    kind: z.literal("media"),
    path: pathSchema,
    namespace: z.enum(["asset", "original"]),
    assetId: identifierSchema,
    role: v1MediaRoleSchema,
    mime: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/)
      .max(120),
    extension: z.string().regex(/^[a-z0-9]{1,10}$/),
    bytes: byteSchema,
  })
  .strict();

const v1RootSchema = z
  .object({
    kind: z.enum(["project", "customer", "family", "studio"]),
    id: identifierSchema,
  })
  .strict();

// Frozen HekayatiArchive/v1 assumption: v2-like metadata, one typed `entries`
// array, and one exact path-keyed checksum map. No other legacy shape is read.
export const manifestV1Schema = z
  .object({
    format: z.literal("HekayatiArchive"),
    schemaVersion: z.literal(1),
    appVersion: z.string().trim().min(1).max(120),
    createdAt: z.iso.datetime(),
    exportId: identifierSchema,
    mode: z.literal("project"),
    scope: z
      .object({
        kind: z.literal("project"),
        projectId: identifierSchema,
        customerId: identifierSchema,
        familyId: identifierSchema,
      })
      .strict(),
    roots: z.array(v1RootSchema).min(1).max(64),
    entries: z
      .array(
        z.discriminatedUnion("kind", [
          v1DocumentEntrySchema,
          v1MediaEntrySchema,
        ]),
      )
      .min(1)
      .max(ARCHIVE_POLICY_V1.maxEntries - 1),
    checksums: z.record(pathSchema, hashSchema),
    totalUncompressedBytes: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    snapshotHash: hashSchema,
  })
  .strict()
  .superRefine(validateV1Invariants);

export type ManifestV1 = z.infer<typeof manifestV1Schema>;

export interface NormalizedImportManifest {
  sourceVersion: 1 | 2;
  manifest: ManifestV2;
  migrated: boolean;
}

export function normalizeImportManifestBytes(
  bytes: Uint8Array,
): NormalizedImportManifest {
  if (bytes.byteLength > ARCHIVE_POLICY_V1.maxManifestBytes)
    fail("IMPORT_ARCHIVE_MANIFEST_LIMIT");
  const text = decodeUtf8(bytes);
  const raw = parseJson(text);
  const version = detectVersion(raw);
  if (version === 2) {
    try {
      return {
        sourceVersion: 2,
        manifest: parseManifestBytes(bytes),
        migrated: false,
      };
    } catch {
      return fail("IMPORT_ARCHIVE_MANIFEST_INVALID");
    }
  }
  if (canonicalJson(raw) !== text)
    fail("IMPORT_ARCHIVE_MANIFEST_NOT_CANONICAL");
  let legacy: ManifestV1;
  try {
    legacy = manifestV1Schema.parse(raw);
  } catch {
    return fail("IMPORT_ARCHIVE_V1_INVALID");
  }
  return {
    sourceVersion: 1,
    manifest: migrateManifestV1(legacy),
    migrated: true,
  };
}

export function migrateManifestV1(legacy: ManifestV1): ManifestV2 {
  const documents = legacy.entries
    .filter(
      (entry): entry is ManifestV1["entries"][number] & { kind: "document" } =>
        entry.kind === "document",
    )
    .map((entry) => ({
      collection: entry.collection,
      id: entry.id,
      schemaVersion: entry.schemaVersion,
      bytes: entry.bytes,
      sha256: legacy.checksums[entry.path],
    }));
  const media = legacy.entries
    .filter(
      (entry): entry is ManifestV1["entries"][number] & { kind: "media" } =>
        entry.kind === "media",
    )
    .map((entry) => ({
      namespace: entry.namespace,
      assetId: entry.assetId,
      role: entry.role,
      mime: entry.mime,
      extension: entry.extension,
      bytes: entry.bytes,
      sha256: legacy.checksums[entry.path],
    }));
  const migrated = createManifest({
    appVersion: legacy.appVersion,
    createdAt: legacy.createdAt,
    exportId: legacy.exportId,
    mode: legacy.mode,
    scope: legacy.scope,
    roots: legacy.roots,
    documents,
    media,
    snapshotHash: legacy.snapshotHash,
  });
  for (const entry of legacy.entries) {
    const migratedEntry = [...migrated.documents, ...migrated.media].find(
      (candidate) => candidate.path === entry.path,
    );
    if (!migratedEntry || migratedEntry.sha256 !== legacy.checksums[entry.path])
      fail("IMPORT_ARCHIVE_V1_MIGRATION_MISMATCH");
  }
  return migrated;
}

function validateV1Invariants(
  manifest: ManifestV1,
  context: z.RefinementCtx,
): void {
  const paths = manifest.entries.map((entry) => entry.path);
  const checksumPaths = Object.keys(manifest.checksums).sort();
  if (
    new Set(paths).size !== paths.length ||
    new Set(paths.map((path) => path.toLocaleLowerCase("en-US"))).size !==
      paths.length
  )
    issue(context, ["entries"], "IMPORT_ARCHIVE_V1_PATH_COLLISION");
  if (JSON.stringify([...paths].sort()) !== JSON.stringify(checksumPaths))
    issue(context, ["checksums"], "IMPORT_ARCHIVE_V1_CHECKSUM_SET_MISMATCH");
  if (sumBytes(manifest.entries) !== manifest.totalUncompressedBytes)
    issue(
      context,
      ["totalUncompressedBytes"],
      "IMPORT_ARCHIVE_V1_TOTAL_MISMATCH",
    );
  for (const entry of manifest.entries) {
    const expected =
      entry.kind === "document"
        ? `data/${entry.collection}/${entry.id}.json`
        : `media/${entry.namespace === "asset" ? "assets" : "originals"}/${manifest.checksums[entry.path]}.${entry.extension}`;
    if (entry.path !== expected)
      issue(context, ["entries"], "IMPORT_ARCHIVE_V1_PATH_INVALID");
  }
}

function detectVersion(raw: unknown): 1 | 2 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail("IMPORT_ARCHIVE_MANIFEST_INVALID");
  const value = raw as Record<string, unknown>;
  if (value.format !== "HekayatiArchive")
    return fail("IMPORT_ARCHIVE_FORMAT_UNSUPPORTED");
  if (value.manifestVersion === 2) return 2;
  if (value.schemaVersion === 1 && value.manifestVersion === undefined)
    return 1;
  const candidate = value.manifestVersion ?? value.schemaVersion;
  if (typeof candidate === "number" && candidate > 2)
    return fail("IMPORT_ARCHIVE_CREATED_BY_NEWER_VERSION");
  if (typeof candidate === "number" && candidate < 2)
    return fail("IMPORT_ARCHIVE_OLDER_VERSION_UNSUPPORTED");
  return fail("IMPORT_ARCHIVE_VERSION_MISSING");
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("IMPORT_ARCHIVE_MANIFEST_UTF8_INVALID");
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fail("IMPORT_ARCHIVE_MANIFEST_JSON_INVALID");
  }
}

function sumBytes(entries: ReadonlyArray<{ bytes: number }>): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.bytes;
    if (!Number.isSafeInteger(total)) return Number.NaN;
  }
  return total;
}

function issue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function fail(code: string): never {
  throw new ArchiveValidationError(code, "manifest");
}

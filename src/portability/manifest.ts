import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { z } from "zod";

import { canonicalJson } from "../contracts/canonical-json.js";

const sha256Pattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const collectionPattern = /^[a-z][a-z0-9_]{0,47}$/;
const extensionPattern = /^[a-z0-9]{1,10}$/;
const mimePattern = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const maxManifestBytes = 8 * 1024 * 1024;
const maxListedEntries = 19_999;

const identifierSchema = z.string().regex(identifierPattern);
const sha256Schema = z.string().regex(sha256Pattern);
const byteCountSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const archivePathSchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 240)
  .refine((value) => value.normalize("NFC") === value)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value
        .split("/")
        .some((part) => part === "" || part === "." || part === ".."),
  );

const documentEntrySchema = z
  .object({
    path: archivePathSchema,
    collection: z.string().regex(collectionPattern),
    id: identifierSchema,
    schemaVersion: z.number().int().positive(),
    bytes: byteCountSchema,
    sha256: sha256Schema,
  })
  .strict();

const exportableAssetRoleSchema = z.enum([
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

const mediaEntrySchema = z
  .object({
    path: archivePathSchema,
    namespace: z.enum(["asset", "original"]),
    assetId: identifierSchema,
    role: exportableAssetRoleSchema,
    mime: z.string().regex(mimePattern).max(120),
    extension: z.string().regex(extensionPattern),
    bytes: byteCountSchema,
    sha256: sha256Schema,
  })
  .strict();

const manifestRootSchema = z
  .object({
    kind: z.enum(["project", "customer", "family", "studio"]),
    id: identifierSchema,
  })
  .strict();

export const manifestV2Schema = z
  .object({
    format: z.literal("HekayatiArchive"),
    manifestVersion: z.literal(2),
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
    roots: z.array(manifestRootSchema).min(1).max(64),
    documents: z.array(documentEntrySchema).max(maxListedEntries),
    media: z.array(mediaEntrySchema).max(maxListedEntries),
    totalUncompressedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    snapshotHash: sha256Schema,
    manifestHash: sha256Schema,
  })
  .strict();

export type ManifestV2 = z.infer<typeof manifestV2Schema>;
export type ManifestDocumentEntry = ManifestV2["documents"][number];
export type ManifestMediaEntry = ManifestV2["media"][number];

export interface CreateManifestInput {
  appVersion: string;
  createdAt: string;
  exportId: string;
  mode: ManifestV2["mode"];
  scope: ManifestV2["scope"];
  roots: ManifestV2["roots"];
  documents: Array<Omit<ManifestDocumentEntry, "path">>;
  media: Array<Omit<ManifestMediaEntry, "path">>;
  snapshotHash: string;
}

export function createManifest(input: CreateManifestInput): ManifestV2 {
  const documents = input.documents
    .map((entry) => ({
      ...entry,
      path: `data/${entry.collection}/${entry.id}.json`,
    }))
    .sort(comparePaths);
  const media = input.media
    .map((entry) => ({
      ...entry,
      path: `media/${entry.namespace === "asset" ? "assets" : "originals"}/${entry.sha256}.${entry.extension}`,
    }))
    .sort(comparePaths);
  const roots = [...input.roots].sort((left, right) =>
    compareText(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`),
  );
  assertOrderedUniquePaths([...documents, ...media]);
  assertOrderedUniqueRoots(roots);
  if (documents.length + media.length > maxListedEntries)
    throw new Error("PORTABILITY_MANIFEST_ENTRY_LIMIT");

  const projection = {
    format: "HekayatiArchive" as const,
    manifestVersion: 2 as const,
    appVersion: input.appVersion,
    createdAt: input.createdAt,
    exportId: input.exportId,
    mode: input.mode,
    scope: input.scope,
    roots,
    documents,
    media,
    totalUncompressedBytes: sumBytes([...documents, ...media]),
    snapshotHash: input.snapshotHash,
  };
  const manifest = manifestV2Schema.parse({
    ...projection,
    manifestHash: sha256(canonicalJson(projection)),
  });
  assertManifestInvariants(manifest);
  if (Buffer.byteLength(canonicalJson(manifest), "utf8") > maxManifestBytes)
    throw new Error("PORTABILITY_MANIFEST_SIZE_LIMIT");
  return manifest;
}

export function parseManifestBytes(bytes: Uint8Array): ManifestV2 {
  if (bytes.byteLength > maxManifestBytes)
    throw new Error("PORTABILITY_MANIFEST_SIZE_LIMIT");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("PORTABILITY_MANIFEST_UTF8_INVALID");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("PORTABILITY_MANIFEST_JSON_INVALID");
  }
  const manifest = manifestV2Schema.parse(raw);
  assertManifestInvariants(manifest);
  if (canonicalJson(manifest) !== text)
    throw new Error("PORTABILITY_MANIFEST_NOT_CANONICAL");
  const { manifestHash, ...projection } = manifest;
  if (manifestHash !== sha256(canonicalJson(projection)))
    throw new Error("PORTABILITY_MANIFEST_HASH_MISMATCH");
  return manifest;
}

function assertManifestInvariants(manifest: ManifestV2): void {
  assertOrderedUniquePaths([...manifest.documents, ...manifest.media]);
  assertOrderedUniqueRoots(manifest.roots);
  if (manifest.documents.length + manifest.media.length > maxListedEntries)
    throw new Error("PORTABILITY_MANIFEST_ENTRY_LIMIT");
  if (
    manifest.totalUncompressedBytes !==
    sumBytes([...manifest.documents, ...manifest.media])
  )
    throw new Error("PORTABILITY_MANIFEST_TOTAL_MISMATCH");
  for (const entry of manifest.documents) {
    if (entry.path !== `data/${entry.collection}/${entry.id}.json`)
      throw new Error("PORTABILITY_MANIFEST_DOCUMENT_PATH_INVALID");
  }
  for (const entry of manifest.media) {
    const namespace = entry.namespace === "asset" ? "assets" : "originals";
    if (entry.path !== `media/${namespace}/${entry.sha256}.${entry.extension}`)
      throw new Error("PORTABILITY_MANIFEST_MEDIA_PATH_INVALID");
  }
}

function assertOrderedUniquePaths(
  entries: ReadonlyArray<{ path: string }>,
): void {
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length)
    throw new Error("PORTABILITY_MANIFEST_DUPLICATE_PATH");
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length)
    throw new Error("PORTABILITY_MANIFEST_PATH_COLLISION");
  for (let index = 1; index < paths.length; index += 1) {
    if (compareText(paths[index - 1], paths[index]) >= 0)
      throw new Error("PORTABILITY_MANIFEST_ORDER_INVALID");
  }
}

function assertOrderedUniqueRoots(roots: ManifestV2["roots"]): void {
  const keys = roots.map((root) => `${root.kind}:${root.id}`);
  if (new Set(keys).size !== keys.length)
    throw new Error("PORTABILITY_MANIFEST_DUPLICATE_ROOT");
  for (let index = 1; index < keys.length; index += 1) {
    if (compareText(keys[index - 1], keys[index]) >= 0)
      throw new Error("PORTABILITY_MANIFEST_ROOT_ORDER_INVALID");
  }
}

function comparePaths(left: { path: string }, right: { path: string }): number {
  return compareText(left.path, right.path);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sumBytes(entries: ReadonlyArray<{ bytes: number }>): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.bytes;
    if (!Number.isSafeInteger(total))
      throw new Error("PORTABILITY_MANIFEST_TOTAL_OVERFLOW");
  }
  return total;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

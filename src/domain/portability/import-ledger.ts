import { z } from "zod";

import { entityIdSchema, sha256Pattern } from "../library/schemas.js";

const hashSchema = z.string().regex(sha256Pattern);
const namespaceSchema = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const collectionSchema = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const safeCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/);
const bytesSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const importMappingLedgerEntrySchema = z
  .object({
    entryType: z.literal("import_mapping"),
    namespace: namespaceSchema,
    sourceId: entityIdSchema,
    targetId: entityIdSchema,
    disposition: z.enum(["fresh", "mapped_existing", "deduplicated", "alias"]),
    targetRevisionHash: hashSchema.nullable(),
  })
  .strict();

export const importConflictLedgerEntrySchema = z
  .object({
    entryType: z.literal("import_conflict"),
    conflictKind: safeCodeSchema,
    namespace: namespaceSchema,
    sourceId: entityIdSchema,
    targetId: entityIdSchema.nullable(),
    resolution: z.enum([
      "fresh_id",
      "map_existing",
      "deduplicate_exact_media",
      "replace_exact_target",
      "local_authority",
    ]),
    targetRevisionHash: hashSchema.nullable(),
  })
  .strict();

export const importWriteLedgerEntrySchema = z
  .object({
    entryType: z.literal("import_write"),
    collection: collectionSchema,
    sourceId: entityIdSchema,
    targetId: entityIdSchema,
    documentHash: hashSchema,
    disposition: z.enum(["create", "replace"]),
  })
  .strict();

export const importRebaseLedgerEntrySchema = z
  .object({
    entryType: z.literal("import_rebase"),
    collection: collectionSchema,
    sourceId: entityIdSchema,
    targetId: entityIdSchema,
    sourceDocumentHash: hashSchema,
    rebasedDocumentHash: hashSchema,
    changedFieldsHash: hashSchema,
  })
  .strict();

export const preparedMediaIntentLedgerEntrySchema = z
  .object({
    entryType: z.literal("prepared_media_intent"),
    namespace: z.enum(["asset", "original"]),
    sourceId: entityIdSchema,
    targetId: entityIdSchema,
    bytes: bytesSchema,
    sha256: hashSchema,
    metadataHash: hashSchema,
    disposition: z.enum(["prepare_new", "retain_existing"]),
  })
  .strict();

export const importAuthorizationLedgerEntrySchema = z
  .object({
    entryType: z.literal("import_authorization"),
    authorizationKind: z.enum([
      "customer_attestation",
      "local_consent",
      "book_approval",
      "print_authorization",
    ]),
    sourceId: entityIdSchema,
    targetId: entityIdSchema,
    disposition: z.enum([
      "local_authority",
      "historical",
      "preserved",
      "demoted",
    ]),
    sourceHash: hashSchema.nullable(),
    targetHash: hashSchema.nullable(),
    reasonCode: safeCodeSchema,
  })
  .strict();

export const importLedgerEntrySchemas = [
  importMappingLedgerEntrySchema,
  importConflictLedgerEntrySchema,
  importWriteLedgerEntrySchema,
  importRebaseLedgerEntrySchema,
  preparedMediaIntentLedgerEntrySchema,
  importAuthorizationLedgerEntrySchema,
] as const;

export type ImportMappingLedgerEntry = z.infer<
  typeof importMappingLedgerEntrySchema
>;
export type ImportConflictLedgerEntry = z.infer<
  typeof importConflictLedgerEntrySchema
>;
export type ImportWriteLedgerEntry = z.infer<
  typeof importWriteLedgerEntrySchema
>;
export type ImportRebaseLedgerEntry = z.infer<
  typeof importRebaseLedgerEntrySchema
>;
export type PreparedMediaIntentLedgerEntry = z.infer<
  typeof preparedMediaIntentLedgerEntrySchema
>;
export type ImportAuthorizationLedgerEntry = z.infer<
  typeof importAuthorizationLedgerEntrySchema
>;

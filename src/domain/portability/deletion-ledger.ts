import { z } from "zod";

import { entityIdSchema, sha256Pattern } from "../library/schemas.js";

const hashSchema = z.string().regex(sha256Pattern);
const safeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const safeCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/);
const collectionSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const managedKeySchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    { message: "DELETION_MANAGED_KEY_INVALID" },
  );

export const deletionDocumentLedgerEntrySchema = z
  .object({
    entryType: z.literal("deletion_document"),
    collection: collectionSchema,
    documentId: safeIdSchema,
    revisionHash: hashSchema,
  })
  .strict();

export const deletionPreservedDocumentLedgerEntrySchema = z
  .object({
    entryType: z.literal("deletion_preserved_document"),
    collection: collectionSchema,
    documentId: safeIdSchema,
    revisionHash: hashSchema,
  })
  .strict();

export const deletionJobLedgerEntrySchema = z
  .object({
    entryType: z.literal("deletion_job"),
    jobId: entityIdSchema,
    revision: countSchema,
    state: safeIdSchema,
    revisionHash: hashSchema,
  })
  .strict();

export const deletionExportLedgerEntrySchema = z
  .object({
    entryType: z.literal("deletion_export"),
    exportId: entityIdSchema,
    checksum: hashSchema,
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const deletionMediaDispositionSchema = z.enum([
  "unlink_pending",
  "shared_reference_preserved",
]);

export const deletionMediaLedgerEntrySchema = z
  .object({
    entryType: z.literal("deletion_media"),
    namespace: z.enum(["asset", "original"]),
    mediaId: entityIdSchema,
    checksum: hashSchema,
    ownedRefs: countSchema,
    referencedRefs: countSchema,
    totalRefs: countSchema,
    expectedRemainingRefs: countSchema,
    disposition: deletionMediaDispositionSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.totalRefs < entry.ownedRefs)
      context.addIssue({
        code: "custom",
        path: ["ownedRefs"],
        message: "DELETION_MEDIA_REFCOUNT_UNDERFLOW",
      });
    if (entry.expectedRemainingRefs !== entry.totalRefs - entry.ownedRefs)
      context.addIssue({
        code: "custom",
        path: ["expectedRemainingRefs"],
        message: "DELETION_MEDIA_REMAINING_REFCOUNT_MISMATCH",
      });
    const expected =
      entry.expectedRemainingRefs === 0
        ? "unlink_pending"
        : "shared_reference_preserved";
    if (entry.disposition !== expected)
      context.addIssue({
        code: "custom",
        path: ["disposition"],
        message: "DELETION_MEDIA_DISPOSITION_MISMATCH",
      });
  });

export const managedUnlinkLedgerEntrySchema = z
  .object({
    entryType: z.literal("managed_unlink"),
    namespace: z.enum(["asset", "original", "export"]),
    mediaId: entityIdSchema,
    checksum: hashSchema,
    managedKey: managedKeySchema,
    bytes: countSchema.nullable(),
    state: z.enum(["pending", "unlinked", "preserved", "blocked"]),
    attempts: countSchema,
    failureCode: safeCodeSchema.nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    if ((entry.state === "blocked") !== (entry.failureCode !== null))
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "DELETION_UNLINK_FAILURE_STATE_MISMATCH",
      });
    if (entry.state === "pending" && entry.attempts !== 0)
      context.addIssue({
        code: "custom",
        path: ["attempts"],
        message: "DELETION_UNLINK_PENDING_ATTEMPT_INVALID",
      });
    if (entry.namespace === "export" && entry.bytes === null)
      context.addIssue({
        code: "custom",
        path: ["bytes"],
        message: "DELETION_EXPORT_BYTES_REQUIRED",
      });
    if (entry.namespace !== "export" && entry.bytes !== null)
      context.addIssue({
        code: "custom",
        path: ["bytes"],
        message: "DELETION_MEDIA_BYTES_FORBIDDEN",
      });
  });

export const deletionBlockerLedgerEntrySchema = z
  .object({
    entryType: z.literal("deletion_blocker"),
    code: safeCodeSchema,
    subjectKind: safeIdSchema,
    subjectId: safeIdSchema,
  })
  .strict();

export const deletionVerificationLedgerEntrySchema = z
  .object({
    entryType: z.literal("deletion_verification"),
    checkKind: z.enum([
      "document_absent",
      "media_index_absent",
      "media_refcount",
      "managed_file_absent",
      "shared_media_preserved",
      "preserved_document_unchanged",
      "scope_absent",
    ]),
    subjectKind: safeIdSchema,
    subjectId: safeIdSchema,
    expectedHash: hashSchema.nullable(),
    expectedCount: countSchema.nullable(),
    actualCount: countSchema.nullable(),
    passed: z.boolean(),
    failureCode: safeCodeSchema.nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.passed === (entry.failureCode !== null))
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "DELETION_VERIFICATION_FAILURE_STATE_MISMATCH",
      });
  });

export const deletionReportDetailLedgerEntrySchema = z
  .object({
    entryType: z.literal("deletion_report_detail"),
    category: z.enum([
      "document",
      "canceled_job",
      "removed_media",
      "shared_media",
      "managed_export",
    ]),
    itemId: safeIdSchema,
    checksum: hashSchema.nullable(),
  })
  .strict();

export const deletionLedgerEntrySchemas = [
  deletionDocumentLedgerEntrySchema,
  deletionPreservedDocumentLedgerEntrySchema,
  deletionJobLedgerEntrySchema,
  deletionExportLedgerEntrySchema,
  deletionMediaLedgerEntrySchema,
  managedUnlinkLedgerEntrySchema,
  deletionBlockerLedgerEntrySchema,
  deletionVerificationLedgerEntrySchema,
  deletionReportDetailLedgerEntrySchema,
] as const;

export type DeletionDocumentLedgerEntry = z.infer<
  typeof deletionDocumentLedgerEntrySchema
>;
export type DeletionPreservedDocumentLedgerEntry = z.infer<
  typeof deletionPreservedDocumentLedgerEntrySchema
>;
export type DeletionJobLedgerEntry = z.infer<
  typeof deletionJobLedgerEntrySchema
>;
export type DeletionExportLedgerEntry = z.infer<
  typeof deletionExportLedgerEntrySchema
>;
export type DeletionMediaLedgerEntry = z.infer<
  typeof deletionMediaLedgerEntrySchema
>;
export type ManagedUnlinkLedgerEntry = z.infer<
  typeof managedUnlinkLedgerEntrySchema
>;
export type DeletionBlockerLedgerEntry = z.infer<
  typeof deletionBlockerLedgerEntrySchema
>;
export type DeletionVerificationLedgerEntry = z.infer<
  typeof deletionVerificationLedgerEntrySchema
>;
export type DeletionReportDetailLedgerEntry = z.infer<
  typeof deletionReportDetailLedgerEntrySchema
>;

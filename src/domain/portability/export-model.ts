import { z } from "zod";

import { entityIdSchema, sha256Pattern } from "../library/schemas.js";

const timestampSchema = z.iso.datetime();
const hashSchema = z.string().regex(sha256Pattern);
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveBytesSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const safeCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/);
const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const collectionSchema = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const roleSchema = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const mimeSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/)
  .max(120);
const extensionSchema = z.string().regex(/^[a-z0-9]{1,10}$/);
const positiveCountSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const archiveKeySchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}-[a-f0-9]{64}\.zip$/);
const documentArchiveEntrySchema = z
  .string()
  .regex(/^data\/[a-z][a-z0-9_]{0,47}\/[0-9A-HJKMNP-TV-Z]{26}\.json$/);
const mediaArchiveEntrySchema = z
  .string()
  .regex(/^media\/(?:assets|originals)\/[a-f0-9]{64}\.[a-z0-9]{1,10}$/);

const baseDocument = {
  id: entityIdSchema,
  schemaVersion: z.literal(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

export const exportOperationStateSchema = z.enum([
  "waiting_pause",
  "waiting_quiescence",
  "acquiring_lock",
  "freezing_snapshot",
  "staging",
  "packaging",
  "secret_scanning",
  "ready",
  "failed",
  "stale",
]);

export const exportOperationSchema = z
  .object({
    ...baseDocument,
    revision: countSchema,
    projectId: entityIdSchema,
    customerId: entityIdSchema,
    familyId: entityIdSchema,
    idempotencyKey: idempotencyKeySchema,
    requestHash: hashSchema,
    projectRevision: countSchema,
    state: exportOperationStateSchema,
    snapshotId: entityIdSchema.nullable(),
    snapshotHash: hashSchema.nullable(),
    documentCount: countSchema,
    mediaCount: countSchema,
    totalUncompressedBytes: countSchema,
    manifestHash: hashSchema.nullable(),
    archiveKey: archiveKeySchema.nullable(),
    archiveChecksum: hashSchema.nullable(),
    archiveBytes: positiveBytesSchema.nullable(),
    failureCode: safeCodeSchema.nullable(),
    cleanupState: z.enum(["none", "pending", "complete", "failed"]),
  })
  .strict()
  .superRefine(validateExportOperation);

export const portabilitySnapshotStateSchema = z.enum([
  "freezing",
  "frozen",
  "staging",
  "staged",
  "released",
  "failed",
]);

export const portabilitySnapshotSchema = z
  .object({
    ...baseDocument,
    revision: countSchema,
    operationId: entityIdSchema,
    projectId: entityIdSchema,
    customerId: entityIdSchema,
    familyId: entityIdSchema,
    projectRevision: countSchema,
    participantRegistryHash: hashSchema,
    state: portabilitySnapshotStateSchema,
    documentCount: countSchema,
    mediaCount: countSchema,
    totalUncompressedBytes: countSchema,
    documentRootHash: hashSchema.nullable(),
    mediaRootHash: hashSchema.nullable(),
    snapshotHash: hashSchema.nullable(),
    nextOrdinal: countSchema,
    failureCode: safeCodeSchema.nullable(),
  })
  .strict()
  .superRefine(validateSnapshot);

const snapshotEntryBase = {
  ...baseDocument,
  snapshotId: entityIdSchema,
  operationId: entityIdSchema,
  ordinal: countSchema,
};

export const snapshotDocumentEntrySchema = z
  .object({
    ...snapshotEntryBase,
    entryType: z.literal("document"),
    archiveEntry: documentArchiveEntrySchema,
    collection: collectionSchema,
    documentId: entityIdSchema,
    documentSchemaVersion: z.number().int().positive(),
    reasons: z
      .array(z.string().trim().min(1).max(240))
      .min(1)
      .max(100)
      .refine((items) => new Set(items).size === items.length),
    canonicalDocument: z
      .string()
      .min(2)
      .max(8 * 1024 * 1024),
    bytes: positiveBytesSchema,
    sha256: hashSchema,
  })
  .strict();

const portabilityMediaInputShape = {
  namespace: z.enum(["asset", "original"]),
  mediaId: entityIdSchema,
  role: roleSchema,
  mime: mimeSchema,
  extension: extensionSchema,
  bytes: positiveBytesSchema,
  sha256: hashSchema,
  occurrenceCount: positiveCountSchema,
  ownedCount: countSchema,
  referencedCount: countSchema,
  outsideScopeOccurrenceCount: countSchema,
  preHoldRefCount: positiveCountSchema,
  disposition: z.enum(["scope_only", "shared_reference_preserved"]),
};

export const portabilityMediaInputSchema = z
  .object(portabilityMediaInputShape)
  .strict()
  .superRefine(validateMediaLedger);

export const snapshotMediaEntrySchema = z
  .object({
    ...snapshotEntryBase,
    entryType: z.literal("media"),
    archiveEntry: mediaArchiveEntrySchema,
    ...portabilityMediaInputShape,
  })
  .strict()
  .superRefine(validateMediaLedger);

export const portabilitySnapshotEntrySchema = z.discriminatedUnion(
  "entryType",
  [snapshotDocumentEntrySchema, snapshotMediaEntrySchema],
);

export const portabilityMediaHoldSchema = z
  .object({
    ...baseDocument,
    snapshotId: entityIdSchema,
    operationId: entityIdSchema,
    ...portabilityMediaInputShape,
    state: z.enum(["held", "released"]),
    releasedAt: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((hold, context) => {
    validateMediaLedger(hold, context);
    if ((hold.state === "released") !== (hold.releasedAt !== null))
      context.addIssue({
        code: "custom",
        path: ["releasedAt"],
        message: "PORTABILITY_MEDIA_HOLD_STATE_MISMATCH",
      });
  });

export const managedExportSchema = z
  .object({
    ...baseDocument,
    exportId: entityIdSchema,
    operationId: entityIdSchema,
    projectId: entityIdSchema,
    customerId: entityIdSchema,
    familyId: entityIdSchema,
    archiveKey: archiveKeySchema,
    manifestVersion: z.literal(2),
    snapshotHash: hashSchema,
    manifestHash: hashSchema,
    archiveChecksum: hashSchema,
    bytes: positiveBytesSchema,
    secretScan: z
      .object({
        passed: z.literal(true),
        candidateScanPassed: z.literal(true),
        finalizedArchiveScanPassed: z.literal(true),
        scannedAt: timestampSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.id !== record.exportId)
      context.addIssue({
        code: "custom",
        path: ["exportId"],
        message: "PORTABILITY_MANAGED_EXPORT_ID_MISMATCH",
      });
    if (record.createdAt !== record.updatedAt)
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "PORTABILITY_MANAGED_EXPORT_IMMUTABLE",
      });
    if (
      record.archiveKey !== `${record.exportId}-${record.archiveChecksum}.zip`
    )
      context.addIssue({
        code: "custom",
        path: ["archiveKey"],
        message: "PORTABILITY_MANAGED_EXPORT_KEY_MISMATCH",
      });
  });

export type ExportOperation = z.infer<typeof exportOperationSchema>;
export type ExportOperationState = z.infer<typeof exportOperationStateSchema>;
export type PortabilitySnapshot = z.infer<typeof portabilitySnapshotSchema>;
export type PortabilitySnapshotEntry = z.infer<
  typeof portabilitySnapshotEntrySchema
>;
export type SnapshotDocumentEntry = z.infer<typeof snapshotDocumentEntrySchema>;
export type SnapshotMediaEntry = z.infer<typeof snapshotMediaEntrySchema>;
export type PortabilityMediaInput = z.infer<typeof portabilityMediaInputSchema>;
export type PortabilityMediaHold = z.infer<typeof portabilityMediaHoldSchema>;
export type ManagedExport = z.infer<typeof managedExportSchema>;

function validateMediaLedger(
  media: MediaLedgerCandidate,
  context: z.RefinementCtx,
): void {
  if (media.ownedCount + media.referencedCount !== media.occurrenceCount)
    issue(
      context,
      ["occurrenceCount"],
      "PORTABILITY_MEDIA_OCCURRENCE_COUNT_MISMATCH",
    );
  const disposition =
    media.outsideScopeOccurrenceCount === 0
      ? "scope_only"
      : "shared_reference_preserved";
  if (media.disposition !== disposition)
    issue(
      context,
      ["disposition"],
      "PORTABILITY_MEDIA_REFERENCE_DISPOSITION_MISMATCH",
    );
}

function validateExportOperation(
  operation: ExportOperationCandidate,
  context: z.RefinementCtx,
): void {
  const early = [
    "waiting_pause",
    "waiting_quiescence",
    "acquiring_lock",
  ].includes(operation.state);
  const afterFreeze = [
    "staging",
    "packaging",
    "secret_scanning",
    "ready",
    "stale",
  ].includes(operation.state);
  if (early && hasSnapshotSummary(operation))
    issue(context, ["snapshotId"], "PORTABILITY_EXPORT_SNAPSHOT_PREMATURE");
  if (operation.state === "freezing_snapshot") {
    if (operation.snapshotId === null || hasFrozenSummary(operation))
      issue(context, ["snapshotId"], "PORTABILITY_EXPORT_FREEZE_STATE_INVALID");
  }
  if (afterFreeze && !hasCompleteSnapshotSummary(operation))
    issue(context, ["snapshotHash"], "PORTABILITY_EXPORT_SNAPSHOT_REQUIRED");
  validateManifestAndArchive(operation, context);
  validateFailureState(operation, context);
}

function validateManifestAndArchive(
  operation: ExportOperationCandidate,
  context: z.RefinementCtx,
): void {
  const manifestRequired = [
    "packaging",
    "secret_scanning",
    "ready",
    "stale",
  ].includes(operation.state);
  if (manifestRequired !== (operation.manifestHash !== null))
    issue(
      context,
      ["manifestHash"],
      "PORTABILITY_EXPORT_MANIFEST_STATE_INVALID",
    );
  const archiveFields = [
    operation.archiveKey,
    operation.archiveChecksum,
    operation.archiveBytes,
  ];
  const archiveComplete = archiveFields.every((value) => value !== null);
  const archiveEmpty = archiveFields.every((value) => value === null);
  if (operation.state === "ready" && !archiveComplete)
    issue(context, ["archiveKey"], "PORTABILITY_EXPORT_READY_INCOMPLETE");
  if (
    operation.state !== "ready" &&
    operation.state !== "stale" &&
    !archiveEmpty
  )
    issue(context, ["archiveKey"], "PORTABILITY_EXPORT_ARCHIVE_PREMATURE");
  if (operation.state === "stale" && !archiveComplete && !archiveEmpty)
    issue(context, ["archiveKey"], "PORTABILITY_EXPORT_ARCHIVE_PARTIAL");
}

function validateFailureState(
  operation: ExportOperationCandidate,
  context: z.RefinementCtx,
): void {
  const failureState =
    operation.state === "failed" || operation.state === "stale";
  if (failureState !== (operation.failureCode !== null))
    issue(context, ["failureCode"], "PORTABILITY_EXPORT_FAILURE_STATE_INVALID");
  if (operation.state !== "failed" && operation.cleanupState !== "none")
    issue(
      context,
      ["cleanupState"],
      "PORTABILITY_EXPORT_CLEANUP_STATE_INVALID",
    );
}

function validateSnapshot(
  snapshot: SnapshotCandidate,
  context: z.RefinementCtx,
): void {
  const completeState = ["frozen", "staging", "staged", "released"].includes(
    snapshot.state,
  );
  const hashes = [
    snapshot.documentRootHash,
    snapshot.mediaRootHash,
    snapshot.snapshotHash,
  ];
  if (snapshot.state === "freezing" && !isEmptySnapshot(snapshot))
    issue(context, ["state"], "PORTABILITY_SNAPSHOT_FREEZING_STATE_INVALID");
  if (
    completeState &&
    (!hashes.every((value) => value !== null) ||
      snapshot.documentCount < 1 ||
      snapshot.nextOrdinal !== snapshot.documentCount + snapshot.mediaCount ||
      snapshot.totalUncompressedBytes < 1)
  )
    issue(context, ["snapshotHash"], "PORTABILITY_SNAPSHOT_FROZEN_INCOMPLETE");
  const failed = snapshot.state === "failed";
  if (failed !== (snapshot.failureCode !== null))
    issue(
      context,
      ["failureCode"],
      "PORTABILITY_SNAPSHOT_FAILURE_STATE_INVALID",
    );
}

interface ExportOperationCandidate {
  state: z.infer<typeof exportOperationStateSchema>;
  snapshotId: string | null;
  snapshotHash: string | null;
  documentCount: number;
  mediaCount: number;
  totalUncompressedBytes: number;
  manifestHash: string | null;
  archiveKey: string | null;
  archiveChecksum: string | null;
  archiveBytes: number | null;
  failureCode: string | null;
  cleanupState: "none" | "pending" | "complete" | "failed";
}

interface SnapshotCandidate {
  state: z.infer<typeof portabilitySnapshotStateSchema>;
  revision: number;
  documentCount: number;
  mediaCount: number;
  totalUncompressedBytes: number;
  documentRootHash: string | null;
  mediaRootHash: string | null;
  snapshotHash: string | null;
  nextOrdinal: number;
  failureCode: string | null;
}

interface MediaLedgerCandidate {
  occurrenceCount: number;
  ownedCount: number;
  referencedCount: number;
  outsideScopeOccurrenceCount: number;
  preHoldRefCount: number;
  disposition: "scope_only" | "shared_reference_preserved";
}

function hasSnapshotSummary(operation: ExportOperationCandidate): boolean {
  return operation.snapshotId !== null || hasFrozenSummary(operation);
}

function hasFrozenSummary(operation: ExportOperationCandidate): boolean {
  return (
    operation.snapshotHash !== null ||
    operation.documentCount !== 0 ||
    operation.mediaCount !== 0 ||
    operation.totalUncompressedBytes !== 0
  );
}

function hasCompleteSnapshotSummary(
  operation: ExportOperationCandidate,
): boolean {
  return (
    operation.snapshotId !== null &&
    operation.snapshotHash !== null &&
    operation.documentCount > 0 &&
    operation.totalUncompressedBytes > 0
  );
}

function isEmptySnapshot(snapshot: SnapshotCandidate): boolean {
  return (
    snapshot.revision === 0 &&
    snapshot.documentCount === 0 &&
    snapshot.mediaCount === 0 &&
    snapshot.totalUncompressedBytes === 0 &&
    snapshot.documentRootHash === null &&
    snapshot.mediaRootHash === null &&
    snapshot.snapshotHash === null &&
    snapshot.failureCode === null
  );
}

function issue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

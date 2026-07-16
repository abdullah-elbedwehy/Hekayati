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
const reservationKeySchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}\.zip$/);
const stagingKeySchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

const baseDocument = {
  id: entityIdSchema,
  schemaVersion: z.literal(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

export const importOperationStateSchema = z.enum([
  "uploaded",
  "validating",
  "plan_ready",
  "committing",
  "imported",
  "rolled_back",
  "failed",
  "cleanup_required",
]);

export const importDiskFactsSchema = z
  .object({
    freeBytes: countSchema,
    reserveBytes: countSchema,
    requiredBytes: countSchema,
    declaredUncompressedBytes: countSchema,
    newContentBytes: countSchema,
    canonicalDocumentBytes: countSchema,
  })
  .strict();

export const importMigrationSummarySchema = z
  .object({
    sourceManifestVersion: z.union([z.literal(1), z.literal(2)]),
    normalizedManifestVersion: z.literal(2),
    migratedManifest: z.boolean(),
    migratedDocumentCount: countSchema,
  })
  .strict();

export const importOperationSchema = z
  .object({
    ...baseDocument,
    revision: countSchema,
    state: importOperationStateSchema,
    reservationKey: reservationKeySchema.nullable(),
    stagingKey: stagingKeySchema.nullable(),
    sourceArchiveHash: hashSchema,
    sourceArchiveBytes: positiveBytesSchema,
    manifestVersion: z.union([z.literal(1), z.literal(2)]).nullable(),
    normalizedManifestHash: hashSchema.nullable(),
    sourceSnapshotHash: hashSchema.nullable(),
    participantRegistryHash: hashSchema.nullable(),
    archiveMode: z.literal("project").nullable(),
    documentCount: countSchema,
    mediaCount: countSchema,
    totalUncompressedBytes: countSchema,
    diskFacts: importDiskFactsSchema.nullable(),
    migrationSummary: importMigrationSummarySchema.nullable(),
    actionRefs: z
      .object({
        uploadActionId: entityIdSchema,
        latestPlanActionId: entityIdSchema.nullable(),
        commitActionId: entityIdSchema.nullable(),
      })
      .strict(),
    planId: entityIdSchema.nullable(),
    failureCode: safeCodeSchema.nullable(),
    cleanupState: z.enum(["none", "pending", "complete", "failed"]),
  })
  .strict()
  .superRefine(validateImportOperation);

export type ImportOperation = z.infer<typeof importOperationSchema>;
export type ImportOperationState = z.infer<typeof importOperationStateSchema>;
export type ImportDiskFacts = z.infer<typeof importDiskFactsSchema>;
export type ImportMigrationSummary = z.infer<
  typeof importMigrationSummarySchema
>;

function validateImportOperation(
  operation: ImportOperationCandidate,
  context: z.RefinementCtx,
): void {
  const validated = ["plan_ready", "committing", "imported"].includes(
    operation.state,
  );
  const validationSummary = [
    operation.manifestVersion,
    operation.normalizedManifestHash,
    operation.sourceSnapshotHash,
    operation.participantRegistryHash,
    operation.archiveMode,
    operation.diskFacts,
    operation.migrationSummary,
  ];
  if (validated && validationSummary.some((value) => value === null))
    issue(context, ["normalizedManifestHash"], "IMPORT_VALIDATION_REQUIRED");
  if (
    validated &&
    (operation.stagingKey === null ||
      operation.documentCount < 1 ||
      operation.totalUncompressedBytes < 1)
  )
    issue(context, ["stagingKey"], "IMPORT_STAGING_SUMMARY_REQUIRED");
  if (
    ["uploaded", "validating"].includes(operation.state) &&
    validationSummary.some((value) => value !== null)
  )
    issue(context, ["manifestVersion"], "IMPORT_VALIDATION_PREMATURE");
  if (
    operation.state === "plan_ready" &&
    (operation.planId !== null ||
      operation.actionRefs.latestPlanActionId !== null ||
      operation.actionRefs.commitActionId !== null)
  )
    issue(context, ["planId"], "IMPORT_PLAN_NOT_CREATED");
  const failed = ["failed", "rolled_back", "cleanup_required"].includes(
    operation.state,
  );
  if (failed !== (operation.failureCode !== null))
    issue(context, ["failureCode"], "IMPORT_FAILURE_STATE_MISMATCH");
  if (operation.state === "failed" && operation.reservationKey !== null)
    issue(context, ["reservationKey"], "IMPORT_FAILED_RESERVATION_RETAINED");
  if (operation.state === "failed" && operation.stagingKey !== null)
    issue(context, ["stagingKey"], "IMPORT_FAILED_STAGING_RETAINED");
}

interface ImportOperationCandidate {
  state: ImportOperationState;
  reservationKey: string | null;
  stagingKey: string | null;
  manifestVersion: 1 | 2 | null;
  normalizedManifestHash: string | null;
  sourceSnapshotHash: string | null;
  participantRegistryHash: string | null;
  archiveMode: "project" | null;
  documentCount: number;
  totalUncompressedBytes: number;
  diskFacts: ImportDiskFacts | null;
  migrationSummary: ImportMigrationSummary | null;
  actionRefs: {
    latestPlanActionId: string | null;
    commitActionId: string | null;
  };
  planId: string | null;
  failureCode: string | null;
}

function issue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

import { z } from "zod";

import { entityIdSchema, sha256Pattern } from "../library/schemas.js";
import { importCommitProgressSchema } from "./import-apply-model.js";
import { importPlanModeSchema } from "./import-plan-model.js";

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
    mode: importPlanModeSchema.nullable(),
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
    commit: importCommitProgressSchema.nullable(),
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
  const validated =
    ["plan_ready", "committing", "imported", "rolled_back"].includes(
      operation.state,
    ) ||
    (operation.state === "cleanup_required" && operation.commit !== null);
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
    ["plan_ready", "committing"].includes(operation.state) &&
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
  validatePlanBinding(operation, context);
  validateCommitBinding(operation, context);
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
  mode: z.infer<typeof importPlanModeSchema> | null;
  documentCount: number;
  totalUncompressedBytes: number;
  diskFacts: ImportDiskFacts | null;
  migrationSummary: ImportMigrationSummary | null;
  actionRefs: {
    latestPlanActionId: string | null;
    commitActionId: string | null;
  };
  planId: string | null;
  commit: z.infer<typeof importCommitProgressSchema> | null;
  failureCode: string | null;
}

function validateCommitBinding(
  operation: ImportOperationCandidate,
  context: z.RefinementCtx,
): void {
  const applyStates: readonly ImportOperationState[] = [
    "committing",
    "imported",
    "rolled_back",
    "cleanup_required",
  ];
  const commitRequired = ["committing", "imported", "rolled_back"].includes(
    operation.state,
  );
  if (commitRequired && operation.commit === null)
    issue(context, ["commit"], "IMPORT_COMMIT_BINDING_REQUIRED");
  if (operation.commit !== null && !applyStates.includes(operation.state))
    issue(context, ["commit"], "IMPORT_COMMIT_STATE_MISMATCH");
  if (operation.commit !== null && operation.planId === null)
    issue(context, ["commit"], "IMPORT_COMMIT_PLAN_REQUIRED");
  if (operation.commit !== null)
    validateCommitPhaseBinding(operation.state, operation.commit, context);
  if (
    operation.state === "committing" &&
    operation.commit !== null &&
    operation.commit.result !== null
  )
    issue(context, ["commit", "result"], "IMPORT_COMMIT_RESULT_PREMATURE");
  if (
    operation.state === "imported" &&
    operation.commit !== null &&
    operation.commit.result === null
  )
    issue(context, ["commit", "result"], "IMPORT_COMMIT_RESULT_REQUIRED");
  const actionBound = operation.actionRefs.commitActionId !== null;
  const resultBound =
    operation.commit !== null && operation.commit.result !== null;
  if (actionBound !== resultBound)
    issue(
      context,
      ["actionRefs", "commitActionId"],
      "IMPORT_COMMIT_ACTION_BINDING_MISMATCH",
    );
}

function validateCommitPhaseBinding(
  state: ImportOperationState,
  commit: NonNullable<ImportOperationCandidate["commit"]>,
  context: z.RefinementCtx,
): void {
  const allowed: Partial<
    Record<ImportOperationState, readonly (typeof commit.phase)[]>
  > = {
    committing: ["preparing", "rolling_back"],
    imported: ["graph_committed", "complete"],
    rolled_back: ["rolled_back"],
    cleanup_required: ["cleanup_required"],
  };
  if (!allowed[state]?.includes(commit.phase))
    issue(context, ["commit", "phase"], "IMPORT_COMMIT_PHASE_STATE_MISMATCH");
}

function validatePlanBinding(
  operation: ImportOperationCandidate,
  context: z.RefinementCtx,
): void {
  const values = [
    operation.mode,
    operation.planId,
    operation.actionRefs.latestPlanActionId,
  ];
  const any = values.some((value) => value !== null);
  const complete = values.every((value) => value !== null);
  if (any && !complete)
    issue(context, ["planId"], "IMPORT_PLAN_BINDING_INCOMPLETE");
  if (["uploaded", "validating"].includes(operation.state) && any)
    issue(context, ["planId"], "IMPORT_PLAN_PREMATURE");
  if (
    ["committing", "imported", "rolled_back"].includes(operation.state) &&
    !complete
  )
    issue(context, ["planId"], "IMPORT_PLAN_REQUIRED");
  if (
    operation.actionRefs.commitActionId !== null &&
    !["committing", "imported", "rolled_back", "cleanup_required"].includes(
      operation.state,
    )
  )
    issue(
      context,
      ["actionRefs", "commitActionId"],
      "IMPORT_COMMIT_ACTION_PREMATURE",
    );
}

function issue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

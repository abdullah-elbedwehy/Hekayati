import { z } from "zod";

import { entityIdSchema, sha256Pattern } from "../library/schemas.js";

const timestampSchema = z.iso.datetime();
const hashSchema = z.string().regex(sha256Pattern);
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const safeCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/);
const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);

const baseDocument = {
  id: entityIdSchema,
  schemaVersion: z.literal(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

export const deletionTargetKindSchema = z.enum(["customer", "project"]);

export const deletionTargetSchema = z
  .object({
    kind: deletionTargetKindSchema,
    id: entityIdSchema,
    customerId: entityIdSchema,
    idHash: hashSchema,
    revisionHash: hashSchema,
    displayNameHash: hashSchema,
  })
  .strict();

export const deletionCountsSchema = z
  .object({
    documents: countSchema,
    jobs: countSchema,
    exports: countSchema,
    media: countSchema,
    blockers: countSchema,
    sharedPreserved: countSchema,
    preservedDocuments: countSchema,
  })
  .strict();

export const deletionInventorySchema = z
  .object({
    ...baseDocument,
    target: deletionTargetSchema,
    participantRegistryHash: hashSchema,
    counts: deletionCountsSchema,
    inventoryPageCount: countSchema,
    inventoryLedgerRoot: hashSchema,
    blockerPageCount: countSchema,
    blockerLedgerRoot: hashSchema,
    inventoryHash: hashSchema,
  })
  .strict()
  .superRefine((inventory, context) => {
    if (inventory.createdAt !== inventory.updatedAt)
      issue(context, ["updatedAt"], "DELETION_INVENTORY_IMMUTABLE");
    if (
      (inventory.counts.blockers === 0) !==
      (inventory.blockerPageCount === 0)
    )
      issue(
        context,
        ["blockerPageCount"],
        "DELETION_BLOCKER_PAGE_COUNT_MISMATCH",
      );
  });

export const deletionOperationStateSchema = z.enum([
  "committing",
  "unlinking",
  "verifying",
  "verified",
  "cleanup_required",
]);

export const deletionOperationCountsSchema = deletionCountsSchema.extend({
  canceledJobs: countSchema,
  deletedDocuments: countSchema,
  unlinkItems: countSchema,
  failedChecks: countSchema,
});

export const deletionOperationSchema = z
  .object({
    ...baseDocument,
    revision: countSchema,
    target: deletionTargetSchema,
    inventoryId: entityIdSchema,
    inventoryHash: hashSchema,
    idempotencyKey: idempotencyKeySchema,
    requestHash: hashSchema,
    state: deletionOperationStateSchema,
    lockId: entityIdSchema,
    lockRevision: countSchema,
    counts: deletionOperationCountsSchema,
    inventoryLedgerRoot: hashSchema,
    blockerLedgerRoot: hashSchema,
    unlinkLedgerRoot: hashSchema,
    sharedPreservedLedgerRoot: hashSchema,
    verificationLedgerRoot: hashSchema,
    reportDetailLedgerRoot: hashSchema,
    reportId: entityIdSchema.nullable(),
    failureCode: safeCodeSchema.nullable(),
    verifiedAt: timestampSchema.nullable(),
  })
  .strict()
  .superRefine(validateDeletionOperation);

export const deletionReportSchema = z
  .object({
    ...baseDocument,
    operationId: entityIdSchema,
    targetKind: deletionTargetKindSchema,
    targetIdHash: hashSchema,
    inventoryId: entityIdSchema,
    inventoryHash: hashSchema,
    counts: deletionOperationCountsSchema,
    inventoryLedgerRoot: hashSchema,
    unlinkLedgerRoot: hashSchema,
    sharedPreservedLedgerRoot: hashSchema,
    verificationLedgerRoot: hashSchema,
    reportDetailLedgerRoot: hashSchema,
    verifiedAt: timestampSchema,
    failedChecks: z.literal(0),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.id !== report.operationId)
      issue(context, ["operationId"], "DELETION_REPORT_OPERATION_ID_MISMATCH");
    if (
      report.createdAt !== report.updatedAt ||
      report.createdAt !== report.verifiedAt
    )
      issue(context, ["verifiedAt"], "DELETION_REPORT_IMMUTABLE");
  });

export type DeletionTargetKind = z.infer<typeof deletionTargetKindSchema>;
export type DeletionTarget = z.infer<typeof deletionTargetSchema>;
export type DeletionCounts = z.infer<typeof deletionCountsSchema>;
export type DeletionInventory = z.infer<typeof deletionInventorySchema>;
export type DeletionOperationState = z.infer<
  typeof deletionOperationStateSchema
>;
export type DeletionOperation = z.infer<typeof deletionOperationSchema>;
export type DeletionReport = z.infer<typeof deletionReportSchema>;

function validateDeletionOperation(
  operation: z.infer<typeof deletionOperationSchema>,
  context: z.RefinementCtx,
): void {
  const verified = operation.state === "verified";
  if (verified !== (operation.verifiedAt !== null))
    issue(context, ["verifiedAt"], "DELETION_VERIFIED_TIMESTAMP_MISMATCH");
  if (verified !== (operation.reportId !== null))
    issue(context, ["reportId"], "DELETION_REPORT_STATE_MISMATCH");
  if (verified && operation.counts.failedChecks !== 0)
    issue(
      context,
      ["counts", "failedChecks"],
      "DELETION_VERIFIED_WITH_FAILURES",
    );
  if (
    (operation.state === "cleanup_required") !==
    (operation.failureCode !== null)
  )
    issue(context, ["failureCode"], "DELETION_FAILURE_STATE_MISMATCH");
}

function issue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

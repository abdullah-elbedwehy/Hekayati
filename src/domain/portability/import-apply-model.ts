import { z } from "zod";

import { assetRecordSchema } from "../../assets/asset-store.js";
import { originalAssetRecordSchema } from "../../assets/original-asset-store.js";
import { entityIdSchema, sha256Pattern } from "../library/schemas.js";
import {
  portabilityIdempotencyKeySchema,
  portabilityScopeSchema,
} from "./schemas.js";

const hashSchema = z.string().regex(sha256Pattern);
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveCountSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.iso.datetime();
const safeCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/);

export const importCommitRequestSchema = z
  .object({
    idempotencyKey: portabilityIdempotencyKeySchema,
    expectedOperationRevision: countSchema,
    planId: entityIdSchema,
    confirmationHash: hashSchema,
    finalConfirmation: z.literal(true),
  })
  .strict();

const importCommitLockSchema = z
  .object({
    id: entityIdSchema,
    mode: z.enum(["import_commit", "replace_import"]),
    phase: z.enum(["draining", "exclusive", "releasing"]),
    revision: countSchema,
    scope: portabilityScopeSchema,
  })
  .strict();

export const importCommitResultSchema = z
  .object({
    graphHash: hashSchema,
    targetRootIds: z.array(entityIdSchema).max(4),
    documentCount: countSchema,
    preparedMediaCount: countSchema,
    canceledJobCount: countSchema,
    cleanupLedgerRoot: hashSchema,
    committedAt: timestampSchema,
  })
  .strict();

export const importCommitProgressSchema = z
  .object({
    action: z.enum(["import_commit", "replace_commit"]),
    idempotencyKey: portabilityIdempotencyKeySchema,
    requestHash: hashSchema,
    expectedOperationRevision: countSchema,
    planConfirmationHash: hashSchema,
    phase: z.enum([
      "preparing",
      "graph_committed",
      "rolling_back",
      "cleanup_required",
      "complete",
      "rolled_back",
    ]),
    lock: importCommitLockSchema,
    sourceProofHash: hashSchema.nullable(),
    targetSnapshotHash: hashSchema.nullable(),
    preparedCount: countSchema,
    result: importCommitResultSchema.nullable(),
    failureCode: safeCodeSchema.nullable(),
  })
  .strict()
  .superRefine(validateCommitProgress);

const preparedImportMediaBase = {
  id: entityIdSchema,
  schemaVersion: z.literal(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  revision: countSchema,
  operationId: entityIdSchema,
  planId: entityIdSchema,
  sourceId: entityIdSchema,
  targetId: entityIdSchema,
  checksum: hashSchema,
  bytes: positiveCountSchema,
  metadataHash: hashSchema,
  managedKey: z.string().min(1).max(240),
  state: z.enum(["reserved", "written", "committed", "discarded"]),
  wasPreexisting: z.boolean(),
};

export const preparedImportMediaSchema = z
  .discriminatedUnion("namespace", [
    z
      .object({
        ...preparedImportMediaBase,
        namespace: z.literal("asset"),
        record: assetRecordSchema,
      })
      .strict(),
    z
      .object({
        ...preparedImportMediaBase,
        namespace: z.literal("original"),
        record: originalAssetRecordSchema,
      })
      .strict(),
  ])
  .superRefine((media, context) => {
    if (
      media.record.id !== media.targetId ||
      media.record.sha256 !== media.checksum ||
      media.record.bytes !== media.bytes ||
      media.managedKey !== managedKey(media.checksum, media.record.extension)
    )
      issue(context, ["record"], "IMPORT_PREPARED_MEDIA_RECORD_MISMATCH");
    if (media.revision === 0 && media.createdAt !== media.updatedAt)
      issue(context, ["updatedAt"], "IMPORT_PREPARED_MEDIA_REVISION_MISMATCH");
  });

export type ImportCommitRequest = z.infer<typeof importCommitRequestSchema>;
export type ImportCommitProgress = z.infer<typeof importCommitProgressSchema>;
export type ImportCommitResult = z.infer<typeof importCommitResultSchema>;
export type PreparedImportMedia = z.infer<typeof preparedImportMediaSchema>;

function validateCommitProgress(
  progress: z.infer<typeof importCommitProgressSchema>,
  context: z.RefinementCtx,
): void {
  const expectedMode =
    progress.action === "replace_commit" ? "replace_import" : "import_commit";
  if (progress.lock.mode !== expectedMode)
    issue(context, ["lock", "mode"], "IMPORT_COMMIT_LOCK_MODE_MISMATCH");
  if (
    progress.lock.mode === "import_commit" &&
    progress.lock.phase === "draining"
  )
    issue(context, ["lock", "phase"], "IMPORT_COMMIT_LOCK_PHASE_INVALID");
  const resultRequired = ["graph_committed", "complete"].includes(
    progress.phase,
  );
  const resultForbidden = ["preparing", "rolling_back", "rolled_back"].includes(
    progress.phase,
  );
  if (
    (resultRequired && progress.result === null) ||
    (resultForbidden && progress.result !== null)
  )
    issue(context, ["result"], "IMPORT_COMMIT_RESULT_REQUIRED");
  const failed = ["rolling_back", "cleanup_required", "rolled_back"].includes(
    progress.phase,
  );
  if (failed !== (progress.failureCode !== null))
    issue(context, ["failureCode"], "IMPORT_COMMIT_FAILURE_STATE_MISMATCH");
}

function managedKey(checksum: string, extension: string): string {
  return `${checksum.slice(0, 2)}/${checksum}.${extension}`;
}

function issue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

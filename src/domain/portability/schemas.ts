import { z } from "zod";

import { entityIdSchema, sha256Pattern } from "../library/schemas.js";

export const PORTABILITY_LEDGER_PAGE_SIZE = 256;

const timestampSchema = z.iso.datetime();
export const portabilityHashSchema = z.string().regex(sha256Pattern);
export const portabilityIdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const hashSchema = portabilityHashSchema;
const safeIdSchema = portabilityIdempotencyKeySchema;
const safeFieldSchema = z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/);
const nonnegativeIntegerSchema = z.number().int().nonnegative();

const baseDocument = {
  id: entityIdSchema,
  schemaVersion: z.literal(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

export const portabilityOperationScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("installation"), id: safeIdSchema }).strict(),
  z.object({ kind: z.literal("project"), id: entityIdSchema }).strict(),
  z
    .object({ kind: z.literal("import_operation"), id: entityIdSchema })
    .strict(),
  z
    .object({
      kind: z.literal("deletion_target"),
      id: safeIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("deletion_operation"),
      id: entityIdSchema,
    })
    .strict(),
]);

export const portabilityActionKindSchema = z.enum([
  "export_pause",
  "export_start",
  "import_upload",
  "import_plan",
  "import_commit",
  "replace_commit",
  "deletion_confirm",
  "deletion_cleanup_retry",
]);

const boundedRevisionMapSchema = boundedRecord(nonnegativeIntegerSchema);
const boundedHashMapSchema = boundedRecord(hashSchema);
const boundedCountMapSchema = boundedRecord(nonnegativeIntegerSchema);
const boundedFlagMapSchema = boundedRecord(z.boolean());

export const portabilityActionInputSchema = z
  .object({
    revisions: boundedRevisionMapSchema,
    hashes: boundedHashMapSchema,
    counts: boundedCountMapSchema,
    flags: boundedFlagMapSchema,
  })
  .strict();

const inlineActionResultSchema = z
  .object({
    kind: z.literal("inline"),
    state: safeIdSchema.nullable(),
    entityIds: z.array(safeIdSchema).max(50),
    counts: boundedCountMapSchema,
    hashes: boundedHashMapSchema,
    flags: boundedFlagMapSchema,
  })
  .strict();

const hashedActionResultSchema = z
  .object({ kind: z.literal("hash"), resultHash: hashSchema })
  .strict();

export const portabilityActionResultSchema = z.discriminatedUnion("kind", [
  inlineActionResultSchema,
  hashedActionResultSchema,
]);

export const portabilityActionSchema = z
  .object({
    ...baseDocument,
    operationScope: portabilityOperationScopeSchema,
    action: portabilityActionKindSchema,
    idempotencyKey: safeIdSchema,
    requestHash: hashSchema,
    input: portabilityActionInputSchema,
    result: portabilityActionResultSchema,
    recordedAt: timestampSchema,
  })
  .strict()
  .superRefine((action, context) => {
    if (!actionScopeMatches(action.action, action.operationScope.kind)) {
      context.addIssue({
        code: "custom",
        path: ["operationScope", "kind"],
        message: "PORTABILITY_ACTION_SCOPE_MISMATCH",
      });
    }
    if (
      action.createdAt !== action.recordedAt ||
      action.updatedAt !== action.recordedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["recordedAt"],
        message: "PORTABILITY_ACTION_TIMESTAMP_MISMATCH",
      });
    }
  });

export const portabilityLedgerKindSchema = z.enum([
  "captured_attempts",
  "snapshot_index",
  "import_id_map",
  "import_conflicts",
  "import_writes",
  "import_releases",
  "import_rebases",
  "prepared_media",
  "deletion_inventory",
  "deletion_unlinks",
  "shared_preservation",
  "deletion_verification",
  "report_detail",
]);

const capturedAttemptEntrySchema = z
  .object({
    entryType: z.literal("job_attempt"),
    jobId: entityIdSchema,
    attempt: z.number().int().positive(),
  })
  .strict();

const documentLedgerEntrySchema = z
  .object({
    entryType: z.literal("document"),
    collection: z.string().regex(/^[a-z][a-z0-9_]*$/),
    documentId: safeIdSchema,
    reasonCode: safeIdSchema,
    schemaVersion: z.number().int().positive(),
    bytes: nonnegativeIntegerSchema,
    sha256: hashSchema,
  })
  .strict();

const mediaLedgerFields = {
  namespace: z.enum(["asset", "original", "managed_export"]),
  mediaId: safeIdSchema,
  role: safeIdSchema,
  bytes: nonnegativeIntegerSchema,
  sha256: hashSchema,
};

const mediaLedgerEntrySchema = z
  .object({ entryType: z.literal("media"), ...mediaLedgerFields })
  .strict();

const mappingLedgerEntrySchema = z
  .object({
    entryType: z.literal("mapping"),
    entityKind: safeIdSchema,
    sourceId: safeIdSchema,
    targetId: safeIdSchema,
  })
  .strict();

const referenceDeltaLedgerEntrySchema = z
  .object({
    entryType: z.literal("reference_delta"),
    ...mediaLedgerFields,
    delta: z.number().int().min(-1_000_000).max(1_000_000),
    disposition: z.enum([
      "retained",
      "release_pending",
      "unlink_pending",
      "shared_reference_preserved",
      "verified",
    ]),
  })
  .strict();

const entityLedgerEntrySchema = z
  .object({
    entryType: z.literal("entity"),
    entityKind: safeIdSchema,
    entityId: safeIdSchema,
    relatedId: safeIdSchema.nullable(),
    hash: hashSchema.nullable(),
  })
  .strict();

export const portabilityLedgerEntrySchema = z.discriminatedUnion("entryType", [
  capturedAttemptEntrySchema,
  documentLedgerEntrySchema,
  mediaLedgerEntrySchema,
  mappingLedgerEntrySchema,
  referenceDeltaLedgerEntrySchema,
  entityLedgerEntrySchema,
]);

export const portabilityLedgerPageSchema = z
  .object({
    ...baseDocument,
    operationId: entityIdSchema,
    ledgerKind: portabilityLedgerKindSchema,
    pageIndex: nonnegativeIntegerSchema,
    entries: z
      .array(portabilityLedgerEntrySchema)
      .min(1)
      .max(PORTABILITY_LEDGER_PAGE_SIZE),
    pageHash: hashSchema,
  })
  .strict()
  .superRefine((page, context) => {
    const onlyCapturedAttempts = page.entries.every(
      (entry) => entry.entryType === "job_attempt",
    );
    const containsCapturedAttempt = page.entries.some(
      (entry) => entry.entryType === "job_attempt",
    );
    if (
      (page.ledgerKind === "captured_attempts" && !onlyCapturedAttempts) ||
      (page.ledgerKind !== "captured_attempts" && containsCapturedAttempt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "PORTABILITY_LEDGER_ENTRY_KIND_MISMATCH",
      });
    }
  });

const customerScopeSchema = z
  .object({
    kind: z.literal("customer"),
    id: entityIdSchema,
    customerId: entityIdSchema,
  })
  .strict()
  .refine((scope) => scope.id === scope.customerId, {
    path: ["id"],
    message: "PORTABILITY_CUSTOMER_SCOPE_ID_MISMATCH",
  });

const projectScopeSchema = z
  .object({
    kind: z.literal("project"),
    id: entityIdSchema,
    customerId: entityIdSchema,
    projectId: entityIdSchema,
  })
  .strict()
  .refine((scope) => scope.id === scope.projectId, {
    path: ["id"],
    message: "PORTABILITY_PROJECT_SCOPE_ID_MISMATCH",
  });

const templateCatalogScopeSchema = z
  .object({
    kind: z.literal("template_catalog"),
    id: z.literal("template_catalog"),
  })
  .strict();

export const portabilityScopeSchema = z.union([
  customerScopeSchema,
  projectScopeSchema,
  templateCatalogScopeSchema,
]);

export const portabilityScopeLockModeSchema = z.enum([
  "export_snapshot",
  "import_commit",
  "replace_import",
  "permanent_delete",
]);

export const portabilityScopeLockPhaseSchema = z.enum([
  "draining",
  "snapshot",
  "exclusive",
  "releasing",
]);

export const portabilityScopeLockSchema = z
  .object({
    ...baseDocument,
    operationId: entityIdSchema,
    scope: portabilityScopeSchema,
    mode: portabilityScopeLockModeSchema,
    phase: portabilityScopeLockPhaseSchema,
    revision: nonnegativeIntegerSchema,
    capturedAttemptLedgerRoot: hashSchema,
    capturedAttemptCount: nonnegativeIntegerSchema,
    acquiredAt: timestampSchema,
  })
  .strict()
  .superRefine((lock, context) => {
    if (lock.createdAt !== lock.acquiredAt) {
      context.addIssue({
        code: "custom",
        path: ["acquiredAt"],
        message: "PORTABILITY_LOCK_ACQUIRED_AT_MISMATCH",
      });
    }
    if (lock.mode === "export_snapshot" && lock.scope.kind !== "project") {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "PORTABILITY_EXPORT_PROJECT_SCOPE_REQUIRED",
      });
    }
    if (lock.mode === "replace_import" && lock.scope.kind !== "project") {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "PORTABILITY_REPLACE_PROJECT_SCOPE_REQUIRED",
      });
    }
    if (
      lock.mode === "permanent_delete" &&
      lock.scope.kind !== "customer" &&
      lock.scope.kind !== "project"
    ) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "PORTABILITY_DELETE_TARGET_SCOPE_REQUIRED",
      });
    }
  });

export type PortabilityAction = z.infer<typeof portabilityActionSchema>;
export type PortabilityActionInput = z.infer<
  typeof portabilityActionInputSchema
>;
export type PortabilityActionKind = z.infer<typeof portabilityActionKindSchema>;
export type PortabilityActionResult = z.infer<
  typeof portabilityActionResultSchema
>;
export type PortabilityOperationScope = z.infer<
  typeof portabilityOperationScopeSchema
>;
export type PortabilityLedgerEntry = z.infer<
  typeof portabilityLedgerEntrySchema
>;
export type PortabilityLedgerKind = z.infer<typeof portabilityLedgerKindSchema>;
export type PortabilityLedgerPage = z.infer<typeof portabilityLedgerPageSchema>;
export type PortabilityScope = z.infer<typeof portabilityScopeSchema>;
export type PortabilityScopeLock = z.infer<typeof portabilityScopeLockSchema>;
export type PortabilityScopeLockMode = z.infer<
  typeof portabilityScopeLockModeSchema
>;
export type PortabilityScopeLockPhase = z.infer<
  typeof portabilityScopeLockPhaseSchema
>;

function boundedRecord<T extends z.ZodType>(value: T) {
  return z
    .record(safeFieldSchema, value)
    .refine((record) => Object.keys(record).length <= 32, {
      message: "PORTABILITY_BOUNDED_RECORD_EXCEEDED",
    });
}

function actionScopeMatches(
  action: PortabilityActionKind,
  scopeKind: PortabilityOperationScope["kind"],
): boolean {
  if (action === "export_pause" || action === "export_start")
    return scopeKind === "project";
  if (action === "import_upload") return scopeKind === "installation";
  if (
    action === "import_plan" ||
    action === "import_commit" ||
    action === "replace_commit"
  )
    return scopeKind === "import_operation";
  if (action === "deletion_confirm") return scopeKind === "deletion_target";
  return scopeKind === "deletion_operation";
}

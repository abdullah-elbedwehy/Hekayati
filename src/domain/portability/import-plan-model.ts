import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../../contracts/canonical-json.js";
import { entityIdSchema, sha256Pattern } from "../library/schemas.js";

const timestampSchema = z.iso.datetime();
const hashSchema = z.string().regex(sha256Pattern);
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const namespaceSchema = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);

const baseDocument = {
  id: entityIdSchema,
  schemaVersion: z.literal(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

export const importPlanModeSchema = z.enum([
  "as_new_project",
  "replace_existing",
  "characters_only",
  "templates_only",
]);

export const importCustomerResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create_from_archive") }).strict(),
  z
    .object({
      kind: z.literal("map_existing_same_customer"),
      targetCustomerId: entityIdSchema,
      targetFamilyId: entityIdSchema,
      targetCustomerRevisionHash: hashSchema,
      targetFamilyRevisionHash: hashSchema,
      sameRealCustomerAttested: z.boolean(),
    })
    .strict(),
]);

export const importExplicitMappingSchema = z
  .object({
    namespace: namespaceSchema,
    sourceId: entityIdSchema,
    targetId: entityIdSchema,
    targetRevisionHash: hashSchema,
  })
  .strict();

const replaceTargetSchema = z
  .object({
    projectId: entityIdSchema,
    projectRevision: countSchema,
    projectRevisionHash: hashSchema,
    destructiveScopeConfirmed: z.boolean(),
  })
  .strict();

export const importPlanRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    expectedOperationRevision: countSchema,
    mode: importPlanModeSchema,
    sourceRoot: z
      .object({
        projectId: entityIdSchema,
        customerId: entityIdSchema,
        familyId: entityIdSchema,
      })
      .strict(),
    customerResolution: importCustomerResolutionSchema.nullable(),
    replaceTarget: replaceTargetSchema.nullable(),
    selectedCharacterIds: z.array(entityIdSchema).max(10_000),
    selectedTemplateIds: z.array(entityIdSchema).max(10_000),
    templateCatalogRevisionHash: hashSchema.nullable(),
    explicitMappings: z.array(importExplicitMappingSchema).max(20_000),
    approvalPolicy: z.enum(["preserve_if_proven", "demote"]),
  })
  .strict()
  .superRefine(validatePlanRequest);

const importLedgerRootSchema = z
  .object({
    pageCount: countSchema,
    entryCount: countSchema,
    rootHash: hashSchema,
  })
  .strict()
  .superRefine((root, context) => {
    if ((root.entryCount === 0) !== (root.pageCount === 0))
      issue(context, ["pageCount"], "IMPORT_PLAN_LEDGER_PAGE_COUNT_MISMATCH");
    if (root.pageCount > Math.ceil(root.entryCount / 256))
      issue(context, ["pageCount"], "IMPORT_PLAN_LEDGER_PAGE_COUNT_MISMATCH");
  });

export const importPlanLedgerRootsSchema = z
  .object({
    importIdMap: importLedgerRootSchema,
    importConflicts: importLedgerRootSchema,
    importWrites: importLedgerRootSchema,
    importReleases: importLedgerRootSchema,
    importRebases: importLedgerRootSchema,
    preparedMedia: importLedgerRootSchema,
    importAuthorizations: importLedgerRootSchema,
  })
  .strict();

const planTargetSchema = z
  .object({
    kind: z.enum([
      "new_project",
      "replace_project",
      "character_library",
      "template_catalog",
    ]),
    customerId: entityIdSchema.nullable(),
    familyId: entityIdSchema.nullable(),
    projectId: entityIdSchema.nullable(),
    customerRevisionHash: hashSchema.nullable(),
    familyRevisionHash: hashSchema.nullable(),
    projectRevision: countSchema.nullable(),
    projectRevisionHash: hashSchema.nullable(),
    templateCatalogRevisionHash: hashSchema.nullable(),
  })
  .strict();

const plannedCustomerResolutionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create_from_archive"),
      attestationHash: z.null(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("map_existing_same_customer"),
      attestationHash: hashSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("not_applicable"), attestationHash: z.null() })
    .strict(),
]);

export const importPlanCountsSchema = z
  .object({
    mappings: countSchema,
    conflicts: countSchema,
    writes: countSchema,
    releases: countSchema,
    rebases: countSchema,
    preparedMedia: countSchema,
    authorizations: countSchema,
    approvalsPreserved: countSchema,
    approvalsDemoted: countSchema,
    jobsPaused: countSchema,
  })
  .strict();

const importPlanCoreSchema = z
  .object({
    ...baseDocument,
    operationId: entityIdSchema,
    operationRevision: countSchema,
    mode: importPlanModeSchema,
    source: z
      .object({
        archiveHash: hashSchema,
        normalizedManifestHash: hashSchema,
        snapshotHash: hashSchema,
        participantRegistryHash: hashSchema,
        graphHash: hashSchema,
        projectId: entityIdSchema,
        customerId: entityIdSchema,
        familyId: entityIdSchema,
      })
      .strict(),
    target: planTargetSchema,
    customerResolution: plannedCustomerResolutionSchema,
    conflictChoicesHash: hashSchema,
    diskFactsHash: hashSchema,
    migrationFactsHash: hashSchema,
    sanitizationFactsHash: hashSchema,
    counts: importPlanCountsSchema,
    ledgerRoots: importPlanLedgerRootsSchema,
  })
  .strict();

export const importPlanSchema = importPlanCoreSchema
  .extend({ confirmationHash: hashSchema })
  .strict()
  .superRefine((plan, context) => {
    if (plan.createdAt !== plan.updatedAt)
      issue(context, ["updatedAt"], "IMPORT_PLAN_IMMUTABLE");
    assertLedgerCounts(plan, context);
    const { confirmationHash, ...core } = plan;
    if (confirmationHash !== hashImportPlanConfirmation(core))
      issue(
        context,
        ["confirmationHash"],
        "IMPORT_PLAN_CONFIRMATION_HASH_MISMATCH",
      );
  });

export type ImportPlanMode = z.infer<typeof importPlanModeSchema>;
export type ImportPlanRequest = z.infer<typeof importPlanRequestSchema>;
export type ImportCustomerResolution = z.infer<
  typeof importCustomerResolutionSchema
>;
export type ImportExplicitMapping = z.infer<typeof importExplicitMappingSchema>;
export type ImportPlanLedgerRoots = z.infer<typeof importPlanLedgerRootsSchema>;
export type ImportPlan = z.infer<typeof importPlanSchema>;
export type ImportPlanCore = z.infer<typeof importPlanCoreSchema>;

export function hashImportPlanConfirmation(plan: ImportPlanCore): string {
  const parsed = importPlanCoreSchema.parse(plan);
  return createHash("sha256")
    .update("HekayatiImportPlanConfirmation/v1\n")
    .update(canonicalJson(parsed))
    .digest("hex");
}

function validatePlanRequest(
  request: z.infer<typeof importPlanRequestSchema>,
  context: z.RefinementCtx,
): void {
  validateSelectionUniqueness(request, context);
  validateCustomerRequirement(request, context);
  validateReplaceRequirement(request, context);
  validateModeSelections(request, context);
}

type PlanRequest = z.infer<typeof importPlanRequestSchema>;

function validateSelectionUniqueness(
  request: PlanRequest,
  context: z.RefinementCtx,
): void {
  assertUnique(request.selectedCharacterIds, context, ["selectedCharacterIds"]);
  assertUnique(request.selectedTemplateIds, context, ["selectedTemplateIds"]);
  const mappings = request.explicitMappings.map(
    (mapping) => `${mapping.namespace}:${mapping.sourceId}`,
  );
  assertUnique(mappings, context, ["explicitMappings"]);
}

function validateCustomerRequirement(
  request: PlanRequest,
  context: z.RefinementCtx,
): void {
  if (request.mode === "templates_only") {
    if (request.customerResolution !== null)
      issue(context, ["customerResolution"], "IMPORT_PLAN_CUSTOMER_FORBIDDEN");
  } else if (request.customerResolution === null) {
    issue(context, ["customerResolution"], "IMPORT_PLAN_CUSTOMER_REQUIRED");
  }
  if (
    request.customerResolution?.kind === "map_existing_same_customer" &&
    !request.customerResolution.sameRealCustomerAttested
  )
    issue(
      context,
      ["customerResolution", "sameRealCustomerAttested"],
      "IMPORT_PLAN_SAME_CUSTOMER_ATTESTATION_REQUIRED",
    );
}

function validateReplaceRequirement(
  request: PlanRequest,
  context: z.RefinementCtx,
): void {
  if (request.mode === "replace_existing") {
    if (!request.replaceTarget)
      issue(context, ["replaceTarget"], "IMPORT_PLAN_REPLACE_TARGET_REQUIRED");
    if (request.customerResolution?.kind !== "map_existing_same_customer")
      issue(
        context,
        ["customerResolution"],
        "IMPORT_PLAN_REPLACE_EXISTING_CUSTOMER_REQUIRED",
      );
    if (
      request.replaceTarget &&
      !request.replaceTarget.destructiveScopeConfirmed
    )
      issue(
        context,
        ["replaceTarget", "destructiveScopeConfirmed"],
        "IMPORT_PLAN_REPLACE_CONFIRMATION_REQUIRED",
      );
  } else if (request.replaceTarget !== null) {
    issue(context, ["replaceTarget"], "IMPORT_PLAN_REPLACE_TARGET_FORBIDDEN");
  }
}

function validateModeSelections(
  request: PlanRequest,
  context: z.RefinementCtx,
): void {
  if (
    request.mode === "characters_only" &&
    request.selectedCharacterIds.length === 0
  )
    issue(
      context,
      ["selectedCharacterIds"],
      "IMPORT_PLAN_CHARACTER_SELECTION_REQUIRED",
    );
  if (
    request.mode !== "characters_only" &&
    request.selectedCharacterIds.length > 0
  )
    issue(
      context,
      ["selectedCharacterIds"],
      "IMPORT_PLAN_CHARACTER_SELECTION_FORBIDDEN",
    );
  validateTemplateSelection(request, context);
}

function validateTemplateSelection(
  request: PlanRequest,
  context: z.RefinementCtx,
): void {
  if (
    request.mode === "templates_only" &&
    request.selectedTemplateIds.length === 0
  )
    issue(
      context,
      ["selectedTemplateIds"],
      "IMPORT_PLAN_TEMPLATE_SELECTION_REQUIRED",
    );
  if (
    request.mode === "templates_only" &&
    request.templateCatalogRevisionHash === null
  )
    issue(
      context,
      ["templateCatalogRevisionHash"],
      "IMPORT_PLAN_TEMPLATE_REVISION_REQUIRED",
    );
  if (
    request.mode !== "templates_only" &&
    (request.selectedTemplateIds.length > 0 ||
      request.templateCatalogRevisionHash !== null)
  )
    issue(
      context,
      ["selectedTemplateIds"],
      "IMPORT_PLAN_TEMPLATE_SELECTION_FORBIDDEN",
    );
}

function assertLedgerCounts(
  plan: z.infer<typeof importPlanSchema>,
  context: z.RefinementCtx,
): void {
  const pairs = [
    ["mappings", "importIdMap"],
    ["conflicts", "importConflicts"],
    ["writes", "importWrites"],
    ["releases", "importReleases"],
    ["rebases", "importRebases"],
    ["preparedMedia", "preparedMedia"],
    ["authorizations", "importAuthorizations"],
  ] as const;
  for (const [count, root] of pairs)
    if (plan.counts[count] !== plan.ledgerRoots[root].entryCount)
      issue(context, ["counts", count], "IMPORT_PLAN_LEDGER_COUNT_MISMATCH");
}

function assertUnique(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (new Set(values).size !== values.length)
    issue(context, path, "IMPORT_PLAN_SELECTION_DUPLICATE");
}

function issue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

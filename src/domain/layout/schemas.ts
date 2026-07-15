import { z } from "zod";

import { entityIdSchema, sha256Pattern } from "../library/schemas.js";
import { matrixRowSchema } from "../creative/schemas.js";
import { projectStatusSchema } from "../authoring/schemas.js";

const timestampSchema = z.iso.datetime();
const hashSchema = z.string().regex(sha256Pattern);
const safeCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
const safeVersionSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);
const roleSchema = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const boundedTextSchema = z.string().max(8_000);
const baseDocument = {
  id: entityIdSchema,
  schemaVersion: z.literal(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};
const revisionedDocument = {
  ...baseDocument,
  revision: z.number().int().nonnegative(),
};

export const normalizedRegionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine((region) => region.x + region.width <= 1, {
    message: "REGION_WIDTH_OUT_OF_BOUNDS",
  })
  .refine((region) => region.y + region.height <= 1, {
    message: "REGION_HEIGHT_OUT_OF_BOUNDS",
  });

export const dimensionsMmSchema = z
  .object({
    width: z.number().positive().max(10_000),
    height: z.number().positive().max(10_000),
  })
  .strict();

export const textSourceSchema = z
  .object({
    role: roleSchema,
    entityId: entityIdSchema,
    versionId: entityIdSchema,
    contentHash: hashSchema,
  })
  .strict();

export const sourceAssetSchema = z
  .object({
    role: roleSchema,
    assetId: entityIdSchema,
    checksum: hashSchema,
  })
  .strict();

const textSourcesSchema = z
  .array(textSourceSchema)
  .max(100)
  .refine(uniqueRoleAndId, "DUPLICATE_TEXT_SOURCE");
const sourceAssetsSchema = z
  .array(sourceAssetSchema)
  .max(100)
  .refine(uniqueRoleAndId, "DUPLICATE_SOURCE_ASSET");

export const compositionProfileSchema = z
  .object({
    ...baseDocument,
    version: safeVersionSchema,
    trimWidthMm: z.number().positive().max(10_000),
    trimHeightMm: z.number().positive().max(10_000),
    dimensionToleranceMm: z.number().nonnegative().max(10),
    safeContentRegion: normalizedRegionSchema,
    placementRegions: z
      .object({
        top: normalizedRegionSchema,
        bottom: normalizedRegionSchema,
        right: normalizedRegionSchema,
        left: normalizedRegionSchema,
      })
      .strict(),
    typographyScale: z
      .object({
        age_3_5: z.number().positive().max(200),
        age_6_8: z.number().positive().max(200),
        age_9_12: z.number().positive().max(200),
      })
      .strict(),
    hash: hashSchema,
  })
  .strict();

export const pageLayoutHeadSchema = z
  .object({
    ...revisionedDocument,
    pageId: entityIdSchema,
    currentLayoutVersionId: entityIdSchema,
  })
  .strict()
  .refine((head) => head.id === head.pageId, {
    path: ["id"],
    message: "PAGE_LAYOUT_HEAD_ID_MISMATCH",
  });

const layoutInputCommon = {
  compositionProfileId: entityIdSchema,
  compositionProfileHash: hashSchema,
  projectVersionId: entityIdSchema,
  pageObservationRevision: z.number().int().nonnegative(),
  pageContentHash: hashSchema,
  textVersionId: entityIdSchema.nullable(),
  illustrationVersionId: entityIdSchema.nullable(),
  templateVersion: safeVersionSchema,
  compositionInputHash: hashSchema,
  textSources: textSourcesSchema,
  sourceAssets: sourceAssetsSchema,
  typographySettingsHash: hashSchema,
  fontManifestHash: hashSchema,
};

export const storyLayoutInputSnapshotSchema = z
  .object({
    ...layoutInputCommon,
    selectionSource: z.literal("not_applicable"),
    pageReviewId: entityIdSchema,
    reviewHash: hashSchema,
    compositionSourcePolicyVersion: z.null(),
  })
  .strict();

export const specialLayoutInputSnapshotSchema = z
  .object({
    ...layoutInputCommon,
    selectionSource: z.enum(["automatic_v1", "operator"]),
    pageReviewId: z.null(),
    reviewHash: z.null(),
    compositionSourcePolicyVersion: safeVersionSchema,
  })
  .strict();

export const layoutInputSnapshotSchema = z.union([
  storyLayoutInputSnapshotSchema,
  specialLayoutInputSnapshotSchema,
]);

export const layoutBubbleSchema = z
  .object({
    speakerCharacterId: entityIdSchema,
    speakerLabel: z.string().trim().min(1).max(240),
    text: boundedTextSchema,
    region: normalizedRegionSchema,
    pointerAnchor: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const layoutVersionSchema = z
  .object({
    ...baseDocument,
    pageId: entityIdSchema,
    previousVersionId: entityIdSchema.nullable(),
    inputSnapshot: layoutInputSnapshotSchema,
    requestedPlacement: z.enum(["auto", "top", "bottom", "right", "left"]),
    resolvedPlacement: z.enum(["top", "bottom", "right", "left"]),
    resolvedRegion: normalizedRegionSchema,
    readabilityAid: z.enum(["none", "gradient", "panel"]),
    fontSizePt: z.number().positive().max(200),
    overflow: z.boolean(),
    warnings: z.array(safeCodeSchema).max(100),
    acceptance: z.enum(["ready", "needs_operator"]),
    bubbles: z.array(layoutBubbleSchema).max(100),
    measurementHash: hashSchema,
    layoutPolicyVersion: safeVersionSchema,
    rendererVersion: safeVersionSchema,
    workRequestId: entityIdSchema.nullable(),
    jobId: entityIdSchema,
    layoutHash: hashSchema,
  })
  .strict()
  .superRefine((layout, context) => {
    if (layout.overflow && layout.acceptance !== "needs_operator")
      addIssue(context, ["acceptance"], "LAYOUT_OVERFLOW_NOT_BLOCKED");
    if (
      layout.requestedPlacement !== "auto" &&
      layout.requestedPlacement !== layout.resolvedPlacement
    )
      addIssue(context, ["resolvedPlacement"], "LAYOUT_PLACEMENT_MISMATCH");
  });

export const coverCompositionSchema = z
  .object({
    ...revisionedDocument,
    projectId: entityIdSchema,
    currentVersionId: entityIdSchema,
  })
  .strict()
  .refine((head) => head.id === head.projectId, {
    path: ["id"],
    message: "COVER_COMPOSITION_ID_MISMATCH",
  });

export const coverWarningSchema = z
  .object({
    code: safeCodeSchema,
    severity: z.enum(["advisory", "blocking"]),
  })
  .strict();

export const coverCompositionVersionSchema = z
  .object({
    ...baseDocument,
    projectId: entityIdSchema,
    compositionProfileId: entityIdSchema,
    compositionProfileHash: hashSchema,
    previousVersionId: entityIdSchema.nullable(),
    projectVersionId: entityIdSchema,
    compositionSourcePolicyVersion: safeVersionSchema,
    selectionSource: z.enum(["automatic_v1", "operator"]),
    textSources: textSourcesSchema,
    sourceAssets: sourceAssetsSchema,
    front: z
      .object({
        title: z.string().trim().min(1).max(240),
        childDisplayName: z.string().trim().min(1).max(240),
        environmentLine: z.string().max(1_000).nullable(),
        artworkAssetId: entityIdSchema.nullable(),
        region: normalizedRegionSchema,
      })
      .strict(),
    back: z
      .object({
        synopsis: z.string().max(4_000).nullable(),
        brandLine: z.string().max(1_000),
        artworkAssetId: entityIdSchema.nullable(),
        region: normalizedRegionSchema,
      })
      .strict(),
    brandTemplateHash: hashSchema,
    fontManifestHash: hashSchema,
    warnings: z.array(coverWarningSchema).max(100),
    acceptance: z.enum(["ready", "needs_operator"]),
    compositionHash: hashSchema,
  })
  .strict()
  .superRefine((cover, context) => {
    const blocked = cover.warnings.some(
      (warning) => warning.severity === "blocking",
    );
    if (blocked !== (cover.acceptance === "needs_operator"))
      addIssue(context, ["acceptance"], "COVER_WARNING_STATE_MISMATCH");
  });

export const previewWorkflowSchema = z
  .object({
    ...revisionedDocument,
    projectId: entityIdSchema,
    state: z.enum([
      "layout_pending",
      "operator_action_required",
      "pdf_pending",
      "rendering",
      "validating",
      "ready",
      "failed",
    ]),
    inputSnapshotHash: hashSchema,
    layoutJobIds: z.array(entityIdSchema).max(24),
    previewJobId: entityIdSchema.nullable(),
    blockingReasons: z.array(safeCodeSchema).max(100),
    currentPreviewOutputId: entityIdSchema.nullable(),
  })
  .strict()
  .refine((workflow) => workflow.id === workflow.projectId, {
    path: ["id"],
    message: "PREVIEW_WORKFLOW_ID_MISMATCH",
  });

const previewPageCommon = {
  pageId: entityIdSchema,
  pageNumber: z.number().int().min(1).max(24),
  pageObservationRevision: z.number().int().nonnegative(),
  pageContentHash: hashSchema,
  layoutVersionId: entityIdSchema,
  layoutHash: hashSchema,
  textVersionId: entityIdSchema.nullable(),
  illustrationVersionId: entityIdSchema.nullable(),
  compositionInputHash: hashSchema,
  textSources: textSourcesSchema,
  sourceAssets: sourceAssetsSchema,
};

const storyPreviewPageSchema = z
  .object({
    ...previewPageCommon,
    selectionSource: z.literal("not_applicable"),
    pageReviewId: entityIdSchema,
    reviewHash: hashSchema,
    compositionSourcePolicyVersion: z.null(),
  })
  .strict();
const specialPreviewPageSchema = z
  .object({
    ...previewPageCommon,
    selectionSource: z.enum(["automatic_v1", "operator"]),
    pageReviewId: z.null(),
    reviewHash: z.null(),
    compositionSourcePolicyVersion: safeVersionSchema,
  })
  .strict();
export const previewInteriorPageSchema = z.union([
  storyPreviewPageSchema,
  specialPreviewPageSchema,
]);

export const previewValidationPageSchema = z
  .object({
    pageNumber: z.number().int().min(1).max(26),
    mediaBoxMm: dimensionsMmSchema,
    trimBoxMm: dimensionsMmSchema.nullable(),
    portrait: z.boolean(),
    tolerancePassed: z.boolean(),
    watermarkPresent: z.boolean(),
    footerPresent: z.boolean(),
    imagePpiMin: z.number().nonnegative().max(10_000).nullable(),
    fontNames: z.array(z.string().trim().min(1).max(240)).max(20),
  })
  .strict();

export const previewValidationCheckSchema = z
  .object({
    code: safeCodeSchema,
    passed: z.boolean(),
    actual: z.string().max(500).nullable(),
  })
  .strict();

export const previewValidationReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    passed: z.boolean(),
    pageCount: z.number().int().min(1).max(26),
    expectedPageCount: z.number().int().min(18).max(26),
    interiorPageCount: z.union([z.literal(16), z.literal(24)]),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(16 * 1024 * 1024),
    pageResults: z.array(previewValidationPageSchema).min(18).max(26),
    fontNames: z.array(z.string().trim().min(1).max(240)).max(20),
    checks: z.array(previewValidationCheckSchema).max(100),
    egressRequestCount: z.literal(0),
    prohibitedPdfFeatureCount: z.literal(0),
    validatedAt: timestampSchema,
  })
  .strict()
  .superRefine((report, context) => {
    const expected = report.interiorPageCount + 2;
    if (
      report.pageCount !== expected ||
      report.expectedPageCount !== expected ||
      report.pageResults.length !== expected
    )
      addIssue(context, ["pageCount"], "PREVIEW_PAGE_COUNT_MISMATCH");
    const allChecksPassed = report.checks.every((check) => check.passed);
    if (report.passed !== allChecksPassed)
      addIssue(context, ["passed"], "PREVIEW_CHECK_STATE_MISMATCH");
  });

export const previewOutputSchema = z
  .object({
    ...revisionedDocument,
    projectId: entityIdSchema,
    assetId: entityIdSchema,
    jobId: entityIdSchema,
    approvalCycleId: entityIdSchema,
    approvalGateJobId: entityIdSchema,
    bookVersion: z.number().int().positive(),
    projectVersionId: entityIdSchema,
    compositionProfileId: entityIdSchema,
    compositionProfileHash: hashSchema,
    coverCompositionVersionId: entityIdSchema,
    customerContentHash: hashSchema,
    orderedInteriorPages: z.array(previewInteriorPageSchema).min(16).max(24),
    approvalBundleHash: hashSchema,
    pageMapHash: hashSchema,
    previewSnapshotHash: hashSchema,
    watermarkSettingsHash: hashSchema,
    previewDerivativePolicyHash: hashSchema,
    typographySettingsHash: hashSchema,
    fontManifestHash: hashSchema,
    rendererVersion: safeVersionSchema,
    validationReport: previewValidationReportSchema,
    status: z.enum(["ready", "stale"]),
    staleReasons: z.array(matrixRowSchema).max(21),
    invalidatedByEventIds: z.array(entityIdSchema).max(1_000),
  })
  .strict()
  .superRefine((output, context) => {
    const count = output.orderedInteriorPages.length;
    if (count !== 16 && count !== 24)
      addIssue(
        context,
        ["orderedInteriorPages"],
        "PREVIEW_INTERIOR_COUNT_INVALID",
      );
    if (output.validationReport.interiorPageCount !== count)
      addIssue(context, ["validationReport"], "PREVIEW_REPORT_COUNT_MISMATCH");
    if (!output.validationReport.passed)
      addIssue(context, ["validationReport"], "PREVIEW_VALIDATION_REQUIRED");
    if (output.status === "ready" && output.staleReasons.length > 0)
      addIssue(context, ["staleReasons"], "PREVIEW_STALE_STATE_MISMATCH");
    if (output.status === "stale" && output.staleReasons.length === 0)
      addIssue(context, ["staleReasons"], "PREVIEW_STALE_REASON_REQUIRED");
  });

export const bookApprovalScopeSchema = z.union([
  z.object({ kind: z.literal("page"), pageId: entityIdSchema }).strict(),
  z
    .object({
      kind: z.literal("cover"),
      side: z.enum(["front", "back", "both"]),
    })
    .strict(),
]);

export const bookApprovalCycleSchema = z
  .object({
    ...revisionedDocument,
    projectId: entityIdSchema,
    previewOutputId: entityIdSchema,
    approvalGateJobId: entityIdSchema,
    targetBookVersion: z.number().int().positive(),
    customerContentHash: hashSchema,
    approvalBundleHash: hashSchema,
    pageMapHash: hashSchema,
    previewSnapshotHash: hashSchema,
    coverCompositionVersionId: entityIdSchema,
    watermarkSettingsHash: hashSchema,
    state: z.enum([
      "ready_to_send",
      "preview_sent",
      "approved",
      "changes_requested",
      "invalidated",
    ]),
    notes: boundedTextSchema,
    affectedScopes: z.array(bookApprovalScopeSchema).max(100),
    recordedAt: timestampSchema,
    invalidatedBy: z
      .object({
        eventId: entityIdSchema,
        matrixRow: matrixRowSchema,
        at: timestampSchema,
      })
      .strict()
      .nullable(),
    attentionReasons: z.array(matrixRowSchema).max(21),
  })
  .strict()
  .superRefine((cycle, context) => {
    if (cycle.state === "changes_requested") {
      if (!cycle.notes.trim())
        addIssue(context, ["notes"], "APPROVAL_CHANGE_NOTES_REQUIRED");
      if (cycle.affectedScopes.length === 0)
        addIssue(context, ["affectedScopes"], "APPROVAL_SCOPE_REQUIRED");
    }
    if (cycle.state === "invalidated" && !cycle.invalidatedBy)
      addIssue(context, ["invalidatedBy"], "APPROVAL_INVALIDATION_REQUIRED");
    if (hasDuplicateScope(cycle.affectedScopes))
      addIssue(context, ["affectedScopes"], "APPROVAL_SCOPE_DUPLICATE");
  });

const approvalActionResultSchema = z
  .object({
    projectRevision: z.number().int().nonnegative(),
    previewOutputRevision: z.number().int().nonnegative(),
    approvalRevision: z.number().int().nonnegative(),
    gateRevision: z.number().int().nonnegative(),
    currentContentApprovalId: entityIdSchema.nullable(),
    projectStatus: projectStatusSchema,
    approvalState: bookApprovalCycleSchema.shape.state,
    gateState: z.enum(["waiting_review", "succeeded", "canceled"]),
  })
  .strict();

export const bookApprovalActionSchema = z
  .object({
    ...baseDocument,
    cycleId: entityIdSchema,
    idempotencyKey: z.string().trim().min(1).max(160),
    canonicalRequestHash: hashSchema,
    action: z.enum(["preview_sent", "approved", "changes_requested"]),
    projectRevision: z.number().int().nonnegative(),
    previewOutputRevision: z.number().int().nonnegative(),
    approvalRevision: z.number().int().nonnegative(),
    gateRevision: z.number().int().nonnegative(),
    expectedContentApprovalId: entityIdSchema.nullable(),
    expectedContentApprovalRevision: z.number().int().nonnegative().nullable(),
    previewOutputId: entityIdSchema,
    approvalGateJobId: entityIdSchema,
    customerContentHash: hashSchema,
    approvalBundleHash: hashSchema,
    normalizedNotes: boundedTextSchema,
    affectedScopes: z.array(bookApprovalScopeSchema).max(100),
    result: approvalActionResultSchema,
    recordedAt: timestampSchema,
  })
  .strict()
  .superRefine((action, context) => {
    const paired =
      (action.expectedContentApprovalId === null) ===
      (action.expectedContentApprovalRevision === null);
    if (!paired)
      addIssue(
        context,
        ["expectedContentApprovalRevision"],
        "CONTENT_APPROVAL_EXPECTATION_MISMATCH",
      );
    if (hasDuplicateScope(action.affectedScopes))
      addIssue(context, ["affectedScopes"], "APPROVAL_SCOPE_DUPLICATE");
  });

export type LayoutNormalizedRegion = z.infer<typeof normalizedRegionSchema>;
export type TextSource = z.infer<typeof textSourceSchema>;
export type SourceAsset = z.infer<typeof sourceAssetSchema>;
export type CompositionProfile = z.infer<typeof compositionProfileSchema>;
export type PageLayoutHead = z.infer<typeof pageLayoutHeadSchema>;
export type LayoutInputSnapshot = z.infer<typeof layoutInputSnapshotSchema>;
export type LayoutVersion = z.infer<typeof layoutVersionSchema>;
export type CoverComposition = z.infer<typeof coverCompositionSchema>;
export type CoverCompositionVersion = z.infer<
  typeof coverCompositionVersionSchema
>;
export type PreviewWorkflow = z.infer<typeof previewWorkflowSchema>;
export type PreviewInteriorPage = z.infer<typeof previewInteriorPageSchema>;
export type PreviewValidationReport = z.infer<
  typeof previewValidationReportSchema
>;
export type PreviewOutput = z.infer<typeof previewOutputSchema>;
export type BookApprovalScope = z.infer<typeof bookApprovalScopeSchema>;
export type BookApprovalCycle = z.infer<typeof bookApprovalCycleSchema>;
export type BookApprovalAction = z.infer<typeof bookApprovalActionSchema>;

function uniqueRoleAndId(
  values: readonly { role: string; entityId?: string; assetId?: string }[],
): boolean {
  const keys = values.map(
    (value) => `${value.role}:${value.entityId ?? value.assetId ?? ""}`,
  );
  return new Set(keys).size === keys.length;
}

function hasDuplicateScope(
  scopes: readonly z.infer<typeof bookApprovalScopeSchema>[],
) {
  const keys = scopes.map((scope) =>
    scope.kind === "page" ? `page:${scope.pageId}` : `cover:${scope.side}`,
  );
  return new Set(keys).size !== keys.length;
}

function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

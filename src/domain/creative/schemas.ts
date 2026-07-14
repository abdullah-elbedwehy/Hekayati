import { z } from "zod";

import { entityIdSchema, sha256Pattern } from "../library/schemas.js";
import { neutralProvenanceSchema as provenanceSchema } from "../../contracts/creative-generation.js";
import { creativePolicyPlanSchema } from "../../contracts/creative-policy.js";
import {
  pagePromptSchema,
  reviewFindingsSchema,
  sceneListSchema,
  storyPlanSchema,
  storyTextSchema,
} from "../../contracts/creative-outputs.js";

const timestampSchema = z.iso.datetime();
const shortTextSchema = z.string().trim().min(1).max(500);
const longTextSchema = z.string().max(12_000);
const safeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const baseDocument = {
  id: entityIdSchema,
  schemaVersion: z.literal(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};
const mutableDocument = {
  ...baseDocument,
  revision: z.number().int().nonnegative(),
};

export const matrixRowSchema = z.enum([
  "IM-01",
  "IM-02",
  "IM-03",
  "IM-04",
  "IM-05",
  "IM-06",
  "IM-07",
  "IM-08",
  "IM-09",
  "IM-10",
  "IM-11",
  "IM-12",
  "IM-13",
  "IM-14",
  "IM-15",
  "IM-16",
  "IM-17",
  "IM-18",
  "IM-19",
  "IM-20",
  "IM-21",
]);

const baseAppearanceBindingSchema = z
  .object({
    type: z.literal("base"),
    lookId: z.null(),
    lookVersionId: z.null(),
  })
  .strict();
const sharedLookAppearanceBindingSchema = z
  .object({
    type: z.literal("shared_look"),
    lookId: entityIdSchema,
    lookVersionId: entityIdSchema,
  })
  .strict();

export const appearanceBindingSchema = z.discriminatedUnion("type", [
  baseAppearanceBindingSchema,
  sharedLookAppearanceBindingSchema,
]);

export const sheetViewNameSchema = z.enum([
  "face",
  "front",
  "threeQuarter",
  "fullBody",
  "mainOutfit",
]);

export const sheetViewsSchema = z
  .object({
    face: entityIdSchema,
    front: entityIdSchema,
    threeQuarter: entityIdSchema,
    fullBody: entityIdSchema,
    mainOutfit: entityIdSchema,
  })
  .strict()
  .refine((views) => new Set(Object.values(views)).size === 5, {
    message: "SHEET_VIEW_ASSETS_MUST_BE_UNIQUE",
  });

const provenanceByViewSchema = z
  .object({
    face: provenanceSchema.optional(),
    front: provenanceSchema.optional(),
    threeQuarter: provenanceSchema.optional(),
    fullBody: provenanceSchema.optional(),
    mainOutfit: provenanceSchema.optional(),
  })
  .strict();

export const characterSheetSchema = z
  .object({
    ...mutableDocument,
    projectId: entityIdSchema,
    customerId: entityIdSchema,
    familyId: entityIdSchema,
    characterId: entityIdSchema,
    characterVersionId: entityIdSchema,
    appearance: appearanceBindingSchema,
    characterName: z.string().trim().min(1).max(240),
    views: sheetViewsSchema,
    referenceThumbnailAssetIds: z.array(entityIdSchema).max(20),
    referenceLineage: z
      .object({
        source: z.enum(["description_only", "photo_derived"]),
        referencePhotoIds: z.array(entityIdSchema).max(40),
      })
      .strict()
      .refine(
        (lineage) =>
          lineage.source === "photo_derived"
            ? lineage.referencePhotoIds.length > 0
            : lineage.referencePhotoIds.length === 0,
        { message: "SHEET_REFERENCE_LINEAGE_MISMATCH" },
      ),
    pdfAssetId: entityIdSchema,
    status: z.enum([
      "ready",
      "revision_needed",
      "approved",
      "approved_superseded",
    ]),
    priorSheetId: entityIdSchema.nullable(),
    generationJobIds: z.array(entityIdSchema).length(6),
    provenanceByView: provenanceByViewSchema,
  })
  .strict();

export const characterSheetIntentSchema = z
  .object({
    ...mutableDocument,
    sheetId: entityIdSchema,
    projectId: entityIdSchema,
    customerId: entityIdSchema,
    familyId: entityIdSchema,
    characterId: entityIdSchema,
    characterVersionId: entityIdSchema,
    appearance: appearanceBindingSchema,
    characterName: z.string().trim().min(1).max(240),
    styleId: z.enum(["modern_cartoon", "colorful_2d", "soft_watercolor"]),
    referencePhotoIds: z.array(entityIdSchema).max(40),
    referenceThumbnailAssetIds: z.array(entityIdSchema).max(40),
    referenceLineage: z.enum(["description_only", "photo_derived"]),
    revisionNotes: longTextSchema,
    status: z.enum([
      "planned",
      "generating",
      "finalizing",
      "ready",
      "rejected",
    ]),
    priorSheetId: entityIdSchema.nullable(),
    viewJobIds: z
      .object({
        face: entityIdSchema.nullable(),
        front: entityIdSchema.nullable(),
        threeQuarter: entityIdSchema.nullable(),
        fullBody: entityIdSchema.nullable(),
        mainOutfit: entityIdSchema.nullable(),
      })
      .strict(),
    finalizeJobId: entityIdSchema.nullable(),
    approvalGateJobId: entityIdSchema.nullable(),
    policyPlan: creativePolicyPlanSchema,
  })
  .strict()
  .refine(
    (intent) =>
      intent.referenceLineage === "photo_derived"
        ? intent.referencePhotoIds.length > 0
        : intent.referencePhotoIds.length === 0,
    { path: ["referenceLineage"], message: "SHEET_REFERENCE_LINEAGE_MISMATCH" },
  );

export const characterApprovalSchema = z
  .object({
    ...mutableDocument,
    projectId: entityIdSchema,
    characterId: entityIdSchema,
    characterVersionId: entityIdSchema,
    sheetId: entityIdSchema,
    state: z.enum(["approved", "changes_requested", "superseded"]),
    notes: longTextSchema,
    recordedAt: timestampSchema,
    invalidatedByEventId: entityIdSchema.nullable(),
  })
  .strict();

export const creativeNodeKindSchema = z.enum([
  "character_sheet_view",
  "character_sheet_finalize",
  "character_approval",
  "story_plan",
  "story_text",
  "scene_list",
  "page_prompt",
  "page_illustration",
  "review_findings",
  "internal_review",
]);

export const creativeRunNodeSchema = z
  .object({
    key: safeIdSchema,
    kind: creativeNodeKindSchema,
    pageNumber: z.number().int().min(1).max(20).nullable(),
    dependsOnKeys: z.array(safeIdSchema).max(100),
    intentId: safeIdSchema,
    jobId: entityIdSchema.nullable(),
    state: z.enum(["planned", "materialized", "committed", "failed"]),
  })
  .strict();

export const creativeRunSchema = z
  .object({
    ...mutableDocument,
    projectId: entityIdSchema,
    projectVersionId: entityIdSchema,
    inputStoryVersionId: entityIdSchema,
    outputStoryVersionId: entityIdSchema.nullable(),
    status: z.enum([
      "planned",
      "generating",
      "internal_review",
      "complete",
      "failed",
      "stale",
    ]),
    priority: z.number().int().min(1).max(5),
    nodes: z.array(creativeRunNodeSchema).min(1).max(500),
    textTarget: z
      .object({
        providerId: z.enum(["mock", "codex", "gemini"]),
        modelId: safeIdSchema,
        operation: z.literal("structured"),
        settingsHash: z.string().regex(sha256Pattern),
      })
      .strict(),
    imageTarget: z
      .object({
        providerId: z.enum(["mock", "gemini"]),
        modelId: safeIdSchema,
        operation: z.literal("image"),
        settingsHash: z.string().regex(sha256Pattern),
      })
      .strict(),
    textTargetHash: z.string().regex(sha256Pattern),
    imageTargetHash: z.string().regex(sha256Pattern),
    policyPlan: creativePolicyPlanSchema,
    internalReviewGateJobId: entityIdSchema.nullable(),
  })
  .strict()
  .superRefine((run, context) => {
    const keys = run.nodes.map((node) => node.key);
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        path: ["nodes"],
        message: "RUN_NODE_DUPLICATE",
      });
    const set = new Set(keys);
    run.nodes.forEach((node, index) => {
      if (node.dependsOnKeys.includes(node.key))
        context.addIssue({
          code: "custom",
          path: ["nodes", index],
          message: "RUN_NODE_SELF_DEPENDENCY",
        });
      if (node.dependsOnKeys.some((key) => !set.has(key)))
        context.addIssue({
          code: "custom",
          path: ["nodes", index],
          message: "RUN_NODE_DEPENDENCY_MISSING",
        });
    });
  });

export const stageOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("story_plan"), value: storyPlanSchema }).strict(),
  z.object({ kind: z.literal("story_text"), value: storyTextSchema }).strict(),
  z.object({ kind: z.literal("scene_list"), value: sceneListSchema }).strict(),
  z
    .object({ kind: z.literal("page_prompt"), value: pagePromptSchema })
    .strict(),
  z
    .object({ kind: z.literal("review_findings"), value: reviewFindingsSchema })
    .strict(),
]);

export const creativeStageRecordSchema = z
  .object({
    ...baseDocument,
    runId: entityIdSchema,
    projectId: entityIdSchema,
    jobId: entityIdSchema,
    pageNumber: z.number().int().min(1).max(20).nullable(),
    output: stageOutputSchema,
    outputHash: z.string().regex(sha256Pattern),
    provenance: provenanceSchema,
  })
  .strict();

export const pageKindSchema = z.enum([
  "title",
  "dedication",
  "story",
  "ending1",
  "ending2",
]);

export const pageSchema = z
  .object({
    ...mutableDocument,
    projectId: entityIdSchema,
    pageNumber: z.number().int().min(1).max(24),
    storyPageIndex: z.number().int().min(1).max(20).nullable(),
    kind: pageKindSchema,
    locked: z.boolean(),
    reviewStatus: z.enum(["unreviewed", "flagged", "approved"]),
    staleState: z.enum(["current", "stale", "locked_stale"]),
    staleReasons: z.array(matrixRowSchema).max(21),
    currentTextVersionId: entityIdSchema.nullable(),
    currentPromptVersionId: entityIdSchema.nullable(),
    currentIllustrationVersionId: entityIdSchema.nullable(),
    currentLayoutVersionId: entityIdSchema.nullable(),
  })
  .strict()
  .superRefine((page, context) => {
    const isStory = page.kind === "story";
    if (isStory !== (page.storyPageIndex !== null))
      context.addIssue({
        code: "custom",
        path: ["storyPageIndex"],
        message: "PAGE_STORY_INDEX_MISMATCH",
      });
    if (page.staleState === "current" && page.staleReasons.length > 0)
      context.addIssue({
        code: "custom",
        path: ["staleReasons"],
        message: "PAGE_STALE_REASON_MISMATCH",
      });
    if (page.staleState === "locked_stale" && !page.locked)
      context.addIssue({
        code: "custom",
        path: ["locked"],
        message: "PAGE_LOCK_STATE_MISMATCH",
      });
  });

const versionSnapshotSchema = z
  .record(safeIdSchema, entityIdSchema)
  .refine((value) => Object.keys(value).length <= 100, "TOO_MANY_VERSION_REFS");

export const pageTextVersionSchema = z
  .object({
    ...baseDocument,
    pageId: entityIdSchema,
    previousVersionId: entityIdSchema.nullable(),
    sceneVersionId: entityIdSchema,
    narrative: longTextSchema,
    dialogue: z
      .array(
        z
          .object({ speakerCharacterId: entityIdSchema, text: longTextSchema })
          .strict(),
      )
      .max(100),
    source: z.enum(["generated", "manual", "revert"]),
    inputSnapshot: versionSnapshotSchema,
  })
  .strict();

export const pagePromptVersionSchema = z
  .object({
    ...baseDocument,
    pageId: entityIdSchema,
    previousVersionId: entityIdSchema.nullable(),
    sceneVersionId: entityIdSchema,
    output: pagePromptSchema,
    styleId: z.enum(["modern_cartoon", "colorful_2d", "soft_watercolor"]),
    jobId: entityIdSchema,
    provenance: provenanceSchema,
  })
  .strict();

export const illustrationVersionSchema = z
  .object({
    ...baseDocument,
    pageId: entityIdSchema,
    previousVersionId: entityIdSchema.nullable(),
    assetId: entityIdSchema,
    promptVersionId: entityIdSchema,
    inputSnapshot: versionSnapshotSchema,
    provenance: provenanceSchema,
  })
  .strict();

export const reviewChecksSchema = z
  .object({
    identityMatchesSheet: z.boolean(),
    outfitMatchesPlan: z.boolean(),
    participantsExact: z.boolean(),
    petAnatomySafe: z.boolean(),
    ageAndRegisterAppropriate: z.boolean(),
    noInImageText: z.boolean(),
    artTextConsistent: z.boolean(),
    noSexualizedChild: z.boolean(),
    noGraphicViolence: z.boolean(),
    noDangerousInstructions: z.boolean(),
    noHumiliationOrPunishment: z.boolean(),
    noHateOrStereotypes: z.boolean(),
    noAdultThemes: z.boolean(),
    noChildBlame: z.boolean(),
    noExcessiveFear: z.boolean(),
    noCopyrightCharacter: z.boolean(),
    noLivingArtistImitation: z.boolean(),
    noContactDetails: z.boolean(),
    noCrossCustomerData: z.boolean(),
  })
  .strict();

export const pageReviewSchema = z
  .object({
    ...baseDocument,
    pageId: entityIdSchema,
    pageRevision: z.number().int().nonnegative(),
    textVersionId: entityIdSchema,
    illustrationVersionId: entityIdSchema,
    checks: reviewChecksSchema,
    notes: longTextSchema,
    completed: z.boolean(),
    recordedAt: timestampSchema,
  })
  .strict()
  .refine(
    (review) =>
      !review.completed || Object.values(review.checks).every(Boolean),
    { path: ["checks"], message: "REVIEW_CHECKLIST_INCOMPLETE" },
  );

export const layoutWorkRequestSchema = z
  .object({
    ...baseDocument,
    pageId: entityIdSchema,
    projectId: entityIdSchema,
    textVersionId: entityIdSchema,
    illustrationVersionId: entityIdSchema,
    reason: shortTextSchema,
    state: z.enum(["pending", "consumed", "canceled"]),
  })
  .strict();

export const findingAcknowledgementSchema = z
  .object({
    ...baseDocument,
    runId: entityIdSchema,
    findingKey: z.string().regex(sha256Pattern),
    note: shortTextSchema,
    acknowledgedAt: timestampSchema,
  })
  .strict();

export const invalidationAuditSchema = z
  .object({
    ...baseDocument,
    eventId: entityIdSchema,
    matrixRow: matrixRowSchema,
    consequenceHash: z.string().regex(sha256Pattern),
    affectedIds: z.array(entityIdSchema).max(10_000),
    bookVersionProjectIds: z.array(entityIdSchema).max(1_000),
  })
  .strict();

export type AppearanceBinding = z.infer<typeof appearanceBindingSchema>;
export type SheetViewName = z.infer<typeof sheetViewNameSchema>;
export type CharacterSheet = z.infer<typeof characterSheetSchema>;
export type CharacterSheetIntent = z.infer<typeof characterSheetIntentSchema>;
export type CharacterApproval = z.infer<typeof characterApprovalSchema>;
export type CreativeRun = z.infer<typeof creativeRunSchema>;
export type CreativeStageRecord = z.infer<typeof creativeStageRecordSchema>;
export type Page = z.infer<typeof pageSchema>;
export type PageTextVersion = z.infer<typeof pageTextVersionSchema>;
export type PagePromptVersion = z.infer<typeof pagePromptVersionSchema>;
export type IllustrationVersion = z.infer<typeof illustrationVersionSchema>;
export type PageReview = z.infer<typeof pageReviewSchema>;
export type LayoutWorkRequest = z.infer<typeof layoutWorkRequestSchema>;
export type FindingAcknowledgement = z.infer<
  typeof findingAcknowledgementSchema
>;
export type InvalidationAudit = z.infer<typeof invalidationAuditSchema>;
export type MatrixRow = z.infer<typeof matrixRowSchema>;

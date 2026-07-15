import { z } from "zod";

import { entityIdSchema, relationshipTypeSchema } from "../library/schemas.js";

const timestampSchema = z.iso.datetime();
const shortText = z.string().max(240);
const requiredText = z.string().trim().min(1).max(8_000);
const longText = z.string().max(8_000);
const textMap = z.record(z.string().min(1).max(80), z.string().max(1_000));

const baseDocumentFields = {
  id: entityIdSchema,
  schemaVersion: z.literal(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

const versionTwoDocumentFields = {
  id: entityIdSchema,
  schemaVersion: z.literal(2),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

export const pageCountSchema = z.union([z.literal(16), z.literal(24)]);
export const storyTypeSchema = z.enum([
  "connected_adventure",
  "related_situations",
  "saved_template",
  "fully_custom",
]);
export const toneSchema = z.enum([
  "light_funny",
  "adventurous",
  "warm_family",
  "magical",
  "educational_non_preachy",
  "custom",
]);
export const illustrationStyleSchema = z.enum([
  "modern_cartoon",
  "colorful_2d",
  "soft_watercolor",
]);
export const audienceAgeBandSchema = z.enum(["age_3_5", "age_6_8", "age_9_12"]);
export const readingLevelSchema = z.enum([
  "early",
  "developing",
  "independent",
]);
export const sceneComplexitySchema = z.enum(["low", "medium", "high"]);

export const baseAppearanceSchema = z
  .object({ type: z.literal("base") })
  .strict();
export const sharedLookAppearanceSchema = z
  .object({
    type: z.literal("shared_look"),
    lookId: entityIdSchema,
    lookVersionId: entityIdSchema,
  })
  .strict();
export const projectOverrideAppearanceSchema = z
  .object({
    type: z.literal("project_override"),
    overrideId: entityIdSchema,
    overrideVersionId: entityIdSchema,
  })
  .strict();
export const appearanceSelectionSchema = z.discriminatedUnion("type", [
  baseAppearanceSchema,
  sharedLookAppearanceSchema,
  projectOverrideAppearanceSchema,
]);

const projectInputAppearanceSchema = z.discriminatedUnion("type", [
  baseAppearanceSchema,
  z.object({ type: z.literal("shared_look"), lookId: entityIdSchema }).strict(),
]);

export const projectParticipantSchema = z
  .object({
    characterId: entityIdSchema,
    characterVersionId: entityIdSchema,
    narrativeRole: z.string().trim().min(1).max(120),
    appearance: appearanceSelectionSchema,
  })
  .strict();

export const projectParticipantInputSchema = z
  .object({
    characterId: entityIdSchema,
    narrativeRole: z.string().trim().min(1).max(120),
    appearance: projectInputAppearanceSchema.optional(),
  })
  .strict();

export const hiddenGoalSchema = z
  .object({
    goal: z.enum([
      "confidence",
      "enjoying_school",
      "reducing_phone_use",
      "sharing",
      "courage",
      "welcoming_sibling",
      "responsibility",
      "cooperation",
      "custom",
    ]),
    customGoal: shortText.nullable(),
    presentation: z.enum(["indirect", "acknowledged_ending"]),
  })
  .strict()
  .superRefine((goal, context) => {
    if (goal.goal === "custom" && !goal.customGoal?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["customGoal"],
        message: "CUSTOM_GOAL_REQUIRED",
      });
    }
  });

export const customStorySchema = z
  .object({
    premise: longText,
    beginningBeat: longText,
    middleBeat: longText,
    endingBeat: longText,
    contentBoundaries: z.array(requiredText).max(50),
  })
  .strict();

export const narrationBalanceSchema = z
  .object({
    suggestedNarrationPercent: z.number().int().min(0).max(100),
    selectedNarrationPercent: z.number().int().min(0).max(100),
    operatorEdited: z.boolean(),
    formulaVersion: z.literal("hekayati.balance.v1"),
  })
  .strict();

export const storyConfigSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    mainChildId: entityIdSchema,
    participants: z.array(projectParticipantSchema).min(1).max(20),
    occasion: shortText,
    dedicationText: longText,
    storyType: storyTypeSchema,
    templateId: entityIdSchema.nullable(),
    templateVersionId: entityIdSchema.nullable(),
    pageCount: pageCountSchema,
    tone: toneSchema,
    customTone: shortText.nullable(),
    illustrationStyleId: illustrationStyleSchema,
    hiddenGoal: hiddenGoalSchema.nullable(),
    clothingNotes: longText,
    customNotes: longText,
    audienceAgeBand: audienceAgeBandSchema,
    readingLevel: readingLevelSchema,
    sceneComplexity: sceneComplexitySchema,
    narrationDialogueBalance: narrationBalanceSchema,
    customStory: customStorySchema.nullable(),
    endingPages: z
      .object({ farewellText: longText, brandLine: longText })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    uniqueParticipantIds(config.participants, context);
    if (
      !config.participants.some(
        (item) => item.characterId === config.mainChildId,
      )
    )
      addIssue(context, ["mainChildId"], "PROJECT_MAIN_CHILD_INVALID");
    if (config.tone === "custom" && !config.customTone?.trim())
      addIssue(context, ["customTone"], "CUSTOM_TONE_REQUIRED");
    if (config.storyType === "saved_template" && !config.templateVersionId)
      addIssue(context, ["templateVersionId"], "TEMPLATE_REQUIRED");
  });

export const projectInputSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    mainChildId: entityIdSchema,
    participants: z.array(projectParticipantInputSchema).min(1).max(20),
    occasion: shortText,
    dedicationText: longText,
    storyType: storyTypeSchema,
    templateId: entityIdSchema.nullable().optional(),
    templateSeedKey: z.string().min(1).max(80).nullable().optional(),
    pageCount: pageCountSchema,
    tone: toneSchema,
    customTone: shortText.nullable(),
    illustrationStyleId: illustrationStyleSchema,
    hiddenGoal: hiddenGoalSchema.nullable(),
    clothingNotes: longText,
    customNotes: longText,
    audienceAgeBand: audienceAgeBandSchema,
    readingLevel: readingLevelSchema,
    sceneComplexity: sceneComplexitySchema,
    selectedNarrationPercent: z.number().int().min(0).max(100).nullable(),
    customStory: customStorySchema.nullable(),
    endingPages: z
      .object({ farewellText: longText, brandLine: longText })
      .strict(),
  })
  .strict();

export const projectStatusSchema = z.enum([
  "draft",
  "characters_ready",
  "awaiting_character_approval",
  "generating",
  "internal_review",
  "preview_ready",
  "awaiting_customer_approval",
  "approved",
  "print_ready",
  "revising",
  "archived",
]);

const projectIdentityFields = {
  customerId: entityIdSchema,
  familyId: entityIdSchema,
  status: projectStatusSchema,
  priority: z.number().int().min(0).max(100),
  paused: z.boolean(),
  currentVersionId: entityIdSchema,
  bookVersion: z.number().int().positive(),
  printerProfileId: entityIdSchema.nullable(),
};

/** Read-only boundary for the restart-safe feature-008 repository migration. */
export const projectV1Schema = z
  .object({
    ...baseDocumentFields,
    ...projectIdentityFields,
  })
  .strict();

export const projectSchema = z
  .object({
    ...versionTwoDocumentFields,
    ...projectIdentityFields,
    revision: z.number().int().nonnegative(),
    compositionProfileId: entityIdSchema,
    currentCoverCompositionVersionId: entityIdSchema.nullable(),
    currentPreviewOutputId: entityIdSchema.nullable(),
    currentPreviewCycleId: entityIdSchema.nullable(),
    currentContentApprovalId: entityIdSchema.nullable(),
  })
  .strict();

export const projectVersionSchema = z
  .object({
    ...baseDocumentFields,
    projectId: entityIdSchema,
    previousVersionId: entityIdSchema.nullable(),
    storyConfig: storyConfigSchema,
  })
  .strict();

export const projectOverrideSchema = z
  .object({
    ...baseDocumentFields,
    projectId: entityIdSchema,
    characterId: entityIdSchema,
    currentVersionId: entityIdSchema,
    status: z.enum(["active", "archived"]),
  })
  .strict();

export const projectOverrideVersionSchema = z
  .object({
    ...baseDocumentFields,
    overrideId: entityIdSchema,
    previousVersionId: entityIdSchema.nullable(),
    baseCharacterVersionId: entityIdSchema,
    baseLookVersionId: entityIdSchema.nullable(),
    clothing: longText,
    appearanceOverrides: textMap,
  })
  .strict();

export const mentionPropsSchema = z
  .object({
    action: longText,
    emotion: longText,
    position: shortText.nullable(),
    framing: shortText.nullable(),
    lookId: entityIdSchema.nullable(),
    heldObject: shortText.nullable(),
    gazeTarget: shortText.nullable(),
    speaks: z.boolean(),
    dialogue: longText.nullable(),
  })
  .strict();

export const documentSegmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: longText }).strict(),
  z
    .object({
      type: z.literal("mention"),
      characterId: entityIdSchema,
      props: mentionPropsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("group"),
      groupKey: z.enum(["hero", "friends", "family"]),
      props: mentionPropsSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("unresolved"), text: requiredText }).strict(),
]);

export const sceneContentSchema = z
  .object({
    purpose: longText,
    description: longText,
    documentSegments: z.array(documentSegmentSchema).max(1_000),
    environment: longText,
    timeOfDay: shortText,
    composition: longText,
    cameraFraming: shortText,
    narrativeText: longText,
    dialogue: z
      .array(
        z
          .object({ speakerCharacterId: entityIdSchema, text: longText })
          .strict(),
      )
      .max(100),
    twoImageMoment: z.boolean(),
  })
  .strict();

export const sceneSchema = z
  .object({
    ...baseDocumentFields,
    projectId: entityIdSchema,
    storyPageIndex: z.number().int().min(1).max(20),
    currentVersionId: entityIdSchema,
  })
  .strict();

export const sceneVersionSchema = z
  .object({
    ...baseDocumentFields,
    sceneId: entityIdSchema,
    previousVersionId: entityIdSchema.nullable(),
    sourceSceneVersionIds: z.array(entityIdSchema).max(20),
    needsAuthoring: z.boolean(),
    content: sceneContentSchema,
  })
  .strict();

const pageCountOperationSchema = z
  .object({
    type: z.enum(["retain", "add", "merge", "remove"]),
    targetStoryPageIndex: z.number().int().min(1).max(20).nullable(),
    sourceSceneVersionIds: z.array(entityIdSchema).max(20),
  })
  .strict();

export const storySchema = z
  .object({
    ...baseDocumentFields,
    projectId: entityIdSchema,
    status: z.enum(["draft", "complete"]),
    currentVersionId: entityIdSchema,
  })
  .strict();

export const storyVersionSchema = z
  .object({
    ...baseDocumentFields,
    storyId: entityIdSchema,
    previousVersionId: entityIdSchema.nullable(),
    source: z.enum(["manual", "generated"]),
    planJson: z.unknown().nullable(),
    sceneVersionIds: z.array(entityIdSchema).max(20),
    pageCountChange: z
      .object({
        from: pageCountSchema,
        to: pageCountSchema,
        planHash: z.string().regex(/^[a-f0-9]{64}$/),
        operations: z.array(pageCountOperationSchema),
      })
      .strict()
      .nullable(),
    completedAt: timestampSchema.nullable(),
  })
  .strict();

export const templateStatusSchema = z.enum(["active", "archived", "disabled"]);
export const templateVariableSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    label: requiredText,
    type: z.enum(["text", "long_text", "text_list"]),
    required: z.boolean(),
    defaultValue: z.union([z.string(), z.array(z.string())]).nullable(),
  })
  .strict();

export const storyTemplateContentSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    premise: requiredText,
    structure: z
      .array(
        z
          .object({ key: z.string().min(1).max(80), purpose: requiredText })
          .strict(),
      )
      .min(1)
      .max(20),
    environments: z.array(requiredText).min(1).max(50),
    roleSlots: z
      .array(
        z
          .object({
            slot: z.string().regex(/^[a-z][a-z0-9_]*$/),
            label: requiredText,
            required: z.boolean(),
            requiredRelationship: relationshipTypeSchema.nullable(),
            narrativeRole: requiredText,
          })
          .strict(),
      )
      .min(1)
      .max(20),
    variables: z.array(templateVariableSchema).max(50),
    possibleHiddenGoals: z.array(requiredText).min(1).max(30),
    sceneGuidance: z.array(requiredText).min(1).max(50),
    ageAdaptationRules: z
      .array(
        z
          .object({ ageBand: audienceAgeBandSchema, guidance: requiredText })
          .strict(),
      )
      .length(3),
    contentBoundaries: z.array(requiredText).min(1).max(50),
    endingPatterns: z.array(requiredText).min(1).max(30),
  })
  .strict()
  .superRefine((content, context) => {
    uniqueKeys(content.structure, "key", context);
    uniqueKeys(content.roleSlots, "slot", context);
    uniqueKeys(content.variables, "key", context);
    uniqueKeys(content.ageAdaptationRules, "ageBand", context);
    if (
      !content.roleSlots.some((slot) => slot.slot === "hero" && slot.required)
    )
      addIssue(context, ["roleSlots"], "REQUIRED_HERO_SLOT_MISSING");
  });

export const storyTemplateSchema = z
  .object({
    ...baseDocumentFields,
    seedKey: z.string().max(80).nullable(),
    status: templateStatusSchema,
    currentVersionId: entityIdSchema,
  })
  .strict();

export const storyTemplateVersionSchema = z
  .object({
    ...baseDocumentFields,
    templateId: entityIdSchema,
    previousVersionId: entityIdSchema.nullable(),
    content: storyTemplateContentSchema,
  })
  .strict();

export type PageCount = z.infer<typeof pageCountSchema>;
export type StoryType = z.infer<typeof storyTypeSchema>;
export type ProjectInput = z.input<typeof projectInputSchema>;
export type ParsedProjectInput = z.output<typeof projectInputSchema>;
export type StoryConfig = z.infer<typeof storyConfigSchema>;
export type ProjectParticipant = z.infer<typeof projectParticipantSchema>;
export type AppearanceSelection = z.infer<typeof appearanceSelectionSchema>;
export type ProjectV1 = z.infer<typeof projectV1Schema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectVersion = z.infer<typeof projectVersionSchema>;
export type ProjectOverride = z.infer<typeof projectOverrideSchema>;
export type ProjectOverrideVersion = z.infer<
  typeof projectOverrideVersionSchema
>;
export type MentionProps = z.infer<typeof mentionPropsSchema>;
export type DocumentSegment = z.infer<typeof documentSegmentSchema>;
export type SceneContent = z.infer<typeof sceneContentSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type SceneVersion = z.infer<typeof sceneVersionSchema>;
export type Story = z.infer<typeof storySchema>;
export type StoryVersion = z.infer<typeof storyVersionSchema>;
export type StoryTemplateContent = z.infer<typeof storyTemplateContentSchema>;
export type StoryTemplate = z.infer<typeof storyTemplateSchema>;
export type StoryTemplateVersion = z.infer<typeof storyTemplateVersionSchema>;
export type TemplateStatus = z.infer<typeof templateStatusSchema>;

function uniqueParticipantIds(
  participants: Array<{ characterId: string }>,
  context: z.RefinementCtx,
): void {
  if (
    new Set(participants.map((item) => item.characterId)).size !==
    participants.length
  )
    addIssue(context, ["participants"], "DUPLICATE_PROJECT_PARTICIPANT");
}

function uniqueKeys<T extends Record<string, unknown>>(
  values: T[],
  key: keyof T,
  context: z.RefinementCtx,
): void {
  if (new Set(values.map((value) => value[key])).size !== values.length)
    addIssue(context, [String(key)], "DUPLICATE_TEMPLATE_KEY");
}

function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

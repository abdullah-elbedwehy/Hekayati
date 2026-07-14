import { z } from "zod";

const safeId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
  .max(160);
const boundedText = z.string().trim().min(1).max(4_000);
const shortText = z.string().trim().min(1).max(240);

export const structuredSchemaIdSchema = z.enum([
  "StoryPlan",
  "StoryText",
  "SceneList",
  "PagePrompt",
  "ReviewFindings",
]);

export type StructuredSchemaId = z.infer<typeof structuredSchemaIdSchema>;

export const characterRefSchema = z
  .object({
    characterId: safeId,
    characterVersionId: safeId,
  })
  .strict();

export type CharacterRef = z.infer<typeof characterRefSchema>;

const participantSchema = z
  .object({
    characterRef: characterRefSchema,
    displayLabel: shortText,
    narrativeRole: shortText,
    appearanceDescription: boundedText,
    availableLookIds: z.array(safeId).max(40),
    traits: z.record(safeId, shortText).refine((value) => {
      return Object.keys(value).length <= 40;
    }, "TOO_MANY_TRAITS"),
  })
  .strict();

const commonShape = {
  schemaVersion: z.literal(1),
  expectedOutputSchemaVersion: z.literal(1),
  inputVersionRefs: z
    .record(safeId, safeId)
    .refine((value) => Object.keys(value).length <= 80, "TOO_MANY_REFS"),
  participants: z.array(participantSchema).min(1).max(20),
  languageDirectives: z
    .object({
      storyDialect: z.literal("egyptian_arabic"),
      register: shortText,
      ageBand: z.enum(["age_3_5", "age_6_8", "age_9_12"]),
    })
    .strict(),
  contentBoundaries: z.array(boundedText).max(40),
  negativeConstraints: z.array(boundedText).max(40),
};

const storyPlanTaskSchema = z
  .object({
    ...commonShape,
    schemaId: z.literal("StoryPlan"),
    payload: z
      .object({
        pageCount: z.number().int().min(1).max(20),
        workingTitle: shortText,
        premise: boundedText,
        hiddenGoal: boundedText.nullable(),
      })
      .strict(),
  })
  .strict();

const storyTextTaskSchema = z
  .object({
    ...commonShape,
    schemaId: z.literal("StoryText"),
    payload: z
      .object({
        pageCount: z.number().int().min(1).max(20),
        planSummary: boundedText,
        wordsPerPage: z
          .object({
            minimum: z.number().int().min(1).max(500),
            maximum: z.number().int().min(1).max(600),
          })
          .strict()
          .refine((value) => value.maximum >= value.minimum, "INVALID_RANGE"),
      })
      .strict(),
  })
  .strict();

const sceneListTaskSchema = z
  .object({
    ...commonShape,
    schemaId: z.literal("SceneList"),
    payload: z
      .object({
        pageCount: z.number().int().min(1).max(20),
        storyPages: z
          .array(
            z
              .object({
                pageNumber: z.number().int().min(1).max(20),
                narrative: boundedText,
              })
              .strict(),
          )
          .min(1)
          .max(20),
      })
      .strict(),
  })
  .strict();

const pagePromptTaskSchema = z
  .object({
    ...commonShape,
    schemaId: z.literal("PagePrompt"),
    payload: z
      .object({
        pageNumber: z.number().int().min(1).max(20),
        scene: z
          .object({
            description: boundedText,
            participantRefs: z.array(characterRefSchema).max(20),
            environment: boundedText,
            composition: boundedText,
            cameraFraming: boundedText,
          })
          .strict(),
        styleId: z.enum(["modern_cartoon", "colorful_2d", "soft_watercolor"]),
        narrativeText: boundedText,
      })
      .strict(),
  })
  .strict();

const reviewFindingsTaskSchema = z
  .object({
    ...commonShape,
    schemaId: z.literal("ReviewFindings"),
    payload: z
      .object({
        pageCount: z.number().int().min(1).max(20),
        artifactRefs: z.array(safeId).min(1).max(100),
      })
      .strict(),
  })
  .strict();

export const generationTaskV1Schema = z.discriminatedUnion("schemaId", [
  storyPlanTaskSchema,
  storyTextTaskSchema,
  sceneListTaskSchema,
  pagePromptTaskSchema,
  reviewFindingsTaskSchema,
]);

export type GenerationTaskV1 = z.infer<typeof generationTaskV1Schema>;

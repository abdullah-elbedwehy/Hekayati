import { z } from "zod";

import { characterRefSchema } from "./generation-task.js";

const text = z.string().trim().min(1).max(12_000);
const shortText = z.string().trim().min(1).max(500);
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);

export const storyPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().trim().min(1).max(80),
    logline: text,
    arc: z
      .array(
        z
          .object({
            beat: shortText,
            purpose: shortText,
            pagesEstimate: z.number().int().min(1).max(4),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    settingSummary: text,
    characterArcs: z
      .array(
        z.object({ characterRef: characterRefSchema, arcNote: text }).strict(),
      )
      .max(20),
    hiddenGoalWeave: text.nullable(),
    toneNotes: text,
    pageBudget: z
      .object({ storyPages: z.number().int().min(1).max(20) })
      .strict(),
  })
  .strict();

export const storyTextSchema = z
  .object({
    schemaVersion: z.literal(1),
    pages: z
      .array(
        z
          .object({
            pageNumber: z.number().int().min(1).max(20),
            narrative: text,
            dialogue: z
              .array(
                z.object({ speaker: characterRefSchema, line: text }).strict(),
              )
              .max(100),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

const perCharacterSchema = z
  .object({
    characterRef: characterRefSchema,
    action: shortText,
    emotion: shortText,
    position: shortText.nullable().optional(),
    framing: shortText.nullable().optional(),
    lookId: safeId.nullable().optional(),
    heldObject: shortText.nullable().optional(),
    gazeTarget: shortText.nullable().optional(),
    speaks: z.boolean(),
  })
  .strict();

export const sceneListSchema = z
  .object({
    schemaVersion: z.literal(1),
    scenes: z
      .array(
        z
          .object({
            pageNumber: z.number().int().min(1).max(20),
            purpose: shortText,
            description: text,
            participants: z.array(characterRefSchema).max(20),
            perCharacter: z.array(perCharacterSchema).max(20),
            environment: text,
            timeOfDay: shortText,
            composition: text,
            cameraFraming: shortText,
            twoImageMoment: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export const pagePromptSchema = z
  .object({
    schemaVersion: z.literal(1),
    pageNumber: z.number().int().min(1).max(20),
    prompt: text,
    negativeConstraints: z.array(shortText).min(4).max(40),
    referencePlan: z
      .array(
        z
          .object({
            characterRef: characterRefSchema,
            useSheetViews: z
              .array(
                z.enum([
                  "face",
                  "front",
                  "threeQuarter",
                  "fullBody",
                  "mainOutfit",
                ]),
              )
              .min(1)
              .max(5),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export const reviewFindingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    findings: z
      .array(
        z
          .object({
            scope: z.enum(["story", "page", "character"]),
            refId: safeId,
            pageNumber: z.number().int().min(1).max(20).optional(),
            category: z.enum([
              "register_drift",
              "slang_excess",
              "trend_vocab",
              "shaming",
              "lecture",
              "age_inappropriate",
              "fear_excess",
              "safety",
              "copyright_similarity",
              "contact_details",
              "inconsistency",
              "other",
            ]),
            severity: z.enum(["info", "warn", "block"]),
            excerpt: text,
            note: text,
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export const structuredOutputSchemas = {
  StoryPlan: storyPlanSchema,
  StoryText: storyTextSchema,
  SceneList: sceneListSchema,
  PagePrompt: pagePromptSchema,
  ReviewFindings: reviewFindingsSchema,
} as const;

import { z } from "zod";

import { creativeCapacityPlanSchema } from "./creative-policy.js";

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const safeDetail = z.string().trim().min(1).max(240);

export const neutralProvenanceSchema = z
  .object({
    provider: z.enum(["mock", "codex", "gemini"]),
    modelId: safeId,
    at: z.iso.datetime(),
    inputVersionRefs: z.record(safeId, safeId),
    promptVersion: safeId,
    referenceAssetIds: z.array(safeId).max(100),
    attempt: z.number().int().positive(),
    settingsSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type NeutralProvenance = z.infer<typeof neutralProvenanceSchema>;

const imageParticipantSchema = z
  .object({
    characterRef: z
      .object({ characterId: safeId, characterVersionId: safeId })
      .strict(),
    action: safeDetail,
    emotion: safeDetail,
    lookId: safeId.nullable(),
  })
  .strict();

export const neutralImageRequestDraftSchema = z
  .object({
    styleId: z.enum(["modern_cartoon", "colorful_2d", "soft_watercolor"]),
    capacityPlan: creativeCapacityPlanSchema.optional(),
    variationKey: safeId.optional(),
    scene: z
      .object({
        pageNumber: z.number().int().min(1).max(20),
        description: z.string().trim().min(1).max(4_000),
        participants: z.array(imageParticipantSchema).max(20),
        environment: z.string().trim().min(1).max(2_000),
        composition: z.string().trim().min(1).max(2_000),
        cameraFraming: safeDetail,
      })
      .strict(),
    referenceImages: z
      .array(
        z.discriminatedUnion("source", [
          z
            .object({
              source: z.literal("reference_photo"),
              referencePhotoId: safeId,
              customerId: safeId,
              familyId: safeId,
              characterId: safeId,
              owner: z.discriminatedUnion("type", [
                z
                  .object({
                    type: z.literal("character"),
                    characterVersionId: safeId,
                  })
                  .strict(),
                z
                  .object({
                    type: z.literal("look"),
                    lookId: safeId,
                    characterVersionId: safeId,
                    lookVersionId: safeId,
                  })
                  .strict(),
              ]),
              providerAssetId: safeId,
            })
            .strict(),
          z
            .object({
              source: z.literal("approved_character_sheet"),
              characterSheetId: safeId,
              customerId: safeId,
              familyId: safeId,
              characterId: safeId,
              characterVersionId: safeId,
              appearance: z.discriminatedUnion("type", [
                z
                  .object({
                    type: z.literal("base"),
                    lookId: z.null(),
                    lookVersionId: z.null(),
                  })
                  .strict(),
                z
                  .object({
                    type: z.literal("shared_look"),
                    lookId: safeId,
                    lookVersionId: safeId,
                  })
                  .strict(),
              ]),
              sheetAssetId: safeId,
            })
            .strict(),
        ]),
      )
      .max(100),
    negativeConstraints: z.array(safeDetail).min(1).max(40),
    output: z
      .object({
        minWidthPx: z.number().int().min(256).max(20_000),
        minHeightPx: z.number().int().min(256).max(20_000),
      })
      .strict(),
  })
  .strict();

export type NeutralImageRequestDraft = z.infer<
  typeof neutralImageRequestDraftSchema
>;
export type NeutralProviderEligibleReference =
  NeutralImageRequestDraft["referenceImages"][number];

export const MANDATORY_IMAGE_CONSTRAINTS = Object.freeze([
  "no_extra_people",
  "no_story_text",
  "no_onomatopoeia",
  "no_photoreal_face",
] as const);

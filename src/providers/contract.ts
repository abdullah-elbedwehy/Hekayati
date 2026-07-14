import { z } from "zod";

import {
  generationTaskV1Schema,
  type GenerationTaskV1,
  structuredSchemaIdSchema,
} from "./generation-task.js";
import { normalizedFailureSchema, type NormalizedFailure } from "./failures.js";

const safeId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
  .max(160);
const safeDetail = z.string().trim().min(1).max(240);

export const providerIdSchema = z.enum(["mock", "codex", "gemini"]);
export type ProviderId = z.infer<typeof providerIdSchema>;

const operationCapabilitySchema = z
  .object({
    available: z.boolean(),
    modelId: safeId.optional(),
    unavailableReason: safeDetail.optional(),
  })
  .strict();

export const providerCapabilitiesSchema = z
  .object({
    providerId: providerIdSchema,
    checkedAt: z.iso.datetime(),
    source: z.enum(["fixture", "cache", "live"]),
    auth: z
      .object({
        state: z.enum(["ok", "missing", "expired", "error"]),
        detail: safeDetail,
      })
      .strict(),
    text: operationCapabilitySchema
      .extend({ structured: z.boolean() })
      .strict(),
    image: operationCapabilitySchema
      .extend({
        maxReferenceImages: z.number().int().min(1).max(100).nullable(),
        reliableCharacterCount: z.number().int().min(1).max(20).nullable(),
        economyTier: z.boolean(),
      })
      .strict(),
    limits: z
      .object({ concurrencySuggested: z.number().int().min(1).max(4) })
      .strict(),
    unavailableReason: safeDetail.optional(),
  })
  .strict();

export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

export const provenanceSchema = z
  .object({
    provider: providerIdSchema,
    modelId: safeId,
    at: z.iso.datetime(),
    inputVersionRefs: z.record(safeId, safeId),
    promptVersion: safeId,
    referenceAssetIds: z.array(safeId).max(100),
    attempt: z.number().int().positive(),
    settingsSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type Provenance = z.infer<typeof provenanceSchema>;

export const textRequestSchema = z
  .object({
    task: generationTaskV1Schema,
    purpose: z.enum(["rewrite", "review_note", "prompt_transformation"]),
  })
  .strict();

export const textResultSchema = z
  .object({ text: z.string().trim().min(1).max(20_000) })
  .strict();

export const structuredRequestSchema = z
  .object({
    schemaId: structuredSchemaIdSchema,
    task: generationTaskV1Schema,
    languageDirectives: z
      .object({
        storyDialect: z.literal("egyptian_arabic"),
        register: safeDetail,
        ageBand: safeDetail,
      })
      .strict(),
  })
  .strict()
  .refine((request) => request.schemaId === request.task.schemaId, {
    path: ["schemaId"],
    message: "SCHEMA_TASK_MISMATCH",
  });

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

export const compiledSceneForImageSchema = z
  .object({
    pageNumber: z.number().int().min(1).max(20),
    description: z.string().trim().min(1).max(4_000),
    participants: z.array(imageParticipantSchema).max(20),
    environment: z.string().trim().min(1).max(2_000),
    composition: z.string().trim().min(1).max(2_000),
    cameraFraming: safeDetail,
  })
  .strict();

const referencePhotoOwnerSchema = z.discriminatedUnion("type", [
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
]);

export const providerEligibleReferenceSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("reference_photo"),
      referencePhotoId: safeId,
      customerId: safeId,
      familyId: safeId,
      characterId: safeId,
      owner: referencePhotoOwnerSchema,
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
      lookVersionId: safeId,
      sheetAssetId: safeId,
    })
    .strict(),
]);

export const imageRequestDraftSchema = z
  .object({
    styleId: z.enum(["modern_cartoon", "colorful_2d", "soft_watercolor"]),
    scene: compiledSceneForImageSchema,
    referenceImages: z.array(providerEligibleReferenceSchema).max(100),
    negativeConstraints: z.array(safeDetail).min(1).max(40),
    output: z
      .object({
        minWidthPx: z.number().int().min(256).max(20_000),
        minHeightPx: z.number().int().min(256).max(20_000),
      })
      .strict(),
  })
  .strict();

export type ImageRequestDraft = z.infer<typeof imageRequestDraftSchema>;
export type ProviderEligibleReference = z.infer<
  typeof providerEligibleReferenceSchema
>;

const versionRefsSchema = z
  .object({
    characterVersionId: safeId,
    lookVersionId: safeId.optional(),
  })
  .strict();

export const resolvedProviderReferenceSchema = z
  .object({
    source: z.enum(["reference_photo", "approved_character_sheet"]),
    sourceRecordId: safeId,
    customerId: safeId,
    familyId: safeId,
    characterId: safeId,
    versionRefs: versionRefsSchema,
    provenanceAssetId: safeId,
    mime: z.enum(["image/jpeg", "image/png"]),
    bytes: z.instanceof(Uint8Array).refine((bytes) => {
      return bytes.byteLength > 0 && bytes.byteLength <= 50 * 1024 * 1024;
    }, "INVALID_REFERENCE_BYTES"),
  })
  .strict();

export const resolvedImageRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    styleId: z.enum(["modern_cartoon", "colorful_2d", "soft_watercolor"]),
    scene: compiledSceneForImageSchema,
    referenceImages: z.array(resolvedProviderReferenceSchema).max(100),
    negativeConstraints: z.array(safeDetail).min(1).max(40),
    output: z
      .object({
        minWidthPx: z.number().int().min(256).max(20_000),
        minHeightPx: z.number().int().min(256).max(20_000),
      })
      .strict(),
  })
  .strict();

export type ResolvedImageRequest = z.infer<typeof resolvedImageRequestSchema>;

const providerMetaSchema = z
  .object({
    responseId: safeId.optional(),
    modelVersion: safeId.optional(),
    finishReason: safeId.optional(),
    safetyRatings: z
      .array(z.object({ category: safeId, blocked: z.boolean() }).strict())
      .max(20)
      .optional(),
  })
  .strict();

export const imageResultSchema = z
  .object({
    imageBytes: z.instanceof(Uint8Array).refine((bytes) => {
      return bytes.byteLength > 0 && bytes.byteLength <= 100 * 1024 * 1024;
    }, "INVALID_IMAGE_BYTES"),
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    providerMeta: providerMetaSchema.optional(),
  })
  .strict();

export type ImageResult = z.infer<typeof imageResultSchema>;
export type TextRequest = z.infer<typeof textRequestSchema>;
export type TextResult = z.infer<typeof textResultSchema>;
export type StructuredRequest = z.infer<typeof structuredRequestSchema>;

export interface CallControl {
  signal: AbortSignal;
  timeoutMs: number;
}

export type ProviderResult<T> =
  | { ok: true; value: T; provenance: Provenance }
  | { ok: false; failure: NormalizedFailure };

export interface AiProvider {
  readonly providerId: ProviderId;
  getCapabilities(force?: boolean): Promise<ProviderCapabilities>;
  testConnection(): Promise<
    | { ok: true; capabilities: ProviderCapabilities }
    | {
        ok: false;
        failure: NormalizedFailure;
      }
  >;
  generateText(
    request: TextRequest,
    control: CallControl,
  ): Promise<ProviderResult<TextResult>>;
  generateStructured<T>(
    request: StructuredRequest,
    control: CallControl,
  ): Promise<ProviderResult<T>>;
  generateImage(
    request: ResolvedImageRequest,
    control: CallControl,
  ): Promise<ProviderResult<ImageResult>>;
}

export function taskInputVersionRefs(
  task: GenerationTaskV1,
): Record<string, string> {
  return { ...task.inputVersionRefs };
}

export { normalizedFailureSchema };

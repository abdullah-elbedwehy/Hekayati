import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./canonical-json.js";

const safeId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
  .max(160);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const creativePromptConfirmationSchema = z
  .object({
    policyVersion: z.literal("prompt-policy-v1"),
    bindingHash: sha256,
    confirmed: z.literal(true),
  })
  .strict();

export const creativeCapacityConfirmationSchema = z
  .object({ bindingHash: sha256, confirmed: z.literal(true) })
  .strict();

const capacityParticipantSchema = z
  .object({
    characterId: safeId,
    requestedAssetIds: z.array(safeId).max(20),
    selectedAssetIds: z.array(safeId).max(20),
  })
  .strict();

export const creativeCapacityPlanSchema = z
  .object({
    providerId: z.enum(["mock", "codex", "gemini"]),
    modelId: safeId,
    settingsHash: sha256,
    maxReferenceImages: z.number().int().positive().max(100),
    reliableCharacterCount: z.number().int().positive().max(20),
    participants: z.array(capacityParticipantSchema).min(1).max(20),
    selectedAssetIds: z.array(safeId).max(100),
    reduced: z.boolean(),
    participantExcess: z.boolean(),
    bindingHash: sha256,
    confirmed: z.boolean(),
  })
  .strict()
  .superRefine((plan, context) => {
    const selected = plan.participants.flatMap(
      (participant) => participant.selectedAssetIds,
    );
    if (
      new Set(plan.participants.map((item) => item.characterId)).size !==
        plan.participants.length ||
      new Set(plan.selectedAssetIds).size !== plan.selectedAssetIds.length ||
      JSON.stringify(selected) !== JSON.stringify(plan.selectedAssetIds)
    ) {
      context.addIssue({ code: "custom", message: "INVALID_CAPACITY_PLAN" });
    }
    if ((plan.reduced || plan.participantExcess) && !plan.confirmed) {
      context.addIssue({
        code: "custom",
        path: ["confirmed"],
        message: "CAPACITY_CONFIRMATION_REQUIRED",
      });
    }
  });

export const creativePromptPlanSchema = z
  .object({
    status: z.enum(["allowed", "transformed"]),
    policyVersion: z.literal("prompt-policy-v1"),
    bindingHash: sha256.nullable(),
    matchedCategories: z
      .array(z.enum(["franchise_trademark", "living_artist"]))
      .max(2),
  })
  .strict();

export const creativePolicyPlanSchema = z
  .object({
    prompt: creativePromptPlanSchema,
    capacity: creativeCapacityPlanSchema,
  })
  .strict();

export type CreativePromptConfirmation = z.infer<
  typeof creativePromptConfirmationSchema
>;
export type CreativeCapacityConfirmation = z.infer<
  typeof creativeCapacityConfirmationSchema
>;
export type CreativeCapacityPlan = z.infer<typeof creativeCapacityPlanSchema>;
export type CreativePolicyPlan = z.infer<typeof creativePolicyPlanSchema>;

export function creativeCapacityBindingHash(
  input: Omit<CreativeCapacityPlan, "bindingHash" | "confirmed">,
): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function verifyCreativeCapacityPlan(input: {
  plan: unknown;
  target: {
    providerId: "mock" | "codex" | "gemini";
    modelId: string;
    settingsHash: string;
  };
  referenceAssetIds: string[];
  participantIds: string[];
}): { reliableCharacterCountAcknowledged: boolean } {
  const plan = creativeCapacityPlanSchema.parse(input.plan);
  const { bindingHash, confirmed, ...bound } = plan;
  if (
    bindingHash !== creativeCapacityBindingHash(bound) ||
    plan.providerId !== input.target.providerId ||
    plan.modelId !== input.target.modelId ||
    plan.settingsHash !== input.target.settingsHash ||
    input.referenceAssetIds.some(
      (assetId) => !plan.selectedAssetIds.includes(assetId),
    ) ||
    input.participantIds.some(
      (characterId) =>
        !plan.participants.some(
          (participant) => participant.characterId === characterId,
        ),
    ) ||
    ((plan.reduced || plan.participantExcess) && !confirmed)
  ) {
    throw new Error("CREATIVE_CAPACITY_PLAN_MISMATCH");
  }
  return {
    reliableCharacterCountAcknowledged:
      plan.participantExcess && plan.confirmed,
  };
}

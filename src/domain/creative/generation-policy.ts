import type { JobTarget } from "../../jobs/schemas.js";
import {
  creativeCapacityBindingHash,
  creativeCapacityPlanSchema,
  creativePolicyPlanSchema,
  type CreativeCapacityConfirmation,
  type CreativePolicyPlan,
  type CreativePromptConfirmation,
} from "../../contracts/creative-policy.js";
import { canonicalJson } from "../../contracts/canonical-json.js";
import {
  checkPromptPolicy,
  confirmationMatches,
  transformConfirmedPrompt,
  transformPolicyTerms,
} from "../../contracts/prompt-policy.js";
import type { StyleId } from "../../contracts/prompt-styles.js";
import { allocateReferenceBudget } from "../../contracts/reference-budget.js";
import { failCreative } from "./errors.js";

export interface CreativeCapabilityLimits {
  maxReferenceImages: number | null;
  reliableCharacterCount: number | null;
}

export type CreativeCapabilityLimitsReader = (
  target: Readonly<JobTarget>,
) => CreativeCapabilityLimits;

export interface CreativePolicyConfirmations {
  prompt?: CreativePromptConfirmation;
  capacity?: CreativeCapacityConfirmation;
}

interface CapacityPolicyInput {
  target: JobTarget;
  limits: CreativeCapabilityLimits;
  participants: Array<{ characterId: string; candidateAssetIds: string[] }>;
  confirmations?: CreativePolicyConfirmations;
}

interface VerifiedCapacityLimits {
  maxReferenceImages: number;
  reliableCharacterCount: number;
}

export function configuredCreativeLimits(
  target: Readonly<JobTarget>,
  geminiLimits?: CreativeCapabilityLimits,
): CreativeCapabilityLimits {
  if (target.providerId === "mock") {
    return { maxReferenceImages: 20, reliableCharacterCount: 20 };
  }
  if (target.providerId === "gemini") {
    return (
      geminiLimits ?? {
        maxReferenceImages: null,
        reliableCharacterCount: null,
      }
    );
  }
  return { maxReferenceImages: null, reliableCharacterCount: null };
}

export function prepareCreativePolicy(input: {
  target: JobTarget;
  limits: CreativeCapabilityLimits;
  styleId: StyleId;
  promptText: string;
  participants: Array<{ characterId: string; candidateAssetIds: string[] }>;
  confirmations?: CreativePolicyConfirmations;
}): { sanitizedPrompt: string; plan: CreativePolicyPlan } {
  const prompt = preparePrompt(input);
  const capacity = prepareCapacity(input);
  return {
    sanitizedPrompt: prompt.sanitizedPrompt,
    plan: creativePolicyPlanSchema.parse({
      prompt: prompt.plan,
      capacity,
    }),
  };
}

export function assertCreativeOutputAllowed(
  value: unknown,
  styleId: StyleId,
): void {
  if (checkPromptPolicy(canonicalJson(value), styleId).status !== "allowed") {
    failCreative("CREATIVE_POLICY_OUTPUT_REJECTED", 422);
  }
}

export function sanitizeTaskForPolicyPlan(input: {
  task: unknown;
  styleId: StyleId;
  plan: CreativePolicyPlan;
}): unknown {
  const serialized = canonicalJson(input.task);
  const check = checkPromptPolicy(serialized, input.styleId);
  if (check.status === "allowed") return input.task;
  if (input.plan.prompt.status !== "transformed") {
    failCreative("CREATIVE_POLICY_OUTPUT_REJECTED", 422);
  }
  return JSON.parse(transformPolicyTerms(serialized, input.styleId));
}

function preparePrompt(input: {
  styleId: StyleId;
  promptText: string;
  confirmations?: CreativePolicyConfirmations;
}) {
  const check = checkPromptPolicy(input.promptText, input.styleId);
  if (check.status === "allowed") {
    return {
      sanitizedPrompt: check.originalPrompt,
      plan: {
        status: "allowed" as const,
        policyVersion: check.policyVersion,
        bindingHash: null,
        matchedCategories: [],
      },
    };
  }
  if (!input.confirmations?.prompt) {
    failCreative("CREATIVE_POLICY_CONFIRMATION_REQUIRED", 409, {
      policyVersion: check.policyVersion,
      bindingHash: check.bindingHash,
      matchedCategories: check.matchedCategories,
      alternativePrompt: check.alternativePrompt,
    });
  }
  if (!confirmationMatches(check, input.confirmations.prompt)) {
    failCreative("CREATIVE_POLICY_CONFIRMATION_STALE", 409, {
      policyVersion: check.policyVersion,
      bindingHash: check.bindingHash,
    });
  }
  return {
    sanitizedPrompt: transformConfirmedPrompt(
      check,
      input.confirmations.prompt,
    ),
    plan: {
      status: "transformed" as const,
      policyVersion: check.policyVersion,
      bindingHash: check.bindingHash,
      matchedCategories: check.matchedCategories,
    },
  };
}

function prepareCapacity(input: CapacityPolicyInput) {
  const limits = requireVerifiedLimits(input);
  const selectedAssetIds = allocateCapacityReferences(input, limits);
  const participants = capacityParticipants(
    input.participants,
    selectedAssetIds,
  );
  const reduced = participants.some(
    (participant) =>
      participant.selectedAssetIds.length <
      participant.requestedAssetIds.length,
  );
  const participantExcess =
    input.participants.length > limits.reliableCharacterCount;
  const bound = {
    providerId: input.target.providerId,
    modelId: input.target.modelId,
    settingsHash: input.target.settingsHash,
    ...limits,
    participants,
    selectedAssetIds: participants.flatMap(
      (participant) => participant.selectedAssetIds,
    ),
    reduced,
    participantExcess,
  };
  const bindingHash = creativeCapacityBindingHash(bound);
  requireCapacityConfirmation(input, bound, bindingHash);
  return creativeCapacityPlanSchema.parse({
    ...bound,
    bindingHash,
    confirmed: reduced || participantExcess,
  });
}

function requireVerifiedLimits(
  input: Pick<CapacityPolicyInput, "target" | "limits">,
): VerifiedCapacityLimits {
  const { maxReferenceImages, reliableCharacterCount } = input.limits;
  if (maxReferenceImages === null || reliableCharacterCount === null) {
    failCreative("CREATIVE_CAPABILITY_UNAVAILABLE", 409, {
      providerId: input.target.providerId,
      modelId: input.target.modelId,
      reason: "unverified_image_limits",
    });
  }
  return { maxReferenceImages, reliableCharacterCount };
}

function allocateCapacityReferences(
  input: CapacityPolicyInput,
  limits: VerifiedCapacityLimits,
): string[] {
  const referenceParticipants = input.participants.filter(
    (participant) => participant.candidateAssetIds.length > 0,
  );
  if (referenceParticipants.length === 0) return [];
  const allocation = allocateReferenceBudget({
    maxReferenceImages: limits.maxReferenceImages,
    reliableCharacterCount: Math.max(
      limits.reliableCharacterCount,
      referenceParticipants.length,
    ),
    participants: referenceParticipants,
  });
  if (!allocation.ok) {
    failCreative("CREATIVE_CAPABILITY_UNAVAILABLE", 409, {
      providerId: input.target.providerId,
      modelId: input.target.modelId,
      reason: "reference_floor_exceeds_limit",
      maxReferenceImages: limits.maxReferenceImages,
      participantCount: input.participants.length,
    });
  }
  return allocation.selectedAssetIds;
}

function capacityParticipants(
  requested: CapacityPolicyInput["participants"],
  selectedAssetIds: string[],
) {
  const selectedSet = new Set(selectedAssetIds);
  return requested.map((participant) => ({
    characterId: participant.characterId,
    requestedAssetIds: [...participant.candidateAssetIds],
    selectedAssetIds: participant.candidateAssetIds.filter((assetId) =>
      selectedSet.has(assetId),
    ),
  }));
}

function requireCapacityConfirmation(
  input: CapacityPolicyInput,
  bound: Parameters<typeof creativeCapacityBindingHash>[0],
  bindingHash: string,
): void {
  if (!bound.reduced && !bound.participantExcess) return;
  if (!input.confirmations?.capacity) {
    failCreative("CREATIVE_CAPACITY_CONFIRMATION_REQUIRED", 409, {
      bindingHash,
      maxReferenceImages: bound.maxReferenceImages,
      reliableCharacterCount: bound.reliableCharacterCount,
      participantExcess: bound.participantExcess,
      counts: bound.participants.map((participant) => ({
        characterId: participant.characterId,
        requested: participant.requestedAssetIds.length,
        selected: participant.selectedAssetIds.length,
      })),
    });
  }
  if (
    input.confirmations.capacity.confirmed !== true ||
    input.confirmations.capacity.bindingHash !== bindingHash
  ) {
    failCreative("CREATIVE_CAPACITY_CONFIRMATION_STALE", 409, {
      bindingHash,
    });
  }
}

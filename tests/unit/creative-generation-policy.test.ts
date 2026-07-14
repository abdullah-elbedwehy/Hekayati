import { describe, expect, it } from "vitest";

import { verifyCreativeCapacityPlan } from "../../src/contracts/creative-policy.js";
import { CreativeError } from "../../src/domain/creative/errors.js";
import {
  configuredCreativeLimits,
  prepareCreativePolicy,
  sanitizeTaskForPolicyPlan,
  type CreativePolicyConfirmations,
} from "../../src/domain/creative/generation-policy.js";
import {
  checkPromptPolicy,
  confirmPromptPolicy,
} from "../../src/providers/prompt/policy.js";

const target = {
  providerId: "mock" as const,
  modelId: "mock-image-v1",
  operation: "image" as const,
  settingsHash: "a".repeat(64),
};

describe("creative generation policy", () => {
  it("requires a hash-bound confirmation and strips named IP before dispatch", () => {
    const promptText = "طفلة أصلية في عالم Disney بأسلوب Miyazaki";
    const challenge = captureCreativeError(() => policy({ promptText }));
    expect(challenge).toMatchObject({
      code: "CREATIVE_POLICY_CONFIRMATION_REQUIRED",
      details: {
        bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        matchedCategories: ["franchise_trademark", "living_artist"],
      },
    });
    const check = checkPromptPolicy(promptText, "modern_cartoon");
    if (check.status !== "confirmation_required") throw new Error("fixture");
    const result = policy({
      promptText,
      confirmations: { prompt: confirmPromptPolicy(check) },
    });
    expect(result.plan.prompt).toMatchObject({ status: "transformed" });
    expect(result.sanitizedPrompt).not.toMatch(/Disney|Miyazaki/i);
    expect(result.sanitizedPrompt).toContain("أصلية");

    expect(() =>
      policy({
        promptText: `${promptText} تغيّر`,
        confirmations: { prompt: confirmPromptPolicy(check) },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_POLICY_CONFIRMATION_STALE" }),
    );
  });

  it("requires one explicit balanced reduction confirmation", () => {
    const participants = [
      { characterId: "a", candidateAssetIds: ["a1", "a2"] },
      { characterId: "b", candidateAssetIds: ["b1", "b2"] },
    ];
    const challenge = captureCreativeError(() =>
      policy({
        participants,
        limits: { maxReferenceImages: 3, reliableCharacterCount: 2 },
      }),
    );
    expect(challenge).toMatchObject({
      code: "CREATIVE_CAPACITY_CONFIRMATION_REQUIRED",
      details: {
        bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        counts: [
          { characterId: "a", requested: 2, selected: 2 },
          { characterId: "b", requested: 2, selected: 1 },
        ],
      },
    });
    const bindingHash = challenge.details?.bindingHash;
    if (typeof bindingHash !== "string") throw new Error("fixture");
    const result = policy({
      participants,
      limits: { maxReferenceImages: 3, reliableCharacterCount: 2 },
      confirmations: { capacity: { bindingHash, confirmed: true } },
    });
    expect(result.plan.capacity).toMatchObject({
      selectedAssetIds: ["a1", "a2", "b1"],
      reduced: true,
      confirmed: true,
    });
    expect(
      verifyCreativeCapacityPlan({
        plan: result.plan.capacity,
        target,
        referenceAssetIds: ["a1", "b1"],
        participantIds: ["a", "b"],
      }),
    ).toEqual({ reliableCharacterCountAcknowledged: false });
  });

  it("keeps null limits unavailable and binds participant-risk acknowledgement", () => {
    expect(() =>
      policy({
        limits: { maxReferenceImages: null, reliableCharacterCount: 2 },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_CAPABILITY_UNAVAILABLE" }),
    );
    const participants = [
      { characterId: "a", candidateAssetIds: ["a1"] },
      { characterId: "b", candidateAssetIds: ["b1"] },
    ];
    const challenge = captureCreativeError(() =>
      policy({
        participants,
        limits: { maxReferenceImages: 2, reliableCharacterCount: 1 },
      }),
    );
    const bindingHash = challenge.details?.bindingHash;
    if (typeof bindingHash !== "string") throw new Error("fixture");
    const result = policy({
      participants,
      limits: { maxReferenceImages: 2, reliableCharacterCount: 1 },
      confirmations: { capacity: { bindingHash, confirmed: true } },
    });
    expect(
      verifyCreativeCapacityPlan({
        plan: result.plan.capacity,
        target,
        referenceAssetIds: ["a1", "b1"],
        participantIds: ["a", "b"],
      }),
    ).toEqual({ reliableCharacterCountAcknowledged: true });
  });

  it("keeps configured targets exact and rejects unconfirmed later policy content", () => {
    expect(configuredCreativeLimits(target)).toEqual({
      maxReferenceImages: 20,
      reliableCharacterCount: 20,
    });
    const geminiTarget = { ...target, providerId: "gemini" as const };
    expect(configuredCreativeLimits(geminiTarget)).toEqual({
      maxReferenceImages: null,
      reliableCharacterCount: null,
    });
    expect(
      configuredCreativeLimits(geminiTarget, {
        maxReferenceImages: 4,
        reliableCharacterCount: 2,
      }),
    ).toEqual({ maxReferenceImages: 4, reliableCharacterCount: 2 });
    expect(
      configuredCreativeLimits({
        ...target,
        providerId: "codex",
        operation: "structured",
      }),
    ).toEqual({ maxReferenceImages: null, reliableCharacterCount: null });

    const allowed = policy();
    const safeTask = { premise: "حكاية أصلية" };
    expect(
      sanitizeTaskForPolicyPlan({
        task: safeTask,
        styleId: "modern_cartoon",
        plan: allowed.plan,
      }),
    ).toBe(safeTask);
    expect(() =>
      sanitizeTaskForPolicyPlan({
        task: { premise: "Disney" },
        styleId: "modern_cartoon",
        plan: allowed.plan,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_POLICY_OUTPUT_REJECTED" }),
    );

    const prompt = "بطلة في عالم Disney";
    const check = checkPromptPolicy(prompt, "modern_cartoon");
    if (check.status !== "confirmation_required") throw new Error("fixture");
    const transformed = policy({
      promptText: prompt,
      confirmations: { prompt: confirmPromptPolicy(check) },
    });
    expect(
      JSON.stringify(
        sanitizeTaskForPolicyPlan({
          task: { premise: "Disney" },
          styleId: "modern_cartoon",
          plan: transformed.plan,
        }),
      ),
    ).not.toContain("Disney");
  });

  it("fails closed when the reference floor cannot fit and rejects stale capacity approval", () => {
    const participants = [
      { characterId: "a", candidateAssetIds: ["a1"] },
      { characterId: "b", candidateAssetIds: ["b1"] },
    ];
    expect(() =>
      policy({
        participants,
        limits: { maxReferenceImages: 1, reliableCharacterCount: 2 },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_CAPABILITY_UNAVAILABLE" }),
    );
    expect(() =>
      policy({
        participants: [{ characterId: "a", candidateAssetIds: ["a1", "a2"] }],
        limits: { maxReferenceImages: 1, reliableCharacterCount: 1 },
        confirmations: {
          capacity: { bindingHash: "f".repeat(64), confirmed: true },
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CREATIVE_CAPACITY_CONFIRMATION_STALE",
      }),
    );
  });
});

function policy(
  overrides: {
    promptText?: string;
    participants?: Array<{
      characterId: string;
      candidateAssetIds: string[];
    }>;
    limits?: {
      maxReferenceImages: number | null;
      reliableCharacterCount: number | null;
    };
    confirmations?: CreativePolicyConfirmations;
  } = {},
) {
  return prepareCreativePolicy({
    target,
    styleId: "modern_cartoon",
    promptText: overrides.promptText ?? "وصف أصلي آمن",
    participants: overrides.participants ?? [
      { characterId: "a", candidateAssetIds: [] },
    ],
    limits: overrides.limits ?? {
      maxReferenceImages: 20,
      reliableCharacterCount: 20,
    },
    confirmations: overrides.confirmations,
  });
}

function captureCreativeError(operation: () => unknown): CreativeError {
  try {
    operation();
  } catch (error) {
    if (error instanceof CreativeError) return error;
    throw error;
  }
  throw new Error("EXPECTED_CREATIVE_ERROR");
}

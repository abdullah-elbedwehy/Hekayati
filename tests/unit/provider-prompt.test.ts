import { describe, expect, it } from "vitest";

import {
  compileProviderPrompt,
  MANDATORY_NEGATIVE_CONSTRAINTS,
} from "../../src/providers/prompt/compiler.js";
import {
  checkPromptPolicy,
  confirmPromptPolicy,
} from "../../src/providers/prompt/policy.js";
import { allocateReferenceBudget } from "../../src/providers/prompt/reference-budget.js";
import { styleConfig } from "../../src/providers/prompt/styles.js";

describe("prompt policy and reference budgeting", () => {
  it("ships three original styles with every mandatory negative class", () => {
    for (const id of [
      "modern_cartoon",
      "colorful_2d",
      "soft_watercolor",
    ] as const) {
      const style = styleConfig(id);
      expect(style.negativeConstraints).toEqual(
        expect.arrayContaining([...MANDATORY_NEGATIVE_CONSTRAINTS]),
      );
    }
  });

  it("requires a hash-bound confirmation for artist/franchise wording", () => {
    const check = checkPromptPolicy(
      "ارسمها بأسلوب Hayao Miyazaki مع Disney",
      "soft_watercolor",
    );
    expect(check).toMatchObject({
      status: "confirmation_required",
      matchedCategories: ["franchise_trademark", "living_artist"],
    });
    if (check.status !== "confirmation_required") throw new Error("fixture");
    const confirmation = confirmPromptPolicy(check);
    expect(
      compileProviderPrompt({
        provider: "gemini",
        prompt: check.originalPrompt,
        styleId: "soft_watercolor",
        confirmation,
      }),
    ).toMatchObject({ ok: true });
    expect(
      compileProviderPrompt({
        provider: "codex",
        prompt: `${check.originalPrompt} changed`,
        styleId: "soft_watercolor",
        confirmation,
      }),
    ).toMatchObject({
      ok: false,
      failure: { category: "invalid_input" },
    });
  });

  it("allocates one reference per participant before round-robin extras", () => {
    const plan = allocateReferenceBudget({
      maxReferenceImages: 5,
      reliableCharacterCount: 5,
      participants: [
        { characterId: "a", candidateAssetIds: ["a1", "a2", "a3"] },
        { characterId: "b", candidateAssetIds: ["b1", "b2"] },
        { characterId: "c", candidateAssetIds: ["c1", "c2"] },
      ],
    });
    expect(plan).toEqual({
      ok: true,
      selectedAssetIds: ["a1", "b1", "c1", "a2", "b2"],
      counts: [
        { characterId: "a", requested: 3, selected: 2 },
        { characterId: "b", requested: 2, selected: 2 },
        { characterId: "c", requested: 2, selected: 1 },
      ],
      reduced: true,
      notice: "تم تقليل صور المراجع بالتساوي لتناسب حد المزوّد.",
    });
  });

  it("blocks null, insufficient, duplicate, and over-reliability budgets", () => {
    const base = {
      maxReferenceImages: 2 as number | null,
      reliableCharacterCount: 2 as number | null,
      participants: [
        { characterId: "a", candidateAssetIds: ["a1"] },
        { characterId: "b", candidateAssetIds: ["b1"] },
      ],
    };
    expect(
      allocateReferenceBudget({ ...base, maxReferenceImages: null }),
    ).toMatchObject({ ok: false });
    expect(
      allocateReferenceBudget({ ...base, maxReferenceImages: 1 }),
    ).toMatchObject({ ok: false });
    expect(
      allocateReferenceBudget({
        ...base,
        participants: [base.participants[0], base.participants[0]],
      }),
    ).toMatchObject({ ok: false });
    expect(
      allocateReferenceBudget({ ...base, reliableCharacterCount: 1 }),
    ).toMatchObject({ ok: false });
  });
});

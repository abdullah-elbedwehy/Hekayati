import { describe, expect, it } from "vitest";

import {
  characterProfileSchema,
  classifyCharacterChange,
  normalizeDuplicateDisplayName,
} from "../../src/domain/library/index.js";

describe("library domain policy", () => {
  it("normalizes duplicate names without biometric or cross-record inference", () => {
    expect(normalizeDuplicateDisplayName("  أَحْمَد\t  Ali  ")).toBe(
      "أحمد ali",
    );
    expect(normalizeDuplicateDisplayName("CAFÉ")).toBe("café");
  });

  it("enforces source-mode and custom-relationship invariants", () => {
    expect(() =>
      characterProfileSchema.parse(
        profile({ sourceMode: "photo", referencePhotoIds: [] }),
      ),
    ).toThrow("PHOTO_SOURCE_REQUIRES_REFERENCE");
    expect(() =>
      characterProfileSchema.parse(
        profile({ sourceMode: "description", referencePhotoIds: [id(1)] }),
      ),
    ).toThrow("DESCRIPTION_SOURCE_FORBIDS_REFERENCE");
    expect(() =>
      characterProfileSchema.parse(
        profile({
          relationship: { type: "custom", customLabel: "" },
        }),
      ),
    ).toThrow();
  });

  it("classifies every applicable matrix row instead of choosing one winner", () => {
    const before = characterProfileSchema.parse(profile());
    const after = characterProfileSchema.parse(
      profile({
        name: "ليلى الجديدة",
        ageOrRange: "8",
        notes: "ملامح ثابتة",
      }),
    );

    expect(classifyCharacterChange(before, after)).toEqual([
      {
        matrixRow: "IM-01",
        changeType: "permanent_appearance",
        changedFields: ["ageOrRange", "notes"],
      },
      {
        matrixRow: "IM-02",
        changeType: "non_visual_profile",
        changedFields: ["ageOrRange", "notes"],
      },
      {
        matrixRow: "IM-05",
        changeType: "rename",
        changedFields: ["name"],
      },
    ]);
  });
});

function profile(overrides: Record<string, unknown> = {}) {
  return {
    name: "ليلى",
    nickname: null,
    relationship: { type: "sister" },
    appearanceDescription: "طفلة بشعر أسود",
    ageOrRange: "7",
    gender: "أنثى",
    skinTone: "قمحي",
    hair: "أسود",
    eyeColor: "بني",
    relativeHeight: "متوسط",
    build: "متوسط",
    distinguishingFeatures: [],
    glasses: null,
    hijab: null,
    accessories: [],
    interests: [],
    favoriteObjects: [],
    favoriteColor: null,
    personalityTraits: [],
    speakingStyle: null,
    notes: null,
    sourceMode: "description",
    referencePhotoIds: [],
    traits: {},
    ...overrides,
  };
}

function id(sequence: number): string {
  return `01J${sequence.toString().padStart(23, "0")}`;
}

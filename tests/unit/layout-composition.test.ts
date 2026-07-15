import { describe, expect, it } from "vitest";

import {
  compileCustomerComposition,
  COMPOSITION_SOURCE_POLICY_VERSION,
} from "../../src/domain/layout/composition.js";

const id = (suffix: string) => `01J00000000000000000000${suffix}`;
const checksum = (value: string) => value.repeat(64);

function input(pageCount: 16 | 24 = 16) {
  const storyCount = pageCount === 16 ? 12 : 20;
  return {
    projectId: id("01"),
    projectVersionId: id("02"),
    pageCount,
    title: "ليلى وحديقة الليمون",
    dedicationText: "إلى ليلى بشجاعة وحب",
    farewellText: "وكل حكاية حلوة تبدأ بخطوة",
    brandLine: "حكايتي — الحكاية التي تشبهك",
    childDisplayName: "ليلى",
    environmentLine: null,
    synopsis: null,
    storyPages: Array.from({ length: storyCount }, (_, index) => ({
      pageId: id(String(10 + index).padStart(2, "0")),
      pageNumber: index + 3,
      text: `صفحة الحكاية ${index + 1}`,
      textVersionId: id("40"),
      textHash: checksum("a"),
      layoutVersionId: id("41"),
      layoutHash: checksum("b"),
      illustration: {
        assetId: id(String(50 + index).padStart(2, "0")),
        checksum: checksum("c"),
        approved: true,
      },
    })),
    mainChildThreeQuarter: null,
    identityAsset: { assetId: id("90"), checksum: checksum("d") },
  } as const;
}

describe("customer composition compiler", () => {
  it.each([16, 24] as const)(
    "creates the exact %i-page interior map with deterministic sources",
    (pageCount) => {
      const result = compileCustomerComposition(input(pageCount));

      expect(result.acceptance).toBe("ready");
      expect(result.interior).toHaveLength(pageCount);
      expect(result.interior.map((entry) => entry.kind)).toEqual([
        "title",
        "dedication",
        ...Array(pageCount === 16 ? 12 : 20).fill("story"),
        "ending1",
        "ending2",
      ]);
      expect(result.interior[0]?.artwork).toEqual(
        input(pageCount).storyPages[0]?.illustration,
      );
      expect(result.interior[1]?.artwork).toBeNull();
      expect(result.interior.at(-1)?.artwork).toEqual(
        input(pageCount).identityAsset,
      );
      expect(result.cover.back.artwork).toBeNull();
      expect(result.sourcePolicyVersion).toBe(
        COMPOSITION_SOURCE_POLICY_VERSION,
      );
    },
  );

  it("uses the exact approved three-quarter fallback", () => {
    const base = input();
    const fallback = {
      assetId: id("91"),
      checksum: checksum("e"),
      approved: true,
    };
    const result = compileCustomerComposition({
      ...base,
      storyPages: base.storyPages.map((page) => ({
        ...page,
        illustration: { ...page.illustration, approved: false },
      })),
      mainChildThreeQuarter: fallback,
    });

    expect(result.acceptance).toBe("ready");
    expect(result.cover.front.artwork).toEqual(fallback);
    expect(result.interior[0]?.selectionSource).toBe("automatic_v1");
  });

  it("requires operator action when required hero artwork is unresolved", () => {
    const base = input();
    const result = compileCustomerComposition({
      ...base,
      storyPages: base.storyPages.map((page) => ({
        ...page,
        illustration: { ...page.illustration, approved: false },
      })),
    });

    expect(result.acceptance).toBe("needs_operator");
    expect(result.warnings).toEqual(["COMPOSITION_SOURCE_REQUIRED"]);
    expect(result.cover.front.artwork).toBeNull();
  });

  it("rejects a story count that does not match the canonical map", () => {
    const base = input();
    expect(() =>
      compileCustomerComposition({
        ...base,
        storyPages: base.storyPages.slice(1),
      }),
    ).toThrowError("COMPOSITION_STORY_PAGE_COUNT_INVALID");
  });
});

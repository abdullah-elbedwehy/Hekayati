import { describe, expect, it } from "vitest";
import { ulid } from "ulid";

import {
  calculateNarrationBalance,
  compileAuthoringSegments,
  createPageCountPlan,
  degradeMentionToUnresolved,
  filterMentionCandidates,
  getBookPageMap,
  normalizeMentionSearch,
  seedTemplateDefinitions,
  storyTemplateContentSchema,
  type CompileParticipant,
} from "../../src/domain/authoring/index.js";

describe("narration/dialogue balance formula v1", () => {
  it("combines every configured driver, clamps, and preserves edits", () => {
    expect(
      calculateNarrationBalance({
        audienceAgeBand: "age_3_5",
        readingLevel: "early",
        storyType: "related_situations",
        pageCount: 16,
        sceneComplexity: "high",
      }),
    ).toEqual({
      suggestedNarrationPercent: 85,
      selectedNarrationPercent: 85,
      operatorEdited: false,
      formulaVersion: "hekayati.balance.v1",
    });
    expect(
      calculateNarrationBalance(
        {
          audienceAgeBand: "age_9_12",
          readingLevel: "independent",
          storyType: "connected_adventure",
          pageCount: 24,
          sceneComplexity: "low",
        },
        { selectedNarrationPercent: 63, operatorEdited: true },
      ),
    ).toMatchObject({
      suggestedNarrationPercent: 40,
      selectedNarrationPercent: 63,
      operatorEdited: true,
    });
  });
});

describe("canonical book structure", () => {
  it("projects exact 16/24 interior page maps", () => {
    const compact = getBookPageMap(16);
    expect(compact).toHaveLength(16);
    expect(compact[0]).toEqual({ pageNumber: 1, kind: "title" });
    expect(compact[1]).toEqual({ pageNumber: 2, kind: "dedication" });
    expect(compact[2]).toEqual({
      pageNumber: 3,
      kind: "story",
      storyPageIndex: 1,
    });
    expect(compact[13]).toEqual({
      pageNumber: 14,
      kind: "story",
      storyPageIndex: 12,
    });
    expect(compact.slice(-2)).toEqual([
      { pageNumber: 15, kind: "farewell" },
      { pageNumber: 16, kind: "brand" },
    ]);
    expect(
      getBookPageMap(24).filter((page) => page.kind === "story"),
    ).toHaveLength(20);
  });

  it("makes deterministic add/merge plans pinned to heads and scenes", () => {
    const twelve = Array.from({ length: 12 }, () => ulid());
    const expand = createPageCountPlan({
      projectId: ulid(),
      expectedProjectVersionId: ulid(),
      expectedStoryVersionId: ulid(),
      from: 16,
      to: 24,
      sourceSceneVersionIds: twelve,
    });
    expect(
      expand.operations.filter((item) => item.type === "add"),
    ).toHaveLength(8);
    expect(
      expand.operations.filter((item) => item.type === "retain"),
    ).toHaveLength(12);
    expect(expand.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(createPageCountPlan(expand.input)).toEqual(expand);

    const shrink = createPageCountPlan({
      ...expand.input,
      from: 24,
      to: 16,
      sourceSceneVersionIds: Array.from({ length: 20 }, () => ulid()),
    });
    expect(shrink.operations.some((item) => item.type === "merge")).toBe(true);
    expect(
      shrink.operations.flatMap((item) => item.sourceSceneVersionIds),
    ).toHaveLength(20);
  });
});

describe("identity-safe Arabic mentions", () => {
  it("degrades pasted or partially deleted tokens and keeps duplicate-name candidates distinct", () => {
    const first = participant("friend", "الصديق");
    const second = participant("brother", "الأخ");
    const candidates = [first, second].map((item) => ({
      characterId: item.characterId,
      displayName: "أَحْمَد علي",
      relationshipType: item.relationshipType,
      narrativeRole: item.narrativeRole,
      thumbnailUrl: null,
      archived: false,
    }));
    expect(degradeMentionToUnresolved(" @أحمد ")).toEqual({
      type: "unresolved",
      text: "@أحمد",
    });
    expect(degradeMentionToUnresolved(" ")).toEqual({
      type: "unresolved",
      text: "@",
    });
    expect(filterMentionCandidates("@أحمد علي", candidates)).toHaveLength(2);
    expect(new Set(candidates.map(({ characterId }) => characterId)).size).toBe(
      2,
    );
    expect(JSON.stringify(mention(first.characterId))).not.toContain(
      "displayName",
    );
  });

  it("normalizes diacritics and compiles groups in project order", () => {
    expect(normalizeMentionSearch("  أَحْمَد   Ali  ")).toBe("أحمد ali");
    const hero = participant("main_child", "البطل");
    const friend = participant("friend", "الصديق");
    const mother = participant("mother", "المساند");
    const pet = participant("pet", "الرفيق");
    const result = compileAuthoringSegments({
      segments: [
        { type: "group", groupKey: "hero" },
        { type: "text", text: " و" },
        { type: "group", groupKey: "friends" },
        {
          type: "mention",
          characterId: mother.characterId,
          props: props("بتساعد", "مطمئنة"),
        },
      ],
      participants: [hero, friend, mother, pet],
      mainChildId: hero.characterId,
      selectedParticipantIds: [
        hero.characterId,
        friend.characterId,
        mother.characterId,
      ],
      capability: { mode: "mock_unlimited" },
      acknowledgements: { reconciliation: true, capacity: false },
    });
    expect(result.participantIds).toEqual([
      hero.characterId,
      friend.characterId,
      mother.characterId,
    ]);
    expect(result.occurrences.at(-1)?.props.action).toBe("بتساعد");
  });

  it("blocks unresolved, empty groups, unavailable models, and capacity excess", () => {
    const hero = participant("main_child", "البطل");
    expect(() =>
      compileAuthoringSegments({
        segments: [{ type: "unresolved", text: "@شخص" }],
        participants: [hero],
        mainChildId: hero.characterId,
        selectedParticipantIds: [hero.characterId],
        capability: { mode: "mock_unlimited" },
        acknowledgements: { reconciliation: false, capacity: false },
      }),
    ).toThrowError(expect.objectContaining({ code: "MENTION_UNRESOLVED" }));
    expect(() =>
      compileAuthoringSegments({
        segments: [{ type: "group", groupKey: "friends" }],
        participants: [hero],
        mainChildId: hero.characterId,
        selectedParticipantIds: [hero.characterId],
        capability: { mode: "mock_unlimited" },
        acknowledgements: { reconciliation: true, capacity: false },
      }),
    ).toThrowError(expect.objectContaining({ code: "MENTION_GROUP_EMPTY" }));
    expect(() =>
      compileAuthoringSegments({
        segments: [mention(hero.characterId)],
        participants: [hero],
        mainChildId: hero.characterId,
        selectedParticipantIds: [hero.characterId],
        capability: {
          mode: "unavailable",
          modelId: "real-model",
          reason: "unverified",
        },
        acknowledgements: { reconciliation: false, capacity: false },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "MODEL_CAPABILITY_UNAVAILABLE" }),
    );
    expect(() =>
      compileAuthoringSegments({
        segments: [mention(hero.characterId)],
        participants: [hero],
        mainChildId: hero.characterId,
        selectedParticipantIds: [hero.characterId],
        capability: {
          mode: "verified",
          modelId: "real-model",
          reliableReferenceCount: 0,
        },
        acknowledgements: { reconciliation: false, capacity: false },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "PARTICIPANT_CAPACITY_CONFIRMATION_REQUIRED",
      }),
    );
  });
});

describe("seed templates", () => {
  it("ships exactly seven complete, stable, identity-free records", () => {
    expect(seedTemplateDefinitions.map((seed) => seed.seedKey)).toEqual([
      "space_adventure",
      "treasure_island",
      "dinosaur_world",
      "imaginary_city_rescue",
      "underwater_journey",
      "unforgettable_birthday",
      "fully_custom",
    ]);
    for (const seed of seedTemplateDefinitions) {
      expect(() =>
        storyTemplateContentSchema.parse(seed.content),
      ).not.toThrow();
      expect(JSON.stringify(seed)).not.toMatch(/[0-9A-HJKMNP-TV-Z]{26}/);
    }
  });
});

function participant(
  relationshipType: CompileParticipant["relationshipType"],
  narrativeRole: string,
): CompileParticipant {
  return {
    characterId: ulid(),
    characterVersionId: ulid(),
    relationshipType,
    narrativeRole,
    appearance: { type: "base" },
  };
}

function props(action: string, emotion: string) {
  return {
    action,
    emotion,
    position: null,
    framing: null,
    lookId: null,
    heldObject: null,
    gazeTarget: null,
    speaks: false,
    dialogue: null,
  };
}

function mention(characterId: string) {
  return { type: "mention" as const, characterId, props: props("", "") };
}

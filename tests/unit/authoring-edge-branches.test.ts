import { describe, expect, it } from "vitest";
import { ulid } from "ulid";

import {
  assertCrossFamilyDraftReady,
  assertPageCountPlanIntegrity,
  assertPrivacySafeTemplate,
  AuthoringError,
  compileAuthoringSegments,
  createCrossFamilyDraft,
  createPageCountPlan,
  extractPrivacySafeTemplate,
  filterMentionCandidates,
  hiddenGoalSchema,
  mapCrossFamilyRole,
  missingCustomStoryFields,
  rewriteCharacterReferences,
  sceneReferencesCharacter,
  seedTemplateDefinitions,
  storyConfigSchema,
  storyTemplateContentSchema,
  type AppearanceSelection,
  type CompileParticipant,
  type DocumentSegment,
  type MentionProps,
  type SceneContent,
  type StoryTemplateContent,
} from "../../src/domain/authoring/index.js";

describe("authoring character-reference edge paths", () => {
  it("recognizes direct, group, and dialogue references without name matching", () => {
    const targetId = ulid();
    const otherId = ulid();

    expect(
      sceneReferencesCharacter(
        scene([mention(targetId)]),
        targetId,
        "friend",
        false,
      ),
    ).toBe(true);
    expect(
      sceneReferencesCharacter(
        scene([mention(otherId)]),
        targetId,
        "friend",
        false,
      ),
    ).toBe(false);
    expect(
      sceneReferencesCharacter(
        scene([{ type: "group", groupKey: "hero" }]),
        targetId,
        "main_child",
        true,
      ),
    ).toBe(true);
    expect(
      sceneReferencesCharacter(
        scene([{ type: "group", groupKey: "hero" }]),
        targetId,
        "main_child",
        false,
      ),
    ).toBe(false);
    expect(
      sceneReferencesCharacter(
        scene([{ type: "group", groupKey: "friends" }]),
        targetId,
        "friend",
        false,
      ),
    ).toBe(true);
    expect(
      sceneReferencesCharacter(
        scene([{ type: "group", groupKey: "friends" }]),
        targetId,
        "mother",
        false,
      ),
    ).toBe(false);
    expect(
      sceneReferencesCharacter(
        scene([{ type: "group", groupKey: "family" }]),
        targetId,
        "mother",
        false,
      ),
    ).toBe(true);
    expect(
      sceneReferencesCharacter(
        scene([{ type: "group", groupKey: "family" }]),
        targetId,
        "pet",
        false,
      ),
    ).toBe(false);
    expect(
      sceneReferencesCharacter(
        scene([], [{ speakerCharacterId: targetId, text: "أيوه" }]),
        targetId,
        "friend",
        false,
      ),
    ).toBe(true);
    expect(
      sceneReferencesCharacter(
        scene([], [{ speakerCharacterId: otherId, text: "أيوه" }]),
        targetId,
        "friend",
        false,
      ),
    ).toBe(false);
  });

  it("replaces or removes only identity-bound mentions and dialogue", () => {
    const targetId = ulid();
    const replacementId = ulid();
    const otherId = ulid();
    const content = scene(
      [{ type: "text", text: "بداية" }, mention(targetId), mention(otherId)],
      [
        { speakerCharacterId: targetId, text: "أنا هنا" },
        { speakerCharacterId: otherId, text: "وأنا كمان" },
      ],
    );

    const replaced = rewriteCharacterReferences(
      content,
      targetId,
      replacementId,
    );
    expect(replaced.documentSegments).toEqual([
      { type: "text", text: "بداية" },
      mention(replacementId),
      mention(otherId),
    ]);
    expect(replaced.dialogue.map((item) => item.speakerCharacterId)).toEqual([
      replacementId,
      otherId,
    ]);

    const removed = rewriteCharacterReferences(content, targetId, null);
    expect(removed.documentSegments).toEqual([
      { type: "text", text: "بداية" },
      mention(otherId),
    ]);
    expect(removed.dialogue).toEqual([
      { speakerCharacterId: otherId, text: "وأنا كمان" },
    ]);
  });
});

describe("mention compilation edge paths", () => {
  it("returns every candidate for an empty normalized query", () => {
    const candidates = [participant("main_child"), participant("friend")].map(
      (item, index) => ({
        characterId: item.characterId,
        displayName: index === 0 ? "سلمى" : "نور",
        relationshipType: item.relationshipType,
        narrativeRole: item.narrativeRole,
        thumbnailUrl: null,
        archived: false,
      }),
    );
    expect(filterMentionCandidates("@  ", candidates)).toBe(candidates);
  });

  it("rejects duplicate, foreign-selected, and foreign-mentioned identities", () => {
    const hero = participant("main_child");
    const duplicate = { ...hero, characterVersionId: ulid() };
    expect(() =>
      compile([mention(hero.characterId)], [hero, duplicate]),
    ).toThrow(
      expect.objectContaining({ code: "MENTION_CHARACTER_NOT_IN_PROJECT" }),
    );
    expect(() =>
      compile([mention(hero.characterId)], [hero], [ulid()]),
    ).toThrow(
      expect.objectContaining({ code: "MENTION_CHARACTER_NOT_IN_PROJECT" }),
    );
    expect(() => compile([mention(ulid())], [hero])).toThrow(
      expect.objectContaining({ code: "MENTION_CHARACTER_NOT_IN_PROJECT" }),
    );
  });

  it("validates shared and owned looks while rejecting an unowned look", () => {
    const sharedLookId = ulid();
    const shared = participant("main_child", {
      type: "shared_look",
      lookId: sharedLookId,
      lookVersionId: ulid(),
    });
    expect(
      compile(
        [mention(shared.characterId, sharedLookId)],
        [shared],
        [shared.characterId],
      ).occurrences,
    ).toHaveLength(1);

    const ownedLookId = ulid();
    const owned = {
      ...participant("main_child"),
      ownedLookIds: [ownedLookId],
    };
    expect(
      compile(
        [mention(owned.characterId, ownedLookId)],
        [owned],
        [owned.characterId],
      ).occurrences,
    ).toHaveLength(1);
    expect(() =>
      compile(
        [mention(owned.characterId, ulid())],
        [owned],
        [owned.characterId],
      ),
    ).toThrow(expect.objectContaining({ code: "MENTION_LOOK_NOT_OWNED" }));
  });

  it("requires reconciliation, expands family only, and accepts verified capacity", () => {
    const hero = participant("main_child");
    expect(() => compile([{ type: "text", text: "مقدمة" }], [hero])).toThrow(
      expect.objectContaining({
        code: "PARTICIPANT_RECONCILIATION_REQUIRED",
      }),
    );

    const mother = participant("mother");
    const friend = participant("friend");
    const family = compile(
      [{ type: "group", groupKey: "family" }],
      [hero, mother, friend],
      [hero.characterId, mother.characterId],
      {
        mode: "verified",
        modelId: "verified-model",
        reliableReferenceCount: 2,
      },
    );
    expect(family.occurrences.map((item) => item.characterId)).toEqual([
      hero.characterId,
      mother.characterId,
    ]);
    expect(family.warnings).toEqual([]);
  });
});

describe("page-count preflight edge paths", () => {
  it("detects altered operations after accepting an intact plan", () => {
    const plan = pagePlan();
    expect(() => assertPageCountPlanIntegrity(plan)).not.toThrow();
    expect(() =>
      assertPageCountPlanIntegrity({
        ...plan,
        operations: plan.operations.map((operation, index) =>
          index === 0 ? { ...operation, type: "add" as const } : operation,
        ),
      }),
    ).toThrow(expect.objectContaining({ code: "PAGE_COUNT_PREFLIGHT_STALE" }));
  });

  it("rejects no-op, structurally incomplete, and duplicate-source plans", () => {
    const input = pagePlan().input;
    expect(() => createPageCountPlan({ ...input, to: 16 })).toThrow(
      expect.objectContaining({ code: "PAGE_COUNT_PREFLIGHT_REQUIRED" }),
    );
    expect(() =>
      createPageCountPlan({ ...input, sourceSceneVersionIds: [ulid()] }),
    ).toThrow(expect.objectContaining({ code: "STORY_STRUCTURE_INCOMPLETE" }));
    const sourceId = ulid();
    expect(() =>
      createPageCountPlan({
        ...input,
        sourceSceneVersionIds: Array.from({ length: 12 }, () => sourceId),
      }),
    ).toThrow(expect.objectContaining({ code: "PAGE_COUNT_PREFLIGHT_STALE" }));
  });
});

describe("privacy-safe extraction edge paths", () => {
  it("clamps role slots and separates reusable structure from source markers", () => {
    expect(
      extractPrivacySafeTemplate({
        name: "قالب صغير",
        participantCount: 0,
        sourceMarkers: [],
      }).roleSlots,
    ).toHaveLength(1);
    expect(
      extractPrivacySafeTemplate({
        name: "قالب مشاركين",
        participantCount: 2,
        sourceMarkers: [],
      }).roleSlots.map((slot) => slot.slot),
    ).toEqual(["hero", "participant_2"]);
    expect(
      extractPrivacySafeTemplate({
        name: "قالب كبير",
        participantCount: 99,
        sourceMarkers: [],
      }).roleSlots,
    ).toHaveLength(20);

    expect(() =>
      extractPrivacySafeTemplate({
        name: "اسم مصدر سري",
        participantCount: 1,
        sourceMarkers: ["اسم مصدر سري"],
      }),
    ).toThrow(expect.objectContaining({ code: "PRIVACY_SCAN_FAILED" }));
  });

  it("tracks custom-story completeness and cross-family role readiness", () => {
    expect(missingCustomStoryFields(null)).toEqual([
      "premise",
      "beginningBeat",
      "middleBeat",
      "endingBeat",
      "contentBoundaries",
    ]);
    expect(
      missingCustomStoryFields({
        premise: "فكرة",
        beginningBeat: "بداية",
        middleBeat: "وسط",
        endingBeat: "نهاية",
        contentBoundaries: ["آمن"],
      }),
    ).toEqual([]);
    expect(
      missingCustomStoryFields({
        premise: " ",
        beginningBeat: "بداية",
        middleBeat: " ",
        endingBeat: "نهاية",
        contentBoundaries: [" "],
      }),
    ).toEqual(["premise", "middleBeat", "contentBoundaries"]);

    const content = extractPrivacySafeTemplate({
      name: "نسخة عائلية",
      participantCount: 2,
      sourceMarkers: [],
    });
    const draft = createCrossFamilyDraft(content);
    expect(() => assertCrossFamilyDraftReady(draft)).toThrow(
      expect.objectContaining({ code: "CROSS_FAMILY_ROLE_REMAP_REQUIRED" }),
    );
    const unchanged = mapCrossFamilyRole(draft, "missing", ulid());
    expect(unchanged.status).toBe("role_remap_required");
    const optionalMapped = mapCrossFamilyRole(
      unchanged,
      "participant_2",
      ulid(),
    );
    expect(optionalMapped.status).toBe("role_remap_required");
    const ready = mapCrossFamilyRole(optionalMapped, "hero", ulid());
    expect(ready.status).toBe("ready");
    expect(() => assertCrossFamilyDraftReady(ready)).not.toThrow();
  });

  it("rejects forbidden identity keys even when nested", () => {
    const safe = seedTemplateDefinitions[0].content;
    const leaky = {
      ...safe,
      structure: [{ ...safe.structure[0], customerId: ulid() }],
    } as unknown as StoryTemplateContent;
    expect(() => assertPrivacySafeTemplate(leaky, [])).toThrow(
      expect.objectContaining({ code: "PRIVACY_SCAN_FAILED" }),
    );
  });
});

describe("authoring schema and error edge paths", () => {
  it("requires custom hidden-goal text and accepts a complete custom goal", () => {
    expect(
      hiddenGoalSchema.safeParse({
        goal: "custom",
        customGoal: " ",
        presentation: "indirect",
      }).success,
    ).toBe(false);
    expect(
      hiddenGoalSchema.safeParse({
        goal: "custom",
        customGoal: "الثقة بالنفس",
        presentation: "acknowledged_ending",
      }).success,
    ).toBe(true);
  });

  it("enforces main-child, custom-tone, template-pin, and participant uniqueness", () => {
    const valid = storyConfig();
    expect(storyConfigSchema.safeParse(valid).success).toBe(true);
    expect(
      storyConfigSchema.safeParse({ ...valid, mainChildId: ulid() }).success,
    ).toBe(false);
    expect(
      storyConfigSchema.safeParse({
        ...valid,
        tone: "custom",
        customTone: " ",
      }).success,
    ).toBe(false);
    expect(
      storyConfigSchema.safeParse({
        ...valid,
        storyType: "saved_template",
        templateId: ulid(),
        templateVersionId: null,
      }).success,
    ).toBe(false);
    expect(
      storyConfigSchema.safeParse({
        ...valid,
        participants: [
          ...valid.participants,
          { ...valid.participants[0], characterVersionId: ulid() },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires one hero slot and unique template keys", () => {
    const valid = seedTemplateDefinitions[0].content;
    expect(
      storyTemplateContentSchema.safeParse({
        ...valid,
        roleSlots: valid.roleSlots.map((slot) =>
          slot.slot === "hero" ? { ...slot, slot: "lead" } : slot,
        ),
      }).success,
    ).toBe(false);
    expect(
      storyTemplateContentSchema.safeParse({
        ...valid,
        structure: [...valid.structure, valid.structure[0]],
      }).success,
    ).toBe(false);
  });

  it("maps safe error categories to stable HTTP statuses", () => {
    expect(
      new AuthoringError("PROJECT_FAMILY_SCOPE_VIOLATION").statusCode,
    ).toBe(403);
    expect(new AuthoringError("PROJECT_NOT_FOUND").statusCode).toBe(404);
    expect(new AuthoringError("PROJECT_VERSION_CONFLICT").statusCode).toBe(409);
    expect(new AuthoringError("PRIVACY_SCAN_FAILED").statusCode).toBe(422);
  });
});

function participant(
  relationshipType: CompileParticipant["relationshipType"],
  appearance: AppearanceSelection = { type: "base" },
): CompileParticipant {
  return {
    characterId: ulid(),
    characterVersionId: ulid(),
    relationshipType,
    narrativeRole: "دور واضح",
    appearance,
  };
}

function compile(
  segments: DocumentSegment[],
  participants: CompileParticipant[],
  selectedParticipantIds = participants.map((item) => item.characterId),
  capability:
    | { mode: "mock_unlimited" }
    | { mode: "verified"; modelId: string; reliableReferenceCount: number } = {
    mode: "mock_unlimited",
  },
) {
  return compileAuthoringSegments({
    segments,
    participants,
    mainChildId: participants[0]?.characterId ?? ulid(),
    selectedParticipantIds,
    capability,
    acknowledgements: { reconciliation: false, capacity: false },
  });
}

function mention(characterId: string, lookId: string | null = null) {
  return {
    type: "mention" as const,
    characterId,
    props: mentionProps(lookId),
  };
}

function mentionProps(lookId: string | null = null): MentionProps {
  return {
    action: "",
    emotion: "",
    position: null,
    framing: null,
    lookId,
    heldObject: null,
    gazeTarget: null,
    speaks: false,
    dialogue: null,
  };
}

function scene(
  documentSegments: DocumentSegment[],
  dialogue: SceneContent["dialogue"] = [],
): SceneContent {
  return {
    purpose: "",
    description: "",
    documentSegments,
    environment: "",
    timeOfDay: "",
    composition: "",
    cameraFraming: "",
    narrativeText: "",
    dialogue,
    twoImageMoment: false,
  };
}

function pagePlan() {
  return createPageCountPlan({
    projectId: ulid(),
    expectedProjectVersionId: ulid(),
    expectedStoryVersionId: ulid(),
    from: 16,
    to: 24,
    sourceSceneVersionIds: Array.from({ length: 12 }, () => ulid()),
  });
}

function storyConfig() {
  const heroId = ulid();
  return {
    title: "رحلة سلمى",
    mainChildId: heroId,
    participants: [
      {
        characterId: heroId,
        characterVersionId: ulid(),
        narrativeRole: "البطلة",
        appearance: { type: "base" as const },
      },
    ],
    occasion: "",
    dedicationText: "",
    storyType: "connected_adventure" as const,
    templateId: null,
    templateVersionId: null,
    pageCount: 16 as const,
    tone: "light_funny" as const,
    customTone: null,
    illustrationStyleId: "modern_cartoon" as const,
    hiddenGoal: null,
    clothingNotes: "",
    customNotes: "",
    audienceAgeBand: "age_6_8" as const,
    readingLevel: "developing" as const,
    sceneComplexity: "medium" as const,
    narrationDialogueBalance: {
      suggestedNarrationPercent: 60,
      selectedNarrationPercent: 60,
      operatorEdited: false,
      formulaVersion: "hekayati.balance.v1" as const,
    },
    customStory: null,
    endingPages: { farewellText: "", brandLine: "" },
  };
}

import { describe, expect, it } from "vitest";
import { ulid } from "ulid";

import {
  characterSheetIntentSchema,
  creativeRunSchema,
  pageSchema,
} from "../../src/domain/creative/schemas.js";

const at = "2026-07-14T00:00:00.000Z";

describe("creative schema relational invariants", () => {
  it("binds sheet-intent lineage to the presence of reference photos", () => {
    const descriptionOnly = intentFixture();
    expect(characterSheetIntentSchema.parse(descriptionOnly)).toMatchObject({
      referenceLineage: "description_only",
      referencePhotoIds: [],
    });

    const photoDerived = {
      ...descriptionOnly,
      id: ulid(),
      referenceLineage: "photo_derived" as const,
      referencePhotoIds: [ulid()],
      referenceThumbnailAssetIds: [ulid()],
    };
    expect(characterSheetIntentSchema.parse(photoDerived)).toMatchObject({
      referenceLineage: "photo_derived",
    });

    expect(
      characterSheetIntentSchema.safeParse({
        ...descriptionOnly,
        id: ulid(),
        referencePhotoIds: [ulid()],
      }).success,
    ).toBe(false);
    expect(
      characterSheetIntentSchema.safeParse({
        ...photoDerived,
        id: ulid(),
        referencePhotoIds: [],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate, self-referential, and missing run dependencies", () => {
    const valid = runFixture();
    expect(creativeRunSchema.parse(valid).nodes).toHaveLength(1);

    const invalid = creativeRunSchema.safeParse({
      ...valid,
      id: ulid(),
      nodes: [
        {
          ...valid.nodes[0],
          key: "duplicate",
          dependsOnKeys: ["duplicate", "not-materialized"],
        },
        {
          ...valid.nodes[0],
          key: "duplicate",
          intentId: "intent:duplicate",
        },
      ],
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      const messages = invalid.error.issues.map((issue) => issue.message);
      expect(messages).toEqual(
        expect.arrayContaining([
          "RUN_NODE_DUPLICATE",
          "RUN_NODE_SELF_DEPENDENCY",
          "RUN_NODE_DEPENDENCY_MISSING",
        ]),
      );
    }
  });

  it("rejects story-index and stale/lock state contradictions", () => {
    const valid = pageFixture();
    expect(pageSchema.parse(valid)).toMatchObject({
      kind: "story",
      storyPageIndex: 1,
      staleState: "current",
    });

    expect(
      pageSchema.safeParse({
        ...valid,
        id: ulid(),
        kind: "title",
        storyPageIndex: 1,
      }).success,
    ).toBe(false);
    expect(
      pageSchema.safeParse({
        ...valid,
        id: ulid(),
        storyPageIndex: null,
      }).success,
    ).toBe(false);
    expect(
      pageSchema.safeParse({
        ...valid,
        id: ulid(),
        staleReasons: ["IM-07"],
      }).success,
    ).toBe(false);
    expect(
      pageSchema.safeParse({
        ...valid,
        id: ulid(),
        staleState: "locked_stale",
        staleReasons: ["IM-07"],
        locked: false,
      }).success,
    ).toBe(false);
  });
});

function intentFixture() {
  const characterId = ulid();
  return {
    ...base(),
    revision: 0,
    sheetId: ulid(),
    projectId: ulid(),
    customerId: ulid(),
    familyId: ulid(),
    characterId,
    characterVersionId: ulid(),
    appearance: {
      type: "base" as const,
      lookId: null,
      lookVersionId: null,
    },
    characterName: "نور",
    styleId: "modern_cartoon" as const,
    referencePhotoIds: [],
    referenceThumbnailAssetIds: [],
    referenceLineage: "description_only" as const,
    revisionNotes: "synthetic",
    status: "planned" as const,
    priorSheetId: null,
    viewJobIds: {
      face: null,
      front: null,
      threeQuarter: null,
      fullBody: null,
      mainOutfit: null,
    },
    finalizeJobId: null,
    approvalGateJobId: null,
    policyPlan: policyPlan(characterId),
  };
}

function runFixture() {
  const characterId = ulid();
  return {
    ...base(),
    revision: 0,
    projectId: ulid(),
    projectVersionId: ulid(),
    inputStoryVersionId: ulid(),
    outputStoryVersionId: null,
    status: "planned" as const,
    priority: 3,
    nodes: [
      {
        key: "story-plan",
        kind: "story_plan" as const,
        pageNumber: null,
        dependsOnKeys: [],
        intentId: "intent:story-plan",
        jobId: null,
        state: "planned" as const,
      },
    ],
    textTarget: {
      providerId: "mock" as const,
      modelId: "mock-text-v1",
      operation: "structured" as const,
      settingsHash: "a".repeat(64),
    },
    imageTarget: {
      providerId: "mock" as const,
      modelId: "mock-image-v1",
      operation: "image" as const,
      settingsHash: "b".repeat(64),
    },
    textTargetHash: "c".repeat(64),
    imageTargetHash: "d".repeat(64),
    policyPlan: policyPlan(characterId),
    internalReviewGateJobId: null,
  };
}

function pageFixture() {
  return {
    ...base(),
    schemaVersion: 2 as const,
    revision: 0,
    projectId: ulid(),
    pageNumber: 3,
    storyPageIndex: 1,
    kind: "story" as const,
    locked: false,
    reviewStatus: "unreviewed" as const,
    staleState: "current" as const,
    staleReasons: [],
    currentTextVersionId: null,
    currentPromptVersionId: null,
    currentIllustrationVersionId: null,
  };
}

function policyPlan(characterId: string) {
  return {
    prompt: {
      status: "allowed" as const,
      policyVersion: "prompt-policy-v1" as const,
      bindingHash: null,
      matchedCategories: [],
    },
    capacity: {
      providerId: "mock" as const,
      modelId: "mock-image-v1",
      settingsHash: "b".repeat(64),
      maxReferenceImages: 20,
      reliableCharacterCount: 20,
      participants: [
        {
          characterId,
          requestedAssetIds: [],
          selectedAssetIds: [],
        },
      ],
      selectedAssetIds: [],
      reduced: false,
      participantExcess: false,
      bindingHash: "e".repeat(64),
      confirmed: false,
    },
  };
}

function base() {
  return {
    id: ulid(),
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
  };
}

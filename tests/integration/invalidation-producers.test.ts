import { afterEach, describe, expect, it } from "vitest";

import { AuthoringService } from "../../src/domain/authoring/index.js";
import type { ProjectInput } from "../../src/domain/authoring/schemas.js";
import { CreativeInvalidationService } from "../../src/domain/creative/invalidation.js";
import { CreativeRepositories } from "../../src/domain/creative/repositories.js";
import { LibraryRepositories } from "../../src/domain/library/repositories.js";
import { LibraryService } from "../../src/domain/library/index.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { resolveDataPaths } from "../../src/config/paths.js";
import { seedCreativeProject } from "../helpers/creative-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("pre-print invalidation producers", () => {
  it("emits and consumes IM-06/08/09/12/13 with one book bump per correlated mutation", async () => {
    const directory = await temporaryDirectory("hekayati-producer-audit-");
    cleanups.push(directory.cleanup);
    const sceneSeed = await seedCreativeProject(directory.path, "-scene");
    const storySeed = await seedCreativeProject(directory.path, "-story");
    const countSeed = await seedCreativeProject(directory.path, "-count");
    const configSeed = await seedCreativeProject(directory.path, "-config");
    const store = new DocumentStore(resolveDataPaths(directory.path).database);
    cleanups.push(async () => store.close());
    const library = new LibraryService(store);
    const authoring = new AuthoringService(store, library);
    const invalidation = new CreativeInvalidationService(store);
    authoring.bindInvalidation(invalidation);

    updateFirstScene(authoring, sceneSeed);
    appendGeneratedStory(authoring, storySeed);
    changePageCount(authoring, countSeed);
    updateVisibleConfig(authoring, configSeed);

    const repositories = new LibraryRepositories(store);
    const creative = new CreativeRepositories(store);
    const events = repositories.changeEvents.list();
    expect(events.map((event) => event.matrixRow).sort()).toEqual([
      "IM-06",
      "IM-08",
      "IM-09",
      "IM-12",
      "IM-13",
    ]);
    expect(repositories.invalidationReceipts.list()).toHaveLength(5);
    expect(creative.invalidationAudits.list()).toHaveLength(5);
    for (const event of events)
      expect(
        creative.invalidationAudits.queryByField("eventId", event.id),
      ).toHaveLength(1);

    const configEvents = events.filter(
      (event) => event.entityId === configSeed.projectId,
    );
    expect(new Set(configEvents.map((event) => event.correlationId)).size).toBe(
      1,
    );
    expect(
      authoring.getProjectWorkspace(configSeed.scope, configSeed.projectId)
        .project.bookVersion,
    ).toBe(2);
  });
});

function updateFirstScene(
  authoring: AuthoringService,
  seed: Awaited<ReturnType<typeof seedCreativeProject>>,
): void {
  const workspace = authoring.getProjectWorkspace(seed.scope, seed.projectId);
  const scene = workspace.scenes[0];
  authoring.updateScene(
    seed.scope,
    seed.projectId,
    scene.scene.storyPageIndex,
    {
      expectedStoryVersionId: workspace.storyVersion.id,
      expectedSceneVersionId: scene.version.id,
      content: completeScene(seed.characterId, "مشهد واحد محدث"),
    },
  );
}

function appendGeneratedStory(
  authoring: AuthoringService,
  seed: Awaited<ReturnType<typeof seedCreativeProject>>,
): void {
  const workspace = authoring.getProjectWorkspace(seed.scope, seed.projectId);
  authoring.appendGeneratedStory(seed.scope, seed.projectId, {
    expectedProjectVersionId: workspace.version.id,
    expectedStoryVersionId: workspace.storyVersion.id,
    planJson: { schemaVersion: 1, source: "synthetic" },
    scenes: workspace.scenes.map(({ scene }) => ({
      storyPageIndex: scene.storyPageIndex,
      content: completeScene(
        seed.characterId,
        `مشهد ${scene.storyPageIndex} مكتمل`,
      ),
    })),
  });
}

function changePageCount(
  authoring: AuthoringService,
  seed: Awaited<ReturnType<typeof seedCreativeProject>>,
): void {
  const plan = authoring.preflightPageCountChange(
    seed.scope,
    seed.projectId,
    24,
  );
  authoring.confirmPageCountChange(seed.scope, seed.projectId, plan);
}

function updateVisibleConfig(
  authoring: AuthoringService,
  seed: Awaited<ReturnType<typeof seedCreativeProject>>,
): void {
  const workspace = authoring.getProjectWorkspace(seed.scope, seed.projectId);
  authoring.updateProject(seed.scope, seed.projectId, {
    expectedVersionId: workspace.version.id,
    input: seedInput(seed.characterId, {
      title: "عنوان جديد مرئي",
      illustrationStyleId: "soft_watercolor",
    }),
  });
}

function completeScene(characterId: string, narrativeText: string) {
  return {
    purpose: "لحظة واضحة",
    description: "مشهد آمن ومفهوم",
    documentSegments: [
      {
        type: "mention" as const,
        characterId,
        props: {
          action: "بيتحرك بثقة",
          emotion: "متحمس",
          position: null,
          framing: null,
          lookId: null,
          heldObject: null,
          gazeTarget: null,
          speaks: false,
          dialogue: null,
        },
      },
    ],
    environment: "مكان خيالي",
    timeOfDay: "نهار",
    composition: "واسع",
    cameraFraming: "متوسط",
    narrativeText,
    dialogue: [],
    twoImageMoment: false,
  };
}

function seedInput(
  characterId: string,
  changes: Partial<ProjectInput> = {},
): ProjectInput {
  return {
    title: "رحلة نور الاصطناعية-config",
    mainChildId: characterId,
    participants: [{ characterId, narrativeRole: "البطلة" }],
    occasion: "اختبار",
    dedicationText: "إهداء اصطناعي",
    storyType: "connected_adventure",
    pageCount: 16,
    tone: "adventurous",
    customTone: null,
    illustrationStyleId: "modern_cartoon",
    hiddenGoal: {
      goal: "confidence",
      customGoal: null,
      presentation: "indirect",
    },
    clothingNotes: "",
    customNotes: "مغامرة فضائية آمنة",
    audienceAgeBand: "age_6_8",
    readingLevel: "developing",
    sceneComplexity: "medium",
    selectedNarrationPercent: null,
    customStory: null,
    endingPages: { farewellText: "إلى اللقاء", brandLine: "حكايتي" },
    ...changes,
  };
}

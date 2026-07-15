import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { resolveDataPaths } from "../../src/config/paths.js";
import { AuthoringService } from "../../src/domain/authoring/index.js";
import { CreativePageService } from "../../src/domain/creative/pages.js";
import { CreativeRepositories } from "../../src/domain/creative/repositories.js";
import { LibraryService } from "../../src/domain/library/index.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { LayoutService } from "../../src/domain/layout/layouts.js";
import { initializeLayoutPersistence } from "../../src/domain/layout/migrations.js";
import { LayoutRepositories } from "../../src/domain/layout/repositories.js";
import { seedCreativeProject } from "../helpers/creative-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-15T01:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("story layout derivation", () => {
  it("creates the first downstream head over a locked exact review without changing creative bytes", async () => {
    const fixture = await reviewedPage();
    const before = creativeSnapshot(fixture.creative, fixture.page.id);
    const service = layoutService(fixture.store, fixture.assetId);

    const result = service.deriveStoryLayout({
      pageId: fixture.page.id,
      expectedPageRevision: fixture.page.revision,
      jobId: ulid(),
      requestedPlacement: "auto",
      measurements: quietMeasurements(),
    });

    expect(result.layout).toMatchObject({
      pageId: fixture.page.id,
      previousVersionId: null,
      requestedPlacement: "auto",
      resolvedPlacement: "top",
      acceptance: "ready",
      inputSnapshot: {
        textVersionId: fixture.page.currentTextVersionId,
        illustrationVersionId: fixture.page.currentIllustrationVersionId,
        pageReviewId: fixture.reviewId,
        pageObservationRevision: fixture.page.revision,
      },
    });
    expect(result.head).toMatchObject({
      id: fixture.page.id,
      pageId: fixture.page.id,
      revision: 0,
      currentLayoutVersionId: result.layout.id,
    });
    expect(creativeSnapshot(fixture.creative, fixture.page.id)).toEqual(before);

    expect(() =>
      service.deriveStoryLayout({
        pageId: fixture.page.id,
        expectedPageRevision: fixture.page.revision,
        jobId: ulid(),
        requestedPlacement: "bottom",
        measurements: quietMeasurements(),
      }),
    ).toThrow("LAYOUT_LOCKED_REPLACEMENT");
    expect(fixture.layout.layoutVersions.list()).toHaveLength(1);
    fixture.store.close();
  });

  it("requires unlock for a successor and rejects a stale page fence atomically", async () => {
    const fixture = await reviewedPage();
    const service = layoutService(fixture.store, fixture.assetId);
    const first = service.deriveStoryLayout({
      pageId: fixture.page.id,
      expectedPageRevision: fixture.page.revision,
      jobId: ulid(),
      requestedPlacement: "top",
      measurements: quietMeasurements(),
    });
    const pages = new CreativePageService(fixture.store);
    const unlocked = pages.unlockPage(fixture.page.id, fixture.page.revision);
    const successor = service.deriveStoryLayout({
      pageId: unlocked.id,
      expectedPageRevision: unlocked.revision,
      jobId: ulid(),
      requestedPlacement: "left",
      measurements: quietMeasurements(),
    });

    expect(successor.layout.previousVersionId).toBe(first.layout.id);
    expect(successor.head).toMatchObject({
      revision: 1,
      currentLayoutVersionId: successor.layout.id,
    });
    expect(() =>
      service.deriveStoryLayout({
        pageId: unlocked.id,
        expectedPageRevision: unlocked.revision - 1,
        jobId: ulid(),
        requestedPlacement: "right",
        measurements: quietMeasurements(),
      }),
    ).toThrow("LAYOUT_STALE_INPUT");
    expect(fixture.layout.layoutVersions.list()).toHaveLength(2);
    fixture.store.close();
  });
});

async function reviewedPage() {
  const temp = await temporaryDirectory("hekayati-layout-service-");
  cleanups.push(temp.cleanup);
  const seed = await seedCreativeProject(temp.path, "-layout");
  const store = new DocumentStore(resolveDataPaths(temp.path).database);
  initializeLayoutPersistence(store);
  const library = new LibraryService(store);
  const authoring = new AuthoringService(store, library, { now: () => at });
  const workspace = authoring.getProjectWorkspace(seed.scope, seed.projectId);
  const firstScene = workspace.scenes[0];
  const authored = authoring.updateScene(
    seed.scope,
    seed.projectId,
    firstScene.scene.storyPageIndex,
    {
      expectedStoryVersionId: workspace.storyVersion.id,
      expectedSceneVersionId: firstScene.version.id,
      content: completeScene(seed.characterId),
    },
  );
  const pages = new CreativePageService(store, { now: () => at });
  const empty = pages.ensureProjectPages(seed.projectId, 16)[2];
  const assetId = ulid();
  const generated = pages.seedGeneratedPage({
    pageId: empty.id,
    expectedRevision: empty.revision,
    sceneVersionId: authored.scenes[0].version.id,
    narrative: "قالت البطلة: هيا نبدأ مغامرتنا.",
    prompt: {
      schemaVersion: 1,
      pageNumber: 1,
      prompt: "مشهد اصطناعي آمن بلا نص",
      negativeConstraints: [
        "no_extra_people",
        "no_story_text",
        "no_onomatopoeia",
        "no_photoreal_face",
      ],
      referencePlan: [],
    },
    illustrationAssetId: assetId,
    provenance: {
      provider: "mock",
      modelId: "mock-image-v1",
      at,
      inputVersionRefs: {},
      promptVersion: "mock-v1",
      referenceAssetIds: [],
      attempt: 1,
      settingsSnapshotHash: "f".repeat(64),
    },
  }).page;
  const reviewed = pages.recordReview({
    pageId: generated.id,
    expectedRevision: generated.revision,
    textVersionId: generated.currentTextVersionId!,
    illustrationVersionId: generated.currentIllustrationVersionId!,
    checks: allChecks(),
    notes: "مراجعة اصطناعية مكتملة",
  });
  const page = pages.lockPage(reviewed.page.id, reviewed.page.revision);
  return {
    store,
    page,
    assetId,
    reviewId: reviewed.review.id,
    creative: new CreativeRepositories(store),
    layout: new LayoutRepositories(store),
  };
}

function layoutService(store: DocumentStore, assetId: string) {
  return new LayoutService(
    store,
    {
      get: (requestedId) =>
        requestedId === assetId
          ? { id: assetId, sha256: "a".repeat(64) }
          : null,
    },
    { now: () => at },
  );
}

function creativeSnapshot(repositories: CreativeRepositories, pageId: string) {
  const page = repositories.pages.get(pageId)!;
  return JSON.stringify({
    page,
    text: repositories.pageTexts.get(page.currentTextVersionId!),
    illustration: repositories.illustrations.get(
      page.currentIllustrationVersionId!,
    ),
    reviews: repositories.reviews.queryByField("pageId", pageId),
  });
}

function quietMeasurements() {
  return {
    top: { quietness: 0.9, contrast: 8 },
    bottom: { quietness: 0.8, contrast: 8 },
    right: { quietness: 0.7, contrast: 7 },
    left: { quietness: 0.6, contrast: 7 },
  };
}

function completeScene(characterId: string) {
  return {
    purpose: "لحظة واضحة",
    description: "مشهد اصطناعي آمن",
    documentSegments: [
      {
        type: "mention" as const,
        characterId,
        props: {
          action: "تتحرك بثقة",
          emotion: "متحمسة",
          position: "يمين المشهد",
          framing: null,
          lookId: null,
          heldObject: null,
          gazeTarget: null,
          speaks: true,
          dialogue: "هيا نبدأ",
        },
      },
    ],
    environment: "حديقة خيالية",
    timeOfDay: "نهار",
    composition: "واسع",
    cameraFraming: "متوسط",
    narrativeText: "قالت البطلة: هيا نبدأ مغامرتنا.",
    dialogue: [{ speakerCharacterId: characterId, text: "هيا نبدأ" }],
    twoImageMoment: false,
  };
}

function allChecks() {
  return {
    identityMatchesSheet: true,
    outfitMatchesPlan: true,
    participantsExact: true,
    petAnatomySafe: true,
    ageAndRegisterAppropriate: true,
    noInImageText: true,
    artTextConsistent: true,
    noSexualizedChild: true,
    noGraphicViolence: true,
    noDangerousInstructions: true,
    noHumiliationOrPunishment: true,
    noHateOrStereotypes: true,
    noAdultThemes: true,
    noChildBlame: true,
    noExcessiveFear: true,
    noCopyrightCharacter: true,
    noLivingArtistImitation: true,
    noContactDetails: true,
    noCrossCustomerData: true,
  };
}

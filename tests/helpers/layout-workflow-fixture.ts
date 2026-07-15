import { AssetStore } from "../../src/assets/asset-store.js";
import { resolveDataPaths } from "../../src/config/paths.js";
import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import { CreativePageService } from "../../src/domain/creative/pages.js";
import { initializeLayoutPersistence } from "../../src/domain/layout/migrations.js";
import { PreviewWorkflowCoordinator } from "../../src/domain/layout/workflow.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { createLayoutJobDefinitions } from "../../src/jobs/layout-definitions.js";
import { JobRuntime } from "../../src/jobs/runtime.js";
import type { Provenance } from "../../src/providers/contract.js";
import { seedCreativeProject } from "./creative-fixtures.js";
import { syntheticPreviewSource } from "./preview-fixtures.js";

export async function createLayoutWorkflowFixture(
  dataDir: string,
  pageCount: 16 | 24 = 16,
) {
  const seed = await seedCreativeProject(dataDir, "-workflow", false, {
    pageCount,
  });
  const paths = resolveDataPaths(dataDir);
  const store = new DocumentStore(paths.database);
  initializeLayoutPersistence(store);
  const assets = new AssetStore(store, paths.assets);
  const sourceAsset = await assets.put({
    bytes: await syntheticPreviewSource(),
    extension: "png",
    mime: "image/png",
    role: "illustration",
    origin: "derived",
    width: 1_400,
    height: 1_900,
  });
  seedReviewedPages(store, seed.projectId, sourceAsset.id, pageCount);
  const settings = {
    get: () => ({
      typography: { minimumAge3To5Pt: 14, minimumAge6PlusPt: 12 },
      watermarkText: "حكايتي — معاينة",
    }),
  };
  const workflow = new PreviewWorkflowCoordinator(store, assets, settings);
  const runtime = createRuntime(store, assets, workflow);
  workflow.bindScheduler(runtime.scheduler);
  return { seed, store, assets, workflow, runtime, paths };
}

function createRuntime(
  store: DocumentStore,
  assets: AssetStore,
  workflow: PreviewWorkflowCoordinator,
) {
  const holder: { runtime: JobRuntime | null } = { runtime: null };
  const definitions = createLayoutJobDefinitions({
    assets,
    workflow,
    scheduler: () => {
      if (!holder.runtime) throw new Error("SYNTHETIC_RUNTIME_NOT_READY");
      return holder.runtime.scheduler;
    },
  });
  const runtime = new JobRuntime(store, {
    definitions,
    pollIntervalMs: 5,
    heartbeatIntervalMs: 50,
    leaseTtlMs: 500,
    timeoutMs: 30_000,
    maxWorkers: 4,
    storageProbe: () => Promise.resolve(true),
  });
  holder.runtime = runtime;
  return runtime;
}

export function seedReviewedPages(
  store: DocumentStore,
  projectId: string,
  assetId: string,
  pageCount: 16 | 24 = 16,
): void {
  const authoring = new AuthoringRepositories(store);
  const pages = new CreativePageService(store, {
    now: () => "2026-07-15T04:00:00.000Z",
  });
  const allPages = pages.ensureProjectPages(projectId, pageCount);
  const scenes = authoring.scenes
    .queryByField("projectId", projectId)
    .sort((left, right) => left.storyPageIndex - right.storyPageIndex);
  for (const page of allPages.filter((item) => item.kind === "story")) {
    const scene = scenes.find(
      (candidate) => candidate.storyPageIndex === page.storyPageIndex,
    );
    if (!scene) throw new Error("SYNTHETIC_SCENE_MISSING");
    const generated = pages.seedGeneratedPage({
      pageId: page.id,
      expectedRevision: page.revision,
      sceneVersionId: scene.currentVersionId,
      narrative: `قالت نور: دي الصفحة ${page.storyPageIndex}.`,
      prompt: syntheticPrompt(page.storyPageIndex ?? 1),
      illustrationAssetId: assetId,
      provenance: syntheticProvenance(),
    }).page;
    const reviewed = pages.recordReview({
      pageId: generated.id,
      expectedRevision: generated.revision,
      textVersionId: generated.currentTextVersionId!,
      illustrationVersionId: generated.currentIllustrationVersionId!,
      checks: completedChecks(),
      notes: "مراجعة اصطناعية مكتملة",
    }).page;
    pages.lockPage(reviewed.id, reviewed.revision);
  }
}

function syntheticPrompt(pageNumber: number) {
  return {
    schemaVersion: 1 as const,
    pageNumber,
    prompt: "مشهد اصطناعي آمن بلا نص",
    negativeConstraints: [
      "no_extra_people" as const,
      "no_story_text" as const,
      "no_onomatopoeia" as const,
      "no_photoreal_face" as const,
    ],
    referencePlan: [],
  };
}

function syntheticProvenance(): Provenance {
  return {
    provider: "mock",
    modelId: "mock-image-v1",
    at: "2026-07-15T04:00:00.000Z",
    inputVersionRefs: {},
    promptVersion: "mock-v1",
    referenceAssetIds: [],
    attempt: 1,
    settingsSnapshotHash: "f".repeat(64),
  };
}

function completedChecks() {
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

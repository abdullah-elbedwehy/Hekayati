import { AssetStore } from "../../src/assets/asset-store.js";
import { OriginalAssetStore } from "../../src/assets/original-asset-store.js";
import {
  prepareDataPaths,
  resolveDataPaths,
  type DataPaths,
} from "../../src/config/paths.js";
import { AuthoringService } from "../../src/domain/authoring/index.js";
import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import { CreativePageService } from "../../src/domain/creative/pages.js";
import { CreativeRepositories } from "../../src/domain/creative/repositories.js";
import type { Page } from "../../src/domain/creative/schemas.js";
import { initializeLayoutPersistence } from "../../src/domain/layout/migrations.js";
import {
  LibraryService,
  characterProfileSchema,
} from "../../src/domain/library/index.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import type { JobScheduler } from "../../src/jobs/scheduler.js";
import { syntheticPreviewSource } from "./preview-fixtures.js";
import { seedCreativeEvidence } from "./portability-fixture/creative.js";
import { seedLayoutAndApproval } from "./portability-fixture/layout.js";
import { seedPrintEvidence } from "./portability-fixture/print.js";
import {
  collectionIds,
  deterministicIdFactory,
  fixtureScheduler,
  neutralProvenance,
  portabilityFixtureAt,
  reusableAssetInput,
  seedSyntheticStudio,
  succeedLocalJob,
  syntheticStudioFixtureSchema,
  type PortabilityFixtureScope,
  type SyntheticStudioFixture,
} from "./portability-fixture/support.js";
import { temporaryDirectory } from "./temp.js";

export {
  portabilityFixtureAt,
  syntheticStudioFixtureSchema,
  type PortabilityFixtureScope,
  type SyntheticStudioFixture,
};

export interface PortabilityFixture {
  store: DocumentStore;
  assets: AssetStore;
  originals: OriginalAssetStore;
  paths: DataPaths;
  scope: PortabilityFixtureScope;
  unrelatedScope: PortabilityFixtureScope;
  idsByCollection: Readonly<Record<string, readonly string[]>>;
  records: {
    characterId: string;
    characterVersionId: string;
    referencePhotoId: string;
    originalAssetId: string;
    workingAssetId: string;
    thumbnailAssetId: string;
    providerAssetId: string;
    repeatedAssetId: string;
    retainedReuseAssetId: string;
    previewOutputId: string;
    approvalCycleId: string;
    printRunId: string;
    syntheticStudioOwnedId: string;
    syntheticStudioPromptOnlyId: string;
  };
  cleanup(): Promise<void>;
}

export async function createPortabilityFixture(): Promise<PortabilityFixture> {
  const temp = await temporaryDirectory("hekayati-portability-");
  const paths = resolveDataPaths(`${temp.path}/data`);
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  const assets = new AssetStore(store, paths.assets);
  const originals = new OriginalAssetStore(store, paths.originals);
  const nextId = deterministicIdFactory();
  const now = () => portabilityFixtureAt;
  let cleaned = false;

  try {
    const library = new LibraryService(store, { now, idFactory: nextId });
    const selected = await seedSelectedLibrary(
      library,
      assets,
      originals,
      nextId,
    );
    const authoring = new AuthoringService(store, library, {
      now,
      idFactory: nextId,
    });
    const workspace = authoring.createProject(
      selected.owner,
      projectInput(selected.characterId),
    );
    const scope = { ...selected.owner, projectId: workspace.project.id };
    const unrelated = seedUnrelatedProject(library, authoring);

    initializeLayoutPersistence(store);
    const repeatedAsset = await assets.put({
      bytes: await syntheticPreviewSource(),
      extension: "png",
      mime: "image/png",
      role: "illustration",
      origin: "derived",
      width: 1_400,
      height: 1_900,
    });
    const pages = seedReviewedPages(
      store,
      workspace.project.id,
      repeatedAsset.id,
      nextId,
    );
    const scheduler = fixtureScheduler(store, nextId);
    seedPromptJobs(store, scheduler, scope.projectId);
    await seedCreativeEvidence({
      store,
      assets,
      scheduler,
      scope,
      characterId: selected.characterId,
      characterVersionId: selected.characterVersionId,
      referencePhotoId: selected.referencePhotoId,
      thumbnailAssetId: selected.thumbnailAssetId,
      projectVersionId: workspace.version.id,
      storyVersionId: workspace.storyVersion.id,
      nextId,
    });
    const layout = await seedLayoutAndApproval({
      store,
      assets,
      scheduler,
      scope,
      projectVersionId: workspace.version.id,
      pages,
      repeatedAssetId: repeatedAsset.id,
      nextId,
    });
    const print = await seedPrintEvidence({
      store,
      assets,
      scheduler,
      scope,
      layout,
      repeatedAssetId: repeatedAsset.id,
      nextId,
    });
    const reuse = await assets.put(reusableAssetInput());
    const retainedReuse = await assets.put(reusableAssetInput());
    if (reuse.id !== retainedReuse.id || retainedReuse.refCount !== 2)
      throw new Error("PORTABILITY_RETAINED_REUSE_FIXTURE_INVALID");
    const studio = seedSyntheticStudio(store, scope, reuse.id, nextId);

    return {
      store,
      assets,
      originals,
      paths,
      scope,
      unrelatedScope: unrelated,
      idsByCollection: collectionIds(store),
      records: {
        characterId: selected.characterId,
        characterVersionId: selected.characterVersionId,
        referencePhotoId: selected.referencePhotoId,
        originalAssetId: selected.originalAssetId,
        workingAssetId: selected.workingAssetId,
        thumbnailAssetId: selected.thumbnailAssetId,
        providerAssetId: selected.providerAssetId,
        repeatedAssetId: repeatedAsset.id,
        retainedReuseAssetId: reuse.id,
        previewOutputId: layout.output.id,
        approvalCycleId: layout.cycleId,
        printRunId: print.runId,
        syntheticStudioOwnedId: studio.owned.id,
        syntheticStudioPromptOnlyId: studio.promptOnly.id,
      },
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        store.close();
        await temp.cleanup();
      },
    };
  } catch (error) {
    store.close();
    await temp.cleanup();
    throw error;
  }
}

async function seedSelectedLibrary(
  library: LibraryService,
  assets: AssetStore,
  originals: OriginalAssetStore,
  nextId: () => string,
) {
  const customer = library.createCustomer({
    id: nextId(),
    name: "عميل قابلية النقل الاصطناعي",
    whatsapp: "+201000000000",
    notes: "fixture synthetic only",
  });
  library.recordConsent(customer.id, {
    granted: true,
    date: portabilityFixtureAt,
    note: "موافقة اصطناعية",
  });
  const family = library.createFamily({
    customerId: customer.id,
    name: "عائلة النقل الاصطناعية",
  });
  const owner = { customerId: customer.id, familyId: family.id };
  const created = library.createCharacter(owner, {
    profile: characterProfile("نور النقل"),
  });
  const original = await originals.put({
    bytes: Buffer.from("synthetic-portability-original"),
    extension: "jpg",
    sourceMime: "image/jpeg",
  });
  const working = await assets.put(
    referenceAsset("working", "reference_photo"),
  );
  const thumbnail = await assets.put(referenceAsset("thumbnail", "thumbnail"));
  const provider = await assets.put(
    referenceAsset("provider", "reference_photo"),
  );
  const photoId = nextId();
  const attached = library.attachReferencePhotoToCharacter(owner, {
    characterId: created.character.id,
    expectedVersionId: created.version.id,
    versionId: nextId(),
    photo: {
      id: photoId,
      kind: "face",
      originalAssetId: original.id,
      workingAssetId: working.id,
      thumbnailAssetId: thumbnail.id,
      providerAssetId: provider.id,
      subjectSelection: { x: 0.1, y: 0.1, width: 0.6, height: 0.7 },
      quality: {
        policyVersion: "photo-quality/v1",
        metrics: {
          widthPx: 1_000,
          heightPx: 1_000,
          blurScore: 100,
          exposureScore: 0.5,
          shadowFraction: 0.1,
          subjectBoxAreaRatio: 0.42,
        },
        warnings: [],
        observations: { peopleCount: 1 },
      },
      usableAsFaceReference: true,
      supersedesPhotoId: null,
    },
  });
  return {
    owner,
    characterId: created.character.id,
    characterVersionId: attached.version.id,
    referencePhotoId: photoId,
    originalAssetId: original.id,
    workingAssetId: working.id,
    thumbnailAssetId: thumbnail.id,
    providerAssetId: provider.id,
  };
}

function seedUnrelatedProject(
  library: LibraryService,
  authoring: AuthoringService,
): PortabilityFixtureScope {
  const customer = library.createCustomer({
    name: "عميل آخر اصطناعي",
    whatsapp: "+201000000001",
    notes: "foreign fixture",
  });
  const family = library.createFamily({
    customerId: customer.id,
    name: "عائلة أخرى",
  });
  const character = library.createCharacter(
    { customerId: customer.id, familyId: family.id },
    { profile: characterProfile("سارة الأخرى") },
  );
  const workspace = authoring.createProject(
    { customerId: customer.id, familyId: family.id },
    projectInput(character.character.id),
  );
  return {
    customerId: customer.id,
    familyId: family.id,
    projectId: workspace.project.id,
  };
}

function seedReviewedPages(
  store: DocumentStore,
  projectId: string,
  illustrationAssetId: string,
  nextId: () => string,
): Page[] {
  const pages = new CreativePageService(store, {
    now: () => portabilityFixtureAt,
    idFactory: nextId,
  });
  const authoring = new AuthoringRepositories(store);
  const seeded = pages.ensureProjectPages(projectId, 16);
  const scenes = authoring.scenes
    .queryByField("projectId", projectId)
    .sort((left, right) => left.storyPageIndex - right.storyPageIndex);
  for (const page of seeded.filter((candidate) => candidate.kind === "story")) {
    const scene = scenes.find(
      (candidate) => candidate.storyPageIndex === page.storyPageIndex,
    );
    if (!scene) throw new Error("PORTABILITY_SCENE_FIXTURE_MISSING");
    const generated = pages.seedGeneratedPage({
      pageId: page.id,
      expectedRevision: page.revision,
      sceneVersionId: scene.currentVersionId,
      narrative: `قالت نور: دي صفحة النقل ${page.storyPageIndex}.`,
      prompt: {
        schemaVersion: 1,
        pageNumber: page.storyPageIndex!,
        prompt: "مشهد اصطناعي آمن بلا نص",
        negativeConstraints: [
          "no_extra_people",
          "no_story_text",
          "no_onomatopoeia",
          "no_photoreal_face",
        ],
        referencePlan: [],
      },
      illustrationAssetId,
      provenance: neutralProvenance(),
    }).page;
    const reviewed = pages.recordReview({
      pageId: generated.id,
      expectedRevision: generated.revision,
      textVersionId: generated.currentTextVersionId!,
      illustrationVersionId: generated.currentIllustrationVersionId!,
      checks: completedReviewChecks(),
      notes: "مراجعة نقل اصطناعية مكتملة",
    }).page;
    pages.lockPage(reviewed.id, reviewed.revision);
  }
  return pages.listProjectPages(projectId);
}

function seedPromptJobs(
  store: DocumentStore,
  scheduler: JobScheduler,
  projectId: string,
): void {
  const prompts = new CreativeRepositories(store).pagePrompts.list();
  for (const prompt of prompts)
    succeedLocalJob(scheduler, {
      id: prompt.jobId,
      jobType: "page_prompt",
      projectId,
      intentId: `prompt-${prompt.id}`,
      resultRefs: [prompt.id],
    });
}

function characterProfile(name: string) {
  return characterProfileSchema.parse({
    name,
    nickname: null,
    relationship: { type: "main_child" },
    appearanceDescription: "طفلة اصطناعية بشعر أسود قصير",
    ageOrRange: "7",
    gender: "طفلة",
    skinTone: "قمحي",
    hair: "أسود قصير",
    eyeColor: "بني",
    relativeHeight: "متوسطة",
    build: "طبيعي",
    distinguishingFeatures: [],
    glasses: null,
    hijab: null,
    accessories: [],
    interests: ["الفضاء"],
    favoriteObjects: [],
    favoriteColor: "أخضر",
    personalityTraits: ["فضولية"],
    speakingStyle: "بسيط",
    notes: "synthetic only",
    sourceMode: "description",
    referencePhotoIds: [],
    traits: {},
  });
}

function projectInput(characterId: string) {
  return {
    title: "رحلة نقل اصطناعية",
    mainChildId: characterId,
    participants: [{ characterId, narrativeRole: "البطلة" }],
    occasion: "اختبار",
    dedicationText: "إهداء اصطناعي",
    storyType: "connected_adventure" as const,
    pageCount: 16 as const,
    tone: "adventurous" as const,
    customTone: null,
    illustrationStyleId: "modern_cartoon" as const,
    hiddenGoal: {
      goal: "confidence" as const,
      customGoal: null,
      presentation: "indirect" as const,
    },
    clothingNotes: "",
    customNotes: "مغامرة نقل آمنة",
    audienceAgeBand: "age_6_8" as const,
    readingLevel: "developing" as const,
    sceneComplexity: "medium" as const,
    selectedNarrationPercent: null,
    customStory: null,
    endingPages: { farewellText: "إلى اللقاء", brandLine: "حكايتي" },
  };
}

function referenceAsset(marker: string, role: "reference_photo" | "thumbnail") {
  return {
    bytes: Buffer.from(`synthetic-reference-${marker}`),
    extension: "jpg",
    mime: "image/jpeg",
    role,
    origin: "derived" as const,
    exifStripped: true,
  };
}

function completedReviewChecks() {
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

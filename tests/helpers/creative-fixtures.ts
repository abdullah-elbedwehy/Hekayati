import { createHash } from "node:crypto";

import { ulid } from "ulid";

import { assetRecordSchema } from "../../src/assets/asset-store.js";
import { originalAssetRecordSchema } from "../../src/assets/original-asset-store.js";
import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import { AuthoringService } from "../../src/domain/authoring/index.js";
import {
  characterProfileSchema,
  LibraryService,
} from "../../src/domain/library/index.js";
import {
  DocumentRepository,
  DocumentStore,
} from "../../src/domain/repository/document-store.js";

export async function seedCreativeProject(
  dataDir: string,
  suffix = "",
  withPhoto = false,
  overrides: {
    appearanceDescription?: string;
    customNotes?: string;
    referencePhotoCount?: number;
    pageCount?: 16 | 24;
  } = {},
) {
  const paths = resolveDataPaths(dataDir);
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  const library = new LibraryService(store);
  const customer = library.createCustomer({
    name: `عميل اصطناعي${suffix}`,
    whatsapp: "+201000000000",
    notes: "synthetic",
  });
  const family = library.createFamily({
    customerId: customer.id,
    name: `عائلة اصطناعية${suffix}`,
  });
  const scope = { customerId: customer.id, familyId: family.id };
  const character = library.createCharacter(scope, {
    profile: characterProfileSchema.parse({
      name: `نور${suffix}`,
      nickname: null,
      relationship: { type: "main_child" },
      appearanceDescription:
        overrides.appearanceDescription ??
        "طفلة كرتونية اصطناعية بشعر أسود قصير",
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
    }),
  });
  const photoIds: string[] = [];
  const photoCount = overrides.referencePhotoCount ?? (withPhoto ? 1 : 0);
  let characterVersionId = character.version.id;
  for (let index = 0; index < photoCount; index += 1) {
    const photo = syntheticPhoto();
    seedPhotoAssets(store, photo);
    const attached = library.attachReferencePhotoToCharacter(scope, {
      characterId: character.character.id,
      expectedVersionId: characterVersionId,
      photo,
    });
    characterVersionId = attached.version.id;
    photoIds.push(photo.id);
  }
  const authoring = new AuthoringService(store, library);
  const project = authoring.createProject(scope, {
    title: `رحلة نور الاصطناعية${suffix}`,
    mainChildId: character.character.id,
    participants: [
      { characterId: character.character.id, narrativeRole: "البطلة" },
    ],
    occasion: "اختبار",
    dedicationText: "إهداء اصطناعي",
    storyType: "connected_adventure",
    pageCount: overrides.pageCount ?? 16,
    tone: "adventurous",
    customTone: null,
    illustrationStyleId: "modern_cartoon",
    hiddenGoal: {
      goal: "confidence",
      customGoal: null,
      presentation: "indirect",
    },
    clothingNotes: "",
    customNotes: overrides.customNotes ?? "مغامرة فضائية آمنة",
    audienceAgeBand: "age_6_8",
    readingLevel: "developing",
    sceneComplexity: "medium",
    selectedNarrationPercent: null,
    customStory: null,
    endingPages: { farewellText: "إلى اللقاء", brandLine: "حكايتي" },
  });
  store.close();
  return {
    scope,
    characterId: character.character.id,
    projectId: project.project.id,
    projectVersionId: project.version.id,
    storyVersionId: project.storyVersion.id,
    photoId: photoIds[0] ?? null,
    photoIds,
  };
}

function syntheticPhoto() {
  return {
    id: ulid(),
    kind: "face" as const,
    originalAssetId: ulid(),
    workingAssetId: ulid(),
    thumbnailAssetId: ulid(),
    providerAssetId: ulid(),
    subjectSelection: { x: 0.1, y: 0.1, width: 0.5, height: 0.6 },
    quality: {
      policyVersion: "photo-quality/v1",
      metrics: {
        widthPx: 1000,
        heightPx: 1000,
        blurScore: 100,
        exposureScore: 0.5,
        shadowFraction: 0.1,
        subjectBoxAreaRatio: 0.3,
      },
      warnings: [],
      observations: { peopleCount: 1 },
    },
    usableAsFaceReference: true,
    supersedesPhotoId: null,
  };
}

function seedPhotoAssets(
  store: DocumentStore,
  photo: ReturnType<typeof syntheticPhoto>,
): void {
  const at = new Date().toISOString();
  new DocumentRepository(
    store,
    "original_assets",
    originalAssetRecordSchema,
  ).put({
    id: photo.originalAssetId,
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    sha256: hash(photo.originalAssetId),
    sourceMime: "image/jpeg",
    extension: "jpg",
    bytes: 12,
    refCount: 1,
  });
  for (const [id, role] of [
    [photo.workingAssetId, "reference_photo"],
    [photo.thumbnailAssetId, "thumbnail"],
    [photo.providerAssetId, "reference_photo"],
  ] as const)
    new DocumentRepository(store, "assets", assetRecordSchema).put({
      id,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      sha256: hash(id),
      extension: "jpg",
      bytes: 12,
      refCount: 1,
      mime: "image/jpeg",
      role,
      origin: "derived",
      exifStripped: true,
    });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function waitForValue<T>(
  read: () => T | null,
  timeoutMs = 60_000,
  diagnostic: () => string = () => "",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`CREATIVE_TEST_TIMEOUT ${diagnostic()}`);
}

export function completedCreativeChecks() {
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

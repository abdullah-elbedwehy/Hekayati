import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import { assetRecordSchema } from "../../src/assets/asset-store.js";
import {
  LibraryService,
  characterProfileSchema,
  originalAssetRecordSchema,
  type CharacterProfile,
} from "../../src/domain/library/index.js";
import {
  DocumentRepository,
  DocumentStore,
} from "../../src/domain/repository/document-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("customer and consent lifecycle", () => {
  it("distinguishes absent, refused, and granted consent and survives restart", async () => {
    const fixture = await libraryFixture();
    const customer = fixture.library.createCustomer({
      name: "أسرة تجريبية",
      whatsapp: "+201000000000",
      notes: "بيانات اصطناعية",
    });

    expect(
      fixture.library.consentDecision(customer.id, "direct_photo"),
    ).toEqual({ allowed: false, code: "PHOTO_CONSENT_NOT_RECORDED" });
    expect(
      fixture.library.consentDecision(customer.id, "description_only"),
    ).toEqual({ allowed: true, reason: "PHOTO_NOT_REQUIRED" });
    expect(() =>
      fixture.library.assertPhotoConsent(customer.id, "photo_derived_sheet"),
    ).toThrowError(
      expect.objectContaining({ code: "PHOTO_CONSENT_NOT_RECORDED" }),
    );

    fixture.library.recordConsent(customer.id, {
      granted: false,
      date: "2026-07-14T08:00:00.000Z",
      note: "رفض مسجل",
    });
    expect(
      fixture.library.consentDecision(customer.id, "direct_photo"),
    ).toEqual({ allowed: false, code: "PHOTO_CONSENT_NOT_GRANTED" });

    fixture.library.recordConsent(customer.id, {
      granted: true,
      date: "2026-07-14T09:00:00.000Z",
      note: "موافقة مسجلة",
    });
    expect(
      fixture.library.consentDecision(customer.id, "direct_photo"),
    ).toEqual({ allowed: true, reason: "CONSENT_GRANTED" });
    fixture.library.archiveCustomer(customer.id);
    fixture.library.restoreCustomer(customer.id);
    expect(fixture.library.getCustomer(customer.id).consent?.granted).toBe(
      true,
    );

    fixture.store.close();
    const reopened = new DocumentStore(fixture.database);
    const library = new LibraryService(reopened);
    expect(library.getCustomer(customer.id).consent?.note).toBe("موافقة مسجلة");
    reopened.close();
  });

  it("re-reads consent so revocation invalidates an earlier enqueue decision", async () => {
    const { library } = await libraryFixture();
    const customer = library.createCustomer(customerInput());
    library.recordConsent(customer.id, consent(true));
    expect(library.consentDecision(customer.id, "direct_photo").allowed).toBe(
      true,
    );

    library.recordConsent(customer.id, consent(false));
    expect(() =>
      library.assertPhotoConsent(customer.id, "direct_photo"),
    ).toThrowError(
      expect.objectContaining({ code: "PHOTO_CONSENT_NOT_GRANTED" }),
    );
  });
});

describe("family anchor, scoping, and duplicates", () => {
  it("assigns one immutable main-child anchor and blocks archived-anchor writes", async () => {
    const { library } = await libraryFixture();
    const customer = library.createCustomer(customerInput());
    const family = library.createFamily({
      customerId: customer.id,
      name: "عائلة",
    });
    const scope = { customerId: customer.id, familyId: family.id };

    expect(() =>
      library.createCharacter(scope, {
        profile: profile({ relationship: { type: "father" } }),
      }),
    ).toThrowError(expect.objectContaining({ code: "FAMILY_ANCHOR_REQUIRED" }));
    expect(library.listCharacters(scope)).toEqual([]);

    const anchor = library.createCharacter(scope, {
      profile: profile({ name: "أحمد", relationship: { type: "main_child" } }),
    });
    expect(library.getFamily(scope).anchorCharacterId).toBe(
      anchor.character.id,
    );
    expect(() =>
      library.createCharacter(scope, {
        profile: profile({
          name: "طفل آخر",
          relationship: { type: "main_child" },
        }),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "FAMILY_ANCHOR_IMMUTABLE" }),
    );

    library.archiveCharacter(scope, anchor.character.id);
    expect(() =>
      library.createCharacter(scope, {
        profile: profile({ name: "الأب", relationship: { type: "father" } }),
      }),
    ).toThrowError(expect.objectContaining({ code: "FAMILY_ANCHOR_ARCHIVED" }));
    library.restoreCharacter(scope, anchor.character.id);
    expect(
      library.createCharacter(scope, {
        profile: profile({ name: "الأب", relationship: { type: "father" } }),
      }).character.familyId,
    ).toBe(family.id);
  });

  it("uses one family scope policy for reads and direct-ID mutations", async () => {
    const { library } = await libraryFixture();
    const customer = library.createCustomer(customerInput());
    const familyA = library.createFamily({
      customerId: customer.id,
      name: "أ",
    });
    const familyB = library.createFamily({
      customerId: customer.id,
      name: "ب",
    });
    const scopeA = { customerId: customer.id, familyId: familyA.id };
    const scopeB = { customerId: customer.id, familyId: familyB.id };
    const character = library.createCharacter(scopeA, {
      profile: profile({ relationship: { type: "main_child" } }),
    }).character;

    for (const operation of [
      () => library.getCharacter(scopeB, character.id),
      () => library.archiveCharacter(scopeB, character.id),
      () => library.listLooks(scopeB, character.id),
    ]) {
      expect(operation).toThrowError(
        expect.objectContaining({ code: "FAMILY_SCOPE_MISMATCH" }),
      );
    }
    expect(library.getCharacter(scopeA, character.id).id).toBe(character.id);
  });

  it("finds exact family-local name/relationship duplicates only", async () => {
    const { library } = await libraryFixture();
    const customer = library.createCustomer(customerInput());
    const familyA = library.createFamily({
      customerId: customer.id,
      name: "أ",
    });
    const familyB = library.createFamily({
      customerId: customer.id,
      name: "ب",
    });
    const scopeA = { customerId: customer.id, familyId: familyA.id };
    const scopeB = { customerId: customer.id, familyId: familyB.id };
    const original = library.createCharacter(scopeA, {
      profile: profile({
        name: "أَحْمَد  Ali",
        relationship: { type: "main_child" },
      }),
    }).character;
    library.createCharacter(scopeB, {
      profile: profile({
        name: "أحمد ali",
        relationship: { type: "main_child" },
      }),
    });

    expect(
      library.findDuplicateCharacters(scopeA, {
        name: "  أحمد ali ",
        relationship: { type: "main_child" },
      }),
    ).toEqual([
      {
        characterId: original.id,
        currentVersionId: original.currentVersionId,
        matches: ["normalized_name_relationship"],
      },
    ]);
    expect(
      library.findDuplicateCharacters(scopeA, {
        name: "أحمد ali",
        relationship: { type: "brother" },
      }),
    ).toEqual([]);

    expect(() =>
      library.createCharacter(scopeA, {
        profile: profile({
          name: "أحمد ali",
          relationship: { type: "brother" },
        }),
      }),
    ).not.toThrow();
    const duplicateProfile = profile({
      name: " أَحْمَد  ALI ",
      relationship: { type: "brother" },
    });
    expect(() =>
      library.createCharacter(scopeA, { profile: duplicateProfile }),
    ).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_DECISION_REQUIRED" }),
    );
    expect(
      library.createCharacter(scopeA, {
        profile: duplicateProfile,
        duplicateDecision: "create_separate",
      }).duplicateCandidates,
    ).toHaveLength(1);
  });
});

describe("immutable character and look versions", () => {
  it("atomically appends a version, CAS head, and every classified event", async () => {
    const { library } = await libraryFixture();
    const { scope, character, version } = seededAnchor(library);
    const nextVersionId = ulid();
    const changed = profile({
      name: "ليلى الجديدة",
      relationship: { type: "main_child" },
      ageOrRange: "8",
      notes: "ملامح جديدة",
    });

    const result = library.appendCharacterVersion(scope, {
      characterId: character.id,
      expectedVersionId: version.id,
      versionId: nextVersionId,
      profile: changed,
    });

    expect(result.character.currentVersionId).toBe(nextVersionId);
    expect(result.events.map((event) => event.matrixRow)).toEqual([
      "IM-01",
      "IM-02",
      "IM-05",
    ]);
    expect(
      library.getCharacterVersion(scope, character.id, version.id).profile.name,
    ).toBe("ليلى");
    expect(
      library.getCharacterVersion(scope, character.id, nextVersionId).profile
        .name,
    ).toBe("ليلى الجديدة");
    expect(
      library.listCharacterVersions(scope, character.id).map((item) => item.id),
    ).toEqual([version.id, nextVersionId]);
    expect(library.scopeForCharacterId(character.id)).toEqual(scope);
  });

  it("rolls back stale and duplicate version attempts without partial events", async () => {
    const { library } = await libraryFixture();
    const { scope, character, version } = seededAnchor(library);
    const successful = library.appendCharacterVersion(scope, {
      characterId: character.id,
      expectedVersionId: version.id,
      profile: profile({ relationship: { type: "main_child" }, hair: "بني" }),
    });
    const eventCount = library.listChangeEvents().length;

    expect(() =>
      library.appendCharacterVersion(scope, {
        characterId: character.id,
        expectedVersionId: version.id,
        profile: profile({
          relationship: { type: "main_child" },
          hair: "أشقر",
        }),
      }),
    ).toThrowError(expect.objectContaining({ code: "STALE_VERSION_HEAD" }));
    expect(() =>
      library.appendCharacterVersion(scope, {
        characterId: character.id,
        expectedVersionId: successful.version.id,
        versionId: version.id,
        profile: profile({
          relationship: { type: "main_child" },
          hair: "أشقر",
        }),
      }),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_VERSION_ID" }));
    expect(library.getCharacter(scope, character.id).currentVersionId).toBe(
      successful.version.id,
    );
    expect(library.listChangeEvents()).toHaveLength(eventCount);
  });

  it("reverts by appending and emits look/visibility events without mutating history", async () => {
    const { library } = await libraryFixture();
    const { scope, character, version } = seededAnchor(library);
    const edited = library.appendCharacterVersion(scope, {
      characterId: character.id,
      expectedVersionId: version.id,
      profile: profile({ relationship: { type: "main_child" }, hair: "بني" }),
    });
    const reverted = library.revertCharacterVersion(scope, {
      characterId: character.id,
      expectedVersionId: edited.version.id,
      targetVersionId: version.id,
    });
    expect(reverted.version.id).not.toBe(version.id);
    expect(reverted.version.profile).toEqual(version.profile);

    const look = library.createLook(scope, {
      characterId: character.id,
      content: {
        name: "يومي",
        clothing: "قميص أزرق",
        appearanceOverrides: {},
        referencePhotoIds: [],
      },
    });
    const updated = library.appendLookVersion(scope, {
      characterId: character.id,
      lookId: look.look.id,
      expectedVersionId: look.version.id,
      content: { ...look.version.content, clothing: "قميص أخضر" },
    });
    expect(updated.events.map((event) => event.matrixRow)).toEqual(["IM-03"]);
    expect(
      library
        .listLookVersions(scope, character.id, look.look.id)
        .map((item) => item.id),
    ).toEqual([look.version.id, updated.version.id]);
    expect(library.scopeForLookId(look.look.id)).toEqual({
      ...scope,
      characterId: character.id,
    });
    expect(
      library.archiveLook(scope, character.id, look.look.id).events[0]
        ?.matrixRow,
    ).toBe("IM-21");
  });

  it("stores idempotent invalidation receipts but does not run a cascade", async () => {
    const { library } = await libraryFixture();
    const { scope, character, version } = seededAnchor(library);
    const edit = library.appendCharacterVersion(scope, {
      characterId: character.id,
      expectedVersionId: version.id,
      profile: profile({ relationship: { type: "main_child" }, hair: "بني" }),
    });
    const eventId = edit.events[0].id;
    const input = {
      eventId,
      consequenceHash: "a".repeat(64),
      affectedIds: [character.id],
    };
    expect(library.recordInvalidationReceipt(input)).toEqual(
      library.recordInvalidationReceipt(input),
    );
    expect(() =>
      library.recordInvalidationReceipt({
        ...input,
        consequenceHash: "b".repeat(64),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALIDATION_RECEIPT_CONFLICT" }),
    );
  });
});

describe("atomic reference-photo ownership", () => {
  it("creates a photo-only anchor locally without requiring provider consent", async () => {
    const { library, store } = await libraryFixture();
    const customer = library.createCustomer(customerInput());
    const family = library.createFamily({
      customerId: customer.id,
      name: "عائلة",
    });
    const scope = { customerId: customer.id, familyId: family.id };
    const photoProfile = withoutPhotoFields(
      profile({ relationship: { type: "main_child" } }),
    );

    const facePhoto = photoInput("face");
    seedPhotoAssets(store, facePhoto);
    const created = library.createPhotoOnlyCharacter(scope, {
      profile: photoProfile,
      photo: facePhoto,
    });

    expect(created.version.profile.sourceMode).toBe("photo");
    expect(created.version.profile.referencePhotoIds).toEqual([
      created.photo.id,
    ]);
    expect(created.photo.owner).toEqual({
      type: "character",
      characterId: created.character.id,
    });
    expect(library.getFamily(scope).anchorCharacterId).toBe(
      created.character.id,
    );
    expect(created.events.map((event) => event.matrixRow)).toEqual(["IM-01"]);
    expect(library.consentDecision(customer.id, "direct_photo")).toEqual({
      allowed: false,
      code: "PHOTO_CONSENT_NOT_RECORDED",
    });

    const bothProfile = withoutPhotoFields(
      profile({ name: "سارة", relationship: { type: "sister" } }),
    );
    const otherPhoto = photoInput("other");
    seedPhotoAssets(store, otherPhoto);
    expect(
      library.createPhotoOnlyCharacter(scope, {
        profile: bothProfile,
        sourceMode: "both",
        photo: otherPhoto,
      }).version.profile.sourceMode,
    ).toBe("both");
  });

  it("rejects dangling reference IDs on ordinary version APIs", async () => {
    const { library } = await libraryFixture();
    const { scope } = seededAnchor(library);
    expect(() =>
      library.createCharacter(scope, {
        profile: profile({
          name: "سارة",
          relationship: { type: "sister" },
          sourceMode: "both",
          referencePhotoIds: [ulid()],
        }),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "REFERENCE_PHOTO_OWNERSHIP_MISMATCH" }),
    );
    expect(library.listCharacters(scope)).toHaveLength(1);
  });

  it("rolls back a photo record when owner head CAS fails", async () => {
    const { library, store } = await libraryFixture();
    const { scope, character, version } = seededAnchor(library);
    const advanced = library.appendCharacterVersion(scope, {
      characterId: character.id,
      expectedVersionId: version.id,
      profile: profile({ relationship: { type: "main_child" }, hair: "بني" }),
    });
    const candidate = photoInput("other");
    seedPhotoAssets(store, candidate);

    expect(() =>
      library.attachReferencePhotoToCharacter(scope, {
        characterId: character.id,
        expectedVersionId: version.id,
        photo: candidate,
      }),
    ).toThrowError(expect.objectContaining({ code: "STALE_VERSION_HEAD" }));
    expect(
      library.getDependencyInventory(scope.customerId).referencePhotoIds,
    ).not.toContain(candidate.id);
    expect(library.getCharacter(scope, character.id).currentVersionId).toBe(
      advanced.version.id,
    );
  });

  it("resolves only pinned provider derivatives under current consent", async () => {
    const { library, store } = await libraryFixture();
    const { scope, customer, character, version } = seededAnchor(library);
    const facePhoto = photoInput("face");
    seedPhotoAssets(store, facePhoto);
    const attached = library.attachReferencePhotoToCharacter(scope, {
      characterId: character.id,
      expectedVersionId: version.id,
      photo: facePhoto,
    });
    const draft = {
      source: "reference_photo" as const,
      referencePhotoId: attached.photo.id,
      customerId: customer.id,
      familyId: scope.familyId,
      characterId: character.id,
      owner: {
        type: "character" as const,
        characterVersionId: attached.version.id,
      },
      providerAssetId: attached.photo.providerAssetId!,
    };
    seedProviderAsset(store, attached.photo.providerAssetId!);

    expect(() =>
      library.resolveProviderPhotoReferenceMetadata(draft),
    ).toThrowError(
      expect.objectContaining({ code: "PHOTO_CONSENT_NOT_RECORDED" }),
    );
    library.recordConsent(customer.id, consent(true));
    expect(
      library.resolveProviderPhotoReferenceMetadata(draft).providerAssetId,
    ).toBe(attached.photo.providerAssetId);
    seedProviderAsset(store, attached.photo.providerAssetId!, "thumbnail");
    expect(() =>
      library.resolveProviderPhotoReferenceMetadata(draft),
    ).toThrowError(
      expect.objectContaining({ code: "PROVIDER_REFERENCE_NOT_ELIGIBLE" }),
    );
    seedProviderAsset(store, attached.photo.providerAssetId!);
    expect(() =>
      library.resolveProviderPhotoReferenceMetadata({
        ...draft,
        providerAssetId: attached.photo.workingAssetId,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "PROVIDER_REFERENCE_NOT_ELIGIBLE" }),
    );
    for (const providerAssetId of [attached.photo.originalAssetId, ulid()]) {
      expect(() =>
        library.resolveProviderPhotoReferenceMetadata({
          ...draft,
          providerAssetId,
        }),
      ).toThrowError(
        expect.objectContaining({ code: "PROVIDER_REFERENCE_NOT_ELIGIBLE" }),
      );
    }
    expect(
      library
        .listReferencePhotosForCharacter(scope, character.id)
        .map((item) => item.id),
    ).toEqual([attached.photo.id]);
  });

  it("rejects a face without a selected subject before any record is visible", async () => {
    const { library, store } = await libraryFixture();
    const { scope, character, version } = seededAnchor(library);
    const photo = { ...photoInput("face"), subjectSelection: null };
    seedPhotoAssets(store, photo);
    expect(() =>
      library.attachReferencePhotoToCharacter(scope, {
        characterId: character.id,
        expectedVersionId: version.id,
        photo,
      }),
    ).toThrow("PHOTO_SUBJECT_SELECTION_REQUIRED");
    expect(
      library.getDependencyInventory(scope.customerId).referencePhotoIds,
    ).toEqual([]);
  });
});

async function libraryFixture() {
  const directory = await temporaryDirectory("hekayati-library-");
  cleanups.push(directory.cleanup);
  const paths = resolveDataPaths(`${directory.path}/data`);
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  return {
    database: paths.database,
    store,
    library: new LibraryService(store),
  };
}

function seededAnchor(library: LibraryService) {
  const customer = library.createCustomer(customerInput());
  const family = library.createFamily({
    customerId: customer.id,
    name: "عائلة",
  });
  const scope = { customerId: customer.id, familyId: family.id };
  const created = library.createCharacter(scope, {
    profile: profile({ relationship: { type: "main_child" } }),
  });
  return { scope, customer, family, ...created };
}

function customerInput() {
  return { name: "عميل اصطناعي", whatsapp: "+201000000000", notes: "اختبار" };
}

function consent(granted: boolean) {
  return {
    granted,
    date: new Date().toISOString(),
    note: granted ? "موافقة" : "رفض",
  };
}

function profile(overrides: Record<string, unknown> = {}): CharacterProfile {
  return characterProfileSchema.parse({
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
  });
}

function photoInput(kind: "face" | "other") {
  const workingAssetId = ulid();
  return {
    id: ulid(),
    kind,
    originalAssetId: ulid(),
    workingAssetId,
    thumbnailAssetId: ulid(),
    providerAssetId: kind === "face" ? ulid() : workingAssetId,
    subjectSelection:
      kind === "face" ? { x: 0.1, y: 0.1, width: 0.5, height: 0.6 } : null,
    quality: {
      policyVersion: "photo-quality/v1",
      metrics: {
        widthPx: 1000,
        heightPx: 1000,
        blurScore: 100,
        exposureScore: 0.5,
        shadowFraction: 0.1,
        subjectBoxAreaRatio: kind === "face" ? 0.3 : null,
      },
      warnings: [],
      observations: kind === "face" ? { peopleCount: 1 } : {},
    },
    usableAsFaceReference: kind === "face",
    supersedesPhotoId: null,
  };
}

function seedProviderAsset(
  store: DocumentStore,
  assetId: string,
  role: "reference_photo" | "thumbnail" = "reference_photo",
): void {
  const now = new Date().toISOString();
  new DocumentRepository(store, "assets", assetRecordSchema).put({
    id: assetId,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    sha256: hashId(assetId),
    extension: "jpg",
    bytes: 12,
    refCount: 1,
    mime: "image/jpeg",
    role,
    origin: "derived",
    exifStripped: true,
  });
}

function seedPhotoAssets(
  store: DocumentStore,
  photo: ReturnType<typeof photoInput>,
): void {
  const now = new Date().toISOString();
  new DocumentRepository(
    store,
    "original_assets",
    originalAssetRecordSchema,
  ).put({
    id: photo.originalAssetId,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    sha256: hashId(photo.originalAssetId),
    sourceMime: "image/jpeg",
    extension: "jpg",
    bytes: 12,
    refCount: 1,
  });
  seedProviderAsset(store, photo.workingAssetId);
  seedProviderAsset(store, photo.thumbnailAssetId, "thumbnail");
  if (photo.providerAssetId && photo.providerAssetId !== photo.workingAssetId)
    seedProviderAsset(store, photo.providerAssetId);
}

function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutPhotoFields(profileValue: CharacterProfile) {
  const { sourceMode, referencePhotoIds, ...rest } = profileValue;
  void sourceMode;
  void referencePhotoIds;
  return rest;
}

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import {
  LibraryService,
  characterProfileSchema,
  originalAssetRecordSchema,
  referencePhotoSchema,
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

describe("library lifecycle visibility and idempotency", () => {
  it("filters archived records and keeps repeated lifecycle commands idempotent", async () => {
    const { library } = await libraryFixture();
    const customer = library.createCustomer(customerInput());
    const family = library.createFamily({
      customerId: customer.id,
      name: "عائلة دورة الحياة",
    });
    const scope = { customerId: customer.id, familyId: family.id };

    expect(() => library.getCustomer(ulid())).toThrowError(
      expect.objectContaining({ code: "CUSTOMER_NOT_FOUND" }),
    );
    expect(library.listCustomers({ includeArchived: true })).toHaveLength(1);

    library.archiveCustomer(customer.id);
    const eventCount = library.listChangeEvents().length;
    expect(library.archiveCustomer(customer.id).status).toBe("archived");
    expect(library.listChangeEvents()).toHaveLength(eventCount);
    expect(library.listCustomers()).toEqual([]);
    expect(library.listCustomers({ includeArchived: true })).toHaveLength(1);
    expect(library.listFamilies(customer.id)).toEqual([]);
    expect(
      library.listFamilies(customer.id, { includeArchived: true }),
    ).toHaveLength(1);
    expect(() =>
      library.createFamily({ customerId: customer.id, name: "ممنوعة" }),
    ).toThrowError(expect.objectContaining({ code: "ENTITY_ARCHIVED" }));

    library.restoreCustomer(customer.id);
    expect(library.restoreCustomer(customer.id).status).toBe("active");
    library.archiveFamily(scope);
    const familyEventCount = library.listChangeEvents().length;
    expect(library.archiveFamily(scope).status).toBe("archived");
    expect(library.listChangeEvents()).toHaveLength(familyEventCount);
    expect(library.listFamilies(customer.id)).toEqual([]);
    expect(
      library.listFamilies(customer.id, { includeArchived: true }),
    ).toHaveLength(1);
    library.restoreFamily(scope);
    expect(library.restoreFamily(scope).status).toBe("active");

    const otherCustomer = library.createCustomer({
      ...customerInput(),
      name: "عميل آخر",
    });
    expect(() =>
      library.getFamily({ customerId: otherCustomer.id, familyId: family.id }),
    ).toThrowError(expect.objectContaining({ code: "FAMILY_SCOPE_MISMATCH" }));
    expect(() =>
      library.getFamily({ customerId: customer.id, familyId: ulid() }),
    ).toThrowError(expect.objectContaining({ code: "FAMILY_NOT_FOUND" }));
  });

  it("filters archived members and looks while lifecycle retries stay side-effect free", async () => {
    const { library } = await libraryFixture();
    const { scope, character } = seededAnchor(library);
    const sibling = library.createCharacter(scope, {
      profile: profile({ name: "سارة", relationship: { type: "sister" } }),
    }).character;
    const look = library.createLook(scope, {
      characterId: sibling.id,
      content: {
        name: "رسمي",
        clothing: "فستان أخضر",
        appearanceOverrides: {},
        referencePhotoIds: [],
      },
    }).look;

    library.archiveLook(scope, sibling.id, look.id);
    expect(library.archiveLook(scope, sibling.id, look.id).events).toEqual([]);
    expect(library.listLooks(scope, sibling.id)).toEqual([]);
    expect(
      library.listLooks(scope, sibling.id, { includeArchived: true }),
    ).toHaveLength(1);
    library.restoreLook(scope, sibling.id, look.id);
    expect(library.restoreLook(scope, sibling.id, look.id).events).toEqual([]);

    library.archiveCharacter(scope, sibling.id);
    expect(library.archiveCharacter(scope, sibling.id).events).toEqual([]);
    expect(library.listCharacters(scope).map((item) => item.id)).toEqual([
      character.id,
    ]);
    expect(
      library.listCharacters(scope, { includeArchived: true }),
    ).toHaveLength(2);

    library.archiveCharacter(scope, character.id);
    expect(library.listCharacters(scope)).toEqual([]);
    expect(library.listLooks(scope, sibling.id)).toEqual([]);
  });
});

describe("read-only dependency inventory", () => {
  it("enumerates library records and media handles without deleting anything", async () => {
    const { library, store } = await libraryFixture();
    const { scope, customer, family, character, version } =
      seededAnchor(library);
    const originalId = ulid();
    const photoId = ulid();
    const secondPhotoId = ulid();
    const workingId = ulid();
    const thumbnailId = ulid();
    const now = new Date().toISOString();
    new DocumentRepository(
      store,
      "original_assets",
      originalAssetRecordSchema,
    ).put({
      id: originalId,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      sha256: "c".repeat(64),
      sourceMime: "image/jpeg",
      extension: "jpg",
      bytes: 12,
      refCount: 1,
    });
    const photoRepository = new DocumentRepository(
      store,
      "reference_photos",
      referencePhotoSchema,
    );
    const referencePhoto = referencePhotoSchema.parse({
      id: photoId,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      customerId: customer.id,
      familyId: family.id,
      owner: { type: "character", characterId: character.id },
      kind: "other",
      originalAssetId: originalId,
      workingAssetId: workingId,
      thumbnailAssetId: thumbnailId,
      providerAssetId: workingId,
      subjectSelection: null,
      quality: {
        policyVersion: "photo-quality/v1",
        metrics: {
          widthPx: 1000,
          heightPx: 1000,
          blurScore: 100,
          exposureScore: 0.5,
          shadowFraction: 0.1,
          subjectBoxAreaRatio: null,
        },
        warnings: [],
        observations: {},
      },
      usableAsFaceReference: false,
      supersedesPhotoId: null,
    });
    photoRepository.put(referencePhoto);
    photoRepository.put({ ...referencePhoto, id: secondPhotoId });

    const inventory = library.getDependencyInventory(customer.id);
    expect(inventory.customerIds).toEqual([customer.id]);
    expect(inventory.familyIds).toEqual([scope.familyId]);
    expect(inventory.characterVersionIds).toContain(version.id);
    expect(inventory.referencePhotoIds).toEqual(
      [photoId, secondPhotoId].sort(),
    );
    expect(inventory.originalAssetIds).toEqual([originalId]);
    expect(inventory.derivedAssetIds).toEqual([workingId, thumbnailId].sort());
    expect(inventory.mediaReferences).toEqual(
      [photoId, secondPhotoId].sort().map((referencePhotoId) => ({
        referencePhotoId,
        originalAssetId: originalId,
        derivedAssetIds: [workingId, thumbnailId].sort(),
      })),
    );
    expect(inventory.assetReferenceCounts).toHaveLength(3);
    expect(inventory.assetReferenceCounts).toEqual(
      expect.arrayContaining([
        { namespace: "derived", assetId: thumbnailId, references: 2 },
        { namespace: "derived", assetId: workingId, references: 2 },
        { namespace: "original", assetId: originalId, references: 2 },
      ]),
    );
    expect(inventory.downstreamReferences).toEqual([]);
    expect(library.getCustomer(customer.id).id).toBe(customer.id);
  });
});

async function libraryFixture() {
  const directory = await temporaryDirectory("hekayati-library-lifecycle-");
  cleanups.push(directory.cleanup);
  const paths = resolveDataPaths(`${directory.path}/data`);
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  return { store, library: new LibraryService(store) };
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

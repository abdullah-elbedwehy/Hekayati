import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AssetStore } from "../../src/assets/asset-store.js";
import { OriginalAssetStore } from "../../src/assets/original-asset-store.js";
import {
  PhotoIntakeProcessor,
  type LocalPhotoImageAdapter,
} from "../../src/assets/photo-intake/index.js";
import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import { LibraryService } from "../../src/domain/library/index.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { SettingsService } from "../../src/domain/settings/settings.js";
import { PhotoIntakeCoordinator } from "../../src/server/photo-intake/photo-intake-coordinator.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("photo intake prepared-write rollback", () => {
  it("removes the first derivative and original when the second derivative prepare fails", async () => {
    const directory = await temporaryDirectory("hekayati-photo-rollback-");
    cleanups.push(directory.cleanup);
    const paths = resolveDataPaths(directory.path);
    await prepareDataPaths(paths);
    const store = new DocumentStore(paths.database);
    cleanups.push(() => store.close());
    const assets = new AssetStore(store, paths.assets);
    const originals = new OriginalAssetStore(store, paths.originals);
    const settings = new SettingsService(store, paths);
    settings.initialize();
    const library = new LibraryService(store);
    const coordinator = new PhotoIntakeCoordinator(
      store,
      assets,
      originals,
      settings,
      library,
      new PhotoIntakeProcessor(fakeImageAdapter()),
    );
    cleanups.push(() => coordinator.close());

    await assets.put({
      bytes: Buffer.from("thumbnail-conflict"),
      extension: "jpg",
      mime: "image/jpeg",
      width: 40,
      height: 40,
      role: "reference_photo",
      origin: "derived",
      exifStripped: true,
    });
    const customer = library.createCustomer({
      name: "عميل اصطناعي",
      whatsapp: "",
      notes: "",
    });
    const family = library.createFamily({
      customerId: customer.id,
      name: "عائلة اصطناعية",
    });
    const staged = await coordinator.stage({
      source: bytesSource(pngSignature()),
      familyId: family.id,
      kind: "other",
      owner: {
        type: "new_character",
        draft: photoProfile(),
      },
    });

    await expect(
      coordinator.commit({
        reservationToken: staged.reservationToken,
        observations: {},
        duplicateDecision: { action: "create_separate" },
      }),
    ).rejects.toThrow("ASSET_METADATA_CONFLICT");

    expect(
      library.listCharacters({
        customerId: customer.id,
        familyId: family.id,
      }),
    ).toEqual([]);
    expect(originals.list()).toEqual([]);
    expect(assets.list()).toHaveLength(1);
    expect(await managedFileCount(paths.originals)).toBe(0);
    expect(await managedFileCount(paths.assets)).toBe(1);
  });
});

function fakeImageAdapter(): LocalPhotoImageAdapter {
  return {
    inspect: async () => ({ widthPx: 40, heightPx: 40 }),
    deriveBase: async () => ({
      working: derivative("working-derivative"),
      thumbnail: derivative("thumbnail-conflict"),
      metrics: {
        blurScore: 100,
        exposureScore: 0.5,
        shadowFraction: 0.1,
      },
    }),
    deriveSubjectCrop: async () => derivative("crop-derivative"),
  };
}

function derivative(content: string) {
  return {
    bytes: Buffer.from(content),
    mime: "image/jpeg" as const,
    extension: "jpg" as const,
    widthPx: 40,
    heightPx: 40,
    metadataStripped: true as const,
  };
}

async function* bytesSource(bytes: Buffer): AsyncIterable<Uint8Array> {
  yield Buffer.from(bytes);
}

function pngSignature(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function photoProfile() {
  return {
    name: "طفل اصطناعي",
    nickname: null,
    relationship: { type: "main_child" as const },
    appearanceDescription: "",
    ageOrRange: null,
    gender: null,
    skinTone: null,
    hair: null,
    eyeColor: null,
    relativeHeight: null,
    build: null,
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
    sourceMode: "photo" as const,
    referencePhotoIds: [],
    traits: {},
  };
}

async function managedFileCount(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true });
  const counts = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name === ".keep" || entry.name === ".DS_Store") return 0;
      if (entry.isFile()) return 1;
      return entry.isDirectory() ? managedFileCount(join(root, entry.name)) : 0;
    }),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}

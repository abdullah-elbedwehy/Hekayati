import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AssetStore } from "../../src/assets/asset-store.js";
import { PrinterProfileService } from "../../src/domain/print/profiles.js";
import { PrintRepositories } from "../../src/domain/print/repositories.js";
import { createDefaultPrinterProfileDraft } from "../../src/domain/print/schemas.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("print repository concurrency contracts", () => {
  it("keeps immutable inserts unique and revisioned heads behind exact CAS", async () => {
    const directory = await temporaryDirectory("hekayati-print-repositories-");
    const store = new DocumentStore(join(directory.path, "hekayati.db"));
    cleanups.push(async () => {
      store.close();
      await directory.cleanup();
    });
    const assets = new AssetStore(store, join(directory.path, "assets"));
    const profiles = new PrinterProfileService(store, assets);
    const created = profiles.create({
      name: "Repository profile",
      draft: {
        ...createDefaultPrinterProfileDraft(),
        spine: { source: "explicit", widthMm: 8 },
      },
    });
    const print = new PrintRepositories(store);

    expect(() => print.profileVersions.insert(created.version)).toThrow(
      "PRINT_DUPLICATE_ENTITY",
    );
    const successor = {
      ...created.profile,
      revision: 1,
      updatedAt: "2026-07-15T01:00:00.000Z",
      name: "Repository profile updated",
    };
    expect(print.profiles.update(0, successor)).toEqual(successor);
    expect(print.profiles.queryByField("name", successor.name)).toEqual([
      successor,
    ]);

    expect(() =>
      print.profiles.update(0, { ...successor, revision: 2 }),
    ).toThrow("PRINT_REVISION_CONFLICT");
    expect(() =>
      print.profiles.update(1, { ...successor, revision: 3 }),
    ).toThrow("PRINT_REVISION_INVALID");
    expect(() =>
      print.profiles.update(1, {
        ...successor,
        revision: 2,
        createdAt: "2026-07-15T02:00:00.000Z",
      }),
    ).toThrow("PRINT_IMMUTABLE_FIELD_CHANGED");
    expect(() =>
      print.profiles.update(0, {
        ...created.profile,
        id: "01J00000000000000000000999",
        revision: 1,
      }),
    ).toThrow("PRINT_ENTITY_NOT_FOUND");
  });
});

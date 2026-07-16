import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AssetStore,
  assetRecordSchema,
} from "../../src/assets/asset-store.js";
import {
  OriginalAssetStore,
  originalAssetRecordSchema,
} from "../../src/assets/original-asset-store.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-16T21:00:00.000Z";
const ids = {
  asset: "01K80000000000000000000001",
  existingAsset: "01K80000000000000000000002",
  original: "01K80000000000000000000003",
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe("planned import media preparation", () => {
  let store: DocumentStore | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    store?.close();
    await cleanup?.();
    store = undefined;
    cleanup = undefined;
  });

  it("prepares and commits a fresh asset under the immutable planned ID and refcount", async () => {
    const fixture = await setup();
    const assets = fixture.assets;
    const planned = assetRecordSchema.parse({
      id: ids.asset,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      sha256: sha256(png),
      extension: "png",
      bytes: png.byteLength,
      refCount: 3,
      mime: "image/png",
      width: 1,
      height: 1,
      role: "illustration",
      origin: "derived",
    });

    const prepared = await assets.prepareImported({
      record: planned,
      bytes: png,
      wasPreexisting: false,
    });
    expect(prepared.record.id).toBe(ids.asset);
    expect(prepared.isNew).toBe(true);
    expect(assets.get(ids.asset)).toBeNull();

    const committed = store!.transactionImmediate(() =>
      assets.commitPreparedImported(prepared, 3),
    );
    expect(committed).toEqual(planned);
    expect(assets.get(ids.asset)).toEqual(planned);
  });

  it("retains only the exact deduplicated target and rejects a stale planned ID", async () => {
    const fixture = await setup();
    const existing = await fixture.assets.put({
      bytes: png,
      extension: "png",
      mime: "image/png",
      role: "illustration",
      origin: "derived",
      width: 1,
      height: 1,
    });
    expect(existing.id).not.toBe(ids.existingAsset);

    await expect(
      fixture.assets.prepareImported({
        record: { ...existing, id: ids.existingAsset },
        bytes: png,
        wasPreexisting: true,
      }),
    ).rejects.toThrow("IMPORTED_ASSET_TARGET_STALE");

    const prepared = await fixture.assets.prepareImported({
      record: existing,
      bytes: png,
      wasPreexisting: true,
    });
    const retained = store!.transactionImmediate(() =>
      fixture.assets.commitPreparedImported(prepared, 2),
    );
    expect(retained.id).toBe(existing.id);
    expect(retained.refCount).toBe(3);
  });

  it("uses the same exact planned-record boundary for originals", async () => {
    const fixture = await setup();
    const planned = originalAssetRecordSchema.parse({
      id: ids.original,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      sha256: sha256(jpeg),
      sourceMime: "image/jpeg",
      extension: "jpg",
      bytes: jpeg.byteLength,
      refCount: 2,
    });

    const prepared = await fixture.originals.prepareImported({
      record: planned,
      bytes: jpeg,
      wasPreexisting: false,
    });
    const committed = store!.transactionImmediate(() =>
      fixture.originals.commitPreparedImported(prepared, 2),
    );
    expect(committed).toEqual(planned);
    expect(fixture.originals.verifyPreparedIntegritySync(prepared)).toEqual({
      assetId: planned.id,
      expectedSha256: planned.sha256,
      status: "healthy",
      reason: null,
    });
  });

  async function setup() {
    const temp = await temporaryDirectory("hekayati-import-media-prepare-");
    cleanup = temp.cleanup;
    store = new DocumentStore(join(temp.path, "app.sqlite"));
    return {
      assets: new AssetStore(store, join(temp.path, "assets")),
      originals: new OriginalAssetStore(store, join(temp.path, "originals")),
    };
  }
});

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

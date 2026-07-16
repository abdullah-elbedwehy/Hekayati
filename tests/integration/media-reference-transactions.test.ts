import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AssetStore } from "../../src/assets/asset-store.js";
import { OriginalAssetStore } from "../../src/assets/original-asset-store.js";
import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("transaction-owned media references", () => {
  it("acquires an asset hold once, rolls back deltas, and defers zero-ref unlink", async () => {
    const fixture = await mediaFixture();
    const record = await fixture.assets.put({
      bytes: Buffer.from("transaction-owned-asset"),
      extension: "bin",
      mime: "application/octet-stream",
      role: "thumbnail",
      origin: "derived",
    });
    const path = fixture.assets.pathForRecord(record);

    expect(() => fixture.assets.retainInTransaction(record.id)).toThrow(
      "MEDIA_REFERENCE_TRANSACTION_REQUIRED",
    );
    expect(() =>
      fixture.assets.holdInTransaction(record.id, () => "acquired"),
    ).toThrow("MEDIA_REFERENCE_TRANSACTION_REQUIRED");
    expect(() =>
      fixture.assets.releaseWithoutUnlinkInTransaction(record.id),
    ).toThrow("MEDIA_REFERENCE_TRANSACTION_REQUIRED");

    const firstHold = fixture.store.transactionImmediate(() =>
      fixture.assets.holdInTransaction(
        record.id,
        claimHold(fixture.store, "asset", "export-1", record.id),
      ),
    );
    const replayedHold = fixture.store.transactionImmediate(() =>
      fixture.assets.holdInTransaction(
        record.id,
        claimHold(fixture.store, "asset", "export-1", record.id),
      ),
    );
    expect(firstHold).toMatchObject({
      acquired: true,
      record: { refCount: 2 },
    });
    expect(replayedHold).toMatchObject({
      acquired: false,
      record: { refCount: 2 },
    });

    expect(() =>
      fixture.store.transactionImmediate(() => {
        fixture.assets.retainInTransaction(record.id);
        fixture.assets.holdInTransaction(
          record.id,
          claimHold(fixture.store, "asset", "rolled-back", record.id),
        );
        throw new Error("ROLL_BACK_MEDIA_DELTAS");
      }),
    ).toThrow("ROLL_BACK_MEDIA_DELTAS");
    expect(fixture.assets.get(record.id)?.refCount).toBe(2);
    expect(holdCount(fixture.store, "rolled-back")).toBe(0);

    const shared = fixture.store.transactionImmediate(() =>
      fixture.assets.releaseWithoutUnlinkInTransaction(record.id),
    );
    expect(shared).toMatchObject({ record: { refCount: 1 } });
    expect(shared.cleanupIntent).toBeNull();
    expect(statSync(path).isFile()).toBe(true);

    let existedInsideTransaction = false;
    const zero = fixture.store.transactionImmediate(() => {
      const result = fixture.assets.releaseWithoutUnlinkInTransaction(
        record.id,
      );
      existedInsideTransaction = statSync(path).isFile();
      return result;
    });
    expect(existedInsideTransaction).toBe(true);
    expect(zero.record).toBeNull();
    expect(zero.cleanupIntent).toEqual({
      namespace: "asset",
      mediaId: record.id,
      checksum: record.sha256,
      managedKey: `${record.sha256.slice(0, 2)}/${record.sha256}.bin`,
    });
    expect(fixture.assets.get(record.id)).toBeNull();
    expect(statSync(path).isFile()).toBe(true);
    expect(() =>
      fixture.store.transactionImmediate(() =>
        fixture.assets.unlinkCleanupIntent(zero.cleanupIntent!),
      ),
    ).toThrow("MEDIA_CLEANUP_TRANSACTION_FORBIDDEN");

    await expect(
      fixture.assets.unlinkCleanupIntent(zero.cleanupIntent!),
    ).resolves.toBe("unlinked");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fixture.assets.unlinkCleanupIntent(zero.cleanupIntent!),
    ).resolves.toBe("absent");
  });

  it("preserves original shared refs and rolls back a zero-ref cleanup intent", async () => {
    const fixture = await mediaFixture();
    const input = {
      bytes: Buffer.from("transaction-owned-original"),
      extension: "jpg",
      sourceMime: "image/jpeg" as const,
    };
    const record = await fixture.originals.put(input);
    const path = fixture.originals.pathForRecord(record);
    expect(() => fixture.originals.retainInTransaction(record.id)).toThrow(
      "MEDIA_REFERENCE_TRANSACTION_REQUIRED",
    );
    expect(() =>
      fixture.originals.holdInTransaction(record.id, () => "acquired"),
    ).toThrow("MEDIA_REFERENCE_TRANSACTION_REQUIRED");
    expect(() =>
      fixture.originals.releaseWithoutUnlinkInTransaction(record.id),
    ).toThrow("MEDIA_REFERENCE_TRANSACTION_REQUIRED");
    expect(
      fixture.store.transactionImmediate(() =>
        fixture.originals.retainInTransaction(record.id),
      ).refCount,
    ).toBe(2);

    const firstHold = fixture.store.transactionImmediate(() =>
      fixture.originals.holdInTransaction(
        record.id,
        claimHold(fixture.store, "original", "snapshot-1", record.id),
      ),
    );
    const replayedHold = fixture.store.transactionImmediate(() =>
      fixture.originals.holdInTransaction(
        record.id,
        claimHold(fixture.store, "original", "snapshot-1", record.id),
      ),
    );
    expect(firstHold).toMatchObject({
      acquired: true,
      record: { refCount: 3 },
    });
    expect(replayedHold).toMatchObject({
      acquired: false,
      record: { refCount: 3 },
    });

    for (const expectedRefCount of [2, 1]) {
      const shared = fixture.store.transactionImmediate(() =>
        fixture.originals.releaseWithoutUnlinkInTransaction(record.id),
      );
      expect(shared.record?.refCount).toBe(expectedRefCount);
      expect(shared.cleanupIntent).toBeNull();
      expect(statSync(path).isFile()).toBe(true);
    }

    expect(() =>
      fixture.store.transactionImmediate(() => {
        const zero = fixture.originals.releaseWithoutUnlinkInTransaction(
          record.id,
        );
        expect(zero.record).toBeNull();
        expect(zero.cleanupIntent?.namespace).toBe("original");
        expect(statSync(path).isFile()).toBe(true);
        throw new Error("ROLL_BACK_ORIGINAL_RELEASE");
      }),
    ).toThrow("ROLL_BACK_ORIGINAL_RELEASE");
    expect(fixture.originals.get(record.id)?.refCount).toBe(1);
    expect(statSync(path).isFile()).toBe(true);

    const committed = fixture.store.transactionImmediate(() =>
      fixture.originals.releaseWithoutUnlinkInTransaction(record.id),
    );
    expect(committed.cleanupIntent).toEqual({
      namespace: "original",
      mediaId: record.id,
      checksum: record.sha256,
      managedKey: `${record.sha256.slice(0, 2)}/${record.sha256}.jpg`,
    });
    expect(statSync(path).isFile()).toBe(true);
    await expect(
      fixture.originals.unlinkCleanupIntent(committed.cleanupIntent!),
    ).resolves.toBe("unlinked");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a replacement indexed before deferred cleanup runs", async () => {
    const fixture = await mediaFixture();
    const input = {
      bytes: Buffer.from("replacement-safe-asset"),
      extension: "bin",
      mime: "application/octet-stream",
      role: "thumbnail" as const,
      origin: "derived" as const,
    };
    const released = await fixture.assets.put(input);
    const cleanup = fixture.store.transactionImmediate(
      () =>
        fixture.assets.releaseWithoutUnlinkInTransaction(released.id)
          .cleanupIntent!,
    );
    const replacement = await fixture.assets.put(input);

    expect(replacement.id).not.toBe(released.id);
    await expect(fixture.assets.unlinkCleanupIntent(cleanup)).resolves.toBe(
      "preserved",
    );
    expect(await fixture.assets.read(replacement.id)).toEqual(input.bytes);
    expect(fixture.assets.get(replacement.id)?.refCount).toBe(1);
  });
});

async function mediaFixture() {
  const directory = await temporaryDirectory("hekayati-media-reference-");
  cleanups.push(directory.cleanup);
  const paths = resolveDataPaths(join(directory.path, "data"));
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  cleanups.push(async () => store.close());
  store.database.exec(`
    CREATE TABLE fixture_media_holds (
      namespace TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      media_id TEXT NOT NULL,
      PRIMARY KEY (namespace, operation_id, media_id)
    )
  `);
  return {
    store,
    assets: new AssetStore(store, paths.assets),
    originals: new OriginalAssetStore(store, paths.originals),
  };
}

function claimHold(
  store: DocumentStore,
  namespace: "asset" | "original",
  operationId: string,
  mediaId: string,
) {
  return () => {
    const result = store.database
      .prepare(
        `INSERT OR IGNORE INTO fixture_media_holds(namespace, operation_id, media_id)
         VALUES (?, ?, ?)`,
      )
      .run(namespace, operationId, mediaId);
    return result.changes === 1 ? ("acquired" as const) : ("replayed" as const);
  };
}

function holdCount(store: DocumentStore, operationId: string): number {
  const result = store.database
    .prepare(
      "SELECT COUNT(*) AS count FROM fixture_media_holds WHERE operation_id = ?",
    )
    .get(operationId) as { count: number };
  return result.count;
}

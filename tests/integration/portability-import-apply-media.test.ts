import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AssetStore, assetRecordSchema } from "../../src/assets/asset-store.js";
import {
  OriginalAssetStore,
  originalAssetRecordSchema,
} from "../../src/assets/original-asset-store.js";
import {
  ImportApplyMediaCoordinator,
  type ImportApplyMediaInput,
} from "../../src/domain/portability/import-apply-media.js";
import { canonicalImportMediaMetadata } from "../../src/domain/portability/import-plan-target.js";
import {
  DocumentStore,
  type BaseDocument,
} from "../../src/domain/repository/document-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-16T23:30:00.000Z";
const assetBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);
const originalBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const ids = {
  operation: id("1"),
  plan: id("2"),
  sourceAsset: id("3"),
  targetAsset: id("4"),
  sourceOriginal: id("5"),
  reservationAsset: id("6"),
  reservationOriginal: id("7"),
};

describe("ImportApplyMediaCoordinator", () => {
  let store: DocumentStore | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    store?.close();
    await cleanup?.();
    store = undefined;
    cleanup = undefined;
  });

  it("reserves every intent before reading staged bytes and recovers reserved writes", async () => {
    const fixture = await setup();
    const built = await buildInput(fixture);
    let firstRead = true;
    const readMedia = vi.fn(async (namespace: "asset" | "original") => {
      if (firstRead) {
        expect(
          fixture.coordinator.repository
            .list(ids.operation)
            .map((row) => row.state),
        ).toEqual(["reserved", "reserved"]);
        firstRead = false;
        throw new Error("TEST_STAGED_READ_INTERRUPTED");
      }
      return namespace === "asset" ? assetBytes : originalBytes;
    });
    const input = { ...built, readMedia };

    const reserved = store!.transactionImmediate(() =>
      fixture.coordinator.reserveInTransaction(input),
    );
    expect(reserved).toHaveLength(2);
    await expect(fixture.coordinator.prepare(input)).rejects.toThrow(
      "TEST_STAGED_READ_INTERRUPTED",
    );
    expect(
      fixture.coordinator.repository
        .list(ids.operation)
        .map((row) => row.state),
    ).toEqual(["reserved", "reserved"]);

    const prepared = await fixture.coordinator.prepare(input);
    expect(prepared.map((row) => row.state)).toEqual(["written", "written"]);
    expect(readMedia).toHaveBeenCalledTimes(3);
  });

  it("commits exact fresh reference counts and retained deltas once", async () => {
    const fixture = await setup();
    const input = await buildInput(fixture);
    store!.transactionImmediate(() =>
      fixture.coordinator.reserveInTransaction(input),
    );
    await fixture.coordinator.prepare(input);

    const committed = store!.transactionImmediate(() =>
      fixture.coordinator.commitInTransaction(input),
    );
    expect(committed.map((row) => row.state)).toEqual([
      "committed",
      "committed",
    ]);
    expect(fixture.assets.get(ids.targetAsset)?.refCount).toBe(3);
    expect(fixture.originals.get(input.retainedOriginalId)?.refCount).toBe(3);

    store!.transactionImmediate(() =>
      fixture.coordinator.commitInTransaction(input),
    );
    expect(fixture.assets.get(ids.targetAsset)?.refCount).toBe(3);
    expect(fixture.originals.get(input.retainedOriginalId)?.refCount).toBe(3);
  });

  it("discards only ledger-proven fresh bytes and is restart-idempotent", async () => {
    const fixture = await setup();
    const input = await buildInput(fixture);
    store!.transactionImmediate(() =>
      fixture.coordinator.reserveInTransaction(input),
    );
    await fixture.coordinator.prepare(input);
    const fresh = fixture.coordinator.repository
      .list(ids.operation)
      .find((row) => row.namespace === "asset")!;
    const retained = fixture.coordinator.repository
      .list(ids.operation)
      .find((row) => row.namespace === "original")!;
    await expect(
      access(fixture.assets.pathForRecord(fresh.record)),
    ).resolves.toBe(undefined);
    await expect(
      access(fixture.originals.pathForRecord(retained.record)),
    ).resolves.toBe(undefined);

    const recovered = new ImportApplyMediaCoordinator(
      store!,
      fixture.assets,
      fixture.originals,
      { nowIso: () => at, idFactory: () => id("8") },
    );
    expect((await recovered.discard(input)).map((row) => row.state)).toEqual([
      "discarded",
      "discarded",
    ]);
    await expect(
      access(fixture.assets.pathForRecord(fresh.record)),
    ).rejects.toThrow();
    await expect(
      access(fixture.originals.pathForRecord(retained.record)),
    ).resolves.toBe(undefined);
    expect(fixture.originals.get(input.retainedOriginalId)?.refCount).toBe(1);
    expect((await recovered.discard(input)).map((row) => row.state)).toEqual([
      "discarded",
      "discarded",
    ]);
  });

  it("rolls back reservations even when no fresh media directory was written", async () => {
    const fixture = await setup();
    const input = await buildInput(fixture);
    store!.transactionImmediate(() =>
      fixture.coordinator.reserveInTransaction(input),
    );

    expect(
      (await fixture.coordinator.discard(input)).map((row) => row.state),
    ).toEqual(["discarded", "discarded"]);
    expect(fixture.originals.get(input.retainedOriginalId)?.refCount).toBe(1);
  });

  async function setup() {
    const temp = await temporaryDirectory("hekayati-import-apply-media-");
    cleanup = temp.cleanup;
    store = new DocumentStore(join(temp.path, "app.sqlite"));
    const assets = new AssetStore(store, join(temp.path, "assets"));
    const originals = new OriginalAssetStore(
      store,
      join(temp.path, "originals"),
    );
    const generated = [ids.reservationAsset, ids.reservationOriginal];
    return {
      assets,
      originals,
      coordinator: new ImportApplyMediaCoordinator(store, assets, originals, {
        nowIso: () => at,
        idFactory: () => generated.shift() ?? id("9"),
      }),
    };
  }
});

async function buildInput(fixture: {
  assets: AssetStore;
  originals: OriginalAssetStore;
}): Promise<ImportApplyMediaInput & { retainedOriginalId: string }> {
  const retained = await fixture.originals.put({
    bytes: originalBytes,
    extension: "jpg",
    sourceMime: "image/jpeg",
  });
  const assetHash = sha256(assetBytes);
  const originalHash = sha256(originalBytes);
  const sourceAsset = assetRecordSchema.parse({
    id: ids.sourceAsset,
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    sha256: assetHash,
    extension: "png",
    bytes: assetBytes.byteLength,
    refCount: 1,
    mime: "image/png",
    width: 1,
    height: 1,
    role: "illustration",
    origin: "derived",
  });
  const plannedAsset = assetRecordSchema.parse({
    ...sourceAsset,
    id: ids.targetAsset,
    refCount: 3,
  });
  const sourceOriginal = originalAssetRecordSchema.parse({
    ...retained,
    id: ids.sourceOriginal,
    refCount: 1,
  });
  const assetFacts = {
    namespace: "asset" as const,
    id: ids.sourceAsset,
    bytes: assetBytes.byteLength,
    sha256: assetHash,
    mime: "image/png",
    extension: "png",
    role: "illustration",
    inspection: { kind: "binary" as const, executable: false as const },
  };
  const originalFacts = {
    namespace: "original" as const,
    id: ids.sourceOriginal,
    bytes: originalBytes.byteLength,
    sha256: originalHash,
    mime: "image/jpeg",
    extension: "jpg",
    role: "reference_photo",
    inspection: { kind: "binary" as const, executable: false as const },
  };
  return {
    operationId: ids.operation,
    planId: ids.plan,
    retainedOriginalId: retained.id,
    source: {
      documents: [
        validatedDocument("assets", sourceAsset),
        validatedDocument("original_assets", sourceOriginal),
      ],
      media: [assetFacts, originalFacts],
    },
    compiled: {
      documents: [
        {
          collection: "assets",
          sourceId: ids.sourceAsset,
          targetId: ids.targetAsset,
          disposition: "create",
          document: plannedAsset,
          sourceDocumentHash: sha256(Buffer.from("source-asset")),
          changedFieldsHash: sha256(Buffer.from("changed-asset")),
        },
      ],
      preparedMedia: [
        {
          entryType: "prepared_media_intent",
          namespace: "asset",
          sourceId: ids.sourceAsset,
          targetId: ids.targetAsset,
          bytes: assetBytes.byteLength,
          sha256: assetHash,
          metadataHash: canonicalImportMediaMetadata({
            facts: assetFacts,
            document: sourceAsset,
          }),
          disposition: "prepare_new",
        },
        {
          entryType: "prepared_media_intent",
          namespace: "original",
          sourceId: ids.sourceOriginal,
          targetId: retained.id,
          bytes: originalBytes.byteLength,
          sha256: originalHash,
          metadataHash: canonicalImportMediaMetadata({
            facts: originalFacts,
            document: sourceOriginal,
          }),
          disposition: "retain_existing",
        },
      ],
      releases: [
        {
          entryType: "reference_delta",
          namespace: "original",
          mediaId: retained.id,
          role: "reference_photo",
          bytes: originalBytes.byteLength,
          sha256: originalHash,
          delta: 2,
          disposition: "retained",
        },
      ],
    },
    readMedia: async (namespace) =>
      namespace === "asset" ? assetBytes : originalBytes,
  };
}

function validatedDocument<T extends BaseDocument>(
  collection: string,
  document: T,
) {
  return {
    collection,
    id: document.id,
    schemaVersion: document.schemaVersion,
    sourceSha256: sha256(Buffer.from(`${collection}:source`)),
    normalizedSha256: sha256(Buffer.from(`${collection}:normalized`)),
    migrationCount: 0,
    document,
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function id(digit: string): string {
  return `01KA000000000000000000000${digit}`;
}

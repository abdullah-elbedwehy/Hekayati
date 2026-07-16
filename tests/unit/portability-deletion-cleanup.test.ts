import { createHash } from "node:crypto";
import { basename } from "node:path";
import { link, unlink } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { ManagedUnlinkLedgerEntry } from "../../src/domain/portability/deletion-ledger.js";
import { ManagedDeletionCleanup } from "../../src/portability/deletion-cleanup.js";
import {
  createDeletionHarness,
  seedManagedExport,
  type DeletionHarness,
} from "../helpers/portability-deletion-fixture.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("managed deletion cleanup", () => {
  it("unlinks zero-ref media idempotently and verifies incomplete/index-present states", async () => {
    const harness = await trackedHarness();
    const record = harness.fixture.originals.get(
      harness.fixture.records.originalAssetId,
    )!;
    const released = harness.fixture.store.transactionImmediate(() =>
      harness.fixture.originals.releaseWithoutUnlinkInTransaction(record.id),
    );
    const entry = mediaEntry(released.cleanupIntent!);
    const cleanup = cleanupFor(harness);

    expect(await cleanup.verify(entry)).toEqual({
      passed: false,
      failureCode: "DELETION_CLEANUP_INCOMPLETE",
    });
    const [completed] = await cleanup.execute([entry]);
    expect(completed).toMatchObject({ state: "unlinked", attempts: 1 });
    expect(await cleanup.verify(completed)).toEqual({
      passed: true,
      failureCode: null,
    });
    expect(await cleanup.execute([completed])).toEqual([completed]);

    const indexed = harness.fixture.assets.get(
      harness.fixture.records.retainedReuseAssetId,
    )!;
    expect(
      await cleanup.verify({
        ...mediaEntry({
          namespace: "asset",
          mediaId: indexed.id,
          checksum: indexed.sha256,
          managedKey: `${indexed.sha256.slice(0, 2)}/${indexed.sha256}.${indexed.extension}`,
        }),
        state: "unlinked",
        attempts: 1,
      }),
    ).toEqual({
      passed: false,
      failureCode: "DELETION_MEDIA_INDEX_PRESENT",
    });
  });

  it("preserves a currently indexed shared asset and verifies its bytes", async () => {
    const harness = await trackedHarness();
    const record = harness.fixture.assets.get(
      harness.fixture.records.retainedReuseAssetId,
    )!;
    const entry = mediaEntry({
      namespace: "asset",
      mediaId: record.id,
      checksum: record.sha256,
      managedKey: `${record.sha256.slice(0, 2)}/${record.sha256}.${record.extension}`,
    });
    const cleanup = cleanupFor(harness);
    const [preserved] = await cleanup.execute([entry]);
    expect(preserved).toMatchObject({ state: "preserved", attempts: 1 });
    expect(await cleanup.verify(preserved)).toEqual({
      passed: true,
      failureCode: null,
    });
    expect(
      await cleanup.verify({ ...preserved, checksum: hash("wrong") }),
    ).toEqual({
      passed: false,
      failureCode: "DELETION_SHARED_MEDIA_MISSING",
    });
  });

  it("blocks an indexed export, then unlinks the exact released archive", async () => {
    const harness = await trackedHarness();
    const managed = await seedManagedExport(harness);
    const entry = exportEntry(managed);
    const cleanup = cleanupFor(harness);
    const [blocked] = await cleanup.execute([entry]);
    expect(blocked).toMatchObject({
      state: "blocked",
      failureCode: "DELETION_CLEANUP_INDEX_PRESENT",
    });
    deleteDocument(harness, "managed_exports", managed.id);
    const [completed] = await cleanup.execute([blocked]);
    expect(completed).toMatchObject({ state: "unlinked", attempts: 2 });
    expect(await cleanup.verify(completed)).toEqual({
      passed: true,
      failureCode: null,
    });
    expect(await cleanup.verify({ ...completed, state: "preserved" })).toEqual({
      passed: false,
      failureCode: "DELETION_EXPORT_NOT_UNLINKED",
    });
  });

  it("treats a missing released archive as idempotently unlinked", async () => {
    const harness = await trackedHarness();
    const managed = await seedManagedExport(harness);
    const entry = exportEntry(managed);
    deleteDocument(harness, "managed_exports", managed.id);
    await unlink(managed.path);
    const [completed] = await cleanupFor(harness).execute([entry]);
    expect(completed).toMatchObject({ state: "unlinked", attempts: 1 });
  });

  it("blocks hard-linked archives, invalid intents, ENOSPC, and generic failures", async () => {
    const harness = await trackedHarness();
    const managed = await seedManagedExport(harness);
    const entry = exportEntry(managed);
    deleteDocument(harness, "managed_exports", managed.id);
    await link(managed.path, `${managed.path}.extra-link`);
    const [hardLinked] = await cleanupFor(harness).execute([entry]);
    expect(hardLinked).toMatchObject({
      state: "blocked",
      failureCode: "DELETION_CLEANUP_INVALID_FILE",
    });

    const [invalid] = await cleanupFor(harness).execute([
      { ...entry, managedKey: "invalid.zip" },
    ]);
    expect(invalid.failureCode).toBe("DELETION_CLEANUP_INVALID_FILE");

    const coded = cleanupFor(harness, () => {
      const error = new Error("full") as Error & { code: string };
      error.code = "ENOSPC";
      throw error;
    });
    expect((await coded.execute([entry]))[0].failureCode).toBe(
      "DELETION_CLEANUP_ENOSPC",
    );
    const generic = cleanupFor(harness, () => {
      throw new Error("opaque failure");
    });
    expect((await generic.execute([entry]))[0].failureCode).toBe(
      "DELETION_CLEANUP_FAILED",
    );
  });
});

async function trackedHarness(): Promise<DeletionHarness> {
  const harness = await createDeletionHarness();
  cleanups.push(harness.fixture.cleanup);
  return harness;
}

function cleanupFor(
  harness: DeletionHarness,
  beforeUnlink?: () => void,
): ManagedDeletionCleanup {
  return new ManagedDeletionCleanup({
    store: harness.fixture.store,
    assets: harness.fixture.assets,
    originals: harness.fixture.originals,
    managedExportsRoot: harness.managedExportsRoot,
    hooks: beforeUnlink ? { beforeUnlink } : undefined,
  });
}

function mediaEntry(input: {
  namespace: "asset" | "original";
  mediaId: string;
  checksum: string;
  managedKey: string;
}): ManagedUnlinkLedgerEntry {
  return {
    entryType: "managed_unlink",
    ...input,
    bytes: null,
    state: "pending",
    attempts: 0,
    failureCode: null,
  };
}

function exportEntry(input: {
  id: string;
  path: string;
  bytes: Buffer;
}): ManagedUnlinkLedgerEntry {
  return {
    entryType: "managed_unlink",
    namespace: "export",
    mediaId: input.id,
    checksum: hash(input.bytes),
    managedKey: basename(input.path),
    bytes: input.bytes.length,
    state: "pending",
    attempts: 0,
    failureCode: null,
  };
}

function deleteDocument(
  harness: DeletionHarness,
  collection: string,
  id: string,
): void {
  harness.fixture.store.database
    .prepare("DELETE FROM documents WHERE collection = ? AND id = ?")
    .run(collection, id);
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

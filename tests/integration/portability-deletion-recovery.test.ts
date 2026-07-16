import { access, readFile, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { PortabilityScopeLockRepository } from "../../src/domain/portability/repositories.js";
import type { DeletionInventorySnapshot } from "../../src/domain/portability/deletion-inventory.js";
import {
  createDeletionHarness,
  type DeletionHarness,
} from "../helpers/portability-deletion-fixture.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("deletion cleanup recovery", () => {
  it("keeps the exclusive lock on EACCES and finishes through the FR-160 retry action", async () => {
    const harness = await trackedHarness();
    let failed = false;
    const service = harness.makeService({
      cleanupHooks: {
        beforeUnlink(entry) {
          if (!failed && entry.namespace === "original") {
            failed = true;
            const error = new Error("synthetic denied") as Error & {
              code: string;
            };
            error.code = "EACCES";
            throw error;
          }
        },
      },
    });
    const inventory = service.createInventory({
      kind: "customer",
      id: harness.fixture.scope.customerId,
    });
    const first = await service.confirm(
      confirmation(inventory, "cleanup-eacces"),
    );

    expect(first.operation.state).toBe("cleanup_required");
    expect(first.operation.failureCode).toBe("DELETION_CLEANUP_EACCES");
    expect(
      new PortabilityScopeLockRepository(harness.fixture.store).list(),
    ).toHaveLength(1);

    const restarted = harness.makeService();
    const retried = await restarted.retryCleanup({
      operationId: first.operation.id,
      idempotencyKey: "cleanup-eacces-retry",
    });
    expect(retried.operation.state).toBe("verified");
    expect(retried.report?.failedChecks).toBe(0);
    expect(
      new PortabilityScopeLockRepository(harness.fixture.store).list(),
    ).toEqual([]);
    const replay = await restarted.retryCleanup({
      operationId: first.operation.id,
      idempotencyKey: "cleanup-eacces-retry",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.operation.state).toBe("verified");
  });

  it("recovers when files were unlinked before the outcome ledger committed", async () => {
    const harness = await trackedHarness();
    let crashed = false;
    const service = harness.makeService({
      serviceHooks: {
        afterFilesystemBatch() {
          if (!crashed) {
            crashed = true;
            throw new Error("SYNTHETIC_PROCESS_CRASH");
          }
        },
      },
    });
    const inventory = service.createInventory({
      kind: "customer",
      id: harness.fixture.scope.customerId,
    });
    await expect(
      service.confirm(confirmation(inventory, "cleanup-crash")),
    ).rejects.toThrowError("SYNTHETIC_PROCESS_CRASH");

    const restarted = harness.makeService();
    const recovered = await restarted.recover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].state).toBe("verified");
  });

  it("never deletes a checksum-mismatched managed file or an unknown neighbor", async () => {
    const harness = await trackedHarness();
    const original = harness.fixture.originals.get(
      harness.fixture.records.originalAssetId,
    )!;
    const originalPath = harness.fixture.originals.pathForRecord(original);
    const expected = await readFile(originalPath);
    const unknownPath = `${originalPath}.operator-note`;
    await writeFile(originalPath, Buffer.from("tampered"));
    await writeFile(unknownPath, Buffer.from("unknown-neighbor"));
    const service = harness.makeService();
    const inventory = service.createInventory({
      kind: "customer",
      id: harness.fixture.scope.customerId,
    });
    const result = await service.confirm(
      confirmation(inventory, "checksum-block"),
    );

    expect(result.operation.state).toBe("cleanup_required");
    expect(await readFile(originalPath, "utf8")).toBe("tampered");
    expect(await readFile(unknownPath, "utf8")).toBe("unknown-neighbor");

    await writeFile(originalPath, expected);
    const retried = await service.retryCleanup({
      operationId: result.operation.id,
      idempotencyKey: "checksum-block-retry",
    });
    expect(retried.operation.state).toBe("verified");
    await expect(access(originalPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(unknownPath, "utf8")).toBe("unknown-neighbor");
  });

  it("rolls back locks, cancels, refcounts, documents, and action on an ENOSPC commit failure", async () => {
    const harness = await trackedHarness();
    const projectBefore = rawDocument(
      harness,
      "projects",
      harness.fixture.scope.projectId,
    );
    const assetBefore = harness.fixture.assets.get(
      harness.fixture.records.repeatedAssetId,
    );
    const service = harness.makeService({
      serviceHooks: {
        beforeGraphCommit() {
          const error = new Error("synthetic full") as Error & { code: string };
          error.code = "ENOSPC";
          throw error;
        },
      },
    });
    const inventory = service.createInventory({
      kind: "project",
      id: harness.fixture.scope.projectId,
    });

    await expect(
      service.confirm(confirmation(inventory, "commit-enospc")),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    expect(
      rawDocument(harness, "projects", harness.fixture.scope.projectId),
    ).toEqual(projectBefore);
    expect(
      harness.fixture.assets.get(harness.fixture.records.repeatedAssetId),
    ).toEqual(assetBefore);
    expect(
      new PortabilityScopeLockRepository(harness.fixture.store).list(),
    ).toEqual([]);
  });
});

async function trackedHarness(): Promise<DeletionHarness> {
  const harness = await createDeletionHarness();
  cleanups.push(harness.fixture.cleanup);
  return harness;
}

function confirmation(
  snapshot: DeletionInventorySnapshot,
  idempotencyKey: string,
) {
  const { inventory } = snapshot;
  return {
    target: { kind: inventory.target.kind, id: inventory.target.id },
    inventoryId: inventory.id,
    inventoryHash: inventory.inventoryHash,
    targetRevisionHash: inventory.target.revisionHash,
    displayName: snapshot.displayName,
    finalConfirmation: true,
    customerCharacterDecision:
      inventory.target.kind === "customer"
        ? ("cascade" as const)
        : ("not_applicable" as const),
    idempotencyKey,
  };
}

function rawDocument(
  harness: DeletionHarness,
  collection: string,
  id: string,
): unknown {
  const row = harness.fixture.store.database
    .prepare("SELECT doc FROM documents WHERE collection = ? AND id = ?")
    .get(collection, id) as { doc: string } | undefined;
  return row ? JSON.parse(row.doc) : null;
}

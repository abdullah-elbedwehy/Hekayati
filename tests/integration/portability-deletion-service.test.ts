import { access } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { DocumentRepository } from "../../src/domain/repository/document-store.js";
import { PortabilityScopeLockRepository } from "../../src/domain/portability/repositories.js";
import type { DeletionInventorySnapshot } from "../../src/domain/portability/deletion-inventory.js";
import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import { JobRepository } from "../../src/jobs/repository.js";
import {
  PortabilityActionRepository,
  PortabilityLedgerRepository,
} from "../../src/domain/portability/repositories.js";
import {
  syntheticStudioFixtureSchema,
  type PortabilityFixture,
} from "../helpers/portability-fixture.js";
import {
  createDeletionHarness,
  seedManagedExport,
  type DeletionHarness,
} from "../helpers/portability-deletion-fixture.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("permanent deletion service", () => {
  it("requires exact typed confirmation and routes keep-pinned customer data without mutation", async () => {
    const harness = await trackedHarness();
    const service = harness.makeService();
    const inventory = service.createInventory({
      kind: "customer",
      id: harness.fixture.scope.customerId,
    });
    const exact = confirmation(inventory, "customer-confirmation-proof");

    await expect(
      service.confirm({ ...exact, finalConfirmation: false }),
    ).rejects.toThrowError("DELETION_FINAL_CONFIRMATION_REQUIRED");
    await expect(
      service.confirm({ ...exact, displayName: `${exact.displayName} خطأ` }),
    ).rejects.toThrowError("DELETION_CONFIRMATION_MISMATCH");
    await expect(
      service.confirm({ ...exact, targetRevisionHash: "0".repeat(64) }),
    ).rejects.toThrowError("DELETION_CONFIRMATION_MISMATCH");
    await expect(
      service.confirm({
        ...exact,
        customerCharacterDecision: "keep_pinned",
      }),
    ).rejects.toThrowError("DELETION_KEEP_PINNED_ROUTE_ARCHIVE_EXPORT");

    expect(
      collectionDocument(
        harness.fixture,
        "customers",
        harness.fixture.scope.customerId,
      ),
    ).not.toBeNull();
    expect(
      new PortabilityActionRepository(harness.fixture.store).list(),
    ).toEqual([]);
    expect(
      new PortabilityScopeLockRepository(harness.fixture.store).list(),
    ).toEqual([]);
  });

  it("deletes exactly one project while preserving its customer library, Studio, and unrelated graph", async () => {
    const harness = await trackedHarness();
    const { fixture } = harness;
    const service = harness.makeService();
    const unrelatedBefore = collectionDocument(
      fixture,
      "projects",
      fixture.unrelatedScope.projectId,
    );
    const inventory = service.createInventory({
      kind: "project",
      id: fixture.scope.projectId,
    });

    expect(inventory.inventory.counts).toMatchObject({
      documents: expect.any(Number),
      jobs: expect.any(Number),
      blockers: 0,
    });
    expect(inventory.inventory.counts.documents).toBeGreaterThan(40);

    const confirmed = await service.confirm(
      confirmation(inventory, "delete-project-once"),
    );

    expect(confirmed.replayed).toBe(false);
    expect(confirmed.operation.state).toBe("verified");
    expect(confirmed.report?.failedChecks).toBe(0);
    expect(
      collectionDocument(fixture, "projects", fixture.scope.projectId),
    ).toBeNull();
    expect(
      collectionDocument(fixture, "customers", fixture.scope.customerId),
    ).not.toBeNull();
    expect(
      collectionDocument(fixture, "families", fixture.scope.familyId),
    ).not.toBeNull();
    expect(
      collectionDocument(
        fixture,
        "synthetic_studio_entries",
        fixture.records.syntheticStudioOwnedId,
      ),
    ).not.toBeNull();
    expect(
      collectionDocument(fixture, "projects", fixture.unrelatedScope.projectId),
    ).toEqual(unrelatedBefore);
    expect(new PortabilityScopeLockRepository(fixture.store).list()).toEqual(
      [],
    );

    const replay = await service.confirm(
      confirmation(inventory, "delete-project-once"),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.operation.id).toBe(confirmed.operation.id);
    expect(new PortabilityActionRepository(fixture.store).list()).toHaveLength(
      1,
    );
  });

  it("deletes a complete customer graph, cancels jobs, unlinks owned media/export, and preserves shared bytes anonymously", async () => {
    const harness = await trackedHarness();
    const { fixture } = harness;
    const managed = await seedManagedExport(harness);
    const service = harness.makeService();
    const originalPath = fixture.originals.pathForRecord(
      fixture.originals.get(fixture.records.originalAssetId)!,
    );
    const jobs = new JobRepository(fixture.store);
    const completedJob = jobs
      .list()
      .find(
        (job) =>
          job.projectId === fixture.scope.projectId &&
          job.state === "succeeded",
      )!;
    jobs.update(completedJob, {
      ...completedJob,
      revision: completedJob.revision + 1,
      updatedAt: "2026-07-16T00:02:00.000Z",
      state: "queued",
      stateReason: null,
      resultRefs: [],
      provenance: null,
    });
    const sharedBefore = fixture.assets.get(
      fixture.records.retainedReuseAssetId,
    )!;
    const inventory = service.createInventory({
      kind: "customer",
      id: fixture.scope.customerId,
    });

    const result = await service.confirm(
      confirmation(inventory, "delete-customer-once"),
    );

    expect(result.operation.state).toBe("verified");
    expect(result.operation.counts.canceledJobs).toBeGreaterThan(0);
    expect(result.operation.counts.deletedDocuments).toBe(
      inventory.inventory.counts.documents + inventory.inventory.counts.jobs,
    );
    expect(
      collectionDocument(fixture, "customers", fixture.scope.customerId),
    ).toBeNull();
    expect(
      collectionDocument(
        fixture,
        "synthetic_studio_entries",
        fixture.records.syntheticStudioOwnedId,
      ),
    ).toBeNull();
    expect(
      collectionDocument(
        fixture,
        "synthetic_studio_entries",
        fixture.records.syntheticStudioPromptOnlyId,
      ),
    ).not.toBeNull();
    expect(
      collectionDocument(fixture, "projects", fixture.unrelatedScope.projectId),
    ).not.toBeNull();
    expect(fixture.originals.get(fixture.records.originalAssetId)).toBeNull();
    await expect(access(originalPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(managed.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      collectionDocument(fixture, "managed_exports", managed.id),
    ).toBeNull();
    expect(
      fixture.assets.get(fixture.records.retainedReuseAssetId),
    ).toMatchObject({
      sha256: sharedBefore.sha256,
      refCount: sharedBefore.refCount - 1,
    });
    expect(result.report?.counts.sharedPreserved).toBeGreaterThan(0);
    expect(
      new PortabilityLedgerRepository(fixture.store).root(
        result.operation.id,
        "deletion_verification",
      ).entryCount,
    ).toBeGreaterThan(0);
  });

  it("rejects a stale confirmation atomically and permits a fresh retry", async () => {
    const harness = await trackedHarness();
    const { fixture } = harness;
    const service = harness.makeService();
    const stale = service.createInventory({
      kind: "project",
      id: fixture.scope.projectId,
    });
    const projects = new AuthoringRepositories(fixture.store).projects;
    const project = projects.get(fixture.scope.projectId)!;
    projects.update({
      ...project,
      revision: project.revision + 1,
      updatedAt: "2026-07-16T00:01:00.000Z",
    });

    await expect(
      service.confirm(confirmation(stale, "stale-delete")),
    ).rejects.toThrowError("DELETION_INVENTORY_STALE");
    expect(
      collectionDocument(fixture, "projects", fixture.scope.projectId),
    ).not.toBeNull();
    expect(new PortabilityActionRepository(fixture.store).list()).toEqual([]);
    expect(new PortabilityScopeLockRepository(fixture.store).list()).toEqual(
      [],
    );

    const fresh = service.createInventory({
      kind: "project",
      id: fixture.scope.projectId,
    });
    const confirmed = await service.confirm(
      confirmation(fresh, "stale-delete"),
    );
    expect(confirmed.operation.state).toBe("verified");
  });

  it("blocks a refcount-underflow inventory before any deletion action", async () => {
    const harness = await trackedHarness();
    const service = harness.makeService();
    const baseline = service.createInventory({
      kind: "customer",
      id: harness.fixture.scope.customerId,
    });
    const media = baseline.inventoryEntries.find(
      (entry) => entry.entryType === "deletion_media" && entry.ownedRefs > 1,
    );
    expect(media?.entryType).toBe("deletion_media");
    if (!media || media.entryType !== "deletion_media")
      throw new Error("SYNTHETIC_MULTI_REF_MEDIA_MISSING");
    const collection =
      media.namespace === "asset" ? "assets" : "original_assets";
    const record = collectionDocument(
      harness.fixture,
      collection,
      media.mediaId,
    ) as { refCount: number };
    harness.fixture.store.database
      .prepare("UPDATE documents SET doc = ? WHERE collection = ? AND id = ?")
      .run(
        JSON.stringify({ ...record, refCount: media.ownedRefs - 1 }),
        collection,
        media.mediaId,
      );

    const blocked = service.createInventory({
      kind: "customer",
      id: harness.fixture.scope.customerId,
    });
    expect(blocked.inventory.counts.blockers).toBeGreaterThan(0);
    await expect(
      service.confirm(confirmation(blocked, "refcount-underflow")),
    ).rejects.toThrowError("DELETION_BLOCKERS_PRESENT");
    expect(
      collectionDocument(
        harness.fixture,
        "customers",
        harness.fixture.scope.customerId,
      ),
    ).not.toBeNull();
    expect(
      new PortabilityActionRepository(harness.fixture.store).list(),
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

function collectionDocument(
  fixture: PortabilityFixture,
  collection: string,
  id: string,
): unknown {
  if (collection === "synthetic_studio_entries")
    return new DocumentRepository(
      fixture.store,
      collection,
      syntheticStudioFixtureSchema,
    ).get(id);
  const row = fixture.store.database
    .prepare("SELECT doc FROM documents WHERE collection = ? AND id = ?")
    .get(collection, id) as { doc: string } | undefined;
  return row ? JSON.parse(row.doc) : null;
}

import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import {
  pauseProjectExportRequestHash,
  ProjectExportService,
} from "../../src/domain/portability/export-service.js";
import type { PortabilitySnapshotEntry } from "../../src/domain/portability/export-model.js";
import type { SelectedPortabilityMedia } from "../../src/domain/portability/graph.js";
import {
  ExportOperationRepository,
  PortabilitySnapshotRepository,
} from "../../src/domain/portability/export-storage.js";
import {
  createPortabilityRegistry,
  definePortabilityParticipant,
  extendPortabilityCatalog,
  REAL_PORTABILITY_CATALOG,
} from "../../src/domain/portability/participants.js";
import { realPortabilityParticipants } from "../../src/domain/portability/real-participants.js";
import { PortabilityScopeLockRepository } from "../../src/domain/portability/repositories.js";
import { ProjectSnapshotFreezer } from "../../src/domain/portability/snapshot-entries.js";
import { ManagedExportStore } from "../../src/portability/managed-export-store.js";
import { SnapshotStagingStore } from "../../src/portability/staging-store.js";
import type { JobScheduler } from "../../src/jobs/scheduler.js";
import type { JobFence, JobRecord } from "../../src/jobs/types.js";
import {
  createPortabilityFixture,
  syntheticStudioFixtureSchema,
  type PortabilityFixture,
} from "../helpers/portability-fixture.js";
import {
  fixtureScheduler,
  portabilityFixtureAt,
} from "../helpers/portability-fixture/support.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("project snapshot entries", () => {
  it("freezes only the registered project graph and holds each medium once", async () => {
    const harness = await snapshotHarness();
    insertIgnoredDocument(harness.fixture, "settings");
    insertIgnoredDocument(harness.fixture, "rogue_private_records");
    const assetRefsBefore = refCounts(harness.fixture.assets.list());
    const originalRefsBefore = refCounts(harness.fixture.originals.list());
    const paused = harness.pause();

    const first = harness.freezer.freeze({
      operationId: paused.current.operation.id,
      expectedProjectRevision: paused.current.operation.projectRevision,
    });

    expect(first.operation).toMatchObject({
      id: paused.current.operation.id,
      state: "staging",
      snapshotId: first.snapshot.id,
      snapshotHash: first.snapshot.snapshotHash,
    });
    expect(first.snapshot).toMatchObject({
      state: "frozen",
      participantRegistryHash: harness.registry.hash,
      projectRevision: paused.current.operation.projectRevision,
    });
    expect(first.lock).toMatchObject({
      operationId: paused.current.operation.id,
      phase: "snapshot",
      mode: "export_snapshot",
    });

    const entries = harness.snapshots.entries(first.snapshot.id);
    expect(entries.map((entry) => entry.archiveEntry)).toEqual(
      entries.map((entry) => entry.archiveEntry).sort(),
    );
    expect(
      entries.filter((entry) => entry.entryType === "document"),
    ).toHaveLength(first.graph.documents.length);
    expect(entries.filter((entry) => entry.entryType === "media")).toHaveLength(
      first.graph.media.length,
    );
    expect(
      entries.some((entry) => entry.archiveEntry.includes("settings")),
    ).toBe(false);
    expect(
      entries.some((entry) =>
        entry.archiveEntry.includes("rogue_private_records"),
      ),
    ).toBe(false);
    expect(
      entries.some(
        (entry) =>
          entry.entryType === "document" &&
          entry.documentId === harness.fixture.records.syntheticStudioOwnedId,
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.entryType === "document" &&
          entry.documentId ===
            harness.fixture.records.syntheticStudioPromptOnlyId,
      ),
    ).toBe(false);

    const originalEntry = entries.find(
      (entry) =>
        entry.entryType === "media" &&
        entry.namespace === "original" &&
        entry.mediaId === harness.fixture.records.originalAssetId,
    );
    expect(originalEntry).toMatchObject({
      role: "reference_photo",
      mime: "image/jpeg",
    });
    assertMediaLedgers(
      harness,
      entries,
      first.graph.media,
      assetRefsBefore,
      originalRefsBefore,
    );
    assertRefCounts(
      harness,
      first.graph.media,
      assetRefsBefore,
      originalRefsBefore,
    );

    const heldCounts = currentRefCounts(harness.fixture);
    const replay = harness.freezer.freeze({
      operationId: paused.current.operation.id,
      expectedProjectRevision: paused.current.operation.projectRevision,
    });
    expect(replay.operation).toEqual(first.operation);
    expect(replay.snapshot).toEqual(first.snapshot);
    expect(replay.lock).toEqual(first.lock);
    expect(replay.graph.media).toEqual(first.graph.media);
    expect(
      replay.graph.documents.map((entry) => `${entry.collection}:${entry.id}`),
    ).toEqual(
      first.graph.documents.map((entry) => `${entry.collection}:${entry.id}`),
    );
    expect(currentRefCounts(harness.fixture)).toEqual(heldCounts);
  });

  it("does not enter snapshot phase until every claimed attempt is quiescent", async () => {
    const harness = await snapshotHarness();
    const running = enqueueRunning(
      harness.scheduler,
      harness.fixture.scope.projectId,
    );
    const paused = harness.pause();
    const input = {
      operationId: paused.current.operation.id,
      expectedProjectRevision: paused.current.operation.projectRevision,
    };

    expect(() => harness.freezer.freeze(input)).toThrow(
      "PORTABILITY_EXPORT_NOT_QUIESCENT",
    );
    expect(harness.operations.get(paused.current.operation.id)).toMatchObject({
      state: "waiting_quiescence",
      snapshotId: null,
    });
    expect(harness.locks.get(paused.current.lock!.id)?.phase).toBe("draining");

    harness.scheduler.commitSuccess(running.id, fence(running), [], 12);
    expect(harness.freezer.freeze(input).snapshot.state).toBe("frozen");
  });

  it("rejects revision drift and a draining lock not exactly linked to the operation", async () => {
    const harness = await snapshotHarness();
    const paused = harness.pause();

    expect(() =>
      harness.freezer.freeze({
        operationId: paused.current.operation.id,
        expectedProjectRevision: paused.current.operation.projectRevision + 1,
      }),
    ).toThrow("PORTABILITY_EXPORT_PROJECT_REVISION_CONFLICT");
    expect(harness.locks.get(paused.current.lock!.id)?.phase).toBe("draining");

    harness.fixture.store.database
      .prepare(
        `UPDATE documents
         SET doc = json_set(doc, '$.scope.customerId', ?)
         WHERE collection = 'portability_scope_locks' AND id = ?`,
      )
      .run(harness.fixture.unrelatedScope.customerId, paused.current.lock!.id);

    expect(() =>
      harness.freezer.freeze({
        operationId: paused.current.operation.id,
        expectedProjectRevision: paused.current.operation.projectRevision,
      }),
    ).toThrow("PORTABILITY_EXPORT_LOCK_MISMATCH");
    expect(harness.operations.get(paused.current.operation.id)?.state).toBe(
      "waiting_quiescence",
    );
  });
});

async function snapshotHarness() {
  const fixture = await createPortabilityFixture();
  cleanups.push(fixture.cleanup);
  const registry = testRegistry();
  const scheduler = fixtureScheduler(fixture.store, ulid);
  const service = new ProjectExportService({
    store: fixture.store,
    registry,
    assets: fixture.assets,
    originals: fixture.originals,
    scheduler,
    stagingStore: new SnapshotStagingStore(join(fixture.paths.root, "staging")),
    managedStore: new ManagedExportStore(join(fixture.paths.root, "exports")),
    appVersion: "0.1.0-test",
    nowIso: () => portabilityFixtureAt,
    idFactory: ulid,
  });
  const freezer = new ProjectSnapshotFreezer({
    store: fixture.store,
    registry,
    assets: fixture.assets,
    originals: fixture.originals,
    nowIso: () => portabilityFixtureAt,
    idFactory: ulid,
  });
  const operations = new ExportOperationRepository(fixture.store);
  const locks = new PortabilityScopeLockRepository(fixture.store);
  const snapshots = new PortabilitySnapshotRepository(fixture.store, registry, {
    nowIso: () => portabilityFixtureAt,
    idFactory: ulid,
  });
  return {
    fixture,
    registry,
    scheduler,
    freezer,
    operations,
    locks,
    snapshots,
    pause: () => {
      const project = new AuthoringRepositories(fixture.store).projects.get(
        fixture.scope.projectId,
      );
      if (!project) throw new Error("bad fixture");
      const request = {
        projectId: project.id,
        expectedProjectRevision: project.revision,
        idempotencyKey: `pause-${project.id}`,
        acknowledgedChildPhotos: true,
        acknowledgedNoAutomaticBackup: true,
      };
      return service.pause({
        ...request,
        requestHash: pauseProjectExportRequestHash(request),
      });
    },
  };
}

function testRegistry() {
  const studio = definePortabilityParticipant({
    key: "synthetic_studio_entries",
    collection: "synthetic_studio_entries",
    currentSchemaVersion: 1,
    schema: syntheticStudioFixtureSchema,
    dependencies: ["assets", "customers", "families", "projects"],
    claims: { scopedWriters: ["synthetic_studio.repository"] },
    selectForProject: (document, root) =>
      document.owner.kind === "customer" &&
      document.owner.customerId === root.customerId
        ? "customer_studio"
        : null,
    selectForCustomer: (document, root) =>
      document.owner.kind === "customer" &&
      document.owner.customerId === root.customerId
        ? "customer_studio"
        : null,
    projectIds: (document) => (document.projectId ? [document.projectId] : []),
    customerIds: (document) =>
      document.owner.kind === "customer" ? [document.owner.customerId] : [],
    ownerReferences: (document) =>
      document.owner.kind === "customer"
        ? [
            {
              collection: "customers",
              id: document.owner.customerId,
              field: "owner.customerId",
            },
            {
              collection: "families",
              id: document.owner.familyId,
              field: "owner.familyId",
            },
          ]
        : [],
    references: (document) =>
      document.projectId
        ? [
            {
              collection: "projects",
              id: document.projectId,
              field: "projectId",
            },
          ]
        : [],
    assetReferences: (document) => [
      { id: document.assetId, field: "assetId", ownership: "owned" },
    ],
  });
  return createPortabilityRegistry(
    [...realPortabilityParticipants, studio],
    extendPortabilityCatalog(REAL_PORTABILITY_CATALOG, {
      collections: [{ key: studio.collection, owner: "participant" }],
      scopedWriters: [
        { key: "synthetic_studio.repository", owner: "participant" },
      ],
    }),
  );
}

function enqueueRunning(scheduler: JobScheduler, projectId: string): JobRecord {
  const queued = scheduler.enqueue({
    jobType: "story_plan",
    projectId,
    standaloneScopeId: null,
    dependsOn: [],
    priority: 5,
    intentId: "snapshot-active-attempt",
    target: null,
    request: { kind: "local", payloadHash: hash("active-attempt") },
    inputSnapshot: { project: projectId },
  });
  const claimed = scheduler.claimNext({
    workerId: "snapshot-worker",
    bootId: "snapshot-boot",
    nowMonoMs: 10,
    nowWallMs: Date.parse(portabilityFixtureAt),
    leaseTtlMs: 30_000,
    concurrencyPerProvider: 4,
  });
  if (!claimed || claimed.id !== queued.id)
    throw new Error("bad fixture claim");
  return scheduler.markRunning(claimed.id, fence(claimed), 11);
}

function fence(job: JobRecord): JobFence {
  if (!job.lease) throw new Error("missing lease");
  return {
    workerId: job.lease.workerId,
    bootId: job.lease.bootId,
    claimToken: job.lease.claimToken,
    attempt: job.attempts,
  };
}

function insertIgnoredDocument(
  fixture: PortabilityFixture,
  collection: string,
) {
  const id = ulid();
  fixture.store.database
    .prepare(
      `INSERT INTO documents(collection, id, doc, schema_version, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(
      collection,
      id,
      JSON.stringify({
        id,
        schemaVersion: 1,
        createdAt: portabilityFixtureAt,
        updatedAt: portabilityFixtureAt,
        malformedForParticipantScan: true,
      }),
      portabilityFixtureAt,
      portabilityFixtureAt,
    );
}

function refCounts(records: readonly { id: string; refCount: number }[]) {
  return new Map(records.map((record) => [record.id, record.refCount]));
}

function currentRefCounts(fixture: PortabilityFixture) {
  return {
    assets: [...refCounts(fixture.assets.list())],
    originals: [...refCounts(fixture.originals.list())],
  };
}

function assertRefCounts(
  harness: Awaited<ReturnType<typeof snapshotHarness>>,
  selected: readonly { namespace: "asset" | "original"; id: string }[],
  assetBefore: ReadonlyMap<string, number>,
  originalBefore: ReadonlyMap<string, number>,
) {
  const selectedKeys = new Set(
    selected.map((item) => `${item.namespace}:${item.id}`),
  );
  for (const record of harness.fixture.assets.list())
    expect(record.refCount).toBe(
      assetBefore.get(record.id)! +
        (selectedKeys.has(`asset:${record.id}`) ? 1 : 0),
    );
  for (const record of harness.fixture.originals.list())
    expect(record.refCount).toBe(
      originalBefore.get(record.id)! +
        (selectedKeys.has(`original:${record.id}`) ? 1 : 0),
    );
}

function assertMediaLedgers(
  harness: Awaited<ReturnType<typeof snapshotHarness>>,
  entries: readonly PortabilitySnapshotEntry[],
  selected: readonly SelectedPortabilityMedia[],
  assetBefore: ReadonlyMap<string, number>,
  originalBefore: ReadonlyMap<string, number>,
): void {
  const mediaEntries = entries.filter((entry) => entry.entryType === "media");
  const holds = harness.snapshots.holds(entries[0].snapshotId);
  for (const graphMedia of selected) {
    const entry = mediaEntries.find(
      (candidate) =>
        candidate.namespace === graphMedia.namespace &&
        candidate.mediaId === graphMedia.id,
    );
    if (!entry) throw new Error("missing media fixture entry");
    const preHoldRefCount =
      graphMedia.namespace === "asset"
        ? assetBefore.get(graphMedia.id)
        : originalBefore.get(graphMedia.id);
    const ledger = {
      occurrenceCount: graphMedia.occurrenceCount,
      ownedCount: graphMedia.ownedCount,
      referencedCount: graphMedia.referencedCount,
      outsideScopeOccurrenceCount: graphMedia.outsideScopeOccurrenceCount,
      preHoldRefCount,
      disposition:
        graphMedia.outsideScopeOccurrenceCount === 0
          ? "scope_only"
          : "shared_reference_preserved",
    } as const;
    expect(entry).toMatchObject(ledger);
    expect(
      holds.find(
        (hold) =>
          hold.namespace === graphMedia.namespace &&
          hold.mediaId === graphMedia.id,
      ),
    ).toMatchObject(ledger);
  }
  const repeated = mediaEntries.find(
    (entry) => entry.mediaId === harness.fixture.records.repeatedAssetId,
  );
  expect(repeated?.occurrenceCount).toBeGreaterThan(10);
  expect(repeated).toMatchObject({
    outsideScopeOccurrenceCount: 0,
    disposition: "scope_only",
  });
  const shared = mediaEntries.find(
    (entry) => entry.mediaId === harness.fixture.records.retainedReuseAssetId,
  );
  expect(shared).toMatchObject({
    outsideScopeOccurrenceCount: 1,
    preHoldRefCount: 2,
    disposition: "shared_reference_preserved",
  });
  expect(shared).not.toHaveProperty("foreignOwnerId");
  expect(JSON.stringify(shared)).not.toContain(
    harness.fixture.unrelatedScope.customerId,
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

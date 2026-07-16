import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { canonicalJson } from "../../src/contracts/canonical-json.js";
import {
  ImportReplaceBoundary,
  type ReplaceImportPlanEvidence,
  type ReplaceParticipantStorage,
} from "../../src/domain/portability/import-replace.js";
import { buildDeletionInventory } from "../../src/domain/portability/deletion-inventory.js";
import { ParticipantImportStorage } from "../../src/domain/portability/import-apply-storage.js";
import {
  PortabilityLedgerRepository,
  PortabilityScopeLockRepository,
} from "../../src/domain/portability/repositories.js";
import { JobRepository } from "../../src/jobs/repository.js";
import type { JobRecord } from "../../src/jobs/schemas.js";
import {
  createDeletionHarness,
  deletionTestRegistry,
  type DeletionHarness,
} from "../helpers/portability-deletion-fixture.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("replace import destructive boundary", () => {
  it("locks before preparation, cancels exact current jobs, and deletes only the target graph", async () => {
    const harness = await trackedHarness();
    const registry = deletionTestRegistry();
    const boundary = makeBoundary(harness, registry);
    const jobs = new JobRepository(harness.fixture.store);
    const queued = makeTargetJobQueued(jobs, harness.fixture.scope.projectId);
    const operationId = ulid();
    const plan = replacePlan(harness, registry.hash);
    const prepared = harness.fixture.store.transactionImmediate(() =>
      boundary.prepareLockInTransaction({ operationId, plan }),
    );

    expect(prepared.lock).toMatchObject({
      operationId,
      mode: "replace_import",
      phase: "draining",
      scope: {
        kind: "project",
        id: harness.fixture.scope.projectId,
        customerId: harness.fixture.scope.customerId,
      },
    });
    expect(
      new PortabilityLedgerRepository(harness.fixture.store).root(
        operationId,
        "captured_attempts",
      ).entryCount,
    ).toBeGreaterThan(0);

    const current = jobs.get(queued.id)!;
    jobs.update(current, {
      ...current,
      revision: current.revision + 1,
      updatedAt: "2026-07-16T00:03:00.000Z",
      state: "paused",
      stateReason: "operator",
      resumeState: "queued",
      resumeReason: null,
    });
    const unrelatedBefore = rawDocument(
      harness,
      "projects",
      harness.fixture.unrelatedScope.projectId,
    );
    const observedJobs: JobRecord[] = [];
    const storage = trackingStorage(harness, registry, (job) =>
      observedJobs.push(job),
    );

    const finalized = harness.fixture.store.transactionImmediate(() =>
      boundary.finalizeInTransaction({
        operationId,
        plan,
        lock: {
          id: prepared.lock.id,
          mode: prepared.lock.mode,
          phase: prepared.lock.phase,
          revision: prepared.lock.revision,
          scope: prepared.lock.scope,
        },
        targetSnapshotHash: prepared.targetSnapshotHash,
        storage,
      }),
    );

    expect(finalized.lockExclusive.phase).toBe("exclusive");
    expect(finalized.canceledJobIds).toContain(queued.id);
    expect(observedJobs.find((job) => job.id === queued.id)).toMatchObject({
      state: "canceled",
      stateReason: "replace_import",
      lease: null,
      retrySchedule: null,
    });
    expect(
      rawDocument(harness, "projects", harness.fixture.scope.projectId),
    ).toBeNull();
    expect(
      rawDocument(harness, "customers", harness.fixture.scope.customerId),
    ).not.toBeNull();
    expect(
      rawDocument(harness, "families", harness.fixture.scope.familyId),
    ).not.toBeNull();
    expect(
      rawDocument(
        harness,
        "projects",
        harness.fixture.unrelatedScope.projectId,
      ),
    ).toEqual(unrelatedBefore);
    expect(finalized.deletedDocumentCount).toBeGreaterThan(40);
    expect(
      new PortabilityScopeLockRepository(harness.fixture.store).get(
        prepared.lock.id,
      )?.phase,
    ).toBe("exclusive");
  });

  it("rejects non-job target drift before cancellation or release", async () => {
    const harness = await trackedHarness();
    const registry = deletionTestRegistry();
    const boundary = makeBoundary(harness, registry);
    const jobs = new JobRepository(harness.fixture.store);
    const queued = makeTargetJobQueued(jobs, harness.fixture.scope.projectId);
    const operationId = ulid();
    const plan = replacePlan(harness, registry.hash);
    const prepared = harness.fixture.store.transactionImmediate(() =>
      boundary.prepareLockInTransaction({ operationId, plan }),
    );
    const version = firstTargetProjectVersion(harness);
    overwriteDocument(harness, "project_versions", version.id, {
      ...version,
      updatedAt: "2026-07-16T00:04:00.000Z",
    });
    const assetBefore = harness.fixture.assets.list();

    expect(() =>
      harness.fixture.store.transactionImmediate(() =>
        boundary.finalizeInTransaction({
          operationId,
          plan,
          lock: prepared.lock,
          targetSnapshotHash: prepared.targetSnapshotHash,
          storage: trackingStorage(harness, registry),
        }),
      ),
    ).toThrowError("IMPORT_REPLACE_TARGET_STALE");

    expect(jobs.get(queued.id)?.state).toBe("queued");
    expect(harness.fixture.assets.list()).toEqual(assetBefore);
    expect(
      rawDocument(harness, "projects", harness.fixture.scope.projectId),
    ).not.toBeNull();
    expect(
      new PortabilityScopeLockRepository(harness.fixture.store).get(
        prepared.lock.id,
      )?.phase,
    ).toBe("draining");
  });

  it("commits an exact retained delta before releasing old-only reused media", async () => {
    const harness = await trackedHarness();
    const registry = deletionTestRegistry();
    const boundary = makeBoundary(harness, registry);
    const snapshot = buildDeletionInventory({
      store: harness.fixture.store,
      registry,
      target: { kind: "project", id: harness.fixture.scope.projectId },
      nowIso: "2026-07-16T00:02:00.000Z",
    });
    const reused = snapshot.inventoryEntries.find(
      (entry) =>
        entry.entryType === "deletion_media" &&
        entry.ownedRefs > 0 &&
        entry.expectedRemainingRefs === 0,
    );
    if (!reused || reused.entryType !== "deletion_media")
      throw new Error("SYNTHETIC_OLD_ONLY_MEDIA_MISSING");
    const before =
      reused.namespace === "asset"
        ? harness.fixture.assets.get(reused.mediaId)
        : harness.fixture.originals.get(reused.mediaId);
    if (!before) throw new Error("SYNTHETIC_REUSED_MEDIA_MISSING");
    const delta = {
      entryType: "reference_delta" as const,
      namespace: reused.namespace,
      mediaId: reused.mediaId,
      role:
        reused.namespace === "asset" && "role" in before
          ? before.role
          : "original",
      bytes: before.bytes,
      sha256: before.sha256,
      delta: 1,
      disposition: "retained" as const,
    };
    const operationId = ulid();
    const plan = replacePlan(harness, registry.hash);
    const prepared = harness.fixture.store.transactionImmediate(() =>
      boundary.prepareLockInTransaction({ operationId, plan }),
    );

    expect(() =>
      harness.fixture.store.transactionImmediate(() =>
        boundary.finalizeInTransaction({
          operationId,
          plan,
          lock: prepared.lock,
          targetSnapshotHash: prepared.targetSnapshotHash,
          storage: trackingStorage(harness, registry),
          retainedMediaDeltas: [{ ...delta, delta: 2 }],
          commitImportedMediaInTransaction: () =>
            retainMedia(harness, reused.namespace, reused.mediaId),
        }),
      ),
    ).toThrowError("IMPORT_REPLACE_MEDIA_COMMIT_MISMATCH");
    expect(
      reused.namespace === "asset"
        ? harness.fixture.assets.get(reused.mediaId)
        : harness.fixture.originals.get(reused.mediaId),
    ).toEqual(before);
    expect(
      new PortabilityScopeLockRepository(harness.fixture.store).get(
        prepared.lock.id,
      )?.phase,
    ).toBe("draining");

    const finalized = harness.fixture.store.transactionImmediate(() =>
      boundary.finalizeInTransaction({
        operationId,
        plan,
        lock: prepared.lock,
        targetSnapshotHash: prepared.targetSnapshotHash,
        storage: trackingStorage(harness, registry),
        retainedMediaDeltas: [delta],
        commitImportedMediaInTransaction: () =>
          retainMedia(harness, reused.namespace, reused.mediaId),
      }),
    );
    const retained =
      reused.namespace === "asset"
        ? harness.fixture.assets.get(reused.mediaId)
        : harness.fixture.originals.get(reused.mediaId);

    expect(retained).toMatchObject({
      id: reused.mediaId,
      sha256: reused.checksum,
      refCount: reused.expectedRemainingRefs + delta.delta,
    });
    expect(
      finalized.unlinks.some(
        (entry) =>
          entry.namespace === reused.namespace &&
          entry.mediaId === reused.mediaId,
      ),
    ).toBe(false);
    expect(
      finalized.sharedMedia.find(
        (entry) =>
          entry.namespace === reused.namespace &&
          entry.mediaId === reused.mediaId,
      ),
    ).toMatchObject({
      expectedRemainingRefs: reused.expectedRemainingRefs + delta.delta,
      disposition: "shared_reference_preserved",
    });
  });

  it("rolls cancellation, refcounts, deletes, and lock transition back with the caller transaction", async () => {
    const harness = await trackedHarness();
    const registry = deletionTestRegistry();
    const boundary = makeBoundary(harness, registry);
    const jobs = new JobRepository(harness.fixture.store);
    const queued = makeTargetJobQueued(jobs, harness.fixture.scope.projectId);
    const operationId = ulid();
    const plan = replacePlan(harness, registry.hash);
    const prepared = harness.fixture.store.transactionImmediate(() =>
      boundary.prepareLockInTransaction({ operationId, plan }),
    );
    const before = allDocuments(harness);

    expect(() =>
      harness.fixture.store.transactionImmediate(() => {
        boundary.finalizeInTransaction({
          operationId,
          plan,
          lock: prepared.lock,
          targetSnapshotHash: prepared.targetSnapshotHash,
          storage: trackingStorage(harness, registry),
        });
        throw new Error("INJECTED_AFTER_REPLACE_DELETE");
      }),
    ).toThrowError("INJECTED_AFTER_REPLACE_DELETE");

    expect(allDocuments(harness)).toEqual(before);
    expect(jobs.get(queued.id)?.state).toBe("queued");
    expect(
      new PortabilityScopeLockRepository(harness.fixture.store).get(
        prepared.lock.id,
      ),
    ).toEqual(prepared.lock);
  });
});

async function trackedHarness(): Promise<DeletionHarness> {
  const harness = await createDeletionHarness();
  cleanups.push(harness.fixture.cleanup);
  return harness;
}

function makeBoundary(
  harness: DeletionHarness,
  registry: ReturnType<typeof deletionTestRegistry>,
): ImportReplaceBoundary {
  return new ImportReplaceBoundary({
    store: harness.fixture.store,
    registry,
    assets: harness.fixture.assets,
    originals: harness.fixture.originals,
    nowIso: () => "2026-07-16T00:02:00.000Z",
  });
}

function replacePlan(
  harness: DeletionHarness,
  participantRegistryHash: string,
): ReplaceImportPlanEvidence {
  const project = rawDocument(
    harness,
    "projects",
    harness.fixture.scope.projectId,
  ) as { revision: number; customerId: string };
  return {
    mode: "replace_existing",
    source: { participantRegistryHash },
    target: {
      kind: "replace_project",
      customerId: harness.fixture.scope.customerId,
      familyId: harness.fixture.scope.familyId,
      projectId: harness.fixture.scope.projectId,
      customerRevisionHash: null,
      familyRevisionHash: null,
      projectRevision: project.revision,
      projectRevisionHash: hash(project),
      templateCatalogRevisionHash: null,
    },
  };
}

function trackingStorage(
  harness: DeletionHarness,
  registry: ReturnType<typeof deletionTestRegistry>,
  observeJob: (job: JobRecord) => void = () => undefined,
): ReplaceParticipantStorage {
  const storage = new ParticipantImportStorage(harness.fixture.store, registry);
  return {
    deleteInTransaction(input) {
      if (input.collection === "jobs") observeJob(input.document as JobRecord);
      storage.deleteInTransaction(input);
    },
  };
}

function makeTargetJobQueued(
  jobs: JobRepository,
  projectId: string,
): JobRecord {
  const completed = jobs
    .list()
    .find(
      (job) =>
        job.projectId === projectId &&
        job.state === "succeeded" &&
        job.request.kind !== "human_gate",
    );
  if (!completed) throw new Error("SYNTHETIC_REPLACE_JOB_MISSING");
  return jobs.update(completed, {
    ...completed,
    revision: completed.revision + 1,
    updatedAt: "2026-07-16T00:01:00.000Z",
    state: "queued",
    stateReason: null,
    lease: null,
    retrySchedule: null,
    resumeState: null,
    resumeReason: null,
    progress: null,
    resultRefs: [],
    provenance: null,
  });
}

function firstTargetProjectVersion(harness: DeletionHarness): {
  id: string;
  updatedAt: string;
  [key: string]: unknown;
} {
  const row = harness.fixture.store.database
    .prepare(
      `SELECT doc FROM documents
       WHERE collection = 'project_versions'
         AND json_extract(doc, '$.projectId') = ?
       ORDER BY id LIMIT 1`,
    )
    .get(harness.fixture.scope.projectId) as { doc: string } | undefined;
  if (!row) throw new Error("SYNTHETIC_PROJECT_VERSION_MISSING");
  return JSON.parse(row.doc) as {
    id: string;
    updatedAt: string;
    [key: string]: unknown;
  };
}

function overwriteDocument(
  harness: DeletionHarness,
  collection: string,
  id: string,
  document: Record<string, unknown>,
): void {
  harness.fixture.store.database
    .prepare(
      "UPDATE documents SET doc = ?, updated_at = ? WHERE collection = ? AND id = ?",
    )
    .run(JSON.stringify(document), document.updatedAt, collection, id);
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

function allDocuments(harness: DeletionHarness): unknown[] {
  return harness.fixture.store.database
    .prepare(
      "SELECT collection, id, doc FROM documents ORDER BY collection, id",
    )
    .all();
}

function retainMedia(
  harness: DeletionHarness,
  namespace: "asset" | "original",
  id: string,
): void {
  if (namespace === "asset") harness.fixture.assets.retainInTransaction(id);
  else harness.fixture.originals.retainInTransaction(id);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

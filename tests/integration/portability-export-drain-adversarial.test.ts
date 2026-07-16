import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import {
  pauseProjectExportRequestHash,
  ProjectExportService,
  startProjectExportRequestHash,
  type StartProjectExportInput,
} from "../../src/domain/portability/export-service.js";
import { PortabilitySnapshotRepository } from "../../src/domain/portability/export-storage.js";
import {
  createPortabilityRegistry,
  type PortabilityRegistry,
} from "../../src/domain/portability/participants.js";
import { realPortabilityParticipants } from "../../src/domain/portability/real-participants.js";
import {
  PortabilityActionRepository,
  PortabilityLedgerRepository,
} from "../../src/domain/portability/repositories.js";
import type { DocumentStore } from "../../src/domain/repository/document-store.js";
import type { JobScheduler } from "../../src/jobs/scheduler.js";
import type { JobFence, JobRecord } from "../../src/jobs/types.js";
import { ManagedExportStore } from "../../src/portability/managed-export-store.js";
import { SnapshotStagingStore } from "../../src/portability/staging-store.js";
import {
  createPortabilityFixture,
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

describe("project export drain boundary adversarial cases", () => {
  it("drains the exact captured attempt while pausing only queued work in scope", async () => {
    const harness = await exportHarness();
    const running = enqueueRunning(
      harness.scheduler,
      harness.fixture.scope.projectId,
      "captured-running",
    );
    const queued = enqueueJob(harness.scheduler, {
      projectId: harness.fixture.scope.projectId,
      intentId: "paused-queued",
    });
    const blocked = enqueueJob(harness.scheduler, {
      projectId: harness.fixture.scope.projectId,
      intentId: "paused-blocked",
      dependsOn: [queued.id],
    });
    const unrelated = enqueueJob(harness.scheduler, {
      projectId: harness.fixture.unrelatedScope.projectId,
      intentId: "unrelated-runnable",
    });

    const paused = pause(harness);
    const attempts = new PortabilityLedgerRepository(harness.fixture.store);
    expect(
      attempts.hasCapturedAttempt(
        paused.current.operation.id,
        running.id,
        running.attempts,
      ),
    ).toBe(true);
    expect(
      attempts.hasCapturedAttempt(
        paused.current.operation.id,
        running.id,
        running.attempts + 1,
      ),
    ).toBe(false);
    expect(harness.scheduler.get(queued.id)).toMatchObject({
      state: "paused",
      resumeState: "queued",
    });
    expect(harness.scheduler.get(blocked.id)).toMatchObject({
      state: "paused",
      resumeState: "blocked",
    });

    const unrelatedClaim = claimNext(harness.scheduler, "unrelated-worker", 20);
    expect(unrelatedClaim?.id).toBe(unrelated.id);
    const unrelatedRunning = harness.scheduler.markRunning(
      unrelatedClaim!.id,
      fence(unrelatedClaim!),
      21,
    );
    harness.scheduler.commitSuccess(
      unrelatedRunning.id,
      fence(unrelatedRunning),
      [],
      22,
    );

    const startInput = startInputFor(paused.current.operation);
    expect(() => harness.service.start(startInput)).toThrow(
      "PORTABILITY_EXPORT_NOT_QUIESCENT",
    );
    expect(
      new PortabilityActionRepository(harness.fixture.store).find(
        { kind: "project", id: harness.fixture.scope.projectId },
        "export_start",
        startInput.idempotencyKey,
      ),
    ).toBeNull();

    harness.scheduler.commitSuccess(running.id, fence(running), [], 23);
    const started = harness.service.start(startInput);
    expect(started).toMatchObject({
      replayed: false,
      current: {
        operation: { state: "staging" },
        snapshot: { state: "frozen" },
      },
    });
  });

  it("rejects stale revisions without mutation, then exactly replays start after restart", async () => {
    const harness = await exportHarness();
    const paused = pause(harness);
    const baseInput = startInputFor(paused.current.operation);
    const beforeStaleAttempts = persistedDocuments(harness.fixture.store);

    const staleProjectRequest = {
      ...withoutRequestHash(baseInput),
      expectedProjectRevision: baseInput.expectedProjectRevision - 1,
      idempotencyKey: "stale-project-start",
    };
    expect(() =>
      harness.service.start(withStartHash(staleProjectRequest)),
    ).toThrow("PORTABILITY_EXPORT_START_CONFLICT");
    expect(persistedDocuments(harness.fixture.store)).toEqual(
      beforeStaleAttempts,
    );

    const staleOperationRequest = {
      ...withoutRequestHash(baseInput),
      expectedOperationRevision: baseInput.expectedOperationRevision + 1,
      idempotencyKey: "stale-operation-start",
    };
    expect(() =>
      harness.service.start(withStartHash(staleOperationRequest)),
    ).toThrow("PORTABILITY_EXPORT_START_CONFLICT");
    expect(persistedDocuments(harness.fixture.store)).toEqual(
      beforeStaleAttempts,
    );

    const started = harness.service.start(baseInput);
    const snapshots = new PortabilitySnapshotRepository(
      harness.fixture.store,
      harness.registry,
    );
    const snapshotCount = collectionCount(
      harness.fixture.store,
      "portability_snapshots",
    );
    const entryCount = snapshots.entries(started.current.snapshot.id).length;
    const holdCount = snapshots.holds(started.current.snapshot.id).length;
    const afterStart = persistedDocuments(harness.fixture.store);

    const restarted = createService(
      harness.fixture,
      harness.registry,
      fixtureScheduler(harness.fixture.store, ulid),
    );
    const replay = restarted.start(baseInput);
    expect(replay).toEqual({ ...started, replayed: true });
    expect(
      collectionCount(harness.fixture.store, "portability_snapshots"),
    ).toBe(snapshotCount);
    expect(snapshots.entries(started.current.snapshot.id)).toHaveLength(
      entryCount,
    );
    expect(snapshots.holds(started.current.snapshot.id)).toHaveLength(
      holdCount,
    );
    expect(persistedDocuments(harness.fixture.store)).toEqual(afterStart);

    const collisionRequest = {
      ...withoutRequestHash(baseInput),
      expectedProjectRevision: 0,
      expectedOperationRevision: 999,
    };
    expect(() => restarted.start(withStartHash(collisionRequest))).toThrow(
      "PORTABILITY_ACTION_IDEMPOTENCY_COLLISION",
    );
    expect(persistedDocuments(harness.fixture.store)).toEqual(afterStart);
  });
});

interface ExportHarness {
  fixture: PortabilityFixture;
  registry: PortabilityRegistry;
  scheduler: JobScheduler;
  service: ProjectExportService;
}

async function exportHarness(): Promise<ExportHarness> {
  const fixture = await createPortabilityFixture();
  cleanups.push(fixture.cleanup);
  const registry = createPortabilityRegistry(realPortabilityParticipants);
  const scheduler = fixtureScheduler(fixture.store, ulid);
  return {
    fixture,
    registry,
    scheduler,
    service: createService(fixture, registry, scheduler),
  };
}

function createService(
  fixture: PortabilityFixture,
  registry: PortabilityRegistry,
  scheduler: JobScheduler,
): ProjectExportService {
  return new ProjectExportService({
    store: fixture.store,
    registry,
    assets: fixture.assets,
    originals: fixture.originals,
    scheduler,
    stagingStore: new SnapshotStagingStore(
      join(fixture.paths.root, "adversarial-export-staging"),
    ),
    managedStore: new ManagedExportStore(
      join(fixture.paths.root, "adversarial-exports"),
    ),
    appVersion: "0.1.0-test",
    nowIso: () => portabilityFixtureAt,
    idFactory: ulid,
  });
}

function pause(harness: ExportHarness) {
  const project = new AuthoringRepositories(harness.fixture.store).projects.get(
    harness.fixture.scope.projectId,
  );
  if (!project) throw new Error("bad fixture");
  const request = {
    projectId: project.id,
    expectedProjectRevision: project.revision,
    idempotencyKey: `adversarial-pause-${project.id}`,
    acknowledgedChildPhotos: true,
    acknowledgedNoAutomaticBackup: true,
  };
  return harness.service.pause({
    ...request,
    requestHash: pauseProjectExportRequestHash(request),
  });
}

function startInputFor(
  operation: ReturnType<ProjectExportService["pause"]>["current"]["operation"],
): StartProjectExportInput {
  const request = {
    projectId: operation.projectId,
    operationId: operation.id,
    expectedProjectRevision: operation.projectRevision,
    expectedOperationRevision: operation.revision,
    idempotencyKey: `adversarial-start-${operation.id}`,
  };
  return withStartHash(request);
}

function withStartHash(
  input: Omit<StartProjectExportInput, "requestHash">,
): StartProjectExportInput {
  return { ...input, requestHash: startProjectExportRequestHash(input) };
}

function withoutRequestHash(
  input: StartProjectExportInput,
): Omit<StartProjectExportInput, "requestHash"> {
  return {
    projectId: input.projectId,
    operationId: input.operationId,
    expectedProjectRevision: input.expectedProjectRevision,
    expectedOperationRevision: input.expectedOperationRevision,
    idempotencyKey: input.idempotencyKey,
  };
}

function enqueueRunning(
  scheduler: JobScheduler,
  projectId: string,
  intentId: string,
): JobRecord {
  const queued = enqueueJob(scheduler, { projectId, intentId });
  const claimed = claimNext(scheduler, "captured-worker", 10);
  if (!claimed || claimed.id !== queued.id) throw new Error("bad job fixture");
  return scheduler.markRunning(claimed.id, fence(claimed), 11);
}

function enqueueJob(
  scheduler: JobScheduler,
  input: { projectId: string; intentId: string; dependsOn?: string[] },
): JobRecord {
  return scheduler.enqueue({
    jobType: "story_plan",
    projectId: input.projectId,
    standaloneScopeId: null,
    dependsOn: input.dependsOn ?? [],
    priority: 5,
    intentId: input.intentId,
    target: null,
    request: { kind: "local", payloadHash: hash(input.intentId) },
    inputSnapshot: { project: input.projectId },
  });
}

function claimNext(
  scheduler: JobScheduler,
  workerId: string,
  nowMonoMs: number,
): JobRecord | null {
  return scheduler.claimNext({
    workerId,
    bootId: `${workerId}-boot`,
    nowMonoMs,
    nowWallMs: Date.parse(portabilityFixtureAt),
    leaseTtlMs: 30_000,
    concurrencyPerProvider: 4,
  });
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

function persistedDocuments(store: DocumentStore) {
  return store.database
    .prepare(
      "SELECT collection, id, doc FROM documents ORDER BY collection, id",
    )
    .all() as Array<{ collection: string; id: string; doc: string }>;
}

function collectionCount(store: DocumentStore, collection: string): number {
  const row = store.database
    .prepare("SELECT COUNT(*) AS count FROM documents WHERE collection = ?")
    .get(collection) as { count: number };
  return row.count;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

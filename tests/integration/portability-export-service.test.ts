import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import {
  pauseProjectExportRequestHash,
  ProjectExportService,
  startProjectExportRequestHash,
} from "../../src/domain/portability/export-service.js";
import {
  createPortabilityRegistry,
  definePortabilityParticipant,
  extendPortabilityCatalog,
  REAL_PORTABILITY_CATALOG,
} from "../../src/domain/portability/participants.js";
import { realPortabilityParticipants } from "../../src/domain/portability/real-participants.js";
import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import { ManagedExportStore } from "../../src/portability/managed-export-store.js";
import { SnapshotStagingStore } from "../../src/portability/staging-store.js";
import {
  createPortabilityFixture,
  syntheticStudioFixtureSchema,
  type PortabilityFixture,
} from "../helpers/portability-fixture.js";
import { fixtureScheduler } from "../helpers/portability-fixture/support.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("project export service", () => {
  it("atomically pauses, captures, locks, and exactly replays export pause", async () => {
    const fixture = await trackedFixture();
    const service = exportService(fixture);
    const projects = new AuthoringRepositories(fixture.store).projects;
    const before = projects.get(fixture.scope.projectId);
    const unrelatedBefore = projects.get(fixture.unrelatedScope.projectId);
    if (!before || !unrelatedBefore) throw new Error("bad fixture");
    const pauseRequest = {
      projectId: before.id,
      expectedProjectRevision: before.revision,
      idempotencyKey: "pause-export-1",
      acknowledgedChildPhotos: true,
      acknowledgedNoAutomaticBackup: true,
    };
    const input = {
      ...pauseRequest,
      requestHash: pauseProjectExportRequestHash(pauseRequest),
    };

    const first = service.pause(input);
    expect(first.replayed).toBe(false);
    expect(first.current.operation).toMatchObject({
      projectId: before.id,
      state: "waiting_quiescence",
      projectRevision: before.revision + 1,
    });
    expect(projects.get(before.id)).toMatchObject({
      paused: true,
      revision: before.revision + 1,
    });
    expect(first.current.lock).toMatchObject({
      operationId: first.current.operation.id,
      phase: "draining",
      mode: "export_snapshot",
      scope: { kind: "project", projectId: before.id },
    });
    expect(first.action.action).toBe("export_pause");

    const replay = service.pause(input);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(projects.get(before.id)?.revision).toBe(before.revision + 1);
    expect(projects.get(unrelatedBefore.id)).toEqual(unrelatedBefore);

    const collisionRequest = {
      ...pauseRequest,
      expectedProjectRevision: before.revision + 1,
    };
    expect(() =>
      service.pause({
        ...collisionRequest,
        requestHash: pauseProjectExportRequestHash(collisionRequest),
      }),
    ).toThrow("PORTABILITY_ACTION_IDEMPOTENCY_COLLISION");
    expect(projects.get(before.id)?.revision).toBe(before.revision + 1);
  });

  it("requires both explicit child-photo and no-backup acknowledgements", async () => {
    const fixture = await trackedFixture();
    const service = exportService(fixture);
    const project = new AuthoringRepositories(fixture.store).projects.get(
      fixture.scope.projectId,
    );
    if (!project) throw new Error("bad fixture");
    const warningRequest = {
      projectId: project.id,
      expectedProjectRevision: project.revision,
      idempotencyKey: "pause-warning",
      acknowledgedChildPhotos: true,
      acknowledgedNoAutomaticBackup: false,
    };
    const common = {
      ...warningRequest,
      requestHash: pauseProjectExportRequestHash(warningRequest),
    };

    expect(() => service.pause(common)).toThrow(
      "PORTABILITY_EXPORT_WARNING_ACK_REQUIRED",
    );
    expect(
      new AuthoringRepositories(fixture.store).projects.get(project.id),
    ).toEqual(project);
  });

  it("freezes, stages, scans, publishes, and safely replays the full graph", async () => {
    const fixture = await trackedFixture();
    const service = exportService(fixture);
    const project = new AuthoringRepositories(fixture.store).projects.get(
      fixture.scope.projectId,
    );
    if (!project) throw new Error("bad fixture");
    const retainedBefore = fixture.assets.get(
      fixture.records.retainedReuseAssetId,
    )?.refCount;
    if (retainedBefore === undefined) throw new Error("bad media fixture");
    const pauseRequest = {
      projectId: project.id,
      expectedProjectRevision: project.revision,
      idempotencyKey: "pause-full-export",
      acknowledgedChildPhotos: true,
      acknowledgedNoAutomaticBackup: true,
    };
    const pauseInput = {
      ...pauseRequest,
      requestHash: pauseProjectExportRequestHash(pauseRequest),
    };
    const paused = service.pause(pauseInput);
    const startRequest = {
      projectId: project.id,
      operationId: paused.current.operation.id,
      expectedProjectRevision: paused.current.operation.projectRevision,
      expectedOperationRevision: paused.current.operation.revision,
      idempotencyKey: "start-full-export",
    };
    const startInput = {
      ...startRequest,
      requestHash: startProjectExportRequestHash(startRequest),
    };

    const started = service.start(startInput);
    expect(started).toMatchObject({
      replayed: false,
      result: { state: "staging" },
      current: {
        operation: { state: "staging" },
        snapshot: { state: "frozen" },
      },
    });
    expect(started.current.snapshot.documentCount).toBeGreaterThan(40);
    expect(started.current.snapshot.mediaCount).toBeGreaterThan(5);
    expect(
      fixture.assets.get(fixture.records.retainedReuseAssetId)?.refCount,
    ).toBe(retainedBefore + 1);
    await expect(
      service.openDownload({
        exportId: started.current.operation.id,
        projectId: project.id,
        customerId: project.customerId,
        familyId: project.familyId,
      }),
    ).rejects.toThrow("PORTABILITY_MANAGED_EXPORT_NOT_FOUND");

    const ready = await service.execute(started.current.operation.id);
    expect(ready.operation).toMatchObject({
      state: "ready",
      archiveKey: ready.managedExport.archiveKey,
      archiveChecksum: ready.managedExport.archiveChecksum,
    });
    expect(ready.manifest.documents.map((entry) => entry.id)).toContain(
      fixture.records.syntheticStudioOwnedId,
    );
    expect(ready.manifest.documents.map((entry) => entry.id)).not.toContain(
      fixture.records.syntheticStudioPromptOnlyId,
    );
    expect(ready.manifest.documents.map((entry) => entry.id)).not.toContain(
      fixture.unrelatedScope.projectId,
    );
    expect(
      ready.manifest.media.some((entry) => entry.namespace === "original"),
    ).toBe(true);
    expect(
      fixture.assets.get(fixture.records.retainedReuseAssetId)?.refCount,
    ).toBe(retainedBefore);
    expect(
      new AuthoringRepositories(fixture.store).projects.get(project.id)?.paused,
    ).toBe(true);
    expect(activeLockCount(fixture)).toBe(0);
    expect(
      (
        await stat(
          join(fixture.paths.root, "exports", ready.managedExport.archiveKey),
        )
      ).mode & 0o777,
    ).toBe(0o600);

    await expect(service.execute(ready.operation.id)).resolves.toEqual(ready);
    const restarted = exportService(fixture);
    const startReplay = restarted.start(startInput);
    expect(startReplay.action).toEqual(started.action);
    expect(startReplay).toMatchObject({
      replayed: true,
      result: started.result,
      current: {
        operation: { state: "ready" },
        snapshot: { state: "released" },
      },
    });
    const pauseReplay = restarted.pause(pauseInput);
    expect(pauseReplay.action).toEqual(paused.action);
    expect(pauseReplay).toMatchObject({
      replayed: true,
      result: paused.result,
      current: {
        operation: { state: "ready" },
        lock: null,
      },
    });
    await expect(
      service.openDownload({
        exportId: ready.managedExport.id,
        projectId: fixture.unrelatedScope.projectId,
        customerId: project.customerId,
        familyId: project.familyId,
      }),
    ).rejects.toThrow("PORTABILITY_MANAGED_EXPORT_SCOPE_MISMATCH");
    const download = await service.openDownload({
      exportId: ready.managedExport.id,
      projectId: project.id,
      customerId: project.customerId,
      familyId: project.familyId,
    });
    const downloaded = await readAll(download.createReadStream());
    await download.close();
    expect(downloaded).toEqual(
      await readFile(
        join(fixture.paths.root, "exports", ready.managedExport.archiveKey),
      ),
    );
  });

  it("fails a secret-bearing export without replacing the prior ready bytes", async () => {
    const fixture = await trackedFixture();
    const service = exportService(fixture);
    const project = new AuthoringRepositories(fixture.store).projects.get(
      fixture.scope.projectId,
    );
    if (!project) throw new Error("bad fixture");
    const first = service.pause(pauseInput(project, "clean"));
    const clean = await service.execute(
      service.start(startInput(first.current.operation, "clean")).current
        .operation.id,
    );
    const exportRoot = join(fixture.paths.root, "exports");
    const priorBytes = await readFile(
      join(exportRoot, clean.managedExport.archiveKey),
    );
    seedSecretCanary(fixture, project.customerId);
    const current = new AuthoringRepositories(fixture.store).projects.get(
      project.id,
    );
    if (!current) throw new Error("bad fixture");
    const blockedPause = service.pause(pauseInput(current, "blocked"));
    const blocked = service.start(
      startInput(blockedPause.current.operation, "blocked"),
    );

    await expect(service.execute(blocked.current.operation.id)).rejects.toThrow(
      "PORTABILITY_EXPORT_EXECUTION_FAILED",
    );
    expect(operationState(fixture, blocked.current.operation.id)).toBe(
      "failed",
    );
    expect(await readdir(exportRoot)).toEqual([clean.managedExport.archiveKey]);
    expect(
      await readFile(join(exportRoot, clean.managedExport.archiveKey)),
    ).toEqual(priorBytes);
    expect(activeLockCount(fixture)).toBe(0);
  }, 30_000);
});

function exportService(fixture: PortabilityFixture): ProjectExportService {
  const registry = testRegistry();
  return new ProjectExportService({
    store: fixture.store,
    registry,
    assets: fixture.assets,
    originals: fixture.originals,
    scheduler: fixtureScheduler(fixture.store, ulid),
    stagingStore: new SnapshotStagingStore(
      join(fixture.paths.root, "export-staging"),
    ),
    managedStore: new ManagedExportStore(join(fixture.paths.root, "exports")),
    appVersion: "0.1.0-test",
    nowIso: () => "2026-07-16T00:05:00.000Z",
    idFactory: ulid,
  });
}

function testRegistry() {
  const syntheticStudio = definePortabilityParticipant({
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
      {
        id: document.assetId,
        field: "assetId",
        ownership: "owned",
      },
    ],
  });
  return createPortabilityRegistry(
    [...realPortabilityParticipants, syntheticStudio],
    extendPortabilityCatalog(REAL_PORTABILITY_CATALOG, {
      collections: [{ key: "synthetic_studio_entries", owner: "participant" }],
      scopedWriters: [
        { key: "synthetic_studio.repository", owner: "participant" },
      ],
    }),
  );
}

async function trackedFixture(): Promise<PortabilityFixture> {
  const fixture = await createPortabilityFixture();
  cleanups.push(fixture.cleanup);
  return fixture;
}

function activeLockCount(fixture: PortabilityFixture): number {
  const row = fixture.store.database
    .prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE collection = 'portability_scope_locks'",
    )
    .get() as { count: number };
  return row.count;
}

function pauseInput(
  project: NonNullable<ReturnType<AuthoringRepositories["projects"]["get"]>>,
  suffix: string,
) {
  const request = {
    projectId: project.id,
    expectedProjectRevision: project.revision,
    idempotencyKey: `pause-${suffix}`,
    acknowledgedChildPhotos: true,
    acknowledgedNoAutomaticBackup: true,
  };
  return { ...request, requestHash: pauseProjectExportRequestHash(request) };
}

function startInput(
  operation: ReturnType<ProjectExportService["pause"]>["current"]["operation"],
  suffix: string,
) {
  const request = {
    projectId: operation.projectId,
    operationId: operation.id,
    expectedProjectRevision: operation.projectRevision,
    expectedOperationRevision: operation.revision,
    idempotencyKey: `start-${suffix}`,
  };
  return { ...request, requestHash: startProjectExportRequestHash(request) };
}

function seedSecretCanary(fixture: PortabilityFixture, customerId: string) {
  fixture.store.database
    .prepare(
      `UPDATE documents
       SET doc = json_set(doc, '$.notes', 'HEKAYATI_SECRET_CANARY')
       WHERE collection = 'customers' AND id = ?`,
    )
    .run(customerId);
}

function operationState(
  fixture: PortabilityFixture,
  operationId: string,
): string | null {
  const row = fixture.store.database
    .prepare(
      `SELECT json_extract(doc, '$.state') AS state
       FROM documents WHERE collection = 'export_operations' AND id = ?`,
    )
    .get(operationId) as { state: string } | undefined;
  return row?.state ?? null;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

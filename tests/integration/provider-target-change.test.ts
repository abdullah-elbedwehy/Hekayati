import { afterEach, describe, expect, it } from "vitest";

import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import {
  SettingsService,
  type Settings,
  type SettingsUpdate,
} from "../../src/domain/settings/settings.js";
import {
  ProviderTargetChangeCoordinator,
  type ProviderTargetResolver,
} from "../../src/jobs/provider-target-change.js";
import { localJobRegistration } from "../../src/jobs/registrations.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import type { JobRecord, JobTarget } from "../../src/jobs/schemas.js";
import { createJobTarget } from "../../src/jobs/targets.js";
import type { EnqueueJobInput, JobFence } from "../../src/jobs/types.js";
import { temporaryDirectory } from "../helpers/temp.js";

const hash = "a".repeat(64);
const projectId = "01J00000000000000000000001";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("ordinary provider target changes", () => {
  it("previews then atomically saves settings and creates linked remaining-work successors", async () => {
    const fixture = await harness(() => false);
    const graph = seedMixedGraph(fixture);
    const update = settingsUpdate(fixture.settings.get(), {
      textProvider: "gemini",
    });

    const preview = fixture.coordinator.preview(update);
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.affected.map((job) => job.id)).toEqual([
      graph.queued.id,
      graph.paused.id,
      graph.blocked.id,
    ]);
    expect(() => fixture.coordinator.save(update)).toThrowError(
      expect.objectContaining({
        code: "SETTINGS_TARGET_CHANGE_CONFIRMATION_REQUIRED",
      }),
    );

    const confirmed = fixture.coordinator.confirm({
      update,
      expectedSettingsUpdatedAt: preview.expectedSettingsUpdatedAt,
      impactHash: preview.impactHash,
    });

    expect(confirmed.settings.textProvider).toBe("gemini");
    expect(confirmed.successorJobIds).toHaveLength(3);
    const successors = fixture.scheduler
      .list()
      .filter((job) => confirmed.successorJobIds.includes(job.id));
    const queuedSuccessor = successorOf(successors, graph.queued.id);
    const pausedSuccessor = successorOf(successors, graph.paused.id);
    const blockedSuccessor = successorOf(successors, graph.blocked.id);
    expect(queuedSuccessor).toMatchObject({
      state: "paused",
      stateReason: "provider_unavailable",
      target: { providerId: "gemini", operation: "text" },
    });
    expect(pausedSuccessor).toMatchObject({
      state: "paused",
      stateReason: "operator",
      target: { providerId: "gemini", operation: "structured" },
    });
    expect(blockedSuccessor.dependsOn).toEqual([queuedSuccessor.id]);
    expect(fixture.scheduler.get(graph.queued.id)).toMatchObject({
      state: "canceled",
      stateReason: "superseded",
      successorJobIds: [queuedSuccessor.id],
    });
    expect(fixture.scheduler.get(graph.running.id)?.target?.providerId).toBe(
      "mock",
    );
    expect(fixture.scheduler.get(graph.succeeded.id)?.target?.providerId).toBe(
      "mock",
    );
    expect(fixture.scheduler.get(graph.image.id)).toMatchObject({
      state: "queued",
      target: { providerId: "mock", operation: "image" },
    });
    expect(fixture.scheduler.targetChangeAudits()).toHaveLength(1);
  });

  it("rejects stale previews without saving settings or creating successors", async () => {
    const fixture = await harness(() => true);
    const job = fixture.scheduler.enqueue(jobInput("stale", "text"));
    const update = settingsUpdate(fixture.settings.get(), {
      textProvider: "gemini",
    });
    const preview = fixture.coordinator.preview(update);
    fixture.scheduler.setPriority(job.id, {
      expectedRevision: job.revision,
      expectedState: "queued",
      priority: 5,
    });

    expect(() =>
      fixture.coordinator.confirm({
        update,
        expectedSettingsUpdatedAt: preview.expectedSettingsUpdatedAt,
        impactHash: preview.impactHash,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "SETTINGS_TARGET_CHANGE_STALE" }),
    );
    expect(fixture.settings.get().textProvider).toBe("mock");
    expect(fixture.scheduler.list()).toHaveLength(1);
    expect(fixture.scheduler.targetChangeAudits()).toEqual([]);
  });

  it("rolls back the settings document, jobs, and audit when successor disposition fails", async () => {
    const fixture = await harness(() => {
      throw new Error("injected availability failure");
    });
    fixture.scheduler.enqueue(jobInput("rollback", "text"));
    const update = settingsUpdate(fixture.settings.get(), {
      textProvider: "gemini",
    });
    const preview = fixture.coordinator.preview(update);
    const before = JSON.stringify(fixture.scheduler.list());

    expect(() =>
      fixture.coordinator.confirm({
        update,
        expectedSettingsUpdatedAt: preview.expectedSettingsUpdatedAt,
        impactHash: preview.impactHash,
      }),
    ).toThrow("injected availability failure");
    expect(fixture.settings.get().textProvider).toBe("mock");
    expect(JSON.stringify(fixture.scheduler.list())).toBe(before);
    expect(fixture.scheduler.targetChangeAudits()).toEqual([]);
  });

  it("saves concurrency-only changes without retargeting any job", async () => {
    const fixture = await harness(() => true);
    const job = fixture.scheduler.enqueue(jobInput("concurrency", "text"));
    const update = settingsUpdate(fixture.settings.get(), {
      concurrencyPerProvider: 4,
    });
    const preview = fixture.coordinator.preview(update);
    expect(preview).toMatchObject({
      requiresConfirmation: false,
      affected: [],
    });
    expect(fixture.coordinator.save(update).concurrencyPerProvider).toBe(4);
    expect(fixture.scheduler.get(job.id)).toEqual(job);
    expect(fixture.scheduler.targetChangeAudits()).toEqual([]);
  });
});

async function harness(isAvailable: (target: JobTarget) => boolean) {
  const directory = await temporaryDirectory("hekayati-target-change-");
  cleanups.push(directory.cleanup);
  const paths = resolveDataPaths(directory.path);
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  cleanups.push(async () => store.close());
  const settings = new SettingsService(store, paths);
  settings.initialize();
  const scheduler = new JobScheduler(store, {
    registeredJobs: [localJobRegistration("fixture")],
    nowIso: () => new Date().toISOString(),
  });
  const resolver: ProviderTargetResolver = {
    resolve: (candidate, operation) => targetFor(candidate, operation),
  };
  const coordinator = new ProviderTargetChangeCoordinator(
    settings,
    scheduler,
    resolver,
    { isAvailable },
  );
  return { settings, scheduler, coordinator, resolver };
}

function seedMixedGraph(fixture: Awaited<ReturnType<typeof harness>>) {
  const running = fixture.scheduler.enqueue(jobInput("running", "text", [], 5));
  const succeeded = fixture.scheduler.enqueue(
    jobInput("succeeded", "text", [], 4),
  );
  const queued = fixture.scheduler.enqueue(jobInput("queued", "text"));
  const paused = fixture.scheduler.enqueue(jobInput("paused", "structured"));
  const blocked = fixture.scheduler.enqueue(
    jobInput("blocked", "structured", [queued.id]),
  );
  const image = fixture.scheduler.enqueue(jobInput("image", "image"));
  const runningClaim = claim(fixture.scheduler, 10);
  fixture.scheduler.markRunning(runningClaim.id, fence(runningClaim), 11);
  const successClaim = claim(fixture.scheduler, 20);
  const successRunning = fixture.scheduler.markRunning(
    successClaim.id,
    fence(successClaim),
    21,
  );
  fixture.scheduler.commitSuccess(
    successRunning.id,
    fence(successRunning),
    [],
    22,
  );
  fixture.scheduler.pause(paused.id, {
    expectedRevision: paused.revision,
    expectedState: "queued",
  });
  return { running, succeeded, queued, paused, blocked, image };
}

function jobInput(
  intentId: string,
  operation: JobTarget["operation"],
  dependsOn: string[] = [],
  priority = 3,
): EnqueueJobInput {
  const settings = fixtureSettings();
  return {
    jobType: "fixture",
    projectId,
    standaloneScopeId: null,
    dependsOn,
    priority,
    intentId,
    target: targetFor(settings, operation),
    request: { kind: "local", payloadHash: hash },
    inputSnapshot: {},
  };
}

function targetFor(
  settings: Settings,
  operation: JobTarget["operation"],
): JobTarget {
  const providerId =
    operation === "image" ? settings.imageProvider : settings.textProvider;
  return createJobTarget({
    providerId,
    modelId: `${providerId}-${operation}-fixture`,
    operation,
    configuration: {
      imageTier: operation === "image" ? settings.geminiImageTier : null,
    },
  });
}

function fixtureSettings(): Settings {
  return {
    id: "operator",
    schemaVersion: 3,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    textProvider: "mock",
    imageProvider: "mock",
    geminiImageTier: "default",
    models: {
      codexText: "codex-fixture",
      geminiText: "gemini-fixture",
      geminiImage: "gemini-image-fixture",
      geminiImageEconomy: "gemini-economy-fixture",
    },
    concurrencyPerProvider: 2,
    typography: { minimumAge3To5Pt: 14, minimumAge6PlusPt: 12 },
    watermarkText: "حكايتي",
    diskWarnGb: 10,
    photoUploadMaxMb: 25,
    photoMaxMegapixels: 80,
    storagePathsReadonly: { data: "/synthetic", assets: "/synthetic/assets" },
    firstRunAcknowledged: true,
    deferredStatus: {
      providerLifecycle: "available",
      printerProfiles: "not_configured",
    },
  };
}

function settingsUpdate(
  settings: Settings,
  changes: Partial<SettingsUpdate>,
): SettingsUpdate {
  return {
    textProvider: settings.textProvider,
    imageProvider: settings.imageProvider,
    geminiImageTier: settings.geminiImageTier,
    models: settings.models,
    concurrencyPerProvider: settings.concurrencyPerProvider,
    typography: settings.typography,
    watermarkText: settings.watermarkText,
    diskWarnGb: settings.diskWarnGb,
    photoUploadMaxMb: settings.photoUploadMaxMb,
    photoMaxMegapixels: settings.photoMaxMegapixels,
    firstRunAcknowledged: settings.firstRunAcknowledged,
    ...changes,
  };
}

function claim(scheduler: JobScheduler, nowMonoMs: number): JobRecord {
  const job = scheduler.claimNext({
    workerId: "worker",
    bootId: "boot",
    nowMonoMs,
    nowWallMs: Date.parse("2026-07-14T00:00:00.000Z") + nowMonoMs,
    leaseTtlMs: 1_000,
    concurrencyPerProvider: 4,
  });
  if (!job) throw new Error("EXPECTED_CLAIM");
  return job;
}

function fence(job: JobRecord): JobFence {
  if (!job.lease) throw new Error("EXPECTED_LEASE");
  return {
    workerId: job.lease.workerId,
    bootId: job.lease.bootId,
    claimToken: job.lease.claimToken,
    attempt: job.attempts,
  };
}

function successorOf(jobs: JobRecord[], originalId: string): JobRecord {
  const successor = jobs.find((job) => job.supersedesJobId === originalId);
  if (!successor) throw new Error("EXPECTED_SUCCESSOR");
  return successor;
}

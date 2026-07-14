import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AssetStore,
  type AssetInput,
  type PreparedAsset,
} from "../../src/assets/asset-store.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { localJobRegistration } from "../../src/jobs/registrations.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import { localJobRequestSchema } from "../../src/jobs/schemas.js";
import type {
  EnqueueJobInput,
  JobClock,
  RegisteredJobDefinition,
} from "../../src/jobs/types.js";
import { JobWorkerPool } from "../../src/jobs/worker-pool.js";
import { temporaryDirectory } from "../helpers/temp.js";

const projectId = "01J00000000000000000000001";
const payloadHash = "f".repeat(64);
const now = "2026-07-14T00:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("job asset commit fencing", () => {
  it("deduplicates concurrent same-content commits and increments one refcount", async () => {
    const fixture = await harness();
    const worker = pool(
      fixture.scheduler,
      assetDefinition(fixture.assets, async () => undefined),
    );
    const first = fixture.scheduler.enqueue(input("asset-first"));
    const second = fixture.scheduler.enqueue(input("asset-second"));

    await Promise.all([worker.runOne(), worker.runOne()]);

    const [asset] = fixture.assets.list();
    expect(asset).toMatchObject({ refCount: 2, bytes: assetBytes.length });
    expect(fixture.scheduler.get(first.id)?.resultRefs).toEqual([asset?.id]);
    expect(fixture.scheduler.get(second.id)?.resultRefs).toEqual([asset?.id]);
    fixture.close();
  });

  it("discards an uncommitted prepared file after late cancellation", async () => {
    const fixture = await harness();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const continueExecution = new Promise<void>((resolve) => {
      release = resolve;
    });
    const definition = assetDefinition(fixture.assets, async () => {
      started?.();
      await continueExecution;
    });
    const worker = pool(fixture.scheduler, definition);
    const job = fixture.scheduler.enqueue(input("asset-canceled"));
    const run = worker.runOne();
    await executing;
    const running = fixture.scheduler.get(job.id)!;

    fixture.scheduler.cancel(job.id, {
      expectedRevision: running.revision,
      expectedState: "running",
    });
    release?.();
    await run;

    expect(fixture.scheduler.get(job.id)?.state).toBe("canceled");
    expect(fixture.assets.list()).toEqual([]);
    fixture.close();
  });
});

const assetBytes = Buffer.from("synthetic-job-asset", "utf8");

function assetDefinition(
  assets: AssetStore,
  wait: () => Promise<void>,
): RegisteredJobDefinition {
  return {
    jobType: "fixture_asset",
    requestSchema: localJobRequestSchema,
    validateEnqueue: () => undefined,
    prepare: async () => ({}),
    execute: async () => {
      const prepared = await assets.prepare(assetInput());
      await wait();
      return { ok: true, value: prepared };
    },
    commit: ({ value }) => {
      const committed = assets.commitPrepared(value as PreparedAsset);
      return { resultRefs: [committed.id] };
    },
    discard: (value) => assets.discardPrepared(value as PreparedAsset),
  };
}

function assetInput(): AssetInput {
  return {
    bytes: assetBytes,
    extension: "bin",
    mime: "application/octet-stream",
    role: "thumbnail",
    origin: "derived",
  };
}

async function harness() {
  const temp = await temporaryDirectory("hekayati-job-asset-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "jobs.db"));
  const assets = new AssetStore(store, join(temp.path, "assets"));
  const scheduler = new JobScheduler(store, {
    registeredJobs: [localJobRegistration("fixture_asset")],
    nowIso: () => now,
  });
  return { assets, scheduler, close: () => store.close() };
}

function input(intentId: string): EnqueueJobInput {
  return {
    jobType: "fixture_asset",
    projectId,
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId,
    target: null,
    request: { kind: "local", payloadHash },
    inputSnapshot: {},
  };
}

function pool(
  scheduler: JobScheduler,
  definition: RegisteredJobDefinition,
): JobWorkerPool {
  return new JobWorkerPool(scheduler, [definition], {
    bootId: "boot",
    workerId: "worker",
    clock,
    concurrencyPerProvider: 2,
    leaseTtlMs: 10_000,
    heartbeatIntervalMs: 1_000,
    timeoutMs: 10_000,
    pollIntervalMs: 10_000,
    maxWorkers: 2,
  });
}

const clock: JobClock = {
  monotonicNow: () => 100,
  wallNowIso: () => now,
};

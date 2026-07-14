import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AssetStore, type AssetInput } from "../../src/assets/asset-store.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import {
  humanGateJobRegistration,
  localJobRegistration,
} from "../../src/jobs/registrations.js";
import { JobRuntime } from "../../src/jobs/runtime.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import { localJobRequestSchema } from "../../src/jobs/schemas.js";
import type {
  EnqueueJobInput,
  JobClock,
  JobFence,
  JobRecord,
  RegisteredJobDefinition,
} from "../../src/jobs/types.js";
import { makeFailure } from "../../src/providers/failures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const projectId = "01J00000000000000000000001";
const hash = "7".repeat(64);
const now = "2026-07-14T00:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("job restart failure matrix", () => {
  it("recovers executable stages, preserves durable states, and sweeps only managed orphans", async () => {
    const temp = await temporaryDirectory("hekayati-job-restart-matrix-");
    cleanups.push(temp.cleanup);
    const database = join(temp.path, "hekayati.db");
    const assetRoot = join(temp.path, "assets");
    const firstStore = new DocumentStore(database);
    const firstAssets = new AssetStore(firstStore, assetRoot);
    const first = scheduler(firstStore);

    const succeeded = first.enqueue(input("completed"));
    const succeededRunning = runClaim(first, 10);
    const committedAsset = await firstAssets.prepare(assetInput("completed"));
    first.commitWith(succeededRunning.id, fence(succeededRunning), 12, () => {
      const committed = firstAssets.commitPrepared(committedAsset);
      return { resultRefs: [committed.id] };
    });

    const claimed = first.enqueue(input("claimed"));
    expect(claim(first, 20).id).toBe(claimed.id);
    const running = first.enqueue(input("provider-running"));
    const runningClaim = claim(first, 30);
    expect(runningClaim.id).toBe(running.id);
    first.markRunning(running.id, fence(runningClaim), 31);

    const retry = first.enqueue(input("retry-delay"));
    const retryRunning = runClaim(first, 40);
    first.recordFailure(
      retryRunning.id,
      fence(retryRunning),
      makeFailure("network_failure"),
      { nowMonoMs: 42, wallNowIso: now },
    );

    const dependency = first.enqueue(input("dependency"));
    const blocked = first.enqueue(
      input("blocked", { dependsOn: [dependency.id] }),
    );
    const gate = first.enqueue(gateInput());
    const operatorPaused = first.enqueue(input("operator-paused"));
    first.pause(operatorPaused.id, {
      expectedRevision: operatorPaused.revision,
      expectedState: "queued",
    });

    const renamedBeforeDb = await firstAssets.prepare(assetInput("orphan"));
    const renamedOrphanPath = firstAssets.pathForRecord(renamedBeforeDb.record);
    const temporaryDirectoryPath = join(assetRoot, "aa");
    const temporaryPath = join(
      temporaryDirectoryPath,
      ".hekayati-tmp-restart-fixture",
    );
    await mkdir(temporaryDirectoryPath, { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, "synthetic-temporary", { mode: 0o600 });
    firstStore.close();

    const restartedStore = new DocumentStore(database);
    const restartedAssets = new AssetStore(restartedStore, assetRoot);
    const removed = await restartedAssets.garbageCollectOrphans();
    expect(removed.sort()).toEqual([renamedOrphanPath, temporaryPath].sort());
    await expect(stat(renamedOrphanPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });

    const runtime = new JobRuntime(restartedStore, {
      bootId: "restart-boot",
      workerId: "restart-worker",
      clock,
      definitions: [fixtureDefinition()],
    });
    expect(runtime.scheduler.get(succeeded.id)).toMatchObject({
      state: "succeeded",
      resultRefs: [committedAsset.record.id],
    });
    expect(await restartedAssets.read(committedAsset.record.id)).toEqual(
      assetInput("completed").bytes,
    );
    expect(runtime.scheduler.get(claimed.id)).toMatchObject({
      state: "queued",
      stateReason: "recovered",
      lease: null,
    });
    expect(runtime.scheduler.get(running.id)).toMatchObject({
      state: "queued",
      stateReason: "recovered",
      lease: null,
    });
    expect(runtime.scheduler.get(retry.id)).toMatchObject({
      state: "queued",
      stateReason: "retry_delay",
      autoRetryIndex: 1,
    });
    expect(runtime.scheduler.get(dependency.id)?.state).toBe("queued");
    expect(runtime.scheduler.get(blocked.id)).toMatchObject({
      state: "blocked",
      stateReason: "dependency",
    });
    expect(runtime.scheduler.get(gate.id)).toMatchObject({
      state: "waiting_review",
      request: {
        kind: "human_gate",
        gateKind: "internal_review",
        targetVersionId: "01J00000000000000000000003",
      },
    });
    expect(runtime.scheduler.get(operatorPaused.id)).toMatchObject({
      state: "paused",
      stateReason: "operator",
    });
    expect(restartedAssets.list()).toHaveLength(1);

    new JobRuntime(restartedStore, {
      bootId: "second-restart-boot",
      workerId: "second-restart-worker",
      clock,
      definitions: [fixtureDefinition()],
    });
    for (const recoveredId of [claimed.id, running.id]) {
      expect(
        runtime.scheduler
          .events(recoveredId)
          .filter((event) => event.kind === "recovered"),
      ).toHaveLength(1);
    }
    expect(runtime.scheduler.list()).toHaveLength(8);
    restartedStore.close();
  });
});

function scheduler(store: DocumentStore): JobScheduler {
  return new JobScheduler(store, {
    registeredJobs: [
      localJobRegistration("fixture_noop"),
      humanGateJobRegistration("human_gate"),
    ],
    nowIso: () => now,
  });
}

function input(
  intentId: string,
  overrides: Partial<EnqueueJobInput> = {},
): EnqueueJobInput {
  return {
    jobType: "fixture_noop",
    projectId,
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId,
    target: null,
    request: { kind: "local", payloadHash: hash },
    inputSnapshot: { projectVersion: "version-1" },
    ...overrides,
  };
}

function gateInput(): EnqueueJobInput {
  return {
    ...input("waiting-review"),
    jobType: "human_gate",
    request: {
      kind: "human_gate",
      gateKind: "internal_review",
      targetId: projectId,
      targetVersionId: "01J00000000000000000000003",
    },
  };
}

function claim(scheduler: JobScheduler, nowMonoMs: number): JobRecord {
  const claimed = scheduler.claimNext({
    workerId: "first-worker",
    bootId: "first-boot",
    nowMonoMs,
    nowWallMs: Date.parse(now) + nowMonoMs,
    leaseTtlMs: 30_000,
    concurrencyPerProvider: 4,
  });
  if (!claimed) throw new Error("EXPECTED_RESTART_MATRIX_CLAIM");
  return claimed;
}

function runClaim(scheduler: JobScheduler, nowMonoMs: number): JobRecord {
  const claimed = claim(scheduler, nowMonoMs);
  return scheduler.markRunning(claimed.id, fence(claimed), nowMonoMs + 1);
}

function fence(job: JobRecord): JobFence {
  if (!job.lease) throw new Error("EXPECTED_RESTART_MATRIX_FENCE");
  return {
    workerId: job.lease.workerId,
    bootId: job.lease.bootId,
    claimToken: job.lease.claimToken,
    attempt: job.attempts,
  };
}

function assetInput(marker: string): AssetInput {
  return {
    bytes: Buffer.from(`synthetic-job-${marker}`, "utf8"),
    extension: "bin",
    mime: "application/octet-stream",
    role: "thumbnail",
    origin: "derived",
  };
}

function fixtureDefinition(): RegisteredJobDefinition {
  return {
    jobType: "fixture_noop",
    requestSchema: localJobRequestSchema,
    validateEnqueue: () => undefined,
    prepare: async () => ({}),
    execute: async () => ({ ok: true, value: null }),
    commit: () => ({ resultRefs: [] }),
  };
}

const clock: JobClock = {
  monotonicNow: () => 100,
  wallNowIso: () => now,
};

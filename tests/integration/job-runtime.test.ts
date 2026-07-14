import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { localJobRegistration } from "../../src/jobs/registrations.js";
import { JobRuntime } from "../../src/jobs/runtime.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import { localJobRequestSchema } from "../../src/jobs/schemas.js";
import type {
  EnqueueJobInput,
  JobClock,
  RegisteredJobDefinition,
} from "../../src/jobs/types.js";
import { temporaryDirectory } from "../helpers/temp.js";

const hash = "1".repeat(64);
const projectId = "01J00000000000000000000001";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("job runtime", () => {
  it("recovers every prior-boot lease before reporting the worker ready", async () => {
    const { store, close } = await storeHarness();
    const old = new JobScheduler(store, {
      registeredJobs: [localJobRegistration("fixture_noop")],
      nowIso: () => now,
    });
    const job = old.enqueue(input("prior-boot"));
    old.claimNext({
      workerId: "old-worker",
      bootId: "old-boot",
      nowMonoMs: 10,
      nowWallMs: Date.parse(now),
      leaseTtlMs: 30_000,
      concurrencyPerProvider: 1,
    });

    const runtime = new JobRuntime(store, {
      bootId: "new-boot",
      workerId: "new-worker",
      clock: fixedClock,
      definitions: [fixtureDefinition()],
    });
    expect(runtime.scheduler.get(job.id)).toMatchObject({
      state: "queued",
      stateReason: "recovered",
      lease: null,
    });
    expect(runtime.healthSnapshot()).toMatchObject({
      workerStatus: "stopped",
      lastRecoveryAt: now,
    });
    close();
  });

  it("returns a bounded queue projection without persisted requests or inputs", async () => {
    const { store, close } = await storeHarness();
    const runtime = new JobRuntime(store, {
      bootId: "boot",
      workerId: "worker",
      clock: fixedClock,
      definitions: [fixtureDefinition()],
    });
    runtime.scheduler.enqueue({
      ...input("private-projection"),
      request: { kind: "local", payloadHash: hash },
      inputSnapshot: { projectVersion: "PRIVATE_INPUT_VERSION_CANARY" },
    });
    const projection = runtime.queueProjection();
    const serialized = JSON.stringify(projection);
    expect(projection.jobs[0]).not.toHaveProperty("request");
    expect(projection.jobs[0]).not.toHaveProperty("inputSnapshot");
    expect(serialized).not.toContain(hash);
    expect(serialized).not.toContain("PRIVATE_INPUT_VERSION_CANARY");
    expect(projection.jobs[0]?.allowedActions).toEqual([
      "pause",
      "cancel",
      "priority",
    ]);
    close();
  });

  it("starts and stops the worker explicitly while an empty queue stays inert", async () => {
    const { store, close } = await storeHarness();
    let calls = 0;
    const runtime = new JobRuntime(store, {
      bootId: "boot",
      workerId: "worker",
      clock: fixedClock,
      pollIntervalMs: 10,
      definitions: [fixtureDefinition(() => (calls += 1))],
    });
    runtime.start();
    expect(runtime.healthSnapshot().workerStatus).toBe("running");
    await runtime.stop();
    expect(runtime.healthSnapshot().workerStatus).toBe("stopped");
    expect(calls).toBe(0);
    close();
  });
});

async function storeHarness() {
  const temp = await temporaryDirectory("hekayati-job-runtime-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "jobs.db"));
  return { store, close: () => store.close() };
}

function input(intentId: string): EnqueueJobInput {
  return {
    jobType: "fixture_noop",
    projectId,
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId,
    target: null,
    request: { kind: "local", payloadHash: hash },
    inputSnapshot: {},
  };
}

function fixtureDefinition(
  onExecute: () => void = () => undefined,
): RegisteredJobDefinition {
  return {
    jobType: "fixture_noop",
    requestSchema: localJobRequestSchema,
    validateEnqueue: () => undefined,
    prepare: async () => ({}),
    execute: async () => {
      onExecute();
      return { ok: true, value: null };
    },
    commit: () => ({ resultRefs: [] }),
  };
}

const now = "2026-07-14T00:00:00.000Z";
const fixedClock: JobClock = {
  monotonicNow: () => 100,
  wallNowIso: () => now,
};

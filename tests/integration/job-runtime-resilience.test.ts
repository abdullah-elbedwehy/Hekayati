import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { JobRuntime } from "../../src/jobs/runtime.js";
import { localJobRequestSchema } from "../../src/jobs/schemas.js";
import type {
  EnqueueJobInput,
  RegisteredJobDefinition,
} from "../../src/jobs/types.js";
import { createRuntime } from "../../src/server/app.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
const hash = "9".repeat(64);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("job runtime resilience", () => {
  it("reports a volatile halt without persisting one after database loss", async () => {
    const { store, close } = await storeHarness();
    const runtime = new JobRuntime(store, {
      pollIntervalMs: 1,
      definitions: [databaseFailingDefinition()],
    });
    runtime.scheduler.enqueue(input("database-failure"));
    runtime.start();

    await eventually(() =>
      expect(runtime.healthSnapshot().workerStatus).toBe("halted"),
    );

    expect(runtime.scheduler.storageStatus().workerStatus).toBe("running");
    await runtime.stop();
    close();
  });

  it("returns the last safe health projection and stops cleanly when SQLite closes", async () => {
    const { store } = await storeHarness();
    const runtime = new JobRuntime(store, { pollIntervalMs: 1 });
    runtime.start();
    const before = runtime.healthSnapshot();
    store.close();

    expect(runtime.healthSnapshot()).toMatchObject({
      ...before,
      workerStatus: "halted",
    });
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it("closes Fastify and SQLite even when worker cleanup rejects", async () => {
    const temp = await temporaryDirectory("hekayati-close-resilience-");
    cleanups.push(temp.cleanup);
    const runtime = await createRuntime({
      dataDir: temp.path,
      serveUi: false,
    });
    let appClosed = false;
    runtime.app.addHook("onClose", () => {
      appClosed = true;
    });
    vi.spyOn(runtime.jobs, "stop").mockRejectedValueOnce(
      new Error("FIXTURE_WORKER_STOP_FAILURE"),
    );

    await expect(runtime.close()).rejects.toThrow(
      "FIXTURE_WORKER_STOP_FAILURE",
    );

    expect(appClosed).toBe(true);
    expect(() => runtime.jobs.scheduler.list()).toThrow(/database/i);
  });
});

async function storeHarness() {
  const temp = await temporaryDirectory("hekayati-runtime-resilience-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "jobs.db"));
  return { store, close: () => store.close() };
}

function databaseFailingDefinition(): RegisteredJobDefinition {
  return {
    jobType: "fixture_noop",
    requestSchema: localJobRequestSchema,
    validateEnqueue: () => undefined,
    prepare: async () => ({}),
    execute: async () => {
      throw Object.assign(new Error("fixture"), { code: "SQLITE_CORRUPT" });
    },
    commit: () => ({ resultRefs: [] }),
  };
}

function input(intentId: string): EnqueueJobInput {
  return {
    jobType: "fixture_noop",
    projectId: "01J00000000000000000000001",
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId,
    target: null,
    request: { kind: "local", payloadHash: hash },
    inputSnapshot: {},
  };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  assertion();
}

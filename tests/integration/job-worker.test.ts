import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import {
  DocumentRepository,
  DocumentStore,
} from "../../src/domain/repository/document-store.js";
import { JobError } from "../../src/jobs/errors.js";
import { localJobRegistration } from "../../src/jobs/registrations.js";
import { localJobRequestSchema } from "../../src/jobs/schemas.js";
import { makeFailure } from "../../src/providers/failures.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import type {
  EnqueueJobInput,
  JobClock,
  RegisteredJobDefinition,
} from "../../src/jobs/types.js";
import { JobWorkerPool } from "../../src/jobs/worker-pool.js";
import { temporaryDirectory } from "../helpers/temp.js";

const hash = "f".repeat(64);
const projectId = "01J00000000000000000000001";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("job worker and commit protocol", () => {
  it("runs one registered definition and commits exactly once", async () => {
    const { scheduler, close } = await harness();
    const trace: string[] = [];
    const worker = pool(scheduler, definition(trace));
    const job = scheduler.enqueue(input("worker-success"));
    await expect(worker.runOne()).resolves.toBe(true);
    expect(trace).toEqual(["prepare", "execute", "commit"]);
    expect(scheduler.get(job.id)).toMatchObject({
      state: "succeeded",
      resultRefs: ["fixture-result"],
    });
    await expect(worker.runOne()).resolves.toBe(false);
    expect(trace).toHaveLength(3);
    close();
  });

  it("rolls back an owner write when commit rejects and discards prepared output", async () => {
    const { scheduler, store, close } = await harness();
    const results = new DocumentRepository(
      store,
      "fixture_results",
      resultSchema,
    );
    let discarded = 0;
    const rejecting: RegisteredJobDefinition = {
      jobType: "fixture_noop",
      requestSchema: localJobRequestSchema,
      validateEnqueue: () => undefined,
      prepare: async () => ({}),
      execute: async () => ({ ok: true, value: { id: "fixture-result" } }),
      commit: ({ job }) => {
        results.put({
          id: "fixture-result",
          schemaVersion: 1,
          createdAt: now,
          updatedAt: now,
          jobId: job.id,
        });
        throw new Error("FIXTURE_COMMIT_REJECTED");
      },
      discard: () => {
        discarded += 1;
      },
    };
    const job = scheduler.enqueue(input("rollback"));
    await pool(scheduler, rejecting).runOne();
    expect(results.list()).toEqual([]);
    expect(discarded).toBe(1);
    expect(scheduler.get(job.id)).toMatchObject({
      state: "paused",
      stateReason: "operator",
    });
    expect(scheduler.events(job.id).map((event) => event.kind)).toContain(
      "commit_rejected",
    );
    close();
  });

  it("keeps cancellation terminal when a late executor result returns", async () => {
    const { scheduler, close } = await harness();
    let release: (() => void) | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const result = new Promise<void>((resolve) => {
      release = resolve;
    });
    let discarded = 0;
    const late: RegisteredJobDefinition = {
      jobType: "fixture_noop",
      requestSchema: localJobRequestSchema,
      validateEnqueue: () => undefined,
      prepare: async () => ({}),
      execute: async () => {
        startedResolve?.();
        await result;
        return { ok: true, value: "late" };
      },
      commit: () => ({ resultRefs: ["late-result"] }),
      discard: () => {
        discarded += 1;
      },
    };
    const job = scheduler.enqueue(input("cancel-late"));
    const running = pool(scheduler, late).runOne();
    await started;
    const current = scheduler.get(job.id)!;
    scheduler.cancel(job.id, {
      expectedRevision: current.revision,
      expectedState: "running",
    });
    release?.();
    await running;
    expect(scheduler.get(job.id)?.state).toBe("canceled");
    expect(discarded).toBe(1);
    expect(scheduler.events(job.id).at(-1)).toMatchObject({
      kind: "commit_rejected",
      reason: "late_commit",
      noteCode: "commit_precondition",
    });
    close();
  });

  it("returns at the deadline when prepare ignores cancellation", async () => {
    const { scheduler, close } = await harness();
    let releasePrepare: (() => void) | undefined;
    const prepared = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    let executeCount = 0;
    const stuckPrepare: RegisteredJobDefinition = {
      jobType: "fixture_noop",
      requestSchema: localJobRequestSchema,
      validateEnqueue: () => undefined,
      prepare: async () => {
        await prepared;
        return { tooLate: true };
      },
      execute: async () => {
        executeCount += 1;
        return { ok: true, value: null };
      },
      commit: () => ({ resultRefs: [] }),
    };
    const job = scheduler.enqueue(input("prepare-timeout"));

    await expect(
      resolvesWithin(
        pool(scheduler, stuckPrepare, { timeoutMs: 25 }).runOne(),
        500,
      ),
    ).resolves.toBe(true);

    expect(executeCount).toBe(0);
    expect(scheduler.get(job.id)).toMatchObject({
      state: "queued",
      stateReason: "retry_delay",
      failure: { category: "timeout" },
    });
    releasePrepare?.();
    close();
  });

  it("returns at the deadline and discards an executor's late success", async () => {
    const { scheduler, close } = await harness();
    let releaseExecute: (() => void) | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const executed = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    let commitCount = 0;
    let discardCount = 0;
    const stuckExecute: RegisteredJobDefinition = {
      jobType: "fixture_noop",
      requestSchema: localJobRequestSchema,
      validateEnqueue: () => undefined,
      prepare: async () => ({}),
      execute: async () => {
        startedResolve?.();
        await executed;
        return { ok: true, value: "late-timeout-result" };
      },
      commit: () => {
        commitCount += 1;
        return { resultRefs: ["must-not-commit"] };
      },
      discard: () => {
        discardCount += 1;
      },
    };
    const job = scheduler.enqueue(input("execute-timeout"));
    const running = pool(scheduler, stuckExecute, {
      timeoutMs: 25,
    }).runOne();
    await started;

    await expect(resolvesWithin(running, 500)).resolves.toBe(true);

    expect(scheduler.get(job.id)).toMatchObject({
      state: "queued",
      stateReason: "retry_delay",
      resultRefs: [],
      failure: { category: "timeout" },
    });
    expect(commitCount).toBe(0);
    releaseExecute?.();
    await eventually(() => expect(discardCount).toBe(1));
    expect(commitCount).toBe(0);
    close();
  });

  it("records a content-safe stale-lineage rejection and preserves no result", async () => {
    const { scheduler, close } = await harness();
    let discarded = 0;
    const stale: RegisteredJobDefinition = {
      jobType: "fixture_noop",
      requestSchema: localJobRequestSchema,
      validateEnqueue: () => undefined,
      prepare: async () => ({}),
      execute: async () => ({ ok: true, value: "PRIVATE_RESULT_CANARY" }),
      commit: () => {
        throw new JobError("JOB_INPUT_LINEAGE_STALE");
      },
      discard: () => {
        discarded += 1;
      },
    };
    const job = scheduler.enqueue(input("stale-lineage"));

    await pool(scheduler, stale).runOne();

    expect(scheduler.get(job.id)).toMatchObject({
      state: "failed",
      stateReason: "JOB_INPUT_LINEAGE_STALE",
      resultRefs: [],
      failure: {
        category: "stale_dependency",
        reasonCode: "JOB_INPUT_LINEAGE_STALE",
      },
    });
    expect(discarded).toBe(1);
    expect(scheduler.events(job.id).slice(-2)).toMatchObject([
      {
        kind: "commit_rejected",
        noteCode: "commit_precondition",
      },
      { kind: "failed", noteCode: "stale_dependency" },
    ]);
    expect(JSON.stringify(scheduler.events(job.id))).not.toContain(
      "PRIVATE_RESULT_CANARY",
    );
    close();
  });

  it("routes normalized executor failures through the exact retry policy", async () => {
    const { scheduler, close } = await harness();
    const failed: RegisteredJobDefinition = {
      jobType: "fixture_noop",
      requestSchema: localJobRequestSchema,
      validateEnqueue: () => undefined,
      prepare: async () => ({}),
      execute: async () => ({
        ok: false,
        failure: makeFailure("network_failure"),
      }),
      commit: () => {
        throw new Error("UNREACHABLE");
      },
    };
    const job = scheduler.enqueue(input("worker-retry"));
    await pool(scheduler, failed).runOne();
    expect(scheduler.get(job.id)).toMatchObject({
      state: "queued",
      stateReason: "retry_delay",
      autoRetryIndex: 1,
    });
    close();
  });

  it("persists the exact safe photo guard code without private detail", async () => {
    const { scheduler, close } = await harness();
    const rejected: RegisteredJobDefinition = {
      jobType: "fixture_noop",
      requestSchema: localJobRequestSchema,
      validateEnqueue: () => undefined,
      prepare: async () => {
        throw new JobError("PHOTO_CONSENT_REQUIRED");
      },
      execute: async () => {
        throw new Error("UNREACHABLE");
      },
      commit: () => ({ resultRefs: [] }),
    };
    const job = scheduler.enqueue(input("consent-guard"));

    await pool(scheduler, rejected).runOne();

    expect(scheduler.get(job.id)).toMatchObject({
      state: "paused",
      stateReason: "PHOTO_CONSENT_REQUIRED",
      failure: {
        category: "missing_reference_asset",
        reasonCode: "PHOTO_CONSENT_REQUIRED",
      },
    });
    close();
  });

  it("reads the current concurrency setting before every future claim", async () => {
    const { scheduler, close } = await harness();
    let concurrency = 1;
    let started = 0;
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executing: RegisteredJobDefinition = {
      jobType: "fixture_noop",
      requestSchema: localJobRequestSchema,
      validateEnqueue: () => undefined,
      prepare: async () => ({}),
      execute: async () => {
        started += 1;
        await released;
        return { ok: true, value: null };
      },
      commit: () => ({ resultRefs: [] }),
    };
    const worker = pool(scheduler, executing, {
      concurrencyPerProvider: 1,
      getConcurrencyPerProvider: () => concurrency,
    });
    scheduler.enqueue(targetedInput("dynamic-cap-1"));
    scheduler.enqueue(targetedInput("dynamic-cap-2"));

    const first = worker.runOne();
    await eventually(() => expect(started).toBe(1));
    await expect(worker.runOne()).resolves.toBe(false);
    concurrency = 2;
    const second = worker.runOne();
    await eventually(() => expect(started).toBe(2));

    release?.();
    await Promise.all([first, second]);
    close();
  });

  it("persists a global storage stop then aborts every owned execution", async () => {
    const { scheduler, close } = await harness();
    let started = 0;
    let failFirst: (() => void) | undefined;
    const firstFailure = new Promise<void>((resolve) => {
      failFirst = resolve;
    });
    const aborted = new Set<string>();
    const executing: RegisteredJobDefinition = {
      jobType: "fixture_noop",
      requestSchema: localJobRequestSchema,
      validateEnqueue: () => undefined,
      prepare: async () => ({}),
      execute: async ({ job, signal }) => {
        started += 1;
        if (job.intentId === "storage-source") {
          await firstFailure;
          throw errorWithCode("ENOSPC");
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted.add(job.id);
              resolve();
            },
            { once: true },
          );
        });
        throw new Error("aborted sibling");
      },
      commit: () => ({ resultRefs: [] }),
    };
    const worker = pool(scheduler, executing, {
      concurrencyPerProvider: 2,
    });
    const source = scheduler.enqueue(input("storage-source"));
    const sibling = scheduler.enqueue(input("storage-sibling"));

    const runs = [worker.runOne(), worker.runOne()];
    await eventually(() => expect(started).toBe(2));
    failFirst?.();
    await Promise.all(runs);

    expect(scheduler.storageStatus()).toMatchObject({
      active: true,
      reason: "insufficient_disk_space",
    });
    expect(scheduler.get(source.id)).toMatchObject({
      state: "paused",
      stateReason: "storage",
    });
    expect(scheduler.get(sibling.id)).toMatchObject({
      state: "paused",
      stateReason: "storage",
    });
    expect(aborted).toContain(sibling.id);
    close();
  });

  it("halts on database loss without writing a false halted transition", async () => {
    const { scheduler, close } = await harness();
    let halted = 0;
    const failing: RegisteredJobDefinition = {
      jobType: "fixture_noop",
      requestSchema: localJobRequestSchema,
      validateEnqueue: () => undefined,
      prepare: async () => ({}),
      execute: async () => {
        throw errorWithCode("SQLITE_CORRUPT");
      },
      commit: () => ({ resultRefs: [] }),
    };
    const worker = pool(scheduler, failing, {
      onDatabaseUnavailable: () => {
        halted += 1;
      },
    });
    scheduler.enqueue(input("database-loss"));

    await expect(worker.runOne()).resolves.toBe(true);

    expect(halted).toBe(1);
    expect(scheduler.storageStatus().workerStatus).toBe("stopped");
    await expect(worker.runOne()).resolves.toBe(false);
    close();
  });

  it("halts immediately when a heartbeat loses the database", async () => {
    const { scheduler, store } = await harness();
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let halted = 0;
    const executing: RegisteredJobDefinition = {
      jobType: "fixture_noop",
      requestSchema: localJobRequestSchema,
      validateEnqueue: () => undefined,
      prepare: async () => ({}),
      execute: async ({ signal }) => {
        startedResolve?.();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { ok: false, failure: makeFailure("user_canceled") };
      },
      commit: () => ({ resultRefs: [] }),
    };
    const worker = pool(scheduler, executing, {
      heartbeatIntervalMs: 2,
      leaseTtlMs: 100,
      onDatabaseUnavailable: () => {
        halted += 1;
      },
    });
    scheduler.enqueue(input("heartbeat-database-loss"));
    const running = worker.runOne();
    await started;

    store.close();
    await running;

    expect(halted).toBe(1);
  });
});

const resultSchema = z
  .object({
    id: z.string(),
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    jobId: z.string(),
  })
  .strict();

async function harness() {
  const temp = await temporaryDirectory("hekayati-worker-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "jobs.db"));
  const scheduler = new JobScheduler(store, {
    registeredJobs: [localJobRegistration("fixture_noop")],
    nowIso: () => now,
  });
  return { scheduler, store, close: () => store.close() };
}

function pool(
  scheduler: JobScheduler,
  registered: RegisteredJobDefinition,
  overrides: Partial<ConstructorParameters<typeof JobWorkerPool>[2]> = {},
): JobWorkerPool {
  return new JobWorkerPool(scheduler, [registered], {
    bootId: "boot-1",
    workerId: "worker-1",
    clock: fixtureClock,
    concurrencyPerProvider: 1,
    leaseTtlMs: 30_000,
    heartbeatIntervalMs: 10_000,
    timeoutMs: 20_000,
    pollIntervalMs: 100,
    maxWorkers: 1,
    ...overrides,
  });
}

function definition(trace: string[]): RegisteredJobDefinition {
  return {
    jobType: "fixture_noop",
    requestSchema: localJobRequestSchema,
    validateEnqueue: () => undefined,
    prepare: async () => {
      trace.push("prepare");
      return { fixture: true };
    },
    execute: async () => {
      trace.push("execute");
      return { ok: true, value: { fixture: true } };
    },
    commit: () => {
      trace.push("commit");
      return { resultRefs: ["fixture-result"] };
    },
  };
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

function targetedInput(intentId: string): EnqueueJobInput {
  return {
    ...input(intentId),
    target: {
      providerId: "mock",
      modelId: "fixture-model",
      operation: "text",
      settingsHash: hash,
    },
  };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  assertion();
}

async function resolvesWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("TEST_OPERATION_DID_NOT_SETTLE")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function errorWithCode(code: string): Error {
  return Object.assign(new Error("fixture failure"), { code });
}

const now = "2026-07-14T00:00:00.000Z";
const fixtureClock: JobClock = {
  monotonicNow: () => 100,
  wallNowIso: () => now,
};

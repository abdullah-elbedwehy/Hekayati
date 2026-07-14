import { join } from "node:path";

import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { JobError } from "../../src/jobs/errors.js";
import { localJobRegistration } from "../../src/jobs/registrations.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import { localJobRequestSchema } from "../../src/jobs/schemas.js";
import type {
  EnqueueJobInput,
  JobFence,
  JobRegistration,
} from "../../src/jobs/types.js";
import { temporaryDirectory } from "../helpers/temp.js";

const hash = "b".repeat(64);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("durable scheduler repository", () => {
  it("rejects unknown, malformed, and invalid graph batches without partial jobs", async () => {
    const { scheduler, close } = await harness();
    const dependencyId = ulid();
    const childId = ulid();

    expect(() =>
      scheduler.enqueue({ ...input(), jobType: "unknown_fixture" }),
    ).toThrowError(expect.objectContaining({ code: "JOB_TYPE_UNKNOWN" }));
    expect(scheduler.list()).toEqual([]);

    expect(() =>
      scheduler.enqueueMany([
        input({ id: dependencyId, intentId: "schema-valid" }),
        {
          ...input({ id: childId, intentId: "schema-invalid" }),
          request: { kind: "local", payloadHash: "not-a-hash" },
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "JOB_REQUEST_SCHEMA_INVALID" }),
    );
    expect(scheduler.list()).toEqual([]);

    const invalidGraphs: Array<{
      code: string;
      jobs: EnqueueJobInput[];
    }> = [
      {
        code: "JOB_DEPENDENCY_MISSING",
        jobs: [
          input({
            id: childId,
            intentId: "missing-edge",
            dependsOn: [dependencyId],
          }),
        ],
      },
      {
        code: "JOB_DEPENDENCY_SELF",
        jobs: [
          input({ id: childId, intentId: "self-edge", dependsOn: [childId] }),
        ],
      },
      {
        code: "JOB_DEPENDENCY_DUPLICATE",
        jobs: [
          input({ id: dependencyId, intentId: "duplicate-parent" }),
          input({
            id: childId,
            intentId: "duplicate-edge",
            dependsOn: [dependencyId, dependencyId],
          }),
        ],
      },
      {
        code: "JOB_DEPENDENCY_CROSS_SCOPE",
        jobs: [
          input({ id: dependencyId, intentId: "cross-parent" }),
          input({
            id: childId,
            intentId: "cross-child",
            projectId: "01J00000000000000000000002",
            dependsOn: [dependencyId],
          }),
        ],
      },
    ];
    for (const fixture of invalidGraphs) {
      expect(() => scheduler.enqueueMany(fixture.jobs)).toThrowError(
        expect.objectContaining({ code: fixture.code }),
      );
      expect(scheduler.list()).toEqual([]);
    }
    close();
  });

  it("runs the registered metadata guard before enqueue and rolls back the whole batch", async () => {
    const validateEnqueue = vi.fn((candidate: Readonly<EnqueueJobInput>) => {
      if (candidate.intentId === "consent-revoked")
        throw new JobError("PHOTO_CONSENT_NOT_GRANTED");
    });
    const registration: JobRegistration = {
      jobType: "fixture_noop",
      requestSchema: localJobRequestSchema,
      validateEnqueue,
    };
    const { scheduler, close } = await harness([registration]);

    expect(() =>
      scheduler.enqueueMany([
        input({ id: ulid(), intentId: "metadata-valid" }),
        input({ id: ulid(), intentId: "consent-revoked" }),
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "PHOTO_CONSENT_NOT_GRANTED" }),
    );
    expect(validateEnqueue).toHaveBeenCalledTimes(2);
    expect(scheduler.list()).toEqual([]);
    close();
  });

  it("atomically validates DAGs and returns the existing duplicate intent", async () => {
    const { scheduler, close } = await harness();
    const firstId = ulid();
    const secondId = ulid();
    const [first, second] = scheduler.enqueueMany([
      input({ id: firstId, intentId: "intent-first" }),
      input({
        id: secondId,
        intentId: "intent-second",
        dependsOn: [firstId],
      }),
    ]);
    expect(first.state).toBe("queued");
    expect(second.state).toBe("blocked");
    expect(scheduler.enqueue(input({ intentId: "intent-first" })).id).toBe(
      first.id,
    );

    const cycleA = ulid();
    const cycleB = ulid();
    expect(() =>
      scheduler.enqueueMany([
        input({ id: cycleA, intentId: "cycle-a", dependsOn: [cycleB] }),
        input({ id: cycleB, intentId: "cycle-b", dependsOn: [cycleA] }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "JOB_DEPENDENCY_CYCLE" }));
    expect(scheduler.list()).toHaveLength(2);
    expect(() =>
      scheduler.enqueue(
        input({
          intentId: "intent-first",
          request: { kind: "local", payloadHash: "d".repeat(64) },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "JOB_INTENT_COLLISION" }));
    expect(scheduler.list()).toHaveLength(2);
    close();
  });

  it("uses persisted creation sequence for FIFO despite adversarial IDs", async () => {
    const { scheduler, close } = await harness();
    const first = scheduler.enqueue(
      input({ id: "01JZZZZZZZZZZZZZZZZZZZZZZZ", intentId: "fifo-first" }),
    );
    scheduler.enqueue(
      input({ id: "01J00000000000000000000000", intentId: "fifo-second" }),
    );
    const claimed = scheduler.claimNext({
      workerId: "worker",
      bootId: "boot",
      nowMonoMs: 1,
      nowWallMs: 1_000,
      leaseTtlMs: 30,
      concurrencyPerProvider: 1,
    });
    expect(claimed?.id).toBe(first.id);
    close();
  });

  it("rejects a commit after the monotonic lease deadline", async () => {
    const { scheduler, close } = await harness();
    scheduler.enqueue(providerInput("expired-commit"));
    const claimed = scheduler.claimNext({
      workerId: "worker",
      bootId: "boot",
      nowMonoMs: 10,
      nowWallMs: 1_000,
      leaseTtlMs: 30,
      concurrencyPerProvider: 1,
    });
    if (!claimed) throw new Error("EXPECTED_CLAIM");
    const owned = fence(claimed);
    scheduler.markRunning(claimed.id, owned, 11);
    expect(() =>
      scheduler.commitSuccess(claimed.id, owned, [], 40),
    ).toThrowError(expect.objectContaining({ code: "JOB_LEASE_EXPIRED" }));
    expect(scheduler.get(claimed.id)?.state).toBe("running");
    close();
  });

  it("honors provider capacity and rejects an expired same-worker claim fence", async () => {
    const { scheduler, close } = await harness();
    scheduler.enqueue(providerInput("provider-a"));
    scheduler.enqueue(providerInput("provider-b"));

    const first = scheduler.claimNext({
      workerId: "worker-1",
      bootId: "boot-1",
      nowMonoMs: 100,
      nowWallMs: 1_000,
      leaseTtlMs: 30,
      concurrencyPerProvider: 1,
    });
    expect(first?.state).toBe("claimed");
    if (!first) throw new Error("EXPECTED_FIRST_CLAIM");
    expect(
      scheduler.claimNext({
        workerId: "worker-2",
        bootId: "boot-1",
        nowMonoMs: 101,
        nowWallMs: 1_001,
        leaseTtlMs: 30,
        concurrencyPerProvider: 1,
      }),
    ).toBeNull();

    const oldFence = fence(first);
    scheduler.markRunning(first.id, oldFence, 105);
    scheduler.recoverExpiredLeases("boot-1", 131);
    const reclaimed = scheduler.claimNext({
      workerId: "worker-1",
      bootId: "boot-1",
      nowMonoMs: 132,
      nowWallMs: 1_032,
      leaseTtlMs: 30,
      concurrencyPerProvider: 1,
    });
    expect(reclaimed?.lease?.claimToken).not.toBe(oldFence.claimToken);
    expect(() => scheduler.commitSuccess(first.id, oldFence, [])).toThrowError(
      expect.objectContaining({ code: "JOB_FENCE_MISMATCH" }),
    );
    if (!reclaimed) throw new Error("EXPECTED_RECLAIM");
    const newFence = fence(reclaimed);
    scheduler.markRunning(reclaimed.id, newFence, 133);
    expect(scheduler.commitSuccess(reclaimed.id, newFence, []).state).toBe(
      "succeeded",
    );
    expect(
      scheduler.claimNext({
        workerId: "worker-2",
        bootId: "boot-1",
        nowMonoMs: 134,
        nowWallMs: 1_034,
        leaseTtlMs: 30,
        concurrencyPerProvider: 1,
      })?.id,
    ).not.toBe(first.id);
    close();
  });

  it("uses monotonic time for heartbeat and ignores wall clock changes", async () => {
    const { scheduler, close } = await harness();
    const job = scheduler.enqueue(providerInput("wall-jump"));
    const claimed = scheduler.claimNext({
      workerId: "worker",
      bootId: "boot",
      nowMonoMs: 10,
      nowWallMs: 10_000,
      leaseTtlMs: 30,
      concurrencyPerProvider: 1,
    })!;
    const claimFence = fence(claimed);
    scheduler.markRunning(job.id, claimFence, 11);
    const heartbeat = scheduler.heartbeat(job.id, claimFence, {
      nowMonoMs: 20,
      wallNowIso: "1900-01-01T00:00:00.000Z",
      leaseTtlMs: 30,
    });
    expect(heartbeat.lease?.expiresAtMono).toBe(50);
    expect(scheduler.recoverExpiredLeases("boot", 49)).toEqual([]);
    expect(scheduler.recoverExpiredLeases("boot", 51)).toEqual([job.id]);
    close();
  });
});

async function harness(
  registeredJobs: readonly JobRegistration[] = [
    localJobRegistration("fixture_noop"),
  ],
) {
  const temp = await temporaryDirectory("hekayati-jobs-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "jobs.db"));
  const scheduler = new JobScheduler(store, {
    registeredJobs,
    nowIso: () => "2026-07-14T00:00:00.000Z",
  });
  return { scheduler, close: () => store.close() };
}

function input(overrides: Partial<EnqueueJobInput> = {}): EnqueueJobInput {
  return {
    jobType: "fixture_noop",
    projectId: "01J00000000000000000000001",
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId: "intent-default",
    target: null,
    request: { kind: "local", payloadHash: hash },
    inputSnapshot: {},
    ...overrides,
  };
}

function providerInput(intentId: string): EnqueueJobInput {
  return input({
    intentId,
    target: {
      providerId: "mock",
      modelId: "mock-v1",
      operation: "image",
      settingsHash: hash,
    },
  });
}

function fence(job: ReturnType<JobScheduler["get"]>): JobFence {
  if (!job?.lease) throw new JobError("JOB_NOT_CLAIMED");
  return {
    workerId: job.lease.workerId,
    bootId: job.lease.bootId,
    claimToken: job.lease.claimToken,
    attempt: job.attempts,
  };
}

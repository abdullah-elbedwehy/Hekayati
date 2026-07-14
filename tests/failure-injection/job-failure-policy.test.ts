import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { localJobRegistration } from "../../src/jobs/registrations.js";
import { decideFailure } from "../../src/jobs/retry-policy.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import type {
  EnqueueJobInput,
  JobFence,
  JobRecord,
} from "../../src/jobs/types.js";
import {
  failureCategorySchema,
  makeFailure,
  type FailureCategory,
} from "../../src/providers/failures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const projectId = "01J00000000000000000000001";
const hash = "8".repeat(64);
const initialWallMs = Date.parse("2026-07-14T00:00:00.000Z");
const cleanups: Array<() => Promise<void>> = [];

interface PolicyFixture {
  category: FailureCategory;
  delays: number[];
  finalState: JobRecord["state"];
  finalReason: string;
}

const policyFixtures: PolicyFixture[] = [
  row("invalid_input", [], "failed", "invalid_input"),
  row("missing_reference_asset", [], "paused", "dependency"),
  row(
    "provider_unavailable",
    [30_000, 120_000, 600_000],
    "paused",
    "provider_unavailable",
  ),
  row("invalid_credentials", [], "paused", "credentials"),
  row("quota_exhausted", [], "paused", "quota"),
  row("rate_limited", [15_000, 60_000, 300_000], "paused", "retry_exhausted"),
  row("timeout", [30_000, 120_000], "paused", "retry_exhausted"),
  row(
    "network_failure",
    [10_000, 60_000, 300_000],
    "paused",
    "retry_exhausted",
  ),
  row("safety_refusal", [], "failed", "safety_refusal"),
  row("malformed_output", [5_000, 30_000], "paused", "retry_exhausted"),
  row("output_validation_failed", [5_000, 30_000], "paused", "retry_exhausted"),
  row("media_decode_failure", [5_000], "paused", "retry_exhausted"),
  row("disk_write_failure", [], "paused", "storage"),
  row("insufficient_disk_space", [], "paused", "storage"),
  row("user_canceled", [], "canceled", "user_canceled"),
  row("stale_dependency", [], "failed", "stale_dependency"),
  row("unknown", [], "paused", "operator"),
];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("canonical job failure policy", () => {
  it("covers every normalized category exactly once", () => {
    expect(
      [
        ...policyFixtures.map((fixture) => fixture.category),
        "database_unavailable",
      ].sort(),
    ).toEqual([...failureCategorySchema.options].sort());
  });

  for (const fixture of policyFixtures) {
    it(`applies ${fixture.category} retries and disposition without mutating intent`, async () => {
      const { scheduler, close } = await harness();
      const original = scheduler.enqueue(input(fixture.category));
      let nowMonoMs = 100;
      let nowWallMs = initialWallMs;

      for (const [retryIndex, expectedDelay] of fixture.delays.entries()) {
        const running = claimAndRun(scheduler, nowMonoMs, nowWallMs);
        const failedAtMono = nowMonoMs + 2;
        const failedAtWall = nowWallMs + 2;
        const scheduled = scheduler.recordFailure(
          running.id,
          fence(running),
          makeFailure(fixture.category, {
            providerDetail: "PRIVATE_PROVIDER_BODY_CANARY",
          }),
          {
            nowMonoMs: failedAtMono,
            wallNowIso: new Date(failedAtWall).toISOString(),
          },
        );
        expect(scheduled).toMatchObject({
          id: original.id,
          state: "queued",
          stateReason: "retry_delay",
          autoRetryIndex: retryIndex + 1,
          idempotencyKey: original.idempotencyKey,
          requestHash: original.requestHash,
          request: original.request,
          target: original.target,
          inputSnapshot: original.inputSnapshot,
          retrySchedule: { delayMs: expectedDelay },
        });
        expect(JSON.stringify(scheduled)).not.toContain(
          "PRIVATE_PROVIDER_BODY_CANARY",
        );
        expect(
          scheduler.claimNext(
            claimOptions(failedAtMono + expectedDelay - 1, failedAtWall),
          ),
        ).toBeNull();
        nowMonoMs = failedAtMono + expectedDelay;
        nowWallMs = failedAtWall + expectedDelay;
      }

      const running = claimAndRun(scheduler, nowMonoMs, nowWallMs);
      const terminal = scheduler.recordFailure(
        running.id,
        fence(running),
        makeFailure(fixture.category, {
          providerDetail: "PRIVATE_PROVIDER_BODY_CANARY",
        }),
        {
          nowMonoMs: nowMonoMs + 2,
          wallNowIso: new Date(nowWallMs + 2).toISOString(),
        },
      );
      expect(terminal).toMatchObject({
        id: original.id,
        state: fixture.finalState,
        stateReason: fixture.finalReason,
        idempotencyKey: original.idempotencyKey,
        requestHash: original.requestHash,
        request: original.request,
        target: original.target,
        inputSnapshot: original.inputSnapshot,
      });
      expect(terminal.attempts).toBe(fixture.delays.length + 1);
      expect(scheduler.events(original.id).at(-1)?.noteCode).toBe(
        fixture.category,
      );
      expect(JSON.stringify(scheduler.list())).not.toContain(
        "PRIVATE_PROVIDER_BODY_CANARY",
      );
      close();
    });
  }

  it("bounds Retry-After to one day and honors it for only three retries", () => {
    expect(decideFailure("rate_limited", 0, 7_000)).toEqual({
      action: "retry",
      delayMs: 7_000,
    });
    expect(decideFailure("rate_limited", 2, 99_000_000)).toEqual({
      action: "retry",
      delayMs: 86_400_000,
    });
    expect(decideFailure("rate_limited", 3, 7_000)).toEqual({
      action: "pause",
      reason: "retry_exhausted",
    });
  });

  it("halts on database loss without claiming persistence succeeded", async () => {
    const { scheduler, close } = await harness();
    const original = scheduler.enqueue(input("database_unavailable"));
    const running = claimAndRun(scheduler, 100, initialWallMs);
    expect(() =>
      scheduler.recordFailure(
        running.id,
        fence(running),
        makeFailure("database_unavailable"),
        {
          nowMonoMs: 102,
          wallNowIso: new Date(initialWallMs + 2).toISOString(),
        },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "JOB_DATABASE_UNAVAILABLE" }),
    );
    expect(scheduler.get(original.id)).toMatchObject({
      state: "running",
      failure: null,
    });
    close();
  });

  it("keeps cancellation terminal while a delayed retry is pending", async () => {
    const { scheduler, close } = await harness();
    const original = scheduler.enqueue(input("cancel-delay"));
    const running = claimAndRun(scheduler, 100, initialWallMs);
    const delayed = scheduler.recordFailure(
      running.id,
      fence(running),
      makeFailure("network_failure"),
      {
        nowMonoMs: 102,
        wallNowIso: new Date(initialWallMs + 2).toISOString(),
      },
    );
    const canceled = scheduler.cancel(original.id, {
      expectedRevision: delayed.revision,
      expectedState: "queued",
    });
    expect(canceled).toMatchObject({
      state: "canceled",
      stateReason: "user_canceled",
    });
    expect(
      scheduler.claimNext(claimOptions(10_102, initialWallMs + 10_002)),
    ).toBeNull();
    close();
  });
});

async function harness() {
  const temp = await temporaryDirectory("hekayati-failure-policy-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "jobs.db"));
  const scheduler = new JobScheduler(store, {
    registeredJobs: [localJobRegistration("fixture_noop")],
    nowIso: () => "2026-07-14T00:00:00.000Z",
  });
  return { scheduler, close: () => store.close() };
}

function input(intentId: string): EnqueueJobInput {
  return {
    jobType: "fixture_noop",
    projectId,
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId,
    target: {
      providerId: "mock",
      modelId: "mock-fixture-v1",
      operation: "image",
      settingsHash: hash,
    },
    request: { kind: "local", payloadHash: hash },
    inputSnapshot: { projectVersion: "version-1" },
  };
}

function claimAndRun(
  scheduler: JobScheduler,
  nowMonoMs: number,
  nowWallMs: number,
): JobRecord {
  const claimed = scheduler.claimNext(claimOptions(nowMonoMs, nowWallMs));
  if (!claimed) throw new Error("EXPECTED_FAILURE_FIXTURE_CLAIM");
  return scheduler.markRunning(claimed.id, fence(claimed), nowMonoMs + 1);
}

function claimOptions(nowMonoMs: number, nowWallMs: number) {
  return {
    workerId: "failure-worker",
    bootId: "failure-boot",
    nowMonoMs,
    nowWallMs,
    leaseTtlMs: 86_500_000,
    concurrencyPerProvider: 1,
  };
}

function fence(job: JobRecord): JobFence {
  if (!job.lease) throw new Error("EXPECTED_FAILURE_FIXTURE_FENCE");
  return {
    workerId: job.lease.workerId,
    bootId: job.lease.bootId,
    claimToken: job.lease.claimToken,
    attempt: job.attempts,
  };
}

function row(
  category: FailureCategory,
  delays: number[],
  finalState: JobRecord["state"],
  finalReason: string,
): PolicyFixture {
  return { category, delays, finalState, finalReason };
}

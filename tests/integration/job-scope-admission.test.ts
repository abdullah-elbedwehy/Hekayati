import { join } from "node:path";

import { ulid } from "ulid";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CapturedAttemptLedger } from "../../src/domain/portability/operation-ledgers.js";
import {
  PortabilityLedgerRepository,
  PortabilityScopeLockRepository,
} from "../../src/domain/portability/repositories.js";
import { ScopeAdmissionService } from "../../src/domain/portability/scope-locks.js";
import type {
  PortabilityScopeLock,
  PortabilityScopeLockMode,
} from "../../src/domain/portability/schemas.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { JobError } from "../../src/jobs/errors.js";
import { localJobRegistration } from "../../src/jobs/registrations.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import {
  localJobRequestSchema,
  type JobRecord,
} from "../../src/jobs/schemas.js";
import type {
  EnqueueJobInput,
  JobFence,
  RegisteredJobDefinition,
  StorageResumeImpact,
} from "../../src/jobs/types.js";
import { JobWorkerPool } from "../../src/jobs/worker-pool.js";
import { makeFailure } from "../../src/providers/failures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const projectA = "01J00000000000000000000001";
const projectB = "01J00000000000000000000002";
const now = "2026-07-16T00:00:00.000Z";
const hash = "a".repeat(64);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("scheduler portability scope admission", () => {
  it("allows only captured attempts to drain while blocking enqueue, promotion, and claim", async () => {
    const fixture = await harness();
    const source = fixture.scheduler.enqueue(
      input("captured-source", projectA, { priority: 5 }),
    );
    const successor = fixture.scheduler.enqueue(
      input("locked-successor", projectA, {
        dependsOn: [source.id],
        priority: 4,
      }),
    );
    const lockedQueued = fixture.scheduler.enqueue(
      input("locked-queued", projectA, { priority: 3 }),
    );
    const unrelated = fixture.scheduler.enqueue(
      input("unrelated", projectB, { priority: 1 }),
    );
    const claimed = claim(fixture.scheduler, 10);
    expect(claimed.id).toBe(source.id);
    fixture.acquire(projectA, [
      { jobId: claimed.id, attempt: claimed.attempts },
    ]);

    expect(
      fixture.scheduler.enqueue(
        input("captured-source", projectA, { priority: 5 }),
      ).id,
    ).toBe(source.id);
    expect(() =>
      fixture.scheduler.enqueue(input("new-locked", projectA)),
    ).toThrow(expect.objectContaining({ code: "JOB_SCOPE_ADMISSION_DENIED" }));

    const running = fixture.scheduler.markRunning(
      claimed.id,
      fence(claimed),
      11,
    );
    fixture.scheduler.commitSuccess(running.id, fence(running), [], 12);
    expect(fixture.scheduler.get(successor.id)?.state).toBe("blocked");

    const next = claim(fixture.scheduler, 20);
    expect(next.id).toBe(unrelated.id);
    expect(fixture.scheduler.get(lockedQueued.id)?.state).toBe("queued");
    fixture.close();
  });

  it("keeps captured expired attempts active while recovering unrelated scopes", async () => {
    const fixture = await harness();
    const capturedInput = fixture.scheduler.enqueue(
      input("captured-expired", projectA, { priority: 5 }),
    );
    const unrelatedInput = fixture.scheduler.enqueue(
      input("unrelated-expired", projectB, { priority: 4 }),
    );
    const capturedClaim = claim(fixture.scheduler, 10);
    expect(capturedClaim.id).toBe(capturedInput.id);
    const capturedRunning = fixture.scheduler.markRunning(
      capturedClaim.id,
      fence(capturedClaim),
      11,
    );
    const unrelatedClaim = claim(fixture.scheduler, 12);
    expect(unrelatedClaim.id).toBe(unrelatedInput.id);
    const unrelatedRunning = fixture.scheduler.markRunning(
      unrelatedClaim.id,
      fence(unrelatedClaim),
      13,
    );
    fixture.acquire(projectA, [
      { jobId: capturedRunning.id, attempt: capturedRunning.attempts },
    ]);

    expect(
      fixture.scheduler.recoverExpiredLeases("replacement-boot", 20),
    ).toEqual([unrelatedRunning.id]);
    expect(fixture.scheduler.get(capturedRunning.id)).toMatchObject({
      state: "running",
      attempts: capturedRunning.attempts,
      lease: capturedRunning.lease,
    });
    expect(fixture.scheduler.get(unrelatedRunning.id)).toMatchObject({
      state: "queued",
      stateReason: "recovered",
      lease: null,
    });
    expect(
      fixture.scheduler
        .events(capturedRunning.id)
        .filter((event) => event.kind === "recovered"),
    ).toEqual([]);
    fixture.close();
  });

  it("rejects shutdown requeue for a captured drain attempt without blocking an unrelated scope", async () => {
    const fixture = await harness();
    const capturedInput = fixture.scheduler.enqueue(
      input("captured-shutdown", projectA, { priority: 5 }),
    );
    const unrelatedInput = fixture.scheduler.enqueue(
      input("unrelated-shutdown", projectB, { priority: 4 }),
    );
    const capturedClaim = claim(fixture.scheduler, 10);
    expect(capturedClaim.id).toBe(capturedInput.id);
    const capturedRunning = fixture.scheduler.markRunning(
      capturedClaim.id,
      fence(capturedClaim),
      11,
    );
    const unrelatedClaim = claim(fixture.scheduler, 12);
    expect(unrelatedClaim.id).toBe(unrelatedInput.id);
    const unrelatedRunning = fixture.scheduler.markRunning(
      unrelatedClaim.id,
      fence(unrelatedClaim),
      13,
    );
    fixture.acquire(projectA, [
      { jobId: capturedRunning.id, attempt: capturedRunning.attempts },
    ]);

    expect(() =>
      fixture.scheduler.requeueOwned(
        capturedRunning.id,
        fence(capturedRunning),
        14,
      ),
    ).toThrow(expect.objectContaining({ code: "JOB_SCOPE_ADMISSION_DENIED" }));
    expect(fixture.scheduler.get(capturedRunning.id)).toMatchObject({
      state: "running",
      lease: capturedRunning.lease,
    });
    expect(
      fixture.scheduler.requeueOwned(
        unrelatedRunning.id,
        fence(unrelatedRunning),
        14,
      ),
    ).toMatchObject({
      state: "queued",
      stateReason: "shutdown",
      lease: null,
    });
    fixture.close();
  });

  it("rejects resume, retry, and project resume atomically under a scope lock", async () => {
    const fixture = await harness();
    const first = fixture.scheduler.enqueue(input("paused-one", projectA));
    const second = fixture.scheduler.enqueue(input("paused-two", projectA));
    fixture.scheduler.pause(first.id, {
      expectedRevision: first.revision,
      expectedState: "queued",
    });
    fixture.scheduler.pause(second.id, {
      expectedRevision: second.revision,
      expectedState: "queued",
    });
    const retryInput = fixture.scheduler.enqueue(
      input("retry", projectA, { priority: 5 }),
    );
    const claimed = claim(fixture.scheduler, 10);
    expect(claimed.id).toBe(retryInput.id);
    const running = fixture.scheduler.markRunning(
      claimed.id,
      fence(claimed),
      11,
    );
    const retryable = fixture.scheduler.recordFailure(
      running.id,
      fence(running),
      makeFailure("missing_reference_asset"),
      { nowMonoMs: 12, wallNowIso: now },
    );
    fixture.acquire(projectA);

    const paused = fixture.scheduler.get(first.id)!;
    expect(() =>
      fixture.scheduler.resume(paused.id, {
        expectedRevision: paused.revision,
        expectedState: "paused",
      }),
    ).toThrow(expect.objectContaining({ code: "JOB_SCOPE_ADMISSION_DENIED" }));
    expect(() =>
      fixture.scheduler.retry(retryable.id, {
        expectedRevision: retryable.revision,
        expectedState: "paused",
      }),
    ).toThrow(expect.objectContaining({ code: "JOB_SCOPE_ADMISSION_DENIED" }));
    expect(() => fixture.scheduler.resumeProject(projectA)).toThrow(
      expect.objectContaining({ code: "JOB_SCOPE_ADMISSION_DENIED" }),
    );
    expect(fixture.scheduler.get(first.id)?.state).toBe("paused");
    expect(fixture.scheduler.get(second.id)?.state).toBe("paused");
    expect(fixture.scheduler.get(retryable.id)).toMatchObject({
      state: "paused",
      stateReason: "dependency",
    });
    fixture.close();
  });

  it("keeps storage incident restore atomic when one affected project is locked", async () => {
    const fixture = await harness();
    const source = fixture.scheduler.enqueue(
      input("storage-source", projectA, { priority: 5 }),
    );
    const sibling = fixture.scheduler.enqueue(
      input("storage-sibling", projectB),
    );
    const claimed = claim(fixture.scheduler, 10);
    expect(claimed.id).toBe(source.id);
    const running = fixture.scheduler.markRunning(
      claimed.id,
      fence(claimed),
      11,
    );
    fixture.scheduler.recordFailure(
      running.id,
      fence(running),
      makeFailure("insufficient_disk_space"),
      { nowMonoMs: 12, wallNowIso: now },
    );
    fixture.acquire(projectA);
    const probe = vi.fn(() => true);
    const impact = fixture.scheduler.storageResumeImpact();

    expect(() =>
      fixture.scheduler.resumeStorage(storageConfirmation(impact), probe),
    ).toThrow(expect.objectContaining({ code: "JOB_SCOPE_ADMISSION_DENIED" }));
    expect(probe).toHaveBeenCalledOnce();
    expect(fixture.scheduler.storageStatus().active).toBe(true);
    expect(fixture.scheduler.get(source.id)).toMatchObject({
      state: "paused",
      stateReason: "storage",
    });
    expect(fixture.scheduler.get(sibling.id)).toMatchObject({
      state: "paused",
      stateReason: "storage",
    });
    fixture.close();
  });

  it("keeps credential and quota incident restore closed for locked jobs", async () => {
    await assertProviderRestoreDenied("invalid_credentials");
    await assertProviderRestoreDenied("quota_exhausted");
  });

  it("rejects uncaptured running transitions and all snapshot or exclusive commits", async () => {
    const fixture = await harness();
    const uncaptured = fixture.scheduler.enqueue(input("uncaptured", projectA));
    const uncapturedClaim = claim(fixture.scheduler, 10);
    expect(uncapturedClaim.id).toBe(uncaptured.id);
    fixture.acquire(projectA);
    expect(() =>
      fixture.scheduler.markRunning(uncaptured.id, fence(uncapturedClaim), 11),
    ).toThrow(expect.objectContaining({ code: "JOB_SCOPE_ADMISSION_DENIED" }));
    fixture.close();

    const snapshotFixture = await harness();
    const snapshotJob = snapshotFixture.scheduler.enqueue(
      input("snapshot", projectA),
    );
    const snapshotClaim = claim(snapshotFixture.scheduler, 20);
    expect(snapshotClaim.id).toBe(snapshotJob.id);
    const snapshotLock = snapshotFixture.acquire(projectA, [
      { jobId: snapshotClaim.id, attempt: snapshotClaim.attempts },
    ]);
    const snapshotRunning = snapshotFixture.scheduler.markRunning(
      snapshotClaim.id,
      fence(snapshotClaim),
      21,
    );
    snapshotFixture.transition(snapshotLock, "snapshot");
    const snapshotCommit = vi.fn(() => ({ resultRefs: ["forbidden"] }));
    expect(() =>
      snapshotFixture.scheduler.commitWith(
        snapshotRunning.id,
        fence(snapshotRunning),
        22,
        snapshotCommit,
      ),
    ).toThrow(expect.objectContaining({ code: "JOB_SCOPE_ADMISSION_DENIED" }));
    expect(snapshotCommit).not.toHaveBeenCalled();
    expect(() =>
      snapshotFixture.scheduler.recordProgress(
        snapshotRunning.id,
        fence(snapshotRunning),
        { percent: 50, noteCode: "late", nowMonoMs: 22, wallNowIso: now },
      ),
    ).toThrow(expect.objectContaining({ code: "JOB_SCOPE_ADMISSION_DENIED" }));
    snapshotFixture.scheduler.recordCommitRejected(
      snapshotRunning.id,
      fence(snapshotRunning),
    );
    expect(
      snapshotFixture.scheduler.events(snapshotRunning.id).at(-1),
    ).toMatchObject({
      kind: "commit_rejected",
      reason: "late_commit",
    });
    snapshotFixture.close();

    const exclusiveFixture = await harness();
    const exclusiveJob = exclusiveFixture.scheduler.enqueue(
      input("exclusive", projectB),
    );
    const exclusiveClaim = claim(exclusiveFixture.scheduler, 30);
    const exclusiveRunning = exclusiveFixture.scheduler.markRunning(
      exclusiveClaim.id,
      fence(exclusiveClaim),
      31,
    );
    exclusiveFixture.acquire(projectB, [], "import_commit");
    const exclusiveCommit = vi.fn(() => ({ resultRefs: ["forbidden"] }));
    expect(() =>
      exclusiveFixture.scheduler.commitWith(
        exclusiveRunning.id,
        fence(exclusiveRunning),
        32,
        exclusiveCommit,
      ),
    ).toThrow(expect.objectContaining({ code: "JOB_SCOPE_ADMISSION_DENIED" }));
    expect(exclusiveCommit).not.toHaveBeenCalled();
    expect(exclusiveFixture.scheduler.get(exclusiveJob.id)?.state).toBe(
      "running",
    );
    exclusiveFixture.close();
  });

  it("discards a worker result whose commit loses the scope race", async () => {
    const fixture = await harness();
    let heldLock: PortabilityScopeLock | null = null;
    const commit = vi.fn(() => ({ resultRefs: ["forbidden"] }));
    const discard = vi.fn();
    const definition: RegisteredJobDefinition = {
      jobType: "worker_fixture",
      requestSchema: localJobRequestSchema,
      validateEnqueue: () => undefined,
      prepare: async (job) => {
        heldLock = fixture.acquire(projectA, [
          { jobId: job.id, attempt: job.attempts },
        ]);
        return {};
      },
      execute: async () => {
        if (!heldLock) throw new JobError("EXPECTED_SCOPE_LOCK");
        fixture.transition(heldLock, "snapshot");
        return { ok: true, value: "late-result" };
      },
      commit,
      discard,
    };
    const scheduler = fixture.restart([definition]);
    const job = scheduler.enqueue(
      input("worker-late", projectA, { jobType: definition.jobType }),
    );
    let mono = 100;
    const workers = new JobWorkerPool(scheduler, [definition], {
      bootId: "boot",
      workerId: "worker",
      clock: {
        monotonicNow: () => (mono += 1),
        wallNowIso: () => now,
      },
      concurrencyPerProvider: 1,
      leaseTtlMs: 1_000,
      heartbeatIntervalMs: 100,
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      maxWorkers: 1,
    });

    await expect(workers.runOne()).resolves.toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith("late-result");
    expect(scheduler.get(job.id)?.state).toBe("running");
    expect(scheduler.events(job.id).at(-1)).toMatchObject({
      kind: "commit_rejected",
      reason: "late_commit",
    });
    fixture.close();
  });
});

async function assertProviderRestoreDenied(
  category: "invalid_credentials" | "quota_exhausted",
): Promise<void> {
  const fixture = await harness();
  const source = fixture.scheduler.enqueue(
    input(`${category}-source`, projectA, { priority: 5, withTarget: true }),
  );
  const sibling = fixture.scheduler.enqueue(
    input(`${category}-sibling`, projectB, { withTarget: true }),
  );
  const claimed = claim(fixture.scheduler, 10);
  expect(claimed.id).toBe(source.id);
  const running = fixture.scheduler.markRunning(claimed.id, fence(claimed), 11);
  fixture.scheduler.recordFailure(
    running.id,
    fence(running),
    makeFailure(category),
    { nowMonoMs: 12, wallNowIso: now },
  );
  fixture.acquire(projectA);

  if (category === "invalid_credentials") {
    const incident = fixture.scheduler.credentialIncidents()[0];
    const impact = fixture.scheduler.credentialResumeImpact(incident.id);
    await expect(
      fixture.scheduler.resumeCredentials(
        incident.id,
        { expectedRevision: incident.revision, impactHash: impact.impactHash },
        { forceCheckExact: async () => true },
      ),
    ).rejects.toMatchObject({ code: "JOB_SCOPE_ADMISSION_DENIED" });
    expect(fixture.scheduler.credentialIncidents()[0].status).toBe("open");
    expect(fixture.scheduler.credentialAuditEvents()).toEqual([]);
  } else {
    const incident = fixture.scheduler.quotaIncidents()[0];
    const impact = fixture.scheduler.quotaResumeImpact(incident.id);
    await expect(
      fixture.scheduler.resumeQuota(
        incident.id,
        {
          actionId: ulid(),
          expectedRevision: incident.revision,
          impactHash: impact.impactHash,
          confirmedAffectedCount: impact.affectedCount,
        },
        { forceCheckExact: async () => true },
      ),
    ).rejects.toMatchObject({ code: "JOB_SCOPE_ADMISSION_DENIED" });
    expect(fixture.scheduler.quotaIncidents()[0].status).toBe("open");
    expect(fixture.scheduler.auditEvents()).toEqual([]);
  }
  expect(fixture.scheduler.get(source.id)?.state).toBe("paused");
  expect(fixture.scheduler.get(sibling.id)?.state).toBe("paused");
  fixture.close();
}

async function harness() {
  const directory = await temporaryDirectory("hekayati-job-admission-");
  const store = new DocumentStore(join(directory.path, "jobs.db"));
  const ledgerRepository = new PortabilityLedgerRepository(store);
  const lockRepository = new PortabilityScopeLockRepository(store);
  const ledgers = new CapturedAttemptLedger(store, ledgerRepository, {
    nowIso: () => now,
  });
  const admission = new ScopeAdmissionService(
    store,
    lockRepository,
    ledgerRepository,
    { nowIso: () => now },
  );
  const makeScheduler = (
    registrations: readonly RegisteredJobDefinition[] = [],
  ) =>
    new JobScheduler(store, {
      registeredJobs:
        registrations.length > 0
          ? registrations
          : [localJobRegistration("fixture_noop")],
      nowIso: () => now,
    });
  const scheduler = makeScheduler();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    store.close();
  };
  cleanups.push(async () => {
    close();
    await directory.cleanup();
  });
  return {
    scheduler,
    restart: makeScheduler,
    close,
    acquire(
      projectId: string,
      attempts: readonly { jobId: string; attempt: number }[] = [],
      mode: PortabilityScopeLockMode = "export_snapshot",
    ): PortabilityScopeLock {
      const operationId = ulid();
      const root = ledgers.write(operationId, attempts);
      return admission.acquire({
        operationId,
        scope: {
          kind: "project",
          id: projectId,
          projectId,
          customerId: projectId,
        },
        mode,
        phase: mode === "import_commit" ? "exclusive" : "draining",
        capturedAttemptLedgerRoot: root.rootHash,
        capturedAttemptCount: root.entryCount,
      });
    },
    transition(
      lock: PortabilityScopeLock,
      phase: "snapshot" | "exclusive",
    ): PortabilityScopeLock {
      return admission.transition(
        lock.id,
        lock.operationId,
        lock.revision,
        phase,
      );
    },
  };
}

function input(
  intentId: string,
  projectId: string,
  options: {
    jobType?: string;
    priority?: number;
    dependsOn?: string[];
    withTarget?: boolean;
  } = {},
): EnqueueJobInput {
  return {
    jobType: options.jobType ?? "fixture_noop",
    projectId,
    standaloneScopeId: null,
    dependsOn: options.dependsOn ?? [],
    priority: options.priority ?? 2,
    intentId,
    target: options.withTarget
      ? {
          providerId: "mock",
          modelId: "mock-v1",
          operation: "image",
          settingsHash: hash,
        }
      : null,
    request: { kind: "local", payloadHash: hash },
    inputSnapshot: {},
  };
}

function claim(scheduler: JobScheduler, nowMonoMs: number): JobRecord {
  const job = scheduler.claimNext({
    workerId: "worker",
    bootId: "boot",
    nowMonoMs,
    nowWallMs: Date.parse(now),
    leaseTtlMs: 1_000,
    concurrencyPerProvider: 4,
  });
  if (!job) throw new JobError("EXPECTED_JOB_CLAIM");
  return job;
}

function fence(job: JobRecord): JobFence {
  if (!job.lease) throw new JobError("JOB_NOT_CLAIMED");
  return {
    workerId: job.lease.workerId,
    bootId: job.lease.bootId,
    claimToken: job.lease.claimToken,
    attempt: job.attempts,
  };
}

function storageConfirmation(impact: StorageResumeImpact) {
  return {
    expectedRevision: impact.expectedRevision,
    impactHash: impact.impactHash,
    confirmedAffectedCount: impact.affectedCount,
    confirmed: true as const,
  };
}

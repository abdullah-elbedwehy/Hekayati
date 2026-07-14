import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { JobControls } from "../../src/jobs/controls.js";
import { JobHistory } from "../../src/jobs/history.js";
import { JobRepository } from "../../src/jobs/repository.js";
import { localJobRegistration } from "../../src/jobs/registrations.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import type {
  EnqueueJobInput,
  JobFence,
  StorageResumeImpact,
} from "../../src/jobs/types.js";
import { makeFailure } from "../../src/providers/failures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const hash = "d".repeat(64);
const projectId = "01J00000000000000000000001";
const now = "2026-07-14T00:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("durable storage incident resume", () => {
  it("persists a failed probe and restores only incident-owned jobs", async () => {
    const fixture = await harness();
    fixture.scheduler.enqueue(input("running"));
    fixture.scheduler.enqueue(input("queued"));
    const claimed = claim(fixture.scheduler);
    const running = fixture.scheduler.markRunning(
      claimed.id,
      fence(claimed),
      2,
    );
    fixture.scheduler.recordFailure(
      running.id,
      fence(running),
      makeFailure("insufficient_disk_space"),
      { nowMonoMs: 3, wallNowIso: now },
    );

    const first = fixture.controls.storageResumeImpact();
    expect(first.affectedCount).toBe(2);
    expect(fixture.controls.storageStatus()).toMatchObject({
      active: true,
      incidentId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      ownedJobIds: expect.arrayContaining([
        running.id,
        expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      ]),
    });
    expect(() =>
      fixture.controls.resumeStorage(confirmation(first), () => false),
    ).toThrow(expect.objectContaining({ code: "JOB_STORAGE_PROBE_FAILED" }));

    const restarted = fixture.restartControls();
    expect(restarted.storageStatus()).toMatchObject({
      active: true,
      revision: first.expectedRevision + 1,
      lastProbeAt: now,
      lastProbeStatus: "failed",
    });
    let staleProbeCalls = 0;
    expect(() =>
      restarted.resumeStorage(confirmation(first), () => {
        staleProbeCalls += 1;
        return true;
      }),
    ).toThrow(expect.objectContaining({ code: "JOB_REVISION_CONFLICT" }));
    expect(staleProbeCalls).toBe(0);

    const unrelated = fixture.scheduler.enqueue(input("unrelated"));
    fixture.forceUnownedStoragePause(unrelated.id);
    const fresh = restarted.storageResumeImpact();
    expect(fresh.affectedCount).toBe(2);
    expect(
      restarted.resumeStorage(confirmation(fresh), () => true),
    ).toHaveLength(2);
    expect(fixture.scheduler.get(unrelated.id)).toMatchObject({
      state: "paused",
      stateReason: "storage",
    });
    expect(restarted.storageStatus()).toMatchObject({
      active: false,
      incidentId: null,
      ownedJobIds: [],
      lastProbeStatus: "succeeded",
    });
  });
});

async function harness() {
  const directory = await temporaryDirectory("hekayati-storage-resume-");
  const store = new DocumentStore(join(directory.path, "jobs.db"));
  const scheduler = new JobScheduler(store, {
    registeredJobs: [localJobRegistration("fixture_noop")],
    nowIso: () => now,
  });
  const makeControls = () =>
    new JobControls(
      new JobRepository(store),
      new JobHistory(store, () => now),
      () => now,
      () => undefined,
    );
  const repository = new JobRepository(store);
  cleanups.push(async () => {
    store.close();
    await directory.cleanup();
  });
  return {
    scheduler,
    controls: makeControls(),
    restartControls: makeControls,
    forceUnownedStoragePause(id: string) {
      const job = repository.get(id)!;
      repository.update(job, {
        ...job,
        state: "paused",
        stateReason: "storage",
        resumeState: job.state,
        updatedAt: now,
        revision: job.revision + 1,
      });
    },
  };
}

function confirmation(impact: StorageResumeImpact) {
  return {
    expectedRevision: impact.expectedRevision,
    impactHash: impact.impactHash,
    confirmedAffectedCount: impact.affectedCount,
    confirmed: true as const,
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

function claim(scheduler: JobScheduler) {
  return scheduler.claimNext({
    workerId: "worker-1",
    bootId: "boot-1",
    nowMonoMs: 1,
    nowWallMs: Date.parse(now),
    leaseTtlMs: 30_000,
    concurrencyPerProvider: 2,
  })!;
}

function fence(job: ReturnType<typeof claim>): JobFence {
  return {
    workerId: job.lease!.workerId,
    bootId: job.lease!.bootId,
    claimToken: job.lease!.claimToken,
    attempt: job.attempts,
  };
}

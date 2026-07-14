import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { JobError } from "../../src/jobs/errors.js";
import { localJobRegistration } from "../../src/jobs/registrations.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import type {
  EnqueueJobInput,
  JobFence,
  JobRecord,
  QuotaAvailabilityPort,
} from "../../src/jobs/types.js";
import { makeFailure } from "../../src/providers/failures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const projectA = "01J00000000000000000000001";
const projectB = "01J00000000000000000000002";
const payloadHash = "a".repeat(64);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("persisted quota availability resume", () => {
  it("force-checks every exact original target before restoring incident-owned work", async () => {
    const { scheduler, store, close } = await harness();
    const source = scheduler.enqueue(
      providerInput("source", projectA, target("model-a", "a")),
    );
    const sibling = scheduler.enqueue(
      providerInput("sibling", projectB, target("model-b", "b")),
    );
    const manuallyPaused = scheduler.enqueue(
      providerInput("operator", projectA, target("model-a", "a")),
    );
    scheduler.pause(manuallyPaused.id, {
      expectedRevision: manuallyPaused.revision,
      expectedState: "queued",
    });
    exhaustQuota(scheduler, source.id);
    const addedDuringIncident = scheduler.enqueue(
      providerInput("later", projectA, target("model-c", "c")),
    );
    expect(addedDuringIncident).toMatchObject({
      state: "paused",
      stateReason: "quota",
    });

    const restarted = new JobScheduler(store, options());
    const [incident] = restarted.quotaIncidents();
    expect(incident).toMatchObject({
      status: "open",
      ownedJobIds: [source.id, sibling.id, addedDuringIncident.id],
    });
    const checked: JobRecord["target"][] = [];
    const availability: QuotaAvailabilityPort = {
      forceCheckExact: async (exactTarget) => {
        checked.push(exactTarget);
        return true;
      },
    };

    const confirmation = resumeInput(
      restarted,
      incident.id,
      incident.revision,
      "resume-success",
    );
    const restored = await restarted.resumeQuota(
      incident.id,
      confirmation,
      availability,
    );

    expect(checked).toEqual([
      target("model-a", "a"),
      target("model-b", "b"),
      target("model-c", "c"),
    ]);
    expect(restored.map((job) => job.id)).toEqual([
      source.id,
      sibling.id,
      addedDuringIncident.id,
    ]);
    expect(restored.every((job) => job.state === "queued")).toBe(true);
    expect(restored.map((job) => job.target)).toEqual([
      target("model-a", "a"),
      target("model-b", "b"),
      target("model-c", "c"),
    ]);
    expect(restarted.get(manuallyPaused.id)).toMatchObject({
      state: "paused",
      stateReason: "operator",
      target: target("model-a", "a"),
    });
    expect(restarted.quotaIncidents()[0]).toMatchObject({ status: "resolved" });
    expect(restarted.auditEvents().at(-1)).toMatchObject({
      incidentId: incident.id,
      projectId: null,
      standaloneScopeId: null,
      decision: "resume",
      affectedJobIds: [source.id, sibling.id, addedDuringIncident.id],
      successorJobIds: [],
    });
    expect(
      restarted.enqueue(
        providerInput("after-resume", projectA, target("model-a", "a")),
      ).state,
    ).toBe("queued");
    const afterRestart = new JobScheduler(store, options());
    const replayed = await afterRestart.resumeQuota(incident.id, confirmation, {
      forceCheckExact: async () => {
        throw new Error("replay must not probe");
      },
    });
    expect(replayed.map((job) => job.id)).toEqual(
      restored.map((job) => job.id),
    );
    expect(afterRestart.auditEvents()).toHaveLength(1);
    close();
  });

  it("leaves jobs, incident, and audit untouched when any exact target is unavailable", async () => {
    const { scheduler, close } = await harness();
    const source = scheduler.enqueue(
      providerInput("source", projectA, target("model-a", "a")),
    );
    scheduler.enqueue(
      providerInput("sibling", projectB, target("model-b", "b")),
    );
    exhaustQuota(scheduler, source.id);
    const [incident] = scheduler.quotaIncidents();
    const before = durableQuotaSnapshot(scheduler);
    const forceCheckExact = vi.fn(
      async (exactTarget: NonNullable<JobRecord["target"]>) =>
        exactTarget.modelId !== "model-b",
    );

    await expect(
      scheduler.resumeQuota(
        incident.id,
        resumeInput(
          scheduler,
          incident.id,
          incident.revision,
          "resume-unavailable",
        ),
        { forceCheckExact },
      ),
    ).rejects.toMatchObject({ code: "JOB_QUOTA_TARGET_UNAVAILABLE" });

    expect(forceCheckExact).toHaveBeenCalledTimes(2);
    expect(durableQuotaSnapshot(scheduler)).toEqual(before);

    await expect(
      scheduler.resumeQuota(
        incident.id,
        resumeInput(
          scheduler,
          incident.id,
          incident.revision,
          "resume-check-error",
        ),
        {
          forceCheckExact: async () => {
            throw new Error("unsafe provider detail");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "JOB_QUOTA_AVAILABILITY_CHECK_FAILED" });
    expect(durableQuotaSnapshot(scheduler)).toEqual(before);
    close();
  });

  it("rejects a stale incident revision before making an availability call", async () => {
    const { scheduler, close } = await harness();
    const source = scheduler.enqueue(
      providerInput("source", projectA, target("model-a", "a")),
    );
    exhaustQuota(scheduler, source.id);
    const [incident] = scheduler.quotaIncidents();
    const forceCheckExact = vi.fn(async () => true);

    await expect(
      scheduler.resumeQuota(
        incident.id,
        {
          actionId: "resume-stale",
          expectedRevision: incident.revision + 1,
          impactHash: "f".repeat(64),
          confirmedAffectedCount: 1,
        },
        { forceCheckExact },
      ),
    ).rejects.toMatchObject({ code: "JOB_REVISION_CONFLICT" });
    expect(forceCheckExact).not.toHaveBeenCalled();
    expect(scheduler.quotaIncidents()[0]?.status).toBe("open");
    close();
  });
});

function resumeInput(
  scheduler: JobScheduler,
  incidentId: string,
  expectedRevision: number,
  actionId: string,
) {
  const impact = scheduler.quotaResumeImpact(incidentId);
  return {
    actionId,
    expectedRevision,
    impactHash: impact.impactHash,
    confirmedAffectedCount: impact.affectedCount,
  };
}

async function harness() {
  const temp = await temporaryDirectory("hekayati-job-quota-resume-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "jobs.db"));
  const scheduler = new JobScheduler(store, options());
  return { scheduler, store, close: () => store.close() };
}

function options() {
  return {
    registeredJobs: [localJobRegistration("fixture_noop")],
    nowIso: () => "2026-07-14T00:00:00.000Z",
  };
}

function providerInput(
  intentId: string,
  projectId: string,
  exactTarget: NonNullable<JobRecord["target"]>,
): EnqueueJobInput {
  return {
    jobType: "fixture_noop",
    projectId,
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId,
    target: exactTarget,
    request: { kind: "local", payloadHash },
    inputSnapshot: {},
  };
}

function target(
  modelId: string,
  settingsCharacter: string,
): NonNullable<JobRecord["target"]> {
  return {
    providerId: "mock",
    modelId,
    operation: "image",
    settingsHash: settingsCharacter.repeat(64),
  };
}

function exhaustQuota(scheduler: JobScheduler, expectedJobId: string): void {
  const claimed = scheduler.claimNext({
    workerId: "worker",
    bootId: "boot",
    nowMonoMs: 10,
    nowWallMs: 1_000,
    leaseTtlMs: 1_000,
    concurrencyPerProvider: 4,
  });
  if (!claimed || claimed.id !== expectedJobId)
    throw new JobError("EXPECTED_JOB_CLAIM");
  const running = scheduler.markRunning(claimed.id, fence(claimed), 11);
  scheduler.recordFailure(
    running.id,
    fence(running),
    makeFailure("quota_exhausted"),
    { nowMonoMs: 12, wallNowIso: "2026-07-14T00:00:03.000Z" },
  );
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

function durableQuotaSnapshot(scheduler: JobScheduler): unknown {
  return {
    jobs: scheduler.list(),
    incidents: scheduler.quotaIncidents(),
    audits: scheduler.auditEvents(),
  };
}

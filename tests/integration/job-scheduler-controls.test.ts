import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { makeFailure } from "../../src/providers/failures.js";
import { JobError } from "../../src/jobs/errors.js";
import {
  humanGateJobRegistration,
  localJobRegistration,
} from "../../src/jobs/registrations.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import type {
  EnqueueJobInput,
  JobFence,
  JobRecord,
  QuotaDecisionInput,
} from "../../src/jobs/types.js";
import { temporaryDirectory } from "../helpers/temp.js";

const hash = "c".repeat(64);
const projectA = "01J00000000000000000000001";
const projectB = "01J00000000000000000000002";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("durable scheduler controls", () => {
  it("records ordered events and fences optimistic operator actions", async () => {
    const { scheduler, close } = await harness();
    const first = scheduler.enqueue(input({ intentId: "first" }));
    const second = scheduler.enqueue(input({ intentId: "second" }));
    const reprioritized = scheduler.setPriority(first.id, {
      expectedRevision: first.revision,
      expectedState: "queued",
      priority: 5,
    });
    expect(reprioritized.priority).toBe(5);
    expect(() =>
      scheduler.setPriority(first.id, {
        expectedRevision: first.revision,
        expectedState: "queued",
        priority: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "JOB_REVISION_CONFLICT" }));

    const claimed = claim(scheduler, 10);
    const running = scheduler.markRunning(claimed.id, fence(claimed), 11);
    expect(scheduler.pauseProject(projectA)).toEqual([second.id]);
    expect(scheduler.get(running.id)?.state).toBe("running");
    expect(scheduler.get(second.id)?.stateReason).toBe("operator");
    expect(scheduler.resumeProject(projectA)).toEqual([second.id]);
    const canceled = scheduler.cancel(running.id, {
      expectedRevision: running.revision,
      expectedState: "running",
    });
    expect(canceled.state).toBe("canceled");
    expect(() =>
      scheduler.commitSuccess(running.id, fence(running), []),
    ).toThrowError(expect.objectContaining({ code: "JOB_FENCE_MISMATCH" }));
    expect(scheduler.events(first.id).map((event) => event.kind)).toEqual([
      "enqueued",
      "priority_changed",
      "claimed",
      "running",
      "canceled",
    ]);
    close();
  });

  it("schedules exact retries and derives no-progress without expiring ownership", async () => {
    const { scheduler, close } = await harness();
    scheduler.enqueue(input({ intentId: "retry" }));
    const claimed = claim(scheduler, 100);
    const running = scheduler.markRunning(claimed.id, fence(claimed), 101);
    const progress = scheduler.recordProgress(running.id, fence(running), {
      percent: 25,
      noteCode: "fixture_work",
      nowMonoMs: 120,
      wallNowIso: "2026-07-14T00:00:01.000Z",
    });
    expect(progress.progress?.noProgress).toBe(false);
    expect(scheduler.queueSnapshot(719, 600).stalledCount).toBe(0);
    expect(scheduler.queueSnapshot(721, 600).stalledCount).toBe(1);
    scheduler.heartbeat(running.id, fence(running), {
      nowMonoMs: 721,
      wallNowIso: "1900-01-01T00:00:00.000Z",
      leaseTtlMs: 30,
    });
    const latest = scheduler.get(running.id)!;
    const advanced = scheduler.recordProgress(latest.id, fence(latest), {
      percent: 30,
      noteCode: "fixture_work",
      nowMonoMs: 722,
      wallNowIso: "2026-07-14T00:00:02.000Z",
    });
    expect(advanced.progress?.noProgress).toBe(false);

    const failed = scheduler.recordFailure(
      advanced.id,
      fence(advanced),
      makeFailure("network_failure"),
      {
        nowMonoMs: 730,
        wallNowIso: "2026-07-14T00:00:03.000Z",
      },
    );
    expect(failed.state).toBe("queued");
    expect(failed.autoRetryIndex).toBe(1);
    expect(failed.retrySchedule?.nextEligibleAtMono).toBe(10_730);
    expect(claimMaybe(scheduler, 10_729)).toBeNull();
    expect(claimMaybe(scheduler, 10_730)?.attempts).toBe(2);
    close();
  });

  it("uses the durable due time after restart and drops provider detail", async () => {
    const { scheduler, store, close } = await harness();
    scheduler.enqueue(input({ intentId: "restart-retry" }));
    const claimed = claim(scheduler, 100);
    const running = scheduler.markRunning(claimed.id, fence(claimed), 101);
    const failed = scheduler.recordFailure(
      running.id,
      fence(running),
      makeFailure("malformed_output", {
        providerDetail: "PRIVATE_CHILD_PROVIDER_BODY",
      }),
      {
        nowMonoMs: 110,
        wallNowIso: "2026-07-14T00:00:00.000Z",
      },
    );
    expect(failed.failure).not.toHaveProperty("providerDetail");
    expect(JSON.stringify(scheduler.list())).not.toContain(
      "PRIVATE_CHILD_PROVIDER_BODY",
    );
    const restarted = new JobScheduler(store, options());
    expect(
      claimMaybeWithBoot(
        restarted,
        "new-boot",
        1,
        Date.parse("2026-07-14T00:00:04.999Z"),
      ),
    ).toBeNull();
    expect(
      claimMaybeWithBoot(
        restarted,
        "new-boot",
        2,
        Date.parse("2026-07-14T00:00:05.000Z"),
      )?.id,
    ).toBe(failed.id);
    close();
  });

  it("opens one provider quota incident and creates scoped explicit successors", async () => {
    const { scheduler, close } = await harness();
    scheduler.enqueue(providerInput("quota-a", projectA, "mock"));
    scheduler.enqueue(providerInput("quota-b", projectB, "mock"));
    scheduler.enqueue(providerInput("other-provider", projectB, "codex"));
    const claimed = claim(scheduler, 10);
    const running = scheduler.markRunning(claimed.id, fence(claimed), 11);
    scheduler.recordFailure(
      running.id,
      fence(running),
      makeFailure("quota_exhausted"),
      { nowMonoMs: 12, wallNowIso: "2026-07-14T00:00:03.000Z" },
    );

    const [incident] = scheduler.quotaIncidents();
    expect(incident?.providerId).toBe("mock");
    expect(
      scheduler
        .list()
        .filter((job) => job.target?.providerId === "mock")
        .every((job) => job.state === "paused" && job.stateReason === "quota"),
    ).toBe(true);
    expect(
      scheduler.list().find((job) => job.target?.providerId === "codex")?.state,
    ).toBe("queued");

    const waitScope = { projectId: projectB, standaloneScopeId: null };
    const waitImpact = scheduler.quotaDecisionImpact(incident.id, waitScope);
    scheduler.decideQuota(incident.id, {
      actionId: "quota-wait-project-b",
      expectedRevision: incident.revision,
      impactHash: waitImpact.impactHash,
      projectId: projectB,
      standaloneScopeId: null,
      decision: "wait",
    });
    const continueScope = { projectId: projectA, standaloneScopeId: null };
    const continueImpact = scheduler.quotaDecisionImpact(
      incident.id,
      continueScope,
    );
    const continueDecision: QuotaDecisionInput = {
      actionId: "quota-continue-project-a",
      expectedRevision: incident.revision,
      impactHash: continueImpact.impactHash,
      projectId: projectA,
      standaloneScopeId: null,
      decision: "continue",
      alternateTarget: target("gemini"),
    };
    const successors = scheduler.decideQuota(incident.id, continueDecision);
    expect(successors).toHaveLength(1);
    expect(successors[0]?.target?.providerId).toBe("gemini");
    expect(successors[0]?.supersedesJobId).toBe(running.id);
    expect(scheduler.get(running.id)?.successorJobIds).toEqual([
      successors[0]?.id,
    ]);
    expect(scheduler.auditEvents().map((event) => event.decision)).toEqual([
      "wait",
      "continue",
    ]);
    expect(
      scheduler.decideQuota(incident.id, continueDecision).map((job) => job.id),
    ).toEqual(successors.map((job) => job.id));
    expect(scheduler.auditEvents()).toHaveLength(2);
    expect(() =>
      scheduler.decideQuota(incident.id, {
        ...continueDecision,
        alternateTarget: target("codex"),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "JOB_ACTION_ID_COLLISION" }),
    );
    expect(() =>
      scheduler.decideQuota(incident.id, {
        ...continueDecision,
        actionId: "quota-second-project-a-decision",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "JOB_QUOTA_SCOPE_DECIDED" }),
    );
    close();
  });

  it("persists a storage stop, preserves gates, and resumes only after a probe", async () => {
    const { scheduler, store, close } = await harness();
    scheduler.enqueue(input({ intentId: "storage-running" }));
    scheduler.enqueue(input({ intentId: "storage-queued" }));
    const gate = scheduler.enqueue(gateInput());
    const claimed = claim(scheduler, 10);
    const running = scheduler.markRunning(claimed.id, fence(claimed), 11);
    scheduler.recordFailure(
      running.id,
      fence(running),
      makeFailure("insufficient_disk_space"),
      { nowMonoMs: 12, wallNowIso: "2026-07-14T00:00:03.000Z" },
    );
    expect(scheduler.storageStatus().active).toBe(true);
    expect(scheduler.get(gate.id)?.state).toBe("waiting_review");
    expect(
      scheduler.list().filter((job) => job.request.kind !== "human_gate"),
    ).toSatisfy((jobs: JobRecord[]) =>
      jobs.every(
        (job) => job.state === "paused" && job.stateReason === "storage",
      ),
    );
    expect(claimMaybe(scheduler, 20)).toBeNull();

    const restarted = new JobScheduler(store, options());
    expect(restarted.storageStatus().active).toBe(true);
    const failedImpact = restarted.storageResumeImpact();
    expect(() =>
      restarted.resumeStorage(
        {
          expectedRevision: failedImpact.expectedRevision,
          impactHash: failedImpact.impactHash,
          confirmedAffectedCount: failedImpact.affectedCount,
          confirmed: true,
        },
        () => false,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "JOB_STORAGE_PROBE_FAILED" }),
    );
    const successImpact = restarted.storageResumeImpact();
    expect(
      restarted.resumeStorage(
        {
          expectedRevision: successImpact.expectedRevision,
          impactHash: successImpact.impactHash,
          confirmedAffectedCount: successImpact.affectedCount,
          confirmed: true,
        },
        () => true,
      ).length,
    ).toBe(2);
    expect(restarted.storageStatus().active).toBe(false);
    close();
  });

  it("keeps human gates owner-verified and unblocks only the exact version", async () => {
    const { scheduler, close } = await harness();
    const gate = scheduler.enqueue(gateInput());
    const child = scheduler.enqueue(
      input({ intentId: "after-gate", dependsOn: [gate.id] }),
    );
    expect(child.state).toBe("blocked");
    expect(() =>
      scheduler.completeHumanGate(
        gate.id,
        {
          expectedRevision: gate.revision,
          targetVersionId: "wrong-version",
        },
        () => true,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "JOB_GATE_VERSION_MISMATCH" }),
    );
    const completed = scheduler.completeHumanGate(
      gate.id,
      {
        expectedRevision: gate.revision,
        targetVersionId: "version-1",
      },
      () => true,
    );
    expect(completed.state).toBe("succeeded");
    expect(scheduler.get(child.id)?.state).toBe("queued");
    close();
  });

  it("reserves customer approval cancellation for the owning feature", async () => {
    const { scheduler, close } = await harness();
    const gate = scheduler.enqueue(
      input({
        jobType: "human_gate_fixture",
        intentId: "customer-approval-gate",
        request: {
          kind: "human_gate",
          gateKind: "customer_approval",
          targetId: "preview-1",
          targetVersionId: "preview-version-1",
        },
      }),
    );

    expect(() =>
      scheduler.cancel(gate.id, {
        expectedRevision: gate.revision,
        expectedState: "waiting_review",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "JOB_GATE_OWNER_ACTION_REQUIRED" }),
    );
    const canceled = scheduler.cancelOwnedHumanGate(
      gate.id,
      {
        expectedRevision: gate.revision,
        targetVersionId: "preview-version-1",
        reason: "changes_requested",
      },
      () => true,
    );
    expect(canceled).toMatchObject({
      state: "canceled",
      stateReason: "changes_requested",
    });
    close();
  });

  it("reserves converted proof cancellation for the print owner", async () => {
    const { scheduler, close } = await harness();
    const gate = scheduler.enqueue(
      input({
        jobType: "human_gate_fixture",
        intentId: "converted-proof-gate",
        request: {
          kind: "human_gate",
          gateKind: "print_converted_proof",
          targetId: "print-run-1",
          targetVersionId: "proof-bundle-1",
        },
      }),
    );

    expect(() =>
      scheduler.cancel(gate.id, {
        expectedRevision: gate.revision,
        expectedState: "waiting_review",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "JOB_GATE_OWNER_ACTION_REQUIRED" }),
    );
    expect(
      scheduler.cancelOwnedHumanGate(
        gate.id,
        {
          expectedRevision: gate.revision,
          targetVersionId: "proof-bundle-1",
          reason: "converted_proof_rejected",
        },
        () => true,
      ),
    ).toMatchObject({
      state: "canceled",
      stateReason: "converted_proof_rejected",
    });
    close();
  });
});

async function harness() {
  const temp = await temporaryDirectory("hekayati-job-controls-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "jobs.db"));
  const scheduler = new JobScheduler(store, options());
  return { scheduler, store, close: () => store.close() };
}

function options() {
  return {
    registeredJobs: [
      localJobRegistration("fixture_noop"),
      humanGateJobRegistration("human_gate_fixture"),
    ],
    nowIso: () => "2026-07-14T00:00:00.000Z",
  };
}

function input(overrides: Partial<EnqueueJobInput> = {}): EnqueueJobInput {
  return {
    jobType: "fixture_noop",
    projectId: projectA,
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

function providerInput(
  intentId: string,
  projectId: string,
  providerId: "mock" | "codex" | "gemini",
): EnqueueJobInput {
  return input({ intentId, projectId, target: target(providerId) });
}

function target(providerId: "mock" | "codex" | "gemini") {
  return {
    providerId,
    modelId: `${providerId}-v1`,
    operation: "image" as const,
    settingsHash: hash,
  };
}

function gateInput(): EnqueueJobInput {
  return input({
    jobType: "human_gate_fixture",
    intentId: "gate",
    request: {
      kind: "human_gate",
      gateKind: "fixture_review",
      targetId: "target-1",
      targetVersionId: "version-1",
    },
  });
}

function claim(scheduler: JobScheduler, nowMonoMs: number): JobRecord {
  const job = claimMaybe(scheduler, nowMonoMs);
  if (!job) throw new JobError("EXPECTED_JOB_CLAIM");
  return job;
}

function claimMaybe(scheduler: JobScheduler, nowMonoMs: number) {
  return claimMaybeWithBoot(scheduler, "boot", nowMonoMs, 1_000 + nowMonoMs);
}

function claimMaybeWithBoot(
  scheduler: JobScheduler,
  bootId: string,
  nowMonoMs: number,
  nowWallMs: number,
) {
  return scheduler.claimNext({
    workerId: "worker",
    bootId,
    nowMonoMs,
    nowWallMs,
    leaseTtlMs: 1_000,
    concurrencyPerProvider: 4,
  });
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

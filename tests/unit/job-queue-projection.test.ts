import { describe, expect, it, vi } from "vitest";

import { buildQueueProjection } from "../../src/jobs/queue-projection.js";
import type { JobScheduler } from "../../src/jobs/scheduler.js";
import {
  credentialIncidentSchema,
  jobRecordSchema,
  quotaIncidentSchema,
  storageControlSchema,
  type JobRecord,
  type JobState,
  type JobTarget,
} from "../../src/jobs/schemas.js";

const hash = "4".repeat(64);
const now = "2026-07-14T00:00:00.000Z";
const projectId = id(90);
const otherProjectId = id(91);
const standaloneScopeId = "studio-scope-1";

describe("safe queue projection", () => {
  it("derives positions, blockers, stalls, actions, gates, and incident impacts", () => {
    const succeededDependency = job(1, "succeeded");
    const queuedLow = job(2, "queued", { priority: 2, createdSequence: 1 });
    const queuedHigh = job(3, "queued", {
      priority: 5,
      createdSequence: undefined,
    });
    const blocked = job(4, "blocked", {
      dependsOn: [queuedLow.id, succeededDependency.id, id(89)],
      stateReason: "dependency",
    });
    const claimed = job(5, "claimed", { lease: lease(), attempts: 1 });
    const stalled = job(6, "running", {
      lease: lease(0),
      attempts: 1,
    });
    const progressing = job(7, "running", {
      lease: lease(0),
      attempts: 1,
      progress: {
        attempt: 1,
        percent: 40,
        noteCode: "fixture_progress",
        updatedAtMono: 599_999,
        noProgress: false,
      },
    });
    const operatorPaused = job(8, "paused", { stateReason: "operator" });
    const dependencyPaused = job(9, "paused", { stateReason: "dependency" });
    const quotaProject = job(10, "paused", {
      stateReason: "quota",
      target: target("mock", "image"),
    });
    const quotaStandalone = job(11, "paused", {
      projectId: null,
      standaloneScopeId,
      stateReason: "quota",
      target: target("mock", "image"),
    });
    const credentialPaused = job(12, "paused", {
      stateReason: "credentials",
    });
    const storagePaused = job(13, "paused", { stateReason: "storage" });
    const gate = job(14, "waiting_review", {
      request: {
        kind: "human_gate",
        gateKind: "internal_review",
        targetId: projectId,
        targetVersionId: id(92),
      },
    });
    const failed = job(15, "failed", { stateReason: "invalid_input" });
    const canceled = job(16, "canceled", { stateReason: "user_canceled" });
    const records = [
      succeededDependency,
      queuedLow,
      queuedHigh,
      blocked,
      claimed,
      stalled,
      progressing,
      operatorPaused,
      dependencyPaused,
      quotaProject,
      quotaStandalone,
      credentialPaused,
      storagePaused,
      gate,
      failed,
      canceled,
    ];
    const scheduler = fakeScheduler(records);
    const invalidTarget = {
      providerId: "invalid",
      modelId: "invalid",
      operation: "image",
      settingsHash: hash,
    } as unknown as JobTarget;
    const geminiImage = target("gemini", "image");
    const projection = buildQueueProjection(scheduler, 600_000, now, () => [
      invalidTarget,
      target("mock", "image"),
      target("gemini", "text"),
      geminiImage,
      geminiImage,
    ]);

    expect(
      projection.jobs.find((item) => item.id === queuedHigh.id),
    ).toMatchObject({
      queuePosition: 1,
      allowedActions: ["pause", "cancel", "priority"],
    });
    expect(
      projection.jobs.find((item) => item.id === queuedLow.id)?.queuePosition,
    ).toBe(2);
    expect(
      projection.jobs.find((item) => item.id === blocked.id)?.blockers,
    ).toEqual([{ id: queuedLow.id, state: "queued", reason: null }]);
    expect(
      projection.jobs.find((item) => item.id === stalled.id)?.noProgress,
    ).toBe(true);
    expect(
      projection.jobs.find((item) => item.id === progressing.id)?.noProgress,
    ).toBe(false);
    expect(actionMap(projection.jobs)).toMatchObject({
      [claimed.id]: ["cancel"],
      [operatorPaused.id]: ["resume", "cancel", "priority"],
      [dependencyPaused.id]: ["retry", "cancel", "priority"],
      [quotaProject.id]: ["cancel", "priority"],
      [credentialPaused.id]: ["cancel", "priority"],
      [storagePaused.id]: ["cancel", "priority"],
      [gate.id]: ["open_gate"],
      [failed.id]: [],
      [canceled.id]: [],
      [succeededDependency.id]: [],
    });
    expect(projection.jobs.find((item) => item.id === gate.id)?.gate).toEqual({
      gateKind: "internal_review",
      targetId: projectId,
      targetVersionId: id(92),
    });
    expect(projection.quotaIncidents[0]).toMatchObject({
      alternateTargets: [geminiImage],
      scopes: [
        { projectId, standaloneScopeId: null, affectedCount: 1 },
        {
          projectId: null,
          standaloneScopeId,
          affectedCount: 1,
        },
      ],
      resumeImpact: { affectedCount: 2 },
    });
    expect(projection.quotaIncidents[1]).toMatchObject({
      alternateTargets: [],
      scopes: [],
      resumeImpact: null,
    });
    expect(projection.credentialIncidents).toMatchObject([
      { status: "open", affectedCount: 1 },
      { status: "resolved", impactHash: null, affectedCount: 0 },
    ]);
    expect(projection.storage).toMatchObject({
      active: true,
      resumeImpact: { affectedCount: 1 },
    });
    expect(
      projection.projectActions.map((item) => item.projectId).sort(),
    ).toEqual([projectId, otherProjectId].sort());
    expect(projection.jobs[0]?.history).toMatchObject([
      { kind: "enqueued", jobId: succeededDependency.id },
    ]);
  });

  it("omits resume impacts when storage and incidents are resolved", () => {
    const scheduler = fakeScheduler([], false);
    const alternates = vi.fn(() => [target("gemini", "image")]);
    const projection = buildQueueProjection(scheduler, 0, now, alternates);
    expect(projection.storage.resumeImpact).toBeNull();
    expect(projection.quotaIncidents[0]?.resumeImpact).toBeNull();
    expect(alternates).not.toHaveBeenCalled();
  });
});

function fakeScheduler(jobs: JobRecord[], active = true): JobScheduler {
  const openQuota = quotaIncidentSchema.parse({
    id: id(70),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    revision: 2,
    providerId: "mock",
    operation: "image",
    status: active ? "open" : "resolved",
    affectedScopeIds: [projectId, standaloneScopeId, "empty-scope"],
    ownedJobIds: jobs
      .filter((item) => item.stateReason === "quota")
      .map((item) => item.id),
    originalTargets: [target("mock", "image")],
  });
  const resolvedQuota = quotaIncidentSchema.parse({
    ...openQuota,
    id: id(71),
    status: "resolved",
  });
  const openCredential = credentialIncidentSchema.parse({
    id: id(72),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    providerId: "mock",
    status: "open",
    affectedScopeIds: [projectId],
    ownedJobIds: jobs
      .filter((item) => item.stateReason === "credentials")
      .map((item) => item.id),
    originalTargets: [target("mock", "image")],
  });
  const resolvedCredential = credentialIncidentSchema.parse({
    ...openCredential,
    id: id(73),
    status: "resolved",
  });
  const counts = Object.fromEntries(
    [
      "created",
      "blocked",
      "queued",
      "claimed",
      "running",
      "succeeded",
      "failed",
      "paused",
      "canceled",
      "waiting_review",
    ].map((state) => [
      state,
      jobs.filter((item) => item.state === state).length,
    ]),
  ) as Record<JobState, number>;
  return {
    list: () => jobs,
    queueSnapshot: () => ({
      counts,
      stalledCount: 1,
      runningByProvider: { mock: 2 },
    }),
    quotaIncidents: () => (active ? [openQuota, resolvedQuota] : [openQuota]),
    credentialIncidents: () =>
      active ? [openCredential, resolvedCredential] : [resolvedCredential],
    projectActionImpact: (_id: string, action: "pause" | "resume") => ({
      impactHash: action === "pause" ? "a".repeat(64) : "b".repeat(64),
      affectedCount: 1,
    }),
    storageStatus: () =>
      storageControlSchema.parse({
        id: "scheduler",
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        revision: active ? 1 : 0,
        active,
        reason: active ? "disk_write_failure" : null,
        incidentId: active ? id(74) : null,
        ownedJobIds: active
          ? jobs
              .filter((item) => item.stateReason === "storage")
              .map((item) => item.id)
          : [],
        detectedAt: active ? now : null,
        lastProbeAt: null,
        lastProbeStatus: null,
        workerStatus: "running",
        bootId: "boot",
        lastRecoveryAt: now,
      }),
    storageResumeImpact: () => ({
      expectedRevision: 1,
      impactHash: "c".repeat(64),
      affectedCount: 1,
    }),
    credentialResumeImpact: () => ({
      impactHash: "d".repeat(64),
      affectedCount: 1,
    }),
    quotaDecisionImpact: (
      _incidentId: string,
      scope: { projectId: string | null; standaloneScopeId: string | null },
    ) => ({
      impactHash: scope.projectId ? "e".repeat(64) : "f".repeat(64),
      affectedCount:
        scope.projectId === projectId ||
        scope.standaloneScopeId === standaloneScopeId
          ? 1
          : 0,
    }),
    quotaResumeImpact: () => ({
      impactHash: "1".repeat(64),
      affectedCount: 2,
    }),
    events: (jobId: string) => [
      {
        id: id(80),
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        jobId,
        sequence: 1,
        kind: "enqueued",
        attempt: null,
        fromState: null,
        toState: "queued",
        reason: null,
        noteCode: null,
      },
    ],
  } as unknown as JobScheduler;
}

function job(
  index: number,
  state: JobState,
  overrides: Partial<JobRecord> = {},
): JobRecord {
  return jobRecordSchema.parse({
    id: id(index),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    jobType: "fixture_noop",
    projectId: index === 1 ? otherProjectId : projectId,
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    createdSequence: index,
    intentId: `intent-${index}`,
    idempotencyKey: hash,
    requestHash: hash,
    target: null,
    request: { kind: "local", payloadHash: hash },
    inputSnapshot: {},
    state,
    stateReason: null,
    resumeState: null,
    resumeReason: null,
    lease: null,
    attempts: 0,
    autoRetryIndex: 0,
    manualRetryCount: 0,
    retrySchedule: null,
    progress: null,
    failure: null,
    provenance: null,
    resultRefs: [],
    supersedesJobId: null,
    successorJobIds: [],
    ...overrides,
  });
}

function target(
  providerId: "mock" | "gemini",
  operation: "text" | "image",
): JobTarget {
  return {
    providerId,
    modelId: `${providerId}-${operation}-v1`,
    operation,
    settingsHash: hash,
  };
}

function lease(claimedAtMono = 10) {
  return {
    workerId: "worker",
    bootId: "boot",
    claimToken: "claim-token",
    claimedAtMono,
    expiresAtMono: claimedAtMono + 1_000_000,
  };
}

function actionMap(
  jobs: ReturnType<typeof buildQueueProjection>["jobs"],
): Record<string, string[]> {
  return Object.fromEntries(jobs.map((item) => [item.id, item.allowedActions]));
}

function id(index: number): string {
  return `01J${String(index).padStart(23, "0")}`;
}

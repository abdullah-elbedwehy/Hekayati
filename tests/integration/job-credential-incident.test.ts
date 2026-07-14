import { join } from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { JobError } from "../../src/jobs/errors.js";
import {
  humanGateJobRegistration,
  localJobRegistration,
} from "../../src/jobs/registrations.js";
import { JobRuntime } from "../../src/jobs/runtime.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import { localJobRequestSchema } from "../../src/jobs/schemas.js";
import type {
  CredentialAvailabilityPort,
  EnqueueJobInput,
  JobFence,
  JobRecord,
  RegisteredJobDefinition,
} from "../../src/jobs/types.js";
import { makeFailure } from "../../src/providers/failures.js";
import { registerJobApi } from "../../src/server/routes/job-api.js";
import { temporaryDirectory } from "../helpers/temp.js";

const projectA = "01J00000000000000000000001";
const projectB = "01J00000000000000000000002";
const payloadHash = "f".repeat(64);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("provider credential incidents", () => {
  it("pauses only failing and pending work for the failed provider", async () => {
    const { scheduler, store, close } = await schedulerHarness();
    const completed = scheduler.enqueue(
      providerInput("completed", projectA, target("text", "done"), 5),
    );
    succeedNext(scheduler, completed.id, 1);
    const source = scheduler.enqueue(
      providerInput("source", projectA, target("text", "source"), 5),
    );
    const runningSibling = scheduler.enqueue(
      providerInput("running", projectB, target("image", "running"), 4),
    );
    const queued = scheduler.enqueue(
      providerInput("queued", projectB, target("image", "queued"), 3),
    );
    const gate = scheduler.enqueue(gateInput());
    const blocked = scheduler.enqueue({
      ...providerInput("blocked", projectA, target("structured", "blocked")),
      dependsOn: [gate.id],
    });
    const otherProvider = scheduler.enqueue(
      providerInput(
        "other-provider",
        projectB,
        { ...target("text", "other"), providerId: "gemini" },
        2,
      ),
    );
    const claimedSource = claim(scheduler, 10);
    expect(claimedSource.id).toBe(source.id);
    const runningSource = scheduler.markRunning(
      source.id,
      fence(claimedSource),
      11,
    );
    const claimedSibling = claim(scheduler, 12);
    expect(claimedSibling.id).toBe(runningSibling.id);
    scheduler.markRunning(runningSibling.id, fence(claimedSibling), 13);

    scheduler.recordFailure(
      runningSource.id,
      fence(runningSource),
      {
        category: "invalid_credentials",
        message: "SECRET_CALLER_MESSAGE",
        retryable: true,
        providerDetail: "SECRET_PROVIDER_RESPONSE",
      },
      { nowMonoMs: 14, wallNowIso: "2026-07-14T00:00:03.000Z" },
    );

    expect(scheduler.get(source.id)).toMatchObject({
      state: "paused",
      stateReason: "credentials",
      failure: {
        category: "invalid_credentials",
        message: "بيانات اتصال المزوّد غير موجودة أو غير صالحة.",
        retryable: false,
      },
    });
    expect(scheduler.get(queued.id)).toMatchObject({
      state: "paused",
      stateReason: "credentials",
    });
    expect(scheduler.get(blocked.id)).toMatchObject({
      state: "paused",
      stateReason: "credentials",
      resumeState: "blocked",
      resumeReason: "dependency",
    });
    expect(scheduler.get(runningSibling.id)?.state).toBe("running");
    expect(scheduler.get(completed.id)?.state).toBe("succeeded");
    expect(scheduler.get(otherProvider.id)?.state).toBe("queued");
    expect(JSON.stringify(scheduler.credentialIncidents())).not.toContain(
      "SECRET_PROVIDER_RESPONSE",
    );
    expect(JSON.stringify(scheduler.list())).not.toContain(
      "SECRET_CALLER_MESSAGE",
    );
    expect(scheduler.events(source.id).at(-1)).toMatchObject({
      reason: "credentials",
      noteCode: "invalid_credentials",
    });

    const duringIncident = scheduler.enqueue(
      providerInput("during-incident", projectA, target("text", "later")),
    );
    expect(duringIncident).toMatchObject({
      state: "paused",
      stateReason: "credentials",
    });
    const [incident] = scheduler.credentialIncidents();
    expect(incident).toMatchObject({
      providerId: "mock",
      status: "open",
      ownedJobIds: [source.id, queued.id, blocked.id, duringIncident.id],
    });
    expect(() =>
      scheduler.retry(duringIncident.id, {
        expectedRevision: duringIncident.revision,
        expectedState: "paused",
      }),
    ).toThrowError(expect.objectContaining({ code: "JOB_ACTION_NOT_ALLOWED" }));

    const restarted = new JobScheduler(store, options());
    expect(restarted.credentialIncidents()).toEqual(
      scheduler.credentialIncidents(),
    );
    close();
  });

  it("requires fresh impact and exact forced checks before owned restoration", async () => {
    const { scheduler, close } = await schedulerHarness();
    const source = scheduler.enqueue(
      providerInput("source", projectA, target("text", "source"), 5),
    );
    const sibling = scheduler.enqueue(
      providerInput("sibling", projectB, target("image", "sibling")),
    );
    failCredentials(scheduler, source.id);
    const [incident] = scheduler.credentialIncidents();
    const initialImpact = scheduler.credentialResumeImpact(incident.id);
    const canceled = scheduler.cancel(sibling.id, {
      expectedRevision: scheduler.get(sibling.id)!.revision,
      expectedState: "paused",
    });
    const checked = vi.fn(async () => true);

    await expect(
      scheduler.resumeCredentials(
        incident.id,
        {
          expectedRevision: incident.revision,
          impactHash: initialImpact.impactHash,
        },
        { forceCheckExact: checked },
      ),
    ).rejects.toMatchObject({ code: "JOB_IMPACT_CONFLICT" });
    expect(checked).not.toHaveBeenCalled();

    const impact = scheduler.credentialResumeImpact(incident.id);
    const before = credentialSnapshot(scheduler);
    const unavailable = vi.fn(
      async (exactTarget: NonNullable<JobRecord["target"]>) =>
        exactTarget.operation !== "image",
    );
    await expect(
      scheduler.resumeCredentials(
        incident.id,
        { expectedRevision: incident.revision, impactHash: impact.impactHash },
        { forceCheckExact: unavailable },
      ),
    ).rejects.toMatchObject({ code: "JOB_CREDENTIAL_TARGET_UNAVAILABLE" });
    expect(unavailable).toHaveBeenCalledTimes(2);
    expect(credentialSnapshot(scheduler)).toEqual(before);

    const exactChecks: JobRecord["target"][] = [];
    const availability: CredentialAvailabilityPort = {
      forceCheckExact: async (exactTarget) => {
        exactChecks.push(exactTarget);
        return true;
      },
    };
    const restored = await scheduler.resumeCredentials(
      incident.id,
      { expectedRevision: incident.revision, impactHash: impact.impactHash },
      availability,
    );

    expect(exactChecks).toEqual([
      target("text", "source"),
      target("image", "sibling"),
    ]);
    expect(restored.map((job) => job.id)).toEqual([source.id]);
    expect(restored[0]).toMatchObject({ state: "queued", failure: null });
    expect(scheduler.get(canceled.id)?.state).toBe("canceled");
    expect(scheduler.credentialIncidents()[0]?.status).toBe("resolved");
    expect(scheduler.credentialAuditEvents().at(-1)).toMatchObject({
      incidentId: incident.id,
      impactHash: impact.impactHash,
      affectedJobIds: [source.id],
      checkedTargetCount: 2,
    });
    close();
  });

  it("projects safe remediation state through queue, health, and API", async () => {
    const directory = await temporaryDirectory("hekayati-job-credentials-api-");
    cleanups.push(directory.cleanup);
    const store = new DocumentStore(join(directory.path, "jobs.db"));
    const runtime = new JobRuntime(store, {
      definitions: [fixtureDefinition()],
    });
    const source = runtime.scheduler.enqueue(
      providerInput("api-source", projectA, target("text", "api")),
    );
    failCredentials(runtime.scheduler, source.id);
    const queue = runtime.queueProjection();
    const [incident] = queue.credentialIncidents;
    expect(incident).toMatchObject({
      providerId: "mock",
      status: "open",
      affectedCount: 1,
    });
    expect(incident.impactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(queue.jobs[0]?.allowedActions).not.toContain("retry");
    expect(JSON.stringify(queue)).not.toContain(payloadHash);

    const app = Fastify();
    registerJobApi(app, runtime, {
      resumeCredentials: async (incidentId, input) =>
        (
          await runtime.scheduler.resumeCredentials(incidentId, input, {
            forceCheckExact: async () => true,
          })
        ).map((job) => job.id),
    });
    cleanups.push(async () => {
      await app.close();
      store.close();
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/jobs/credentials/${incident.id}/resume`,
      payload: {
        expectedRevision: incident.revision,
        impactHash: incident.impactHash,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ affectedJobIds: [source.id] });
    expect(runtime.scheduler.credentialIncidents()[0]?.status).toBe("resolved");
  });

  it("persists only canonical failures, structural diagnostics, and exact safe reason codes", async () => {
    const { scheduler, close } = await schedulerHarness();
    const malformed = scheduler.enqueue(
      providerInput("malformed", projectA, target("structured", "malformed")),
    );
    const malformedClaim = claim(scheduler, 1_000);
    expect(malformedClaim.id).toBe(malformed.id);
    const malformedRunning = scheduler.markRunning(
      malformed.id,
      fence(malformedClaim),
      1_001,
    );
    scheduler.recordFailure(
      malformed.id,
      fence(malformedRunning),
      makeFailure("output_validation_failed", {
        message: "PRIVATE_REJECTED_CHILD_VALUE",
        providerDetail: JSON.stringify({
          sha256: "b".repeat(64),
          byteCount: 123,
          topLevelType: "object",
          topLevelKeys: ["PRIVATE_CHILD_FIELD"],
          issues: [{ path: "pages.0.text", code: "too_small" }],
        }),
      }),
      { nowMonoMs: 1_002, wallNowIso: "2026-07-14T00:00:03.000Z" },
    );
    expect(scheduler.get(malformed.id)?.failure).toMatchObject({
      category: "output_validation_failed",
      diagnostics: [{ path: ["pages", "0", "text"], code: "too_small" }],
    });
    expect(JSON.stringify(scheduler.get(malformed.id))).not.toMatch(
      /PRIVATE_REJECTED_CHILD_VALUE|PRIVATE_CHILD_FIELD/,
    );
    expect(scheduler.events(malformed.id).at(-1)?.noteCode).toBe(
      "output_validation_failed",
    );

    const consent = scheduler.enqueue(
      providerInput("consent", projectA, target("image", "consent"), 5),
    );
    const consentClaim = claim(scheduler, 2_000);
    expect(consentClaim.id).toBe(consent.id);
    const consentRunning = scheduler.markRunning(
      consent.id,
      fence(consentClaim),
      2_001,
    );
    scheduler.recordFailure(
      consent.id,
      fence(consentRunning),
      makeFailure("missing_reference_asset", {
        reasonCode: "PHOTO_CONSENT_REVOKED",
      }),
      { nowMonoMs: 2_002, wallNowIso: "2026-07-14T00:00:04.000Z" },
    );
    expect(scheduler.get(consent.id)).toMatchObject({
      state: "paused",
      stateReason: "PHOTO_CONSENT_REVOKED",
      failure: {
        category: "missing_reference_asset",
        reasonCode: "PHOTO_CONSENT_REVOKED",
      },
    });
    expect(scheduler.events(consent.id).at(-1)).toMatchObject({
      reason: "PHOTO_CONSENT_REVOKED",
      noteCode: "missing_reference_asset",
    });
    close();
  });
});

async function schedulerHarness() {
  const temp = await temporaryDirectory("hekayati-job-credentials-");
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

function providerInput(
  intentId: string,
  projectId: string,
  exactTarget: NonNullable<JobRecord["target"]>,
  priority = 3,
): EnqueueJobInput {
  return {
    jobType: "fixture_noop",
    projectId,
    standaloneScopeId: null,
    dependsOn: [],
    priority,
    intentId,
    target: exactTarget,
    request: { kind: "local", payloadHash },
    inputSnapshot: {},
  };
}

function gateInput(): EnqueueJobInput {
  return {
    ...providerInput("gate", projectA, target("text", "unused")),
    jobType: "human_gate_fixture",
    target: null,
    request: {
      kind: "human_gate",
      gateKind: "fixture_review",
      targetId: "target-1",
      targetVersionId: "version-1",
    },
  };
}

function target(
  operation: "text" | "structured" | "image",
  suffix: string,
): NonNullable<JobRecord["target"]> {
  return {
    providerId: "mock",
    modelId: `mock-${suffix}`,
    operation,
    settingsHash: "a".repeat(64),
  };
}

function claim(scheduler: JobScheduler, nowMonoMs: number): JobRecord {
  const job = scheduler.claimNext({
    workerId: "worker",
    bootId: "boot",
    nowMonoMs,
    nowWallMs: 1_000 + nowMonoMs,
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

function succeedNext(
  scheduler: JobScheduler,
  expectedJobId: string,
  nowMonoMs: number,
): void {
  const claimed = claim(scheduler, nowMonoMs);
  expect(claimed.id).toBe(expectedJobId);
  const running = scheduler.markRunning(
    claimed.id,
    fence(claimed),
    nowMonoMs + 1,
  );
  scheduler.commitSuccess(running.id, fence(running), [], nowMonoMs + 2);
}

function failCredentials(scheduler: JobScheduler, expectedJobId: string): void {
  const claimed = claim(scheduler, 100);
  if (claimed.id !== expectedJobId) throw new JobError("EXPECTED_JOB_CLAIM");
  const running = scheduler.markRunning(claimed.id, fence(claimed), 101);
  scheduler.recordFailure(
    running.id,
    fence(running),
    makeFailure("invalid_credentials"),
    { nowMonoMs: 102, wallNowIso: "2026-07-14T00:00:03.000Z" },
  );
}

function credentialSnapshot(scheduler: JobScheduler): unknown {
  return {
    jobs: scheduler.list(),
    incidents: scheduler.credentialIncidents(),
    audits: scheduler.credentialAuditEvents(),
  };
}

function fixtureDefinition(): RegisteredJobDefinition {
  return {
    jobType: "fixture_noop",
    requestSchema: localJobRequestSchema,
    validateEnqueue: () => undefined,
    prepare: async () => ({}),
    execute: async () => ({ ok: true, value: null }),
    commit: () => ({ resultRefs: [] }),
  };
}

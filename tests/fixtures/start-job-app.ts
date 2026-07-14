import { LOOPBACK_HOST } from "../../src/config/defaults.js";
import { localJobRequestSchema } from "../../src/jobs/schemas.js";
import { makeFailure } from "../../src/providers/failures.js";
import { createRuntime } from "../../src/server/app.js";
import { parsePort } from "../../src/server/startup/bind.js";
import type {
  EnqueueJobInput,
  JobFence,
  RegisteredJobDefinition,
} from "../../src/jobs/types.js";
import type { JobRecord, JobTarget } from "../../src/jobs/schemas.js";

const projectA = "01J00000000000000000000001";
const projectB = "01J00000000000000000000002";
const projectC = "01J00000000000000000000003";
const hash = "a".repeat(64);

const runtime = await createRuntime({
  enableTestRoutes: true,
  jobs: {
    definitions: [fixtureDefinition()],
    pollIntervalMs: 60_000,
    maxWorkers: 1,
    quotaAvailability: { forceCheckExact: async () => true },
    quotaAlternates: (incident) =>
      incident.operation === "image" ? [target("gemini")] : [],
  },
});

if (runtime.jobs.scheduler.list().length === 0)
  seedQueue(runtime.jobs.scheduler);

const origin = await runtime.start({
  host: LOOPBACK_HOST,
  port: parsePort(process.env.HEKAYATI_PORT, 4317),
});
console.log(`Hekayati is ready at ${origin}`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await runtime.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function seedQueue(scheduler: typeof runtime.jobs.scheduler): void {
  for (let index = 1; index <= 14; index += 1) {
    const completed = scheduler.enqueue(
      imageInput(`completed-${index}`, projectA),
    );
    const claimed = claim(scheduler, `complete-${index}`);
    const running = scheduler.markRunning(
      completed.id,
      fence(claimed),
      index * 10 + 1,
    );
    scheduler.commitWith(running.id, fence(running), index * 10 + 2, () => ({
      resultRefs: [`synthetic-page-${index}`],
      provenance: {
        provider: "mock",
        modelId: "mock-image-fixture-v1",
        at: "2026-07-14T12:00:00.000Z",
        inputVersionRefs: { projectVersion: `version-completed-${index}` },
        promptVersion: "fixture-prompt-v1",
        referenceAssetIds: [],
        attempt: running.attempts,
        settingsSnapshotHash: hash,
      },
    }));
  }
  const remaining = [
    imageInput("remaining-a-1", projectA),
    imageInput("remaining-a-2", projectA),
    imageInput("remaining-a-3", projectA),
    imageInput("remaining-a-4", projectA),
    imageInput("remaining-b-1", projectB),
    imageInput("remaining-b-2", projectB),
  ].map((input) => scheduler.enqueue(input));
  const source = claim(scheduler, "quota-source");
  const running = scheduler.markRunning(source.id, fence(source), 1_001);
  scheduler.recordFailure(
    running.id,
    fence(running),
    makeFailure("quota_exhausted"),
    { nowMonoMs: 1_002, wallNowIso: "2026-07-14T12:00:00.000Z" },
  );
  if (!remaining.some((job) => job.id === source.id))
    throw new Error("JOB_FIXTURE_QUOTA_SOURCE_MISSING");

  const otherProvider = scheduler.enqueue({
    ...imageInput("other-provider", projectC),
    target: target("gemini"),
  });
  scheduler.pause(otherProvider.id, {
    expectedRevision: otherProvider.revision,
    expectedState: "queued",
  });
  scheduler.enqueue(humanGateInput());
}

function claim(
  scheduler: typeof runtime.jobs.scheduler,
  claimToken: string,
): JobRecord {
  const claimed = scheduler.claimNext({
    workerId: "fixture-worker",
    bootId: "fixture-boot",
    nowMonoMs: 1_000,
    nowWallMs: Date.parse("2026-07-14T12:00:00.000Z"),
    leaseTtlMs: 60_000,
    concurrencyPerProvider: 4,
  });
  if (!claimed) throw new Error(`JOB_FIXTURE_CLAIM_MISSING:${claimToken}`);
  return claimed;
}

function imageInput(intentId: string, projectId: string): EnqueueJobInput {
  return {
    jobType: "fixture_image",
    projectId,
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId,
    target: target("mock"),
    request: { kind: "local", payloadHash: hash },
    inputSnapshot: { projectVersion: `version-${intentId}` },
  };
}

function humanGateInput(): EnqueueJobInput {
  return {
    jobType: "human_gate",
    projectId: projectC,
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId: "fixture-human-gate",
    target: null,
    request: {
      kind: "human_gate",
      gateKind: "internal_review",
      targetId: projectC,
      targetVersionId: "01J00000000000000000000004",
    },
    inputSnapshot: {},
  };
}

function target(providerId: "mock" | "gemini"): JobTarget {
  return {
    providerId,
    modelId: `${providerId}-image-fixture-v1`,
    operation: "image",
    settingsHash: hash,
  };
}

function fence(job: JobRecord): JobFence {
  if (!job.lease) throw new Error("JOB_FIXTURE_FENCE_MISSING");
  return {
    workerId: job.lease.workerId,
    bootId: job.lease.bootId,
    claimToken: job.lease.claimToken,
    attempt: job.attempts,
  };
}

function fixtureDefinition(): RegisteredJobDefinition {
  return {
    jobType: "fixture_image",
    requestSchema: localJobRequestSchema,
    validateEnqueue: () => undefined,
    prepare: async () => ({}),
    execute: async ({ job }) => ({
      ok: true,
      value: null,
      provenance: job.target
        ? {
            provider: job.target.providerId,
            modelId: job.target.modelId,
            at: "2026-07-14T12:00:00.000Z",
            inputVersionRefs: job.inputSnapshot,
            promptVersion: "fixture-prompt-v1",
            referenceAssetIds: [],
            attempt: job.attempts,
            settingsSnapshotHash: job.target.settingsHash,
          }
        : undefined,
    }),
    commit: ({ provenance }) => ({ resultRefs: [], provenance }),
  };
}

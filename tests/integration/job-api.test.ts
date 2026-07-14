import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, type HekayatiRuntime } from "../../src/server/app.js";
import type { Settings } from "../../src/domain/settings/settings.js";
import { localJobRequestSchema } from "../../src/jobs/schemas.js";
import type {
  EnqueueJobInput,
  RegisteredJobDefinition,
} from "../../src/jobs/types.js";
import { httpRequest } from "../helpers/http.js";
import { temporaryDirectory } from "../helpers/temp.js";

const hash = "2".repeat(64);
const projectId = "01J00000000000000000000001";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("job API", () => {
  it("serves no-store safe projections and expected-revision actions", async () => {
    const fixture = await apiFixture();
    const job = fixture.runtime.jobs.scheduler.enqueue(input("api-actions"));

    const listed = await httpRequest(fixture.origin, "/api/jobs");
    expect(listed.status).toBe(200);
    expect(listed.headers["cache-control"]).toBe("no-store");
    expect(listed.body).not.toContain(hash);
    expect(listed.body).not.toContain("PRIVATE_VERSION_CANARY");
    const projection = JSON.parse(listed.body);
    expect(projection.jobs[0]).not.toHaveProperty("request");
    expect(projection.jobs[0]).not.toHaveProperty("inputSnapshot");

    const priority = await mutate(
      fixture,
      `/api/jobs/${job.id}/priority`,
      "PUT",
      { expectedRevision: 0, expectedState: "queued", priority: 5 },
    );
    expect(priority.status).toBe(200);
    expect(JSON.parse(priority.body)).toMatchObject({
      id: job.id,
      revision: 1,
      priority: 5,
    });
    expect(priority.body).not.toContain(hash);

    const stale = await mutate(fixture, `/api/jobs/${job.id}/priority`, "PUT", {
      expectedRevision: 0,
      expectedState: "queued",
      priority: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toBe('{"code":"JOB_REVISION_CONFLICT"}');

    const paused = await mutate(fixture, `/api/jobs/${job.id}/pause`, "POST", {
      expectedRevision: 1,
      expectedState: "queued",
    });
    expect(JSON.parse(paused.body)).toMatchObject({
      state: "paused",
      stateReason: "operator",
    });
    const resumed = await mutate(
      fixture,
      `/api/jobs/${job.id}/resume`,
      "POST",
      { expectedRevision: 2, expectedState: "paused" },
    );
    expect(JSON.parse(resumed.body)).toMatchObject({ state: "queued" });
    const canceled = await mutate(
      fixture,
      `/api/jobs/${job.id}/cancel`,
      "POST",
      { expectedRevision: 3, expectedState: "queued" },
    );
    expect(JSON.parse(canceled.body)).toMatchObject({ state: "canceled" });
    expect(fixture.executions()).toBe(0);
  });

  it("keeps queue reads side-effect free and requires the local CSRF boundary", async () => {
    const fixture = await apiFixture();
    fixture.runtime.jobs.scheduler.enqueue(input("side-effect-free"));
    const health = await httpRequest(fixture.origin, "/api/health");
    expect(JSON.parse(health.body).queue).toMatchObject({
      status: "available",
      workerStatus: "running",
      depth: 1,
    });
    await httpRequest(fixture.origin, "/api/jobs");
    await httpRequest(fixture.origin, "/api/jobs");
    expect(fixture.executions()).toBe(0);

    const denied = await httpRequest(
      fixture.origin,
      `/api/jobs/${fixture.runtime.jobs.scheduler.list()[0]?.id}/pause`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 0, expectedState: "queued" }),
      },
    );
    expect(denied.status).toBe(403);
  });

  it("requires impact confirmation for provider target settings changes", async () => {
    const fixture = await apiFixture();
    const original = fixture.runtime.jobs.scheduler.enqueue(
      providerInput("settings-retarget"),
    );
    const current = JSON.parse(
      (await httpRequest(fixture.origin, "/api/settings")).body,
    ) as Settings;
    const update = settingsUpdate(current, { textProvider: "gemini" });

    const direct = await mutate(fixture, "/api/settings", "PUT", update);
    expect(direct).toMatchObject({ status: 409 });
    expect(direct.body).toBe(
      '{"code":"SETTINGS_TARGET_CHANGE_CONFIRMATION_REQUIRED"}',
    );

    const previewResponse = await mutate(
      fixture,
      "/api/settings/target-change/preview",
      "POST",
      update,
    );
    expect(previewResponse.headers["cache-control"]).toBe("no-store");
    const preview = JSON.parse(previewResponse.body);
    expect(preview).toMatchObject({
      requiresConfirmation: true,
      affected: [{ id: original.id }],
    });

    const confirmed = await mutate(
      fixture,
      "/api/settings/target-change/confirm",
      "POST",
      {
        update,
        expectedSettingsUpdatedAt: preview.expectedSettingsUpdatedAt,
        impactHash: preview.impactHash,
      },
    );
    expect(confirmed.status).toBe(200);
    const result = JSON.parse(confirmed.body);
    expect(result.settings.textProvider).toBe("gemini");
    expect(result.successorJobIds).toHaveLength(1);
    expect(fixture.runtime.jobs.scheduler.get(original.id)).toMatchObject({
      state: "canceled",
      stateReason: "superseded",
      successorJobIds: result.successorJobIds,
    });
    expect(
      fixture.runtime.jobs.scheduler.get(result.successorJobIds[0]),
    ).toMatchObject({
      state: "paused",
      stateReason: "provider_unavailable",
      target: { providerId: "gemini", operation: "text" },
    });
  });
});

async function apiFixture() {
  const directory = await temporaryDirectory("hekayati-job-api-");
  cleanups.push(directory.cleanup);
  let executionCount = 0;
  const runtime = await createRuntime({
    dataDir: directory.path,
    serveUi: false,
    jobs: {
      definitions: [fixtureDefinition(() => (executionCount += 1))],
      pollIntervalMs: 60_000,
      maxWorkers: 1,
    },
  });
  const origin = await runtime.start();
  cleanups.push(runtime.close);
  const bootstrap = JSON.parse(
    (await httpRequest(origin, "/api/bootstrap")).body,
  ) as { csrfToken: string };
  return {
    runtime,
    origin,
    csrfToken: bootstrap.csrfToken,
    executions: () => executionCount,
  };
}

function mutate(
  fixture: {
    runtime: HekayatiRuntime;
    origin: string;
    csrfToken: string;
  },
  path: string,
  method: "POST" | "PUT",
  body: unknown,
) {
  return httpRequest(fixture.origin, path, {
    method,
    headers: {
      origin: fixture.origin,
      "x-hekayati-csrf": fixture.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
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
    inputSnapshot: { projectVersion: "PRIVATE_VERSION_CANARY" },
  };
}

function providerInput(intentId: string): EnqueueJobInput {
  return {
    ...input(intentId),
    target: {
      providerId: "mock",
      modelId: "mock-v1",
      operation: "text",
      settingsHash: hash,
    },
  };
}

function settingsUpdate(settings: Settings, changes: Partial<Settings>) {
  return {
    textProvider: settings.textProvider,
    imageProvider: settings.imageProvider,
    geminiImageTier: settings.geminiImageTier,
    models: settings.models,
    concurrencyPerProvider: settings.concurrencyPerProvider,
    typography: settings.typography,
    watermarkText: settings.watermarkText,
    diskWarnGb: settings.diskWarnGb,
    photoUploadMaxMb: settings.photoUploadMaxMb,
    photoMaxMegapixels: settings.photoMaxMegapixels,
    firstRunAcknowledged: settings.firstRunAcknowledged,
    ...changes,
  };
}

function fixtureDefinition(onExecute: () => void): RegisteredJobDefinition {
  return {
    jobType: "fixture_noop",
    requestSchema: localJobRequestSchema,
    validateEnqueue: () => undefined,
    prepare: async () => ({}),
    execute: async () => {
      onExecute();
      return { ok: true, value: null };
    },
    commit: () => ({ resultRefs: [] }),
  };
}

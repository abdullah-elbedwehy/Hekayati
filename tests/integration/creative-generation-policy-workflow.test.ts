import { afterEach, describe, expect, it } from "vitest";

import { resolveDataPaths } from "../../src/config/paths.js";
import { LibraryService } from "../../src/domain/library/index.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { SettingsService } from "../../src/domain/settings/settings.js";
import { CreativeRepositories } from "../../src/domain/creative/repositories.js";
import { deterministicStructuredFixture } from "../../src/providers/mock/deterministic-fixtures.js";
import { createRuntime } from "../../src/server/app.js";
import {
  seedCreativeProject,
  waitForValue,
} from "../helpers/creative-fixtures.js";
import { httpRequest } from "../helpers/http.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("creative generation policy workflow", () => {
  it("keeps named-IP sheet work at zero jobs until the exact prompt confirmation is supplied", async () => {
    const directory = await temporaryDirectory("hekayati-policy-workflow-");
    cleanups.push(directory.cleanup);
    const seeded = await seedCreativeProject(directory.path, "", false, {
      appearanceDescription: "طفلة خيالية أصلية بأسلوب Disney",
    });
    const fixture = await startApi(directory.path);
    const { runtime } = fixture;
    const path = sheetPath(seeded);
    const input = {
      characterId: seeded.characterId,
      expectedProjectVersionId: seeded.projectVersionId,
    };

    const challenge = await mutate(fixture, path, input);
    expect(challenge.status).toBe(409);
    const challengeBody = errorBody(challenge.body);
    expect(challengeBody).toMatchObject({
      code: "CREATIVE_POLICY_CONFIRMATION_REQUIRED",
      details: {
        policyVersion: "prompt-policy-v1",
        bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        matchedCategories: ["franchise_trademark"],
      },
    });
    expect(runtime.jobs.scheduler.list()).toHaveLength(0);
    expect(
      runtime.creative.sheets.listProjectIntents(seeded.projectId),
    ).toHaveLength(0);

    const stale = await mutate(fixture, path, {
      ...input,
      confirmations: {
        prompt: {
          policyVersion: "prompt-policy-v1",
          bindingHash: "0".repeat(64),
          confirmed: true,
        },
      },
    });
    expect(stale.status).toBe(409);
    expect(errorBody(stale.body).code).toBe(
      "CREATIVE_POLICY_CONFIRMATION_STALE",
    );
    expect(runtime.jobs.scheduler.list()).toHaveLength(0);
    expect(
      runtime.creative.sheets.listProjectIntents(seeded.projectId),
    ).toHaveLength(0);

    const bindingHash = requireDetailString(challengeBody, "bindingHash");
    const accepted = await mutate(fixture, path, {
      ...input,
      confirmations: {
        prompt: {
          policyVersion: "prompt-policy-v1",
          bindingHash,
          confirmed: true,
        },
      },
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = JSON.parse(accepted.body) as {
      intent: { id: string; policyPlan: unknown };
      jobs: unknown[];
    };
    expect(acceptedBody.jobs).toHaveLength(6);
    expect(runtime.jobs.scheduler.list()).toHaveLength(6);
    const intent = runtime.creative.sheets.getIntent(acceptedBody.intent.id);
    expect(intent.policyPlan.prompt).toMatchObject({
      status: "transformed",
      policyVersion: "prompt-policy-v1",
      bindingHash,
      matchedCategories: ["franchise_trademark"],
    });
    expect(JSON.stringify(runtime.jobs.scheduler.list())).not.toMatch(
      /Disney/i,
    );
  });

  it("reduces references deterministically only after an exact capacity confirmation", async () => {
    const directory = await temporaryDirectory("hekayati-capacity-workflow-");
    cleanups.push(directory.cleanup);
    const seeded = await seedCreativeProject(directory.path, "", false, {
      referencePhotoCount: 2,
    });
    configureGemini(directory.path, seeded.scope.customerId, true);
    const fixture = await startApi(directory.path, {
      maxReferenceImages: 1,
      reliableCharacterCount: 1,
    });
    const { runtime } = fixture;
    const path = sheetPath(seeded);
    const input = {
      characterId: seeded.characterId,
      expectedProjectVersionId: seeded.projectVersionId,
    };

    const challenge = await mutate(fixture, path, input);
    expect(challenge.status).toBe(409);
    const challengeBody = errorBody(challenge.body);
    expect(challengeBody).toMatchObject({
      code: "CREATIVE_CAPACITY_CONFIRMATION_REQUIRED",
      details: {
        bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        maxReferenceImages: 1,
        reliableCharacterCount: 1,
        counts: [
          {
            characterId: seeded.characterId,
            requested: 2,
            selected: 1,
          },
        ],
      },
    });
    expect(runtime.jobs.scheduler.list()).toHaveLength(0);
    expect(
      runtime.creative.sheets.listProjectIntents(seeded.projectId),
    ).toHaveLength(0);

    const stale = await mutate(fixture, path, {
      ...input,
      confirmations: {
        capacity: { bindingHash: "f".repeat(64), confirmed: true },
      },
    });
    expect(stale.status).toBe(409);
    expect(errorBody(stale.body).code).toBe(
      "CREATIVE_CAPACITY_CONFIRMATION_STALE",
    );
    expect(runtime.jobs.scheduler.list()).toHaveLength(0);

    const bindingHash = requireDetailString(challengeBody, "bindingHash");
    const accepted = await mutate(fixture, path, {
      ...input,
      confirmations: {
        capacity: { bindingHash, confirmed: true },
      },
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = JSON.parse(accepted.body) as {
      intent: { id: string };
      jobs: unknown[];
    };
    expect(acceptedBody.jobs).toHaveLength(6);
    const intent = runtime.creative.sheets.getIntent(acceptedBody.intent.id);
    expect(intent.referencePhotoIds).toEqual([seeded.photoIds[0]]);
    expect(intent.policyPlan.capacity).toMatchObject({
      bindingHash,
      maxReferenceImages: 1,
      reliableCharacterCount: 1,
      reduced: true,
      confirmed: true,
    });
    expect(intent.policyPlan.capacity.selectedAssetIds).toHaveLength(1);
    const imageJobs = runtime.jobs.scheduler
      .list()
      .filter((job) => job.jobType === "character_sheet_view");
    expect(imageJobs).toHaveLength(5);
    for (const job of imageJobs) {
      if (job.request.kind !== "image") throw new Error("EXPECTED_IMAGE_JOB");
      expect(job.request.request.referenceImages).toHaveLength(1);
      expect(job.request.request.capacityPlan).toEqual(
        intent.policyPlan.capacity,
      );
    }
  });

  it("fails closed on unverified image limits without persisting intent or jobs", async () => {
    const directory = await temporaryDirectory("hekayati-null-capacity-");
    cleanups.push(directory.cleanup);
    const seeded = await seedCreativeProject(directory.path);
    configureGemini(directory.path);
    const fixture = await startApi(directory.path, {
      maxReferenceImages: null,
      reliableCharacterCount: null,
    });

    const response = await mutate(fixture, sheetPath(seeded), {
      characterId: seeded.characterId,
      expectedProjectVersionId: seeded.projectVersionId,
    });
    expect(response.status).toBe(409);
    expect(errorBody(response.body)).toMatchObject({
      code: "CREATIVE_CAPABILITY_UNAVAILABLE",
      details: {
        providerId: "gemini",
        reason: "unverified_image_limits",
      },
    });
    expect(fixture.runtime.jobs.scheduler.list()).toHaveLength(0);
    expect(
      fixture.runtime.creative.sheets.listProjectIntents(seeded.projectId),
    ).toHaveLength(0);
  });

  it("rejects forbidden structured output before stage persistence or child enqueue", async () => {
    const directory = await temporaryDirectory("hekayati-output-policy-");
    cleanups.push(directory.cleanup);
    const seeded = await seedCreativeProject(directory.path);
    const runtime = await createRuntime({
      dataDir: directory.path,
      serveUi: false,
      jobs: { pollIntervalMs: 2 },
      providers: { mockStructuredFixture: forbiddenStoryPlanFixture },
    });
    cleanups.push(() => runtime.close());
    await runtime.start();

    const startedSheet = runtime.creative.sheetPipeline.start(
      seeded.scope,
      seeded.projectId,
      {
        characterId: seeded.characterId,
        expectedProjectVersionId: seeded.projectVersionId,
      },
    );
    const readyIntent = await waitForValue(() => {
      const intent = runtime.creative.sheets.getIntent(startedSheet.intent.id);
      return intent.status === "ready" && intent.approvalGateJobId
        ? intent
        : null;
    });
    const sheet = runtime.creative.sheets.getSheet(readyIntent.sheetId);
    const approvalGate = runtime.jobs.scheduler.get(
      readyIntent.approvalGateJobId!,
    )!;
    runtime.creative.sheets.approveSheet({
      sheetId: sheet.id,
      expectedSheetRevision: sheet.revision,
      intentId: readyIntent.id,
      expectedIntentRevision: readyIntent.revision,
      gateJobId: approvalGate.id,
      expectedGateRevision: approvalGate.revision,
      notes: "اعتماد اصطناعي",
    });

    const startedRun = runtime.creative.pipeline.startRun(
      seeded.scope,
      seeded.projectId,
      {
        expectedProjectVersionId: seeded.projectVersionId,
        expectedStoryVersionId: seeded.storyVersionId,
      },
    );
    const failed = await waitForValue(() => {
      const job = runtime.jobs.scheduler.get(startedRun.firstJob.id);
      return job?.state === "failed" ? job : null;
    });
    expect(failed).toMatchObject({
      jobType: "story_plan",
      resultRefs: [],
      failure: {
        category: "stale_dependency",
        reasonCode: "CREATIVE_POLICY_OUTPUT_REJECTED",
      },
    });
    expect(
      runtime.jobs.scheduler
        .list()
        .filter((job) => job.projectId === seeded.projectId)
        .some((job) => job.jobType === "story_text"),
    ).toBe(false);

    await runtime.close();
    const store = new DocumentStore(resolveDataPaths(directory.path).database);
    expect(
      new CreativeRepositories(store).stages.queryByField(
        "runId",
        startedRun.run.id,
      ),
    ).toHaveLength(0);
    store.close();
  }, 30_000);
});

async function startApi(
  dataDir: string,
  geminiLimits?: {
    maxReferenceImages: number | null;
    reliableCharacterCount: number | null;
  },
) {
  const runtime = await createRuntime({
    dataDir,
    serveUi: false,
    jobs: { pollIntervalMs: 60_000, maxWorkers: 1 },
    providers: geminiLimits ? { geminiLimits } : undefined,
  });
  cleanups.push(() => runtime.close());
  const origin = await runtime.start();
  const bootstrap = await httpRequest(origin, "/api/bootstrap");
  expect(bootstrap.status).toBe(200);
  return {
    runtime,
    origin,
    csrf: String(
      (JSON.parse(bootstrap.body) as { csrfToken: string }).csrfToken,
    ),
  };
}

function configureGemini(
  dataDir: string,
  customerId?: string,
  grantConsent = false,
): void {
  const paths = resolveDataPaths(dataDir);
  const store = new DocumentStore(paths.database);
  const settings = new SettingsService(store, paths);
  settings.initialize();
  const current = settings.get();
  settings.update({
    textProvider: current.textProvider,
    imageProvider: "gemini",
    geminiImageTier: current.geminiImageTier,
    models: current.models,
    concurrencyPerProvider: current.concurrencyPerProvider,
    typography: current.typography,
    watermarkText: current.watermarkText,
    diskWarnGb: current.diskWarnGb,
    photoUploadMaxMb: current.photoUploadMaxMb,
    photoMaxMegapixels: current.photoMaxMegapixels,
    firstRunAcknowledged: current.firstRunAcknowledged,
  });
  if (customerId && grantConsent) {
    new LibraryService(store).recordConsent(customerId, {
      granted: true,
      date: new Date().toISOString(),
      note: "موافقة اصطناعية لاختبار السعة",
    });
  }
  store.close();
}

function sheetPath(seeded: Awaited<ReturnType<typeof seedCreativeProject>>) {
  return `/api/creative/projects/${seeded.projectId}/sheets?familyId=${seeded.scope.familyId}`;
}

function mutate(
  fixture: { origin: string; csrf: string },
  path: string,
  body: unknown,
) {
  return httpRequest(fixture.origin, path, {
    method: "POST",
    headers: {
      origin: fixture.origin,
      "content-type": "application/json",
      "x-hekayati-csrf": fixture.csrf,
    },
    body: JSON.stringify(body),
  });
}

function errorBody(body: string): {
  code: string;
  details?: Record<string, unknown>;
} {
  return JSON.parse(body) as {
    code: string;
    details?: Record<string, unknown>;
  };
}

function requireDetailString(
  response: ReturnType<typeof errorBody>,
  key: string,
): string {
  const value = response.details?.[key];
  if (typeof value !== "string") throw new Error(`MISSING_${key}`);
  return value;
}

function forbiddenStoryPlanFixture(
  task: Parameters<typeof deterministicStructuredFixture>[0],
  hash: string,
) {
  const value = deterministicStructuredFixture(task, hash);
  if (task.schemaId !== "StoryPlan") return value;
  return { ...(value as Record<string, unknown>), title: "Disney ممنوع" };
}

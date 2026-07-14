import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { AssetStore } from "../../src/assets/asset-store.js";
import { resolveDataPaths } from "../../src/config/paths.js";
import { CreativeSheetService } from "../../src/domain/creative/sheets.js";
import { LibraryService } from "../../src/domain/library/index.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { createLibraryImageReferenceResolver } from "../../src/jobs/image-references.js";
import { PreDispatchCoordinator } from "../../src/jobs/pre-dispatch.js";
import { MockFaultScript } from "../../src/providers/mock/fault-script.js";
import { createRuntime } from "../../src/server/app.js";
import {
  completedCreativeChecks,
  seedCreativeProject,
  waitForValue,
} from "../helpers/creative-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("creative runtime graph", () => {
  it("generates and approves a sheet, then completes a 16-page mock book", async () => {
    const directory = await temporaryDirectory("hekayati-creative-runtime-");
    cleanups.push(directory.cleanup);
    const seeded = await seedCreativeProject(directory.path);
    const runtime = await createRuntime({
      dataDir: directory.path,
      serveUi: false,
      jobs: { pollIntervalMs: 2 },
    });
    cleanups.push(() => runtime.close());
    const origin = await runtime.start();

    const startedSheet = runtime.creative.sheetPipeline.start(
      seeded.scope,
      seeded.projectId,
      {
        characterId: seeded.characterId,
        expectedProjectVersionId: seeded.projectVersionId,
      },
    );
    const readyIntent = await waitForValue(
      () => {
        const intent = runtime.creative.sheets.getIntent(
          startedSheet.intent.id,
        );
        return intent.status === "ready" && intent.approvalGateJobId
          ? intent
          : null;
      },
      10_000,
      () =>
        JSON.stringify(
          runtime.jobs.scheduler.list().map((job) => ({
            type: job.jobType,
            state: job.state,
            failure: job.failure,
          })),
        ),
    );
    const sheet = runtime.creative.sheets.getSheet(readyIntent.sheetId);
    const gate = runtime.jobs.scheduler.get(readyIntent.approvalGateJobId!)!;
    const approved = runtime.creative.sheets.approveSheet({
      sheetId: sheet.id,
      expectedSheetRevision: sheet.revision,
      intentId: readyIntent.id,
      expectedIntentRevision: readyIntent.revision,
      gateJobId: gate.id,
      expectedGateRevision: gate.revision,
      notes: "اعتماد اصطناعي",
    });
    expect(approved.sheet.status).toBe("approved");
    expect(Object.values(approved.sheet.views)).toHaveLength(5);

    const startedRun = runtime.creative.pipeline.startRun(
      seeded.scope,
      seeded.projectId,
      {
        expectedProjectVersionId: seeded.projectVersionId,
        expectedStoryVersionId: seeded.storyVersionId,
      },
    );
    const reviewRun = await waitForValue(() => {
      const run = runtime.creative.pipeline.getRun(startedRun.run.id);
      return run.status === "internal_review" ? run : null;
    });
    const pages = runtime.creative.pages
      .listProjectPages(seeded.projectId)
      .filter((page) => page.kind === "story");
    expect(pages).toHaveLength(12);
    expect(
      reviewRun.nodes.filter((node) => node.kind === "page_illustration"),
    ).toHaveLength(12);
    expect(pages.every((page) => page.currentIllustrationVersionId)).toBe(true);

    const beforeRegeneration = await pageEvidence(
      runtime,
      origin,
      seeded.scope.familyId,
      seeded.projectId,
    );
    const target = pages.find((page) => page.storyPageIndex === 7)!;
    runtime.creative.pipeline.regenerateIllustration({
      runId: reviewRun.id,
      pageId: target.id,
      expectedPageRevision: target.revision,
    });
    await waitForValue(() => {
      const current = runtime.creative.pages.getPage(target.id);
      return current.currentIllustrationVersionId !==
        target.currentIllustrationVersionId
        ? current
        : null;
    });
    const afterRegeneration = await pageEvidence(
      runtime,
      origin,
      seeded.scope.familyId,
      seeded.projectId,
    );
    expect(afterRegeneration.get(7)?.illustrationVersionId).not.toBe(
      beforeRegeneration.get(7)?.illustrationVersionId,
    );
    expect(afterRegeneration.get(7)?.assetId).not.toBe(
      beforeRegeneration.get(7)?.assetId,
    );
    expect(afterRegeneration.get(7)?.sha256).not.toBe(
      beforeRegeneration.get(7)?.sha256,
    );
    expect(afterRegeneration.get(7)?.textVersionId).toBe(
      beforeRegeneration.get(7)?.textVersionId,
    );
    for (const pageNumber of [...beforeRegeneration.keys()].filter(
      (item) => item !== 7,
    ))
      expect(afterRegeneration.get(pageNumber)).toEqual(
        beforeRegeneration.get(pageNumber),
      );

    for (const snapshot of runtime.creative.pages
      .listProjectPages(seeded.projectId)
      .filter((page) => page.kind === "story")) {
      const page = runtime.creative.pages.getPage(snapshot.id);
      runtime.creative.pages.recordReview({
        pageId: page.id,
        expectedRevision: page.revision,
        textVersionId: page.currentTextVersionId!,
        illustrationVersionId: page.currentIllustrationVersionId!,
        checks: completedCreativeChecks(),
        notes: "مراجعة اصطناعية",
      });
    }
    const currentRun = runtime.creative.pipeline.getRun(reviewRun.id);
    const reviewGate = runtime.jobs.scheduler.get(
      currentRun.internalReviewGateJobId!,
    )!;
    const complete = runtime.creative.pipeline.completeInternalReview({
      runId: currentRun.id,
      expectedRunRevision: currentRun.revision,
      gateJobId: reviewGate.id,
      expectedGateRevision: reviewGate.revision,
    });
    expect(complete.status).toBe("complete");
    expect(runtime.jobs.scheduler.get(reviewGate.id)?.state).toBe("succeeded");
  }, 120_000);

  it("keeps a creative safety refusal terminal with safe stage context", async () => {
    const directory = await temporaryDirectory("hekayati-creative-refusal-");
    cleanups.push(directory.cleanup);
    const seeded = await seedCreativeProject(directory.path);
    const runtime = await createRuntime({
      dataDir: directory.path,
      serveUi: false,
      jobs: { pollIntervalMs: 2 },
      providers: {
        mockFaults: new MockFaultScript([
          { operation: "image", category: "safety_refusal" },
        ]),
      },
    });
    cleanups.push(() => runtime.close());
    await runtime.start();
    runtime.creative.sheetPipeline.start(seeded.scope, seeded.projectId, {
      characterId: seeded.characterId,
      expectedProjectVersionId: seeded.projectVersionId,
    });
    const failed = await waitForValue(
      () =>
        runtime.jobs.scheduler
          .list()
          .find(
            (job) =>
              job.jobType === "character_sheet_view" && job.state === "failed",
          ) ?? null,
    );
    expect(failed).toMatchObject({
      attempts: 1,
      autoRetryIndex: 0,
      retrySchedule: null,
      failure: { category: "safety_refusal" },
    });
    expect(failed.inputSnapshot.view).toMatch(
      /^(face|front|threeQuarter|fullBody|mainOutfit)$/,
    );
    expect(failed.failure).not.toHaveProperty("detail");

    const originalIntentId = failed.inputSnapshot.intent;
    const originalJobCount = runtime.jobs.scheduler.list().length;
    const corrected = runtime.creative.sheetPipeline.start(
      seeded.scope,
      seeded.projectId,
      {
        characterId: seeded.characterId,
        expectedProjectVersionId: seeded.projectVersionId,
        revisionNotes: "تصحيح صريح: ملابس يومية بسيطة وخلفية محايدة",
      },
    );
    expect(corrected.intent.id).not.toBe(originalIntentId);
    expect(corrected.intent.revisionNotes).toContain("تصحيح صريح");
    expect(runtime.jobs.scheduler.list()).toHaveLength(originalJobCount + 6);
    const correctedReady = await waitForValue(() => {
      const intent = runtime.creative.sheets.getIntent(corrected.intent.id);
      return intent.status === "ready" ? intent : null;
    });
    expect(correctedReady.sheetId).not.toBe(
      runtime.creative.sheets.getIntent(originalIntentId).sheetId,
    );
    expect(runtime.jobs.scheduler.get(failed.id)).toMatchObject({
      attempts: 1,
      state: "failed",
      failure: { category: "safety_refusal" },
    });
  }, 30_000);

  it("lets sibling page branches finish when one illustration is refused", async () => {
    const directory = await temporaryDirectory("hekayati-creative-branch-");
    cleanups.push(directory.cleanup);
    const seeded = await seedCreativeProject(directory.path, "-branch");
    const sheetRuntime = await createRuntime({
      dataDir: directory.path,
      serveUi: false,
      jobs: { pollIntervalMs: 2 },
    });
    await sheetRuntime.start();
    const startedSheet = sheetRuntime.creative.sheetPipeline.start(
      seeded.scope,
      seeded.projectId,
      {
        characterId: seeded.characterId,
        expectedProjectVersionId: seeded.projectVersionId,
      },
    );
    const readyIntent = await waitForValue(() => {
      const intent = sheetRuntime.creative.sheets.getIntent(
        startedSheet.intent.id,
      );
      return intent.status === "ready" && intent.approvalGateJobId
        ? intent
        : null;
    });
    const sheet = sheetRuntime.creative.sheets.getSheet(readyIntent.sheetId);
    const gate = sheetRuntime.jobs.scheduler.get(
      readyIntent.approvalGateJobId!,
    )!;
    sheetRuntime.creative.sheets.approveSheet({
      sheetId: sheet.id,
      expectedSheetRevision: sheet.revision,
      intentId: readyIntent.id,
      expectedIntentRevision: readyIntent.revision,
      gateJobId: gate.id,
      expectedGateRevision: gate.revision,
      notes: "اعتماد اصطناعي",
    });
    await sheetRuntime.close();

    const runtime = await createRuntime({
      dataDir: directory.path,
      serveUi: false,
      jobs: { pollIntervalMs: 2, concurrencyPerProvider: 1 },
      providers: {
        mockFaults: new MockFaultScript([
          { operation: "image", category: "safety_refusal" },
        ]),
      },
    });
    cleanups.push(() => runtime.close());
    await runtime.start();
    const startedRun = runtime.creative.pipeline.startRun(
      seeded.scope,
      seeded.projectId,
      {
        expectedProjectVersionId: seeded.projectVersionId,
        expectedStoryVersionId: seeded.storyVersionId,
      },
    );
    const imageJobs = await waitForValue(() => {
      const jobs = runtime.jobs.scheduler
        .list()
        .filter(
          (job) =>
            job.jobType === "page_illustration" &&
            job.inputSnapshot.run === startedRun.run.id,
        );
      return jobs.length === 12 &&
        jobs.every((job) => ["failed", "succeeded"].includes(job.state))
        ? jobs
        : null;
    });
    expect(imageJobs.filter((job) => job.state === "failed")).toHaveLength(1);
    expect(imageJobs.filter((job) => job.state === "succeeded")).toHaveLength(
      11,
    );
    expect(imageJobs.find((job) => job.state === "failed")).toMatchObject({
      attempts: 1,
      autoRetryIndex: 0,
      failure: { category: "safety_refusal" },
    });
    const pages = runtime.creative.pages
      .listProjectPages(seeded.projectId)
      .filter((page) => page.kind === "story");
    expect(
      pages.filter((page) => page.currentIllustrationVersionId !== null),
    ).toHaveLength(11);
    expect(
      pages.filter((page) => page.currentIllustrationVersionId === null),
    ).toHaveLength(1);
    expect(runtime.creative.pipeline.getRun(startedRun.run.id).status).toBe(
      "generating",
    );
  }, 90_000);

  it("blocks photo-bearing sheet work before enqueue without current consent", async () => {
    const directory = await temporaryDirectory("hekayati-creative-consent-");
    cleanups.push(directory.cleanup);
    const seeded = await seedCreativeProject(directory.path, "", true);
    const runtime = await createRuntime({
      dataDir: directory.path,
      serveUi: false,
      jobs: { pollIntervalMs: 2 },
    });
    await runtime.start();
    const enqueue = () =>
      runtime.creative.sheetPipeline.start(seeded.scope, seeded.projectId, {
        characterId: seeded.characterId,
        expectedProjectVersionId: seeded.projectVersionId,
      });
    const before = runtime.jobs.scheduler.list().length;
    expect(enqueue).toThrowError(
      expect.objectContaining({ code: "PHOTO_CONSENT_NOT_RECORDED" }),
    );
    expect(runtime.jobs.scheduler.list()).toHaveLength(before);

    await runtime.close();
    const paths = resolveDataPaths(directory.path);
    const store = new DocumentStore(paths.database);
    new LibraryService(store).recordConsent(seeded.scope.customerId, {
      granted: false,
      date: new Date().toISOString(),
      note: "رفض اصطناعي",
    });
    store.close();
    const restarted = await createRuntime({
      dataDir: directory.path,
      serveUi: false,
      jobs: { pollIntervalMs: 2 },
    });
    cleanups.push(() => restarted.close());
    await restarted.start();
    const refusedEnqueue = () =>
      restarted.creative.sheetPipeline.start(seeded.scope, seeded.projectId, {
        characterId: seeded.characterId,
        expectedProjectVersionId: seeded.projectVersionId,
      });
    expect(refusedEnqueue).toThrowError(
      expect.objectContaining({ code: "PHOTO_CONSENT_NOT_GRANTED" }),
    );
    expect(restarted.jobs.scheduler.list()).toHaveLength(before);
  }, 30_000);

  it("rechecks revoked consent before capability acquisition or provider dispatch", async () => {
    const directory = await temporaryDirectory(
      "hekayati-creative-predispatch-consent-",
    );
    cleanups.push(directory.cleanup);
    const seeded = await seedCreativeProject(directory.path, "-revoked", true);
    const paths = resolveDataPaths(directory.path);
    const consentStore = new DocumentStore(paths.database);
    const consentLibrary = new LibraryService(consentStore);
    consentLibrary.recordConsent(seeded.scope.customerId, {
      granted: true,
      date: new Date().toISOString(),
      note: "موافقة اصطناعية مؤقتة",
    });
    consentStore.close();

    const runtime = await createRuntime({
      dataDir: directory.path,
      serveUi: false,
      jobs: { pollIntervalMs: 60_000 },
    });
    cleanups.push(() => runtime.close());
    const started = runtime.creative.sheetPipeline.start(
      seeded.scope,
      seeded.projectId,
      {
        characterId: seeded.characterId,
        expectedProjectVersionId: seeded.projectVersionId,
      },
    );
    const viewJob = started.jobs.find(
      (job) => job.jobType === "character_sheet_view",
    )!;
    await runtime.close();

    const boundaryStore = new DocumentStore(paths.database);
    const boundaryLibrary = new LibraryService(boundaryStore);
    boundaryLibrary.recordConsent(seeded.scope.customerId, {
      granted: false,
      date: new Date().toISOString(),
      note: "سحب موافقة اصطناعي قبل الإرسال",
    });
    const assets = new AssetStore(boundaryStore, paths.assets);
    const sheets = new CreativeSheetService(boundaryStore, assets, null);
    let capabilityCalls = 0;
    const preDispatch = new PreDispatchCoordinator(
      {
        acquireExact: async () => {
          capabilityCalls += 1;
          throw new Error("CAPABILITY_MUST_NOT_RUN");
        },
      },
      createLibraryImageReferenceResolver(boundaryLibrary, assets, sheets),
    );
    await expect(
      preDispatch.prepare(
        viewJob,
        {
          assertCurrent: (job) => sheets.assertJobCurrent(job),
        },
        "revoked-consent-batch",
      ),
    ).rejects.toMatchObject({ code: "PHOTO_CONSENT_NOT_GRANTED" });
    expect(capabilityCalls).toBe(0);
    boundaryStore.close();
  });
});

async function pageEvidence(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  origin: string,
  familyId: string,
  projectId: string,
) {
  const entries = await Promise.all(
    runtime.creative.pages
      .listProjectPages(projectId)
      .filter((page) => page.kind === "story")
      .map(async (page) => {
        const illustration = runtime.creative.pages.getIllustrationVersion(
          page.currentIllustrationVersionId!,
        );
        const response = await fetch(
          `${origin}/api/creative/pages/${page.id}/illustration?familyId=${familyId}`,
        );
        if (!response.ok) throw new Error(`IMAGE_HTTP_${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        return [
          page.storyPageIndex!,
          {
            textVersionId: page.currentTextVersionId,
            promptVersionId: page.currentPromptVersionId,
            illustrationVersionId: page.currentIllustrationVersionId,
            assetId: illustration.assetId,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            provenance: illustration.provenance,
          },
        ] as const;
      }),
  );
  return new Map(entries);
}

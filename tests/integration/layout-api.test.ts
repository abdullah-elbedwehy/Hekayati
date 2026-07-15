import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";

import { AssetStore } from "../../src/assets/asset-store.js";
import { resolveDataPaths } from "../../src/config/paths.js";
import { initializeLayoutPersistence } from "../../src/domain/layout/migrations.js";
import type { LayoutProjectProjection } from "../../src/domain/layout/workspace.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { createRuntime } from "../../src/server/app.js";
import {
  seedCreativeProject,
  waitForValue,
} from "../helpers/creative-fixtures.js";
import { httpRequest } from "../helpers/http.js";
import { seedReviewedPages } from "../helpers/layout-workflow-fixture.js";
import { syntheticPreviewSource } from "../helpers/preview-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("layout preview and approval API", () => {
  it("scopes ready previews, downloads the indexed PDF, and preserves exact approval transitions", async () => {
    const fixture = await startFixture();
    const path = `/api/layout/projects/${fixture.seed.projectId}?familyId=${fixture.seed.scope.familyId}`;
    const projectRead = await httpRequest(fixture.origin, path);
    expect(projectRead.status).toBe(200);
    expect(projectRead.headers["cache-control"]).toBe("private, no-store");
    const initial = JSON.parse(projectRead.body) as LayoutProjectProjection;
    expect(initial.workflow?.state).toBe("ready");
    expect(initial.pages).toHaveLength(16);
    expect(initial.preview?.status).toBe("ready");
    expect(initial.approval?.state).toBe("ready_to_send");

    const pdf = await httpRequest(
      fixture.origin,
      `/api/layout/previews/${initial.preview!.id}/pdf?familyId=${fixture.seed.scope.familyId}`,
    );
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.headers["cache-control"]).toBe("private, no-store");
    expect(Buffer.byteLength(pdf.body)).toBeGreaterThan(1_000);

    expect(
      (
        await httpRequest(
          fixture.origin,
          `/api/layout/previews/${initial.preview!.id}/pdf?familyId=${fixture.foreign.scope.familyId}`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await httpRequest(
          fixture.origin,
          `/api/layout/previews/${initial.preview!.id}/pdf`,
        )
      ).status,
    ).toBe(400);

    const sent = await approvalMutation(fixture, initial, "sent", "send-1");
    expect(sent.status).toBe(200);
    expect(JSON.parse(sent.body)).toMatchObject({
      approvalState: "preview_sent",
      gateState: "waiting_review",
    });
    const sentState = fixture.runtime.layout.workspace.project(
      fixture.seed.projectId,
    );
    const approved = await approvalMutation(
      fixture,
      sentState,
      "approve",
      "approve-1",
    );
    expect(approved.status).toBe(200);
    expect(JSON.parse(approved.body)).toMatchObject({
      approvalState: "approved",
      gateState: "succeeded",
      projectStatus: "approved",
    });

    const status = await httpRequest(
      fixture.origin,
      `/api/layout/projects/${fixture.seed.projectId}/approved-snapshot-status?familyId=${fixture.seed.scope.familyId}`,
    );
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({
      state: "authorized",
      snapshot: { previewOutputId: initial.preview!.id },
    });
  }, 120_000);

  it("creates a same-content successor and atomically revokes prior authorization on scoped changes", async () => {
    const fixture = await startFixture();
    let state = fixture.runtime.layout.workspace.project(
      fixture.seed.projectId,
    );
    await approvalMutation(fixture, state, "sent", "send-initial");
    state = fixture.runtime.layout.workspace.project(fixture.seed.projectId);
    await approvalMutation(fixture, state, "approve", "approve-initial");
    state = fixture.runtime.layout.workspace.project(fixture.seed.projectId);
    const priorApprovalId = state.project.currentContentApprovalId;
    const priorOutputId = state.preview!.id;

    const regenerate = await mutate(
      fixture,
      `/api/layout/projects/${fixture.seed.projectId}/preview-regenerate?familyId=${fixture.seed.scope.familyId}`,
      {
        expectedProjectRevision: state.project.revision,
        expectedWorkflowRevision: state.workflow!.revision,
      },
    );
    expect(regenerate.status).toBe(200);
    state = await waitForValue(() => {
      const current = fixture.runtime.layout.workspace.project(
        fixture.seed.projectId,
      );
      return current.workflow?.state === "ready" &&
        current.preview?.id !== priorOutputId
        ? current
        : null;
    }, 90_000);
    expect(state.project.currentContentApprovalId).toBe(priorApprovalId);
    expect(state.project.status).toBe("approved");
    expect(state.preview!.customerContentHash).toBe(
      fixture.runtime.layout.workspace.preview(priorOutputId)
        .customerContentHash,
    );

    await approvalMutation(fixture, state, "sent", "send-successor");
    state = fixture.runtime.layout.workspace.project(fixture.seed.projectId);
    const response = await mutate(
      fixture,
      `/api/layout/previews/${state.preview!.id}/changes-requested?familyId=${fixture.seed.scope.familyId}`,
      {
        ...approvalBody(state, "change-successor"),
        notes: "تعديل الصفحة الأولى",
        affectedScopes: [
          {
            kind: "page",
            pageId: state.preview!.orderedInteriorPages[0].pageId,
          },
        ],
      },
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      approvalState: "changes_requested",
      gateState: "canceled",
      currentContentApprovalId: null,
      projectStatus: "revising",
    });
    const blocked = await httpRequest(
      fixture.origin,
      `/api/layout/projects/${fixture.seed.projectId}/approved-snapshot-status?familyId=${fixture.seed.scope.familyId}`,
    );
    expect(JSON.parse(blocked.body)).toMatchObject({
      state: "blocked",
      code: "APPROVED_SNAPSHOT_NOT_AUTHORIZED",
    });
  }, 120_000);

  it("appends operator special-page and cover successors while staling each prior preview", async () => {
    const fixture = await startFixture();
    let state = fixture.runtime.layout.workspace.project(
      fixture.seed.projectId,
    );
    const titlePage = state.pages.find((page) => page.kind === "title")!;
    const selectedAssetId = state
      .preview!.orderedInteriorPages.flatMap((page) => page.sourceAssets)
      .find((asset) => asset.role === "artwork")!.assetId;
    const firstOutputId = state.preview!.id;
    const firstCycleId = state.approval!.id;
    const firstGateId = state.approvalGate!.id;
    const firstBookVersion = state.project.bookVersion;

    const special = await mutate(
      fixture,
      `/api/layout/pages/${titlePage.pageId}/composition-source?familyId=${fixture.seed.scope.familyId}`,
      {
        expectedPageRevision: titlePage.revision,
        expectedWorkflowRevision: state.workflow!.revision,
        assetId: selectedAssetId,
        requestedPlacement: "top",
      },
    );
    expect(special.status).toBe(200);
    state = await waitForValue(() => {
      const current = fixture.runtime.layout.workspace.project(
        fixture.seed.projectId,
      );
      return current.workflow?.state === "ready" &&
        current.preview?.id !== firstOutputId
        ? current
        : null;
    }, 90_000);
    expect(
      fixture.runtime.layout.workspace.preview(firstOutputId),
    ).toMatchObject({
      status: "stale",
      staleReasons: ["IM-12"],
    });
    expect(fixture.runtime.layout.workspace.approval(firstCycleId).state).toBe(
      "invalidated",
    );
    expect(fixture.runtime.jobs.scheduler.get(firstGateId)?.state).toBe(
      "canceled",
    );
    expect(state.project.bookVersion).toBe(firstBookVersion + 1);
    expect(
      state.pages.find((page) => page.kind === "title")!.layout,
    ).toMatchObject({
      requestedPlacement: "top",
      inputSnapshot: {
        selectionSource: "operator",
        sourceAssets: [{ assetId: selectedAssetId }],
      },
    });

    const secondOutputId = state.preview!.id;
    const secondBookVersion = state.project.bookVersion;
    const cover = await mutate(
      fixture,
      `/api/layout/projects/${fixture.seed.projectId}/cover-composition?familyId=${fixture.seed.scope.familyId}`,
      {
        expectedProjectRevision: state.project.revision,
        expectedWorkflowRevision: state.workflow!.revision,
        expectedCoverVersionId: state.cover!.id,
        frontArtworkAssetId: selectedAssetId,
        backArtworkAssetId: null,
        environmentLine: "رحلة بين النجوم 2026",
        synopsis: "مغامرة اصطناعية آمنة.",
      },
    );
    expect(cover.status).toBe(200);
    state = await waitForValue(() => {
      const current = fixture.runtime.layout.workspace.project(
        fixture.seed.projectId,
      );
      return current.workflow?.state === "ready" &&
        current.preview?.id !== secondOutputId
        ? current
        : null;
    }, 90_000);
    expect(
      fixture.runtime.layout.workspace.preview(secondOutputId).status,
    ).toBe("stale");
    expect(state.project.bookVersion).toBe(secondBookVersion + 1);
    expect(state.cover).toMatchObject({
      selectionSource: "operator",
      front: {
        artworkAssetId: selectedAssetId,
        environmentLine: "رحلة بين النجوم 2026",
      },
      back: { synopsis: "مغامرة اصطناعية آمنة." },
    });
  }, 120_000);

  it("emits IM-19 and IM-20 from real settings and integrity routes while preserving content authorization", async () => {
    const fixture = await startFixture();
    let state = fixture.runtime.layout.workspace.project(
      fixture.seed.projectId,
    );
    await approvalMutation(fixture, state, "sent", "producer-send");
    state = fixture.runtime.layout.workspace.project(fixture.seed.projectId);
    await approvalMutation(fixture, state, "approve", "producer-approve");
    state = fixture.runtime.layout.workspace.project(fixture.seed.projectId);
    const approvalId = state.project.currentContentApprovalId;

    const settings = JSON.parse(
      (await httpRequest(fixture.origin, "/api/settings")).body,
    ) as Record<string, unknown>;
    const watermark = await mutateMethod(
      fixture,
      "/api/settings",
      settingsUpdate(settings, "حكايتي — معاينة جديدة 2026"),
      "PUT",
    );
    expect(watermark.status).toBe(200);
    state = fixture.runtime.layout.workspace.project(fixture.seed.projectId);
    expect(state.preview).toMatchObject({
      status: "stale",
      staleReasons: ["IM-19"],
    });
    expect(state.contentApproval).toMatchObject({
      id: approvalId,
      state: "approved",
      attentionReasons: ["IM-19"],
    });
    expect(state.project.currentContentApprovalId).toBe(approvalId);

    await writeFile(fixture.sourcePath, Buffer.from("corrupt synthetic bytes"));
    const scan = await mutate(fixture, "/api/health/integrity-scan", {});
    expect(scan.status).toBe(200);
    expect(JSON.parse(scan.body)).toMatchObject({
      issues: [{ assetId: fixture.sourceAssetId, reason: "checksum_mismatch" }],
    });
    state = fixture.runtime.layout.workspace.project(fixture.seed.projectId);
    expect(state.contentApproval).toMatchObject({
      state: "approved",
      attentionReasons: ["IM-19", "IM-20"],
    });
    expect(state.project.currentContentApprovalId).toBe(approvalId);
    const blocked = await httpRequest(
      fixture.origin,
      `/api/layout/projects/${fixture.seed.projectId}/approved-snapshot-status?familyId=${fixture.seed.scope.familyId}`,
    );
    expect(JSON.parse(blocked.body)).toMatchObject({
      state: "blocked",
      code: "APPROVED_SNAPSHOT_INTEGRITY_FAILED",
    });

    await writeFile(fixture.sourcePath, fixture.sourceBytes);
    await mutate(fixture, "/api/health/integrity-scan", {});
    const restored = await httpRequest(
      fixture.origin,
      `/api/layout/projects/${fixture.seed.projectId}/approved-snapshot-status?familyId=${fixture.seed.scope.familyId}`,
    );
    expect(JSON.parse(restored.body)).toMatchObject({ state: "authorized" });
  }, 120_000);
});

async function startFixture() {
  const directory = await temporaryDirectory("hekayati-layout-api-");
  cleanups.push(directory.cleanup);
  const seed = await seedCreativeProject(directory.path, "-layout-api");
  const foreign = await seedCreativeProject(directory.path, "-foreign");
  const paths = resolveDataPaths(directory.path);
  const store = new DocumentStore(paths.database);
  initializeLayoutPersistence(store);
  const assets = new AssetStore(store, paths.assets);
  const sourceBytes = await syntheticPreviewSource();
  const source = await assets.put({
    bytes: sourceBytes,
    extension: "png",
    mime: "image/png",
    role: "illustration",
    origin: "derived",
    width: 1_400,
    height: 1_900,
  });
  const sourcePath = assets.pathForRecord(source);
  seedReviewedPages(store, seed.projectId, source.id);
  store.close();
  const runtime = await createRuntime({
    dataDir: directory.path,
    serveUi: false,
    jobs: { pollIntervalMs: 2 },
  });
  cleanups.push(() => runtime.close());
  const origin = await runtime.start();
  const bootstrap = JSON.parse(
    (await httpRequest(origin, "/api/bootstrap")).body,
  ) as { csrfToken: string };
  runtime.layout.workflow.start(seed.projectId);
  await waitForValue(() => {
    const current = runtime.layout.workspace.project(seed.projectId);
    return current.workflow?.state === "ready" ? current : null;
  }, 90_000);
  return {
    seed,
    foreign,
    runtime,
    origin,
    csrf: bootstrap.csrfToken,
    sourceAssetId: source.id,
    sourcePath,
    sourceBytes,
  };
}

function approvalMutation(
  fixture: Awaited<ReturnType<typeof startFixture>>,
  state: LayoutProjectProjection,
  route: "sent" | "approve",
  key: string,
) {
  return mutate(
    fixture,
    `/api/layout/previews/${state.preview!.id}/${route}?familyId=${fixture.seed.scope.familyId}`,
    approvalBody(state, key),
  );
}

function approvalBody(state: LayoutProjectProjection, idempotencyKey: string) {
  return {
    cycleId: state.approval!.id,
    idempotencyKey,
    customerContentHash: state.preview!.customerContentHash,
    approvalBundleHash: state.preview!.approvalBundleHash,
    expectedProjectRevision: state.project.revision,
    expectedPreviewOutputRevision: state.preview!.revision,
    expectedApprovalRevision: state.approval!.revision,
    expectedGateRevision: state.approvalGate!.revision,
    expectedContentApprovalId: state.project.currentContentApprovalId,
    expectedContentApprovalRevision: state.project.currentContentApprovalId
      ? state.contentApproval!.revision
      : null,
  };
}

function mutate(
  fixture: { origin: string; csrf: string },
  path: string,
  body: unknown,
) {
  return mutateMethod(fixture, path, body, "POST");
}

function mutateMethod(
  fixture: { origin: string; csrf: string },
  path: string,
  body: unknown,
  method: "POST" | "PUT",
) {
  return httpRequest(fixture.origin, path, {
    method,
    headers: {
      origin: fixture.origin,
      "content-type": "application/json",
      "x-hekayati-csrf": fixture.csrf,
    },
    body: JSON.stringify(body),
  });
}

function settingsUpdate(
  settings: Record<string, unknown>,
  watermarkText: string,
) {
  return {
    textProvider: settings.textProvider,
    imageProvider: settings.imageProvider,
    geminiImageTier: settings.geminiImageTier,
    models: settings.models,
    concurrencyPerProvider: settings.concurrencyPerProvider,
    typography: settings.typography,
    watermarkText,
    diskWarnGb: settings.diskWarnGb,
    photoUploadMaxMb: settings.photoUploadMaxMb,
    photoMaxMegapixels: settings.photoMaxMegapixels,
    firstRunAcknowledged: settings.firstRunAcknowledged,
  };
}

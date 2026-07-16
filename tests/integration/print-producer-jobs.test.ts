import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { AssetStore } from "../../src/assets/asset-store.js";
import { CreativeInvalidationService } from "../../src/domain/creative/invalidation.js";
import {
  ApprovedBookSnapshotReader,
  BookApprovalService,
} from "../../src/domain/layout/approvals.js";
import {
  compileCoverGeometry,
  compileInteriorGeometry,
  compileOutputPageMap,
} from "../../src/domain/print/geometry.js";
import { PrinterProfileService } from "../../src/domain/print/profiles.js";
import { PrintInvalidationParticipant } from "../../src/domain/print/invalidation.js";
import { PrintRepositories } from "../../src/domain/print/repositories.js";
import { createDefaultPrinterProfileDraft } from "../../src/domain/print/schemas.js";
import { PrintProductionService } from "../../src/domain/print/workflow.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import {
  createPrintProducerDefinitions,
  type PrintCompilerPort,
} from "../../src/jobs/print-definitions.js";
import { JobRuntime } from "../../src/jobs/runtime.js";
import { localJobRequestSchema } from "../../src/jobs/schemas.js";
import type { RegisteredJobDefinition } from "../../src/jobs/types.js";
import type {
  PrintCoverDocument,
  PrintInteriorDocument,
} from "../../src/pdf/print-document.js";
import {
  addPreviewBundle,
  approvalActionInput,
  createApprovalFixture,
  customerContentHash,
} from "../helpers/layout-approval-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("durable print artifact producers", () => {
  it("commits separate artifacts and enqueues one dependent preflight", async () => {
    const temp = await temporaryDirectory("hekayati-print-producers-");
    cleanups.push(temp.cleanup);
    const store = new DocumentStore(join(temp.path, "hekayati.db"));
    const assets = new AssetStore(store, join(temp.path, "assets"));
    const source = await assets.put({
      bytes: Buffer.from("synthetic-full-resolution-source"),
      extension: "png",
      mime: "image/png",
      role: "illustration",
      origin: "derived",
      width: 2480,
      height: 3508,
      dpi: 300,
    });
    const fixture = createApprovalFixture(store, {
      assetId: source.id,
      assetChecksum: source.sha256,
    });
    const bundle = addPreviewBundle(fixture);
    const approval = new BookApprovalService(store, fixture.scheduler);
    approval.act(approvalActionInput(fixture, bundle, "preview_sent", "send"));
    approval.act(approvalActionInput(fixture, bundle, "approved", "approve"));
    const profiles = new PrinterProfileService(store, assets);
    const profile = profiles.create({
      name: "Synthetic RGB",
      draft: {
        ...createDefaultPrinterProfileDraft(),
        spine: { source: "explicit", widthMm: 8 },
      },
    });
    const project = fixture.authoring.projects.get(fixture.projectId)!;
    profiles.assignProject({
      owner: fixture.owner,
      projectId: project.id,
      expectedProjectRevision: project.revision,
      profileId: profile.profile.id,
      expectedProfileRevision: profile.profile.revision,
      profileVersionId: profile.version.id,
    });

    const holder: { production: PrintProductionService | null } = {
      production: null,
    };
    const compiler = syntheticCompiler();
    let interiorRenders = 0;
    let coverRenders = 0;
    const definitions = createPrintProducerDefinitions({
      production: () => requireProduction(holder),
      compiler: () => compiler,
      assets,
      renderer: {
        interior: async () => {
          interiorRenders += 1;
          return renderResult("interior", 16);
        },
        cover: async () => {
          coverRenders += 1;
          return {
            ...renderResult("cover", 1),
            panelOrder: ["back", "spine", "front"],
          };
        },
      },
    });
    const runtime = new JobRuntime(store, {
      definitions: [...definitions, inertPreflightDefinition()],
      pollIntervalMs: 5,
      maxWorkers: 2,
      timeoutMs: 10_000,
    });
    const reader = new ApprovedBookSnapshotReader(
      store,
      runtime.scheduler,
      assets,
      { resolveCustomerContentHash: () => customerContentHash },
    );
    const production = new PrintProductionService(
      store,
      assets,
      runtime.scheduler,
      reader,
    );
    holder.production = production;
    const authorization = await reader.read(project.id);
    const current = fixture.authoring.projects.get(project.id)!;
    const started = await production.start({
      owner: fixture.owner,
      projectId: project.id,
      expectedProjectRevision: current.revision,
      profileId: profile.profile.id,
      expectedProfileRevision: profile.profile.revision,
      profileVersionId: profile.version.id,
      contentAuthorizationHash: authorization.contentAuthorizationHash,
      idempotencyKey: "producer-start",
    });
    runtime.start();
    await waitFor(() =>
      started.jobs.every(
        (job) => runtime.scheduler.get(job.id)?.state === "succeeded",
      ),
    );

    const print = new PrintRepositories(store);
    const run = print.runs.get(started.run.id)!;
    expect(print.artifacts.list()).toHaveLength(2);
    expect(
      print.artifacts
        .list()
        .map((artifact) => artifact.kind)
        .sort(),
    ).toEqual(["cover", "interior"]);
    expect(run).toMatchObject({
      state: "preflight_pending",
      currentInteriorArtifactId: expect.any(String),
      currentCoverArtifactId: expect.any(String),
      preflightJobId: expect.any(String),
    });
    expect(
      runtime.scheduler
        .list()
        .filter((job) => job.jobType === "print_preflight"),
    ).toHaveLength(1);
    expect(
      assets.list().filter((asset) => asset.role.startsWith("pdf_")),
    ).toHaveLength(2);
    expect({ interiorRenders, coverRenders }).toEqual({
      interiorRenders: 1,
      coverRenders: 1,
    });

    const invalidation = new CreativeInvalidationService(store);
    invalidation.bindGateController(runtime.scheduler);
    invalidation.bindParticipant(
      new PrintInvalidationParticipant(store, assets, runtime.scheduler),
    );
    invalidation.recordAndConsume({
      id: ulid(),
      entity: "cover_template",
      entityId: project.id,
      fromVersionId: profile.version.id,
      toVersionId: null,
      changeType: "cover_template",
      matrixRow: "IM-15",
      changedFields: ["spine.widthMm"],
      correlationId: ulid(),
    });
    const stale = print.runs.get(started.run.id)!;
    expect(stale).toMatchObject({
      state: "stale",
      currentInteriorArtifactId: run.currentInteriorArtifactId,
      currentCoverArtifactId: null,
      staleReasons: ["IM_15"],
    });

    const successorProfile = profiles.update({
      profileId: profile.profile.id,
      expectedRevision: profile.profile.revision,
      name: profile.profile.name,
      archived: false,
      draft: profileDraft(profile.version, 9),
    });
    const reassignable = fixture.authoring.projects.get(project.id)!;
    profiles.assignProject({
      owner: fixture.owner,
      projectId: project.id,
      expectedProjectRevision: reassignable.revision,
      profileId: successorProfile.profile.id,
      expectedProfileRevision: successorProfile.profile.revision,
      profileVersionId: successorProfile.version.id,
    });
    const successorProject = fixture.authoring.projects.get(project.id)!;
    const successor = await production.start({
      owner: fixture.owner,
      projectId: project.id,
      expectedProjectRevision: successorProject.revision,
      profileId: successorProfile.profile.id,
      expectedProfileRevision: successorProfile.profile.revision,
      profileVersionId: successorProfile.version.id,
      contentAuthorizationHash: authorization.contentAuthorizationHash,
      idempotencyKey: "producer-cover-only-successor",
    });
    expect(successor.jobs.map((job) => job.jobType)).toEqual([
      "print_interior_reuse",
      "print_cover",
    ]);
    await waitFor(
      () =>
        successor.jobs.every(
          (job) => runtime.scheduler.get(job.id)?.state === "succeeded",
        ),
      () => ({
        interiorRenders,
        coverRenders,
        jobs: successor.jobs.map((job) => {
          const current = runtime.scheduler.get(job.id);
          return {
            id: job.id,
            jobType: job.jobType,
            state: current?.state,
            failure: current?.failure,
            events: runtime.scheduler.events(job.id).slice(-2),
          };
        }),
      }),
    );
    await runtime.stop();

    const successorRun = print.runs.get(successor.run.id)!;
    const reused = print.artifacts.get(
      successorRun.currentInteriorArtifactId!,
    )!;
    const original = print.artifacts.get(run.currentInteriorArtifactId!)!;
    expect({ interiorRenders, coverRenders }).toEqual({
      interiorRenders: 1,
      coverRenders: 2,
    });
    expect(reused).toMatchObject({
      runId: successorRun.id,
      assetId: original.assetId,
      checksum: original.checksum,
      reusedFromArtifactId: original.id,
      printerProfileVersionId: successorProfile.version.id,
      printerProfileHash: successorProfile.version.profileHash,
    });
    expect(assets.get(original.assetId)?.refCount).toBe(2);
    expect(successorRun).toMatchObject({
      state: "preflight_pending",
      currentInteriorArtifactId: reused.id,
      currentCoverArtifactId: expect.any(String),
      preflightJobId: expect.any(String),
    });
    store.close();
  }, 20_000);
});

function syntheticCompiler(): PrintCompilerPort {
  return {
    compileInterior: async (context) => {
      const map = compileOutputPageMap(
        context.snapshot.orderedInteriorPages.map((page) => ({
          customerPageNumber: page.pageNumber,
          pageId: page.pageId,
        })),
        context.profileVersion.requiredBlankPages,
      );
      return {
        kind: "interior",
        profile: context.profileVersion,
        geometry: compileInteriorGeometry(context.profileVersion),
        sourceSnapshotHash: context.sourceSnapshotHash,
        fontManifestHash: context.output.fontManifestHash,
        pages: map.map((entry) => ({
          map: entry,
          pageKind: entry.kind === "printer_blank" ? "printer_blank" : "story",
          image: null,
          text: null,
          bubbles: [],
        })),
      } satisfies PrintInteriorDocument;
    },
    compileCover: async (context) =>
      ({
        kind: "cover",
        profile: context.profileVersion,
        geometry: compileCoverGeometry(context.profileVersion),
        sourceSnapshotHash: context.sourceSnapshotHash,
        fontManifestHash: context.cover.fontManifestHash,
        panels: [
          { kind: "back", image: null, text: null },
          { kind: "spine", image: null, text: null },
          { kind: "front", image: null, text: null },
        ],
      }) satisfies PrintCoverDocument,
  };
}

function profileDraft(
  version: ReturnType<PrinterProfileService["create"]>["version"],
  spineWidthMm: number,
) {
  return {
    trim: version.trim,
    bleedMm: version.bleedMm,
    safeContentRegion: version.safeContentRegion,
    dpiMin: version.dpiMin,
    color: version.color,
    cropMarks: version.cropMarks,
    spine: { source: "explicit" as const, widthMm: spineWidthMm },
    coverTemplate: null,
    requiredBlankPages: version.requiredBlankPages,
  };
}

function renderResult(label: string, pageCount: number) {
  const pdfBytes = Buffer.from(`%PDF-1.4\n% synthetic-${label}\n%%EOF\n`);
  return {
    pdfBytes,
    pageCount,
    egressRequestCount: 0 as const,
    blockedRequests: [],
    overflowPageNumbers: [],
    watermarkCount: 0 as const,
    minimumImagePpi: 300,
    fontNames: ["Hekayati Arabic", "Hekayati Brand"],
    rendererVersion: "hekayati.print.chromium.v1" as const,
    fontPolicyVersion: "hekayati.print-fonts.v1" as const,
    renderFactsHash: "f".repeat(64),
  };
}

function inertPreflightDefinition(): RegisteredJobDefinition {
  return {
    jobType: "print_preflight",
    requestSchema: localJobRequestSchema,
    validateEnqueue: () => undefined,
    prepare: async () => null,
    execute: async () => ({ ok: true, value: null }),
    commit: () => ({ resultRefs: [] }),
  };
}

async function waitFor(
  predicate: () => boolean,
  diagnostic?: () => unknown,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(
        `PRINT_JOB_WAIT_TIMEOUT ${JSON.stringify(diagnostic?.() ?? null)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function requireProduction(holder: {
  production: PrintProductionService | null;
}): PrintProductionService {
  if (!holder.production) throw new Error("PRINT_PRODUCTION_NOT_READY");
  return holder.production;
}

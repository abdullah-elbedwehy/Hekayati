import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { AssetStore } from "../../src/assets/asset-store.js";
import {
  ApprovedBookSnapshotReader,
  BookApprovalService,
} from "../../src/domain/layout/approvals.js";
import { PrinterProfileService } from "../../src/domain/print/profiles.js";
import { PrintRepositories } from "../../src/domain/print/repositories.js";
import { createDefaultPrinterProfileDraft } from "../../src/domain/print/schemas.js";
import { PrintProductionService } from "../../src/domain/print/workflow.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { createPrintProducerDefinitions } from "../../src/jobs/print-definitions.js";
import { createPrintPreflightDefinition } from "../../src/jobs/print-preflight-definition.js";
import { JobRuntime } from "../../src/jobs/runtime.js";
import type { PrintDocumentImage } from "../../src/pdf/print-document.js";
import {
  addPreviewBundle,
  approvalActionInput,
  createApprovalFixture,
  customerContentHash,
} from "../helpers/layout-approval-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";
import {
  printableCompiler,
  syntheticPrintImage,
} from "../helpers/print-workflow-fixtures.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("complete RGB print workflow", () => {
  it("renders, preflights, and atomically reaches deliverable/print_ready", async () => {
    const temp = await temporaryDirectory("hekayati-print-rgb-");
    cleanups.push(temp.cleanup);
    const store = new DocumentStore(join(temp.path, "hekayati.db"));
    const assets = new AssetStore(store, join(temp.path, "assets"));
    const imageBytes = await syntheticPrintImage();
    const source = await assets.put({
      bytes: imageBytes,
      extension: "jpg",
      mime: "image/jpeg",
      role: "illustration",
      origin: "derived",
      width: 2_600,
      height: 3_677,
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
      name: "RGB A4 synthetic",
      draft: {
        ...createDefaultPrinterProfileDraft(),
        spine: { source: "explicit", widthMm: 8 },
      },
    });
    const beforeAssignment = fixture.authoring.projects.get(fixture.projectId)!;
    profiles.assignProject({
      owner: fixture.owner,
      projectId: fixture.projectId,
      expectedProjectRevision: beforeAssignment.revision,
      profileId: profile.profile.id,
      expectedProfileRevision: profile.profile.revision,
      profileVersionId: profile.version.id,
    });

    const holder: { production: PrintProductionService | null } = {
      production: null,
    };
    const image: PrintDocumentImage = {
      bytes: imageBytes,
      mime: "image/jpeg",
      widthPx: 2_600,
      heightPx: 3_677,
      assetId: source.id,
      checksum: source.sha256,
      effectivePpi: 300,
    };
    const compiler = printableCompiler(image);
    const producerDefinitions = createPrintProducerDefinitions({
      production: () => requireProduction(holder),
      compiler: () => compiler,
      assets,
    });
    const preflightDefinition = createPrintPreflightDefinition({
      store,
      assets,
      production: () => requireProduction(holder),
    });
    const runtime = new JobRuntime(store, {
      definitions: [...producerDefinitions, preflightDefinition],
      pollIntervalMs: 10,
      maxWorkers: 2,
      timeoutMs: 45_000,
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
    const approved = await reader.read(fixture.projectId);
    const project = fixture.authoring.projects.get(fixture.projectId)!;
    const startRequest = {
      owner: fixture.owner,
      projectId: project.id,
      expectedProjectRevision: project.revision,
      profileId: profile.profile.id,
      expectedProfileRevision: profile.profile.revision,
      profileVersionId: profile.version.id,
      contentAuthorizationHash: approved.contentAuthorizationHash,
      idempotencyKey: "rgb-full-workflow",
    };
    const started = await production.start(startRequest);
    runtime.start();
    const print = new PrintRepositories(store);
    await waitFor(
      () => print.runs.get(started.run.id)?.state === "deliverable",
      () =>
        JSON.stringify({
          run: (() => {
            const run = print.runs.get(started.run.id);
            return run
              ? {
                  state: run.state,
                  blockingReasons: run.blockingReasons,
                  interiorReady: run.currentInteriorArtifactId !== null,
                  coverReady: run.currentCoverArtifactId !== null,
                  preflightReady: run.currentPreflightReportId !== null,
                }
              : null;
          })(),
          jobs: runtime.scheduler
            .list()
            .filter((job) => job.projectId === project.id)
            .map((job) => ({
              jobType: job.jobType,
              state: job.state,
              failureCategory: job.failure?.category ?? null,
              reasonCode: job.failure?.reasonCode ?? null,
            })),
        }),
    );
    await runtime.stop();

    const run = print.runs.get(started.run.id)!;
    const report = print.preflightReports.get(run.currentPreflightReportId!)!;
    expect(run).toMatchObject({
      state: "deliverable",
      blockingReasons: [],
      convertedProofGateJobId: null,
      convertedProofBundleHash: null,
    });
    expect(report).toMatchObject({ passed: true, findings: [] });
    expect(report.measurements).toMatchObject({
      colorMode: "rgb",
      iccChecksum: null,
      outputIntentMatches: true,
      sourceAssets: [
        { role: "artwork", assetId: source.id, checksum: source.sha256 },
        { role: "cover_art", assetId: source.id, checksum: source.sha256 },
      ],
      outputChecksums: {
        interior: report.interiorChecksum,
        cover: report.coverChecksum,
      },
      coverSpread: {
        panelOrder: ["back", "spine", "front"],
        spineWidthMm: 8,
        foldLinesMm: [213, 221],
      },
      cropMarks: {
        enabled: false,
        interiorSegmentCount: 0,
        coverSegmentCount: 0,
      },
      interior: { pageCount: 16, watermarkCount: 0 },
      cover: { pageCount: 1, watermarkCount: 0 },
    });
    for (const [facts, pageCount] of [
      [report.measurements.interior, 16],
      [report.measurements.cover, 1],
    ] as const) {
      expect(facts).toMatchObject({
        encrypted: false,
        parseable: true,
        hasArabicText: true,
        unmappedGlyphCount: 0,
        watermarkPages: [],
        prohibitedFeatureCount: 0,
        externalResourceCount: 0,
        hasDeviceCmyk: false,
      });
      expect(facts.pageBoxes).toHaveLength(pageCount);
      expect(facts.minimumImagePpi).toBeGreaterThanOrEqual(300);
      expect(facts.arabicGlyphCount).toBeGreaterThan(0);
      expect(facts.fonts.length).toBeGreaterThan(0);
      expect(
        facts.fonts.every(
          (font) => font.embedded && font.subset && font.toUnicode,
        ),
      ).toBe(true);
    }
    expect(fixture.authoring.projects.get(project.id)).toMatchObject({
      status: "print_ready",
    });
    expect(runtime.scheduler.get(run.preflightJobId!)?.state).toBe("succeeded");
    expect(print.proofBundles.list()).toEqual([]);
    expect(print.proofActions.list()).toEqual([]);
    await expect(production.start(startRequest)).resolves.toEqual({
      run,
      jobs: started.jobs.map((job) => runtime.scheduler.get(job.id)!),
      replayed: true,
    });
    store.close();
  }, 60_000);
});

async function waitFor(
  predicate: () => boolean,
  diagnostic: () => string = () => "",
): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`PRINT_RGB_WAIT_TIMEOUT:${diagnostic()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function requireProduction(holder: {
  production: PrintProductionService | null;
}): PrintProductionService {
  if (!holder.production) throw new Error("PRINT_PRODUCTION_NOT_READY");
  return holder.production;
}

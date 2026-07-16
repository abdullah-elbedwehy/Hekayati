import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AssetStore } from "../../src/assets/asset-store.js";
import {
  ApprovedBookSnapshotReader,
  BookApprovalService,
} from "../../src/domain/layout/approvals.js";
import { ConvertedProofService } from "../../src/domain/print/proof-approval.js";
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
import {
  printableCompiler,
  syntheticPrintImage,
} from "../helpers/print-workflow-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const iccPath = "/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc";
const imageWidth = 1_300;
const imageHeight = 1_839;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("complete CMYK print workflow", () => {
  it("requires the exact converted proof before becoming deliverable", async () => {
    const fixture = await runToProof("approve");
    const input = proofInput(fixture, "approved", "proof-approve");

    const approved = fixture.proofs.act(input);

    expect(approved).toMatchObject({
      replayed: false,
      action: "approved",
      runState: "deliverable",
    });
    expect(fixture.print.runs.get(fixture.run.id)).toMatchObject({
      state: "deliverable",
      blockingReasons: [],
    });
    expect(fixture.authoring.projects.get(fixture.projectId)).toMatchObject({
      status: "print_ready",
    });
    expect(fixture.runtime.scheduler.get(fixture.gate.id)).toMatchObject({
      state: "succeeded",
      revision: fixture.gate.revision + 1,
    });
    expect(fixture.proofs.act(input)).toMatchObject({
      replayed: true,
      actionId: approved.actionId,
    });
    expect(() =>
      fixture.proofs.act({
        ...input,
        printerProfileHash: "0".repeat(64),
      }),
    ).toThrowError("PRINT_PROOF_ACTION_COLLISION");
  }, 120_000);

  it("records rejection notes and never exposes a deliverable", async () => {
    const fixture = await runToProof("reject");
    const input = proofInput(
      fixture,
      "rejected",
      "proof-reject",
      "  الألوان تحتاج تعديل قبل الطباعة  ",
    );
    const source = fixture.assets.get(fixture.run.sourceAssets[0].assetId)!;
    await writeFile(
      fixture.assets.pathForRecord(source),
      Buffer.from("corrupt-source"),
    );
    expect(() => fixture.proofs.act(input)).toThrowError("PRINT_RUN_STALE");
    await writeFile(fixture.assets.pathForRecord(source), fixture.sourceBytes);

    const profile = fixture.print.profiles.get(fixture.run.printerProfileId)!;
    fixture.print.profiles.update(profile.revision, {
      ...profile,
      revision: profile.revision + 1,
      archived: true,
    });
    expect(() => fixture.proofs.act(input)).toThrowError("PRINT_RUN_STALE");
    fixture.print.profiles.update(profile.revision + 1, {
      ...profile,
      revision: profile.revision + 2,
    });
    expect(fixture.print.proofActions.list()).toEqual([]);
    expect(fixture.runtime.scheduler.get(fixture.gate.id)?.state).toBe(
      "waiting_review",
    );

    const rejected = fixture.proofs.act(input);

    expect(rejected).toMatchObject({
      replayed: false,
      action: "rejected",
      runState: "rejected",
    });
    expect(fixture.print.runs.get(fixture.run.id)).toMatchObject({
      state: "rejected",
      blockingReasons: ["CONVERTED_PROOF_REJECTED"],
    });
    expect(fixture.runtime.scheduler.get(fixture.gate.id)?.state).toBe(
      "canceled",
    );
    expect(fixture.authoring.projects.get(fixture.projectId)?.status).not.toBe(
      "print_ready",
    );
    expect(fixture.print.proofActions.list()[0]?.normalizedNotes).toBe(
      "الألوان تحتاج تعديل قبل الطباعة",
    );
  }, 120_000);
});

async function runToProof(suffix: string) {
  const temp = await temporaryDirectory(`hekayati-print-cmyk-${suffix}-`);
  const store = new DocumentStore(join(temp.path, "hekayati.db"));
  let runtime: JobRuntime | null = null;
  cleanups.push(async () => {
    if (runtime) await runtime.stop().catch(() => undefined);
    store.close();
    await temp.cleanup();
  });
  const assets = new AssetStore(store, join(temp.path, "assets"));
  const imageBytes = await syntheticPrintImage(imageWidth, imageHeight);
  const source = await assets.put({
    bytes: imageBytes,
    extension: "jpg",
    mime: "image/jpeg",
    role: "illustration",
    origin: "derived",
    width: imageWidth,
    height: imageHeight,
    dpi: 150,
  });
  const approvalFixture = createApprovalFixture(store, {
    assetId: source.id,
    assetChecksum: source.sha256,
  });
  const preview = addPreviewBundle(approvalFixture);
  const approval = new BookApprovalService(store, approvalFixture.scheduler);
  approval.act(
    approvalActionInput(approvalFixture, preview, "preview_sent", "send"),
  );
  approval.act(
    approvalActionInput(approvalFixture, preview, "approved", "approve"),
  );
  const profiles = new PrinterProfileService(store, assets);
  const imported = await profiles.importIcc({
    bytes: await readFile(iccPath),
    requireCmyk: true,
  });
  const profile = profiles.create({
    name: `CMYK A4 synthetic ${suffix}`,
    draft: {
      ...createDefaultPrinterProfileDraft(),
      dpiMin: 150,
      spine: { source: "explicit", widthMm: 8 },
      color: {
        mode: "cmyk",
        iccAssetId: imported.asset.id,
        iccChecksum: imported.asset.sha256,
      },
    },
  });
  const beforeAssignment = approvalFixture.authoring.projects.get(
    approvalFixture.projectId,
  )!;
  profiles.assignProject({
    owner: approvalFixture.owner,
    projectId: approvalFixture.projectId,
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
    widthPx: imageWidth,
    heightPx: imageHeight,
    assetId: source.id,
    checksum: source.sha256,
    effectivePpi: 150,
  };
  runtime = new JobRuntime(store, {
    definitions: [
      ...createPrintProducerDefinitions({
        production: () => requireProduction(holder),
        compiler: () => printableCompiler(image),
        assets,
      }),
      createPrintPreflightDefinition({
        store,
        assets,
        production: () => requireProduction(holder),
      }),
    ],
    pollIntervalMs: 10,
    maxWorkers: 2,
    timeoutMs: 90_000,
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
  const approved = await reader.read(approvalFixture.projectId);
  const project = approvalFixture.authoring.projects.get(
    approvalFixture.projectId,
  )!;
  const startInput = {
    owner: approvalFixture.owner,
    projectId: project.id,
    expectedProjectRevision: project.revision,
    profileId: profile.profile.id,
    expectedProfileRevision: profile.profile.revision,
    profileVersionId: profile.version.id,
    contentAuthorizationHash: approved.contentAuthorizationHash,
    idempotencyKey: `cmyk-workflow-${suffix}`,
  };
  const started = await production.start(startInput);
  const canonicalReplay = await production.start({
    ...startInput,
    idempotencyKey: `cmyk-workflow-${suffix}-new-key`,
  });
  expect(canonicalReplay).toMatchObject({
    replayed: true,
    run: { id: started.run.id },
  });
  runtime.start();
  const print = new PrintRepositories(store);
  await waitFor(
    () => print.runs.get(started.run.id)?.state === "converted_proof_pending",
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
        preflightFindings: (() => {
          const reportId = print.runs.get(
            started.run.id,
          )?.currentPreflightReportId;
          return reportId
            ? print.preflightReports.get(reportId)?.findings.map((finding) => ({
                code: finding.code,
                artifact: finding.artifact,
                page: finding.page,
                expected: finding.expected,
                actual: finding.actual,
              }))
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
    () => {
      const state = print.runs.get(started.run.id)?.state;
      const preflightFailed = runtime.scheduler
        .list()
        .some(
          (job) =>
            job.projectId === project.id &&
            job.jobType === "print_preflight" &&
            ["failed", "paused", "canceled"].includes(job.state),
        );
      return (
        preflightFailed ||
        state === "blocked" ||
        state === "stale" ||
        state === "rejected"
      );
    },
  );
  await runtime.stop();
  const run = print.runs.get(started.run.id)!;
  const bundle = print.proofBundles
    .queryByField("runId", run.id)
    .find(
      (candidate) => candidate.bundleHash === run.convertedProofBundleHash,
    )!;
  const gate = runtime.scheduler.get(run.convertedProofGateJobId!)!;
  expect(run.state).toBe("converted_proof_pending");
  expect(bundle.representativeAssets).toHaveLength(2);
  expect(gate.state).toBe("waiting_review");
  expect(
    print.preflightReports.get(run.currentPreflightReportId!)?.passed,
  ).toBe(true);
  return {
    store,
    assets,
    runtime,
    print,
    authoring: approvalFixture.authoring,
    owner: approvalFixture.owner,
    projectId: approvalFixture.projectId,
    run,
    bundle,
    gate,
    sourceBytes: imageBytes,
    proofs: new ConvertedProofService(store, assets, runtime.scheduler),
  };
}

function proofInput(
  fixture: Awaited<ReturnType<typeof runToProof>>,
  action: "approved" | "rejected",
  idempotencyKey: string,
  notes?: string,
) {
  return {
    owner: fixture.owner,
    runId: fixture.run.id,
    proofBundleId: fixture.bundle.id,
    gateJobId: fixture.gate.id,
    action,
    idempotencyKey,
    expectedRunRevision: fixture.run.revision,
    expectedGateRevision: fixture.gate.revision,
    proofBundleHash: fixture.bundle.bundleHash,
    contentAuthorizationHash: fixture.run.contentAuthorizationHash,
    printerProfileHash: fixture.run.printerProfileHash,
    iccChecksum: fixture.bundle.iccChecksum,
    ...(notes === undefined ? {} : { notes }),
  };
}

async function waitFor(
  predicate: () => boolean,
  diagnostic: () => string = () => "",
  terminalFailure: () => boolean = () => false,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (!predicate()) {
    if (terminalFailure())
      throw new Error(`PRINT_CMYK_TERMINAL_FAILURE:${diagnostic()}`);
    if (Date.now() > deadline)
      throw new Error(`PRINT_CMYK_WAIT_TIMEOUT:${diagnostic()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function requireProduction(holder: {
  production: PrintProductionService | null;
}): PrintProductionService {
  if (!holder.production) throw new Error("PRINT_PRODUCTION_NOT_READY");
  return holder.production;
}

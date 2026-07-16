import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AssetStore,
  type AssetStoreHooks,
} from "../../src/assets/asset-store.js";
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
import type {
  RegisteredJobDefinition,
  StorageResumeInput,
} from "../../src/jobs/types.js";
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
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("print producer storage failures", () => {
  for (const row of [
    {
      code: "ENOSPC",
      category: "insufficient_disk_space",
      boundary: "afterTempSync",
      orphanCount: 0,
    },
    {
      code: "EACCES",
      category: "disk_write_failure",
      boundary: "afterRenameSync",
      orphanCount: 1,
    },
  ] as const) {
    it(`${row.code} publishes no successor artifact and recovers after a successful storage probe`, async () => {
      const fixture = await harness(row.code, row.boundary);
      const baseline = await fixture.startBaseline();
      const baselineArtifacts = fixture.print.artifacts
        .list()
        .filter((artifact) => artifact.runId === baseline.run.id);
      expect(baselineArtifacts).toHaveLength(2);

      const failed = await fixture.startFailingSuccessor();
      await waitFor(() => fixture.runtime.scheduler.storageStatus().active);

      const failedJobs = failed.jobs.map((job) =>
        fixture.runtime.scheduler.get(job.id),
      );
      expect(failedJobs).toSatisfy((jobs: typeof failedJobs) =>
        jobs.every(
          (job) => job?.state === "paused" && job.stateReason === "storage",
        ),
      );
      expect(
        failedJobs.map((job) => job?.failure?.category).filter(Boolean),
      ).toEqual([row.category]);
      expect(fixture.runtime.scheduler.storageStatus()).toMatchObject({
        active: true,
        reason: row.category,
        ownedJobIds: expect.arrayContaining(failed.jobs.map((job) => job.id)),
      });

      const failedRun = fixture.print.runs.get(failed.run.id)!;
      expect(failedRun).toMatchObject({
        state: "queued",
        currentInteriorArtifactId: null,
        currentCoverArtifactId: null,
        currentPreflightReportId: null,
      });
      expect(
        fixture.print.artifacts
          .list()
          .filter((artifact) => artifact.runId === failed.run.id),
      ).toEqual([]);
      expect(
        fixture.assets.list().filter((asset) => asset.role.startsWith("pdf_")),
      ).toHaveLength(2);
      await expectBaselineIntact(fixture.assets, baselineArtifacts);

      const collected = await fixture.assets.garbageCollectOrphans();
      expect(collected).toHaveLength(row.orphanCount);
      await expect(fixture.assets.garbageCollectOrphans()).resolves.toEqual([]);

      const rejectedImpact = fixture.runtime.scheduler.storageResumeImpact();
      await expect(
        fixture.runtime.resumeStorage(resumeConfirmation(rejectedImpact)),
      ).rejects.toMatchObject({ code: "JOB_STORAGE_PROBE_FAILED" });
      expect(fixture.runtime.scheduler.storageStatus()).toMatchObject({
        active: true,
        lastProbeStatus: "failed",
      });

      fixture.repairStorage();
      const recoveryImpact = fixture.runtime.scheduler.storageResumeImpact();
      await expect(
        fixture.runtime.resumeStorage(resumeConfirmation(recoveryImpact)),
      ).resolves.toEqual(
        expect.arrayContaining(failed.jobs.map((job) => job.id)),
      );

      await waitFor(() =>
        failed.jobs.every(
          (job) => fixture.runtime.scheduler.get(job.id)?.state === "succeeded",
        ),
      );

      const recoveredRun = fixture.print.runs.get(failed.run.id)!;
      const recoveredArtifacts = fixture.print.artifacts
        .list()
        .filter((artifact) => artifact.runId === failed.run.id);
      expect(recoveredArtifacts).toHaveLength(2);
      expect(
        recoveredArtifacts.map((artifact) => artifact.kind).sort(),
      ).toEqual(["cover", "interior"]);
      expect(recoveredRun).toMatchObject({
        state: "preflight_pending",
        currentInteriorArtifactId: expect.any(String),
        currentCoverArtifactId: expect.any(String),
        preflightJobId: expect.any(String),
      });
      expect(
        new Set([
          recoveredRun.currentInteriorArtifactId,
          recoveredRun.currentCoverArtifactId,
        ]).size,
      ).toBe(2);
      expect(
        failed.jobs.map(
          (job) => fixture.runtime.scheduler.get(job.id)?.attempts,
        ),
      ).toContain(2);
      expect(fixture.runtime.scheduler.storageStatus()).toMatchObject({
        active: false,
        reason: null,
        lastProbeStatus: "succeeded",
      });
      await expectBaselineIntact(fixture.assets, baselineArtifacts);
      for (const artifact of recoveredArtifacts) {
        await expect(
          fixture.assets.verifyIntegrity(artifact.assetId),
        ).resolves.toMatchObject({
          status: "healthy",
          expectedSha256: artifact.checksum,
        });
      }
      await expect(fixture.assets.garbageCollectOrphans()).resolves.toEqual([]);
    }, 15_000);
  }
});

async function harness(
  failureCode: "ENOSPC" | "EACCES",
  failureBoundary: keyof AssetStoreHooks,
) {
  const directory = await temporaryDirectory("hekayati-print-storage-");
  const store = new DocumentStore(join(directory.path, "hekayati.db"));
  const fault = { enabled: false };
  const probe = { healthy: false };
  const failAtBoundary = (boundary: { role: string }) => {
    if (fault.enabled && boundary.role.startsWith("pdf_"))
      throw errorWithCode(failureCode);
  };
  const assets = new AssetStore(store, join(directory.path, "assets"), {
    [failureBoundary]: failAtBoundary,
  });
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
  const approvalFixture = createApprovalFixture(store, {
    assetId: source.id,
    assetChecksum: source.sha256,
  });
  const bundle = addPreviewBundle(approvalFixture);
  const approval = new BookApprovalService(store, approvalFixture.scheduler);
  approval.act(
    approvalActionInput(approvalFixture, bundle, "preview_sent", "send"),
  );
  approval.act(
    approvalActionInput(approvalFixture, bundle, "approved", "approve"),
  );

  const profiles = new PrinterProfileService(store, assets);
  const profile = profiles.create({
    name: "Synthetic RGB",
    draft: {
      ...createDefaultPrinterProfileDraft(),
      spine: { source: "explicit", widthMm: 8 },
    },
  });
  const initialProject = approvalFixture.authoring.projects.get(
    approvalFixture.projectId,
  )!;
  profiles.assignProject({
    owner: approvalFixture.owner,
    projectId: initialProject.id,
    expectedProjectRevision: initialProject.revision,
    profileId: profile.profile.id,
    expectedProfileRevision: profile.profile.revision,
    profileVersionId: profile.version.id,
  });

  const holder: { production: PrintProductionService | null } = {
    production: null,
  };
  const compiler = syntheticCompiler();
  const definitions = createPrintProducerDefinitions({
    production: () => requireProduction(holder),
    compiler: () => compiler,
    assets,
    renderer: {
      interior: async (document) =>
        renderResult("interior", 16, document.profile.id),
      cover: async (document) => ({
        ...renderResult("cover", 1, document.profile.id),
        panelOrder: ["back", "spine", "front"],
      }),
    },
  });
  const runtime = new JobRuntime(store, {
    definitions: [...definitions, inertPreflightDefinition()],
    pollIntervalMs: 5,
    maxWorkers: 1,
    timeoutMs: 5_000,
    storageProbe: async () => probe.healthy,
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
  const print = new PrintRepositories(store);
  let stopped = false;
  cleanups.push(async () => {
    if (!stopped) {
      await runtime.stop().catch(() => undefined);
      stopped = true;
    }
    store.close();
    await directory.cleanup();
  });

  const start = async (profileBinding: typeof profile, key: string) => {
    const authorization = await reader.read(approvalFixture.projectId);
    const project = approvalFixture.authoring.projects.get(
      approvalFixture.projectId,
    )!;
    return production.start({
      owner: approvalFixture.owner,
      projectId: project.id,
      expectedProjectRevision: project.revision,
      profileId: profileBinding.profile.id,
      expectedProfileRevision: profileBinding.profile.revision,
      profileVersionId: profileBinding.version.id,
      contentAuthorizationHash: authorization.contentAuthorizationHash,
      idempotencyKey: key,
    });
  };

  return {
    assets,
    print,
    runtime,
    async startBaseline() {
      const started = await start(profile, "storage-baseline");
      runtime.start();
      await waitFor(() =>
        started.jobs.every(
          (job) => runtime.scheduler.get(job.id)?.state === "succeeded",
        ),
      );
      return started;
    },
    async startFailingSuccessor() {
      const successor = profiles.update({
        profileId: profile.profile.id,
        expectedRevision: profile.profile.revision,
        name: profile.profile.name,
        archived: false,
        draft: profileDraft(profile.version, 9),
      });
      const project = approvalFixture.authoring.projects.get(
        approvalFixture.projectId,
      )!;
      profiles.assignProject({
        owner: approvalFixture.owner,
        projectId: project.id,
        expectedProjectRevision: project.revision,
        profileId: successor.profile.id,
        expectedProfileRevision: successor.profile.revision,
        profileVersionId: successor.version.id,
      });
      fault.enabled = true;
      return start(successor, `storage-${failureCode.toLowerCase()}`);
    },
    repairStorage() {
      fault.enabled = false;
      probe.healthy = true;
    },
  };
}

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

function renderResult(label: string, pageCount: number, versionId: string) {
  const pdfBytes = Buffer.from(
    `%PDF-1.4\n% synthetic-${label}-${versionId}\n%%EOF\n`,
  );
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

function resumeConfirmation(
  impact: ReturnType<JobRuntime["scheduler"]["storageResumeImpact"]>,
): StorageResumeInput {
  return {
    expectedRevision: impact.expectedRevision,
    impactHash: impact.impactHash,
    confirmedAffectedCount: impact.affectedCount,
    confirmed: true,
  };
}

async function expectBaselineIntact(
  assets: AssetStore,
  baseline: ReturnType<PrintRepositories["artifacts"]["list"]>,
): Promise<void> {
  for (const artifact of baseline) {
    await expect(
      assets.verifyIntegrity(artifact.assetId),
    ).resolves.toMatchObject({
      status: "healthy",
      expectedSha256: artifact.checksum,
    });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("PRINT_STORAGE_WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function requireProduction(holder: {
  production: PrintProductionService | null;
}): PrintProductionService {
  if (!holder.production) throw new Error("PRINT_PRODUCTION_NOT_READY");
  return holder.production;
}

function errorWithCode(code: "ENOSPC" | "EACCES"): Error {
  return Object.assign(new Error("synthetic print storage failure"), { code });
}

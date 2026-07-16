import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { AssetStore } from "../../src/assets/asset-store.js";
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
  type PrintRendererPort,
} from "../../src/jobs/print-definitions.js";
import {
  humanGateJobRegistration,
  localJobRegistration,
} from "../../src/jobs/registrations.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import type {
  JobClock,
  JobExecutionResult,
  RegisteredJobDefinition,
} from "../../src/jobs/types.js";
import { JobWorkerPool } from "../../src/jobs/worker-pool.js";
import {
  addPreviewBundle,
  approvalActionInput,
  createApprovalFixture,
  customerContentHash,
} from "../helpers/layout-approval-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const now = "2026-07-15T18:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("print producer commit fences", () => {
  it("blocks corrupt source bytes before renderer execution", async () => {
    const harness = await setupFenceHarness({});
    await writeFile(
      harness.assets.pathForRecord(harness.source),
      Buffer.from("corrupt-before-print-prepare"),
    );

    await harness.worker.runOne();

    expectRejectedInterior(harness, "failed");
    await expectNoPreparedOrphan(harness);
    harness.store.close();
  });

  it("revalidates persisted approval state after prepare and discards stale output", async () => {
    const harness = await setupFenceHarness({
      afterExecute: async (harness) => invalidateApproval(harness),
    });

    await harness.worker.runOne();

    expectRejectedInterior(harness, "failed");
    expect(
      harness.scheduler
        .events(harness.started.jobs[0].id)
        .some((event) => event.kind === "commit_rejected"),
    ).toBe(true);
    expect(
      harness.fixture.layout.bookApprovalCycles.get(harness.bundle.cycle.id),
    ).toMatchObject({ state: "invalidated" });
    await expectNoPreparedOrphan(harness);
    harness.store.close();
  });

  it("allows IM-19 observation drift after prepare under the stable authorization", async () => {
    const harness = await setupFenceHarness({
      afterExecute: async (harness) => applyIm19Observation(harness),
    });

    await harness.worker.runOne();

    const job = harness.scheduler.get(harness.started.jobs[0].id)!;
    const run = harness.print.runs.get(harness.started.run.id)!;
    expect(job.state).toBe("succeeded");
    expect(run).toMatchObject({
      state: "producing",
      currentInteriorArtifactId: expect.any(String),
      currentCoverArtifactId: null,
      contentAuthorizationHash: harness.started.run.contentAuthorizationHash,
    });
    expect(harness.print.artifacts.list()).toHaveLength(1);
    expect(
      harness.fixture.layout.bookApprovalCycles.get(harness.bundle.cycle.id),
    ).toMatchObject({ state: "approved", attentionReasons: ["IM-19"] });
    harness.store.close();
  });

  it("rejects cancellation after prepare and removes the prepared PDF", async () => {
    const barrier = deferred();
    const harness = await setupFenceHarness({
      afterExecute: async () => {
        barrier.reached.resolve();
        await barrier.release.promise;
      },
    });
    const running = harness.worker.runOne();
    await barrier.reached.promise;
    const job = harness.scheduler.get(harness.started.jobs[0].id)!;

    harness.scheduler.cancel(job.id, {
      expectedRevision: job.revision,
      expectedState: "running",
    });
    barrier.release.resolve();
    await running;

    expectRejectedInterior(harness, "canceled");
    await expectNoPreparedOrphan(harness);
    harness.store.close();
  });

  it("rejects an old boot fence, discards its PDF, then commits one replacement", async () => {
    const barrier = deferred();
    const harness = await setupFenceHarness({
      afterExecute: async () => {
        barrier.reached.resolve();
        await barrier.release.promise;
      },
    });
    const oldAttempt = harness.worker.runOne();
    await barrier.reached.promise;

    expect(
      harness.scheduler.recoverExpiredLeases("replacement-boot", 100),
    ).toContain(harness.started.jobs[0].id);
    barrier.release.resolve();
    await oldAttempt;

    expectRejectedInterior(harness, "queued");
    await expectNoPreparedOrphan(harness);
    const replacement = worker(
      harness.scheduler,
      harness.baseDefinitions,
      "replacement-boot",
      "replacement-worker",
    );
    await replacement.runOne();

    expect(harness.scheduler.get(harness.started.jobs[0].id)).toMatchObject({
      state: "succeeded",
      attempts: 2,
    });
    expect(harness.print.artifacts.list()).toHaveLength(1);
    expect(
      harness.assets.list().filter((asset) => asset.role === "pdf_interior"),
    ).toHaveLength(1);
    harness.store.close();
  });

  it("rolls back owner writes and discards bytes when scheduler commit throws", async () => {
    const harness = await setupFenceHarness({ throwAfterOwnerCommit: true });

    await harness.worker.runOne();

    expectRejectedInterior(harness, "queued");
    expect(harness.print.artifacts.list()).toEqual([]);
    expect(harness.print.runs.get(harness.started.run.id)).toMatchObject({
      revision: 0,
      state: "queued",
      currentInteriorArtifactId: null,
    });
    await expectNoPreparedOrphan(harness);
    harness.store.close();
  });
});

interface FenceHarnessOptions {
  afterExecute?: (harness: FenceHarness) => Promise<void>;
  throwAfterOwnerCommit?: boolean;
}

type FenceHarness = Awaited<ReturnType<typeof createFenceHarness>>;

async function setupFenceHarness(
  options: FenceHarnessOptions,
): Promise<FenceHarness> {
  let harness: FenceHarness | null = null;
  const created = await createFenceHarness((definitions) =>
    definitions.map((definition) => {
      if (definition.jobType !== "print_interior") return definition;
      return wrapInteriorDefinition(definition, {
        afterExecute: options.afterExecute
          ? async () => options.afterExecute!(requireHarness(harness))
          : undefined,
        throwAfterOwnerCommit: options.throwAfterOwnerCommit,
      });
    }),
  );
  harness = created;
  return created;
}

async function createFenceHarness(
  transform: (
    definitions: RegisteredJobDefinition[],
  ) => RegisteredJobDefinition[],
) {
  const temp = await temporaryDirectory("hekayati-print-fence-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "hekayati.db"));
  const assets = new AssetStore(store, join(temp.path, "assets"));
  const source = await assets.put({
    bytes: Buffer.from("synthetic-full-resolution-print-fence-source"),
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
    name: "Synthetic fence profile",
    draft: {
      ...createDefaultPrinterProfileDraft(),
      spine: { source: "explicit", widthMm: 8 },
    },
  });
  const projectBeforeAssignment = fixture.authoring.projects.get(
    fixture.projectId,
  )!;
  profiles.assignProject({
    owner: fixture.owner,
    projectId: fixture.projectId,
    expectedProjectRevision: projectBeforeAssignment.revision,
    profileId: profile.profile.id,
    expectedProfileRevision: profile.profile.revision,
    profileVersionId: profile.version.id,
  });

  const holder: { production: PrintProductionService | null } = {
    production: null,
  };
  const baseDefinitions = createPrintProducerDefinitions({
    production: () => requireProduction(holder),
    compiler: () => syntheticCompiler(),
    assets,
    renderer: syntheticRenderer(),
  });
  const definitions = transform(baseDefinitions);
  const scheduler = new JobScheduler(store, {
    registeredJobs: [
      humanGateJobRegistration("customer_approval_gate"),
      ...definitions.map((definition) => ({
        jobType: definition.jobType,
        requestSchema: definition.requestSchema,
        validateEnqueue: definition.validateEnqueue,
      })),
      localJobRegistration("print_preflight"),
      humanGateJobRegistration("print_converted_proof_gate"),
    ],
    nowIso: () => now,
  });
  const reader = new ApprovedBookSnapshotReader(store, scheduler, assets, {
    resolveCustomerContentHash: () => customerContentHash,
  });
  const production = new PrintProductionService(
    store,
    assets,
    scheduler,
    reader,
    { now: () => now },
  );
  holder.production = production;
  const project = fixture.authoring.projects.get(fixture.projectId)!;
  const authorization = await reader.read(project.id);
  const started = await production.start({
    owner: fixture.owner,
    projectId: project.id,
    expectedProjectRevision: project.revision,
    profileId: profile.profile.id,
    expectedProfileRevision: profile.profile.revision,
    profileVersionId: profile.version.id,
    contentAuthorizationHash: authorization.contentAuthorizationHash,
    idempotencyKey: `print-fence-${ulid()}`,
  });
  return {
    store,
    assets,
    source,
    fixture,
    bundle,
    profile,
    scheduler,
    production,
    started,
    print: new PrintRepositories(store),
    baseDefinitions,
    worker: worker(scheduler, definitions, "original-boot", "original-worker"),
  };
}

function wrapInteriorDefinition(
  definition: RegisteredJobDefinition,
  options: {
    afterExecute?: () => Promise<void>;
    throwAfterOwnerCommit?: boolean;
  },
): RegisteredJobDefinition {
  return {
    ...definition,
    execute: async (input): Promise<JobExecutionResult> => {
      const result = await definition.execute(input);
      if (result.ok) await options.afterExecute?.();
      return result;
    },
    commit: (input) => {
      const committed = definition.commit(input);
      if (options.throwAfterOwnerCommit)
        throw new Error("INJECTED_AFTER_PRINT_OWNER_COMMIT");
      return committed;
    },
  };
}

function invalidateApproval(harness: FenceHarness): void {
  const cycle = harness.fixture.layout.bookApprovalCycles.get(
    harness.bundle.cycle.id,
  )!;
  harness.fixture.layout.bookApprovalCycles.update(cycle.revision, {
    ...cycle,
    revision: cycle.revision + 1,
    updatedAt: now,
    state: "invalidated",
    invalidatedBy: { eventId: ulid(), matrixRow: "IM-11", at: now },
  });
}

function applyIm19Observation(harness: FenceHarness): void {
  const output = harness.fixture.layout.previewOutputs.get(
    harness.bundle.output.id,
  )!;
  harness.fixture.layout.previewOutputs.update(output.revision, {
    ...output,
    revision: output.revision + 1,
    updatedAt: now,
    status: "stale",
    staleReasons: ["IM-19"],
    invalidatedByEventIds: [ulid()],
  });
  const cycle = harness.fixture.layout.bookApprovalCycles.get(
    harness.bundle.cycle.id,
  )!;
  harness.fixture.layout.bookApprovalCycles.update(cycle.revision, {
    ...cycle,
    revision: cycle.revision + 1,
    updatedAt: now,
    attentionReasons: ["IM-19"],
  });
}

function expectRejectedInterior(
  harness: FenceHarness,
  expectedState: "canceled" | "failed" | "paused" | "queued",
): void {
  expect(harness.scheduler.get(harness.started.jobs[0].id)?.state).toBe(
    expectedState,
  );
  expect(harness.print.artifacts.list()).toEqual([]);
  expect(harness.print.runs.get(harness.started.run.id)).toMatchObject({
    currentInteriorArtifactId: null,
  });
  expect(
    harness.assets.list().filter((asset) => asset.role === "pdf_interior"),
  ).toEqual([]);
}

async function expectNoPreparedOrphan(harness: FenceHarness): Promise<void> {
  expect(await harness.assets.garbageCollectOrphans()).toEqual([]);
}

function syntheticCompiler(): PrintCompilerPort {
  return {
    compileInterior: async (context) => ({
      kind: "interior",
      profile: context.profileVersion,
      geometry: compileInteriorGeometry(context.profileVersion),
      sourceSnapshotHash: context.sourceSnapshotHash,
      fontManifestHash: context.output.fontManifestHash,
      pages: compileOutputPageMap(
        context.snapshot.orderedInteriorPages.map((page) => ({
          customerPageNumber: page.pageNumber,
          pageId: page.pageId,
        })),
        context.profileVersion.requiredBlankPages,
      ).map((map) => ({
        map,
        pageKind: "story",
        image: null,
        text: null,
        bubbles: [],
      })),
    }),
    compileCover: async (context) => ({
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
    }),
  } satisfies PrintCompilerPort;
}

function syntheticRenderer(): PrintRendererPort {
  return {
    interior: async () => renderResult("interior", 16),
    cover: async () => ({
      ...renderResult("cover", 1),
      panelOrder: ["back", "spine", "front"],
    }),
  };
}

function renderResult(label: string, pageCount: number) {
  return {
    pdfBytes: Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`),
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

function worker(
  scheduler: JobScheduler,
  definitions: readonly RegisteredJobDefinition[],
  bootId: string,
  workerId: string,
): JobWorkerPool {
  return new JobWorkerPool(scheduler, definitions, {
    bootId,
    workerId,
    clock,
    concurrencyPerProvider: 2,
    leaseTtlMs: 10_000,
    heartbeatIntervalMs: 1_000,
    timeoutMs: 10_000,
    pollIntervalMs: 10_000,
    maxWorkers: 1,
  });
}

function deferred() {
  let reach!: () => void;
  let release!: () => void;
  return {
    reached: {
      promise: new Promise<void>((resolve) => {
        reach = resolve;
      }),
      resolve: () => reach(),
    },
    release: {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      resolve: () => release(),
    },
  };
}

function requireHarness(harness: FenceHarness | null): FenceHarness {
  if (!harness) throw new Error("PRINT_FENCE_HARNESS_NOT_READY");
  return harness;
}

function requireProduction(holder: {
  production: PrintProductionService | null;
}): PrintProductionService {
  if (!holder.production) throw new Error("PRINT_PRODUCTION_NOT_READY");
  return holder.production;
}

const clock: JobClock = {
  monotonicNow: () => 100,
  wallNowIso: () => now,
};

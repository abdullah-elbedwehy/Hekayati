import { join } from "node:path";

import { expect } from "vitest";

import { AssetStore } from "../../src/assets/asset-store.js";
import {
  type ApprovedBookSnapshot,
  ApprovedBookSnapshotReader,
  BookApprovalService,
} from "../../src/domain/layout/approvals.js";
import { PrinterProfileService } from "../../src/domain/print/profiles.js";
import { PrintRepositories } from "../../src/domain/print/repositories.js";
import { createDefaultPrinterProfileDraft } from "../../src/domain/print/schemas.js";
import { PrintProductionService } from "../../src/domain/print/workflow.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import {
  humanGateJobRegistration,
  localJobRegistration,
} from "../../src/jobs/registrations.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import { validTestIcc } from "./icc-profile.js";
import {
  addPreviewBundle,
  approvalActionInput,
  createApprovalFixture,
  customerContentHash,
} from "./layout-approval-fixtures.js";
import { temporaryDirectory } from "./temp.js";

export async function setupMaterializationHarness(
  cleanups: Array<() => Promise<void>>,
) {
  const temp = await temporaryDirectory("hekayati-print-materialize-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "hekayati.db"));
  const assets = new AssetStore(store, join(temp.path, "assets"));
  const source = await assets.put({
    bytes: Buffer.from("synthetic-print-materialization-source"),
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

  const profileService = new PrinterProfileService(store, assets);
  const profile = profileService.create({
    name: "Synthetic A4 RGB",
    draft: {
      ...createDefaultPrinterProfileDraft(),
      spine: { source: "explicit", widthMm: 8 },
    },
  });
  const beforeAssignment = fixture.authoring.projects.get(fixture.projectId)!;
  profileService.assignProject({
    owner: fixture.owner,
    projectId: fixture.projectId,
    expectedProjectRevision: beforeAssignment.revision,
    profileId: profile.profile.id,
    expectedProfileRevision: profile.profile.revision,
    profileVersionId: profile.version.id,
  });

  const scheduler = printMaterializationScheduler(store);
  const integrity: { status: "healthy" | "corrupt" } = { status: "healthy" };
  const reader = new ApprovedBookSnapshotReader(
    store,
    scheduler,
    {
      verifyIntegrity: async () => ({
        status: integrity.status,
        expectedSha256: source.sha256,
      }),
    },
    { resolveCustomerContentHash: () => customerContentHash },
  );
  const authorizationHash = (await reader.read(fixture.projectId))
    .contentAuthorizationHash;
  const production = new PrintProductionService(
    store,
    assets,
    scheduler,
    reader,
  );

  return {
    temp,
    store,
    assets,
    fixture,
    bundle,
    profile,
    source,
    scheduler,
    integrity,
    reader,
    authorizationHash,
    production,
    print: new PrintRepositories(store),
  };
}

export function printMaterializationScheduler(
  store: DocumentStore,
): JobScheduler {
  return new JobScheduler(store, {
    registeredJobs: [
      humanGateJobRegistration("customer_approval_gate"),
      localJobRegistration("print_interior"),
      localJobRegistration("print_cover"),
      localJobRegistration("print_preflight"),
      humanGateJobRegistration("print_converted_proof_gate"),
    ],
  });
}

export type MaterializationHarness = Awaited<
  ReturnType<typeof setupMaterializationHarness>
>;

export type MaterializationStartInput = Awaited<
  ReturnType<typeof materializationStartInput>
>;

export function fixedApprovedSnapshot(snapshot: ApprovedBookSnapshot) {
  return { read: async () => structuredClone(snapshot) };
}

export function syntheticIcc(colorSpace: "CMYK" | "RGB "): Buffer {
  return validTestIcc(colorSpace);
}

export function expectZeroPrintWork(harness: MaterializationHarness): void {
  expect(harness.print.runs.list()).toEqual([]);
  expect(harness.print.artifacts.list()).toEqual([]);
  expect(harness.print.preflightReports.list()).toEqual([]);
  expect(harness.print.proofBundles.list()).toEqual([]);
  expect(harness.print.proofActions.list()).toEqual([]);
  expect(
    harness.assets
      .list()
      .filter((asset) =>
        ["pdf_interior", "pdf_cover", "print_proof"].includes(asset.role),
      ),
  ).toEqual([]);
  expect(
    harness.scheduler.list().filter((job) => job.jobType.startsWith("print_")),
  ).toEqual([]);
}

export async function materializationStartInput(
  harness: MaterializationHarness,
  idempotencyKey: string,
) {
  const project = harness.fixture.authoring.projects.get(
    harness.fixture.projectId,
  )!;
  return {
    owner: harness.fixture.owner,
    projectId: project.id,
    expectedProjectRevision: project.revision,
    profileId: harness.profile.profile.id,
    expectedProfileRevision: harness.profile.profile.revision,
    profileVersionId: harness.profile.version.id,
    contentAuthorizationHash: harness.authorizationHash,
    idempotencyKey,
  };
}

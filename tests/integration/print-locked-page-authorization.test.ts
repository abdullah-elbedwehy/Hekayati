import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { AssetStore } from "../../src/assets/asset-store.js";
import { canonicalJson } from "../../src/contracts/canonical-json.js";
import { CreativeInvalidationService } from "../../src/domain/creative/invalidation.js";
import { CreativeRepositories } from "../../src/domain/creative/repositories.js";
import {
  ApprovedBookSnapshotReader,
  BookApprovalService,
} from "../../src/domain/layout/approvals.js";
import { LayoutRepositories } from "../../src/domain/layout/repositories.js";
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
import {
  addPreviewBundle,
  approvalActionInput,
  createApprovalFixture,
  customerContentHash,
} from "../helpers/layout-approval-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-16T08:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("locked page print authorization", () => {
  it("keeps locked content byte-identical while IM-07 blocks zero-work print start", async () => {
    const fixture = await setup();
    const pageBefore = fixture.creative.pages.get(fixture.pageId)!;
    const contentBefore = canonicalJson(lockedContent(pageBefore));
    const layoutHeadBefore = fixture.layout.pageLayoutHeads.get(fixture.pageId);
    const sourceBytesBefore = await fixture.assets.read(fixture.sourceId);

    const invalidation = new CreativeInvalidationService(fixture.store, {
      now: () => at,
    });
    invalidation.bindGateController(fixture.scheduler);
    invalidation.recordAndConsume({
      id: ulid(),
      entity: "narrative_text",
      entityId: fixture.pageId,
      fromVersionId: pageBefore.currentTextVersionId,
      toVersionId: ulid(),
      changeType: "narrative_text",
      matrixRow: "IM-07",
      changedFields: ["narrative"],
      correlationId: ulid(),
      occurredAt: at,
    });

    const pageAfter = fixture.creative.pages.get(fixture.pageId)!;
    expect(pageAfter).toMatchObject({
      locked: true,
      reviewStatus: "flagged",
      staleState: "locked_stale",
      staleReasons: ["IM-07"],
      revision: pageBefore.revision + 1,
    });
    expect(canonicalJson(lockedContent(pageAfter))).toBe(contentBefore);
    expect(fixture.layout.pageLayoutHeads.get(fixture.pageId)).toEqual(
      layoutHeadBefore,
    );
    expect(await fixture.assets.read(fixture.sourceId)).toEqual(
      sourceBytesBefore,
    );
    expect(fixture.layout.previewOutputs.get(fixture.previewId)).toMatchObject({
      status: "stale",
      staleReasons: ["IM-07"],
    });
    expect(
      fixture.layout.bookApprovalCycles.get(fixture.approvalId),
    ).toMatchObject({
      state: "invalidated",
      invalidatedBy: { matrixRow: "IM-07" },
    });
    expect(
      fixture.fixture.authoring.projects.get(fixture.projectId),
    ).toMatchObject({ currentContentApprovalId: null, status: "revising" });

    await expect(fixture.reader.read(fixture.projectId)).rejects.toThrow(
      "APPROVED_SNAPSHOT_NOT_AUTHORIZED",
    );
    await expect(fixture.production.start(fixture.startInput)).rejects.toThrow(
      "APPROVED_SNAPSHOT_NOT_AUTHORIZED",
    );
    expect(fixture.print.runs.list()).toEqual([]);
    expect(
      fixture.scheduler
        .list()
        .filter((job) => job.jobType.startsWith("print_")),
    ).toEqual([]);
  });
});

async function setup() {
  const temp = await temporaryDirectory("hekayati-locked-print-gate-");
  const store = new DocumentStore(join(temp.path, "hekayati.db"));
  cleanups.push(temp.cleanup, async () => store.close());
  const assets = new AssetStore(store, join(temp.path, "assets"));
  const source = await assets.put({
    bytes: Buffer.from("synthetic-locked-page-source"),
    extension: "png",
    mime: "image/png",
    role: "illustration",
    origin: "derived",
    width: 2_480,
    height: 3_508,
    dpi: 300,
  });
  const fixture = createApprovalFixture(store, {
    assetId: source.id,
    assetChecksum: source.sha256,
  });
  const preview = addPreviewBundle(fixture);
  const pageRef = preview.output.orderedInteriorPages[2];
  const creative = new CreativeRepositories(store);
  creative.pages.insert({
    id: pageRef.pageId,
    schemaVersion: 2,
    createdAt: at,
    updatedAt: at,
    revision: 0,
    projectId: fixture.projectId,
    pageNumber: pageRef.pageNumber,
    storyPageIndex: 1,
    kind: "story",
    locked: true,
    reviewStatus: "approved",
    staleState: "current",
    staleReasons: [],
    currentTextVersionId: pageRef.textVersionId,
    currentPromptVersionId: null,
    currentIllustrationVersionId: pageRef.illustrationVersionId,
  });
  fixture.layout.pageLayoutHeads.insert({
    id: pageRef.pageId,
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    revision: 0,
    pageId: pageRef.pageId,
    currentLayoutVersionId: pageRef.layoutVersionId,
  });
  const approval = new BookApprovalService(store, fixture.scheduler);
  approval.act(approvalActionInput(fixture, preview, "preview_sent", "send"));
  approval.act(approvalActionInput(fixture, preview, "approved", "approve"));

  const profiles = new PrinterProfileService(store, assets, { now: () => at });
  const profile = profiles.create({
    name: "Locked-page A4 RGB",
    draft: {
      ...createDefaultPrinterProfileDraft(),
      spine: { source: "explicit", widthMm: 8 },
    },
  });
  const assignable = fixture.authoring.projects.get(fixture.projectId)!;
  const assigned = profiles.assignProject({
    owner: fixture.owner,
    projectId: fixture.projectId,
    expectedProjectRevision: assignable.revision,
    profileId: profile.profile.id,
    expectedProfileRevision: profile.profile.revision,
    profileVersionId: profile.version.id,
  });
  const scheduler = printScheduler(store);
  const reader = new ApprovedBookSnapshotReader(store, scheduler, assets, {
    resolveCustomerContentHash: () => customerContentHash,
  });
  const authorization = await reader.read(fixture.projectId);
  const production = new PrintProductionService(
    store,
    assets,
    scheduler,
    reader,
  );
  return {
    store,
    assets,
    fixture,
    creative,
    layout: new LayoutRepositories(store),
    print: new PrintRepositories(store),
    scheduler,
    reader,
    production,
    sourceId: source.id,
    pageId: pageRef.pageId,
    previewId: preview.output.id,
    approvalId: preview.cycle.id,
    projectId: fixture.projectId,
    startInput: {
      owner: fixture.owner,
      projectId: fixture.projectId,
      expectedProjectRevision: assigned.revision,
      profileId: profile.profile.id,
      expectedProfileRevision: profile.profile.revision,
      profileVersionId: profile.version.id,
      contentAuthorizationHash: authorization.contentAuthorizationHash,
      idempotencyKey: "locked-page-invalidated-start",
    },
  };
}

function printScheduler(store: DocumentStore): JobScheduler {
  return new JobScheduler(store, {
    registeredJobs: [
      humanGateJobRegistration("customer_approval_gate"),
      localJobRegistration("print_interior"),
      localJobRegistration("print_cover"),
      localJobRegistration("print_preflight"),
      humanGateJobRegistration("print_converted_proof_gate"),
    ],
    nowIso: () => at,
  });
}

function lockedContent(page: {
  projectId: string;
  pageNumber: number;
  storyPageIndex: number | null;
  kind: string;
  locked: boolean;
  currentTextVersionId: string | null;
  currentPromptVersionId: string | null;
  currentIllustrationVersionId: string | null;
}) {
  return {
    projectId: page.projectId,
    pageNumber: page.pageNumber,
    storyPageIndex: page.storyPageIndex,
    kind: page.kind,
    locked: page.locked,
    currentTextVersionId: page.currentTextVersionId,
    currentPromptVersionId: page.currentPromptVersionId,
    currentIllustrationVersionId: page.currentIllustrationVersionId,
  };
}

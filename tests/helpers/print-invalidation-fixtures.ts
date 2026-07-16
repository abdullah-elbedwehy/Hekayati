import { join } from "node:path";

import { ulid } from "ulid";

import { AssetStore } from "../../src/assets/asset-store.js";
import { CreativeInvalidationService } from "../../src/domain/creative/invalidation.js";
import type { MatrixRow } from "../../src/domain/creative/schemas.js";
import {
  ApprovedBookSnapshotReader,
  BookApprovalService,
} from "../../src/domain/layout/approvals.js";
import { hashCanonical } from "../../src/domain/layout/hashes.js";
import { PrintInvalidationParticipant } from "../../src/domain/print/invalidation.js";
import { PrinterProfileService } from "../../src/domain/print/profiles.js";
import { PrintRepositories } from "../../src/domain/print/repositories.js";
import { createDefaultPrinterProfileDraft } from "../../src/domain/print/schemas.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import {
  humanGateJobRegistration,
  localJobRegistration,
} from "../../src/jobs/registrations.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import type { JobFence, JobRecord } from "../../src/jobs/types.js";
import {
  addPreviewBundle,
  approvalActionInput,
  createApprovalFixture,
  customerContentHash,
} from "./layout-approval-fixtures.js";
import { persistedPdfFactsFixture } from "./print-preflight-fixtures.js";
import { addSyntheticReviewedPage } from "./print-workflow-fixtures.js";
import { temporaryDirectory } from "./temp.js";

const cleanups: Array<() => Promise<void>> = [];
export const printInvalidationAt = "2026-07-15T12:00:00.000Z";

export async function cleanupPrintInvalidationFixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

export async function seedDeliverable(
  options: {
    producerState?: "succeeded" | "in_flight";
    proofGate?: "waiting_review" | "succeeded";
  } = {},
) {
  const temp = await temporaryDirectory("hekayati-print-invalidation-");
  const store = new DocumentStore(join(temp.path, "hekayati.db"));
  cleanups.push(temp.cleanup, async () => store.close());
  const assets = new AssetStore(store, join(temp.path, "assets"));
  const sourceBytes = Buffer.from("synthetic-full-resolution-source");
  const source = await assets.put({
    bytes: sourceBytes,
    extension: "png",
    mime: "image/png",
    role: "illustration",
    origin: "derived",
    width: 2_480,
    height: 3_508,
    dpi: 300,
  });
  const approvalFixture = createApprovalFixture(store, {
    assetId: source.id,
    assetChecksum: source.sha256,
  });
  const preview = addPreviewBundle(approvalFixture);
  const pageId = preview.output.orderedInteriorPages[2].pageId;
  addSyntheticReviewedPage(store, {
    id: pageId,
    projectId: approvalFixture.projectId,
    at: printInvalidationAt,
  });
  const approvals = new BookApprovalService(store, approvalFixture.scheduler);
  approvals.act(
    approvalActionInput(approvalFixture, preview, "preview_sent", "send"),
  );
  approvals.act(
    approvalActionInput(approvalFixture, preview, "approved", "approve"),
  );
  const reader = new ApprovedBookSnapshotReader(
    store,
    approvalFixture.scheduler,
    assets,
    { resolveCustomerContentHash: () => customerContentHash },
  );
  const snapshot = await reader.read(approvalFixture.projectId);
  const profiles = new PrinterProfileService(store, assets, {
    now: () => printInvalidationAt,
  });
  const profile = profiles.create({
    name: "Synthetic invalidation profile",
    draft: {
      ...createDefaultPrinterProfileDraft(),
      spine: { source: "explicit", widthMm: 8 },
    },
  });
  const assignable = approvalFixture.authoring.projects.get(
    approvalFixture.projectId,
  )!;
  profiles.assignProject({
    owner: approvalFixture.owner,
    projectId: approvalFixture.projectId,
    expectedProjectRevision: assignable.revision,
    profileId: profile.profile.id,
    expectedProfileRevision: profile.profile.revision,
    profileVersionId: profile.version.id,
  });
  const project = approvalFixture.authoring.projects.get(
    approvalFixture.projectId,
  )!;
  const print = new PrintRepositories(store);
  const runId = ulid();
  const scheduler = new JobScheduler(store, {
    registeredJobs: [
      localJobRegistration("print_interior"),
      localJobRegistration("print_cover"),
      localJobRegistration("print_preflight"),
      humanGateJobRegistration("human_gate"),
    ],
    nowIso: () => printInvalidationAt,
  });
  const jobs = enqueueProducerJobs(scheduler, runId, project.id);
  if (options.producerState === "in_flight") startNext(scheduler);
  else
    for (let index = 0; index < jobs.length; index += 1)
      completeNext(scheduler);
  const interiorAsset = await assets.put({
    bytes: Buffer.from("synthetic-interior-pdf"),
    extension: "pdf",
    mime: "application/pdf",
    role: "pdf_interior",
    origin: "derived",
  });
  const coverAsset = await assets.put({
    bytes: Buffer.from("synthetic-cover-pdf"),
    extension: "pdf",
    mime: "application/pdf",
    role: "pdf_cover",
    origin: "derived",
  });
  const colorMode = options.proofGate ? ("cmyk" as const) : ("rgb" as const);
  const iccChecksum = options.proofGate ? "6".repeat(64) : null;
  const baseArtifact = {
    schemaVersion: 1 as const,
    createdAt: printInvalidationAt,
    updatedAt: printInvalidationAt,
    projectId: approvalFixture.projectId,
    runId,
    contentAuthorizationHash: snapshot.contentAuthorizationHash,
    printerProfileVersionId: profile.version.id,
    printerProfileHash: profile.version.profileHash,
    sourceSnapshotHash: hashCanonical(snapshot),
    pageMapHash: "1".repeat(64),
    colorMode,
    iccChecksum,
    rendererVersion: "hekayati.print.chromium.v1",
    converterVersion: options.proofGate ? "ghostscript.synthetic.v1" : null,
    fontPolicyVersion: "hekayati.print-fonts.v1",
    conversionFacts: options.proofGate
      ? {
          outputConditionIdentifier: "Synthetic CMYK",
          embeddedIccChecksum: iccChecksum!,
          embeddedIccBytes: 128,
          imageCount: 1,
          contentStreamCount: 1,
          cmykOnly: true as const,
          outputIntentMatches: true as const,
          geometryPreserved: true as const,
          fontsPreserved: true as const,
        }
      : null,
    reusedFromArtifactId: null,
  };
  const interiorFacts = renderFacts(16, null);
  const interior = print.artifacts.insert({
    ...baseArtifact,
    id: ulid(),
    jobId: jobs[0].id,
    kind: "interior",
    assetId: interiorAsset.id,
    checksum: interiorAsset.sha256,
    bytes: interiorAsset.bytes,
    renderFactsHash: hashCanonical(interiorFacts),
    renderFacts: interiorFacts,
  });
  const coverFacts = renderFacts(1, ["back", "spine", "front"]);
  const cover = print.artifacts.insert({
    ...baseArtifact,
    id: ulid(),
    jobId: jobs[1].id,
    kind: "cover",
    assetId: coverAsset.id,
    checksum: coverAsset.sha256,
    bytes: coverAsset.bytes,
    renderFactsHash: hashCanonical(coverFacts),
    renderFacts: coverFacts,
  });
  const measurements = {
    pageMap: [],
    interior: persistedPdfFactsFixture(16),
    cover: persistedPdfFactsFixture(1),
    sourceAssets: [
      { role: "illustration", assetId: source.id, checksum: source.sha256 },
    ],
    outputChecksums: {
      interior: interior.checksum,
      cover: cover.checksum,
    },
    coverSpread: {
      panelOrder: ["back", "spine", "front"] as ["back", "spine", "front"],
      spineWidthMm: 8,
      panels: [
        {
          kind: "back" as const,
          boxMm: { x: 3, y: 3, width: 210, height: 297 },
        },
        {
          kind: "spine" as const,
          boxMm: { x: 213, y: 3, width: 8, height: 297 },
        },
        {
          kind: "front" as const,
          boxMm: { x: 221, y: 3, width: 210, height: 297 },
        },
      ],
      foldLinesMm: [213, 221] as [number, number],
    },
    cropMarks: {
      enabled: false,
      offsetMm: 0,
      lengthMm: 0,
      strokePt: 0.25,
      interiorSegmentCount: 0,
      coverSegmentCount: 0,
    },
    colorMode,
    iccChecksum,
    outputIntentMatches: true,
  };
  const report = print.preflightReports.insert({
    id: ulid(),
    schemaVersion: 1,
    createdAt: printInvalidationAt,
    updatedAt: printInvalidationAt,
    projectId: approvalFixture.projectId,
    runId,
    interiorArtifactId: interior.id,
    interiorChecksum: interior.checksum,
    coverArtifactId: cover.id,
    coverChecksum: cover.checksum,
    contentAuthorizationHash: snapshot.contentAuthorizationHash,
    printerProfileVersionId: profile.version.id,
    printerProfileHash: profile.version.profileHash,
    policyVersion: "hekayati.print-preflight.v1",
    toolVersions: { qpdf: "fixture", poppler: "fixture" },
    findings: [],
    measurements,
    measurementsHash: hashCanonical(measurements),
    passed: true,
  });
  const proofBundleId = ulid();
  const proofGate = options.proofGate
    ? scheduler.enqueue({
        jobType: "human_gate",
        projectId: project.id,
        standaloneScopeId: null,
        dependsOn: options.producerState === "in_flight" ? [] : [jobs[2].id],
        priority: 3,
        intentId: `print-proof-${runId}`,
        target: null,
        request: {
          kind: "human_gate",
          gateKind: "print_converted_proof",
          targetId: runId,
          targetVersionId: proofBundleId,
        },
        inputSnapshot: { runId, proofBundleId },
      })
    : null;
  const finalProofGate =
    proofGate && options.proofGate === "succeeded"
      ? scheduler.completeHumanGate(
          proofGate.id,
          {
            expectedRevision: proofGate.revision,
            targetVersionId: proofBundleId,
          },
          () => true,
        )
      : proofGate;
  const run = print.runs.insert({
    id: runId,
    schemaVersion: 1,
    createdAt: printInvalidationAt,
    updatedAt: printInvalidationAt,
    revision: 0,
    projectId: project.id,
    familyId: project.familyId,
    customerId: project.customerId,
    requestHash: "2".repeat(64),
    idempotencyKey: `invalidation-${runId}`,
    contentAuthorizationHash: snapshot.contentAuthorizationHash,
    approvalCycleId: snapshot.approvalCycleId,
    approvalGateJobId: snapshot.approvalGateJobId,
    previewOutputId: snapshot.previewOutputId,
    customerContentHash: snapshot.customerContentHash,
    compositionProfileId: snapshot.compositionProfileId,
    compositionProfileHash: preview.output.compositionProfileHash,
    printerProfileId: profile.profile.id,
    printerProfileVersionId: profile.version.id,
    printerProfileHash: profile.version.profileHash,
    sourceSnapshotHash: hashCanonical(snapshot),
    sourceAssets: [
      { role: "illustration", assetId: source.id, checksum: source.sha256 },
    ],
    state: "deliverable",
    interiorJobId: jobs[0].id,
    coverJobId: jobs[1].id,
    preflightJobId: jobs[2].id,
    convertedProofGateJobId: finalProofGate?.id ?? null,
    currentInteriorArtifactId: interior.id,
    currentCoverArtifactId: cover.id,
    currentPreflightReportId: report.id,
    convertedProofBundleHash: finalProofGate ? "9".repeat(64) : null,
    blockingReasons: [],
    staleReasons: [],
    invalidatedByEventIds: [],
  });
  approvalFixture.authoring.projects.update({
    ...project,
    revision: project.revision + 1,
    updatedAt: printInvalidationAt,
    status: "print_ready",
  });
  const invalidation = new CreativeInvalidationService(store, {
    now: () => printInvalidationAt,
  });
  invalidation.bindGateController(scheduler);
  const printInvalidation = new PrintInvalidationParticipant(
    store,
    assets,
    scheduler,
    () => printInvalidationAt,
  );
  invalidation.bindParticipant(printInvalidation);
  return {
    store,
    assets,
    source,
    sourceBytes,
    authoring: approvalFixture.authoring,
    project: approvalFixture.authoring.projects.get(project.id)!,
    print,
    run,
    interior,
    cover,
    report,
    scheduler,
    jobs,
    proofGate: finalProofGate,
    pageId,
    invalidation,
    printInvalidation,
    profile,
  };
}

export function enqueueProducerJobs(
  scheduler: JobScheduler,
  runId: string,
  projectId: string,
): JobRecord[] {
  const interior = enqueuePrintJob(
    scheduler,
    runId,
    projectId,
    "print_interior",
    "interior",
  );
  const cover = enqueuePrintJob(
    scheduler,
    runId,
    projectId,
    "print_cover",
    "cover",
  );
  const preflight = scheduler.enqueue({
    jobType: "print_preflight",
    projectId,
    standaloneScopeId: null,
    dependsOn: [interior.id, cover.id],
    priority: 3,
    intentId: `preflight-${runId}`,
    target: null,
    request: { kind: "local", payloadHash: "8".repeat(64) },
    inputSnapshot: { runId },
  });
  return [interior, cover, preflight];
}

export function enqueuePrintJob(
  scheduler: JobScheduler,
  runId: string,
  projectId: string,
  jobType: "print_interior" | "print_cover" | "print_preflight",
  suffix: string,
): JobRecord {
  return scheduler.enqueue({
    jobType,
    projectId,
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId: `${jobType}-${runId}-${suffix}`,
    target: null,
    request: { kind: "local", payloadHash: "7".repeat(64) },
    inputSnapshot: { runId },
  });
}

export function startNext(scheduler: JobScheduler): JobRecord {
  const claimed = scheduler.claimNext({
    workerId: "print-invalidation-worker",
    bootId: "print-invalidation-boot",
    nowMonoMs: 10,
    nowWallMs: Date.parse(printInvalidationAt),
    leaseTtlMs: 1_000,
    concurrencyPerProvider: 2,
  })!;
  return scheduler.markRunning(claimed.id, fence(claimed), 11);
}

function completeNext(scheduler: JobScheduler): JobRecord {
  const running = startNext(scheduler);
  return scheduler.commitSuccess(running.id, fence(running), [], 12);
}

export function fence(job: JobRecord): JobFence {
  return {
    workerId: job.lease!.workerId,
    bootId: job.lease!.bootId,
    claimToken: job.lease!.claimToken,
    attempt: job.attempts,
  };
}

function renderFacts(
  pageCount: number,
  panelOrder: ["back", "spine", "front"] | null,
) {
  return {
    pageCount,
    egressRequestCount: 0 as const,
    overflowPageNumbers: [],
    watermarkCount: 0 as const,
    minimumImagePpi: 300,
    fontNames: ["IBM Plex Sans Arabic"],
    panelOrder,
  };
}

export function change(
  entityId: string,
  matrixRow: MatrixRow,
  entity:
    | "printer_profile"
    | "cover_template"
    | "internal"
    | "asset_integrity"
    | "book_content"
    | "narrative_text"
    | "watermark_setting",
) {
  const changeType = {
    printer_profile: "printer_profile",
    cover_template: "cover_template",
    internal: "internal_only",
    asset_integrity: "asset_integrity",
    book_content: "book_content",
    narrative_text: "narrative_text",
    watermark_setting: "watermark_text",
  } as const;
  return {
    id: ulid(),
    entity,
    entityId,
    fromVersionId: null,
    toVersionId: null,
    changeType: changeType[entity],
    matrixRow,
    changedFields: [entity],
    correlationId: ulid(),
    occurredAt: printInvalidationAt,
  };
}

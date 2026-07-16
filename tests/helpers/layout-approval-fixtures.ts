import { ulid } from "ulid";

import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import type { Project } from "../../src/domain/authoring/schemas.js";
import type { DocumentStore } from "../../src/domain/repository/document-store.js";
import type { BookApprovalActionInput } from "../../src/domain/layout/approvals.js";
import { hashCanonical } from "../../src/domain/layout/hashes.js";
import { initializeLayoutPersistence } from "../../src/domain/layout/migrations.js";
import { A4_COMPOSITION_PROFILE_ID } from "../../src/domain/layout/policy.js";
import { LayoutRepositories } from "../../src/domain/layout/repositories.js";
import type {
  BookApprovalCycle,
  CoverCompositionVersion,
  PreviewInteriorPage,
  PreviewOutput,
} from "../../src/domain/layout/schemas.js";
import { humanGateJobRegistration } from "../../src/jobs/registrations.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";

export const approvalAt = "2026-07-15T02:00:00.000Z";
export const customerContentHash = "a".repeat(64);

export interface ApprovalFixture {
  store: DocumentStore;
  authoring: AuthoringRepositories;
  layout: LayoutRepositories;
  scheduler: JobScheduler;
  owner: { customerId: string; familyId: string };
  projectId: string;
  projectVersionId: string;
  coverVersion: CoverCompositionVersion;
  assetId: string;
  assetChecksum: string;
}

export interface PreviewBundle {
  output: PreviewOutput;
  cycle: BookApprovalCycle;
  gateId: string;
}

export function createApprovalFixture(
  store: DocumentStore,
  source?: { assetId: string; assetChecksum: string },
): ApprovalFixture {
  initializeLayoutPersistence(store);
  const authoring = new AuthoringRepositories(store);
  const layout = new LayoutRepositories(store);
  const scheduler = new JobScheduler(store, {
    registeredJobs: [humanGateJobRegistration("customer_approval_gate")],
    nowIso: () => approvalAt,
  });
  const projectId = ulid();
  const projectVersionId = ulid();
  const owner = { customerId: ulid(), familyId: ulid() };
  authoring.projects.insert(project(projectId, projectVersionId, owner));
  const assetId = source?.assetId ?? ulid();
  const assetChecksum = source?.assetChecksum ?? "b".repeat(64);
  const coverVersion = layout.coverCompositionVersions.insert(
    cover(projectId, projectVersionId, assetId, assetChecksum),
  );
  return {
    store,
    authoring,
    layout,
    scheduler,
    owner,
    projectId,
    projectVersionId,
    coverVersion,
    assetId,
    assetChecksum,
  };
}

export function addPreviewBundle(fixture: ApprovalFixture): PreviewBundle {
  const outputId = ulid();
  const cycleId = ulid();
  const gate = fixture.scheduler.enqueue({
    jobType: "customer_approval_gate",
    projectId: fixture.projectId,
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId: `approval-${cycleId}`,
    target: null,
    request: {
      kind: "human_gate",
      gateKind: "customer_approval",
      targetId: fixture.projectId,
      targetVersionId: outputId,
    },
    inputSnapshot: {},
  });
  const pages = interiorPages(fixture.assetId, fixture.assetChecksum);
  const output = fixture.layout.previewOutputs.insert(
    previewOutput(fixture, outputId, cycleId, gate.id, pages),
  );
  const cycle = fixture.layout.bookApprovalCycles.insert(
    approvalCycle(fixture, output, gate.id),
  );
  advancePreviewHeads(fixture, output, cycle);
  return { output, cycle, gateId: gate.id };
}

export function approvalActionInput(
  fixture: ApprovalFixture,
  bundle: PreviewBundle,
  action: BookApprovalActionInput["action"],
  idempotencyKey: string,
  changes: Pick<BookApprovalActionInput, "notes" | "affectedScopes"> = {},
): BookApprovalActionInput {
  const project = fixture.authoring.projects.get(fixture.projectId)!;
  const output = fixture.layout.previewOutputs.get(bundle.output.id)!;
  const cycle = fixture.layout.bookApprovalCycles.get(bundle.cycle.id)!;
  const gate = fixture.scheduler.get(bundle.gateId)!;
  const prior = project.currentContentApprovalId
    ? fixture.layout.bookApprovalCycles.get(project.currentContentApprovalId)
    : null;
  return {
    owner: fixture.owner,
    projectId: project.id,
    previewOutputId: output.id,
    cycleId: cycle.id,
    action,
    idempotencyKey,
    customerContentHash: output.customerContentHash,
    approvalBundleHash: output.approvalBundleHash,
    expectedProjectRevision: project.revision,
    expectedPreviewOutputRevision: output.revision,
    expectedApprovalRevision: cycle.revision,
    expectedGateRevision: gate.revision,
    expectedContentApprovalId: project.currentContentApprovalId,
    expectedContentApprovalRevision: prior?.revision ?? null,
    ...changes,
  };
}

function project(
  id: string,
  versionId: string,
  owner: ApprovalFixture["owner"],
): Project {
  return {
    id,
    schemaVersion: 2,
    createdAt: approvalAt,
    updatedAt: approvalAt,
    customerId: owner.customerId,
    familyId: owner.familyId,
    revision: 0,
    status: "internal_review",
    priority: 0,
    paused: false,
    currentVersionId: versionId,
    bookVersion: 9,
    compositionProfileId: A4_COMPOSITION_PROFILE_ID,
    currentCoverCompositionVersionId: null,
    currentPreviewOutputId: null,
    currentPreviewCycleId: null,
    currentContentApprovalId: null,
    printerProfileId: null,
  };
}

function cover(
  projectId: string,
  projectVersionId: string,
  assetId: string,
  checksum: string,
): CoverCompositionVersion {
  const sourceAssets = [{ role: "cover_art", assetId, checksum }];
  return {
    id: ulid(),
    schemaVersion: 1,
    createdAt: approvalAt,
    updatedAt: approvalAt,
    projectId,
    compositionProfileId: A4_COMPOSITION_PROFILE_ID,
    compositionProfileHash: "c".repeat(64),
    previousVersionId: null,
    projectVersionId,
    compositionSourcePolicyVersion: "hekayati.composition-source.v1",
    selectionSource: "automatic_v1",
    textSources: [
      {
        role: "cover_title",
        entityId: projectId,
        versionId: projectVersionId,
        contentHash: "d".repeat(64),
      },
    ],
    sourceAssets,
    front: {
      title: "حكاية اصطناعية",
      childDisplayName: "نور",
      environmentLine: null,
      artworkAssetId: assetId,
      region: { x: 0, y: 0, width: 1, height: 1 },
    },
    back: {
      synopsis: null,
      brandLine: "حكايتي",
      artworkAssetId: null,
      region: { x: 0, y: 0, width: 1, height: 1 },
    },
    brandTemplateHash: "e".repeat(64),
    fontManifestHash: "f".repeat(64),
    warnings: [],
    acceptance: "ready",
    compositionHash: hashCanonical({ sourceAssets, projectVersionId }),
  };
}

function interiorPages(
  assetId: string,
  checksum: string,
): PreviewInteriorPage[] {
  return Array.from({ length: 16 }, (_, index) => ({
    pageId: ulid(),
    pageNumber: index + 1,
    pageObservationRevision: 4,
    pageContentHash: hashCanonical({ page: index + 1 }),
    layoutVersionId: ulid(),
    layoutHash: hashCanonical({ layout: index + 1 }),
    textVersionId: ulid(),
    illustrationVersionId: ulid(),
    compositionInputHash: hashCanonical({ composition: index + 1 }),
    textSources: [
      {
        role: "story_text",
        entityId: ulid(),
        versionId: ulid(),
        contentHash: hashCanonical({ text: index + 1 }),
      },
    ],
    sourceAssets: [{ role: "artwork", assetId, checksum }],
    selectionSource: "not_applicable" as const,
    pageReviewId: ulid(),
    reviewHash: hashCanonical({ review: index + 1 }),
    compositionSourcePolicyVersion: null,
  }));
}

function previewOutput(
  fixture: ApprovalFixture,
  id: string,
  cycleId: string,
  gateId: string,
  pages: PreviewInteriorPage[],
): PreviewOutput {
  const approvalBundleHash = hashCanonical({ id, kind: "approval_bundle" });
  const pageMapHash = hashCanonical(
    pages.map((page) => ({ pageId: page.pageId, pageNumber: page.pageNumber })),
  );
  const previewSnapshotHash = hashCanonical({ id, pageMapHash });
  return {
    id,
    schemaVersion: 1,
    createdAt: approvalAt,
    updatedAt: approvalAt,
    revision: 0,
    projectId: fixture.projectId,
    assetId: ulid(),
    jobId: ulid(),
    approvalCycleId: cycleId,
    approvalGateJobId: gateId,
    bookVersion: 9,
    projectVersionId: fixture.projectVersionId,
    compositionProfileId: A4_COMPOSITION_PROFILE_ID,
    compositionProfileHash: "c".repeat(64),
    coverCompositionVersionId: fixture.coverVersion.id,
    customerContentHash,
    orderedInteriorPages: pages,
    approvalBundleHash,
    pageMapHash,
    previewSnapshotHash,
    watermarkSettingsHash: "1".repeat(64),
    previewDerivativePolicyHash: "2".repeat(64),
    typographySettingsHash: "3".repeat(64),
    fontManifestHash: "4".repeat(64),
    rendererVersion: "hekayati.chromium.v1",
    validationReport: validationReport(),
    status: "ready",
    staleReasons: [],
    invalidatedByEventIds: [],
  };
}

function validationReport(): PreviewOutput["validationReport"] {
  const pageResults = Array.from({ length: 18 }, (_, index) => ({
    pageNumber: index + 1,
    mediaBoxMm: { width: 210, height: 297 },
    trimBoxMm: { width: 210, height: 297 },
    portrait: true,
    tolerancePassed: true,
    watermarkPresent: true,
    footerPresent: true,
    imagePpiMin: 150,
    fontNames: ["IBMPlexSansArabic", "Lemonada"],
  }));
  return {
    schemaVersion: 1,
    passed: true,
    pageCount: 18,
    expectedPageCount: 18,
    interiorPageCount: 16,
    bytes: 200_000,
    pageResults,
    fontNames: ["IBMPlexSansArabic", "Lemonada"],
    checks: [{ code: "PDF_PARSEABLE", passed: true, actual: null }],
    egressRequestCount: 0,
    prohibitedPdfFeatureCount: 0,
    validatedAt: approvalAt,
  };
}

function approvalCycle(
  fixture: ApprovalFixture,
  output: PreviewOutput,
  gateId: string,
): BookApprovalCycle {
  return {
    id: output.approvalCycleId,
    schemaVersion: 1,
    createdAt: approvalAt,
    updatedAt: approvalAt,
    revision: 0,
    projectId: fixture.projectId,
    previewOutputId: output.id,
    approvalGateJobId: gateId,
    targetBookVersion: output.bookVersion,
    customerContentHash: output.customerContentHash,
    approvalBundleHash: output.approvalBundleHash,
    pageMapHash: output.pageMapHash,
    previewSnapshotHash: output.previewSnapshotHash,
    coverCompositionVersionId: output.coverCompositionVersionId,
    watermarkSettingsHash: output.watermarkSettingsHash,
    state: "ready_to_send",
    notes: "",
    affectedScopes: [],
    recordedAt: approvalAt,
    invalidatedBy: null,
    attentionReasons: [],
  };
}

function advancePreviewHeads(
  fixture: ApprovalFixture,
  output: PreviewOutput,
  cycle: BookApprovalCycle,
): void {
  const current = fixture.authoring.projects.get(fixture.projectId)!;
  fixture.authoring.projects.update({
    ...current,
    revision: current.revision + 1,
    updatedAt: approvalAt,
    status: current.currentContentApprovalId ? current.status : "preview_ready",
    currentCoverCompositionVersionId: fixture.coverVersion.id,
    currentPreviewOutputId: output.id,
    currentPreviewCycleId: cycle.id,
  });
}

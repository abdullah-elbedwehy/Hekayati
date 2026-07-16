import type { AssetStore } from "../../../src/assets/asset-store.js";
import { AuthoringRepositories } from "../../../src/domain/authoring/repositories.js";
import { CreativeRepositories } from "../../../src/domain/creative/repositories.js";
import type { Page } from "../../../src/domain/creative/schemas.js";
import { BookApprovalService } from "../../../src/domain/layout/approvals.js";
import { hashCanonical } from "../../../src/domain/layout/hashes.js";
import { A4_COMPOSITION_PROFILE_ID } from "../../../src/domain/layout/policy.js";
import { LayoutRepositories } from "../../../src/domain/layout/repositories.js";
import type {
  LayoutVersion,
  PreviewInteriorPage,
  PreviewOutput,
} from "../../../src/domain/layout/schemas.js";
import type { DocumentStore } from "../../../src/domain/repository/document-store.js";
import type { JobScheduler } from "../../../src/jobs/scheduler.js";
import type { JobRecord } from "../../../src/jobs/types.js";
import { approvalActionInput } from "../layout-approval-fixtures.js";
import {
  hash,
  portabilityFixtureAt,
  succeedLocalJob,
  syntheticPdf,
  waitingGate,
  type PortabilityFixtureScope,
  type StoredAsset,
} from "./support.js";

export async function seedLayoutAndApproval(input: {
  store: DocumentStore;
  assets: AssetStore;
  scheduler: JobScheduler;
  scope: PortabilityFixtureScope;
  projectVersionId: string;
  pages: Page[];
  repeatedAssetId: string;
  nextId: () => string;
}) {
  const layout = new LayoutRepositories(input.store);
  const creative = new CreativeRepositories(input.store);
  const authoring = new AuthoringRepositories(input.store);
  const profile = layout.compositionProfiles.get(A4_COMPOSITION_PROFILE_ID);
  const repeated = input.assets.get(input.repeatedAssetId);
  if (!profile || !repeated)
    throw new Error("PORTABILITY_LAYOUT_SOURCE_MISSING");
  const layouts: LayoutVersion[] = [];
  const layoutJobs: JobRecord[] = [];
  let workRequestId: string | null = null;
  for (const page of input.pages) {
    let pageWorkRequestId: string | null = null;
    const text = page.currentTextVersionId
      ? creative.pageTexts.get(page.currentTextVersionId)
      : null;
    const illustration = page.currentIllustrationVersionId
      ? creative.illustrations.get(page.currentIllustrationVersionId)
      : null;
    const review =
      creative.reviews
        .list()
        .find((candidate) => candidate.pageId === page.id) ?? null;
    if (page.kind === "story" && (!text || !illustration || !review))
      throw new Error("PORTABILITY_REVIEWED_PAGE_INCOMPLETE");
    const jobId = input.nextId();
    if (page.kind === "story" && workRequestId === null) {
      pageWorkRequestId = input.nextId();
      workRequestId = pageWorkRequestId;
      creative.layoutWorkRequests.insert({
        id: pageWorkRequestId,
        schemaVersion: 1,
        createdAt: portabilityFixtureAt,
        updatedAt: portabilityFixtureAt,
        pageId: page.id,
        projectId: input.scope.projectId,
        textVersionId: text!.id,
        illustrationVersionId: illustration!.id,
        reason: "طلب تخطيط اصطناعي",
        requestedPlacement: "bottom",
        state: "consumed",
      });
    }
    const sourceAssets = [
      { role: "artwork", assetId: repeated.id, checksum: repeated.sha256 },
    ];
    const textSources = text
      ? [
          {
            role: "story_text",
            entityId: page.id,
            versionId: text.id,
            contentHash: hash(text.id),
          },
        ]
      : [];
    const common = {
      compositionProfileId: profile.id,
      compositionProfileHash: profile.hash,
      projectVersionId: input.projectVersionId,
      pageObservationRevision: page.revision,
      pageContentHash: hash(`page-${page.id}`),
      textVersionId: text?.id ?? null,
      illustrationVersionId: illustration?.id ?? null,
      templateVersion: "portability-fixture-v1",
      compositionInputHash: hash(`composition-${page.id}`),
      textSources,
      sourceAssets,
      typographySettingsHash: hash("typography"),
      fontManifestHash: hash("fonts"),
    };
    const inputSnapshot =
      page.kind === "story"
        ? {
            ...common,
            selectionSource: "not_applicable" as const,
            pageReviewId: review!.id,
            reviewHash: hash(review!.id),
            compositionSourcePolicyVersion: null,
          }
        : {
            ...common,
            selectionSource: "automatic_v1" as const,
            pageReviewId: null,
            reviewHash: null,
            compositionSourcePolicyVersion: "hekayati.composition-source.v1",
          };
    const record = layout.layoutVersions.insert({
      id: input.nextId(),
      schemaVersion: 1,
      createdAt: portabilityFixtureAt,
      updatedAt: portabilityFixtureAt,
      pageId: page.id,
      previousVersionId: null,
      inputSnapshot,
      requestedPlacement: pageWorkRequestId !== null ? "bottom" : "auto",
      resolvedPlacement: pageWorkRequestId !== null ? "bottom" : "top",
      resolvedRegion: { x: 0.1, y: 0.65, width: 0.8, height: 0.25 },
      readabilityAid: "panel",
      fontSizePt: 18,
      overflow: false,
      warnings: [],
      acceptance: "ready",
      bubbles: [],
      measurementHash: hash(`measurement-${page.id}`),
      layoutPolicyVersion: "hekayati.layout.v1",
      rendererVersion: "hekayati.chromium.v1",
      workRequestId: pageWorkRequestId,
      jobId,
      layoutHash: hash(`layout-${page.id}`),
    });
    layout.pageLayoutHeads.insert({
      id: page.id,
      schemaVersion: 1,
      createdAt: portabilityFixtureAt,
      updatedAt: portabilityFixtureAt,
      revision: 0,
      pageId: page.id,
      currentLayoutVersionId: record.id,
    });
    layouts.push(record);
    layoutJobs.push(
      succeedLocalJob(input.scheduler, {
        id: jobId,
        jobType: "page_layout",
        projectId: input.scope.projectId,
        intentId: `layout-${page.id}`,
        resultRefs: [record.id, page.id],
      }),
    );
  }
  const coverId = input.nextId();
  const coverSources = [
    { role: "cover_art", assetId: repeated.id, checksum: repeated.sha256 },
  ];
  const cover = layout.coverCompositionVersions.insert({
    id: coverId,
    schemaVersion: 1,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    projectId: input.scope.projectId,
    compositionProfileId: profile.id,
    compositionProfileHash: profile.hash,
    previousVersionId: null,
    projectVersionId: input.projectVersionId,
    compositionSourcePolicyVersion: "hekayati.composition-source.v1",
    selectionSource: "automatic_v1",
    textSources: [
      {
        role: "cover_title",
        entityId: input.scope.projectId,
        versionId: input.projectVersionId,
        contentHash: hash("cover-title"),
      },
    ],
    sourceAssets: coverSources,
    front: {
      title: "حكاية النقل الاصطناعية",
      childDisplayName: "نور",
      environmentLine: null,
      artworkAssetId: repeated.id,
      region: { x: 0, y: 0, width: 1, height: 1 },
    },
    back: {
      synopsis: null,
      brandLine: "حكايتي",
      artworkAssetId: null,
      region: { x: 0, y: 0, width: 1, height: 1 },
    },
    brandTemplateHash: hash("brand-template"),
    fontManifestHash: hash("fonts"),
    warnings: [],
    acceptance: "ready",
    compositionHash: hashCanonical({
      coverSources,
      projectVersionId: input.projectVersionId,
    }),
  });
  layout.coverCompositions.insert({
    id: input.scope.projectId,
    schemaVersion: 1,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    revision: 0,
    projectId: input.scope.projectId,
    currentVersionId: cover.id,
  });
  const previewPdf = await input.assets.put({
    bytes: syntheticPdf("preview"),
    extension: "pdf",
    mime: "application/pdf",
    role: "pdf_preview",
    origin: "derived",
  });
  const outputId = input.nextId();
  const cycleId = input.nextId();
  const previewJob = succeedLocalJob(input.scheduler, {
    jobType: "preview_pdf",
    projectId: input.scope.projectId,
    intentId: "preview-pdf",
    dependsOn: layoutJobs.map((job) => job.id),
    resultRefs: [previewPdf.id, outputId],
  });
  const gate = waitingGate(input.scheduler, {
    jobType: "customer_approval_gate",
    gateKind: "customer_approval",
    projectId: input.scope.projectId,
    targetId: input.scope.projectId,
    targetVersionId: outputId,
    intentId: "customer-approval",
    dependsOn: [previewJob.id],
  });
  const orderedPages = previewPages(input.pages, layouts, creative, repeated);
  const output = layout.previewOutputs.insert(
    previewOutput({
      id: outputId,
      projectId: input.scope.projectId,
      projectVersionId: input.projectVersionId,
      assetId: previewPdf.id,
      jobId: previewJob.id,
      cycleId,
      gateId: gate.id,
      coverId: cover.id,
      profileId: profile.id,
      profileHash: profile.hash,
      pages: orderedPages,
    }),
  );
  const cycle = layout.bookApprovalCycles.insert({
    id: cycleId,
    schemaVersion: 1,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    revision: 0,
    projectId: input.scope.projectId,
    previewOutputId: output.id,
    approvalGateJobId: gate.id,
    targetBookVersion: output.bookVersion,
    customerContentHash: output.customerContentHash,
    approvalBundleHash: output.approvalBundleHash,
    pageMapHash: output.pageMapHash,
    previewSnapshotHash: output.previewSnapshotHash,
    coverCompositionVersionId: cover.id,
    watermarkSettingsHash: output.watermarkSettingsHash,
    state: "ready_to_send",
    notes: "",
    affectedScopes: [],
    recordedAt: portabilityFixtureAt,
    invalidatedBy: null,
    attentionReasons: [],
  });
  layout.previewWorkflows.insert({
    id: input.scope.projectId,
    schemaVersion: 1,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    revision: 0,
    projectId: input.scope.projectId,
    state: "ready",
    inputSnapshotHash: hash("preview-input"),
    layoutJobIds: layoutJobs.map((job) => job.id),
    previewJobId: previewJob.id,
    blockingReasons: [],
    currentPreviewOutputId: output.id,
  });
  const project = authoring.projects.get(input.scope.projectId)!;
  authoring.projects.update({
    ...project,
    revision: project.revision + 1,
    updatedAt: portabilityFixtureAt,
    status: "preview_ready",
    currentCoverCompositionVersionId: cover.id,
    currentPreviewOutputId: output.id,
    currentPreviewCycleId: cycle.id,
  });
  const approvalFixture = {
    store: input.store,
    authoring,
    layout,
    scheduler: input.scheduler,
    owner: {
      customerId: input.scope.customerId,
      familyId: input.scope.familyId,
    },
    projectId: input.scope.projectId,
    projectVersionId: input.projectVersionId,
    coverVersion: cover,
    assetId: repeated.id,
    assetChecksum: repeated.sha256,
  };
  const approvals = new BookApprovalService(input.store, input.scheduler);
  approvals.act(
    approvalActionInput(
      approvalFixture,
      { output, cycle, gateId: gate.id },
      "preview_sent",
      "portability-preview-sent",
    ),
  );
  approvals.act(
    approvalActionInput(
      approvalFixture,
      { output, cycle, gateId: gate.id },
      "approved",
      "portability-approved",
    ),
  );
  return {
    output: layout.previewOutputs.get(output.id)!,
    cycleId,
    gateId: gate.id,
    cover,
    profile,
  };
}

function previewPages(
  pages: Page[],
  layouts: LayoutVersion[],
  creative: CreativeRepositories,
  asset: StoredAsset,
): PreviewInteriorPage[] {
  return pages.map((page) => {
    const layout = layouts.find((candidate) => candidate.pageId === page.id)!;
    const review =
      creative.reviews
        .list()
        .find((candidate) => candidate.pageId === page.id) ?? null;
    const textSources = page.currentTextVersionId
      ? [
          {
            role: "story_text",
            entityId: page.id,
            versionId: page.currentTextVersionId,
            contentHash: hash(page.currentTextVersionId),
          },
        ]
      : [];
    const common = {
      pageId: page.id,
      pageNumber: page.pageNumber,
      pageObservationRevision: page.revision,
      pageContentHash: layout.inputSnapshot.pageContentHash,
      layoutVersionId: layout.id,
      layoutHash: layout.layoutHash,
      textVersionId: page.currentTextVersionId,
      illustrationVersionId: page.currentIllustrationVersionId,
      compositionInputHash: layout.inputSnapshot.compositionInputHash,
      textSources,
      sourceAssets: [
        { role: "artwork", assetId: asset.id, checksum: asset.sha256 },
      ],
    };
    return page.kind === "story"
      ? {
          ...common,
          selectionSource: "not_applicable",
          pageReviewId: review!.id,
          reviewHash: hash(review!.id),
          compositionSourcePolicyVersion: null,
        }
      : {
          ...common,
          selectionSource: "automatic_v1",
          pageReviewId: null,
          reviewHash: null,
          compositionSourcePolicyVersion: "hekayati.composition-source.v1",
        };
  });
}

function previewOutput(input: {
  id: string;
  projectId: string;
  projectVersionId: string;
  assetId: string;
  jobId: string;
  cycleId: string;
  gateId: string;
  coverId: string;
  profileId: string;
  profileHash: string;
  pages: PreviewInteriorPage[];
}): PreviewOutput {
  const pageMapHash = hashCanonical(
    input.pages.map((page) => ({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
    })),
  );
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
    id: input.id,
    schemaVersion: 1,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    revision: 0,
    projectId: input.projectId,
    assetId: input.assetId,
    jobId: input.jobId,
    approvalCycleId: input.cycleId,
    approvalGateJobId: input.gateId,
    bookVersion: 1,
    projectVersionId: input.projectVersionId,
    compositionProfileId: input.profileId,
    compositionProfileHash: input.profileHash,
    coverCompositionVersionId: input.coverId,
    customerContentHash: hash("customer-content"),
    orderedInteriorPages: input.pages,
    approvalBundleHash: hash("approval-bundle"),
    pageMapHash,
    previewSnapshotHash: hash("preview-snapshot"),
    watermarkSettingsHash: hash("watermark"),
    previewDerivativePolicyHash: hash("preview-derivatives"),
    typographySettingsHash: hash("typography"),
    fontManifestHash: hash("fonts"),
    rendererVersion: "hekayati.chromium.v1",
    validationReport: {
      schemaVersion: 1,
      passed: true,
      pageCount: 18,
      expectedPageCount: 18,
      interiorPageCount: 16,
      bytes: 256,
      pageResults,
      fontNames: ["IBMPlexSansArabic", "Lemonada"],
      checks: [{ code: "PDF_PARSEABLE", passed: true, actual: null }],
      egressRequestCount: 0,
      prohibitedPdfFeatureCount: 0,
      validatedAt: portabilityFixtureAt,
    },
    status: "ready",
    staleReasons: [],
    invalidatedByEventIds: [],
  };
}

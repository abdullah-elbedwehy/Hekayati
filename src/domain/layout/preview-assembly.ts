import { ulid } from "ulid";

import type { AssetStore, PreparedAsset } from "../../assets/asset-store.js";
import type { JobRecord } from "../../jobs/schemas.js";
import type { EnqueueJobInput } from "../../jobs/types.js";
import {
  type PreviewCompositionPage,
  type PreviewDocumentImage,
  type PreviewTextBlock,
} from "../../pdf/composition-document.js";
import {
  createPreviewImageDerivative,
  previewDerivativePolicyHash,
} from "../../pdf/preview-derivatives.js";
import {
  renderPreviewPdf,
  previewRendererPolicyHash,
} from "../../pdf/preview-renderer.js";
import {
  assertPreviewPdfValid,
  type PreviewMechanicalValidationReport,
} from "../../pdf/preview-validator.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import { CreativeRepositories } from "../creative/repositories.js";
import type { Page, PageTextVersion } from "../creative/schemas.js";
import type { DocumentStore } from "../repository/document-store.js";
import { failLayout } from "./errors.js";
import {
  type ApprovedCoverArtwork,
  type ApprovedCoverContent,
  approvedCoverTextSamples,
  compileApprovedCoverContent,
  toPreviewCoverTextBlock,
} from "./cover-content.js";
import {
  createApprovalBundleHash,
  createCustomerContentHash,
  createPageMapHash,
  hashCanonical,
} from "./hashes.js";
import { LayoutRepositories } from "./repositories.js";
import type {
  BookApprovalCycle,
  LayoutVersion,
  PreviewInteriorPage,
  PreviewOutput,
  PreviewValidationReport,
} from "./schemas.js";
import type {
  PreviewJobSnapshot,
  PreviewWorkflowCoordinator,
} from "./workflow.js";

const previewRendererVersion = "hekayati.chromium.v1";
const defaultFooter = "معاينة — غير مخصصة للطباعة";

export interface PreviewCommitScheduler {
  enqueue(input: EnqueueJobInput): JobRecord;
}

export interface PreviewAssemblyOptions {
  now?: () => string;
  idFactory?: () => string;
}

export interface PreparedPreviewAssembly {
  asset: PreparedAsset;
  output: PreviewOutput;
  cycle: BookApprovalCycle;
  gateId: string;
  snapshotFingerprint: string;
}

interface PreviewPageEntry {
  page: Page;
  layout: LayoutVersion;
  text: string;
  textVersion: PageTextVersion | null;
  image: PreviewDocumentImage | undefined;
}

export class PreviewAssemblyService {
  private readonly authoring: AuthoringRepositories;
  private readonly creative: CreativeRepositories;
  private readonly layout: LayoutRepositories;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: DocumentStore,
    private readonly assets: AssetStore,
    private readonly workflow: PreviewWorkflowCoordinator,
    private readonly scheduler: PreviewCommitScheduler,
    options: PreviewAssemblyOptions = {},
  ) {
    this.authoring = new AuthoringRepositories(store);
    this.creative = new CreativeRepositories(store);
    this.layout = new LayoutRepositories(store);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
  }

  async prepare(job: Readonly<JobRecord>): Promise<PreparedPreviewAssembly> {
    const snapshot = this.workflow.previewJobSnapshot(job);
    const { entries, documentInput, requiredCoverText } =
      await this.compileDocument(snapshot);
    const rendered = await renderPreviewPdf(documentInput);
    const report = await assertPreviewPdfValid(rendered.pdfBytes, {
      pageMap: rendered.pageMap,
      watermarkText: snapshot.watermarkText,
      footerText: defaultFooter,
      composition: {
        widthMm: snapshot.profile.trimWidthMm,
        heightMm: snapshot.profile.trimHeightMm,
        toleranceMm: snapshot.profile.dimensionToleranceMm,
      },
      maximumBytes: 16 * 1024 * 1024,
      minimumImagePpi: 140,
      maximumImagePpi: 160,
      requiredTextSamples: requiredCoverText,
      egressRequestCount: rendered.egressRequestCount,
    });
    const asset = await this.assets.prepare({
      bytes: rendered.pdfBytes,
      extension: "pdf",
      mime: "application/pdf",
      role: "pdf_preview",
      origin: "derived",
    });
    const ids = {
      outputId: this.idFactory(),
      cycleId: this.idFactory(),
      gateId: this.idFactory(),
    };
    const output = previewOutput(
      job,
      snapshot,
      entries,
      asset,
      report,
      rendered.documentHash,
      ids,
      this.now(),
    );
    return {
      asset,
      output,
      cycle: approvalCycle(output, ids.gateId),
      gateId: ids.gateId,
      snapshotFingerprint: previewSnapshotFingerprint(snapshot),
    };
  }

  commit(job: Readonly<JobRecord>, prepared: PreparedPreviewAssembly) {
    const snapshot = this.workflow.previewJobSnapshot(job);
    if (
      previewSnapshotFingerprint(snapshot) !== prepared.snapshotFingerprint ||
      prepared.output.jobId !== job.id ||
      prepared.output.projectId !== snapshot.project.id
    )
      failLayout("LAYOUT_PREVIEW_STALE");
    const asset = this.assets.commitPrepared(prepared.asset);
    if (asset.id !== prepared.output.assetId)
      failLayout("LAYOUT_PREVIEW_ASSET_INVALID");
    const gate = this.scheduler.enqueue(
      approvalGateInput(job, prepared.output, prepared.gateId),
    );
    if (gate.id !== prepared.gateId) failLayout("LAYOUT_WORKFLOW_CONFLICT");
    this.layout.previewOutputs.insert(prepared.output);
    this.layout.bookApprovalCycles.insert(prepared.cycle);
    this.advanceHeads(snapshot, prepared.output);
    return {
      resultRefs: [asset.id, prepared.output.id, prepared.cycle.id, gate.id],
    };
  }

  async discard(prepared: PreparedPreviewAssembly): Promise<void> {
    await this.assets.discardPrepared(prepared.asset);
  }

  private async compileDocument(snapshot: PreviewJobSnapshot) {
    const imageCache = new Map<string, PreviewDocumentImage>();
    const entries = await this.pageEntries(snapshot, imageCache);
    const cover = approvedCoverContent(snapshot.cover);
    const coverImages = await this.previewCoverImages(cover, imageCache);
    return {
      entries,
      requiredCoverText: approvedCoverTextSamples(cover),
      documentInput: previewDocumentInput(
        snapshot,
        entries,
        cover,
        coverImages,
      ),
    };
  }

  private async pageEntries(
    snapshot: PreviewJobSnapshot,
    cache: Map<string, PreviewDocumentImage>,
  ): Promise<PreviewPageEntry[]> {
    const result: PreviewPageEntry[] = [];
    for (const item of snapshot.pages) {
      const textVersion = item.page.currentTextVersionId
        ? this.creative.pageTexts.get(item.page.currentTextVersionId)
        : null;
      result.push({
        ...item,
        textVersion,
        text: pageText(item.page, textVersion, snapshot),
        image: await this.previewImage(item.layout, cache),
      });
    }
    return result;
  }

  private async previewImage(
    layout: LayoutVersion,
    cache: Map<string, PreviewDocumentImage>,
  ): Promise<PreviewDocumentImage | undefined> {
    const source = layout.inputSnapshot.sourceAssets[0];
    if (!source) return undefined;
    return this.previewAsset(source, cache, "رسم توضيحي للصفحة");
  }

  private async previewCoverImages(
    cover: ApprovedCoverContent,
    cache: Map<string, PreviewDocumentImage>,
  ): Promise<{
    back: PreviewDocumentImage | undefined;
    front: PreviewDocumentImage | undefined;
  }> {
    const image = (source: ApprovedCoverArtwork | null, alt: string) =>
      source ? this.previewAsset(source, cache, alt) : undefined;
    const [back, front] = await Promise.all([
      image(cover.back.artwork, "رسم الغلاف الخلفي"),
      image(cover.front.artwork, "رسم الغلاف الأمامي"),
    ]);
    return { back, front };
  }

  private async previewAsset(
    source: { assetId: string; checksum: string },
    cache: Map<string, PreviewDocumentImage>,
    alt: string,
  ): Promise<PreviewDocumentImage> {
    const key = `${source.assetId}:${source.checksum}`;
    const prior = cache.get(key);
    if (prior) return prior;
    const record = this.assets.get(source.assetId);
    if (!record || record.sha256 !== source.checksum)
      failLayout("LAYOUT_PREVIEW_ASSET_INVALID");
    const derivative = await createPreviewImageDerivative({
      sourceBytes: await this.assets.read(source.assetId),
      placedWidthMm: 210,
      placedHeightMm: 297,
      fit: "cover",
    });
    const image = {
      bytes: derivative.bytes,
      mime: derivative.mime,
      alt,
      widthPx: derivative.widthPx,
      heightPx: derivative.heightPx,
    } satisfies PreviewDocumentImage;
    cache.set(key, image);
    return image;
  }

  private advanceHeads(
    snapshot: PreviewJobSnapshot,
    output: PreviewOutput,
  ): void {
    const workflow = this.layout.previewWorkflows.get(snapshot.workflow.id);
    const project = this.authoring.projects.get(snapshot.project.id);
    if (
      !workflow ||
      !project ||
      workflow.revision !== snapshot.workflow.revision ||
      project.revision !== snapshot.project.revision
    )
      failLayout("LAYOUT_PREVIEW_STALE");
    this.layout.previewWorkflows.update(workflow.revision, {
      ...workflow,
      revision: workflow.revision + 1,
      updatedAt: output.updatedAt,
      state: "ready",
      currentPreviewOutputId: output.id,
    });
    const prior = project.currentContentApprovalId
      ? this.layout.bookApprovalCycles.get(project.currentContentApprovalId)
      : null;
    const preservesLifecycle =
      prior?.state === "approved" &&
      prior.customerContentHash === output.customerContentHash;
    this.authoring.projects.update({
      ...project,
      revision: project.revision + 1,
      updatedAt: output.updatedAt,
      status: preservesLifecycle ? project.status : "preview_ready",
      currentPreviewOutputId: output.id,
      currentPreviewCycleId: output.approvalCycleId,
    });
  }
}

function previewDocumentInput(
  snapshot: PreviewJobSnapshot,
  entries: readonly PreviewPageEntry[],
  cover: ApprovedCoverContent,
  coverImages: {
    back: PreviewDocumentImage | undefined;
    front: PreviewDocumentImage | undefined;
  },
) {
  return {
    pages: [
      coverPage("front_cover", cover.front, coverImages.front),
      ...entries.map(compositionPage),
      coverPage("back_cover", cover.back, coverImages.back),
    ],
    watermarkText: snapshot.watermarkText,
    footerText: defaultFooter,
  };
}

function compositionPage(entry: PreviewPageEntry): PreviewCompositionPage {
  return {
    kind: previewKind(entry.page.kind),
    interiorPageNumber: entry.page.pageNumber,
    image: entry.image,
    text: textBlock(entry.text, entry.layout, entry.page.kind),
    bubbles: entry.layout.bubbles.map((bubble) => ({
      speakerLabel: bubble.speakerLabel,
      body: bubble.text,
      region: bubble.region,
      ...(bubble.pointerAnchor ? { pointer: bubble.pointerAnchor } : {}),
    })),
  };
}

function coverPage(
  kind: "front_cover" | "back_cover",
  panel: ApprovedCoverContent["front"],
  image?: PreviewDocumentImage,
): PreviewCompositionPage {
  return {
    kind,
    interiorPageNumber: null,
    image,
    text: toPreviewCoverTextBlock(panel.text),
  };
}

function approvedCoverContent(
  cover: PreviewJobSnapshot["cover"],
): ApprovedCoverContent {
  try {
    return compileApprovedCoverContent(cover);
  } catch {
    failLayout("LAYOUT_PREVIEW_STALE");
  }
}

function textBlock(
  text: string,
  layout: LayoutVersion,
  kind: Page["kind"],
): PreviewTextBlock {
  return {
    ...(kind === "title" || kind === "ending2"
      ? { heading: text }
      : { body: text }),
    region: layout.resolvedRegion,
    fontSizePt: layout.fontSizePt,
    aid: layout.readabilityAid,
  };
}

function pageText(
  page: Page,
  text: PageTextVersion | null,
  snapshot: PreviewJobSnapshot,
): string {
  const config = snapshot.cover;
  if (page.kind === "story") {
    if (!text) failLayout("LAYOUT_PREVIEW_STALE");
    return text.narrative;
  }
  if (page.kind === "title") return config.front.title;
  if (page.kind === "dedication")
    return snapshot.projectVersion.storyConfig.dedicationText;
  if (page.kind === "ending1")
    return snapshot.projectVersion.storyConfig.endingPages.farewellText;
  return `${config.back.brandLine}\n${config.front.childDisplayName}`;
}

function previewKind(kind: Page["kind"]): PreviewCompositionPage["kind"] {
  if (kind === "ending1") return "farewell";
  if (kind === "ending2") return "brand";
  return kind;
}

function previewOutput(
  job: Readonly<JobRecord>,
  snapshot: PreviewJobSnapshot,
  entries: readonly PreviewPageEntry[],
  asset: PreparedAsset,
  report: PreviewMechanicalValidationReport,
  documentHash: string,
  ids: { outputId: string; cycleId: string; gateId: string },
  at: string,
): PreviewOutput {
  const interior = entries.map(interiorEntry);
  const hashes = previewOutputHashes(
    snapshot,
    interior,
    asset,
    documentHash,
    ids.outputId,
  );
  return {
    id: ids.outputId,
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    revision: 0,
    projectId: snapshot.project.id,
    assetId: asset.record.id,
    jobId: job.id,
    approvalCycleId: ids.cycleId,
    approvalGateJobId: ids.gateId,
    bookVersion: snapshot.project.bookVersion,
    projectVersionId: snapshot.project.currentVersionId,
    compositionProfileId: snapshot.profile.id,
    compositionProfileHash: snapshot.profile.hash,
    coverCompositionVersionId: snapshot.cover.id,
    customerContentHash: hashes.customerContentHash,
    orderedInteriorPages: interior,
    approvalBundleHash: hashes.approvalBundleHash,
    pageMapHash: hashes.pageMapHash,
    previewSnapshotHash: hashes.previewSnapshotHash,
    watermarkSettingsHash: snapshot.watermarkSettingsHash,
    previewDerivativePolicyHash,
    typographySettingsHash: firstLayoutInput(entries).typographySettingsHash,
    fontManifestHash: firstLayoutInput(entries).fontManifestHash,
    rendererVersion: previewRendererVersion,
    validationReport: persistedValidationReport(report, entries.length),
    status: "ready",
    staleReasons: [],
    invalidatedByEventIds: [],
  };
}

function firstLayoutInput(entries: readonly PreviewPageEntry[]) {
  return entries[0].layout.inputSnapshot;
}

function previewOutputHashes(
  snapshot: PreviewJobSnapshot,
  interior: readonly PreviewInteriorPage[],
  asset: PreparedAsset,
  documentHash: string,
  outputId: string,
) {
  const customerContentHash = createCustomerContentHash({
    compositionProfileHash: snapshot.profile.hash,
    coverCompositionHash: snapshot.cover.compositionHash,
    pages: interior,
  });
  const pageMapHash = createPageMapHash(interior);
  const reviewEvidenceHash = hashCanonical(
    interior.map((page) => ({
      pageId: page.pageId,
      pageReviewId: page.pageReviewId,
      reviewHash: page.reviewHash,
      selectionSource: page.selectionSource,
    })),
  );
  const previewSnapshotHash = hashCanonical({
    outputId,
    projectVersionId: snapshot.project.currentVersionId,
    bookVersion: snapshot.project.bookVersion,
    coverVersionId: snapshot.cover.id,
    pageMapHash,
    documentHash,
    rendererPolicyHash: previewRendererPolicyHash,
    pdfSha256: asset.record.sha256,
  });
  return {
    customerContentHash,
    pageMapHash,
    previewSnapshotHash,
    approvalBundleHash: createApprovalBundleHash({
      previewOutputId: outputId,
      customerContentHash,
      reviewEvidenceHash,
      watermarkSettingsHash: snapshot.watermarkSettingsHash,
      previewDerivativePolicyHash,
    }),
  };
}

function interiorEntry(entry: PreviewPageEntry): PreviewInteriorPage {
  const input = entry.layout.inputSnapshot;
  return {
    pageId: entry.page.id,
    pageNumber: entry.page.pageNumber,
    pageObservationRevision: entry.page.revision,
    pageContentHash: input.pageContentHash,
    layoutVersionId: entry.layout.id,
    layoutHash: entry.layout.layoutHash,
    textVersionId: input.textVersionId,
    illustrationVersionId: input.illustrationVersionId,
    compositionInputHash: input.compositionInputHash,
    textSources: input.textSources,
    sourceAssets: input.sourceAssets,
    selectionSource: input.selectionSource,
    pageReviewId: input.pageReviewId,
    reviewHash: input.reviewHash,
    compositionSourcePolicyVersion: input.compositionSourcePolicyVersion,
  } as PreviewInteriorPage;
}

function persistedValidationReport(
  report: PreviewMechanicalValidationReport,
  interiorCount: number,
): PreviewValidationReport {
  if (!report.passed || (interiorCount !== 16 && interiorCount !== 24))
    failLayout("LAYOUT_PREVIEW_ASSET_INVALID");
  const fontNames = report.fonts.map((font) => font.name);
  return {
    schemaVersion: 1,
    passed: true,
    pageCount: report.pageCount,
    expectedPageCount: report.expectedPageCount,
    interiorPageCount: interiorCount,
    bytes: report.bytes,
    pageResults: report.pageResults.map((page) => ({
      pageNumber: page.pageNumber,
      mediaBoxMm: requireBox(page.mediaBoxMm),
      trimBoxMm: page.trimBoxMm,
      portrait:
        page.rotation === 0 &&
        Boolean(
          page.mediaBoxMm && page.mediaBoxMm.width < page.mediaBoxMm.height,
        ),
      tolerancePassed: true,
      watermarkPresent: page.watermarkPresent,
      footerPresent: page.footerPresent,
      imagePpiMin: page.minimumImagePpi,
      fontNames,
    })),
    fontNames,
    checks: [
      "PDF_PARSEABLE",
      "PAGE_COUNT_MATCH",
      "PAGE_GEOMETRY_MATCH",
      "FONTS_EMBEDDED",
      "WATERMARK_PRESENT",
      "FOOTER_PRESENT",
      "IMAGE_PPI_MATCH",
      "ZERO_EGRESS",
    ].map((code) => ({ code, passed: true, actual: null })),
    egressRequestCount: 0,
    prohibitedPdfFeatureCount: 0,
    validatedAt: report.validatedAt,
  };
}

function requireBox(value: { width: number; height: number } | null): {
  width: number;
  height: number;
} {
  if (!value) failLayout("LAYOUT_PREVIEW_ASSET_INVALID");
  return value;
}

function approvalCycle(
  output: PreviewOutput,
  gateId: string,
): BookApprovalCycle {
  return {
    id: output.approvalCycleId,
    schemaVersion: 1,
    createdAt: output.createdAt,
    updatedAt: output.updatedAt,
    revision: 0,
    projectId: output.projectId,
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
    recordedAt: output.updatedAt,
    invalidatedBy: null,
    attentionReasons: [],
  };
}

function approvalGateInput(
  job: Readonly<JobRecord>,
  output: PreviewOutput,
  gateId: string,
): EnqueueJobInput {
  return {
    id: gateId,
    jobType: "human_gate",
    projectId: output.projectId,
    standaloneScopeId: null,
    dependsOn: [job.id],
    priority: job.priority,
    intentId: `approval-${output.id}`,
    target: null,
    request: {
      kind: "human_gate",
      gateKind: "customer_approval",
      targetId: output.projectId,
      targetVersionId: output.id,
    },
    inputSnapshot: {
      previewOutputId: output.id,
      approvalCycleId: output.approvalCycleId,
      customerContentHash: output.customerContentHash,
      approvalBundleHash: output.approvalBundleHash,
    },
  };
}

function previewSnapshotFingerprint(snapshot: PreviewJobSnapshot): string {
  return hashCanonical({
    projectId: snapshot.project.id,
    projectRevision: snapshot.project.revision,
    bookVersion: snapshot.project.bookVersion,
    workflowRevision: snapshot.workflow.revision,
    workflowHash: snapshot.workflow.inputSnapshotHash,
    coverId: snapshot.cover.id,
    coverHash: snapshot.cover.compositionHash,
    watermarkSettingsHash: snapshot.watermarkSettingsHash,
    pages: snapshot.pages.map(({ page, layout }) => ({
      pageId: page.id,
      pageRevision: page.revision,
      layoutId: layout.id,
      layoutHash: layout.layoutHash,
      pageContentHash: layout.inputSnapshot.pageContentHash,
      sourceAssets: layout.inputSnapshot.sourceAssets,
    })),
  });
}

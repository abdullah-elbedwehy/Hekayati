import { ulid } from "ulid";

import type { JobRecord } from "../../jobs/schemas.js";
import type { EnqueueJobInput } from "../../jobs/types.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import type { Project } from "../authoring/schemas.js";
import { CreativeRepositories } from "../creative/repositories.js";
import type { Page } from "../creative/schemas.js";
import type { AppendChangeEventInput } from "../creative/invalidation.js";
import type { DocumentStore } from "../repository/document-store.js";
import { failLayout } from "./errors.js";
import { hashCanonical } from "./hashes.js";
import { LayoutRepositories } from "./repositories.js";
import type {
  CoverCompositionVersion,
  LayoutVersion,
  PreviewWorkflow,
} from "./schemas.js";
import {
  resolveCompositionSources,
  requireEligibleCompositionAsset,
  type CompositionAssetCatalog,
  type CompositionSourceAsset,
} from "./sources.js";
import {
  coverMatches,
  coverVersion,
  currentLayoutMatches,
  hasPendingLayoutRequest,
  layoutJobAssetId,
  latestPendingLayoutRequest,
  LAYOUT_FONT_MANIFEST_HASH,
  operatorCoverVersion,
  pageInputBlock,
  parseRequestedPlacement,
  projectPriority,
  workflowInputHash,
  type ChangeCoverCompositionInput,
  type ChangeSpecialCompositionSourceInput,
  type LayoutJobSource,
  type LayoutReadiness,
  type PreviewJobSnapshot,
  type RegeneratePreviewInput,
  type WorkflowSnapshot,
} from "./workflow-support.js";

export {
  COVER_BRAND_TEMPLATE_HASH,
  layoutWorkflowAsset,
  LAYOUT_FONT_MANIFEST_HASH,
} from "./workflow-support.js";
export type {
  ChangeCoverCompositionInput,
  ChangeSpecialCompositionSourceInput,
  LayoutJobSource,
  PreviewJobSnapshot,
  RegeneratePreviewInput,
} from "./workflow-support.js";

export interface LayoutWorkflowSettings {
  get(): {
    typography: {
      minimumAge3To5Pt: number;
      minimumAge6PlusPt: number;
    };
    watermarkText: string;
  };
}

export interface LayoutWorkflowScheduler {
  enqueue(input: EnqueueJobInput): JobRecord;
  enqueueMany(inputs: readonly EnqueueJobInput[]): JobRecord[];
  get(id: string): JobRecord | null;
}

export interface LayoutInvalidationRecorder {
  recordAndConsume(input: AppendChangeEventInput): unknown;
}

export interface PreviewWorkflowOptions {
  now?: () => string;
  idFactory?: () => string;
}

export class PreviewWorkflowCoordinator {
  private readonly authoring: AuthoringRepositories;
  private readonly creative: CreativeRepositories;
  private readonly layout: LayoutRepositories;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private scheduler: LayoutWorkflowScheduler | null = null;
  private invalidation: LayoutInvalidationRecorder | null = null;

  constructor(
    private readonly store: DocumentStore,
    private readonly assets: CompositionAssetCatalog,
    private readonly settings: LayoutWorkflowSettings,
    options: PreviewWorkflowOptions = {},
  ) {
    this.authoring = new AuthoringRepositories(store);
    this.creative = new CreativeRepositories(store);
    this.layout = new LayoutRepositories(store);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
  }

  bindScheduler(scheduler: LayoutWorkflowScheduler): void {
    if (this.scheduler && this.scheduler !== scheduler)
      failLayout("LAYOUT_WORKFLOW_CONFLICT");
    this.scheduler = scheduler;
  }

  bindInvalidation(invalidation: LayoutInvalidationRecorder): void {
    if (this.invalidation && this.invalidation !== invalidation)
      failLayout("LAYOUT_WORKFLOW_CONFLICT");
    this.invalidation = invalidation;
  }

  start(projectId: string): PreviewWorkflow {
    return this.store.transaction(() => {
      const snapshot = this.snapshot(projectId);
      const existing = this.layout.previewWorkflows.get(projectId);
      if (
        existing?.inputSnapshotHash === snapshot.inputHash &&
        existing.state !== "failed" &&
        !hasPendingLayoutRequest(snapshot.pages, this.creative)
      )
        return existing.state === "ready" || existing.state === "pdf_pending"
          ? existing
          : this.advanceInTransaction(projectId);
      const readiness = this.layoutReadiness(snapshot);
      const jobs = readiness.blockingReasons.length
        ? []
        : this.materializeLayoutJobs(snapshot, readiness.needsJobs);
      const workflow = this.putWorkflow(existing, snapshot, readiness, jobs);
      if (readiness.blockingReasons.length) return workflow;
      return jobs.length ? workflow : this.advanceInTransaction(projectId);
    });
  }

  regenerate(
    projectId: string,
    input: RegeneratePreviewInput,
  ): PreviewWorkflow {
    return this.store.transaction(() => {
      const snapshot = this.snapshot(projectId);
      const existing = this.layout.previewWorkflows.get(projectId);
      if (!existing) failLayout("LAYOUT_WORKFLOW_NOT_FOUND", 404);
      if (
        snapshot.project.revision !== input.expectedProjectRevision ||
        existing.revision !== input.expectedWorkflowRevision
      )
        failLayout("LAYOUT_REVISION_CONFLICT");
      return this.restartWorkflowInTransaction(existing, snapshot);
    });
  }

  changeSpecialCompositionSource(
    projectId: string,
    input: ChangeSpecialCompositionSourceInput,
  ): PreviewWorkflow {
    return this.store.transaction(() => {
      const page = this.creative.pages.get(input.pageId);
      const workflow = this.layout.previewWorkflows.get(projectId);
      if (!page || page.projectId !== projectId)
        failLayout("LAYOUT_PAGE_NOT_FOUND", 404);
      if (page.kind === "story") failLayout("LAYOUT_PAGE_KIND_INVALID");
      if (
        page.revision !== input.expectedPageRevision ||
        workflow?.revision !== input.expectedWorkflowRevision
      )
        failLayout("LAYOUT_REVISION_CONFLICT");
      if (page.locked && this.layout.pageLayoutHeads.get(page.id))
        failLayout("LAYOUT_LOCKED_REPLACEMENT");
      const selected = input.assetId
        ? requireEligibleCompositionAsset(
            this.store,
            this.assets,
            projectId,
            input.assetId,
          )
        : null;
      if (page.kind !== "dedication" && !selected)
        failLayout("LAYOUT_COMPOSITION_SOURCE_REQUIRED");
      const next = this.enqueueSpecialCompositionJob(
        workflow,
        page,
        selected,
        input.requestedPlacement,
      );
      this.recordVisibleChange({
        entity: "layout",
        entityId: page.id,
        fromVersionId:
          this.layout.pageLayoutHeads.get(page.id)?.currentLayoutVersionId ??
          null,
        toVersionId: next.layoutJobIds[0] ?? null,
        changedFields: ["compositionSource", "requestedPlacement"],
      });
      return next;
    });
  }

  changeCoverComposition(
    projectId: string,
    input: ChangeCoverCompositionInput,
  ): { cover: CoverCompositionVersion; workflow: PreviewWorkflow } {
    return this.store.transaction(() => {
      const { snapshot, workflow, current } = this.requireCoverEditContext(
        projectId,
        input,
      );
      const front = requireEligibleCompositionAsset(
        this.store,
        this.assets,
        projectId,
        input.frontArtworkAssetId,
      );
      const back = input.backArtworkAssetId
        ? requireEligibleCompositionAsset(
            this.store,
            this.assets,
            projectId,
            input.backArtworkAssetId,
          )
        : null;
      const at = this.now();
      const cover = this.layout.coverCompositionVersions.insert(
        operatorCoverVersion(
          snapshot,
          current,
          input,
          front,
          back,
          at,
          this.idFactory(),
        ),
      );
      this.advanceCoverHeads(snapshot.project, cover, at, false);
      this.recordVisibleChange({
        entity: "book_content",
        entityId: projectId,
        fromVersionId: current.id,
        toVersionId: cover.id,
        changedFields: ["coverComposition"],
      });
      const refreshed = this.snapshot(projectId);
      return {
        cover,
        workflow: this.restartWorkflowInTransaction(workflow, refreshed),
      };
    });
  }

  private requireCoverEditContext(
    projectId: string,
    input: ChangeCoverCompositionInput,
  ) {
    const snapshot = this.snapshot(projectId);
    const workflow = this.layout.previewWorkflows.get(projectId);
    const current = snapshot.project.currentCoverCompositionVersionId
      ? this.layout.coverCompositionVersions.get(
          snapshot.project.currentCoverCompositionVersionId,
        )
      : null;
    if (!workflow || !current) failLayout("LAYOUT_WORKFLOW_NOT_FOUND", 404);
    if (
      snapshot.project.revision !== input.expectedProjectRevision ||
      workflow.revision !== input.expectedWorkflowRevision ||
      current.id !== input.expectedCoverVersionId
    )
      failLayout("LAYOUT_REVISION_CONFLICT");
    return { snapshot, workflow, current };
  }

  private recordVisibleChange(input: {
    entity: "layout" | "book_content";
    entityId: string;
    fromVersionId: string | null;
    toVersionId: string | null;
    changedFields: string[];
  }): void {
    if (!this.invalidation) failLayout("LAYOUT_WORKFLOW_CONFLICT");
    const eventId = this.idFactory();
    this.invalidation.recordAndConsume({
      id: eventId,
      ...input,
      changeType: "book_content",
      matrixRow: "IM-12",
      correlationId: eventId,
    });
  }

  advance(projectId: string): PreviewWorkflow {
    return this.store.transaction(() => this.advanceInTransaction(projectId));
  }

  layoutJobSource(job: Readonly<JobRecord>): LayoutJobSource {
    if (job.jobType !== "page_layout" || !job.projectId)
      failLayout("LAYOUT_WORKFLOW_CONFLICT");
    const workflow = this.layout.previewWorkflows.get(job.projectId);
    const page = this.creative.pages.get(job.inputSnapshot.pageId ?? "");
    if (
      !workflow ||
      !page ||
      workflow.inputSnapshotHash !== job.inputSnapshot.workflowHash ||
      page.projectId !== job.projectId ||
      String(page.revision) !== job.inputSnapshot.pageRevision
    )
      failLayout("LAYOUT_STALE_INPUT");
    const sources = resolveCompositionSources(
      this.store,
      this.assets,
      job.projectId,
    );
    const selectedAsset = this.selectedJobAsset(job, sources.project.id);
    return {
      projectId: job.projectId,
      page,
      workflowHash: workflow.inputSnapshotHash,
      sourceAssetId:
        selectedAsset?.assetId ??
        layoutJobAssetId(page, sources, this.creative),
      selectedAsset,
      selectionSource:
        job.inputSnapshot.selectionSource === "operator"
          ? "operator"
          : "automatic_v1",
      requestedPlacement: parseRequestedPlacement(
        job.inputSnapshot.requestedPlacement,
      ),
      workRequestId:
        job.inputSnapshot.workRequestId === "none"
          ? null
          : (job.inputSnapshot.workRequestId ?? null),
      typographySettingsHash: job.inputSnapshot.typographySettingsHash ?? "",
      fontManifestHash: job.inputSnapshot.fontManifestHash ?? "",
    };
  }

  private selectedJobAsset(
    job: Readonly<JobRecord>,
    projectId: string,
  ): CompositionSourceAsset | null {
    if (job.inputSnapshot.selectionSource !== "operator") return null;
    const assetId = job.inputSnapshot.selectedAssetId;
    if (!assetId || assetId === "none") return null;
    const selected = requireEligibleCompositionAsset(
      this.store,
      this.assets,
      projectId,
      assetId,
    );
    if (selected.checksum !== job.inputSnapshot.selectedAssetChecksum)
      failLayout("LAYOUT_STALE_INPUT");
    return selected;
  }

  projectWorkflow(projectId: string): PreviewWorkflow | null {
    return this.layout.previewWorkflows.get(projectId);
  }

  workflowStore(): DocumentStore {
    return this.store;
  }

  previewJobSnapshot(job: Readonly<JobRecord>): PreviewJobSnapshot {
    const { workflow, project } = this.previewJobBase(job);
    const snapshot = this.snapshot(project.id);
    const readiness = this.layoutReadiness(snapshot);
    const cover = project.currentCoverCompositionVersionId
      ? this.layout.coverCompositionVersions.get(
          project.currentCoverCompositionVersionId,
        )
      : null;
    const profile = this.layout.compositionProfiles.get(
      project.compositionProfileId,
    );
    const watermarkText = this.settings.get().watermarkText;
    const watermarkSettingsHash = hashCanonical(watermarkText);
    if (
      snapshot.inputHash !== workflow.inputSnapshotHash ||
      !readiness.ready ||
      !cover ||
      !coverMatches(cover, snapshot, this.assets) ||
      !profile ||
      watermarkSettingsHash !== job.inputSnapshot.watermarkSettingsHash
    )
      failLayout("LAYOUT_PREVIEW_STALE");
    return {
      project,
      projectVersion: snapshot.sources.projectVersion,
      workflow,
      profile,
      cover,
      pages: snapshot.pages.map((page) => ({
        page,
        layout: this.requireCurrentLayout(page),
      })),
      watermarkText,
      watermarkSettingsHash,
    };
  }

  private advanceInTransaction(projectId: string): PreviewWorkflow {
    const workflow = this.layout.previewWorkflows.get(projectId);
    if (!workflow) failLayout("LAYOUT_WORKFLOW_NOT_FOUND", 404);
    if (workflow.state === "ready" || workflow.state === "pdf_pending")
      return workflow;
    const snapshot = this.snapshot(projectId);
    if (snapshot.inputHash !== workflow.inputSnapshotHash)
      failLayout("LAYOUT_WORKFLOW_CONFLICT");
    const readiness = this.layoutReadiness(snapshot);
    if (readiness.blockingReasons.length)
      return this.updateWorkflow(workflow, {
        state: "operator_action_required",
        blockingReasons: readiness.blockingReasons,
      });
    if (!readiness.ready) return workflow;
    const cover = this.ensureCover(snapshot);
    if (cover.acceptance !== "ready")
      return this.updateWorkflow(workflow, {
        state: "operator_action_required",
        blockingReasons: ["COVER_OPERATOR_ACTION_REQUIRED"],
      });
    return this.materializePreviewJob(workflow, snapshot, cover);
  }

  private restartWorkflowInTransaction(
    existing: PreviewWorkflow,
    snapshot: WorkflowSnapshot,
  ): PreviewWorkflow {
    const readiness = this.layoutReadiness(snapshot);
    const jobs = readiness.blockingReasons.length
      ? []
      : this.materializeLayoutJobs(snapshot, readiness.needsJobs);
    const workflow = this.putWorkflow(existing, snapshot, readiness, jobs);
    if (readiness.blockingReasons.length || jobs.length) return workflow;
    return this.advanceInTransaction(snapshot.project.id);
  }

  private snapshot(projectId: string): WorkflowSnapshot {
    const sources = resolveCompositionSources(
      this.store,
      this.assets,
      projectId,
    );
    const pages = this.creative.pages
      .queryByField("projectId", projectId)
      .sort((left, right) => left.pageNumber - right.pageNumber);
    const expected = sources.projectVersion.storyConfig.pageCount;
    if (pages.length !== expected) failLayout("LAYOUT_WORKFLOW_NOT_READY");
    const typographySettingsHash = hashCanonical(
      this.settings.get().typography,
    );
    const inputHash = workflowInputHash(
      sources,
      pages,
      this.creative,
      this.assets,
      typographySettingsHash,
    );
    return {
      project: sources.project,
      pages,
      inputHash,
      typographySettingsHash,
      sources,
    };
  }

  private layoutReadiness(snapshot: WorkflowSnapshot): LayoutReadiness {
    const blockingReasons: string[] = [];
    if (!snapshot.sources.hero)
      blockingReasons.push("COMPOSITION_SOURCE_REQUIRED");
    const needsJobs: Page[] = [];
    for (const page of snapshot.pages) {
      const inputBlock = pageInputBlock(page, this.creative, this.assets);
      if (inputBlock) {
        blockingReasons.push(`${inputBlock}_${page.pageNumber}`);
        continue;
      }
      const head = this.layout.pageLayoutHeads.get(page.id);
      const version = head
        ? this.layout.layoutVersions.get(head.currentLayoutVersionId)
        : null;
      if (version?.acceptance === "needs_operator") {
        blockingReasons.push(
          `LAYOUT_OPERATOR_ACTION_REQUIRED_${page.pageNumber}`,
        );
        continue;
      }
      if (
        currentLayoutMatches(
          page,
          version,
          snapshot,
          this.creative,
          this.assets,
        )
      )
        continue;
      if (head && page.locked) {
        blockingReasons.push(`LAYOUT_LOCKED_REPLACEMENT_${page.pageNumber}`);
        continue;
      }
      needsJobs.push(page);
    }
    return {
      ready: needsJobs.length === 0 && blockingReasons.length === 0,
      needsJobs,
      blockingReasons: [...new Set(blockingReasons)],
    };
  }

  private materializeLayoutJobs(
    snapshot: WorkflowSnapshot,
    pages: readonly Page[],
  ): JobRecord[] {
    const scheduler = this.requireScheduler();
    return scheduler.enqueueMany(
      pages.map((page) => this.layoutJobInput(snapshot, page)),
    );
  }

  private layoutJobInput(
    snapshot: WorkflowSnapshot,
    page: Page,
  ): EnqueueJobInput {
    const workRequest = latestPendingLayoutRequest(this.creative, page.id);
    const inputSnapshot = {
      projectId: snapshot.project.id,
      pageId: page.id,
      pageRevision: String(page.revision),
      workflowHash: snapshot.inputHash,
      requestedPlacement: workRequest?.requestedPlacement ?? "auto",
      workRequestId: workRequest?.id ?? "none",
      selectionSource: "automatic_v1",
      selectedAssetId: "none",
      selectedAssetChecksum: "none",
      typographySettingsHash: snapshot.typographySettingsHash,
      fontManifestHash: LAYOUT_FONT_MANIFEST_HASH,
    };
    return {
      jobType: "page_layout",
      projectId: snapshot.project.id,
      standaloneScopeId: null,
      dependsOn: [],
      priority: projectPriority(snapshot.project.priority),
      intentId: `layout-${page.id}-${hashCanonical(inputSnapshot).slice(0, 16)}`,
      target: null,
      request: { kind: "local", payloadHash: hashCanonical(inputSnapshot) },
      inputSnapshot,
    };
  }

  private enqueueSpecialCompositionJob(
    workflow: PreviewWorkflow,
    page: Page,
    selected: CompositionSourceAsset | null,
    requestedPlacement: ChangeSpecialCompositionSourceInput["requestedPlacement"],
  ): PreviewWorkflow {
    const inputSnapshot = {
      projectId: page.projectId,
      pageId: page.id,
      pageRevision: String(page.revision),
      workflowHash: workflow.inputSnapshotHash,
      requestedPlacement,
      workRequestId: "none",
      selectionSource: "operator",
      selectedAssetId: selected?.assetId ?? "none",
      selectedAssetChecksum: selected?.checksum ?? "none",
      typographySettingsHash: hashCanonical(this.settings.get().typography),
      fontManifestHash: LAYOUT_FONT_MANIFEST_HASH,
    };
    const job = this.requireScheduler().enqueue({
      jobType: "page_layout",
      projectId: page.projectId,
      standaloneScopeId: null,
      dependsOn: [],
      priority: projectPriority(
        this.authoring.projects.get(page.projectId)?.priority ?? 50,
      ),
      intentId: `layout-${page.id}-${hashCanonical(inputSnapshot).slice(0, 16)}`,
      target: null,
      request: { kind: "local", payloadHash: hashCanonical(inputSnapshot) },
      inputSnapshot,
    });
    return this.layout.previewWorkflows.update(workflow.revision, {
      ...workflow,
      revision: workflow.revision + 1,
      updatedAt: this.now(),
      state: "layout_pending",
      layoutJobIds: [job.id],
      previewJobId: null,
      blockingReasons: [],
      currentPreviewOutputId: null,
    });
  }

  private putWorkflow(
    existing: PreviewWorkflow | null,
    snapshot: WorkflowSnapshot,
    readiness: LayoutReadiness,
    jobs: readonly JobRecord[],
  ): PreviewWorkflow {
    const at = this.now();
    const fields = {
      updatedAt: at,
      state: readiness.blockingReasons.length
        ? ("operator_action_required" as const)
        : ("layout_pending" as const),
      inputSnapshotHash: snapshot.inputHash,
      layoutJobIds: jobs.map((job) => job.id),
      previewJobId: null,
      blockingReasons: readiness.blockingReasons,
      currentPreviewOutputId: null,
    };
    if (existing)
      return this.layout.previewWorkflows.update(existing.revision, {
        ...existing,
        ...fields,
        revision: existing.revision + 1,
      });
    return this.layout.previewWorkflows.insert({
      id: snapshot.project.id,
      schemaVersion: 1,
      createdAt: at,
      revision: 0,
      projectId: snapshot.project.id,
      ...fields,
    });
  }

  private ensureCover(snapshot: WorkflowSnapshot): CoverCompositionVersion {
    const currentId = snapshot.project.currentCoverCompositionVersionId;
    const current = currentId
      ? this.layout.coverCompositionVersions.get(currentId)
      : null;
    if (current && coverMatches(current, snapshot, this.assets)) return current;
    const at = this.now();
    const version = this.layout.coverCompositionVersions.insert(
      coverVersion(snapshot, current, at, this.idFactory()),
    );
    const head = this.layout.coverCompositions.get(snapshot.project.id);
    if (head)
      this.layout.coverCompositions.update(head.revision, {
        ...head,
        revision: head.revision + 1,
        updatedAt: at,
        currentVersionId: version.id,
      });
    else
      this.layout.coverCompositions.insert({
        id: snapshot.project.id,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        revision: 0,
        projectId: snapshot.project.id,
        currentVersionId: version.id,
      });
    this.advanceProjectCover(snapshot.project.id, version.id, at);
    return version;
  }

  private advanceProjectCover(
    projectId: string,
    versionId: string,
    at: string,
  ) {
    const project = this.authoring.projects.get(projectId);
    if (!project) failLayout("LAYOUT_SOURCE_NOT_FOUND", 404);
    this.authoring.projects.update({
      ...project,
      revision: project.revision + 1,
      updatedAt: at,
      bookVersion: project.bookVersion + 1,
      currentCoverCompositionVersionId: versionId,
    });
  }

  private advanceCoverHeads(
    project: Project,
    cover: CoverCompositionVersion,
    at: string,
    bumpBookVersion: boolean,
  ): void {
    const head = this.layout.coverCompositions.get(project.id);
    if (!head || head.currentVersionId !== cover.previousVersionId)
      failLayout("LAYOUT_REVISION_CONFLICT");
    this.layout.coverCompositions.update(head.revision, {
      ...head,
      revision: head.revision + 1,
      updatedAt: at,
      currentVersionId: cover.id,
    });
    this.authoring.projects.update({
      ...project,
      revision: project.revision + 1,
      updatedAt: at,
      bookVersion: project.bookVersion + (bumpBookVersion ? 1 : 0),
      currentCoverCompositionVersionId: cover.id,
    });
  }

  private materializePreviewJob(
    workflow: PreviewWorkflow,
    snapshot: WorkflowSnapshot,
    cover: CoverCompositionVersion,
  ): PreviewWorkflow {
    const project = this.authoring.projects.get(snapshot.project.id);
    if (!project) failLayout("LAYOUT_SOURCE_NOT_FOUND", 404);
    const at = this.now();
    const jobId = this.idFactory();
    const nextRevision = workflow.revision + 1;
    const inputSnapshot = {
      projectId: project.id,
      projectRevision: String(project.revision),
      bookVersion: String(project.bookVersion),
      workflowRevision: String(nextRevision),
      workflowHash: workflow.inputSnapshotHash,
      coverVersionId: cover.id,
      watermarkSettingsHash: hashCanonical(this.settings.get().watermarkText),
    };
    const job = this.requireScheduler().enqueue({
      id: jobId,
      jobType: "preview_pdf",
      projectId: project.id,
      standaloneScopeId: null,
      dependsOn: workflow.layoutJobIds,
      priority: projectPriority(project.priority),
      intentId: `preview-${project.id}-${hashCanonical(inputSnapshot).slice(0, 16)}`,
      target: null,
      request: { kind: "local", payloadHash: hashCanonical(inputSnapshot) },
      inputSnapshot,
    });
    return this.layout.previewWorkflows.update(workflow.revision, {
      ...workflow,
      revision: nextRevision,
      updatedAt: at,
      state: "pdf_pending",
      previewJobId: job.id,
      blockingReasons: [],
    });
  }

  private updateWorkflow(
    workflow: PreviewWorkflow,
    changes: Pick<PreviewWorkflow, "state" | "blockingReasons">,
  ): PreviewWorkflow {
    return this.layout.previewWorkflows.update(workflow.revision, {
      ...workflow,
      ...changes,
      revision: workflow.revision + 1,
      updatedAt: this.now(),
    });
  }

  private requireScheduler(): LayoutWorkflowScheduler {
    if (!this.scheduler) failLayout("LAYOUT_WORKFLOW_CONFLICT");
    return this.scheduler;
  }

  private requireCurrentLayout(page: Page): LayoutVersion {
    const head = this.layout.pageLayoutHeads.get(page.id);
    const version = head
      ? this.layout.layoutVersions.get(head.currentLayoutVersionId)
      : null;
    if (!version || version.acceptance !== "ready")
      failLayout("LAYOUT_PREVIEW_STALE");
    return version;
  }

  private previewJobBase(job: Readonly<JobRecord>): {
    project: Project;
    workflow: PreviewWorkflow;
  } {
    if (job.jobType !== "preview_pdf" || !job.projectId)
      failLayout("LAYOUT_PREVIEW_STALE");
    const workflow = this.layout.previewWorkflows.get(job.projectId);
    const project = this.authoring.projects.get(job.projectId);
    if (
      !workflow ||
      !project ||
      workflow.state !== "pdf_pending" ||
      workflow.previewJobId !== job.id ||
      String(workflow.revision) !== job.inputSnapshot.workflowRevision ||
      String(project.revision) !== job.inputSnapshot.projectRevision ||
      String(project.bookVersion) !== job.inputSnapshot.bookVersion ||
      workflow.inputSnapshotHash !== job.inputSnapshot.workflowHash ||
      project.currentCoverCompositionVersionId !==
        job.inputSnapshot.coverVersionId
    )
      failLayout("LAYOUT_PREVIEW_STALE");
    return { project, workflow };
  }
}

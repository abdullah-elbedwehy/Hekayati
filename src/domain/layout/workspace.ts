import type { JobRecord } from "../../jobs/schemas.js";
import type { DocumentStore } from "../repository/document-store.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import type { Project } from "../authoring/schemas.js";
import { CreativeRepositories } from "../creative/repositories.js";
import { failLayout } from "./errors.js";
import {
  eligibleCompositionAssets,
  type CompositionAssetCatalog,
  type CompositionSourceAsset,
} from "./sources.js";
import { LayoutRepositories } from "./repositories.js";
import type {
  BookApprovalCycle,
  CoverCompositionVersion,
  LayoutVersion,
  PreviewOutput,
  PreviewWorkflow,
} from "./schemas.js";

export interface LayoutJobReader {
  get(id: string): JobRecord | null;
}

export interface LayoutPageProjection {
  pageId: string;
  pageNumber: number;
  kind: "title" | "dedication" | "story" | "ending1" | "ending2";
  revision: number;
  locked: boolean;
  staleState: "current" | "stale" | "locked_stale";
  layout: LayoutVersion | null;
}

export interface LayoutProjectProjection {
  project: Project;
  workflow: PreviewWorkflow | null;
  pages: LayoutPageProjection[];
  cover: CoverCompositionVersion | null;
  preview: PreviewOutput | null;
  approval: BookApprovalCycle | null;
  contentApproval: BookApprovalCycle | null;
  approvalGate: JobRecord | null;
  eligibleCompositionAssets: CompositionSourceAsset[];
}

export class LayoutWorkspaceService {
  private readonly authoring: AuthoringRepositories;
  private readonly creative: CreativeRepositories;
  private readonly layout: LayoutRepositories;

  constructor(
    private readonly store: DocumentStore,
    private readonly jobs: LayoutJobReader,
    private readonly assets: CompositionAssetCatalog,
  ) {
    this.authoring = new AuthoringRepositories(store);
    this.creative = new CreativeRepositories(store);
    this.layout = new LayoutRepositories(store);
  }

  project(projectId: string): LayoutProjectProjection {
    const project = this.requireProject(projectId);
    const workflow = this.layout.previewWorkflows.get(project.id);
    const cover = project.currentCoverCompositionVersionId
      ? this.layout.coverCompositionVersions.get(
          project.currentCoverCompositionVersionId,
        )
      : null;
    const preview = project.currentPreviewOutputId
      ? this.layout.previewOutputs.get(project.currentPreviewOutputId)
      : null;
    const approval = project.currentPreviewCycleId
      ? this.layout.bookApprovalCycles.get(project.currentPreviewCycleId)
      : null;
    const contentApproval = project.currentContentApprovalId
      ? this.layout.bookApprovalCycles.get(project.currentContentApprovalId)
      : null;
    const approvalGate = approval
      ? this.jobs.get(approval.approvalGateJobId)
      : null;
    return {
      project,
      workflow,
      pages: this.pages(project.id),
      cover,
      preview,
      approval,
      contentApproval,
      approvalGate,
      eligibleCompositionAssets: eligibleCompositionAssets(
        this.store,
        this.assets,
        project.id,
      ),
    };
  }

  preview(previewOutputId: string): PreviewOutput {
    const output = this.layout.previewOutputs.get(previewOutputId);
    if (!output) failLayout("LAYOUT_ENTITY_NOT_FOUND", 404);
    this.requireProject(output.projectId);
    return output;
  }

  approval(cycleId: string): BookApprovalCycle {
    const cycle = this.layout.bookApprovalCycles.get(cycleId);
    if (!cycle) failLayout("LAYOUT_ENTITY_NOT_FOUND", 404);
    this.requireProject(cycle.projectId);
    return cycle;
  }

  private pages(projectId: string): LayoutPageProjection[] {
    return this.creative.pages
      .queryByField("projectId", projectId)
      .sort((left, right) => left.pageNumber - right.pageNumber)
      .map((page) => {
        const head = this.layout.pageLayoutHeads.get(page.id);
        return {
          pageId: page.id,
          pageNumber: page.pageNumber,
          kind: page.kind,
          revision: page.revision,
          locked: page.locked,
          staleState: page.staleState,
          layout: head
            ? this.layout.layoutVersions.get(head.currentLayoutVersionId)
            : null,
        };
      });
  }

  private requireProject(projectId: string): Project {
    const project = this.authoring.projects.get(projectId);
    if (!project) failLayout("LAYOUT_ENTITY_NOT_FOUND", 404);
    return project;
  }
}

import { CreativeApiClient } from "./creative-api-client";
import type {
  LayoutAffectedItems,
  LayoutApprovalInput,
  LayoutApprovalResult,
  LayoutApprovalScope,
  LayoutPlacement,
  LayoutProjectProjection,
} from "./layout-types";

export abstract class LayoutApiClient extends CreativeApiClient {
  layoutProject(
    familyId: string,
    projectId: string,
  ): Promise<LayoutProjectProjection> {
    return this.request(
      `/api/layout/projects/${encodeURIComponent(projectId)}?familyId=${encodeURIComponent(familyId)}`,
    );
  }

  regenerateLayoutPreview(
    familyId: string,
    projectId: string,
    input: {
      expectedProjectRevision: number;
      expectedWorkflowRevision: number;
    },
  ): Promise<LayoutProjectProjection["workflow"]> {
    return this.json(
      `/api/layout/projects/${encodeURIComponent(projectId)}/preview-regenerate?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      input,
    );
  }

  recalculateLayoutPage(
    familyId: string,
    pageId: string,
    input: {
      expectedRevision: number;
      reason: string;
      requestedPlacement: LayoutPlacement;
    },
  ): Promise<unknown> {
    return this.json(
      `/api/layout/pages/${encodeURIComponent(pageId)}/recalculate?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      input,
    );
  }

  changeSpecialCompositionSource(
    familyId: string,
    pageId: string,
    input: {
      expectedPageRevision: number;
      expectedWorkflowRevision: number;
      assetId: string | null;
      requestedPlacement: LayoutPlacement;
    },
  ): Promise<unknown> {
    return this.json(
      `/api/layout/pages/${encodeURIComponent(pageId)}/composition-source?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      input,
    );
  }

  changeCoverComposition(
    familyId: string,
    projectId: string,
    input: {
      expectedProjectRevision: number;
      expectedWorkflowRevision: number;
      expectedCoverVersionId: string;
      frontArtworkAssetId: string;
      backArtworkAssetId: string | null;
      environmentLine: string | null;
      synopsis: string | null;
    },
  ): Promise<unknown> {
    return this.json(
      `/api/layout/projects/${encodeURIComponent(projectId)}/cover-composition?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      input,
    );
  }

  layoutPreviewPdfUrl(familyId: string, previewOutputId: string): string {
    return `/api/layout/previews/${encodeURIComponent(previewOutputId)}/pdf?familyId=${encodeURIComponent(familyId)}`;
  }

  recordLayoutApprovalAction(
    familyId: string,
    previewOutputId: string,
    action: "sent" | "approve",
    input: LayoutApprovalInput,
  ): Promise<LayoutApprovalResult> {
    return this.json(
      `/api/layout/previews/${encodeURIComponent(previewOutputId)}/${action}?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      input,
    );
  }

  requestLayoutChanges(
    familyId: string,
    previewOutputId: string,
    input: LayoutApprovalInput & {
      notes: string;
      affectedScopes: LayoutApprovalScope[];
    },
  ): Promise<LayoutApprovalResult> {
    return this.json(
      `/api/layout/previews/${encodeURIComponent(previewOutputId)}/changes-requested?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      input,
    );
  }

  approvedLayoutSnapshotStatus(
    familyId: string,
    projectId: string,
  ): Promise<
    | { state: "authorized"; snapshot: { contentAuthorizationHash: string } }
    | { state: "blocked"; code: string }
  > {
    return this.request(
      `/api/layout/projects/${encodeURIComponent(projectId)}/approved-snapshot-status?familyId=${encodeURIComponent(familyId)}`,
    );
  }

  layoutAffectedItems(
    familyId: string,
    eventId: string,
  ): Promise<LayoutAffectedItems> {
    return this.json(
      `/api/creative/invalidation-events/${encodeURIComponent(eventId)}/affected-items?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      {},
    );
  }
}

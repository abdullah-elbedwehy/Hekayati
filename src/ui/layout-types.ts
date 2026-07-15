export type LayoutPlacement = "auto" | "top" | "bottom" | "right" | "left";

export interface LayoutVersionProjection {
  id: string;
  requestedPlacement: LayoutPlacement;
  resolvedPlacement: Exclude<LayoutPlacement, "auto">;
  readabilityAid: "none" | "gradient" | "panel";
  fontSizePt: number;
  warnings: string[];
  acceptance: "ready" | "needs_operator";
  layoutHash: string;
  inputSnapshot: {
    selectionSource: "not_applicable" | "automatic_v1" | "operator";
    sourceAssets: Array<{ role: string; assetId: string; checksum: string }>;
  };
}

export interface LayoutPageProjection {
  pageId: string;
  pageNumber: number;
  kind: "title" | "dedication" | "story" | "ending1" | "ending2";
  revision: number;
  locked: boolean;
  staleState: "current" | "stale" | "locked_stale";
  layout: LayoutVersionProjection | null;
}

export interface LayoutPreviewOutput {
  id: string;
  revision: number;
  assetId: string;
  approvalCycleId: string;
  approvalGateJobId: string;
  bookVersion: number;
  customerContentHash: string;
  approvalBundleHash: string;
  previewSnapshotHash: string;
  status: "ready" | "stale";
  staleReasons: string[];
  invalidatedByEventIds: string[];
  orderedInteriorPages: Array<{
    pageId: string;
    pageNumber: number;
    sourceAssets: Array<{ role: string; assetId: string; checksum: string }>;
  }>;
  validationReport: {
    passed: boolean;
    pageCount: number;
    bytes: number;
    fontNames: string[];
    egressRequestCount: 0;
  };
}

export interface LayoutApprovalCycle {
  id: string;
  revision: number;
  state:
    | "ready_to_send"
    | "preview_sent"
    | "approved"
    | "changes_requested"
    | "invalidated";
  attentionReasons: string[];
  notes: string;
  affectedScopes: LayoutApprovalScope[];
}

export type LayoutApprovalScope =
  | { kind: "page"; pageId: string }
  | { kind: "cover"; side: "front" | "back" | "both" };

export interface LayoutProjectProjection {
  project: {
    id: string;
    revision: number;
    status: string;
    bookVersion: number;
    currentContentApprovalId: string | null;
  };
  workflow: {
    revision: number;
    state:
      | "layout_pending"
      | "operator_action_required"
      | "pdf_pending"
      | "rendering"
      | "validating"
      | "ready"
      | "failed";
    blockingReasons: string[];
    previewJobId: string | null;
  } | null;
  pages: LayoutPageProjection[];
  cover: {
    id: string;
    selectionSource: "automatic_v1" | "operator";
    acceptance: "ready" | "needs_operator";
    warnings: Array<{ code: string; severity: "advisory" | "blocking" }>;
    front: {
      title: string;
      childDisplayName: string;
      environmentLine: string | null;
      artworkAssetId: string | null;
    };
    back: {
      synopsis: string | null;
      brandLine: string;
      artworkAssetId: string | null;
    };
  } | null;
  preview: LayoutPreviewOutput | null;
  approval: LayoutApprovalCycle | null;
  contentApproval: LayoutApprovalCycle | null;
  approvalGate: {
    id: string;
    revision: number;
    state: string;
  } | null;
  eligibleCompositionAssets: Array<{ assetId: string; checksum: string }>;
}

export interface LayoutApprovalInput {
  cycleId: string;
  idempotencyKey: string;
  customerContentHash: string;
  approvalBundleHash: string;
  expectedProjectRevision: number;
  expectedPreviewOutputRevision: number;
  expectedApprovalRevision: number;
  expectedGateRevision: number;
  expectedContentApprovalId: string | null;
  expectedContentApprovalRevision: number | null;
}

export interface LayoutApprovalResult {
  actionId: string;
  replayed: boolean;
  projectRevision: number;
  approvalRevision: number;
  gateRevision: number;
  currentContentApprovalId: string | null;
  projectStatus: string;
  approvalState: LayoutApprovalCycle["state"];
  gateState: "waiting_review" | "succeeded" | "canceled";
}

export interface LayoutAffectedItems {
  event: { id: string; matrixRow: string; occurredAt: string };
  affected: Array<{
    id: string;
    kind: string;
    projectId: string | null;
    effect: string;
    actions: string[];
  }>;
}

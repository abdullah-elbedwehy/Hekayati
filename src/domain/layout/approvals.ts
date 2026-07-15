import { ulid } from "ulid";

import type { JobRecord } from "../../jobs/schemas.js";
import type { DocumentStore } from "../repository/document-store.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import type { Project } from "../authoring/schemas.js";
import { createContentAuthorizationHash, hashCanonical } from "./hashes.js";
import { LayoutRepositories } from "./repositories.js";
import type {
  BookApprovalAction,
  BookApprovalCycle,
  BookApprovalScope,
  CoverCompositionVersion,
  PreviewOutput,
} from "./schemas.js";

export type ApprovalActionKind =
  "preview_sent" | "approved" | "changes_requested";

export interface ApprovalOwnerScope {
  customerId: string;
  familyId: string;
}

export interface ApprovalGateController {
  get(id: string): JobRecord | null;
  completeHumanGate(
    id: string,
    input: { expectedRevision: number; targetVersionId: string },
    ownerVerify: (job: JobRecord) => boolean,
  ): JobRecord;
  cancelOwnedHumanGate(
    id: string,
    input: {
      expectedRevision: number;
      targetVersionId: string;
      reason: string;
    },
    ownerVerify: (job: JobRecord) => boolean,
  ): JobRecord;
}

export interface BookApprovalActionInput {
  owner: ApprovalOwnerScope;
  projectId: string;
  previewOutputId: string;
  cycleId: string;
  action: ApprovalActionKind;
  idempotencyKey: string;
  customerContentHash: string;
  approvalBundleHash: string;
  expectedProjectRevision: number;
  expectedPreviewOutputRevision: number;
  expectedApprovalRevision: number;
  expectedGateRevision: number;
  expectedContentApprovalId: string | null;
  expectedContentApprovalRevision: number | null;
  notes?: string;
  affectedScopes?: readonly BookApprovalScope[];
}

export interface BookApprovalActionResult {
  actionId: string;
  replayed: boolean;
  projectRevision: number;
  previewOutputRevision: number;
  approvalRevision: number;
  gateRevision: number;
  currentContentApprovalId: string | null;
  projectStatus: BookApprovalAction["result"]["projectStatus"];
  approvalState: BookApprovalCycle["state"];
  gateState: "waiting_review" | "succeeded" | "canceled";
}

export interface BookApprovalServiceOptions {
  now?: () => string;
  idFactory?: () => string;
}

interface ApprovalActionContext {
  project: Project;
  output: PreviewOutput;
  cycle: BookApprovalCycle;
  gate: JobRecord;
  priorCycle: BookApprovalCycle | null;
}

interface ApprovalTransition {
  project: Project;
  cycle: BookApprovalCycle;
  gate: JobRecord;
}

export class BookApprovalService {
  private readonly authoring: AuthoringRepositories;
  private readonly layout: LayoutRepositories;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: DocumentStore,
    private readonly gates: ApprovalGateController,
    options: BookApprovalServiceOptions = {},
  ) {
    this.authoring = new AuthoringRepositories(store);
    this.layout = new LayoutRepositories(store);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
  }

  act(input: BookApprovalActionInput): BookApprovalActionResult {
    const normalized = normalizeApprovalRequest(input);
    const requestHash = hashCanonical(normalized);
    return this.store.transaction(() =>
      this.actInTransaction(input, normalized, requestHash),
    );
  }

  private actInTransaction(
    input: BookApprovalActionInput,
    normalized: ReturnType<typeof normalizeApprovalRequest>,
    requestHash: string,
  ): BookApprovalActionResult {
    const replay = this.findReplay(input.cycleId, normalized.idempotencyKey);
    if (replay) return this.replayResult(replay, requestHash);
    const context = this.loadActionContext(input);
    assertTransition(input.action, context.cycle.state);
    assertScopes(
      input.action,
      normalized.notes,
      normalized.affectedScopes,
      context.output,
    );
    const at = this.now();
    const transition = this.applyTransition(
      input.action,
      context,
      normalized,
      at,
    );
    const action = this.recordAction(
      input,
      normalized,
      requestHash,
      context,
      transition,
      at,
    );
    return actionResult(action, false);
  }

  private replayResult(
    replay: BookApprovalAction,
    requestHash: string,
  ): BookApprovalActionResult {
    if (replay.canonicalRequestHash !== requestHash)
      failApproval("APPROVAL_IDEMPOTENCY_COLLISION");
    return actionResult(replay, true);
  }

  private loadActionContext(
    input: BookApprovalActionInput,
  ): ApprovalActionContext {
    const project = this.authoring.projects.get(input.projectId);
    if (!project) failApproval("APPROVAL_PROJECT_NOT_FOUND", 404);
    if (
      project.customerId !== input.owner.customerId ||
      project.familyId !== input.owner.familyId
    )
      failApproval("APPROVAL_SCOPE_REJECTED", 404);
    const output = this.layout.previewOutputs.get(input.previewOutputId);
    const cycle = this.layout.bookApprovalCycles.get(input.cycleId);
    if (!output || !cycle) failApproval("APPROVAL_TARGET_NOT_FOUND", 404);
    const gate = this.gates.get(cycle.approvalGateJobId);
    if (!gate) failApproval("APPROVAL_GATE_NOT_FOUND", 404);
    const priorCycle = input.expectedContentApprovalId
      ? this.layout.bookApprovalCycles.get(input.expectedContentApprovalId)
      : null;
    assertCurrent(input, project, output, cycle, gate, priorCycle);
    return { project, output, cycle, gate, priorCycle };
  }

  private applyTransition(
    action: ApprovalActionKind,
    context: ApprovalActionContext,
    normalized: ReturnType<typeof normalizeApprovalRequest>,
    at: string,
  ): ApprovalTransition {
    if (action === "preview_sent") return this.markPreviewSent(context, at);
    if (action === "approved") return this.markApproved(context, at);
    return this.markChangesRequested(context, normalized, at);
  }

  private markPreviewSent(
    context: ApprovalActionContext,
    at: string,
  ): ApprovalTransition {
    const cycle = updateCycle(this.layout, context.cycle, at, {
      state: "preview_sent",
      recordedAt: at,
    });
    const project = this.authoring.projects.update({
      ...context.project,
      revision: context.project.revision + 1,
      updatedAt: at,
      status: context.project.currentContentApprovalId
        ? context.project.status
        : "awaiting_customer_approval",
    });
    return { project, cycle, gate: context.gate };
  }

  private markApproved(
    context: ApprovalActionContext,
    at: string,
  ): ApprovalTransition {
    const gate = this.gates.completeHumanGate(
      context.gate.id,
      {
        expectedRevision: context.gate.revision,
        targetVersionId: context.output.id,
      },
      (candidate) => ownsGate(candidate, context.project.id, context.output.id),
    );
    const cycle = updateCycle(this.layout, context.cycle, at, {
      state: "approved",
      recordedAt: at,
    });
    const project = this.authoring.projects.update({
      ...context.project,
      revision: context.project.revision + 1,
      updatedAt: at,
      status: "approved",
      currentContentApprovalId: context.cycle.id,
    });
    return { project, cycle, gate };
  }

  private markChangesRequested(
    context: ApprovalActionContext,
    normalized: ReturnType<typeof normalizeApprovalRequest>,
    at: string,
  ): ApprovalTransition {
    const gate = this.gates.cancelOwnedHumanGate(
      context.gate.id,
      {
        expectedRevision: context.gate.revision,
        targetVersionId: context.output.id,
        reason: "changes_requested",
      },
      (candidate) => ownsGate(candidate, context.project.id, context.output.id),
    );
    const cycle = updateCycle(this.layout, context.cycle, at, {
      state: "changes_requested",
      notes: normalized.notes,
      affectedScopes: normalized.affectedScopes,
      recordedAt: at,
    });
    this.invalidatePriorSameContent(context, at);
    const project = this.authoring.projects.update({
      ...context.project,
      revision: context.project.revision + 1,
      updatedAt: at,
      status: "revising",
      currentContentApprovalId: null,
    });
    return { project, cycle, gate };
  }

  private invalidatePriorSameContent(
    context: ApprovalActionContext,
    at: string,
  ): void {
    const prior = context.priorCycle;
    if (
      !prior ||
      prior.id === context.cycle.id ||
      prior.customerContentHash !== context.cycle.customerContentHash ||
      prior.state !== "approved"
    )
      return;
    updateCycle(this.layout, prior, at, {
      state: "invalidated",
      invalidatedBy: {
        eventId: this.idFactory(),
        matrixRow: "IM-11",
        at,
      },
    });
  }

  private recordAction(
    input: BookApprovalActionInput,
    normalized: ReturnType<typeof normalizeApprovalRequest>,
    requestHash: string,
    context: ApprovalActionContext,
    transition: ApprovalTransition,
    at: string,
  ): BookApprovalAction {
    const result = transitionResult(context.output, transition);
    return this.layout.bookApprovalActions.insert({
      id: this.idFactory(),
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      cycleId: context.cycle.id,
      idempotencyKey: normalized.idempotencyKey,
      canonicalRequestHash: requestHash,
      action: input.action,
      projectRevision: input.expectedProjectRevision,
      previewOutputRevision: input.expectedPreviewOutputRevision,
      approvalRevision: input.expectedApprovalRevision,
      gateRevision: input.expectedGateRevision,
      expectedContentApprovalId: input.expectedContentApprovalId,
      expectedContentApprovalRevision: input.expectedContentApprovalRevision,
      previewOutputId: context.output.id,
      approvalGateJobId: context.gate.id,
      customerContentHash: input.customerContentHash,
      approvalBundleHash: input.approvalBundleHash,
      normalizedNotes: normalized.notes,
      affectedScopes: normalized.affectedScopes,
      result,
      recordedAt: at,
    });
  }

  private findReplay(cycleId: string, key: string): BookApprovalAction | null {
    return (
      this.layout.bookApprovalActions
        .queryByField("idempotencyKey", key)
        .find((action) => action.cycleId === cycleId) ?? null
    );
  }
}

export interface SnapshotIntegrityPort {
  verifyIntegrity(assetId: string): Promise<{
    status: "healthy" | "missing" | "corrupt";
    expectedSha256: string;
  }>;
}

export interface CurrentCustomerContentPort {
  resolveCustomerContentHash(projectId: string): string;
}

export class CurrentPreviewCustomerContentReader implements CurrentCustomerContentPort {
  private readonly authoring: AuthoringRepositories;
  private readonly layout: LayoutRepositories;

  constructor(store: DocumentStore) {
    this.authoring = new AuthoringRepositories(store);
    this.layout = new LayoutRepositories(store);
  }

  resolveCustomerContentHash(projectId: string): string {
    const project = this.authoring.projects.get(projectId);
    const output = project?.currentPreviewOutputId
      ? this.layout.previewOutputs.get(project.currentPreviewOutputId)
      : null;
    if (!output) failApproval("APPROVED_SNAPSHOT_STALE");
    return output.customerContentHash;
  }
}

export interface ApprovedBookSnapshot {
  projectId: string;
  projectVersionId: string;
  compositionProfileId: string;
  coverCompositionVersionId: string;
  approvalCycleId: string;
  previewOutputId: string;
  approvalGateJobId: string;
  customerContentHash: string;
  contentAuthorizationHash: string;
  orderedInteriorPages: PreviewOutput["orderedInteriorPages"];
  coverSourceAssets: Array<{ role: string; assetId: string; checksum: string }>;
  observations: {
    projectRevision: number;
    bookVersion: number;
    previewOutputRevision: number;
    approvalRevision: number;
    pageObservationRevisions: Array<{ pageId: string; revision: number }>;
  };
}

interface ApprovedSnapshotContext {
  project: Project;
  cycle: BookApprovalCycle;
  output: PreviewOutput;
  gate: JobRecord;
  cover: CoverCompositionVersion;
  assets: Array<{ role: string; assetId: string; checksum: string }>;
}

export class ApprovedBookSnapshotReader {
  private readonly authoring: AuthoringRepositories;
  private readonly layout: LayoutRepositories;

  constructor(
    store: DocumentStore,
    private readonly gates: Pick<ApprovalGateController, "get">,
    private readonly integrity: SnapshotIntegrityPort,
    private readonly content: CurrentCustomerContentPort,
  ) {
    this.authoring = new AuthoringRepositories(store);
    this.layout = new LayoutRepositories(store);
  }

  async read(projectId: string): Promise<ApprovedBookSnapshot> {
    const context = this.loadSnapshotContext(projectId);
    await this.verifyAssets(context.assets);
    return approvedSnapshot(context);
  }

  private loadSnapshotContext(projectId: string): ApprovedSnapshotContext {
    const project = this.authoring.projects.get(projectId);
    if (!project?.currentContentApprovalId)
      failApproval("APPROVED_SNAPSHOT_NOT_AUTHORIZED");
    const cycle = this.layout.bookApprovalCycles.get(
      project.currentContentApprovalId,
    );
    if (!cycle || cycle.state !== "approved")
      failApproval("APPROVED_SNAPSHOT_NOT_AUTHORIZED");
    const output = this.layout.previewOutputs.get(cycle.previewOutputId);
    const gate = this.gates.get(cycle.approvalGateJobId);
    const cover = output
      ? this.layout.coverCompositionVersions.get(
          output.coverCompositionVersionId,
        )
      : null;
    if (
      !output ||
      !cover ||
      !gate ||
      gate.state !== "succeeded" ||
      gate.request.kind !== "human_gate" ||
      gate.request.gateKind !== "customer_approval" ||
      gate.request.targetVersionId !== output.id ||
      cycle.customerContentHash !== output.customerContentHash ||
      this.content.resolveCustomerContentHash(project.id) !==
        cycle.customerContentHash
    )
      failApproval("APPROVED_SNAPSHOT_STALE");
    const assets = uniqueAssets([
      ...output.orderedInteriorPages.flatMap((page) => page.sourceAssets),
      ...cover.sourceAssets,
    ]);
    return { project, cycle, output, gate, cover, assets };
  }

  private async verifyAssets(
    assets: readonly { assetId: string; checksum: string }[],
  ): Promise<void> {
    for (const asset of assets) {
      const result = await this.integrity.verifyIntegrity(asset.assetId);
      if (
        result.status !== "healthy" ||
        result.expectedSha256 !== asset.checksum
      )
        failApproval("APPROVED_SNAPSHOT_INTEGRITY_FAILED");
    }
  }
}

type CycleChanges = Partial<
  Pick<
    BookApprovalCycle,
    | "state"
    | "recordedAt"
    | "notes"
    | "affectedScopes"
    | "invalidatedBy"
    | "attentionReasons"
  >
>;

function updateCycle(
  layout: LayoutRepositories,
  cycle: BookApprovalCycle,
  at: string,
  changes: CycleChanges,
): BookApprovalCycle {
  return layout.bookApprovalCycles.update(cycle.revision, {
    ...cycle,
    ...changes,
    revision: cycle.revision + 1,
    updatedAt: at,
  });
}

function transitionResult(
  output: PreviewOutput,
  transition: ApprovalTransition,
): BookApprovalAction["result"] {
  return {
    projectRevision: transition.project.revision,
    previewOutputRevision: output.revision,
    approvalRevision: transition.cycle.revision,
    gateRevision: transition.gate.revision,
    currentContentApprovalId: transition.project.currentContentApprovalId,
    projectStatus: transition.project.status,
    approvalState: transition.cycle.state,
    gateState: gateState(transition.gate),
  };
}

function approvedSnapshot(
  context: ApprovedSnapshotContext,
): ApprovedBookSnapshot {
  const reviewEvidenceHash = hashCanonical(
    context.output.orderedInteriorPages.map((page) => ({
      pageId: page.pageId,
      pageReviewId: page.pageReviewId,
      reviewHash: page.reviewHash,
    })),
  );
  return {
    projectId: context.project.id,
    projectVersionId: context.output.projectVersionId,
    compositionProfileId: context.output.compositionProfileId,
    coverCompositionVersionId: context.output.coverCompositionVersionId,
    approvalCycleId: context.cycle.id,
    previewOutputId: context.output.id,
    approvalGateJobId: context.gate.id,
    customerContentHash: context.cycle.customerContentHash,
    contentAuthorizationHash: createContentAuthorizationHash({
      customerContentHash: context.cycle.customerContentHash,
      previewOutputId: context.output.id,
      approvalCycleId: context.cycle.id,
      approvalGateJobId: context.gate.id,
      approvedOutcome: "approved",
      reviewEvidenceHash,
    }),
    orderedInteriorPages: context.output.orderedInteriorPages,
    coverSourceAssets: context.cover.sourceAssets,
    observations: snapshotObservations(context),
  };
}

function snapshotObservations(context: ApprovedSnapshotContext) {
  return {
    projectRevision: context.project.revision,
    bookVersion: context.project.bookVersion,
    previewOutputRevision: context.output.revision,
    approvalRevision: context.cycle.revision,
    pageObservationRevisions: context.output.orderedInteriorPages.map(
      (page) => ({
        pageId: page.pageId,
        revision: page.pageObservationRevision,
      }),
    ),
  };
}

function normalizeApprovalRequest(input: BookApprovalActionInput) {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 160)
    failApproval("APPROVAL_IDEMPOTENCY_KEY_INVALID");
  return {
    owner: input.owner,
    projectId: input.projectId,
    previewOutputId: input.previewOutputId,
    cycleId: input.cycleId,
    action: input.action,
    idempotencyKey,
    customerContentHash: input.customerContentHash,
    approvalBundleHash: input.approvalBundleHash,
    expectedProjectRevision: input.expectedProjectRevision,
    expectedPreviewOutputRevision: input.expectedPreviewOutputRevision,
    expectedApprovalRevision: input.expectedApprovalRevision,
    expectedGateRevision: input.expectedGateRevision,
    expectedContentApprovalId: input.expectedContentApprovalId,
    expectedContentApprovalRevision: input.expectedContentApprovalRevision,
    notes: normalizeNotes(input.notes ?? ""),
    affectedScopes: normalizeScopes(input.affectedScopes ?? []),
  };
}

function normalizeNotes(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function normalizeScopes(
  scopes: readonly BookApprovalScope[],
): BookApprovalScope[] {
  const keyed = scopes.map((scope) => ({
    key: scope.kind === "page" ? `page:${scope.pageId}` : `cover:${scope.side}`,
    scope,
  }));
  if (new Set(keyed.map(({ key }) => key)).size !== keyed.length)
    failApproval("APPROVAL_SCOPE_DUPLICATE");
  return keyed
    .sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    )
    .map(({ scope }) => scope);
}

function assertCurrent(
  input: BookApprovalActionInput,
  project: Project,
  output: PreviewOutput,
  cycle: BookApprovalCycle,
  gate: JobRecord,
  priorCycle: BookApprovalCycle | null,
): void {
  if (
    project.revision !== input.expectedProjectRevision ||
    output.revision !== input.expectedPreviewOutputRevision ||
    cycle.revision !== input.expectedApprovalRevision ||
    gate.revision !== input.expectedGateRevision
  )
    failApproval("APPROVAL_REVISION_CONFLICT");
  if (!approvalTargetIsCurrent(input, project, output, cycle, gate))
    failApproval("APPROVAL_STALE_TARGET");
  if (
    (input.expectedContentApprovalId === null) !==
    (input.expectedContentApprovalRevision === null)
  )
    failApproval("APPROVAL_CONTENT_EXPECTATION_INVALID");
  if (
    input.expectedContentApprovalId &&
    (!priorCycle ||
      priorCycle.id !== input.expectedContentApprovalId ||
      priorCycle.revision !== input.expectedContentApprovalRevision)
  )
    failApproval("APPROVAL_REVISION_CONFLICT");
}

function approvalTargetIsCurrent(
  input: BookApprovalActionInput,
  project: Project,
  output: PreviewOutput,
  cycle: BookApprovalCycle,
  gate: JobRecord,
): boolean {
  return !(
    project.currentPreviewOutputId !== output.id ||
    project.currentPreviewCycleId !== cycle.id ||
    project.currentCoverCompositionVersionId !==
      output.coverCompositionVersionId ||
    output.projectId !== project.id ||
    cycle.projectId !== project.id ||
    cycle.previewOutputId !== output.id ||
    cycle.approvalGateJobId !== gate.id ||
    output.approvalGateJobId !== gate.id ||
    output.approvalCycleId !== cycle.id ||
    output.bookVersion !== cycle.targetBookVersion ||
    output.pageMapHash !== cycle.pageMapHash ||
    output.previewSnapshotHash !== cycle.previewSnapshotHash ||
    output.coverCompositionVersionId !== cycle.coverCompositionVersionId ||
    output.watermarkSettingsHash !== cycle.watermarkSettingsHash ||
    output.status !== "ready" ||
    output.customerContentHash !== input.customerContentHash ||
    cycle.customerContentHash !== input.customerContentHash ||
    output.approvalBundleHash !== input.approvalBundleHash ||
    cycle.approvalBundleHash !== input.approvalBundleHash ||
    project.currentContentApprovalId !== input.expectedContentApprovalId ||
    gate.state !== "waiting_review" ||
    !ownsGate(gate, project.id, output.id)
  );
}

function assertTransition(
  action: ApprovalActionKind,
  state: BookApprovalCycle["state"],
): void {
  if (action === "preview_sent" && state !== "ready_to_send")
    failApproval("APPROVAL_TRANSITION_INVALID");
  if (action !== "preview_sent" && state !== "preview_sent")
    failApproval("APPROVAL_TRANSITION_INVALID");
}

function assertScopes(
  action: ApprovalActionKind,
  notes: string,
  scopes: readonly BookApprovalScope[],
  output: PreviewOutput,
): void {
  if (action !== "changes_requested") {
    if (notes || scopes.length)
      failApproval("APPROVAL_UNEXPECTED_CHANGE_DETAIL");
    return;
  }
  if (!notes) failApproval("APPROVAL_CHANGE_NOTES_REQUIRED");
  if (!scopes.length) failApproval("APPROVAL_SCOPE_REQUIRED");
  const pageIds = new Set(
    output.orderedInteriorPages.map((page) => page.pageId),
  );
  if (
    scopes.some((scope) => scope.kind === "page" && !pageIds.has(scope.pageId))
  )
    failApproval("APPROVAL_SCOPE_REJECTED");
}

function ownsGate(
  job: JobRecord,
  projectId: string,
  previewOutputId: string,
): boolean {
  return (
    job.projectId === projectId &&
    job.request.kind === "human_gate" &&
    job.request.gateKind === "customer_approval" &&
    job.request.targetVersionId === previewOutputId
  );
}

function gateState(
  job: JobRecord,
): "waiting_review" | "succeeded" | "canceled" {
  if (
    job.state !== "waiting_review" &&
    job.state !== "succeeded" &&
    job.state !== "canceled"
  )
    failApproval("APPROVAL_GATE_STATE_INVALID");
  return job.state;
}

function actionResult(
  action: BookApprovalAction,
  replayed: boolean,
): BookApprovalActionResult {
  return { actionId: action.id, replayed, ...action.result };
}

function uniqueAssets<T extends { assetId: string }>(
  assets: readonly T[],
): T[] {
  return [...new Map(assets.map((asset) => [asset.assetId, asset])).values()];
}

export type ApprovalErrorCode =
  | "APPROVAL_IDEMPOTENCY_KEY_INVALID"
  | "APPROVAL_IDEMPOTENCY_COLLISION"
  | "APPROVAL_PROJECT_NOT_FOUND"
  | "APPROVAL_SCOPE_REJECTED"
  | "APPROVAL_TARGET_NOT_FOUND"
  | "APPROVAL_GATE_NOT_FOUND"
  | "APPROVAL_REVISION_CONFLICT"
  | "APPROVAL_STALE_TARGET"
  | "APPROVAL_CONTENT_EXPECTATION_INVALID"
  | "APPROVAL_TRANSITION_INVALID"
  | "APPROVAL_UNEXPECTED_CHANGE_DETAIL"
  | "APPROVAL_CHANGE_NOTES_REQUIRED"
  | "APPROVAL_SCOPE_REQUIRED"
  | "APPROVAL_SCOPE_DUPLICATE"
  | "APPROVAL_GATE_STATE_INVALID"
  | "APPROVED_SNAPSHOT_NOT_AUTHORIZED"
  | "APPROVED_SNAPSHOT_STALE"
  | "APPROVED_SNAPSHOT_INTEGRITY_FAILED";

export class ApprovalError extends Error {
  readonly name = "ApprovalError";
  constructor(
    readonly code: ApprovalErrorCode,
    readonly statusCode = 409,
  ) {
    super(code);
  }
}

function failApproval(code: ApprovalErrorCode, statusCode?: number): never {
  throw new ApprovalError(code, statusCode);
}

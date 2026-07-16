import { AuthoringRepositories } from "../authoring/repositories.js";
import { LayoutRepositories } from "../layout/repositories.js";
import type { BookApprovalCycle, PreviewOutput } from "../layout/schemas.js";
import type { ChangeEvent } from "../library/schemas.js";
import type { DocumentStore } from "../repository/document-store.js";
import { failCreative } from "./errors.js";
import type { InvalidationConsequence } from "./invalidation-rules.js";
import { CreativeRepositories } from "./repositories.js";
import type { CharacterApproval, CharacterSheet, Page } from "./schemas.js";
import {
  unique,
  type InvalidationGateController,
  type ResolvedArtifact,
} from "./invalidation-support.js";

export class InvalidationMutationService {
  private readonly creative: CreativeRepositories;
  private readonly authoring: AuthoringRepositories;
  private readonly layout: LayoutRepositories;
  private gates: InvalidationGateController | null = null;

  constructor(
    store: DocumentStore,
    private readonly now: () => string,
  ) {
    this.creative = new CreativeRepositories(store);
    this.authoring = new AuthoringRepositories(store);
    this.layout = new LayoutRepositories(store);
  }

  bindGateController(gates: InvalidationGateController): void {
    if (this.gates && this.gates !== gates)
      failCreative("CREATIVE_INVALIDATION_CONFLICT");
    this.gates = gates;
  }

  apply(
    event: ChangeEvent,
    artifacts: ResolvedArtifact[],
    consequences: readonly InvalidationConsequence[],
  ): void {
    const byId = new Map(
      artifacts.map((artifact) => [
        `${artifact.kind}:${artifact.id}`,
        artifact,
      ]),
    );
    for (const consequence of consequences) {
      const artifact = byId.get(
        `${consequence.kind}:${consequence.artifactId}`,
      );
      if (artifact) this.applyOne(event, artifact, consequence);
    }
  }

  bumpBookVersion(projectId: string, at: string): void {
    const project = this.authoring.projects.get(projectId);
    if (!project) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    this.authoring.projects.update({
      ...project,
      bookVersion: project.bookVersion + 1,
      revision: project.revision + 1,
      updatedAt: at,
    });
  }

  private applyOne(
    event: ChangeEvent,
    artifact: ResolvedArtifact,
    consequence: InvalidationConsequence,
  ): void {
    if (artifact.kind === "character_sheet")
      this.updateSheet(artifact.record as CharacterSheet, consequence.effect);
    else if (artifact.kind === "character_approval")
      this.supersedeApproval(artifact.record as CharacterApproval, event.id);
    else if (
      artifact.kind === "page_illustration" ||
      artifact.kind === "page_layout"
    )
      this.applyPage(event, artifact.record as Page, consequence.effect);
    else if (artifact.kind === "preview_pdf")
      this.stalePreview(artifact.record as PreviewOutput, event);
    else if (artifact.kind === "book_approval")
      this.updateBookApproval(
        artifact.record as BookApprovalCycle,
        event,
        consequence.effect,
      );
  }

  private applyPage(
    event: ChangeEvent,
    page: Page,
    effect: InvalidationConsequence["effect"],
  ): void {
    if (effect === "recheck") this.flagPageForReview(page.id);
    else this.markPageStale(page.id, event.matrixRow);
  }

  private stalePreview(output: PreviewOutput, event: ChangeEvent): void {
    if (!output.staleReasons.includes(event.matrixRow))
      this.layout.previewOutputs.update(output.revision, {
        ...output,
        revision: output.revision + 1,
        updatedAt: this.now(),
        status: "stale",
        staleReasons: unique([...output.staleReasons, event.matrixRow]),
        invalidatedByEventIds: unique([
          ...output.invalidatedByEventIds,
          event.id,
        ]),
      });
    const cycle = this.layout.bookApprovalCycles.get(output.approvalCycleId);
    if (cycle && cycle.state !== "approved")
      this.cancelWaitingApprovalGate(cycle, output);
  }

  private cancelWaitingApprovalGate(
    cycle: BookApprovalCycle,
    output: PreviewOutput,
  ): void {
    if (!this.gates) failCreative("CREATIVE_INVALIDATION_CONFLICT");
    const gate = this.gates.get(cycle.approvalGateJobId);
    if (!gate) failCreative("CREATIVE_INVALIDATION_CONFLICT");
    if (gate.state === "canceled" || gate.state !== "waiting_review") return;
    this.gates.cancelOwnedHumanGate(
      gate.id,
      {
        expectedRevision: gate.revision,
        targetVersionId: output.id,
        reason: "preview_invalidated",
      },
      (candidate) =>
        candidate.projectId === output.projectId &&
        candidate.request.kind === "human_gate" &&
        candidate.request.gateKind === "customer_approval" &&
        candidate.request.targetVersionId === output.id,
    );
  }

  private updateBookApproval(
    cycle: BookApprovalCycle,
    event: ChangeEvent,
    effect: InvalidationConsequence["effect"],
  ): void {
    if (effect === "recheck") {
      if (cycle.attentionReasons.includes(event.matrixRow)) return;
      this.layout.bookApprovalCycles.update(cycle.revision, {
        ...cycle,
        revision: cycle.revision + 1,
        updatedAt: this.now(),
        attentionReasons: unique([...cycle.attentionReasons, event.matrixRow]),
      });
      return;
    }
    if (cycle.state === "invalidated") return;
    const at = this.now();
    this.layout.bookApprovalCycles.update(cycle.revision, {
      ...cycle,
      revision: cycle.revision + 1,
      updatedAt: at,
      state: "invalidated",
      invalidatedBy: { eventId: event.id, matrixRow: event.matrixRow, at },
    });
    this.clearContentAuthorization(cycle, at);
  }

  private clearContentAuthorization(
    cycle: BookApprovalCycle,
    at: string,
  ): void {
    const project = this.authoring.projects.get(cycle.projectId);
    if (!project || project.currentContentApprovalId !== cycle.id) return;
    this.authoring.projects.update({
      ...project,
      revision: project.revision + 1,
      updatedAt: at,
      status: "revising",
      currentContentApprovalId: null,
    });
  }

  private flagPageForReview(pageId: string): void {
    const page = this.creative.pages.get(pageId);
    if (!page || page.reviewStatus === "flagged") return;
    this.creative.pages.update({
      ...page,
      reviewStatus: "flagged",
      revision: page.revision + 1,
      updatedAt: this.now(),
    });
  }

  private markPageStale(pageId: string, row: ChangeEvent["matrixRow"]): void {
    const page = this.creative.pages.get(pageId);
    if (!page || page.staleReasons.includes(row)) return;
    this.creative.pages.update({
      ...page,
      staleState: page.locked ? "locked_stale" : "stale",
      staleReasons: [...page.staleReasons, row],
      reviewStatus:
        page.reviewStatus === "approved" ? "flagged" : page.reviewStatus,
      revision: page.revision + 1,
      updatedAt: this.now(),
    });
  }

  private updateSheet(
    sheet: CharacterSheet,
    effect: InvalidationConsequence["effect"],
  ): void {
    const status =
      effect === "recheck"
        ? "revision_needed"
        : sheet.status === "approved"
          ? "approved_superseded"
          : "revision_needed";
    if (sheet.status === status) return;
    this.creative.sheets.update({
      ...sheet,
      status,
      revision: sheet.revision + 1,
      updatedAt: this.now(),
    });
  }

  private supersedeApproval(
    approval: CharacterApproval,
    eventId: string,
  ): void {
    this.creative.approvals.update({
      ...approval,
      state: "superseded",
      invalidatedByEventId: eventId,
      revision: approval.revision + 1,
      updatedAt: this.now(),
    });
  }
}

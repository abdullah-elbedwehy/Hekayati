import { createHash } from "node:crypto";

import { ulid } from "ulid";

import { AuthoringRepositories } from "../authoring/repositories.js";
import { LibraryRepositories } from "../library/repositories.js";
import {
  changeEventSchema,
  invalidationReceiptSchema,
  type ChangeEvent,
} from "../library/schemas.js";
import type { FamilyScope } from "../library/types.js";
import type { DocumentStore } from "../repository/document-store.js";
import { canonicalJson } from "../../contracts/canonical-json.js";
import { failCreative } from "./errors.js";
import {
  evaluateInvalidation,
  type InvalidationArtifact,
  type InvalidationConsequence,
} from "./invalidation-rules.js";
import { CreativeRepositories } from "./repositories.js";
import {
  invalidationAuditSchema,
  type CharacterApproval,
  type CharacterSheet,
  type InvalidationAudit,
  type Page,
} from "./schemas.js";

export interface CreativeInvalidationOptions {
  now?: () => string;
  idFactory?: () => string;
}

export type AppendChangeEventInput = Omit<
  ChangeEvent,
  "schemaVersion" | "createdAt" | "updatedAt" | "occurredAt"
> & { occurredAt?: string };

interface ResolvedArtifact extends InvalidationArtifact {
  projectId: string | null;
  record: CharacterSheet | CharacterApproval | Page;
}

export class CreativeInvalidationService {
  private readonly creative: CreativeRepositories;
  private readonly library: LibraryRepositories;
  private readonly authoring: AuthoringRepositories;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: DocumentStore,
    options: CreativeInvalidationOptions = {},
  ) {
    this.creative = new CreativeRepositories(store);
    this.library = new LibraryRepositories(store);
    this.authoring = new AuthoringRepositories(store);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
  }

  appendEvent(input: AppendChangeEventInput): ChangeEvent {
    const at = input.occurredAt ?? this.now();
    return this.library.changeEvents.insert(
      changeEventSchema.parse({
        ...input,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        occurredAt: at,
      }),
      "DUPLICATE_ENTITY_ID",
    );
  }

  recordAndConsume(input: AppendChangeEventInput): {
    event: ChangeEvent;
    audit: InvalidationAudit;
  } {
    return this.store.transaction(() => {
      const event = this.appendEvent(input);
      const resolved = this.resolveEvent(event.id);
      return {
        event,
        audit: this.consumeResolved(
          resolved.event,
          resolved.artifacts,
          resolved.evaluation,
        ),
      };
    });
  }

  consume(eventId: string): InvalidationAudit {
    return this.store.transaction(() => {
      const resolved = this.resolveEvent(eventId);
      return this.consumeResolved(
        resolved.event,
        resolved.artifacts,
        resolved.evaluation,
      );
    });
  }

  affectedItems(eventId: string): {
    event: ChangeEvent;
    audit: InvalidationAudit;
    actions: Array<{
      id: string;
      effect: InvalidationConsequence["effect"];
      actions: InvalidationConsequence["actions"];
    }>;
  } {
    return this.store.transaction(() => {
      const resolved = this.resolveEvent(eventId);
      return {
        event: resolved.event,
        audit: this.consumeResolved(
          resolved.event,
          resolved.artifacts,
          resolved.evaluation,
        ),
        actions: resolved.evaluation.consequences.map((item) => ({
          id: item.artifactId,
          effect: item.effect,
          actions: item.actions,
        })),
      };
    });
  }

  affectedItemsForFamily(scope: FamilyScope, eventId: string) {
    return this.store.transaction(() => {
      const resolved = this.resolveEvent(eventId);
      this.assertEventScope(scope, resolved.event, resolved.artifacts);
      const audit = this.consumeResolved(
        resolved.event,
        resolved.artifacts,
        resolved.evaluation,
      );
      const byId = new Map(
        resolved.artifacts.map((artifact) => [artifact.id, artifact]),
      );
      return {
        event: {
          id: resolved.event.id,
          matrixRow: resolved.event.matrixRow,
          occurredAt: resolved.event.occurredAt,
        },
        audit: {
          id: audit.id,
          eventId: audit.eventId,
          consequenceHash: audit.consequenceHash,
        },
        affected: resolved.evaluation.consequences.map((item) => ({
          id: item.artifactId,
          kind: item.kind,
          projectId: byId.get(item.artifactId)?.projectId ?? null,
          effect: item.effect,
          actions: item.actions,
        })),
      };
    });
  }

  private resolveEvent(eventId: string) {
    const event = this.library.changeEvents.get(eventId);
    if (!event) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    const artifacts = this.resolveArtifacts(event);
    return {
      event,
      artifacts,
      evaluation: evaluateInvalidation(event.matrixRow, artifacts),
    };
  }

  private consumeResolved(
    event: ChangeEvent,
    artifacts: ResolvedArtifact[],
    evaluation: ReturnType<typeof evaluateInvalidation>,
  ): InvalidationAudit {
    const priorReceipt = this.library.invalidationReceipts.get(event.id);
    if (priorReceipt) return this.verifyReplay(priorReceipt);
    const affectedIds = unique(
      evaluation.consequences.map((item) => item.artifactId),
    );
    const projectIds = this.affectedProjects(event, artifacts, evaluation);
    const consequenceHash = hashConsequences(
      event,
      evaluation.consequences,
      projectIds,
    );
    this.applyConsequences(event, artifacts, evaluation.consequences);
    const at = this.now();
    for (const projectId of projectIds) this.bumpBookVersion(projectId, at);
    const audit = this.creative.invalidationAudits.insert(
      invalidationAuditSchema.parse({
        id: this.idFactory(),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        eventId: event.id,
        matrixRow: event.matrixRow,
        consequenceHash,
        affectedIds,
        bookVersionProjectIds: projectIds,
      }),
    );
    this.library.invalidationReceipts.insert(
      invalidationReceiptSchema.parse({
        id: event.id,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        eventId: event.id,
        consumedAt: at,
        consequenceHash,
        affectedIds,
      }),
      "INVALIDATION_RECEIPT_CONFLICT",
    );
    return audit;
  }

  private assertEventScope(
    scope: FamilyScope,
    event: ChangeEvent,
    artifacts: ResolvedArtifact[],
  ): void {
    if (event.entity === "character") {
      this.assertCharacterScope(scope, event.entityId);
      this.assertArtifactProjects(scope, artifacts);
      return;
    }
    if (event.entity === "look") {
      this.assertLookScope(scope, event.entityId);
      this.assertArtifactProjects(scope, artifacts);
      return;
    }
    if (event.entity === "library_visibility") {
      const character = this.library.characters.get(event.entityId);
      const look = this.library.looks.get(event.entityId);
      if (!character && !look) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
      if (character && look) failCreative("CREATIVE_INVALIDATION_CONFLICT");
      if (character) this.assertCharacterScope(scope, character.id);
      else this.assertLookScope(scope, look!.id);
      this.assertArtifactProjects(scope, artifacts);
      return;
    }
    const sourceProjects = this.sourceProjectIds(event);
    const artifactProjects = artifacts.flatMap((artifact) =>
      artifact.projectId ? [artifact.projectId] : [],
    );
    const projectIds = unique([...sourceProjects, ...artifactProjects]);
    if (projectIds.length === 0) failCreative("CREATIVE_SCOPE_MISMATCH", 403);
    for (const projectId of projectIds)
      this.assertProjectScope(scope, projectId);
  }

  private assertCharacterScope(scope: FamilyScope, characterId: string): void {
    const character = this.library.characters.get(characterId);
    if (!character) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    const family = this.library.families.get(character.familyId);
    if (!family) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    if (
      family.customerId !== scope.customerId ||
      character.familyId !== scope.familyId
    )
      failCreative("CREATIVE_SCOPE_MISMATCH", 403);
  }

  private assertLookScope(scope: FamilyScope, lookId: string): void {
    const look = this.library.looks.get(lookId);
    if (!look) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    this.assertCharacterScope(scope, look.characterId);
  }

  private assertArtifactProjects(
    scope: FamilyScope,
    artifacts: ResolvedArtifact[],
  ): void {
    const projectIds = unique(
      artifacts.flatMap((artifact) =>
        artifact.projectId ? [artifact.projectId] : [],
      ),
    );
    for (const projectId of projectIds)
      this.assertProjectScope(scope, projectId);
  }

  private assertProjectScope(scope: FamilyScope, projectId: string): void {
    const project = this.authoring.projects.get(projectId);
    if (!project) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    if (
      project.customerId !== scope.customerId ||
      project.familyId !== scope.familyId
    )
      failCreative("CREATIVE_SCOPE_MISMATCH", 403);
  }

  private sourceProjectIds(event: ChangeEvent): string[] {
    if (event.entity === "project_override") {
      const override = this.authoring.projectOverrides.get(event.entityId);
      if (!override) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
      return [override.projectId];
    }
    const project = this.authoring.projects.get(event.entityId);
    if (project) return [project.id];
    const scene = this.authoring.scenes.get(event.entityId);
    if (scene) return [scene.projectId];
    const story = this.authoring.stories.get(event.entityId);
    if (story) return [story.projectId];
    const page = this.creative.pages.get(event.entityId);
    if (page) return [page.projectId];
    const illustration = this.creative.illustrations.get(event.entityId);
    if (illustration) {
      const illustrationPage = this.creative.pages.get(illustration.pageId);
      if (illustrationPage) return [illustrationPage.projectId];
    }
    return [];
  }

  private verifyReplay(
    receipt: ReturnType<LibraryRepositories["invalidationReceipts"]["get"]>,
  ): InvalidationAudit {
    if (!receipt) failCreative("CREATIVE_INVALIDATION_CONFLICT");
    const audits = this.creative.invalidationAudits.queryByField(
      "eventId",
      receipt.eventId,
    );
    if (
      audits.length !== 1 ||
      audits[0].consequenceHash !== receipt.consequenceHash ||
      canonicalJson(audits[0].affectedIds) !==
        canonicalJson(receipt.affectedIds)
    )
      failCreative("CREATIVE_INVALIDATION_CONFLICT");
    return audits[0];
  }

  private resolveArtifacts(event: ChangeEvent): ResolvedArtifact[] {
    const resolved: ResolvedArtifact[] = [];
    const sheets = this.matchingSheets(event);
    for (const sheet of sheets) {
      resolved.push({
        id: sheet.id,
        kind: "character_sheet",
        locked: false,
        projectId: sheet.projectId,
        record: sheet,
      });
      for (const approval of this.creative.approvals
        .queryByField("sheetId", sheet.id)
        .filter((item) => item.state === "approved")) {
        resolved.push({
          id: approval.id,
          kind: "character_approval",
          locked: false,
          projectId: approval.projectId,
          record: approval,
        });
      }
    }
    for (const page of this.matchingPages(event)) {
      if (page.currentIllustrationVersionId) {
        resolved.push({
          id: page.id,
          kind: "page_illustration",
          locked: page.locked,
          projectId: page.projectId,
          record: page,
        });
      }
      if (page.currentLayoutVersionId) {
        resolved.push({
          id: page.id,
          kind: "page_layout",
          locked: page.locked,
          projectId: page.projectId,
          record: page,
        });
      }
    }
    return resolved;
  }

  private matchingSheets(event: ChangeEvent): CharacterSheet[] {
    if (["IM-01", "IM-02", "IM-05"].includes(event.matrixRow)) {
      return this.creative.sheets
        .queryByField("characterId", event.entityId)
        .filter(
          (sheet) =>
            event.fromVersionId === null ||
            sheet.characterVersionId === event.fromVersionId,
        );
    }
    if (event.matrixRow === "IM-03") {
      return this.creative.sheets
        .list()
        .filter(
          (sheet) =>
            sheet.appearance.type === "shared_look" &&
            sheet.appearance.lookId === event.entityId &&
            (event.fromVersionId === null ||
              sheet.appearance.lookVersionId === event.fromVersionId),
        );
    }
    return [];
  }

  private matchingPages(event: ChangeEvent): Page[] {
    const pages = this.creative.pages.list();
    if (
      event.entity === "illustration" ||
      event.entity === "layout" ||
      event.entity === "narrative_text"
    )
      return pages.filter((page) => page.id === event.entityId);
    if (
      [
        "story",
        "page_count",
        "book_content",
        "project_style",
        "printer_profile",
        "cover_template",
        "provider_target",
        "internal",
        "watermark_setting",
      ].includes(event.entity)
    )
      return pages.filter((page) => page.projectId === event.entityId);
    const versionRef = event.fromVersionId;
    if (!versionRef) return [];
    return pages.filter((page) => {
      if (!page.currentIllustrationVersionId) return false;
      const illustration = this.creative.illustrations.get(
        page.currentIllustrationVersionId,
      );
      return illustration
        ? Object.values(illustration.inputSnapshot).includes(versionRef)
        : false;
    });
  }

  private affectedProjects(
    event: ChangeEvent,
    artifacts: ResolvedArtifact[],
    evaluation: ReturnType<typeof evaluateInvalidation>,
  ): string[] {
    if (!evaluation.bumpBookVersion) return [];
    const ids = artifacts
      .filter((artifact) =>
        evaluation.consequences.some(
          (consequence) => consequence.artifactId === artifact.id,
        ),
      )
      .flatMap((artifact) => (artifact.projectId ? [artifact.projectId] : []));
    ids.push(...this.sourceProjectIds(event));
    return unique(ids);
  }

  private applyConsequences(
    event: ChangeEvent,
    artifacts: ResolvedArtifact[],
    consequences: readonly InvalidationConsequence[],
  ): void {
    const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    for (const consequence of consequences) {
      const artifact = byId.get(consequence.artifactId);
      if (!artifact) continue;
      if (artifact.kind === "character_sheet") {
        this.updateSheet(artifact.record as CharacterSheet, consequence.effect);
      } else if (artifact.kind === "character_approval") {
        this.supersedeApproval(artifact.record as CharacterApproval, event.id);
      } else if (
        artifact.kind === "page_illustration" ||
        artifact.kind === "page_layout"
      ) {
        const page = artifact.record as Page;
        if (consequence.effect === "recheck") this.flagPageForReview(page.id);
        else this.markPageStale(page.id, event.matrixRow);
      }
    }
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

  private bumpBookVersion(projectId: string, at: string): void {
    const project = this.authoring.projects.get(projectId);
    if (!project) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    this.authoring.projects.update({
      ...project,
      bookVersion: project.bookVersion + 1,
      updatedAt: at,
    });
  }
}

function hashConsequences(
  event: ChangeEvent,
  consequences: readonly InvalidationConsequence[],
  projectIds: readonly string[],
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        eventId: event.id,
        row: event.matrixRow,
        consequences: [...consequences].sort((left, right) =>
          `${left.kind}:${left.artifactId}`.localeCompare(
            `${right.kind}:${right.artifactId}`,
          ),
        ),
        projectIds: [...projectIds].sort(),
      }),
    )
    .digest("hex");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

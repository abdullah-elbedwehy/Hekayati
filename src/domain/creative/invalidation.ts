import { ulid } from "ulid";

import { canonicalJson } from "../../contracts/canonical-json.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import type { Project } from "../authoring/schemas.js";
import { LayoutRepositories } from "../layout/repositories.js";
import { LibraryRepositories } from "../library/repositories.js";
import {
  changeEventSchema,
  invalidationReceiptSchema,
  type ChangeEvent,
} from "../library/schemas.js";
import type { FamilyScope } from "../library/types.js";
import type { DocumentStore } from "../repository/document-store.js";
import { failCreative } from "./errors.js";
import {
  evaluateInvalidation,
  type InvalidationConsequence,
} from "./invalidation-rules.js";
import { InvalidationMutationService } from "./invalidation-mutations.js";
import { CreativeRepositories } from "./repositories.js";
import {
  hashConsequences,
  previewReferencesAsset,
  unique,
  type AppendChangeEventInput,
  type CreativeInvalidationOptions,
  type InvalidationGateController,
  type InvalidationParticipant,
  type ResolvedArtifact,
} from "./invalidation-support.js";
import {
  invalidationAuditSchema,
  type CharacterSheet,
  type InvalidationAudit,
  type Page,
} from "./schemas.js";

export type {
  AppendChangeEventInput,
  CreativeInvalidationOptions,
  InvalidationGateController,
} from "./invalidation-support.js";

export class CreativeInvalidationService {
  private readonly creative: CreativeRepositories;
  private readonly library: LibraryRepositories;
  private readonly authoring: AuthoringRepositories;
  private readonly layout: LayoutRepositories;
  private readonly mutations: InvalidationMutationService;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly participants: InvalidationParticipant[] = [];

  constructor(
    private readonly store: DocumentStore,
    options: CreativeInvalidationOptions = {},
  ) {
    this.creative = new CreativeRepositories(store);
    this.library = new LibraryRepositories(store);
    this.authoring = new AuthoringRepositories(store);
    this.layout = new LayoutRepositories(store);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
    this.mutations = new InvalidationMutationService(store, this.now);
  }

  bindGateController(gates: InvalidationGateController): void {
    this.mutations.bindGateController(gates);
  }

  bindParticipant(participant: InvalidationParticipant): void {
    if (!this.participants.includes(participant))
      this.participants.push(participant);
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
    const evaluation = evaluateInvalidation(event.matrixRow, artifacts);
    const receipt = this.library.invalidationReceipts.get(event.id);
    return {
      event,
      artifacts,
      evaluation: receipt
        ? {
            ...evaluation,
            consequences: evaluation.consequences.filter((item) =>
              receipt.affectedIds.includes(item.artifactId),
            ),
          }
        : evaluation,
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
    this.mutations.apply(event, artifacts, evaluation.consequences);
    for (const participant of this.participants)
      participant.apply(event, artifacts, evaluation.consequences);
    const at = this.now();
    for (const projectId of projectIds)
      this.mutations.bumpBookVersion(projectId, at);
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
    const participantIds = this.participants.flatMap((participant) =>
      participant.sourceProjectIds(event),
    );
    const builtIn = this.builtInSourceProjectIds(event);
    return unique([...builtIn, ...participantIds]);
  }

  private builtInSourceProjectIds(event: ChangeEvent): string[] {
    if (event.entity === "project_override") {
      const override = this.authoring.projectOverrides.get(event.entityId);
      if (!override) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
      return [override.projectId];
    }
    if (event.entity === "asset_integrity")
      return this.assetIntegrityProjectIds(event.entityId);
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

  private assetIntegrityProjectIds(assetId: string): string[] {
    const pageProjects = this.creative.pages.list().flatMap((page) => {
      const illustration = page.currentIllustrationVersionId
        ? this.creative.illustrations.get(page.currentIllustrationVersionId)
        : null;
      return illustration?.assetId === assetId ? [page.projectId] : [];
    });
    const sheetProjects = this.creative.sheets
      .list()
      .flatMap((sheet) =>
        sheet.pdfAssetId === assetId ||
        Object.values(sheet.views).includes(assetId)
          ? [sheet.projectId]
          : [],
      );
    const previewProjects = this.layout.previewOutputs
      .list()
      .flatMap((output) =>
        output.assetId === assetId || previewReferencesAsset(output, assetId)
          ? [output.projectId]
          : [],
      );
    const coverProjects = this.layout.coverCompositionVersions
      .list()
      .flatMap((cover) =>
        cover.sourceAssets.some((source) => source.assetId === assetId)
          ? [cover.projectId]
          : [],
      );
    return unique([
      ...pageProjects,
      ...sheetProjects,
      ...previewProjects,
      ...coverProjects,
    ]);
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
    const resolved = this.resolveCreativeArtifacts(event);
    const projectIds = unique([
      ...this.sourceProjectIds(event),
      ...resolved.flatMap((artifact) =>
        artifact.projectId ? [artifact.projectId] : [],
      ),
    ]);
    for (const projectId of projectIds) {
      const project = this.authoring.projects.get(projectId);
      if (project) this.resolveLayoutArtifacts(project, resolved);
    }
    for (const participant of this.participants)
      resolved.push(...participant.resolve(event));
    return [
      ...new Map(
        resolved.map((artifact) => [
          `${artifact.kind}:${artifact.id}`,
          artifact,
        ]),
      ).values(),
    ];
  }

  private resolveCreativeArtifacts(event: ChangeEvent): ResolvedArtifact[] {
    const resolved: ResolvedArtifact[] = [];
    for (const sheet of this.matchingSheets(event)) {
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
      if (this.layout.pageLayoutHeads.get(page.id)) {
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

  private resolveLayoutArtifacts(
    project: Project,
    resolved: ResolvedArtifact[],
  ): void {
    const output = project.currentPreviewOutputId
      ? this.layout.previewOutputs.get(project.currentPreviewOutputId)
      : null;
    if (output)
      resolved.push({
        id: output.id,
        kind: "preview_pdf",
        locked: false,
        projectId: project.id,
        record: output,
      });
    const cycleIds = unique(
      [project.currentPreviewCycleId, project.currentContentApprovalId].filter(
        (id): id is string => Boolean(id),
      ),
    );
    for (const cycleId of cycleIds) {
      const cycle = this.layout.bookApprovalCycles.get(cycleId);
      if (cycle)
        resolved.push({
          id: cycle.id,
          kind: "book_approval",
          locked: false,
          projectId: project.id,
          record: cycle,
        });
    }
  }

  private matchingSheets(event: ChangeEvent): CharacterSheet[] {
    if (event.matrixRow === "IM-20")
      return this.creative.sheets
        .list()
        .filter(
          (sheet) =>
            sheet.pdfAssetId === event.entityId ||
            Object.values(sheet.views).includes(event.entityId),
        );
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
    if (event.entity === "asset_integrity")
      return pages.filter((page) => {
        const illustration = page.currentIllustrationVersionId
          ? this.creative.illustrations.get(page.currentIllustrationVersionId)
          : null;
        return illustration?.assetId === event.entityId;
      });
    if (event.entity === "layout" || event.entity === "narrative_text")
      return pages.filter((page) => page.id === event.entityId);
    if (event.entity === "illustration") {
      const illustration = this.creative.illustrations.get(event.entityId);
      const pageId =
        illustration?.pageId ?? this.creative.pages.get(event.entityId)?.id;
      return pageId ? pages.filter((page) => page.id === pageId) : [];
    }
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
    const alreadyBumped = new Set(
      this.library.changeEvents
        .queryByField("correlationId", event.correlationId)
        .filter((candidate) => candidate.id !== event.id)
        .flatMap((candidate) =>
          this.creative.invalidationAudits
            .queryByField("eventId", candidate.id)
            .flatMap((audit) => audit.bookVersionProjectIds),
        ),
    );
    return unique(ids).filter((projectId) => !alreadyBumped.has(projectId));
  }
}

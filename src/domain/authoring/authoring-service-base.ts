import { ulid } from "ulid";

import {
  LibraryError,
  changeEventSchema,
  type ChangeEvent,
  type FamilyScope,
  type LibraryService,
} from "../library/index.js";
import type { DocumentStore } from "../repository/document-store.js";
import type {
  AppendChangeEventInput,
  CreativeInvalidationService,
} from "../creative/invalidation.js";
import { A4_COMPOSITION_PROFILE_ID } from "../layout/policy.js";
import { calculateNarrationBalance } from "./balance.js";
import {
  getBookPageMap,
  storySlotCount,
  type PageCountOperation,
  type PageCountPlan,
} from "./book-structure.js";
import { failAuthoring } from "./errors.js";
import { sameFamilyDuplicatePlan } from "./duplication-plan.js";
import {
  compileAuthoringSegments,
  type CompileParticipant,
  type MentionCandidate,
} from "./mentions.js";
import type { ProjectWorkspace, SceneRecord } from "./project-types.js";
import {
  baseDocument,
  blankSceneContent,
  compileWorkspaceParticipants,
  requiredSceneText,
  type AuthoringServiceOptions,
} from "./authoring-service-support.js";
import { AuthoringRepositories } from "./repositories.js";
import {
  type PageCount,
  type Project,
  type ProjectOverride,
  type ProjectOverrideVersion,
  type ProjectParticipant,
  type ProjectVersion,
  type SceneContent,
  type SceneVersion,
  type Story,
  type StoryConfig,
  type StoryVersion,
} from "./schemas.js";
import { TemplateService } from "./template-service.js";

export type { AuthoringServiceOptions } from "./authoring-service-support.js";

export abstract class AuthoringServiceBase {
  protected readonly repositories: AuthoringRepositories;
  protected readonly templates: TemplateService;
  protected readonly now: () => string;
  protected readonly idFactory: () => string;
  private invalidation: CreativeInvalidationService | null = null;
  private readonly changeEventMode: "persist" | "suppress";

  constructor(
    protected readonly store: DocumentStore,
    protected readonly library: LibraryService,
    options: AuthoringServiceOptions = {},
  ) {
    this.repositories = new AuthoringRepositories(store);
    this.templates = new TemplateService(store, options);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
    this.changeEventMode = options.changeEventMode ?? "persist";
  }

  bindInvalidation(invalidation: CreativeInvalidationService): void {
    if (this.invalidation && this.invalidation !== invalidation)
      failAuthoring("PROJECT_VERSION_CONFLICT");
    this.invalidation = invalidation;
  }

  protected emitChange(
    input: Omit<AppendChangeEventInput, "id">,
    at = this.now(),
  ): ChangeEvent {
    const id = this.idFactory();
    const document = changeEventSchema.parse({
      ...baseDocument(id, at),
      ...input,
      occurredAt: input.occurredAt ?? at,
    });
    if (this.changeEventMode === "suppress") return document;
    if (this.invalidation)
      return this.invalidation.recordAndConsume({ id, ...input }).event;
    return this.repositories.changeEvents.insert(document);
  }

  protected insertInitialStory(
    projectId: string,
    pageCount: PageCount,
    at: string,
  ): { story: Story; version: StoryVersion } {
    const storyId = this.idFactory();
    const scenes = Array.from(
      { length: storySlotCount(pageCount) },
      (_, index) => this.insertBlankScene(projectId, index + 1, at),
    );
    const version = this.repositories.storyVersions.insert({
      ...baseDocument(this.idFactory(), at),
      storyId,
      previousVersionId: null,
      source: "manual",
      planJson: null,
      sceneVersionIds: scenes.map(({ version: item }) => item.id),
      pageCountChange: null,
      completedAt: null,
    });
    const story = this.repositories.stories.insert({
      ...baseDocument(storyId, at),
      projectId,
      status: "draft",
      currentVersionId: version.id,
    });
    return { story, version };
  }

  protected insertProject(
    scope: FamilyScope,
    projectId: string,
    versionId: string,
    at: string,
  ): Project {
    return this.repositories.projects.insert({
      ...baseDocument(projectId, at),
      schemaVersion: 2,
      customerId: scope.customerId,
      familyId: scope.familyId,
      revision: 0,
      status: "draft",
      priority: 0,
      paused: false,
      currentVersionId: versionId,
      bookVersion: 1,
      compositionProfileId: A4_COMPOSITION_PROFILE_ID,
      currentCoverCompositionVersionId: null,
      currentPreviewOutputId: null,
      currentPreviewCycleId: null,
      currentContentApprovalId: null,
      printerProfileId: null,
    });
  }

  protected insertProjectVersion(
    projectId: string,
    previousVersionId: string | null,
    storyConfig: StoryConfig,
    at: string,
  ): ProjectVersion {
    return this.repositories.projectVersions.insert({
      ...baseDocument(this.idFactory(), at),
      projectId,
      previousVersionId,
      storyConfig,
    });
  }

  protected advanceProject(
    project: Project,
    versionId: string,
    at: string,
  ): Project {
    return this.repositories.projects.update({
      ...project,
      currentVersionId: versionId,
      updatedAt: at,
      revision: project.revision + 1,
    });
  }

  protected appendSceneVersion(
    workspace: ProjectWorkspace,
    target: SceneRecord,
    content: SceneContent,
    at: string,
  ): SceneVersion {
    return this.repositories.sceneVersions.insert({
      ...baseDocument(this.idFactory(), at),
      sceneId: target.scene.id,
      previousVersionId: target.version.id,
      sourceSceneVersionIds: [],
      needsAuthoring: !this.sceneIsComplete(workspace, content),
      content,
    });
  }

  protected appendStoryVersion(
    workspace: ProjectWorkspace,
    scenes: SceneRecord[],
    at: string,
  ): StoryVersion {
    const complete = this.storyIsComplete(
      workspace.version.storyConfig.pageCount,
      scenes,
    );
    const version = this.insertStoryVersion(workspace, scenes, complete, at);
    this.repositories.stories.update({
      ...workspace.story,
      status: complete ? "complete" : "draft",
      currentVersionId: version.id,
      updatedAt: at,
    });
    return version;
  }

  protected appendGeneratedStoryVersion(
    workspace: ProjectWorkspace,
    scenes: SceneRecord[],
    planJson: unknown,
    at: string,
  ): StoryVersion {
    const complete = this.storyIsComplete(
      workspace.version.storyConfig.pageCount,
      scenes,
    );
    if (!complete) failAuthoring("STORY_STRUCTURE_INCOMPLETE");
    this.store.assertSafeForPersistence(planJson);
    const version = this.repositories.storyVersions.insert({
      ...baseDocument(this.idFactory(), at),
      storyId: workspace.story.id,
      previousVersionId: workspace.storyVersion.id,
      source: "generated",
      planJson,
      sceneVersionIds: scenes.map(({ version: scene }) => scene.id),
      pageCountChange: null,
      completedAt: at,
    });
    this.repositories.stories.update({
      ...workspace.story,
      status: "complete",
      currentVersionId: version.id,
      updatedAt: at,
    });
    return version;
  }

  protected storyIsComplete(
    pageCount: PageCount,
    scenes: SceneRecord[],
  ): boolean {
    return (
      scenes.length === storySlotCount(pageCount) &&
      scenes.every(
        ({ version }) =>
          !version.needsAuthoring && requiredSceneText(version.content),
      )
    );
  }

  protected duplicateCompletedWorkspace(
    scope: FamilyScope,
    source: ProjectWorkspace,
    title: string,
  ): ProjectWorkspace {
    const at = this.now();
    const projectId = this.idFactory();
    const participants = source.version.storyConfig.participants.map(
      (participant) =>
        this.cloneParticipantForProject(source, projectId, participant, at),
    );
    const version = this.insertProjectVersion(
      projectId,
      null,
      { ...source.version.storyConfig, title, participants },
      at,
    );
    const project = this.insertProject(scope, projectId, version.id, at);
    const scenes = source.scenes.map(({ scene, version: sourceVersion }) =>
      this.insertScene(
        project.id,
        scene.storyPageIndex,
        [sourceVersion.id],
        sourceVersion.content,
        sourceVersion.needsAuthoring,
        at,
      ),
    );
    const storyId = this.idFactory();
    const storyVersion = this.repositories.storyVersions.insert({
      ...baseDocument(this.idFactory(), at),
      storyId,
      previousVersionId: null,
      source: "manual",
      planJson: sameFamilyDuplicatePlan(source),
      sceneVersionIds: scenes.map(({ version: item }) => item.id),
      pageCountChange: null,
      completedAt: at,
    });
    const story = this.repositories.stories.insert({
      ...baseDocument(storyId, at),
      projectId: project.id,
      status: "complete",
      currentVersionId: storyVersion.id,
    });
    return this.workspaceFrom(project, version, story, storyVersion);
  }

  protected createStructuralScenes(
    workspace: ProjectWorkspace,
    operations: PageCountOperation[],
    at: string,
  ): SceneRecord[] {
    const versions = new Map(
      workspace.scenes.map(({ version }) => [version.id, version]),
    );
    return operations
      .filter((operation) => operation.targetStoryPageIndex !== null)
      .map((operation) => {
        const sourceId = operation.sourceSceneVersionIds[0];
        const source = sourceId ? versions.get(sourceId) : undefined;
        return this.insertScene(
          workspace.project.id,
          operation.targetStoryPageIndex!,
          operation.sourceSceneVersionIds,
          operation.type === "retain" && source
            ? source.content
            : blankSceneContent(),
          operation.type !== "retain",
          at,
        );
      });
  }

  protected configForPageCount(
    config: StoryConfig,
    pageCount: PageCount,
  ): StoryConfig {
    return {
      ...config,
      pageCount,
      narrationDialogueBalance: calculateNarrationBalance(
        { ...config, pageCount },
        config.narrationDialogueBalance.operatorEdited
          ? config.narrationDialogueBalance
          : undefined,
      ),
    };
  }

  protected appendPageCountStoryVersion(
    workspace: ProjectWorkspace,
    scenes: SceneRecord[],
    plan: PageCountPlan,
    at: string,
  ): StoryVersion {
    const version = this.repositories.storyVersions.insert({
      ...baseDocument(this.idFactory(), at),
      storyId: workspace.story.id,
      previousVersionId: workspace.storyVersion.id,
      source: "manual",
      planJson: plan,
      sceneVersionIds: scenes.map(({ version: item }) => item.id),
      pageCountChange: {
        from: plan.input.from,
        to: plan.input.to,
        planHash: plan.hash,
        operations: plan.operations,
      },
      completedAt: null,
    });
    this.repositories.stories.update({
      ...workspace.story,
      status: "draft",
      currentVersionId: version.id,
      updatedAt: at,
    });
    return version;
  }

  protected assertFreshPageCountPlan(
    workspace: ProjectWorkspace,
    projectId: string,
    plan: PageCountPlan,
  ): void {
    const currentIds = workspace.scenes.map(({ version }) => version.id);
    if (
      plan.input.projectId !== projectId ||
      plan.input.expectedProjectVersionId !== workspace.version.id ||
      plan.input.expectedStoryVersionId !== workspace.storyVersion.id ||
      plan.input.from !== workspace.version.storyConfig.pageCount ||
      JSON.stringify(plan.input.sourceSceneVersionIds) !==
        JSON.stringify(currentIds)
    )
      failAuthoring("PAGE_COUNT_PREFLIGHT_STALE");
  }

  protected workspace(project: Project): ProjectWorkspace {
    const version = this.currentProjectVersion(project);
    const story = this.repositories.stories
      .queryByField("projectId", project.id)
      .at(-1);
    if (!story) failAuthoring("STORY_NOT_FOUND");
    const storyVersion = this.repositories.storyVersions.get(
      story.currentVersionId,
    );
    if (!storyVersion || storyVersion.storyId !== story.id)
      failAuthoring("STORY_NOT_FOUND");
    return this.workspaceFrom(project, version, story, storyVersion);
  }

  protected workspaceFrom(
    project: Project,
    version: ProjectVersion,
    story: Story,
    storyVersion: StoryVersion,
  ): ProjectWorkspace {
    const scenes = storyVersion.sceneVersionIds.map((versionId) =>
      this.sceneRecord(project.id, versionId),
    );
    const complete = this.storyIsComplete(
      version.storyConfig.pageCount,
      scenes,
    );
    return {
      project,
      version,
      story: {
        ...story,
        currentVersionId: storyVersion.id,
        status: complete ? "complete" : "draft",
      },
      storyVersion,
      scenes: scenes.sort(
        (left, right) => left.scene.storyPageIndex - right.scene.storyPageIndex,
      ),
      pageMap: getBookPageMap(version.storyConfig.pageCount),
    };
  }

  protected scopedProject(scope: FamilyScope, projectId: string): Project {
    this.assertFamilyScope(scope);
    const project = this.repositories.projects.get(projectId);
    if (!project) failAuthoring("PROJECT_NOT_FOUND");
    if (
      project.customerId !== scope.customerId ||
      project.familyId !== scope.familyId
    )
      failAuthoring("PROJECT_FAMILY_SCOPE_VIOLATION");
    return project;
  }

  protected assertFamilyScope(scope: FamilyScope): void {
    try {
      this.library.getFamily(scope);
    } catch (error) {
      this.rethrowScope(error, "PROJECT_FAMILY_SCOPE_VIOLATION");
    }
  }

  protected currentProjectVersion(project: Project): ProjectVersion {
    const version = this.repositories.projectVersions.get(
      project.currentVersionId,
    );
    if (!version || version.projectId !== project.id)
      failAuthoring("PROJECT_VERSION_NOT_FOUND");
    return version;
  }

  protected assertProjectHead(
    project: Project,
    expectedVersionId: string,
  ): void {
    if (project.currentVersionId !== expectedVersionId)
      failAuthoring("PROJECT_VERSION_CONFLICT");
  }

  protected mentionCandidate(
    scope: FamilyScope,
    participant: ProjectParticipant,
  ): MentionCandidate {
    const character = this.library.getCharacter(scope, participant.characterId);
    const version = this.library.getCharacterVersion(
      scope,
      character.id,
      character.currentVersionId,
    );
    const photo = this.library.listReferencePhotosForCharacter(
      scope,
      character.id,
    )[0];
    return {
      characterId: character.id,
      displayName: version.profile.name,
      relationshipType: version.profile.relationship.type,
      narrativeRole: participant.narrativeRole,
      thumbnailUrl: photo
        ? `/api/library/reference-photos/${photo.id}/thumbnail`
        : null,
      archived: character.status === "archived",
    };
  }

  protected overrideFor(
    projectId: string,
    participant: ProjectParticipant,
  ): ProjectOverride | null {
    if (participant.appearance.type !== "project_override") return null;
    const override = this.repositories.projectOverrides.get(
      participant.appearance.overrideId,
    );
    if (!override || override.projectId !== projectId)
      failAuthoring("PROJECT_OVERRIDE_NOT_FOUND");
    return override;
  }

  protected insertOverrideVersion(
    participant: ProjectParticipant,
    existing: ProjectOverride | null,
    command: {
      expectedOverrideVersionId?: string;
      clothing: string;
      appearanceOverrides: Record<string, string>;
    },
    at: string,
  ): ProjectOverrideVersion {
    if (
      existing &&
      existing.currentVersionId !== command.expectedOverrideVersionId
    )
      failAuthoring("PROJECT_OVERRIDE_VERSION_CONFLICT");
    const overrideId = existing?.id ?? this.idFactory();
    return this.repositories.projectOverrideVersions.insert({
      ...baseDocument(this.idFactory(), at),
      overrideId,
      previousVersionId: existing?.currentVersionId ?? null,
      baseCharacterVersionId: participant.characterVersionId,
      baseLookVersionId:
        participant.appearance.type === "shared_look"
          ? participant.appearance.lookVersionId
          : null,
      clothing: command.clothing,
      appearanceOverrides: command.appearanceOverrides,
    });
  }

  protected upsertOverride(
    project: Project,
    participant: ProjectParticipant,
    existing: ProjectOverride | null,
    version: ProjectOverrideVersion,
    at: string,
  ): ProjectOverride {
    if (existing)
      return this.repositories.projectOverrides.update({
        ...existing,
        currentVersionId: version.id,
        updatedAt: at,
      });
    return this.repositories.projectOverrides.insert({
      ...baseDocument(version.overrideId, at),
      projectId: project.id,
      characterId: participant.characterId,
      currentVersionId: version.id,
      status: "active",
    });
  }

  protected pinOverride(
    project: Project,
    current: ProjectVersion,
    participant: ProjectParticipant,
    override: ProjectOverride,
    version: ProjectOverrideVersion,
    at: string,
  ): ProjectVersion {
    const participants = current.storyConfig.participants.map((item) =>
      item.characterId === participant.characterId
        ? {
            ...item,
            appearance: {
              type: "project_override" as const,
              overrideId: override.id,
              overrideVersionId: version.id,
            },
          }
        : item,
    );
    const next = this.insertProjectVersion(
      project.id,
      current.id,
      { ...current.storyConfig, participants },
      at,
    );
    this.advanceProject(project, next.id, at);
    return next;
  }

  protected insertOverrideEvent(
    previousVersionId: string | null,
    override: ProjectOverride,
    version: ProjectOverrideVersion,
    at: string,
  ): ChangeEvent {
    const correlationId = this.idFactory();
    return this.emitChange(
      {
        entity: "project_override",
        entityId: override.id,
        fromVersionId: previousVersionId,
        toVersionId: version.id,
        changeType: "project_look_override",
        matrixRow: "IM-04",
        changedFields: ["clothing", "appearanceOverrides"],
        correlationId,
        occurredAt: at,
      },
      at,
    );
  }

  protected rethrowScope(
    error: unknown,
    fallback: Parameters<typeof failAuthoring>[0],
  ): never {
    if (error instanceof LibraryError) {
      if (
        error.code === "FAMILY_ANCHOR_REQUIRED" ||
        error.code === "FAMILY_ANCHOR_ARCHIVED"
      )
        throw error;
      if (
        error.code === "FAMILY_SCOPE_MISMATCH" ||
        error.code === "CHARACTER_NOT_FOUND" ||
        error.code === "LOOK_NOT_FOUND"
      )
        failAuthoring(fallback);
    }
    throw error;
  }

  private insertBlankScene(
    projectId: string,
    storyPageIndex: number,
    at: string,
  ): SceneRecord {
    return this.insertScene(
      projectId,
      storyPageIndex,
      [],
      blankSceneContent(),
      true,
      at,
    );
  }

  protected insertScene(
    projectId: string,
    storyPageIndex: number,
    sourceSceneVersionIds: string[],
    content: SceneContent,
    needsAuthoring: boolean,
    at: string,
  ): SceneRecord {
    const sceneId = this.idFactory();
    const version = this.repositories.sceneVersions.insert({
      ...baseDocument(this.idFactory(), at),
      sceneId,
      previousVersionId: null,
      sourceSceneVersionIds,
      needsAuthoring,
      content,
    });
    const scene = this.repositories.scenes.insert({
      ...baseDocument(sceneId, at),
      projectId,
      storyPageIndex,
      currentVersionId: version.id,
    });
    return { scene, version };
  }

  private cloneParticipantForProject(
    source: ProjectWorkspace,
    projectId: string,
    participant: ProjectParticipant,
    at: string,
  ): ProjectParticipant {
    if (participant.appearance.type !== "project_override") return participant;
    const sourceOverride = this.repositories.projectOverrides.get(
      participant.appearance.overrideId,
    );
    const sourceVersion = this.repositories.projectOverrideVersions.get(
      participant.appearance.overrideVersionId,
    );
    if (
      !sourceOverride ||
      sourceOverride.projectId !== source.project.id ||
      !sourceVersion ||
      sourceVersion.overrideId !== sourceOverride.id
    )
      failAuthoring("PROJECT_OVERRIDE_NOT_FOUND");
    const overrideId = this.idFactory();
    const version = this.repositories.projectOverrideVersions.insert({
      ...baseDocument(this.idFactory(), at),
      overrideId,
      previousVersionId: null,
      baseCharacterVersionId: sourceVersion.baseCharacterVersionId,
      baseLookVersionId: sourceVersion.baseLookVersionId,
      clothing: sourceVersion.clothing,
      appearanceOverrides: sourceVersion.appearanceOverrides,
    });
    this.repositories.projectOverrides.insert({
      ...baseDocument(overrideId, at),
      projectId,
      characterId: participant.characterId,
      currentVersionId: version.id,
      status: sourceOverride.status,
    });
    return {
      ...participant,
      appearance: {
        type: "project_override",
        overrideId,
        overrideVersionId: version.id,
      },
    };
  }

  private insertStoryVersion(
    workspace: ProjectWorkspace,
    scenes: SceneRecord[],
    complete: boolean,
    at: string,
  ): StoryVersion {
    return this.repositories.storyVersions.insert({
      ...baseDocument(this.idFactory(), at),
      storyId: workspace.story.id,
      previousVersionId: workspace.storyVersion.id,
      source: "manual",
      planJson: null,
      sceneVersionIds: scenes.map(({ version }) => version.id),
      pageCountChange: null,
      completedAt: complete ? at : null,
    });
  }

  private sceneIsComplete(
    workspace: ProjectWorkspace,
    content: SceneContent,
  ): boolean {
    if (!requiredSceneText(content)) return false;
    try {
      const compiled = compileAuthoringSegments({
        segments: content.documentSegments,
        participants: this.compileParticipants(workspace),
        mainChildId: workspace.version.storyConfig.mainChildId,
        selectedParticipantIds: workspace.version.storyConfig.participants.map(
          ({ characterId }) => characterId,
        ),
        capability: { mode: "mock_unlimited" },
        acknowledgements: { reconciliation: true, capacity: false },
      });
      const mentioned = new Set(
        compiled.occurrences.map(({ characterId }) => characterId),
      );
      return (
        mentioned.size > 0 &&
        content.dialogue.every(({ speakerCharacterId }) =>
          mentioned.has(speakerCharacterId),
        )
      );
    } catch {
      return false;
    }
  }

  protected compileParticipants(
    workspace: ProjectWorkspace,
  ): CompileParticipant[] {
    return compileWorkspaceParticipants(this.library, workspace);
  }

  private sceneRecord(projectId: string, versionId: string): SceneRecord {
    const version = this.repositories.sceneVersions.get(versionId);
    if (!version) failAuthoring("SCENE_NOT_FOUND");
    const scene = this.repositories.scenes.get(version.sceneId);
    if (!scene || scene.projectId !== projectId)
      failAuthoring("SCENE_NOT_FOUND");
    return { scene, version };
  }
}

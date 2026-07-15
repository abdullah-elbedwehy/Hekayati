import type { FamilyScope } from "../library/index.js";
import { GeneratedStoryServiceBase } from "./generated-story-service-base.js";
import { calculateNarrationBalance } from "./balance.js";
import {
  assertPageCountPlanIntegrity,
  createPageCountPlan,
  type PageCountPlan,
} from "./book-structure.js";
import { failAuthoring } from "./errors.js";
import {
  createCrossFamilyDraft,
  extractPrivacySafeTemplate,
  missingCustomStoryFields,
  sourcePrivacyMarkers,
  type CrossFamilyDuplicationDraft,
} from "./extraction.js";
import {
  compileAuthoringSegments,
  filterMentionCandidates,
  type CompileCapability,
  type MentionCandidate,
} from "./mentions.js";
import {
  rewriteCharacterReferences,
  sceneReferencesCharacter,
} from "./removal.js";
import {
  projectInputSchema,
  sceneContentSchema,
  type AppearanceSelection,
  type PageCount,
  type ParsedProjectInput,
  type Project,
  type ProjectInput,
  type ProjectParticipant,
  type ProjectVersion,
  type Scene,
  type SceneContent,
  type SceneVersion,
  type StoryConfig,
  type TemplateStatus,
} from "./schemas.js";
import type { TemplateRecord } from "./template-service.js";
import type {
  CharacterRemovalPreflight,
  CharacterRemovalResolution,
  ProjectOverrideResult,
  ProjectWorkspace,
  SceneCompileResult,
  SceneRecord,
} from "./project-types.js";
import {
  pageCountChangeEvent,
  projectConfigEvents,
  sceneContentChangeEvent,
} from "./project-events.js";
import {
  activeProjectCharacters,
  assertProjectMainChild,
} from "./project-participants.js";
import { resolveProjectTemplate } from "./project-template.js";

export type { AuthoringServiceOptions } from "./authoring-service-base.js";
export type {
  CharacterRemovalPreflight,
  CharacterRemovalResolution,
  ProjectOverrideResult,
  ProjectWorkspace,
  SceneCompileResult,
  SceneRecord,
} from "./project-types.js";

export class AuthoringService extends GeneratedStoryServiceBase {
  listProjects(scope: FamilyScope): ProjectWorkspace[] {
    this.assertFamilyScope(scope);
    return this.repositories.projects
      .queryByField("familyId", scope.familyId)
      .filter((project) => project.customerId === scope.customerId)
      .map((project) => this.workspace(project));
  }

  getProjectWorkspace(scope: FamilyScope, projectId: string): ProjectWorkspace {
    return this.workspace(this.scopedProject(scope, projectId));
  }

  createProject(scope: FamilyScope, rawInput: ProjectInput): ProjectWorkspace {
    const input = projectInputSchema.parse(rawInput);
    const config = this.buildConfig(scope, input, null);
    return this.store.transaction(() => {
      const at = this.now();
      const projectId = this.idFactory();
      const version = this.insertProjectVersion(projectId, null, config, at);
      const project = this.insertProject(scope, projectId, version.id, at);
      const story = this.insertInitialStory(project.id, config.pageCount, at);
      return this.workspaceFrom(project, version, story.story, story.version);
    });
  }

  updateProject(
    scope: FamilyScope,
    projectId: string,
    command: { expectedVersionId: string; input: ProjectInput },
  ): ProjectWorkspace {
    const input = projectInputSchema.parse(command.input);
    return this.store.transaction(() => {
      const project = this.scopedProject(scope, projectId);
      const current = this.currentProjectVersion(project);
      this.assertProjectHead(project, command.expectedVersionId);
      if (input.pageCount !== current.storyConfig.pageCount)
        failAuthoring("PAGE_COUNT_PREFLIGHT_REQUIRED");
      const config = this.buildConfig(scope, input, current.storyConfig);
      const at = this.now();
      const version = this.insertProjectVersion(
        project.id,
        current.id,
        config,
        at,
      );
      const updated = this.advanceProject(project, version.id, at);
      this.emitProjectConfigChanges(project, current, version, at);
      const refreshed = this.repositories.projects.get(updated.id) ?? updated;
      return this.workspace({ ...refreshed, currentVersionId: version.id });
    });
  }

  appendProjectOverride(
    scope: FamilyScope,
    projectId: string,
    command: {
      expectedProjectVersionId: string;
      expectedOverrideVersionId?: string;
      characterId: string;
      clothing: string;
      appearanceOverrides: Record<string, string>;
    },
  ): ProjectOverrideResult {
    return this.store.transaction(() =>
      this.appendOverrideInTransaction(scope, projectId, command),
    );
  }

  mentionCandidates(
    scope: FamilyScope,
    projectId: string,
    query = "",
  ): MentionCandidate[] {
    const workspace = this.getProjectWorkspace(scope, projectId);
    const candidates = workspace.version.storyConfig.participants.map(
      (participant) => this.mentionCandidate(scope, participant),
    );
    return filterMentionCandidates(query, candidates);
  }

  compileScene(
    scope: FamilyScope,
    projectId: string,
    storyPageIndex: number,
    input: {
      selectedParticipantIds: string[];
      capability: CompileCapability;
      acknowledgements: { reconciliation: boolean; capacity: boolean };
    },
  ): SceneCompileResult {
    const workspace = this.getProjectWorkspace(scope, projectId);
    const scene = workspace.scenes.find(
      (item) => item.scene.storyPageIndex === storyPageIndex,
    );
    if (!scene) failAuthoring("SCENE_NOT_FOUND");
    const compiled = compileAuthoringSegments({
      segments: scene.version.content.documentSegments,
      participants: this.compileParticipants(workspace),
      mainChildId: workspace.version.storyConfig.mainChildId,
      ...input,
    });
    return {
      projectVersionId: workspace.version.id,
      storyVersionId: workspace.storyVersion.id,
      sceneVersionId: scene.version.id,
      ...compiled,
    };
  }

  preflightCharacterRemoval(
    scope: FamilyScope,
    projectId: string,
    characterId: string,
  ): CharacterRemovalPreflight {
    const workspace = this.getProjectWorkspace(scope, projectId);
    const participant = this.removableParticipant(workspace, characterId);
    const relationship = this.library.getCharacterVersion(
      scope,
      participant.characterId,
      participant.characterVersionId,
    ).profile.relationship.type;
    const affected = workspace.scenes.filter(({ version }) =>
      sceneReferencesCharacter(
        version.content,
        characterId,
        relationship,
        characterId === workspace.version.storyConfig.mainChildId,
      ),
    );
    return {
      characterId,
      affectedSceneIds: affected.map(({ scene }) => scene.id),
      affectedStoryPageIndexes: affected.map(
        ({ scene }) => scene.storyPageIndex,
      ),
      resolutions: ["cancel", "replace", "remove_mentions"],
    };
  }

  resolveCharacterRemoval(
    scope: FamilyScope,
    projectId: string,
    command: {
      expectedProjectVersionId: string;
      expectedStoryVersionId: string;
      characterId: string;
      resolution: CharacterRemovalResolution;
    },
  ): ProjectWorkspace {
    const resolution = command.resolution;
    if (resolution.type === "cancel")
      return this.getProjectWorkspace(scope, projectId);
    return this.store.transaction(() =>
      this.resolveCharacterRemovalInTransaction(scope, projectId, {
        ...command,
        resolution,
      }),
    );
  }

  validateGenerationReadiness(
    scope: FamilyScope,
    projectId: string,
  ): { ready: true; projectVersionId: string } {
    const workspace = this.getProjectWorkspace(scope, projectId);
    const config = workspace.version.storyConfig;
    if (config.storyType === "fully_custom") {
      const missingFields = missingCustomStoryFields(config.customStory);
      if (missingFields.length)
        failAuthoring("CUSTOM_STORY_INCOMPLETE", { missingFields });
    }
    return { ready: true, projectVersionId: workspace.version.id };
  }

  extractTemplateFromCompletedStory(
    scope: FamilyScope,
    projectId: string,
    name: string,
  ): TemplateRecord {
    const workspace = this.getProjectWorkspace(scope, projectId);
    if (workspace.story.status !== "complete")
      failAuthoring("STORY_STRUCTURE_INCOMPLETE");
    const content = extractPrivacySafeTemplate({
      name,
      participantCount: workspace.version.storyConfig.participants.length,
      sourceMarkers: sourcePrivacyMarkers(this.library, scope, workspace),
    });
    try {
      this.store.assertSafeForPersistence(content);
    } catch {
      failAuthoring("PRIVACY_SCAN_FAILED");
    }
    return this.templates.create(content);
  }

  duplicateCompletedStoryWithinFamily(
    scope: FamilyScope,
    projectId: string,
    command: {
      expectedProjectVersionId: string;
      expectedStoryVersionId: string;
      title: string;
    },
  ): ProjectWorkspace {
    const title = projectInputSchema.shape.title.parse(command.title);
    return this.store.transaction(() => {
      const source = this.getProjectWorkspace(scope, projectId);
      this.assertProjectHead(source.project, command.expectedProjectVersionId);
      if (source.storyVersion.id !== command.expectedStoryVersionId)
        failAuthoring("STORY_VERSION_CONFLICT");
      if (source.story.status !== "complete")
        failAuthoring("STORY_STRUCTURE_INCOMPLETE");
      return this.duplicateCompletedWorkspace(scope, source, title);
    });
  }

  prepareCrossFamilyDuplicate(
    sourceScope: FamilyScope,
    projectId: string,
    targetScope: FamilyScope,
  ): CrossFamilyDuplicationDraft {
    const source = this.getProjectWorkspace(sourceScope, projectId);
    this.assertFamilyScope(targetScope);
    if (sourceScope.familyId === targetScope.familyId)
      failAuthoring("PROJECT_FAMILY_SCOPE_VIOLATION");
    if (source.story.status !== "complete")
      failAuthoring("STORY_STRUCTURE_INCOMPLETE");
    const content = extractPrivacySafeTemplate({
      name: "نسخة قصة تحتاج ربط الأدوار",
      participantCount: source.version.storyConfig.participants.length,
      sourceMarkers: sourcePrivacyMarkers(this.library, sourceScope, source),
    });
    return createCrossFamilyDraft(content);
  }

  updateScene(
    scope: FamilyScope,
    projectId: string,
    storyPageIndex: number,
    command: {
      expectedStoryVersionId: string;
      expectedSceneVersionId: string;
      content: SceneContent;
    },
  ): ProjectWorkspace {
    const content = sceneContentSchema.parse(command.content);
    return this.store.transaction(() =>
      this.updateSceneInTransaction(
        scope,
        projectId,
        storyPageIndex,
        command,
        content,
      ),
    );
  }

  preflightPageCountChange(
    scope: FamilyScope,
    projectId: string,
    to: PageCount,
  ): PageCountPlan {
    const workspace = this.getProjectWorkspace(scope, projectId);
    return createPageCountPlan({
      projectId,
      expectedProjectVersionId: workspace.version.id,
      expectedStoryVersionId: workspace.storyVersion.id,
      from: workspace.version.storyConfig.pageCount,
      to,
      sourceSceneVersionIds: workspace.scenes.map(({ version }) => version.id),
    });
  }

  confirmPageCountChange(
    scope: FamilyScope,
    projectId: string,
    plan: PageCountPlan,
  ): ProjectWorkspace {
    assertPageCountPlanIntegrity(plan);
    return this.store.transaction(() =>
      this.confirmPageCountInTransaction(scope, projectId, plan),
    );
  }

  listTemplates(options: { includeHidden?: boolean } = {}): TemplateRecord[] {
    return this.templates.list(options);
  }

  getTemplate(templateId: string, versionId?: string): TemplateRecord {
    return versionId
      ? this.templates.getVersion(templateId, versionId)
      : this.templates.get(templateId);
  }

  createTemplate(
    content: TemplateRecord["version"]["content"],
  ): TemplateRecord {
    return this.templates.create(content);
  }

  updateTemplate(
    templateId: string,
    input: {
      expectedVersionId: string;
      content: TemplateRecord["version"]["content"];
    },
  ): TemplateRecord {
    return this.templates.appendVersion(templateId, input);
  }

  duplicateTemplate(templateId: string): TemplateRecord {
    return this.templates.duplicate(templateId);
  }

  setTemplateStatus(
    templateId: string,
    input: {
      expectedVersionId: string;
      expectedStatus: TemplateStatus;
      status: TemplateStatus;
    },
  ): TemplateRecord {
    return this.templates.setStatus(templateId, input);
  }

  private appendOverrideInTransaction(
    scope: FamilyScope,
    projectId: string,
    command: {
      expectedProjectVersionId: string;
      expectedOverrideVersionId?: string;
      characterId: string;
      clothing: string;
      appearanceOverrides: Record<string, string>;
    },
  ): ProjectOverrideResult {
    const project = this.scopedProject(scope, projectId);
    this.assertProjectHead(project, command.expectedProjectVersionId);
    const current = this.currentProjectVersion(project);
    const participant = current.storyConfig.participants.find(
      (item) => item.characterId === command.characterId,
    );
    if (!participant) failAuthoring("MENTION_CHARACTER_NOT_IN_PROJECT");
    const existing = this.overrideFor(project.id, participant);
    const at = this.now();
    const overrideVersion = this.insertOverrideVersion(
      participant,
      existing,
      command,
      at,
    );
    const override = this.upsertOverride(
      project,
      participant,
      existing,
      overrideVersion,
      at,
    );
    const projectVersion = this.pinOverride(
      project,
      current,
      participant,
      override,
      overrideVersion,
      at,
    );
    const event = this.insertOverrideEvent(
      existing?.currentVersionId ?? null,
      override,
      overrideVersion,
      at,
    );
    return { override, overrideVersion, projectVersion, event };
  }

  private updateSceneInTransaction(
    scope: FamilyScope,
    projectId: string,
    storyPageIndex: number,
    command: {
      expectedStoryVersionId: string;
      expectedSceneVersionId: string;
    },
    content: SceneContent,
  ): ProjectWorkspace {
    const workspace = this.getProjectWorkspace(scope, projectId);
    if (workspace.storyVersion.id !== command.expectedStoryVersionId)
      failAuthoring("STORY_VERSION_CONFLICT");
    const target = workspace.scenes.find(
      ({ scene }) => scene.storyPageIndex === storyPageIndex,
    );
    if (!target) failAuthoring("SCENE_NOT_FOUND");
    if (target.version.id !== command.expectedSceneVersionId)
      failAuthoring("SCENE_VERSION_CONFLICT");
    const at = this.now();
    const version = this.appendSceneVersion(workspace, target, content, at);
    const scene = this.repositories.scenes.update({
      ...target.scene,
      currentVersionId: version.id,
      updatedAt: at,
    });
    const scenes = workspace.scenes.map((record) =>
      record.scene.id === scene.id ? { scene, version } : record,
    );
    const storyVersion = this.appendStoryVersion(workspace, scenes, at);
    this.emitSceneContentChange(target, scene, version, at);
    const project =
      this.repositories.projects.get(workspace.project.id) ?? workspace.project;
    return this.workspaceFrom(
      project,
      workspace.version,
      { ...workspace.story, currentVersionId: storyVersion.id },
      storyVersion,
    );
  }

  private confirmPageCountInTransaction(
    scope: FamilyScope,
    projectId: string,
    plan: PageCountPlan,
  ): ProjectWorkspace {
    const workspace = this.getProjectWorkspace(scope, projectId);
    this.assertFreshPageCountPlan(workspace, projectId, plan);
    const at = this.now();
    const scenes = this.createStructuralScenes(workspace, plan.operations, at);
    const config = this.configForPageCount(
      workspace.version.storyConfig,
      plan.input.to,
    );
    const projectVersion = this.insertProjectVersion(
      workspace.project.id,
      workspace.version.id,
      config,
      at,
    );
    const project = this.advanceProject(
      workspace.project,
      projectVersion.id,
      at,
    );
    const storyVersion = this.appendPageCountStoryVersion(
      workspace,
      scenes,
      plan,
      at,
    );
    this.emitPageCountChange(workspace, project, projectVersion, at);
    const refreshed = this.repositories.projects.get(project.id) ?? project;
    return this.workspaceFrom(
      refreshed,
      projectVersion,
      workspace.story,
      storyVersion,
    );
  }

  private emitProjectConfigChanges(
    project: Project,
    previous: ProjectVersion,
    next: ProjectVersion,
    at: string,
  ): void {
    const correlationId = this.idFactory();
    for (const event of projectConfigEvents(
      project,
      previous,
      next,
      correlationId,
      at,
    ))
      this.emitChange(event, at);
  }

  private emitSceneContentChange(
    previous: SceneRecord,
    scene: Scene,
    version: SceneVersion,
    at: string,
  ): void {
    this.emitChange(
      sceneContentChangeEvent(previous, scene, version, this.idFactory(), at),
      at,
    );
  }

  private emitPageCountChange(
    workspace: ProjectWorkspace,
    project: Project,
    version: ProjectVersion,
    at: string,
  ): void {
    this.emitChange(
      pageCountChangeEvent(workspace, project, version, this.idFactory(), at),
      at,
    );
  }

  private resolveCharacterRemovalInTransaction(
    scope: FamilyScope,
    projectId: string,
    command: {
      expectedProjectVersionId: string;
      expectedStoryVersionId: string;
      characterId: string;
      resolution: Exclude<CharacterRemovalResolution, { type: "cancel" }>;
    },
  ): ProjectWorkspace {
    const workspace = this.getProjectWorkspace(scope, projectId);
    this.assertProjectHead(workspace.project, command.expectedProjectVersionId);
    if (workspace.storyVersion.id !== command.expectedStoryVersionId)
      failAuthoring("STORY_VERSION_CONFLICT");
    this.removableParticipant(workspace, command.characterId);
    if (
      command.resolution.type === "replace" &&
      command.resolution.replacementCharacterId === command.characterId
    )
      failAuthoring("CHARACTER_REMOVAL_RESOLUTION_REQUIRED");
    const affectedSceneIds = new Set(
      this.preflightCharacterRemoval(scope, projectId, command.characterId)
        .affectedSceneIds,
    );
    const replacementId = this.replacementId(workspace, command.resolution);
    const at = this.now();
    const context = this.projectWithoutParticipant(
      workspace,
      command.characterId,
      at,
    );
    const scenes = workspace.scenes.map((scene) =>
      affectedSceneIds.has(scene.scene.id)
        ? this.rewriteRemovalScene(
            context,
            scene,
            command.characterId,
            replacementId,
            at,
          )
        : scene,
    );
    const storyVersion = this.appendStoryVersion(context, scenes, at);
    return this.workspaceFrom(
      context.project,
      context.version,
      workspace.story,
      storyVersion,
    );
  }

  private projectWithoutParticipant(
    workspace: ProjectWorkspace,
    characterId: string,
    at: string,
  ): ProjectWorkspace {
    const config = {
      ...workspace.version.storyConfig,
      participants: workspace.version.storyConfig.participants.filter(
        (participant) => participant.characterId !== characterId,
      ),
    };
    const version = this.insertProjectVersion(
      workspace.project.id,
      workspace.version.id,
      config,
      at,
    );
    const project = this.advanceProject(workspace.project, version.id, at);
    return { ...workspace, project, version };
  }

  private rewriteRemovalScene(
    workspace: ProjectWorkspace,
    record: SceneRecord,
    characterId: string,
    replacementId: string | null,
    at: string,
  ): SceneRecord {
    const content = rewriteCharacterReferences(
      record.version.content,
      characterId,
      replacementId,
    );
    if (content === record.version.content) return record;
    const version = this.appendSceneVersion(workspace, record, content, at);
    const scene = this.repositories.scenes.update({
      ...record.scene,
      currentVersionId: version.id,
      updatedAt: at,
    });
    return { scene, version };
  }

  private removableParticipant(
    workspace: ProjectWorkspace,
    characterId: string,
  ): ProjectParticipant {
    if (characterId === workspace.version.storyConfig.mainChildId)
      failAuthoring("PROJECT_MAIN_CHILD_INVALID");
    const participant = workspace.version.storyConfig.participants.find(
      (item) => item.characterId === characterId,
    );
    if (!participant) failAuthoring("MENTION_CHARACTER_NOT_IN_PROJECT");
    return participant;
  }

  private replacementId(
    workspace: ProjectWorkspace,
    resolution: Exclude<CharacterRemovalResolution, { type: "cancel" }>,
  ): string | null {
    if (resolution.type === "remove_mentions") return null;
    if (
      !workspace.version.storyConfig.participants.some(
        ({ characterId }) => characterId === resolution.replacementCharacterId,
      )
    )
      failAuthoring("MENTION_CHARACTER_NOT_IN_PROJECT");
    return resolution.replacementCharacterId;
  }

  private buildConfig(
    scope: FamilyScope,
    input: ParsedProjectInput,
    previous: StoryConfig | null,
  ): StoryConfig {
    const { templateSeedKey, selectedNarrationPercent, ...persisted } = input;
    void templateSeedKey;
    const participants = this.resolveParticipants(scope, input, previous);
    const template = resolveProjectTemplate(this.templates, input, previous);
    const balance = calculateNarrationBalance(
      input,
      selectedNarrationPercent === null
        ? undefined
        : {
            selectedNarrationPercent,
            operatorEdited: true,
          },
    );
    return {
      ...persisted,
      participants,
      templateId: template?.template.id ?? null,
      templateVersionId: template?.version.id ?? null,
      narrationDialogueBalance: balance,
    };
  }

  private resolveParticipants(
    scope: FamilyScope,
    input: ParsedProjectInput,
    previous: StoryConfig | null,
  ): ProjectParticipant[] {
    const characters = activeProjectCharacters(
      this.library,
      scope,
      input.participants.map(({ characterId }) => characterId),
      (error) => this.rethrowScope(error, "PROJECT_FAMILY_SCOPE_VIOLATION"),
    );
    const byId = new Map(
      characters.map((character) => [character.id, character]),
    );
    const prior = new Map(
      previous?.participants.map((item) => [item.characterId, item]) ?? [],
    );
    const participants = input.participants.map((item) => {
      const character = byId.get(item.characterId)!;
      const existing = prior.get(item.characterId);
      return {
        characterId: character.id,
        characterVersionId:
          existing?.characterVersionId ?? character.currentVersionId,
        narrativeRole: item.narrativeRole,
        appearance: this.resolveAppearance(
          scope,
          character.id,
          item.appearance,
          existing,
        ),
      };
    });
    assertProjectMainChild(
      this.library,
      scope,
      input.mainChildId,
      participants,
    );
    return participants;
  }

  private resolveAppearance(
    scope: FamilyScope,
    characterId: string,
    input: ParsedProjectInput["participants"][number]["appearance"],
    previous?: ProjectParticipant,
  ): AppearanceSelection {
    if (!input) return previous?.appearance ?? { type: "base" };
    if (input.type === "base") return input;
    if (
      previous?.appearance.type === "shared_look" &&
      previous.appearance.lookId === input.lookId
    )
      return previous.appearance;
    try {
      const look = this.library.getLook(scope, characterId, input.lookId);
      if (look.status !== "active") failAuthoring("MENTION_LOOK_NOT_OWNED");
      return {
        type: "shared_look",
        lookId: look.id,
        lookVersionId: look.currentVersionId,
      };
    } catch (error) {
      this.rethrowScope(error, "MENTION_LOOK_NOT_OWNED");
    }
  }
}

import type { FamilyScope } from "../library/index.js";
import { AuthoringServiceBase } from "./authoring-service-base.js";
import { failAuthoring } from "./errors.js";
import { sceneContentSchema, type SceneContent } from "./schemas.js";
import type { ProjectWorkspace, SceneRecord } from "./project-service.js";

export interface GeneratedSceneInput {
  storyPageIndex: number;
  content: SceneContent;
}

export interface GeneratedStoryCommand {
  expectedProjectVersionId: string;
  expectedStoryVersionId: string;
  planJson: unknown;
  scenes: GeneratedSceneInput[];
}

export abstract class GeneratedStoryServiceBase extends AuthoringServiceBase {
  appendGeneratedStory(
    scope: FamilyScope,
    projectId: string,
    command: GeneratedStoryCommand,
  ): ProjectWorkspace {
    const scenes = command.scenes.map((scene) => ({
      storyPageIndex: scene.storyPageIndex,
      content: sceneContentSchema.parse(scene.content),
    }));
    return this.store.transaction(() =>
      this.appendGeneratedStoryInTransaction(scope, projectId, command, scenes),
    );
  }

  private appendGeneratedStoryInTransaction(
    scope: FamilyScope,
    projectId: string,
    command: GeneratedStoryCommand,
    generated: GeneratedSceneInput[],
  ): ProjectWorkspace {
    const workspace = this.workspace(this.scopedProject(scope, projectId));
    this.assertGeneratedStoryHeads(workspace, command, generated);
    const at = this.now();
    const scenes = workspace.scenes.map((record, index) =>
      this.appendGeneratedScene(
        workspace,
        record,
        generated[index].content,
        at,
      ),
    );
    const storyVersion = this.appendGeneratedStoryVersion(
      workspace,
      scenes,
      command.planJson,
      at,
    );
    this.emitChange(
      {
        entity: "story",
        entityId: workspace.story.id,
        fromVersionId: workspace.storyVersion.id,
        toVersionId: storyVersion.id,
        changeType: "story_regeneration",
        matrixRow: "IM-08",
        changedFields: ["planJson", "sceneVersionIds"],
        correlationId: this.idFactory(),
        occurredAt: at,
      },
      at,
    );
    const project =
      this.repositories.projects.get(workspace.project.id) ?? workspace.project;
    return this.workspaceFrom(
      project,
      workspace.version,
      {
        ...workspace.story,
        status: "complete",
        currentVersionId: storyVersion.id,
      },
      storyVersion,
    );
  }

  private assertGeneratedStoryHeads(
    workspace: ProjectWorkspace,
    command: GeneratedStoryCommand,
    scenes: GeneratedSceneInput[],
  ): void {
    this.assertProjectHead(workspace.project, command.expectedProjectVersionId);
    if (workspace.storyVersion.id !== command.expectedStoryVersionId)
      failAuthoring("STORY_VERSION_CONFLICT");
    if (
      scenes.length !== workspace.scenes.length ||
      scenes.some((scene, index) => scene.storyPageIndex !== index + 1)
    )
      failAuthoring("STORY_STRUCTURE_INCOMPLETE");
  }

  private appendGeneratedScene(
    workspace: ProjectWorkspace,
    record: SceneRecord,
    content: SceneContent,
    at: string,
  ): SceneRecord {
    const version = this.appendSceneVersion(workspace, record, content, at);
    if (version.needsAuthoring) failAuthoring("STORY_STRUCTURE_INCOMPLETE");
    const scene = this.repositories.scenes.update({
      ...record.scene,
      currentVersionId: version.id,
      updatedAt: at,
    });
    return { scene, version };
  }
}

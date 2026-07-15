import type { AppendChangeEventInput } from "../creative/invalidation.js";
import type {
  Project,
  ProjectVersion,
  Scene,
  SceneVersion,
  StoryConfig,
} from "./schemas.js";
import type { ProjectWorkspace, SceneRecord } from "./project-types.js";

type AuthoringChange = Omit<AppendChangeEventInput, "id">;

export function projectConfigEvents(
  project: Project,
  previous: ProjectVersion,
  next: ProjectVersion,
  correlationId: string,
  occurredAt: string,
): AuthoringChange[] {
  const events: AuthoringChange[] = [];
  const visibleFields = visibleBookConfigChanges(
    previous.storyConfig,
    next.storyConfig,
  );
  if (visibleFields.length)
    events.push(
      projectConfigEvent(
        project,
        previous,
        next,
        correlationId,
        occurredAt,
        "book_content",
        "IM-12",
        visibleFields,
      ),
    );
  if (
    previous.storyConfig.illustrationStyleId !==
    next.storyConfig.illustrationStyleId
  )
    events.push(
      projectConfigEvent(
        project,
        previous,
        next,
        correlationId,
        occurredAt,
        "project_style",
        "IM-13",
        ["illustrationStyleId"],
      ),
    );
  return events;
}

export function sceneContentChangeEvent(
  previous: SceneRecord,
  scene: Scene,
  version: SceneVersion,
  correlationId: string,
  occurredAt: string,
): AuthoringChange {
  return {
    entity: "scene",
    entityId: scene.id,
    fromVersionId: previous.version.id,
    toVersionId: version.id,
    changeType: "scene_content",
    matrixRow: "IM-06",
    changedFields: ["content"],
    correlationId,
    occurredAt,
  };
}

export function pageCountChangeEvent(
  workspace: ProjectWorkspace,
  project: Project,
  version: ProjectVersion,
  correlationId: string,
  occurredAt: string,
): AuthoringChange {
  return {
    entity: "page_count",
    entityId: project.id,
    fromVersionId: workspace.version.id,
    toVersionId: version.id,
    changeType: "page_count",
    matrixRow: "IM-09",
    changedFields: ["pageCount", "pageMap"],
    correlationId,
    occurredAt,
  };
}

function visibleBookConfigChanges(
  previous: StoryConfig,
  next: StoryConfig,
): string[] {
  const changed: string[] = [];
  if (previous.title !== next.title) changed.push("title");
  if (previous.dedicationText !== next.dedicationText)
    changed.push("dedicationText");
  if (JSON.stringify(previous.endingPages) !== JSON.stringify(next.endingPages))
    changed.push("endingPages");
  return changed;
}

function projectConfigEvent(
  project: Project,
  previous: ProjectVersion,
  next: ProjectVersion,
  correlationId: string,
  occurredAt: string,
  changeType: "book_content" | "project_style",
  matrixRow: "IM-12" | "IM-13",
  changedFields: string[],
): AuthoringChange {
  return {
    entity: changeType,
    entityId: project.id,
    fromVersionId: previous.id,
    toVersionId: next.id,
    changeType,
    matrixRow,
    changedFields,
    correlationId,
    occurredAt,
  };
}

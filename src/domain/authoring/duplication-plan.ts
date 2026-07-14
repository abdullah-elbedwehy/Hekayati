import type { ProjectWorkspace } from "./project-service.js";

export function sameFamilyDuplicatePlan(source: ProjectWorkspace) {
  return {
    type: "same_family_duplicate",
    sourceProjectId: source.project.id,
    sourceProjectVersionId: source.version.id,
    sourceStoryVersionId: source.storyVersion.id,
  };
}

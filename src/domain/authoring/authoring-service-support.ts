import type { LibraryService } from "../library/index.js";
import type { CompileParticipant } from "./mentions.js";
import type { ProjectWorkspace } from "./project-types.js";
import type { SceneContent } from "./schemas.js";
import type { TemplateServiceOptions } from "./template-service.js";

export type AuthoringServiceOptions = TemplateServiceOptions & {
  changeEventMode?: "persist" | "suppress";
};

export function baseDocument(id: string, at: string) {
  return { id, schemaVersion: 1 as const, createdAt: at, updatedAt: at };
}

export function blankSceneContent(): SceneContent {
  return {
    purpose: "",
    description: "",
    documentSegments: [],
    environment: "",
    timeOfDay: "",
    composition: "",
    cameraFraming: "",
    narrativeText: "",
    dialogue: [],
    twoImageMoment: false,
  };
}

export function requiredSceneText(content: SceneContent): boolean {
  return [
    content.purpose,
    content.description,
    content.environment,
    content.timeOfDay,
    content.composition,
    content.cameraFraming,
    content.narrativeText,
  ].every((value) => value.trim().length > 0);
}

export function compileWorkspaceParticipants(
  library: LibraryService,
  workspace: ProjectWorkspace,
): CompileParticipant[] {
  const scope = {
    customerId: workspace.project.customerId,
    familyId: workspace.project.familyId,
  };
  return workspace.version.storyConfig.participants.map((participant) => {
    const version = library.getCharacterVersion(
      scope,
      participant.characterId,
      participant.characterVersionId,
    );
    return {
      ...participant,
      relationshipType: version.profile.relationship.type,
      ownedLookIds: library
        .listLooks(scope, participant.characterId, { includeArchived: true })
        .map(({ id }) => id),
    };
  });
}

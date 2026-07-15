import type { FamilyScope, LibraryService } from "../library/index.js";
import { failAuthoring } from "./errors.js";
import type { ProjectParticipant } from "./schemas.js";

export function activeProjectCharacters(
  library: LibraryService,
  scope: FamilyScope,
  characterIds: string[],
  onScopeError: (error: unknown) => never,
) {
  try {
    return library.assertCharacterSelection(scope, characterIds);
  } catch (error) {
    return onScopeError(error);
  }
}

export function assertProjectMainChild(
  library: LibraryService,
  scope: FamilyScope,
  mainChildId: string,
  participants: ProjectParticipant[],
): void {
  const selected = participants.find(
    (item) => item.characterId === mainChildId,
  );
  if (!selected) failAuthoring("PROJECT_MAIN_CHILD_INVALID");
  const version = library.getCharacterVersion(
    scope,
    selected.characterId,
    selected.characterVersionId,
  );
  if (version.profile.relationship.type === "pet")
    failAuthoring("PROJECT_MAIN_CHILD_INVALID");
}

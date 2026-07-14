import type { Relationship } from "../library/index.js";
import type { SceneContent } from "./schemas.js";

type RelationshipType = Relationship["type"];

export function sceneReferencesCharacter(
  content: SceneContent,
  characterId: string,
  relationshipType: RelationshipType,
  isMainChild: boolean,
): boolean {
  if (
    content.documentSegments.some(
      (segment) =>
        (segment.type === "mention" && segment.characterId === characterId) ||
        (segment.type === "group" &&
          groupIncludes(segment.groupKey, relationshipType, isMainChild)),
    )
  )
    return true;
  return content.dialogue.some(
    (dialogue) => dialogue.speakerCharacterId === characterId,
  );
}

export function rewriteCharacterReferences(
  content: SceneContent,
  characterId: string,
  replacementCharacterId: string | null,
): SceneContent {
  const documentSegments = content.documentSegments.flatMap((segment) => {
    if (segment.type !== "mention" || segment.characterId !== characterId)
      return [segment];
    return replacementCharacterId
      ? [{ ...segment, characterId: replacementCharacterId }]
      : [];
  });
  const dialogue = content.dialogue.flatMap((item) => {
    if (item.speakerCharacterId !== characterId) return [item];
    return replacementCharacterId
      ? [{ ...item, speakerCharacterId: replacementCharacterId }]
      : [];
  });
  return { ...content, documentSegments, dialogue };
}

function groupIncludes(
  groupKey: "hero" | "friends" | "family",
  relationshipType: RelationshipType,
  isMainChild: boolean,
): boolean {
  if (groupKey === "hero") return isMainChild;
  if (groupKey === "friends") return relationshipType === "friend";
  return [
    "main_child",
    "father",
    "mother",
    "brother",
    "sister",
    "grandfather",
    "grandmother",
  ].includes(relationshipType);
}

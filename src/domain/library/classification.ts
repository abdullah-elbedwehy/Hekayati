import { isDeepStrictEqual } from "node:util";

import type { CharacterProfile, LookContent } from "./schemas.js";

export interface ClassifiedChange {
  matrixRow: "IM-01" | "IM-02" | "IM-03" | "IM-05";
  changeType:
    "permanent_appearance" | "non_visual_profile" | "shared_look" | "rename";
  changedFields: string[];
}

const profileFieldOrder: Array<keyof CharacterProfile> = [
  "name",
  "nickname",
  "relationship",
  "appearanceDescription",
  "ageOrRange",
  "gender",
  "skinTone",
  "hair",
  "eyeColor",
  "relativeHeight",
  "build",
  "distinguishingFeatures",
  "glasses",
  "hijab",
  "accessories",
  "interests",
  "favoriteObjects",
  "favoriteColor",
  "personalityTraits",
  "speakingStyle",
  "notes",
  "sourceMode",
  "referencePhotoIds",
  "traits",
];

const appearanceFields = new Set<keyof CharacterProfile>([
  "appearanceDescription",
  "sourceMode",
  "ageOrRange",
  "gender",
  "skinTone",
  "hair",
  "eyeColor",
  "relativeHeight",
  "build",
  "distinguishingFeatures",
  "glasses",
  "hijab",
  "accessories",
  "referencePhotoIds",
  "notes",
  "traits",
]);

const narrativeFields = new Set<keyof CharacterProfile>([
  "ageOrRange",
  "gender",
  "relationship",
  "interests",
  "favoriteObjects",
  "favoriteColor",
  "personalityTraits",
  "speakingStyle",
  "notes",
  "traits",
]);

const renameFields = new Set<keyof CharacterProfile>(["name", "nickname"]);

export function classifyCharacterChange(
  previous: CharacterProfile,
  next: CharacterProfile,
): ClassifiedChange[] {
  const changed = profileFieldOrder.filter(
    (field) => !isDeepStrictEqual(previous[field], next[field]),
  );
  return [
    classified(changed, appearanceFields, "IM-01", "permanent_appearance"),
    classified(changed, narrativeFields, "IM-02", "non_visual_profile"),
    classified(changed, renameFields, "IM-05", "rename"),
  ].filter((change): change is ClassifiedChange => change !== null);
}

export function classifyLookChange(
  previous: LookContent,
  next: LookContent,
): ClassifiedChange[] {
  const fieldOrder: Array<keyof LookContent> = [
    "name",
    "clothing",
    "appearanceOverrides",
    "referencePhotoIds",
  ];
  const changedFields = fieldOrder.filter(
    (field) => !isDeepStrictEqual(previous[field], next[field]),
  );
  return changedFields.length === 0
    ? []
    : [
        {
          matrixRow: "IM-03",
          changeType: "shared_look",
          changedFields,
        },
      ];
}

function classified(
  changed: Array<keyof CharacterProfile>,
  fields: Set<keyof CharacterProfile>,
  matrixRow: ClassifiedChange["matrixRow"],
  changeType: ClassifiedChange["changeType"],
): ClassifiedChange | null {
  const changedFields = changed.filter((field) => fields.has(field));
  return changedFields.length === 0
    ? null
    : { matrixRow, changeType, changedFields };
}

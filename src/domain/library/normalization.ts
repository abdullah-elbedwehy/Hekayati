import type { Relationship } from "./schemas.js";

const arabicTashkeel = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/gu;
const latinRuns = /\p{Script=Latin}+/gu;

/** C-19 exact normalization; deliberately contains no fuzzy or biometric step. */
export function normalizeDuplicateDisplayName(value: string): string {
  return value
    .trim()
    .replace(/\s+/gu, " ")
    .normalize("NFC")
    .replace(arabicTashkeel, "")
    .replace(latinRuns, (run) => run.toLocaleLowerCase("und"));
}

export function relationshipKey(relationship: Relationship): string {
  return relationship.type === "custom"
    ? `custom:${normalizeDuplicateDisplayName(relationship.customLabel)}`
    : relationship.type;
}

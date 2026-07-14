import { createHash } from "node:crypto";

import { z } from "zod";

import { styleConfig, styleIdSchema, type StyleId } from "./prompt-styles.js";

export const PROMPT_POLICY_VERSION = "prompt-policy-v1";

export const promptPolicyCategorySchema = z.enum([
  "franchise_trademark",
  "living_artist",
]);

export type PromptPolicyCategory = z.infer<typeof promptPolicyCategorySchema>;

const deniedTerms: ReadonlyArray<{
  phrase: string;
  category: PromptPolicyCategory;
}> = [
  { phrase: "hayao miyazaki", category: "living_artist" },
  { phrase: "miyazaki", category: "living_artist" },
  { phrase: "disney", category: "franchise_trademark" },
  { phrase: "pixar", category: "franchise_trademark" },
  { phrase: "studio ghibli", category: "franchise_trademark" },
  { phrase: "marvel", category: "franchise_trademark" },
  { phrase: "spider-man", category: "franchise_trademark" },
  { phrase: "spiderman", category: "franchise_trademark" },
  { phrase: "ديزني", category: "franchise_trademark" },
  { phrase: "بيكسار", category: "franchise_trademark" },
  { phrase: "مارفل", category: "franchise_trademark" },
  { phrase: "سبايدر مان", category: "franchise_trademark" },
  { phrase: "ستوديو غيبلي", category: "franchise_trademark" },
  { phrase: "ميازاكي", category: "living_artist" },
  { phrase: "غريغ روتكوفسكي", category: "living_artist" },
  { phrase: "greg rutkowski", category: "living_artist" },
];

export type PromptPolicyCheck =
  | {
      status: "allowed";
      policyVersion: typeof PROMPT_POLICY_VERSION;
      originalPrompt: string;
    }
  | {
      status: "confirmation_required";
      policyVersion: typeof PROMPT_POLICY_VERSION;
      originalPrompt: string;
      alternativePrompt: string;
      matchedCategories: PromptPolicyCategory[];
      matchedTerms: string[];
      bindingHash: string;
    };

export interface PromptPolicyConfirmation {
  policyVersion: typeof PROMPT_POLICY_VERSION;
  bindingHash: string;
  confirmed: true;
}

export function checkPromptPolicy(
  prompt: string,
  styleId: StyleId,
): PromptPolicyCheck {
  const originalPrompt = z.string().trim().min(1).max(12_000).parse(prompt);
  const style = styleConfig(styleIdSchema.parse(styleId));
  const normalized = normalizePolicyText(originalPrompt);
  const matches = deniedTerms.filter((item) =>
    normalized.includes(item.phrase),
  );
  if (matches.length === 0) {
    return {
      status: "allowed",
      policyVersion: PROMPT_POLICY_VERSION,
      originalPrompt,
    };
  }
  const matchedCategories = uniqueSorted(matches.map((item) => item.category));
  const matchedTerms = uniqueSorted(matches.map((item) => item.phrase));
  const alternativePrompt = [
    "استخدم معالجة بصرية أصلية خاصة بحكايتي.",
    style.directive,
    style.palette,
    style.composition,
  ].join(" ");
  return {
    status: "confirmation_required",
    policyVersion: PROMPT_POLICY_VERSION,
    originalPrompt,
    alternativePrompt,
    matchedCategories,
    matchedTerms,
    bindingHash: bindingHash({
      originalPrompt,
      alternativePrompt,
      matchedCategories,
      matchedTerms,
    }),
  };
}

export function confirmPromptPolicy(
  check: Extract<PromptPolicyCheck, { status: "confirmation_required" }>,
): PromptPolicyConfirmation {
  return {
    policyVersion: PROMPT_POLICY_VERSION,
    bindingHash: check.bindingHash,
    confirmed: true,
  };
}

export function confirmationMatches(
  check: Extract<PromptPolicyCheck, { status: "confirmation_required" }>,
  confirmation: PromptPolicyConfirmation | undefined,
): boolean {
  return (
    confirmation?.confirmed === true &&
    confirmation.policyVersion === check.policyVersion &&
    confirmation.bindingHash === check.bindingHash
  );
}

export function transformConfirmedPrompt(
  check: Extract<PromptPolicyCheck, { status: "confirmation_required" }>,
  confirmation: PromptPolicyConfirmation | undefined,
): string {
  if (!confirmationMatches(check, confirmation))
    throw new Error("PROMPT_CONFIRMATION_STALE");
  return replaceDeniedTerms(check);
}

export function transformPolicyTerms(prompt: string, styleId: StyleId): string {
  const check = checkPromptPolicy(prompt, styleId);
  return check.status === "allowed"
    ? check.originalPrompt
    : replaceDeniedTerms(check);
}

function replaceDeniedTerms(
  check: Extract<PromptPolicyCheck, { status: "confirmation_required" }>,
): string {
  let transformed = check.originalPrompt;
  for (const term of check.matchedTerms) {
    const category = deniedTerms.find((item) => item.phrase === term)?.category;
    const replacement =
      category === "living_artist"
        ? "أسلوب رسوم أصلي دافئ"
        : "شخصية خيالية أصلية";
    transformed = transformed.replace(
      new RegExp(escapeRegExp(term), "giu"),
      replacement,
    );
  }
  return transformed;
}

export function normalizePolicyText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .toLocaleLowerCase("en-US")
    .trim()
    .replace(/\s+/g, " ");
}

function bindingHash(value: {
  originalPrompt: string;
  alternativePrompt: string;
  matchedCategories: PromptPolicyCategory[];
  matchedTerms: string[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify({ policyVersion: PROMPT_POLICY_VERSION, ...value }))
    .digest("hex");
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

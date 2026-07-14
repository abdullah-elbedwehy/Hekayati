import { createHash } from "node:crypto";

import { failAuthoring } from "./errors.js";
import type { PageCount } from "./schemas.js";

export type BookPage =
  | { pageNumber: number; kind: "title" | "dedication" | "farewell" | "brand" }
  | { pageNumber: number; kind: "story"; storyPageIndex: number };

export interface PageCountPlanInput {
  projectId: string;
  expectedProjectVersionId: string;
  expectedStoryVersionId: string;
  from: PageCount;
  to: PageCount;
  sourceSceneVersionIds: string[];
}

export interface PageCountOperation {
  type: "retain" | "add" | "merge" | "remove";
  targetStoryPageIndex: number | null;
  sourceSceneVersionIds: string[];
}

export interface PageCountPlan {
  input: PageCountPlanInput;
  operations: PageCountOperation[];
  hash: string;
}

export function storySlotCount(pageCount: PageCount): 12 | 20 {
  return pageCount === 16 ? 12 : 20;
}

export function getBookPageMap(pageCount: PageCount): BookPage[] {
  const storySlots = storySlotCount(pageCount);
  const pages: BookPage[] = [
    { pageNumber: 1, kind: "title" },
    { pageNumber: 2, kind: "dedication" },
  ];
  for (let index = 1; index <= storySlots; index += 1) {
    pages.push({ pageNumber: index + 2, kind: "story", storyPageIndex: index });
  }
  pages.push(
    { pageNumber: pageCount - 1, kind: "farewell" },
    { pageNumber: pageCount, kind: "brand" },
  );
  return pages;
}

export function createPageCountPlan(input: PageCountPlanInput): PageCountPlan {
  assertPlanInput(input);
  const targetSlots = storySlotCount(input.to);
  const groups = groupSourcesByTarget(input.sourceSceneVersionIds, targetSlots);
  const operations = Array.from({ length: targetSlots }, (_, offset) =>
    operationForTarget(offset + 1, groups.get(offset + 1) ?? []),
  );
  const normalizedInput = {
    ...input,
    sourceSceneVersionIds: [...input.sourceSceneVersionIds],
  };
  return {
    input: normalizedInput,
    operations,
    hash: planHash(normalizedInput, operations),
  };
}

export function assertPageCountPlanIntegrity(plan: PageCountPlan): void {
  const rebuilt = createPageCountPlan(plan.input);
  if (
    rebuilt.hash !== plan.hash ||
    canonicalJson(rebuilt.operations) !== canonicalJson(plan.operations)
  ) {
    failAuthoring("PAGE_COUNT_PREFLIGHT_STALE");
  }
}

export function pageCountPlanHash(
  input: PageCountPlanInput,
  operations: PageCountOperation[],
): string {
  return planHash(input, operations);
}

function assertPlanInput(input: PageCountPlanInput): void {
  if (input.from === input.to) failAuthoring("PAGE_COUNT_PREFLIGHT_REQUIRED");
  if (input.sourceSceneVersionIds.length !== storySlotCount(input.from))
    failAuthoring("STORY_STRUCTURE_INCOMPLETE");
  if (
    new Set(input.sourceSceneVersionIds).size !==
    input.sourceSceneVersionIds.length
  )
    failAuthoring("PAGE_COUNT_PREFLIGHT_STALE");
}

function groupSourcesByTarget(
  sourceIds: string[],
  targetSlots: number,
): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  const sourceSlots = sourceIds.length;
  sourceIds.forEach((sourceId, offset) => {
    const target =
      1 + Math.round((offset * (targetSlots - 1)) / (sourceSlots - 1));
    groups.set(target, [...(groups.get(target) ?? []), sourceId]);
  });
  return groups;
}

function operationForTarget(
  targetStoryPageIndex: number,
  sourceSceneVersionIds: string[],
): PageCountOperation {
  if (sourceSceneVersionIds.length === 0) {
    return {
      type: "add",
      targetStoryPageIndex,
      sourceSceneVersionIds: [],
    };
  }
  return {
    type: sourceSceneVersionIds.length === 1 ? "retain" : "merge",
    targetStoryPageIndex,
    sourceSceneVersionIds: [...sourceSceneVersionIds],
  };
}

function planHash(
  input: PageCountPlanInput,
  operations: PageCountOperation[],
): string {
  return createHash("sha256")
    .update(canonicalJson({ input, operations }))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]),
  );
}

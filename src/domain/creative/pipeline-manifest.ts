import type { CharacterSheet } from "./schemas.js";
import type { CreativeRun } from "./schemas.js";

type RunNode = CreativeRun["nodes"][number];

export function createRunNodes(
  approvedSheets: readonly CharacterSheet[],
  storyPageCount: number,
): RunNode[] {
  const approvalNodes = approvedSheets.map((sheet, index) =>
    node(
      `character_approval_${index + 1}`,
      "character_approval",
      [],
      null,
      `approved-sheet-${sheet.id}`,
      null,
      "committed",
    ),
  );
  const approvalKeys = approvalNodes.map((item) => item.key);
  const storyNodes = createStoryNodes(approvalKeys);
  const pageNodes = createPageNodes(storyNodes.sceneList, storyPageCount);
  const review = node(
    "review_findings",
    "review_findings",
    pageNodes.illustrations.map((item) => item.key),
    null,
    "review-findings-v1",
  );
  const gate = node(
    "internal_review",
    "internal_review",
    [review.key],
    null,
    "internal-review-v1",
  );
  return [
    ...approvalNodes,
    storyNodes.storyPlan,
    storyNodes.storyText,
    storyNodes.sceneList,
    ...pageNodes.prompts,
    ...pageNodes.illustrations,
    review,
    gate,
  ];
}

function createStoryNodes(approvalKeys: string[]) {
  const storyPlan = node(
    "story_plan",
    "story_plan",
    approvalKeys,
    null,
    "story-plan-v1",
  );
  const storyText = node(
    "story_text",
    "story_text",
    [storyPlan.key],
    null,
    "story-text-v1",
  );
  const sceneList = node(
    "scene_list",
    "scene_list",
    [storyText.key],
    null,
    "scene-list-v1",
  );
  return { storyPlan, storyText, sceneList };
}

function createPageNodes(sceneList: RunNode, storyPageCount: number) {
  const prompts = Array.from({ length: storyPageCount }, (_, index) =>
    node(
      pageNodeKey("page_prompt", index + 1),
      "page_prompt",
      [sceneList.key],
      index + 1,
      `page-prompt-${index + 1}-v1`,
    ),
  );
  const illustrations = Array.from({ length: storyPageCount }, (_, index) =>
    node(
      pageNodeKey("page_illustration", index + 1),
      "page_illustration",
      [prompts[index].key],
      index + 1,
      `page-illustration-${index + 1}-v1`,
    ),
  );
  return { prompts, illustrations };
}

export function pageNodeKey(
  kind: "page_prompt" | "page_illustration",
  pageNumber: number,
): string {
  return `${kind}_${String(pageNumber).padStart(2, "0")}`;
}

function node(
  key: string,
  kind: RunNode["kind"],
  dependsOnKeys: string[],
  pageNumber: number | null,
  intentId: string,
  jobId: string | null = null,
  state: RunNode["state"] = "planned",
): RunNode {
  return {
    key,
    kind,
    pageNumber,
    dependsOnKeys,
    intentId,
    jobId,
    state,
  };
}

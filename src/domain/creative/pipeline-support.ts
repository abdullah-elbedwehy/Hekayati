import { createHash } from "node:crypto";

import type { ProjectWorkspace } from "../authoring/index.js";
import type { FamilyScope } from "../library/index.js";
import type { JobTarget } from "../../jobs/schemas.js";
import {
  pagePromptSchema,
  reviewFindingsSchema,
  sceneListSchema,
  storyPlanSchema,
  storyTextSchema,
} from "../../contracts/creative-outputs.js";
import { canonicalJson } from "../../contracts/canonical-json.js";
import { failCreative } from "./errors.js";
import type { CreativeCapabilityLimitsReader } from "./generation-policy.js";
import type { buildStoryPlanTask } from "./generation-context.js";
import type { CreativeRun } from "./schemas.js";
import type { ReviewFindings } from "./output-types.js";

export interface CreativePipelineOptions {
  now?: () => string;
  idFactory?: () => string;
  capacityLimits?: CreativeCapabilityLimitsReader;
}

export interface PreviewWorkflowStarter {
  start(projectId: string): unknown;
}

export function parseStructuredStage(jobType: string, value: unknown) {
  if (jobType === "story_plan")
    return { kind: "story_plan" as const, value: storyPlanSchema.parse(value) };
  if (jobType === "story_text")
    return { kind: "story_text" as const, value: storyTextSchema.parse(value) };
  if (jobType === "scene_list")
    return { kind: "scene_list" as const, value: sceneListSchema.parse(value) };
  if (jobType === "page_prompt")
    return {
      kind: "page_prompt" as const,
      value: pagePromptSchema.parse(value),
    };
  if (jobType === "review_findings")
    return {
      kind: "review_findings" as const,
      value: reviewFindingsSchema.parse(value),
    };
  failCreative("CREATIVE_JOB_NOT_BOUND");
}

export function structuredJobRequest(
  task: ReturnType<typeof buildStoryPlanTask>,
) {
  return {
    kind: "structured" as const,
    request: {
      schemaId: task.schemaId,
      task,
      languageDirectives: task.languageDirectives,
    },
  };
}

export function requireNodeForJob(run: CreativeRun, jobId: string) {
  const node = run.nodes.find((item) => item.jobId === jobId);
  if (!node) failCreative("CREATIVE_JOB_NOT_BOUND");
  return node;
}

export function requireNodeByKey(nodes: CreativeRun["nodes"], key: string) {
  const node = nodes.find((item) => item.key === key);
  if (!node) failCreative("CREATIVE_JOB_NOT_BOUND");
  return node;
}

export function updateNode(
  nodes: CreativeRun["nodes"],
  key: string,
  patch: Partial<CreativeRun["nodes"][number]>,
) {
  let found = false;
  const updated = nodes.map((node) => {
    if (node.key !== key) return node;
    found = true;
    return { ...node, ...patch };
  });
  if (!found) failCreative("CREATIVE_JOB_NOT_BOUND");
  return updated;
}

export function pageSnapshot(page: {
  id: string;
  revision: number;
  currentTextVersionId: string | null;
  currentPromptVersionId: string | null;
}) {
  return {
    page: page.id,
    pageRevision: `r${page.revision}`,
    ...(page.currentTextVersionId
      ? { textVersion: page.currentTextVersionId }
      : {}),
    ...(page.currentPromptVersionId
      ? { promptVersion: page.currentPromptVersionId }
      : {}),
  };
}

export function versionSnapshot(snapshot: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([, value]) =>
      /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value),
    ),
  );
}

export function asTarget(
  target: CreativeRun["textTarget"] | CreativeRun["imageTarget"],
): JobTarget {
  return target;
}

export function scopeFor(workspace: ProjectWorkspace): FamilyScope {
  return {
    customerId: workspace.project.customerId,
    familyId: workspace.project.familyId,
  };
}

export function findingKey(
  finding: ReviewFindings["findings"][number],
): string {
  return createHash("sha256").update(canonicalJson(finding)).digest("hex");
}

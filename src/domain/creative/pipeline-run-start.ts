import type { ProjectWorkspace } from "../authoring/index.js";
import type { SettingsService } from "../settings/settings.js";
import type { JobScheduler } from "../../jobs/scheduler.js";
import type { JobRecord } from "../../jobs/schemas.js";
import type { GenerationTaskV1 } from "../../contracts/generation-task.js";
import type { CreativePolicyPlan } from "../../contracts/creative-policy.js";
import type { CreativePolicyConfirmations } from "./generation-policy.js";
import { failCreative } from "./errors.js";
import { createRunNodes } from "./pipeline-manifest.js";
import {
  asTarget,
  requireNodeByKey,
  structuredJobRequest,
} from "./pipeline-support.js";
import type { CreativeRepositories } from "./repositories.js";
import {
  creativeRunSchema,
  type CharacterSheet,
  type CreativeRun,
} from "./schemas.js";
import { selectedStructuredTarget } from "./targets.js";

interface RunStartContext {
  workspace: ProjectWorkspace;
  sheets: readonly CharacterSheet[];
  gateJobIds: string[];
  storyPlanJobId: string;
  priority: number;
  repositories: CreativeRepositories;
  settings: SettingsService;
  scheduler: JobScheduler;
  idFactory: () => string;
  now: () => string;
  storyPlanTask: GenerationTaskV1;
  imageTarget: CreativeRun["imageTarget"];
  policyPlan: CreativePolicyPlan;
}

export interface StartRunInput {
  expectedProjectVersionId: string;
  expectedStoryVersionId: string;
  priority?: number;
  confirmations?: CreativePolicyConfirmations;
}

export function assertRunStartVersions(
  workspace: ProjectWorkspace,
  input: StartRunInput,
): void {
  if (
    workspace.version.id !== input.expectedProjectVersionId ||
    workspace.storyVersion.id !== input.expectedStoryVersionId
  )
    failCreative("CREATIVE_VERSION_CONFLICT");
}

export function materializeCreativeRun(context: RunStartContext): {
  run: CreativeRun;
  firstJob: JobRecord;
} {
  const run = insertRun(context);
  const task = context.storyPlanTask;
  const firstJob = context.scheduler.enqueue({
    id: context.storyPlanJobId,
    jobType: "story_plan",
    projectId: run.projectId,
    standaloneScopeId: null,
    dependsOn: context.gateJobIds,
    priority: run.priority,
    intentId: requireNodeByKey(run.nodes, "story_plan").intentId,
    target: asTarget(run.textTarget),
    request: structuredJobRequest(task),
    inputSnapshot: { ...task.inputVersionRefs, run: run.id },
  });
  return { run, firstJob };
}

function insertRun(context: RunStartContext): CreativeRun {
  const textTarget = selectedStructuredTarget(context.settings);
  const imageTarget = context.imageTarget;
  const nodes = createRunNodes(context.sheets, context.workspace.scenes.length);
  context.sheets.forEach((_, index) => {
    nodes[index] = { ...nodes[index], jobId: context.gateJobIds[index] };
  });
  Object.assign(requireNodeByKey(nodes, "story_plan"), {
    jobId: context.storyPlanJobId,
    state: "materialized",
  });
  const at = context.now();
  return context.repositories.runs.insert(
    creativeRunSchema.parse({
      id: context.idFactory(),
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      revision: 0,
      projectId: context.workspace.project.id,
      projectVersionId: context.workspace.version.id,
      inputStoryVersionId: context.workspace.storyVersion.id,
      outputStoryVersionId: null,
      status: "generating",
      priority: context.priority,
      nodes,
      textTarget,
      imageTarget,
      textTargetHash: textTarget.settingsHash,
      imageTargetHash: imageTarget.settingsHash,
      policyPlan: context.policyPlan,
      internalReviewGateJobId: null,
    }),
  );
}

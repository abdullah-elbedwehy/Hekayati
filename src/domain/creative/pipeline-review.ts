import { failCreative } from "./errors.js";
import type { CreativeRepositories } from "./repositories.js";
import {
  findingAcknowledgementSchema,
  type CreativeRun,
  type FindingAcknowledgement,
} from "./schemas.js";
import type { CreativeStageStore } from "./pipeline-stages.js";
import { findingKey } from "./pipeline-support.js";

interface ReviewContext {
  repositories: CreativeRepositories;
  stages: CreativeStageStore;
  now: () => string;
  idFactory: () => string;
}

export interface AcknowledgeFindingInput {
  runId: string;
  expectedRunRevision: number;
  findingKey: string;
  note: string;
}

export function creativeFindingProjection(
  context: Pick<ReviewContext, "repositories" | "stages">,
  runId: string,
) {
  const output = context.stages.reviewFindings(runId);
  const acknowledgements = context.repositories.acknowledgements.queryByField(
    "runId",
    runId,
  );
  return output.findings.map((finding) => ({
    key: findingKey(finding),
    ...finding,
    acknowledged: acknowledgements.some(
      (item) => item.findingKey === findingKey(finding),
    ),
  }));
}

export function acknowledgeCreativeFinding(
  context: ReviewContext,
  input: AcknowledgeFindingInput,
): FindingAcknowledgement {
  if (!input.note.trim()) failCreative("CREATIVE_FINDINGS_BLOCK");
  const run = requireRun(context.repositories, input.runId);
  if (run.revision !== input.expectedRunRevision)
    failCreative("CREATIVE_REVISION_CONFLICT");
  if (run.status !== "internal_review")
    failCreative("CREATIVE_RUN_STATE_INVALID");
  const findings = creativeFindingProjection(context, input.runId);
  if (!findings.some((item) => item.key === input.findingKey))
    failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
  const existing = context.repositories.acknowledgements
    .queryByField("runId", input.runId)
    .find((item) => item.findingKey === input.findingKey);
  if (existing) return existing;
  const at = context.now();
  return context.repositories.acknowledgements.insert(
    findingAcknowledgementSchema.parse({
      id: context.idFactory(),
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      runId: input.runId,
      findingKey: input.findingKey,
      note: input.note,
      acknowledgedAt: at,
    }),
  );
}

function requireRun(
  repositories: CreativeRepositories,
  runId: string,
): CreativeRun {
  const run = repositories.runs.get(runId);
  if (!run) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
  return run;
}

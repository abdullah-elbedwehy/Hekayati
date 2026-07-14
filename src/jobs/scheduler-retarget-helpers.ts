import { JobError } from "./errors.js";
import { createRequestHash } from "./idempotency.js";
import type { JobRecord, JobTarget } from "./schemas.js";
import { sameJobTarget } from "./targets.js";
import type { EnqueueJobInput, RetargetPreview } from "./types.js";

export function retargetCandidates(
  jobs: readonly JobRecord[],
  targets: readonly NonNullable<JobRecord["target"]>[],
): RetargetPreview["affected"] {
  const byOperation = targetMap(targets);
  return jobs.flatMap((job) => {
    if (!job.target || !["queued", "blocked", "paused"].includes(job.state))
      return [];
    const target = byOperation.get(job.target.operation);
    if (!target || sameJobTarget(job.target, target)) return [];
    return [
      {
        id: job.id,
        revision: job.revision,
        state: job.state,
        projectId: job.projectId,
        standaloneScopeId: job.standaloneScopeId,
        fromTarget: job.target,
        toTarget: target,
      },
    ];
  });
}

function targetMap(
  targets: readonly JobTarget[],
): Map<JobTarget["operation"], JobTarget> {
  const result = new Map<JobTarget["operation"], JobTarget>();
  for (const target of targets) {
    if (result.has(target.operation))
      throw new JobError("JOB_TARGET_CHANGE_INVALID", 400);
    result.set(target.operation, target);
  }
  return result;
}

export function retargetImpactHash(
  targets: readonly NonNullable<JobRecord["target"]>[],
  affected: RetargetPreview["affected"],
): string {
  return createRequestHash({
    kind: "provider_target_change",
    targets: [...targets].sort((left, right) =>
      left.operation.localeCompare(right.operation),
    ),
    affected: [...affected]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((job) => ({
        id: job.id,
        revision: job.revision,
        state: job.state,
        fromTarget: job.fromTarget,
        toTarget: job.toTarget,
      })),
  });
}

export function retargetSuccessorInput(
  job: JobRecord,
  preview: RetargetPreview,
  ids: ReadonlyMap<string, string>,
): EnqueueJobInput {
  const entry = preview.affected.find((candidate) => candidate.id === job.id);
  if (!entry) throw new JobError("JOB_TARGET_CHANGE_ENTRY_MISSING");
  return {
    id: ids.get(job.id),
    jobType: job.jobType,
    projectId: job.projectId,
    standaloneScopeId: job.standaloneScopeId,
    dependsOn: job.dependsOn.map((id) => ids.get(id) ?? id),
    priority: job.priority,
    intentId: `settings-${preview.impactHash.slice(0, 12)}-${job.id}`,
    target: entry.toTarget,
    request: job.request,
    inputSnapshot: job.inputSnapshot,
    supersedesJobId: job.id,
  };
}

export function uniqueOperations(
  preview: RetargetPreview,
): Array<NonNullable<JobRecord["target"]>["operation"]> {
  return [...new Set(preview.affected.map((job) => job.toTarget.operation))];
}

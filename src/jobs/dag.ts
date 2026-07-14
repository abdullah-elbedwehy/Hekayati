import { JobError } from "./errors.js";
import type { JobRecord } from "./schemas.js";

export function validateDag(
  proposed: readonly JobRecord[],
  persisted: readonly JobRecord[],
): void {
  const jobs = new Map(persisted.map((job) => [job.id, job]));
  for (const job of proposed) {
    if (jobs.has(job.id)) throw new JobError("JOB_ID_CONFLICT");
    jobs.set(job.id, job);
  }
  for (const job of proposed) validateEdges(job, jobs);
  detectCycles(jobs);
}

export function dependenciesSucceeded(
  job: JobRecord,
  jobs: ReadonlyMap<string, JobRecord>,
): boolean {
  return job.dependsOn.every((id) => jobs.get(id)?.state === "succeeded");
}

function validateEdges(
  job: JobRecord,
  jobs: ReadonlyMap<string, JobRecord>,
): void {
  if (new Set(job.dependsOn).size !== job.dependsOn.length)
    throw new JobError("JOB_DEPENDENCY_DUPLICATE");
  for (const dependencyId of job.dependsOn) {
    if (dependencyId === job.id) throw new JobError("JOB_DEPENDENCY_SELF");
    const dependency = jobs.get(dependencyId);
    if (!dependency) throw new JobError("JOB_DEPENDENCY_MISSING");
    if (scopeKey(job) !== scopeKey(dependency))
      throw new JobError("JOB_DEPENDENCY_CROSS_SCOPE");
  }
}

function detectCycles(jobs: ReadonlyMap<string, JobRecord>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new JobError("JOB_DEPENDENCY_CYCLE");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of jobs.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of jobs.keys()) visit(id);
}

function scopeKey(job: JobRecord): string {
  return job.projectId
    ? `project:${job.projectId}`
    : `scope:${job.standaloneScopeId}`;
}

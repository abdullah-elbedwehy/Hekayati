import type { JobHistory } from "./history.js";
import type { JobRepository } from "./repository.js";
import type { JobRecord } from "./schemas.js";
import type { JobEnqueuer } from "./scheduler-enqueuer.js";
import type { ClaimOptions, JobScopeAdmissionPort } from "./types.js";

export function claimNextAdmitted(
  repository: JobRepository,
  history: JobHistory,
  enqueuer: JobEnqueuer,
  scopeAdmission: JobScopeAdmissionPort,
  options: ClaimOptions,
  claimTokenFactory: () => string,
): JobRecord | null {
  if (history.storageStatus().active) return null;
  enqueuer.promoteReady();
  const excludedJobIds = repository
    .list()
    .filter(
      (job) =>
        job.state === "queued" &&
        !scopeAdmission.isAdmittedInTransaction(job, "scheduler_claim"),
    )
    .map((job) => job.id);
  const claimed = repository.claimNext(
    options,
    {
      workerId: options.workerId,
      bootId: options.bootId,
      claimToken: claimTokenFactory(),
      claimedAtMono: options.nowMonoMs,
      expiresAtMono: options.nowMonoMs + options.leaseTtlMs,
    },
    new Date(options.nowWallMs).toISOString(),
    excludedJobIds,
  );
  if (claimed)
    history.append(claimed, "claimed", {
      fromState: "queued",
      toState: "claimed",
    });
  return claimed;
}

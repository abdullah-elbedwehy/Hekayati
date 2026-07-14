import { JobError } from "./errors.js";
import type { JobHistory } from "./history.js";
import type { JobRepository } from "./repository.js";
import type { JobRecord, JobTarget } from "./schemas.js";
import type { JobEnqueuer } from "./scheduler-enqueuer.js";
import {
  retargetCandidates,
  retargetImpactHash,
  retargetSuccessorInput,
  uniqueOperations,
} from "./scheduler-retarget-helpers.js";
import { linkSupersedingSuccessor } from "./scheduler-successors.js";
import type { RetargetInput, RetargetPreview } from "./types.js";

export class JobRetargeter {
  constructor(
    private readonly repository: JobRepository,
    private readonly history: JobHistory,
    private readonly enqueuer: JobEnqueuer,
    private readonly nowIso: () => string,
    private readonly idFactory: () => string,
  ) {}

  preview(
    targets: readonly NonNullable<JobRecord["target"]>[],
  ): RetargetPreview {
    const affected = retargetCandidates(this.repository.list(), targets);
    return {
      impactHash: retargetImpactHash(targets, affected),
      affected,
    };
  }

  hasRetargetableOperation(operation: JobTarget["operation"]): boolean {
    return this.repository
      .list()
      .some(
        (job) =>
          job.target?.operation === operation &&
          ["queued", "blocked", "paused"].includes(job.state),
      );
  }

  retargetRemaining<T extends { updatedAt: string }>(
    input: RetargetInput & { expectedSettingsUpdatedAt: string },
    commitSettings: () => T,
  ): { settings: T; successors: JobRecord[] } {
    return this.repository.transaction(() => {
      const preview = this.preview(input.targets);
      if (preview.impactHash !== input.expectedImpactHash)
        throw new JobError("JOB_IMPACT_CONFLICT");
      if (preview.affected.length === 0)
        throw new JobError("JOB_TARGET_CHANGE_EMPTY");
      const settings = commitSettings();
      const successors = this.createSuccessors(preview, input);
      this.history.appendTargetChangeAudit({
        expectedSettingsUpdatedAt: input.expectedSettingsUpdatedAt,
        settingsUpdatedAt: settings.updatedAt,
        impactHash: preview.impactHash,
        operations: uniqueOperations(preview),
        affectedJobIds: preview.affected.map((job) => job.id),
        successorJobIds: successors.map((job) => job.id),
      });
      return { settings, successors };
    });
  }

  private createSuccessors(
    preview: RetargetPreview,
    input: RetargetInput,
  ): JobRecord[] {
    const originals = preview.affected.map((entry) =>
      this.requireJob(entry.id),
    );
    const ids = new Map(originals.map((job) => [job.id, this.idFactory()]));
    const successors = this.enqueuer.enqueueInTransaction(
      originals.map((job) => retargetSuccessorInput(job, preview, ids)),
    );
    originals.forEach((original, index) => {
      const successor = successors[index];
      if (!successor) throw new JobError("JOB_TARGET_SUCCESSOR_MISSING");
      const adjusted = this.applyDisposition(
        original,
        successor,
        input.isTargetAvailable(successor.target!),
      );
      linkSupersedingSuccessor(
        this.repository,
        this.history,
        this.nowIso,
        original,
        adjusted,
      );
      successors[index] = adjusted;
    });
    return successors;
  }

  private applyDisposition(
    original: JobRecord,
    successor: JobRecord,
    targetAvailable: boolean,
  ): JobRecord {
    if (successor.state === "paused") return successor;
    const reason =
      original.state === "paused"
        ? (original.stateReason ?? "operator")
        : targetAvailable
          ? null
          : "provider_unavailable";
    if (!reason) return successor;
    const paused = this.repository.update(successor, {
      ...successor,
      state: "paused",
      stateReason: reason,
      resumeState: successor.state,
      resumeReason: successor.stateReason,
      updatedAt: this.nowIso(),
      revision: successor.revision + 1,
    });
    this.history.append(paused, "paused", {
      fromState: successor.state,
      toState: "paused",
      reason,
    });
    return paused;
  }

  private requireJob(id: string): JobRecord {
    const job = this.repository.get(id);
    if (!job) throw new JobError("JOB_NOT_FOUND", 404);
    return job;
  }
}

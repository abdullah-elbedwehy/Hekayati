import type { JobHistory } from "./history.js";
import type { JobRepository } from "./repository.js";
import type { JobRecord } from "./schemas.js";

export function linkSupersedingSuccessor(
  repository: JobRepository,
  history: JobHistory,
  nowIso: () => string,
  original: JobRecord,
  successor: JobRecord,
): void {
  const linked = repository.update(original, {
    ...original,
    state: "canceled",
    stateReason: "superseded",
    resumeState: null,
    resumeReason: null,
    successorJobIds: [...original.successorJobIds, successor.id],
    updatedAt: nowIso(),
    revision: original.revision + 1,
  });
  history.append(linked, "successor_linked", {
    fromState: original.state,
    toState: "canceled",
    reason: "superseded",
  });
}

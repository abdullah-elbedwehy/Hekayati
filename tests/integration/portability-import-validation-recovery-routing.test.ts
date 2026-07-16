import { afterEach, describe, expect, it, vi } from "vitest";

import type { ImportCommitProgress } from "../../src/domain/portability/import-apply-model.js";
import {
  IMPORT_VALIDATION_AT as at,
  IMPORT_VALIDATION_ENTITY as entity,
  cleanupImportValidationFixtures,
  harness,
  syntheticArchive,
  syntheticRegistry,
} from "../helpers/portability-import-validation-fixture.js";

afterEach(cleanupImportValidationFixtures);

describe("import recovery ownership routing", () => {
  it("leaves apply-owned cleanup for ImportApplyService", async () => {
    const fixture = await harness(
      syntheticRegistry(),
      await syntheticArchive(),
    );
    const validated = await fixture.validation.validate(entity.operation);
    const planned = fixture.db.transactionImmediate(() =>
      fixture.operations.replaceInTransaction(
        {
          ...validated,
          revision: validated.revision + 1,
          mode: "as_new_project",
          planId: entity.export,
          actionRefs: {
            ...validated.actionRefs,
            latestPlanActionId: entity.extra,
          },
        },
        validated.revision,
      ),
    );
    const committing = fixture.db.transactionImmediate(() =>
      fixture.operations.replaceInTransaction(
        {
          ...planned,
          revision: planned.revision + 1,
          state: "committing",
          commit: commitProgress(planned.revision),
        },
        planned.revision,
      ),
    );
    const cleanupRequired = fixture.db.transactionImmediate(() =>
      fixture.operations.replaceInTransaction(
        {
          ...committing,
          revision: committing.revision + 1,
          state: "cleanup_required",
          commit: {
            ...committing.commit!,
            phase: "cleanup_required",
            failureCode: "IMPORT_PREPARE_FAILED",
          },
          failureCode: "IMPORT_PREPARE_FAILED",
          cleanupState: "failed",
        },
        committing.revision,
      ),
    );
    const removeStaging = vi.spyOn(fixture.managed, "removeStaging");
    const removeReservation = vi.spyOn(fixture.managed, "removeReservation");

    const recovery = await fixture.validation.recover();

    expect(recovery.resumed).toEqual([]);
    expect(recovery.cleanupRetried).toEqual([]);
    expect(fixture.operations.get(entity.operation)).toEqual(cleanupRequired);
    expect(removeStaging).not.toHaveBeenCalled();
    expect(removeReservation).not.toHaveBeenCalled();
    await expect(fixture.validation.validate(entity.operation)).rejects.toThrow(
      "IMPORT_APPLY_RECOVERY_REQUIRED",
    );
    expect(removeStaging).not.toHaveBeenCalled();
    expect(removeReservation).not.toHaveBeenCalled();
  });

  it("does not let recovery switch a pre-commit cleanup into post-commit cleanup", async () => {
    const fixture = await harness(
      syntheticRegistry(),
      await syntheticArchive(),
    );
    const validated = await fixture.validation.validate(entity.operation);
    const planned = fixture.db.transactionImmediate(() =>
      fixture.operations.replaceInTransaction(
        {
          ...validated,
          revision: validated.revision + 1,
          mode: "as_new_project",
          planId: entity.export,
          actionRefs: {
            ...validated.actionRefs,
            latestPlanActionId: entity.extra,
          },
        },
        validated.revision,
      ),
    );
    const committing = fixture.db.transactionImmediate(() =>
      fixture.operations.replaceInTransaction(
        {
          ...planned,
          revision: planned.revision + 1,
          state: "committing",
          commit: commitProgress(planned.revision),
        },
        planned.revision,
      ),
    );
    expect(() =>
      fixture.db.transactionImmediate(() =>
        fixture.operations.replaceInTransaction(
          {
            ...committing,
            revision: committing.revision + 1,
            state: "cleanup_required",
            actionRefs: {
              ...committing.actionRefs,
              commitActionId: entity.action,
            },
            commit: {
              ...committing.commit!,
              phase: "cleanup_required",
              result: commitResult(),
              failureCode: "IMPORT_CLEANUP_FAILED",
            },
            failureCode: "IMPORT_CLEANUP_FAILED",
            cleanupState: "failed",
          },
          committing.revision,
        ),
      ),
    ).toThrow("IMPORT_COMMIT_RECOVERY_BRANCH_CHANGED");
    const cleanupRequired = fixture.db.transactionImmediate(() =>
      fixture.operations.replaceInTransaction(
        {
          ...committing,
          revision: committing.revision + 1,
          state: "cleanup_required",
          commit: {
            ...committing.commit!,
            phase: "cleanup_required",
            failureCode: "IMPORT_PREPARE_FAILED",
          },
          failureCode: "IMPORT_PREPARE_FAILED",
          cleanupState: "failed",
        },
        committing.revision,
      ),
    );

    expect(() =>
      fixture.db.transactionImmediate(() =>
        fixture.operations.replaceInTransaction(
          {
            ...cleanupRequired,
            revision: cleanupRequired.revision + 1,
            state: "imported",
            actionRefs: {
              ...cleanupRequired.actionRefs,
              commitActionId: entity.action,
            },
            commit: {
              ...cleanupRequired.commit!,
              phase: "complete",
              result: commitResult(),
              failureCode: null,
            },
            failureCode: null,
            cleanupState: "complete",
          },
          cleanupRequired.revision,
        ),
      ),
    ).toThrow("IMPORT_COMMIT_RECOVERY_BRANCH_CHANGED");
  });
});

function commitProgress(
  expectedOperationRevision: number,
): ImportCommitProgress {
  return {
    action: "import_commit",
    idempotencyKey: "apply-once",
    requestHash: "a".repeat(64),
    expectedOperationRevision,
    planConfirmationHash: "b".repeat(64),
    phase: "preparing",
    lock: {
      id: entity.family,
      mode: "import_commit",
      phase: "exclusive",
      revision: 0,
      scope: {
        kind: "project",
        id: entity.project,
        projectId: entity.project,
        customerId: entity.customer,
      },
    },
    sourceProofHash: null,
    targetSnapshotHash: null,
    preparedCount: 0,
    result: null,
    failureCode: null,
  };
}

function commitResult() {
  return {
    graphHash: "c".repeat(64),
    targetRootIds: [entity.project],
    documentCount: 4,
    preparedMediaCount: 1,
    canceledJobCount: 0,
    cleanupLedgerRoot: "d".repeat(64),
    committedAt: at,
  };
}

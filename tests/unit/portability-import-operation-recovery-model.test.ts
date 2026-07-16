import { describe, expect, it } from "vitest";

import {
  importCommitProgressSchema,
  type ImportCommitProgress,
} from "../../src/domain/portability/import-apply-model.js";
import { importOperationSchema } from "../../src/domain/portability/import-model.js";

const at = "2026-07-16T23:00:00.000Z";
const id = (digit: string) => `01KA000000000000000000000${digit}`;
const hash = (digit: string) => digit.repeat(64);

describe("import apply recovery state model", () => {
  it("represents pre-commit and post-commit cleanup without conflating them", () => {
    const preCommit = progress({
      phase: "cleanup_required",
      failureCode: "IMPORT_PREPARE_FAILED",
    });
    const postCommit = progress({
      phase: "cleanup_required",
      result: result(),
      failureCode: "IMPORT_CLEANUP_FAILED",
    });

    expect(importCommitProgressSchema.parse(preCommit).result).toBeNull();
    expect(importCommitProgressSchema.parse(postCommit).result).toEqual(
      result(),
    );
    expect(operationFor(preCommit, "cleanup_required")).toMatchObject({
      state: "cleanup_required",
      actionRefs: { commitActionId: null },
    });
    expect(operationFor(postCommit, "cleanup_required")).toMatchObject({
      state: "cleanup_required",
      actionRefs: { commitActionId: id("4") },
    });
  });

  it("keeps result presence bounded for all non-cleanup phases", () => {
    for (const phase of ["preparing", "rolling_back", "rolled_back"] as const)
      expect(() =>
        importCommitProgressSchema.parse(
          progress({
            phase,
            result: result(),
            failureCode: phase === "preparing" ? null : "IMPORT_PREPARE_FAILED",
          }),
        ),
      ).toThrow("IMPORT_COMMIT_RESULT_REQUIRED");

    for (const phase of ["graph_committed", "complete"] as const)
      expect(() =>
        importCommitProgressSchema.parse(progress({ phase, result: null })),
      ).toThrow("IMPORT_COMMIT_RESULT_REQUIRED");
  });

  it("binds operation states to their recoverable commit phases", () => {
    expect(operationFor(progress(), "committing")).toMatchObject({
      state: "committing",
      commit: { phase: "preparing" },
    });
    expect(
      operationFor(
        progress({
          phase: "rolling_back",
          failureCode: "IMPORT_PREPARE_FAILED",
        }),
        "committing",
      ),
    ).toMatchObject({ state: "committing", commit: { phase: "rolling_back" } });
    expect(
      operationFor(
        progress({ phase: "graph_committed", result: result() }),
        "imported",
      ),
    ).toMatchObject({
      state: "imported",
      commit: { phase: "graph_committed" },
    });
    expect(
      operationFor(
        progress({ phase: "complete", result: result() }),
        "imported",
      ),
    ).toMatchObject({ state: "imported", commit: { phase: "complete" } });
    expect(
      operationFor(
        progress({
          phase: "rolled_back",
          failureCode: "IMPORT_PREPARE_FAILED",
        }),
        "rolled_back",
      ),
    ).toMatchObject({ state: "rolled_back", commit: { phase: "rolled_back" } });

    expectInvalidOperation(
      progress({ phase: "rolled_back", failureCode: "IMPORT_PREPARE_FAILED" }),
      "committing",
      "IMPORT_COMMIT_PHASE_STATE_MISMATCH",
    );
    expectInvalidOperation(
      progress({
        phase: "cleanup_required",
        result: result(),
        failureCode: "IMPORT_CLEANUP_FAILED",
      }),
      "imported",
      "IMPORT_COMMIT_PHASE_STATE_MISMATCH",
    );
    expectInvalidOperation(
      progress(),
      "rolled_back",
      "IMPORT_COMMIT_PHASE_STATE_MISMATCH",
    );
  });

  it("requires validated plan facts for apply-owned cleanup", () => {
    const commit = progress({
      phase: "cleanup_required",
      failureCode: "IMPORT_PREPARE_FAILED",
    });
    const candidate = operation(commit, "cleanup_required");
    expect(() =>
      importOperationSchema.parse({
        ...candidate,
        normalizedManifestHash: null,
      }),
    ).toThrow("IMPORT_VALIDATION_REQUIRED");
    expect(() =>
      importOperationSchema.parse({
        ...candidate,
        state: "plan_ready",
        failureCode: null,
        cleanupState: "none",
      }),
    ).toThrow("IMPORT_COMMIT_STATE_MISMATCH");
  });
});

function expectInvalidOperation(
  commit: ImportCommitProgress,
  state: "committing" | "imported" | "rolled_back",
  code: string,
): void {
  expect(() => importOperationSchema.parse(operation(commit, state))).toThrow(
    code,
  );
}

function operationFor(
  commit: ImportCommitProgress,
  state: "committing" | "imported" | "rolled_back" | "cleanup_required",
) {
  return importOperationSchema.parse(operation(commit, state));
}

function operation(
  commit: ImportCommitProgress,
  state: "committing" | "imported" | "rolled_back" | "cleanup_required",
) {
  const failed = state === "rolled_back" || state === "cleanup_required";
  const committed = commit.result !== null;
  return {
    id: id("1"),
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    revision: 4,
    state,
    reservationKey: state === "committing" ? `${id("2")}.zip` : null,
    stagingKey: state === "committing" ? id("3") : null,
    sourceArchiveHash: hash("a"),
    sourceArchiveBytes: 1,
    manifestVersion: 2,
    normalizedManifestHash: hash("b"),
    sourceSnapshotHash: hash("c"),
    participantRegistryHash: hash("d"),
    archiveMode: "project",
    mode: "as_new_project",
    documentCount: 1,
    mediaCount: 0,
    totalUncompressedBytes: 1,
    diskFacts: {
      freeBytes: 10,
      reserveBytes: 1,
      requiredBytes: 2,
      declaredUncompressedBytes: 1,
      newContentBytes: 0,
      canonicalDocumentBytes: 1,
    },
    migrationSummary: {
      sourceManifestVersion: 2,
      normalizedManifestVersion: 2,
      migratedManifest: false,
      migratedDocumentCount: 0,
    },
    actionRefs: {
      uploadActionId: id("5"),
      latestPlanActionId: id("6"),
      commitActionId: committed ? id("4") : null,
    },
    planId: id("7"),
    commit,
    failureCode: failed ? (commit.failureCode ?? "IMPORT_APPLY_FAILED") : null,
    cleanupState:
      state === "cleanup_required"
        ? "failed"
        : state === "rolled_back" || commit.phase === "complete"
          ? "complete"
          : "pending",
  };
}

function progress(
  overrides: Partial<ImportCommitProgress> = {},
): ImportCommitProgress {
  return {
    action: "import_commit",
    idempotencyKey: "commit-once",
    requestHash: hash("e"),
    expectedOperationRevision: 3,
    planConfirmationHash: hash("f"),
    phase: "preparing",
    lock: {
      id: id("8"),
      mode: "import_commit",
      phase: "exclusive",
      revision: 0,
      scope: {
        kind: "project",
        id: id("9"),
        projectId: id("9"),
        customerId: id("A"),
      },
    },
    sourceProofHash: hash("0"),
    targetSnapshotHash: hash("1"),
    preparedCount: 0,
    result: null,
    failureCode: null,
    ...overrides,
  };
}

function result() {
  return {
    graphHash: hash("2"),
    targetRootIds: [id("9")],
    documentCount: 1,
    preparedMediaCount: 0,
    canceledJobCount: 0,
    cleanupLedgerRoot: hash("3"),
    committedAt: at,
  };
}

import { describe, expect, it } from "vitest";

import {
  importCommitProgressSchema,
  importCommitRequestSchema,
  preparedImportMediaSchema,
} from "../../src/domain/portability/import-apply-model.js";

const at = "2026-07-16T22:00:00.000Z";
const id = (digit: string) => `01K9000000000000000000000${digit}`;
const hash = (digit: string) => digit.repeat(64);

describe("import apply durable models", () => {
  it("requires exact final confirmation and binds one operation-owned lock", () => {
    expect(
      importCommitRequestSchema.parse({
        idempotencyKey: "commit-once",
        expectedOperationRevision: 3,
        planId: id("1"),
        confirmationHash: hash("a"),
        finalConfirmation: true,
      }),
    ).toMatchObject({ finalConfirmation: true });
    expect(() =>
      importCommitRequestSchema.parse({
        idempotencyKey: "commit-once",
        expectedOperationRevision: 3,
        planId: id("1"),
        confirmationHash: hash("a"),
        finalConfirmation: false,
      }),
    ).toThrow();

    expect(importCommitProgressSchema.parse(progress())).toMatchObject({
      phase: "preparing",
      action: "import_commit",
      lock: { mode: "import_commit", phase: "exclusive" },
    });
  });

  it("rejects a graph-committed phase without its exact result", () => {
    expect(() =>
      importCommitProgressSchema.parse({
        ...progress(),
        phase: "graph_committed",
      }),
    ).toThrow("IMPORT_COMMIT_RESULT_REQUIRED");
    expect(() =>
      importCommitProgressSchema.parse({
        ...progress(),
        action: "replace_commit",
      }),
    ).toThrow("IMPORT_COMMIT_LOCK_MODE_MISMATCH");
  });

  it("keeps mutable prepared state separate from the immutable plan intent", () => {
    const prepared = preparedImportMediaSchema.parse({
      id: id("2"),
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      revision: 0,
      operationId: id("3"),
      planId: id("1"),
      namespace: "asset",
      sourceId: id("4"),
      targetId: id("5"),
      checksum: hash("b"),
      bytes: 10,
      metadataHash: hash("c"),
      managedKey: `${hash("b").slice(0, 2)}/${hash("b")}.png`,
      state: "reserved",
      wasPreexisting: false,
      record: {
        id: id("5"),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        sha256: hash("b"),
        extension: "png",
        bytes: 10,
        refCount: 1,
        mime: "image/png",
        width: 1,
        height: 1,
        role: "illustration",
        origin: "derived",
      },
    });
    expect(prepared.record.id).toBe(prepared.targetId);
    expect(() =>
      preparedImportMediaSchema.parse({
        ...prepared,
        record: { ...prepared.record, id: id("6") },
      }),
    ).toThrow("IMPORT_PREPARED_MEDIA_RECORD_MISMATCH");
  });
});

function progress() {
  return {
    action: "import_commit",
    idempotencyKey: "commit-once",
    requestHash: hash("a"),
    expectedOperationRevision: 3,
    planConfirmationHash: hash("b"),
    phase: "preparing",
    lock: {
      id: id("7"),
      mode: "import_commit",
      phase: "exclusive",
      revision: 0,
      scope: {
        kind: "project",
        id: id("8"),
        projectId: id("8"),
        customerId: id("9"),
      },
    },
    sourceProofHash: null,
    targetSnapshotHash: null,
    preparedCount: 1,
    result: null,
    failureCode: null,
  };
}

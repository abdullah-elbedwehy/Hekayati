import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

import {
  ARABIC_EXPORT_PRESENTATION_COPY,
  projectExportPresentation,
} from "../../src/domain/portability/export-presentation.js";
import type {
  ExportOperation,
  PortabilitySnapshot,
} from "../../src/domain/portability/export-model.js";

const at = "2026-07-16T02:00:00.000Z";
const snapshotHash = "a".repeat(64);
const documentHash = "b".repeat(64);
const mediaHash = "c".repeat(64);
const manifestHash = "d".repeat(64);
const archiveChecksum = "e".repeat(64);

describe("Arabic export presentation copy", () => {
  it("states every no-backup and child-photo boundary explicitly", () => {
    expect(ARABIC_EXPORT_PRESENTATION_COPY.warnings).toEqual({
      noAutomaticBackup: "لا يوجد نسخ احتياطي تلقائي في حكايتي.",
      exportIsNotBackup: "التصدير ليس نسخة احتياطية.",
      archiveContainsChildPhotos: "يحتوي الأرشيف على صور الأطفال.",
      externalCopies: "لا تستطيع حكايتي تتبّع النسخ المحفوظة خارجها أو حذفها.",
    });
    expect(Object.isFrozen(ARABIC_EXPORT_PRESENTATION_COPY)).toBe(true);
    expect(Object.isFrozen(ARABIC_EXPORT_PRESENTATION_COPY.warnings)).toBe(
      true,
    );
    expect(Object.isFrozen(ARABIC_EXPORT_PRESENTATION_COPY.stages)).toBe(true);
    for (const stage of Object.values(ARABIC_EXPORT_PRESENTATION_COPY.stages))
      expect(Object.isFrozen(stage)).toBe(true);
  });
});

describe("project export presentation", () => {
  it("shows pause and unfinished quiescence without inventing content counts", () => {
    const operation = exportOperation("waiting_quiescence");

    expect(projectExportPresentation(operation, null)).toEqual({
      direction: "rtl",
      stage: "waiting_quiescence",
      references: {
        operationId: operation.id,
        projectId: operation.projectId,
        snapshotId: null,
        snapshotHash: null,
        manifestHash: null,
        archiveChecksum: null,
        failureCode: null,
      },
      pause: {
        projectPaused: true,
        quiescenceReached: false,
        resumesAutomatically: false,
      },
      content: null,
      canDownload: false,
      copy: ARABIC_EXPORT_PRESENTATION_COPY.stages.waiting_quiescence,
      warnings: ARABIC_EXPORT_PRESENTATION_COPY.warnings,
    });
  });

  it("reports frozen staging counts as Western numeric fields only", () => {
    const operation = frozenOperation("staging");
    const snapshot = frozenSnapshot(operation, "staging");
    const presentation = projectExportPresentation(operation, snapshot);

    expect(presentation).toMatchObject({
      stage: "staging",
      pause: {
        projectPaused: true,
        quiescenceReached: true,
        resumesAutomatically: false,
      },
      content: {
        documentCount: 27,
        mediaCount: 11,
        totalUncompressedBytes: 4_096,
      },
      canDownload: false,
    });
    expect(typeof presentation.content?.documentCount).toBe("number");
    expect(typeof presentation.content?.mediaCount).toBe("number");
    expect(typeof presentation.content?.totalUncompressedBytes).toBe("number");
    expect(JSON.stringify(presentation)).not.toMatch(/[٠-٩۰-۹]/u);
  });

  it("exposes only safe IDs, hashes, counts, state, and immutable copy when ready", () => {
    const operation = frozenOperation("ready");
    const snapshot = frozenSnapshot(operation, "released");
    const presentation = projectExportPresentation(operation, snapshot);

    expect(presentation.stage).toBe("ready");
    expect(presentation.canDownload).toBe(true);
    expect(Object.isFrozen(presentation)).toBe(true);
    expect(Object.isFrozen(presentation.references)).toBe(true);
    expect(Object.isFrozen(presentation.pause)).toBe(true);
    expect(Object.isFrozen(presentation.content)).toBe(true);
    expect(presentation.references).toEqual({
      operationId: operation.id,
      projectId: operation.projectId,
      snapshotId: operation.snapshotId,
      snapshotHash,
      manifestHash,
      archiveChecksum,
      failureCode: null,
    });

    const serialized = JSON.stringify(presentation);
    for (const forbidden of [
      operation.archiveKey!,
      operation.customerId,
      operation.familyId,
      operation.idempotencyKey,
      "operator@example.test",
      "/Users/operator/child.jpg",
      "private customer note",
      "canonicalDocument",
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it("models failures honestly before and after a frozen summary", () => {
    const early = exportOperation("failed", {
      failureCode: "EXPORT_DRAIN_FAILED",
      cleanupState: "complete",
    });
    expect(projectExportPresentation(early, null)).toMatchObject({
      stage: "failed",
      content: null,
      canDownload: false,
      references: { failureCode: "EXPORT_DRAIN_FAILED" },
      pause: { quiescenceReached: false },
    });

    const afterFreeze = frozenOperation("failed", {
      failureCode: "EXPORT_STAGE_FAILED",
      cleanupState: "failed",
    });
    const failedSnapshot = frozenSnapshot(afterFreeze, "failed", {
      failureCode: "EXPORT_STAGE_FAILED",
    });
    expect(
      projectExportPresentation(afterFreeze, failedSnapshot),
    ).toMatchObject({
      stage: "failed",
      content: {
        documentCount: 27,
        mediaCount: 11,
        totalUncompressedBytes: 4_096,
      },
      canDownload: false,
      references: { failureCode: "EXPORT_STAGE_FAILED" },
      pause: { quiescenceReached: true },
    });
  });

  it("rejects mismatched snapshots and unbounded fields", () => {
    const operation = frozenOperation("staging");
    const snapshot = frozenSnapshot(operation, "staging");
    expect(() =>
      projectExportPresentation(operation, {
        ...snapshot,
        operationId: ulid(),
      }),
    ).toThrow("PORTABILITY_EXPORT_PRESENTATION_SNAPSHOT_MISMATCH");
    expect(() =>
      projectExportPresentation(
        {
          ...operation,
          sourcePath: "/Users/operator/child.jpg",
          customerContact: "operator@example.test",
          notes: "private customer note",
          canonicalDocument: "raw document",
        } as ExportOperation,
        snapshot,
      ),
    ).toThrow();
  });
});

function exportOperation(
  state: ExportOperation["state"],
  overrides: Partial<ExportOperation> = {},
): ExportOperation {
  const operation: ExportOperation = {
    id: ulid(),
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    revision: 1,
    projectId: ulid(),
    customerId: ulid(),
    familyId: ulid(),
    idempotencyKey: "presentation-export",
    requestHash: "f".repeat(64),
    projectRevision: 4,
    state,
    snapshotId: null,
    snapshotHash: null,
    documentCount: 0,
    mediaCount: 0,
    totalUncompressedBytes: 0,
    manifestHash: null,
    archiveKey: null,
    archiveChecksum: null,
    archiveBytes: null,
    failureCode: null,
    cleanupState: "none",
    ...overrides,
  };
  return operation;
}

function frozenOperation(
  state: "staging" | "ready" | "failed",
  overrides: Partial<ExportOperation> = {},
): ExportOperation {
  const operationId = ulid();
  const checksum = state === "ready" ? archiveChecksum : null;
  return exportOperation(state, {
    id: operationId,
    snapshotId: ulid(),
    snapshotHash,
    documentCount: 27,
    mediaCount: 11,
    totalUncompressedBytes: 4_096,
    manifestHash: state === "ready" ? manifestHash : null,
    archiveKey:
      state === "ready" ? `${operationId}-${archiveChecksum}.zip` : null,
    archiveChecksum: checksum,
    archiveBytes: state === "ready" ? 8_192 : null,
    ...overrides,
  });
}

function frozenSnapshot(
  operation: ExportOperation,
  state: PortabilitySnapshot["state"],
  overrides: Partial<PortabilitySnapshot> = {},
): PortabilitySnapshot {
  if (!operation.snapshotId) throw new Error("test snapshot ID required");
  return {
    id: operation.snapshotId,
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    revision: 3,
    operationId: operation.id,
    projectId: operation.projectId,
    customerId: operation.customerId,
    familyId: operation.familyId,
    projectRevision: operation.projectRevision,
    participantRegistryHash: "1".repeat(64),
    state,
    documentCount: 27,
    mediaCount: 11,
    totalUncompressedBytes: 4_096,
    documentRootHash: documentHash,
    mediaRootHash: mediaHash,
    snapshotHash,
    nextOrdinal: 38,
    failureCode: state === "failed" ? "EXPORT_STAGE_FAILED" : null,
    ...overrides,
  };
}

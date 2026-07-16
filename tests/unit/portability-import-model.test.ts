import { describe, expect, it } from "vitest";

import { importOperationSchema } from "../../src/domain/portability/import-model.js";

const at = "2026-07-16T15:00:00.000Z";
const id = "01K40000000000000000000001";
const action = "01K40000000000000000000002";
const reservation = "01K40000000000000000000003.zip";
const staging = "01K40000000000000000000004";
const hash = "a".repeat(64);

describe("ImportOperation invariants", () => {
  it("accepts minimal uploaded and complete plan-ready boundaries", () => {
    expect(importOperationSchema.parse(uploaded())).toMatchObject({
      state: "uploaded",
      revision: 0,
    });
    expect(importOperationSchema.parse(planReady())).toMatchObject({
      state: "plan_ready",
      manifestVersion: 2,
      cleanupState: "none",
    });
    expect(importOperationSchema.parse(planned())).toMatchObject({
      state: "plan_ready",
      mode: "as_new_project",
      planId: id,
    });
  });

  it("rejects premature, missing, empty, and already-planned validation facts", () => {
    expectInvalid(
      { ...uploaded(), normalizedManifestHash: hash },
      "IMPORT_VALIDATION_PREMATURE",
    );
    expectInvalid(
      { ...planReady(), normalizedManifestHash: null },
      "IMPORT_VALIDATION_REQUIRED",
    );
    expectInvalid(
      { ...planReady(), stagingKey: null },
      "IMPORT_STAGING_SUMMARY_REQUIRED",
    );
    expectInvalid(
      { ...planReady(), documentCount: 0 },
      "IMPORT_STAGING_SUMMARY_REQUIRED",
    );
    expectInvalid(
      { ...planReady(), totalUncompressedBytes: 0 },
      "IMPORT_STAGING_SUMMARY_REQUIRED",
    );
    expectInvalid(
      { ...planReady(), planId: id },
      "IMPORT_PLAN_BINDING_INCOMPLETE",
    );
    expectInvalid(
      {
        ...planReady(),
        actionRefs: { ...planReady().actionRefs, latestPlanActionId: action },
      },
      "IMPORT_PLAN_BINDING_INCOMPLETE",
    );
    expectInvalid(
      { ...planReady(), mode: "as_new_project" },
      "IMPORT_PLAN_BINDING_INCOMPLETE",
    );
  });

  it("binds failure codes and released managed keys to terminal failure states", () => {
    expectInvalid(
      { ...uploaded(), state: "failed", reservationKey: null },
      "IMPORT_FAILURE_STATE_MISMATCH",
    );
    expectInvalid(
      { ...uploaded(), failureCode: "IMPORT_FAILED" },
      "IMPORT_FAILURE_STATE_MISMATCH",
    );
    expectInvalid(
      { ...failed(), reservationKey: reservation },
      "IMPORT_FAILED_RESERVATION_RETAINED",
    );
    expectInvalid(
      { ...failed(), stagingKey: staging },
      "IMPORT_FAILED_STAGING_RETAINED",
    );
    expect(importOperationSchema.parse(failed())).toMatchObject({
      state: "failed",
      failureCode: "IMPORT_FAILED",
    });
    expect(
      importOperationSchema.parse({
        ...uploaded(),
        state: "cleanup_required",
        failureCode: "IMPORT_FAILED",
        cleanupState: "failed",
      }),
    ).toMatchObject({ state: "cleanup_required" });
  });
});

function uploaded() {
  return {
    id,
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    revision: 0,
    state: "uploaded",
    reservationKey: reservation,
    stagingKey: null,
    sourceArchiveHash: hash,
    sourceArchiveBytes: 1,
    manifestVersion: null,
    normalizedManifestHash: null,
    sourceSnapshotHash: null,
    participantRegistryHash: null,
    archiveMode: null,
    mode: null,
    documentCount: 0,
    mediaCount: 0,
    totalUncompressedBytes: 0,
    diskFacts: null,
    migrationSummary: null,
    actionRefs: {
      uploadActionId: action,
      latestPlanActionId: null,
      commitActionId: null,
    },
    planId: null,
    failureCode: null,
    cleanupState: "none",
  };
}

function planned() {
  return {
    ...planReady(),
    mode: "as_new_project",
    planId: id,
    actionRefs: {
      ...planReady().actionRefs,
      latestPlanActionId: action,
    },
  };
}

function planReady() {
  return {
    ...uploaded(),
    revision: 2,
    state: "plan_ready",
    stagingKey: staging,
    manifestVersion: 2,
    normalizedManifestHash: hash,
    sourceSnapshotHash: hash,
    participantRegistryHash: hash,
    archiveMode: "project",
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
  };
}

function failed() {
  return {
    ...uploaded(),
    revision: 2,
    state: "failed",
    reservationKey: null,
    stagingKey: null,
    failureCode: "IMPORT_FAILED",
    cleanupState: "complete",
  };
}

function expectInvalid(candidate: unknown, code: string): void {
  expect(() => importOperationSchema.parse(candidate)).toThrow(code);
}

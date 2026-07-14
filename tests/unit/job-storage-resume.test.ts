import { describe, expect, it } from "vitest";

import type { JobRecord } from "../../src/jobs/schemas.js";
import { storageControlSchema } from "../../src/jobs/schemas.js";
import {
  confirmStorageResume,
  storageIncidentJobs,
  storageResumeImpact,
  type StorageIncidentControl,
} from "../../src/jobs/storage-resume.js";

const hash = "b".repeat(64);

describe("storage resume confirmation", () => {
  it("binds the server impact to the incident revision and exact owned jobs", () => {
    const owned = job("01J00000000000000000000001", 4, "storage");
    const otherIncident = job("01J00000000000000000000002", 2, "storage");
    const priorReason = job("01J00000000000000000000003", 3, "operator");
    const control = storageControl([owned.id, priorReason.id]);

    const impact = storageResumeImpact(control, [
      otherIncident,
      priorReason,
      owned,
    ]);

    expect(impact).toMatchObject({ expectedRevision: 7, affectedCount: 1 });
    expect(impact.impactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      confirmStorageResume(control, [otherIncident, priorReason, owned], {
        ...impact,
        confirmedAffectedCount: impact.affectedCount,
        confirmed: true,
      }),
    ).toEqual([owned]);
    expect(storageIncidentJobs(control, [otherIncident, owned])).toEqual([
      owned,
    ]);
  });

  it("rejects stale revision, hash, and affected-count confirmations", () => {
    const owned = job("01J00000000000000000000001", 4, "storage");
    const control = storageControl([owned.id]);
    const impact = storageResumeImpact(control, [owned]);
    const confirmation = {
      expectedRevision: impact.expectedRevision,
      impactHash: impact.impactHash,
      confirmedAffectedCount: impact.affectedCount,
      confirmed: true as const,
    };

    expect(() =>
      confirmStorageResume(control, [owned], {
        ...confirmation,
        expectedRevision: confirmation.expectedRevision - 1,
      }),
    ).toThrow(expect.objectContaining({ code: "JOB_REVISION_CONFLICT" }));
    expect(() =>
      confirmStorageResume(control, [{ ...owned, revision: 5 }], confirmation),
    ).toThrow(expect.objectContaining({ code: "JOB_IMPACT_CONFLICT" }));
    expect(() =>
      confirmStorageResume(control, [owned], {
        ...confirmation,
        confirmedAffectedCount: 2,
      }),
    ).toThrow(expect.objectContaining({ code: "JOB_IMPACT_CONFLICT" }));
  });

  it("rejects a closed or identifier-less incident", () => {
    const owned = job("01J00000000000000000000001", 4, "storage");

    expect(() =>
      storageResumeImpact({ ...storageControl([owned.id]), active: false }, [
        owned,
      ]),
    ).toThrow(expect.objectContaining({ code: "JOB_STORAGE_NOT_PAUSED" }));
    expect(() =>
      storageResumeImpact({ ...storageControl([owned.id]), incidentId: null }, [
        owned,
      ]),
    ).toThrow(expect.objectContaining({ code: "JOB_STORAGE_NOT_PAUSED" }));
  });

  it("defaults incident ownership when reading a pre-hardening control", () => {
    expect(
      storageControlSchema.parse({
        id: "scheduler",
        schemaVersion: 1,
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
        revision: 0,
        active: false,
        reason: null,
        detectedAt: null,
        lastProbeAt: null,
        lastProbeStatus: null,
        workerStatus: "stopped",
        bootId: null,
        lastRecoveryAt: null,
      }),
    ).toMatchObject({ incidentId: null, ownedJobIds: [] });
  });
});

function storageControl(ownedJobIds: string[]): StorageIncidentControl {
  return {
    active: true,
    revision: 7,
    incidentId: "01J00000000000000000000999",
    ownedJobIds,
  };
}

function job(
  id: string,
  revision: number,
  stateReason: "storage" | "operator",
): JobRecord {
  return {
    id,
    schemaVersion: 1,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    revision,
    jobType: "fixture_noop",
    projectId: "01J00000000000000000000998",
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId: `intent-${id}`,
    idempotencyKey: hash,
    requestHash: hash,
    target: null,
    request: { kind: "local", payloadHash: hash },
    inputSnapshot: {},
    state: "paused",
    stateReason,
    resumeState: "queued",
    resumeReason: null,
    lease: null,
    attempts: 0,
    autoRetryIndex: 0,
    manualRetryCount: 0,
    retrySchedule: null,
    progress: null,
    failure: null,
    provenance: null,
    resultRefs: [],
    supersedesJobId: null,
    successorJobIds: [],
  };
}

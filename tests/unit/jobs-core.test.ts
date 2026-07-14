import { describe, expect, it } from "vitest";

import {
  createIdempotencyKey,
  createRequestHash,
} from "../../src/jobs/idempotency.js";
import { jobRecordSchema } from "../../src/jobs/schemas.js";
import { decideFailure, RETRY_POLICIES } from "../../src/jobs/retry-policy.js";
import { failureCategorySchema } from "../../src/providers/failures.js";

const hash = "a".repeat(64);

describe("job core contracts", () => {
  it("canonicalizes request and idempotency inputs without accepting bytes", () => {
    const left = createIdempotencyKey({
      jobType: "fixture_noop",
      intentId: "intent-1",
      request: { kind: "local", payloadHash: hash },
      inputSnapshot: { b: "version-b", a: "version-a" },
      target: null,
    });
    const right = createIdempotencyKey({
      intentId: "intent-1",
      target: null,
      inputSnapshot: { a: "version-a", b: "version-b" },
      request: { payloadHash: hash, kind: "local" },
      jobType: "fixture_noop",
    });
    expect(left).toBe(right);
    expect(
      createRequestHash({ kind: "local", payloadHash: hash }),
    ).toHaveLength(64);
    expect(() => createRequestHash(new Uint8Array([1, 2, 3]))).toThrow(
      "JOB_BINARY_PERSISTENCE_FORBIDDEN",
    );
  });

  it("defines one exact scheduler policy for every normalized category", () => {
    expect(Object.keys(RETRY_POLICIES).sort()).toEqual(
      [...failureCategorySchema.options].sort(),
    );
    expect(decideFailure("network_failure", 0)).toEqual({
      action: "retry",
      delayMs: 10_000,
    });
    expect(decideFailure("network_failure", 3)).toEqual({
      action: "pause",
      reason: "retry_exhausted",
    });
    expect(decideFailure("rate_limited", 1, 86_500_000)).toEqual({
      action: "retry",
      delayMs: 86_400_000,
    });
    expect(decideFailure("safety_refusal", 0)).toEqual({
      action: "fail",
      reason: "safety_refusal",
    });
    expect(decideFailure("disk_write_failure", 0)).toEqual({
      action: "pause_all",
      reason: "storage",
    });
  });

  it("rejects runtime-resolved bytes and unknown persisted job fields", () => {
    const record = validJobRecord();
    expect(jobRecordSchema.parse(record).request.kind).toBe("local");
    expect(() =>
      jobRecordSchema.parse({
        ...record,
        request: {
          kind: "local",
          payloadHash: hash,
          bytes: new Uint8Array([1]),
        },
      }),
    ).toThrow();
    expect(() =>
      jobRecordSchema.parse({ ...record, providerRaw: "secret" }),
    ).toThrow();
  });
});

function validJobRecord() {
  return {
    id: "01J00000000000000000000000",
    schemaVersion: 1,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    revision: 0,
    jobType: "fixture_noop",
    projectId: "01J00000000000000000000001",
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId: "intent-1",
    idempotencyKey: hash,
    requestHash: hash,
    target: null,
    request: { kind: "local", payloadHash: hash },
    inputSnapshot: {},
    state: "queued",
    stateReason: null,
    resumeState: null,
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

import { describe, expect, it } from "vitest";

import { createExactIdMap } from "../../src/domain/portability/id-map.js";
import {
  IMPORT_DERIVED_HASH_RULES,
  rebaseParticipantDerivedFields,
} from "../../src/domain/portability/import-rebase.js";
import { jobRecordSchema } from "../../src/jobs/schemas.js";

const at = "2026-07-16T19:30:00.000Z";
const id = (suffix: string) =>
  `01K52000000000000000000000`.slice(0, 25).concat(suffix);
const hash = (character: string) => character.repeat(64);

describe("dependency-safe imported derived-field rebase", () => {
  it("normalizes executable work to lease-free operator pause and rehashes intent", () => {
    const sourceJob = id("0");
    const targetJob = id("1");
    const sourceProject = id("2");
    const targetProject = id("3");
    const map = createExactIdMap([
      { namespace: "jobs", sourceId: sourceJob, targetId: targetJob },
      {
        namespace: "projects",
        sourceId: sourceProject,
        targetId: targetProject,
      },
    ]);
    const job = jobRecordSchema.parse({
      id: targetJob,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      revision: 4,
      jobType: "preview_pdf",
      projectId: targetProject,
      standaloneScopeId: null,
      dependsOn: [],
      priority: 3,
      intentId: `preview-${sourceProject}`,
      idempotencyKey: hash("a"),
      requestHash: hash("b"),
      target: null,
      request: { kind: "local", payloadHash: hash("c") },
      inputSnapshot: { projectId: targetProject },
      state: "running",
      stateReason: null,
      resumeState: null,
      resumeReason: null,
      lease: {
        workerId: "worker-1",
        bootId: "boot-1",
        claimToken: "claim-1",
        claimedAtMono: 1,
        expiresAtMono: 2,
      },
      attempts: 1,
      autoRetryIndex: 0,
      manualRetryCount: 0,
      retrySchedule: null,
      progress: null,
      failure: null,
      provenance: null,
      resultRefs: [],
      supersedesJobId: null,
      successorJobIds: [],
    });

    const rebased = jobRecordSchema.parse(
      rebaseParticipantDerivedFields("jobs", job, map),
    );
    expect(rebased).toMatchObject({
      state: "paused",
      stateReason: "operator",
      resumeState: "queued",
      lease: null,
    });
    expect(rebased.intentId).not.toContain(sourceProject);
    expect(rebased.request).not.toEqual(job.request);
    expect(rebased.requestHash).not.toBe(job.requestHash);
    expect(rebased.idempotencyKey).not.toBe(job.idempotencyKey);
  });

  it("keeps terminal jobs terminal and human gates on their remapped gate", () => {
    const map = createExactIdMap([]);
    const succeeded = baseJob({ state: "succeeded", request: localRequest() });
    const gate = baseJob({
      state: "waiting_review",
      request: {
        kind: "human_gate",
        gateKind: "customer_approval",
        targetId: id("8"),
        targetVersionId: id("9"),
      },
    });

    expect(rebaseParticipantDerivedFields("jobs", succeeded, map).state).toBe(
      "succeeded",
    );
    expect(rebaseParticipantDerivedFields("jobs", gate, map)).toMatchObject({
      state: "waiting_review",
      request: gate.request,
      lease: null,
    });
  });

  it("publishes explicit rules for every request/approval/layout/preview/print family", () => {
    expect(IMPORT_DERIVED_HASH_RULES.jobs).toContain("requestHash");
    expect(IMPORT_DERIVED_HASH_RULES.book_approval_actions).toContain(
      "canonicalRequestHash",
    );
    expect(IMPORT_DERIVED_HASH_RULES.layout_versions).toContain("layoutHash");
    expect(IMPORT_DERIVED_HASH_RULES.preview_outputs).toContain(
      "previewSnapshotHash",
    );
    expect(IMPORT_DERIVED_HASH_RULES.print_runs).toContain(
      "contentAuthorizationHash",
    );
    expect(IMPORT_DERIVED_HASH_RULES.print_proof_bundles).toContain(
      "bundleHash",
    );
  });
});

function localRequest() {
  return { kind: "local" as const, payloadHash: hash("c") };
}

function baseJob(input: {
  state: "succeeded" | "waiting_review";
  request:
    | ReturnType<typeof localRequest>
    | {
        kind: "human_gate";
        gateKind: string;
        targetId: string;
        targetVersionId: string;
      };
}) {
  return jobRecordSchema.parse({
    id: id("4"),
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    revision: 1,
    jobType: input.request.kind === "human_gate" ? "human_gate" : "preview_pdf",
    projectId: id("5"),
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId: "historical-intent",
    idempotencyKey: hash("a"),
    requestHash: hash("b"),
    target: null,
    request: input.request,
    inputSnapshot: {},
    state: input.state,
    stateReason: null,
    resumeState: null,
    resumeReason: null,
    lease: null,
    attempts: 1,
    autoRetryIndex: 0,
    manualRetryCount: 0,
    retrySchedule: null,
    progress: null,
    failure: null,
    provenance: null,
    resultRefs: [],
    supersedesJobId: null,
    successorJobIds: [],
  });
}

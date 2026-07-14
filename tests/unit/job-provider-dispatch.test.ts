import { describe, expect, it, vi } from "vitest";

import {
  resolvedImageRequestSchema,
  structuredRequestSchema,
  textRequestSchema,
  type AiProvider,
  type Provenance,
} from "../../src/providers/contract.js";
import { makeFailure } from "../../src/providers/failures.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import type {
  PreDispatchCoordinator,
  PreparedDispatch,
} from "../../src/jobs/pre-dispatch.js";
import {
  createProviderJobDefinition,
  ProviderDispatchGateway,
} from "../../src/jobs/provider-dispatch.js";
import {
  jobRecordSchema,
  localJobRequestSchema,
} from "../../src/jobs/schemas.js";
import { generationTask } from "../helpers/provider-fixtures.js";

const hash = "5".repeat(64);
const now = "2026-07-14T00:00:00.000Z";
const control = { signal: new AbortController().signal, timeoutMs: 1_000 };

describe("provider job dispatch boundary", () => {
  it.each(["text", "structured", "image"] as const)(
    "dispatches only the exact %s operation and preserves provenance",
    async (operation) => {
      const calls: string[] = [];
      const exactGateway = gateway(provider(calls));
      const result = await exactGateway.execute(
        job(operation),
        prepared(operation),
        control,
      );
      expect(result).toMatchObject({
        ok: true,
        provenance: { provider: "mock", modelId: model(operation) },
      });
      expect(calls).toEqual([operation]);
    },
  );

  it("returns a normalized provider failure without commit-side behavior", async () => {
    const failing = provider([]);
    failing.generateText = vi.fn().mockResolvedValue({
      ok: false,
      failure: makeFailure("timeout"),
    });
    await expect(
      gateway(failing).execute(job("text"), prepared("text"), control),
    ).resolves.toMatchObject({
      ok: false,
      failure: { category: "timeout" },
    });
  });

  it.each([
    ["provider", { provider: "gemini" }],
    ["model", { modelId: "silent-substitute" }],
  ] as const)(
    "rejects a %s provenance substitution",
    async (_label, change) => {
      const substituted = provider([]);
      substituted.generateText = vi.fn().mockResolvedValue({
        ok: true,
        value: { text: "fixture" },
        provenance: { ...provenance("text"), ...change },
      });
      await expect(
        gateway(substituted).execute(job("text"), prepared("text"), control),
      ).rejects.toMatchObject({ code: "JOB_PROVENANCE_TARGET_MISMATCH" });
    },
  );

  it("rejects missing and mismatched immutable job targets before dispatch", async () => {
    const calls: string[] = [];
    const exact = gateway(provider(calls));
    await expect(
      exact.execute(
        { ...job("text"), target: null },
        prepared("text"),
        control,
      ),
    ).rejects.toMatchObject({ code: "JOB_TARGET_REQUIRED" });
    await expect(
      exact.execute(job("text"), prepared("image"), control),
    ).rejects.toMatchObject({ code: "JOB_REQUEST_TARGET_MISMATCH" });
    expect(calls).toEqual([]);
  });

  it("builds a registered definition that wires guard, dispatch, commit, and discard", async () => {
    const preparedValue = prepared("text");
    const prepare = vi.fn().mockResolvedValue(preparedValue);
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      value: { text: "fixture" },
      provenance: provenance("text"),
    });
    const commit = vi.fn().mockReturnValue({ resultRefs: ["result-1"] });
    const discard = vi.fn();
    const definition = createProviderJobDefinition({
      jobType: "fixture_provider",
      requestSchema: localJobRequestSchema,
      validateEnqueue: vi.fn(),
      guard: { assertCurrent: vi.fn() },
      preDispatch: { prepare } as unknown as PreDispatchCoordinator,
      gateway: { execute } as unknown as ProviderDispatchGateway,
      commit,
      discard,
    });
    const fixtureJob = job("text");
    const preparedResult = await definition.prepare(fixtureJob, "batch");
    const execution = await definition.execute({
      job: fixtureJob,
      prepared: preparedResult,
      ...control,
    });
    expect(execution).toMatchObject({ ok: true });
    expect(
      definition.commit({
        job: fixtureJob,
        value: { text: "fixture" },
        provenance: provenance("text"),
      }),
    ).toEqual({ resultRefs: ["result-1"] });
    await definition.discard?.("fixture");
    expect(prepare).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
  });
});

function gateway(exactProvider: AiProvider): ProviderDispatchGateway {
  return new ProviderDispatchGateway(new ProviderRegistry([exactProvider]));
}

function provider(calls: string[]): AiProvider {
  return {
    providerId: "mock",
    getCapabilities: async () => {
      throw new Error("UNREACHABLE");
    },
    testConnection: async () => {
      throw new Error("UNREACHABLE");
    },
    generateText: async () => {
      calls.push("text");
      return {
        ok: true,
        value: { text: "fixture" },
        provenance: provenance("text"),
      };
    },
    generateStructured: async <T>() => {
      calls.push("structured");
      return {
        ok: true,
        value: { schemaVersion: 1 } as T,
        provenance: provenance("structured"),
      };
    },
    generateImage: async () => {
      calls.push("image");
      return {
        ok: true,
        value: { imageBytes: new Uint8Array([1]), mime: "image/png" },
        provenance: provenance("image"),
      };
    },
  };
}

function job(operation: "text" | "structured" | "image") {
  return jobRecordSchema.parse({
    id: "01J00000000000000000000000",
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    jobType: "fixture_provider",
    projectId: "01J00000000000000000000001",
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    createdSequence: 0,
    intentId: "provider-intent",
    idempotencyKey: hash,
    requestHash: hash,
    target: {
      providerId: "mock",
      modelId: model(operation),
      operation,
      settingsHash: hash,
    },
    request: { kind: "local", payloadHash: hash },
    inputSnapshot: {},
    state: "queued",
    stateReason: null,
    resumeState: null,
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
  });
}

function prepared(
  operation: "text" | "structured" | "image",
): PreparedDispatch {
  const target = job(operation).target!;
  return {
    operation,
    ticket: {
      ...target,
      batchId: "batch",
      checkedAt: now,
      expiresAtMono: 300_000,
    },
    request:
      operation === "text"
        ? textRequestSchema.parse({
            task: generationTask("StoryPlan"),
            purpose: "rewrite",
          })
        : operation === "structured"
          ? structuredRequestSchema.parse({
              schemaId: "StoryPlan",
              task: generationTask("StoryPlan"),
              languageDirectives: {
                storyDialect: "egyptian_arabic",
                register: "عربي بسيط",
                ageBand: "age_6_8",
              },
            })
          : resolvedImageRequestSchema.parse({
              schemaVersion: 1,
              styleId: "modern_cartoon",
              scene: {
                pageNumber: 1,
                description: "مشهد اصطناعي",
                participants: [],
                environment: "حديقة",
                composition: "متوازنة",
                cameraFraming: "متوسط",
              },
              referenceImages: [],
              negativeConstraints: ["no_extra_people"],
              output: { minWidthPx: 1024, minHeightPx: 1024 },
            }),
  };
}

function provenance(operation: "text" | "structured" | "image"): Provenance {
  return {
    provider: "mock",
    modelId: model(operation),
    at: now,
    inputVersionRefs: {},
    promptVersion: "fixture-v1",
    referenceAssetIds: [],
    attempt: 1,
    settingsSnapshotHash: hash,
  };
}

function model(operation: "text" | "structured" | "image"): string {
  return operation === "image" ? "mock-image-v1" : "mock-text-v1";
}

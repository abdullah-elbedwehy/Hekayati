import { describe, expect, it } from "vitest";

import { CapabilityCache } from "../../src/providers/capability-cache.js";
import {
  structuredRequestSchema,
  textRequestSchema,
  type AiProvider,
  type ProviderCapabilities,
} from "../../src/providers/contract.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { ExactCapabilityBroker } from "../../src/jobs/capabilities.js";
import { JobError } from "../../src/jobs/errors.js";
import {
  PreDispatchCoordinator,
  type ImageReferenceResolver,
} from "../../src/jobs/pre-dispatch.js";
import { jobRecordSchema, type JobRecord } from "../../src/jobs/schemas.js";
import { generationTask } from "../helpers/provider-fixtures.js";

const hash = "e".repeat(64);

describe("job pre-dispatch", () => {
  it("guards, inspects, checks the exact target, guards again, then loads", async () => {
    const trace: string[] = [];
    const resolver = tracedResolver(trace);
    const coordinator = new PreDispatchCoordinator(
      {
        acquireExact: async ({ batchId, target }) => {
          trace.push("capability");
          return { ...target, batchId, checkedAt: now, expiresAtMono: 300_000 };
        },
      },
      resolver,
    );
    const prepared = await coordinator.prepare(
      imageJob(),
      {
        assertCurrent: () => {
          trace.push("guard");
        },
      },
      "batch-1",
    );
    expect(trace).toEqual([
      "guard",
      "inspect",
      "capability",
      "guard",
      "inspect",
      "load",
    ]);
    expect(prepared.request).toHaveProperty("schemaVersion", 1);
  });

  it("makes no capability or byte-load call when the initial guard rejects", async () => {
    const trace: string[] = [];
    const coordinator = new PreDispatchCoordinator(
      {
        acquireExact: async () => {
          trace.push("capability");
          throw new Error("UNREACHABLE");
        },
      },
      tracedResolver(trace),
    );
    await expect(
      coordinator.prepare(
        imageJob(),
        {
          assertCurrent: () => {
            trace.push("guard");
            throw new JobError("PHOTO_CONSENT_NOT_GRANTED");
          },
        },
        "batch-1",
      ),
    ).rejects.toMatchObject({ code: "PHOTO_CONSENT_NOT_GRANTED" });
    expect(trace).toEqual(["guard"]);
  });

  it.each([
    "PHOTO_CONSENT_NOT_RECORDED",
    "PHOTO_CONSENT_NOT_GRANTED",
    "JOB_REFERENCE_ASSET_MISSING",
    "JOB_REFERENCE_ASSET_INELIGIBLE",
    "SHEET_NOT_APPROVED",
    "SHEET_REFERENCE_MISMATCH",
  ])(
    "stops before capability and bytes when metadata rejects with %s",
    async (code) => {
      const trace: string[] = [];
      const coordinator = new PreDispatchCoordinator(
        {
          acquireExact: async () => {
            trace.push("capability");
            throw new Error("UNREACHABLE");
          },
        },
        {
          inspect: async () => {
            trace.push("inspect");
            throw new JobError(code);
          },
          load: async () => {
            trace.push("load");
            throw new Error("UNREACHABLE");
          },
        },
      );
      await expect(
        coordinator.prepare(
          imageJob(),
          {
            assertCurrent: () => {
              trace.push("guard");
            },
          },
          "batch-1",
        ),
      ).rejects.toMatchObject({ code });
      expect(trace).toEqual(["guard", "inspect"]);
    },
  );

  it("repeats the guard after capability and loads no bytes after revocation", async () => {
    const trace: string[] = [];
    let guardCount = 0;
    const coordinator = new PreDispatchCoordinator(
      {
        acquireExact: async ({ batchId, target }) => {
          trace.push("capability");
          return { ...target, batchId, checkedAt: now, expiresAtMono: 300_000 };
        },
      },
      tracedResolver(trace),
    );
    await expect(
      coordinator.prepare(
        imageJob(),
        {
          assertCurrent: () => {
            guardCount += 1;
            trace.push("guard");
            if (guardCount === 2)
              throw new JobError("PHOTO_CONSENT_NOT_RECORDED");
          },
        },
        "batch-1",
      ),
    ).rejects.toMatchObject({ code: "PHOTO_CONSENT_NOT_RECORDED" });
    expect(trace).toEqual(["guard", "inspect", "capability", "guard"]);
  });

  it("rejects a capability ticket that changes any immutable target field", async () => {
    const coordinator = new PreDispatchCoordinator(
      {
        acquireExact: async ({ batchId, target }) => ({
          ...target,
          modelId: "silent-substitute",
          batchId,
          checkedAt: now,
          expiresAtMono: 300_000,
        }),
      },
      tracedResolver([]),
    );
    await expect(
      coordinator.prepare(
        imageJob(),
        { assertCurrent: () => undefined },
        "batch",
      ),
    ).rejects.toMatchObject({ code: "JOB_CAPABILITY_TARGET_MISMATCH" });
  });

  it("loads one exact capability per bounded batch without fallback", async () => {
    let calls = 0;
    const provider = fakeProvider(() => {
      calls += 1;
      return capabilities();
    });
    const broker = new ExactCapabilityBroker(
      new ProviderRegistry([provider]),
      new CapabilityCache({ now: () => 10 }),
      () => 10,
    );
    const input = {
      batchId: "batch-1",
      target: imageJob().target!,
      referenceCount: 0,
      participantCount: 0,
    };
    await broker.acquireExact(input);
    await broker.acquireExact(input);
    expect(calls).toBe(1);
    await broker.acquireExact({ ...input, batchId: "batch-2" });
    expect(calls).toBe(2);
    await expect(
      broker.acquireExact({
        ...input,
        target: { ...input.target, modelId: "not-the-configured-model" },
      }),
    ).rejects.toMatchObject({ code: "JOB_PROVIDER_MODEL_UNAVAILABLE" });
  });

  it.each(["text", "structured"] as const)(
    "prepares a schema-valid %s request without touching image references",
    async (operation) => {
      const trace: string[] = [];
      const coordinator = new PreDispatchCoordinator(
        {
          acquireExact: async ({ batchId, target }) => {
            trace.push("capability");
            return {
              ...target,
              batchId,
              checkedAt: now,
              expiresAtMono: 300_000,
            };
          },
        },
        tracedResolver(trace),
      );
      const prepared = await coordinator.prepare(
        providerJob(operation),
        {
          assertCurrent: () => {
            trace.push("guard");
          },
        },
        "batch-1",
      );
      expect(prepared.operation).toBe(operation);
      expect(trace).toEqual(["guard", "capability", "guard"]);
    },
  );

  it("rejects missing and request-mismatched targets before any guard or capability", async () => {
    const trace: string[] = [];
    const coordinator = new PreDispatchCoordinator(
      {
        acquireExact: async () => {
          trace.push("capability");
          throw new Error("UNREACHABLE");
        },
      },
      tracedResolver(trace),
    );
    await expect(
      coordinator.prepare(
        { ...imageJob(), target: null },
        {
          assertCurrent: () => {
            trace.push("guard");
          },
        },
        "batch",
      ),
    ).rejects.toMatchObject({ code: "JOB_TARGET_REQUIRED" });
    await expect(
      coordinator.prepare(
        {
          ...providerJob("text"),
          target: { ...providerJob("text").target!, operation: "image" },
        },
        {
          assertCurrent: () => {
            trace.push("guard");
          },
        },
        "batch",
      ),
    ).rejects.toMatchObject({ code: "JOB_REQUEST_TARGET_MISMATCH" });
    expect(trace).toEqual([]);
  });
});

const now = "2026-07-14T00:00:00.000Z";

function imageJob(): JobRecord {
  return jobRecordSchema.parse({
    id: "01J00000000000000000000000",
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    jobType: "fixture_image",
    projectId: "01J00000000000000000000001",
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    createdSequence: 0,
    intentId: "image-intent",
    idempotencyKey: hash,
    requestHash: hash,
    target: {
      providerId: "mock",
      modelId: "mock-image-v1",
      operation: "image",
      settingsHash: hash,
    },
    request: {
      kind: "image",
      request: {
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
      },
    },
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

function providerJob(operation: "text" | "structured"): JobRecord {
  const task = generationTask("StoryPlan");
  return jobRecordSchema.parse({
    ...imageJob(),
    target: {
      providerId: "mock",
      modelId: "mock-text-v1",
      operation,
      settingsHash: hash,
    },
    request:
      operation === "text"
        ? {
            kind: "text",
            request: textRequestSchema.parse({ task, purpose: "rewrite" }),
          }
        : {
            kind: "structured",
            request: structuredRequestSchema.parse({
              schemaId: "StoryPlan",
              task,
              languageDirectives: task.languageDirectives,
            }),
          },
  });
}

function tracedResolver(trace: string[]): ImageReferenceResolver {
  return {
    inspect: async () => {
      trace.push("inspect");
      return [];
    },
    load: async (draft) => {
      trace.push("load");
      return { ...draft, schemaVersion: 1, referenceImages: [] };
    },
  };
}

function fakeProvider(load: () => ProviderCapabilities): AiProvider {
  return {
    providerId: "mock",
    getCapabilities: async () => load(),
    testConnection: async () => ({ ok: true, capabilities: load() }),
    generateText: async () => {
      throw new Error("UNREACHABLE");
    },
    generateStructured: async () => {
      throw new Error("UNREACHABLE");
    },
    generateImage: async () => {
      throw new Error("UNREACHABLE");
    },
  };
}

function capabilities(): ProviderCapabilities {
  return {
    providerId: "mock",
    checkedAt: now,
    source: "fixture",
    auth: { state: "ok", detail: "fixture" },
    text: { available: true, structured: true, modelId: "mock-text-v1" },
    image: {
      available: true,
      modelId: "mock-image-v1",
      maxReferenceImages: 10,
      reliableCharacterCount: 6,
      economyTier: true,
    },
    limits: { concurrencySuggested: 2 },
  };
}

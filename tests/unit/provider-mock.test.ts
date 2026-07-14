import { describe, expect, it } from "vitest";

import {
  structuredRequestSchema,
  type ResolvedImageRequest,
  type StructuredRequest,
} from "../../src/providers/contract.js";
import { failureCategorySchema } from "../../src/providers/failures.js";
import type { StructuredSchemaId } from "../../src/providers/generation-task.js";
import { MockProvider } from "../../src/providers/mock/adapter.js";
import { MockFaultScript } from "../../src/providers/mock/fault-script.js";
import { generationTask } from "../helpers/provider-fixtures.js";

const fixedTime = "2026-07-14T12:00:00.000Z";

describe("deterministic mock provider", () => {
  it("returns honest fixture capabilities without network state", async () => {
    const provider = mockProvider();
    await expect(provider.getCapabilities()).resolves.toMatchObject({
      providerId: "mock",
      source: "fixture",
      auth: { state: "ok" },
      text: { available: true, structured: true, modelId: "mock-v1" },
      image: {
        available: true,
        maxReferenceImages: 20,
        reliableCharacterCount: 20,
      },
    });
    await expect(provider.testConnection()).resolves.toMatchObject({
      ok: true,
    });
  });

  it("is stable for identical tasks and changes with the request hash", async () => {
    const provider = mockProvider();
    const request = structuredRequest("StoryPlan");
    const first = await provider.generateStructured(request, control());
    const second = await provider.generateStructured(request, control());
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      provenance: {
        provider: "mock",
        modelId: "mock-v1",
        at: fixedTime,
      },
    });
    const changedTask = generationTask("StoryPlan");
    if (changedTask.schemaId !== "StoryPlan") throw new Error("fixture");
    changedTask.payload.premise = "مغامرة مختلفة تمامًا";
    const changed = await provider.generateStructured(
      { ...request, task: changedTask },
      control(),
    );
    expect(changed).not.toEqual(first);
  });

  it("scripts every canonical failure without throwing or retrying", async () => {
    for (const category of failureCategorySchema.options) {
      const cases = [
        {
          operation: "text" as const,
          run: (provider: MockProvider) =>
            provider.generateText(
              {
                task: generationTask("ReviewFindings"),
                purpose: "review_note",
              },
              control(),
            ),
        },
        {
          operation: "structured" as const,
          run: (provider: MockProvider) =>
            provider.generateStructured(
              structuredRequest("StoryPlan"),
              control(),
            ),
        },
        {
          operation: "image" as const,
          run: (provider: MockProvider) =>
            provider.generateImage(imageRequest(), control()),
        },
        {
          operation: "connection" as const,
          run: (provider: MockProvider) => provider.testConnection(),
        },
      ];
      for (const fixture of cases) {
        const faults = new MockFaultScript([
          { operation: fixture.operation, category },
        ]);
        const result = await fixture.run(mockProvider(faults));
        expect(result, `${fixture.operation}:${category}`).toMatchObject({
          ok: false,
          failure: { category },
        });
        expect(faults.consumed).toBe(1);
      }
    }
  });

  it("normalizes timeout, cancellation, and malformed structured output", async () => {
    const timeout = mockProvider(
      new MockFaultScript([{ operation: "structured", latencyMs: 100 }]),
    );
    await expect(
      timeout.generateStructured(structuredRequest("StoryPlan"), control(5)),
    ).resolves.toMatchObject({
      ok: false,
      failure: { category: "timeout" },
    });

    const controller = new AbortController();
    const canceled = mockProvider(
      new MockFaultScript([{ operation: "text", latencyMs: 100 }]),
    );
    const pending = canceled.generateText(
      { task: generationTask("ReviewFindings"), purpose: "review_note" },
      control(500, controller.signal),
    );
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      failure: { category: "user_canceled" },
    });

    const canary = "PRIVATE-MOCK-OUTPUT-CANARY";
    const malformed = mockProvider(
      new MockFaultScript([
        {
          operation: "structured",
          rawStructured: JSON.stringify({ schemaVersion: 1, private: canary }),
        },
      ]),
    );
    const result = await malformed.generateStructured(
      structuredRequest("StoryPlan"),
      control(),
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { category: "output_validation_failed" },
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it("returns deterministic PNG bytes and exact reference provenance", async () => {
    const provider = mockProvider();
    const request = imageRequest();
    const first = await provider.generateImage(request, control());
    const second = await provider.generateImage(request, control());
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      value: { mime: "image/png" },
      provenance: { referenceAssetIds: ["asset-clean-1"] },
    });
    if (!first.ok) throw new Error("fixture");
    expect(Buffer.from(first.value.imageBytes).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  });

  it("generates locally valid deterministic values for every structured schema", async () => {
    for (const schemaId of [
      "StoryPlan",
      "StoryText",
      "SceneList",
      "PagePrompt",
      "ReviewFindings",
    ] as const) {
      await expect(
        mockProvider().generateStructured(
          structuredRequest(schemaId),
          control(),
        ),
      ).resolves.toMatchObject({ ok: true });
    }
  });

  it("rejects invalid requests and honors connection, structured, and image faults", async () => {
    const connectionFaults = new MockFaultScript([
      { operation: "connection", category: "network_failure" },
    ]);
    await expect(
      mockProvider(connectionFaults).testConnection(),
    ).resolves.toMatchObject({
      ok: false,
      failure: { category: "network_failure" },
    });
    await expect(
      mockProvider().generateText({} as never, control()),
    ).resolves.toMatchObject({ failure: { category: "invalid_input" } });
    await expect(
      mockProvider().generateStructured({} as never, control()),
    ).resolves.toMatchObject({ failure: { category: "invalid_input" } });
    await expect(
      mockProvider().generateImage({} as never, control()),
    ).resolves.toMatchObject({ failure: { category: "invalid_input" } });
    await expect(
      mockProvider(
        new MockFaultScript([
          { operation: "image", category: "safety_refusal" },
        ]),
      ).generateImage(imageRequest(), control()),
    ).resolves.toMatchObject({
      failure: { category: "safety_refusal" },
    });
  });
});

function mockProvider(faults = new MockFaultScript()) {
  return new MockProvider({
    clock: () => new Date(fixedTime),
    faults,
    settings: { textProvider: "mock", imageProvider: "mock" },
  });
}

function structuredRequest(schemaId: StructuredSchemaId): StructuredRequest {
  const task = generationTask(schemaId);
  return structuredRequestSchema.parse({
    schemaId,
    task,
    languageDirectives: task.languageDirectives,
  });
}

function control(timeoutMs = 1_000, signal = new AbortController().signal) {
  return { timeoutMs, signal };
}

function imageRequest(): ResolvedImageRequest {
  return {
    schemaVersion: 1,
    styleId: "modern_cartoon",
    scene: {
      pageNumber: 1,
      description: "نور في الحديقة",
      participants: [
        {
          characterRef: {
            characterId: "character-a",
            characterVersionId: "character-version-a",
          },
          action: "تجري",
          emotion: "سعيدة",
          lookId: "look-a",
        },
      ],
      environment: "حديقة",
      composition: "متوازنة",
      cameraFraming: "متوسط",
    },
    referenceImages: [
      {
        source: "reference_photo",
        sourceRecordId: "photo-1",
        customerId: "customer-1",
        familyId: "family-1",
        characterId: "character-a",
        versionRefs: { characterVersionId: "character-version-a" },
        provenanceAssetId: "asset-clean-1",
        mime: "image/png",
        bytes: new Uint8Array([137, 80, 78, 71]),
      },
    ],
    negativeConstraints: ["no_extra_people"],
    output: { minWidthPx: 2480, minHeightPx: 3508 },
  };
}

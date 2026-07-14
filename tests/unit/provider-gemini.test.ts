import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { GeminiProvider } from "../../src/providers/gemini/adapter.js";
import { classifyGeminiError } from "../../src/providers/gemini/classify.js";
import type {
  GeminiGenerateRequest,
  GeminiModelInfo,
  GeminiTransport,
  GeminiTransportResponse,
} from "../../src/providers/gemini/client.js";
import type { ResolvedImageRequest } from "../../src/providers/contract.js";
import { generationTask, outputFixture } from "../helpers/provider-fixtures.js";

describe("Gemini adapter", () => {
  it("fails closed without a key and probes exact configured models when present", async () => {
    const missingCredential = new FixtureCredential(null);
    const missingTransport = new FixtureGeminiTransport();
    const missing = await provider(
      missingCredential,
      missingTransport,
    ).getCapabilities();
    expect(missing).toMatchObject({
      auth: { state: "missing" },
      text: { available: false },
      image: { available: false },
    });
    expect(missingTransport.modelCalls).toHaveLength(0);

    const credential = new FixtureCredential(testCredential());
    const transport = readyTransport([
      response({
        modelVersion: "gemini-text-test",
        parts: [{ text: '{"probe":"ok"}' }],
      }),
    ]);
    const capabilities = await provider(
      credential,
      transport,
    ).getCapabilities();
    expect(capabilities).toMatchObject({
      auth: { state: "ok" },
      text: { available: true, modelId: "gemini-text-test" },
      image: {
        available: false,
        modelId: "gemini-image-test",
        maxReferenceImages: null,
        reliableCharacterCount: null,
        unavailableReason: expect.stringContaining("تُقَس"),
      },
    });
    expect(credential.reads).toBe(1);
    expect(transport.modelCalls.map((call) => call.modelId)).toEqual([
      "gemini-text-test",
      "gemini-image-test",
    ]);
    expect(transport.generateCalls[0]?.request).toMatchObject({
      modelId: "gemini-text-test",
      responseMimeType: "application/json",
      responseJsonSchema: expect.any(Object),
    });
  });

  it("requests provider-side JSON schema and revalidates locally", async () => {
    const credential = new FixtureCredential(testCredential());
    const task = generationTask("StoryPlan");
    const transport = readyTransport([
      response({
        modelVersion: "gemini-text-test",
        parts: [{ text: JSON.stringify(outputFixture("StoryPlan")) }],
      }),
    ]);
    const result = await provider(credential, transport).generateStructured(
      {
        schemaId: "StoryPlan",
        task,
        languageDirectives: task.languageDirectives,
      },
      control(),
    );
    expect(result).toMatchObject({
      ok: true,
      provenance: { provider: "gemini", modelId: "gemini-text-test" },
    });
    expect(transport.generateCalls[0]?.request).toMatchObject({
      modelId: "gemini-text-test",
      responseMimeType: "application/json",
      responseJsonSchema: expect.any(Object),
    });
    expect(credential.reads).toBe(1);

    const canary = "PRIVATE-GEMINI-OUTPUT-CANARY";
    const invalidTransport = readyTransport([
      response({
        modelVersion: "gemini-text-test",
        parts: [
          { text: JSON.stringify({ schemaVersion: 1, private: canary }) },
        ],
      }),
    ]);
    const invalid = await provider(
      new FixtureCredential(testCredential()),
      invalidTransport,
    ).generateStructured(
      {
        schemaId: "StoryPlan",
        task,
        languageDirectives: task.languageDirectives,
      },
      control(),
    );
    expect(invalid).toMatchObject({
      ok: false,
      failure: { category: "output_validation_failed" },
    });
    expect(JSON.stringify(invalid)).not.toContain(canary);
  });

  it("retrieves the key for every call and rejects response model drift", async () => {
    const credential = new FixtureCredential(testCredential());
    const transport = readyTransport([
      response({
        modelVersion: "gemini-text-test",
        parts: [{ text: "أول نص" }],
      }),
      response({
        modelVersion: "different-model",
        parts: [{ text: "ثاني نص" }],
      }),
    ]);
    const adapter = provider(credential, transport);
    const request = {
      task: generationTask("ReviewFindings"),
      purpose: "review_note" as const,
    };
    await expect(
      adapter.generateText(request, control()),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      adapter.generateText(request, control()),
    ).resolves.toMatchObject({
      ok: false,
      failure: { category: "provider_unavailable" },
    });
    expect(credential.reads).toBe(2);
    expect(transport.generateCalls).toHaveLength(2);
    expect(
      transport.generateCalls.every((call) => call.apiKey === testCredential()),
    ).toBe(true);
  });

  it("uses the economy image model and accepts exactly one decodable matching image", async () => {
    const png = await sharp({
      create: {
        width: 300,
        height: 300,
        channels: 4,
        background: { r: 255, g: 190, b: 60, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const transport = readyTransport([
      response({
        modelVersion: "gemini-image-economy-test",
        parts: [
          {
            inlineData: { mimeType: "image/png", data: png.toString("base64") },
          },
        ],
      }),
    ]);
    const result = await provider(
      new FixtureCredential(testCredential()),
      transport,
      { tier: "economy", maxReferenceImages: 4, reliableCharacterCount: 4 },
    ).generateImage(imageRequest(), control());
    expect(result).toMatchObject({
      ok: true,
      value: { mime: "image/png" },
      provenance: {
        modelId: "gemini-image-economy-test",
        referenceAssetIds: ["asset-clean-1"],
      },
    });
    expect(transport.generateCalls[0]?.request).toMatchObject({
      modelId: "gemini-image-economy-test",
      responseModalities: ["Image"],
    });
    expect(transport.generateCalls[0]?.request.contents).toHaveLength(2);
    const payload = JSON.stringify(transport.generateCalls[0]?.request);
    expect(payload).not.toContain("customer-1");
    expect(payload).not.toContain("family-1");
    expect(payload).not.toContain("asset-clean-1");
    expect(payload).not.toContain("photo-1");
    expect(payload).not.toMatch(/localPath|consent|original|secret/i);
  });

  it("rejects text-only, multiple, corrupt, and MIME-mismatched image responses", async () => {
    const png = await sharp({
      create: {
        width: 300,
        height: 300,
        channels: 3,
        background: { r: 10, g: 120, b: 70 },
      },
    })
      .png()
      .toBuffer();
    const variants: GeminiTransportResponse[] = [
      response({ parts: [{ text: "no image" }] }),
      response({
        parts: [
          {
            inlineData: { mimeType: "image/png", data: png.toString("base64") },
          },
          {
            inlineData: { mimeType: "image/png", data: png.toString("base64") },
          },
        ],
      }),
      response({
        parts: [
          { inlineData: { mimeType: "image/png", data: "bm90LWltYWdl" } },
        ],
      }),
      response({
        parts: [
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: png.toString("base64"),
            },
          },
        ],
      }),
    ];
    for (const variant of variants) {
      const transport = readyTransport([
        { ...variant, modelVersion: "gemini-image-test" },
      ]);
      const result = await provider(
        new FixtureCredential(testCredential()),
        transport,
        { maxReferenceImages: 4, reliableCharacterCount: 4 },
      ).generateImage(imageRequest(), control());
      expect(result).toMatchObject({
        ok: false,
        failure: { category: "malformed_output" },
      });
      expect(transport.generateCalls).toHaveLength(1);
    }
  });

  it("normalizes provider errors once without retry or raw leakage", async () => {
    const cases = [
      [
        { status: 401, message: "secret unauthorized body" },
        "invalid_credentials",
      ],
      [
        { status: 429, message: "RESOURCE_EXHAUSTED quota exceeded" },
        "quota_exhausted",
      ],
      [{ status: 429, message: "too many requests" }, "rate_limited"],
      [{ status: 503, message: "connection reset" }, "network_failure"],
      [{ status: 400, message: "model not found" }, "provider_unavailable"],
      [{ status: 400, message: "blocked by safety" }, "safety_refusal"],
    ] as const;
    for (const [error, expected] of cases) {
      expect(classifyGeminiError(error)).toBe(expected);
      const transport = readyTransport([error]);
      const result = await provider(
        new FixtureCredential(testCredential()),
        transport,
      ).generateText(
        { task: generationTask("ReviewFindings"), purpose: "review_note" },
        control(),
      );
      expect(result).toMatchObject({
        ok: false,
        failure: { category: expected },
      });
      expect(JSON.stringify(result)).not.toContain("secret unauthorized body");
      expect(transport.generateCalls).toHaveLength(1);
    }
  });
});

class FixtureCredential {
  reads = 0;
  constructor(private readonly value: string | null) {}
  read(): Promise<string | null> {
    this.reads += 1;
    return Promise.resolve(this.value);
  }
}

class FixtureGeminiTransport implements GeminiTransport {
  readonly modelCalls: Array<{ apiKey: string; modelId: string }> = [];
  readonly generateCalls: Array<{
    apiKey: string;
    request: GeminiGenerateRequest;
  }> = [];
  readonly modelInfos = new Map<string, GeminiModelInfo>();

  constructor(
    private readonly responses: Array<GeminiTransportResponse | object> = [],
  ) {}

  getModel(apiKey: string, modelId: string): Promise<GeminiModelInfo> {
    this.modelCalls.push({ apiKey, modelId });
    const value = this.modelInfos.get(modelId);
    if (!value) return Promise.reject(fixtureError(404, "model not found"));
    return Promise.resolve(value);
  }

  generate(
    apiKey: string,
    request: GeminiGenerateRequest,
  ): Promise<GeminiTransportResponse> {
    this.generateCalls.push({ apiKey, request });
    const value = this.responses.shift();
    if (!value) return Promise.reject(fixtureError(500, "fixture missing"));
    if ("candidateCount" in value) return Promise.resolve(value);
    const error = value as { status?: number; message?: string };
    return Promise.reject(
      fixtureError(error.status ?? 500, error.message ?? "fixture error"),
    );
  }
}

function fixtureError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function readyTransport(
  responses: Array<GeminiTransportResponse | object> = [],
) {
  const transport = new FixtureGeminiTransport(responses);
  for (const modelId of [
    "gemini-text-test",
    "gemini-image-test",
    "gemini-image-economy-test",
  ]) {
    transport.modelInfos.set(modelId, {
      name: `models/${modelId}`,
      supportedActions: ["generateContent"],
    });
  }
  return transport;
}

function provider(
  credential: FixtureCredential,
  transport: GeminiTransport,
  overrides: {
    tier?: "default" | "economy";
    maxReferenceImages?: number | null;
    reliableCharacterCount?: number | null;
  } = {},
) {
  return new GeminiProvider({
    credential,
    transport,
    configuration: () => ({
      textModelId: "gemini-text-test",
      imageModelId: "gemini-image-test",
      economyImageModelId: "gemini-image-economy-test",
      imageTier: overrides.tier ?? "default",
      maxReferenceImages: overrides.maxReferenceImages ?? null,
      reliableCharacterCount: overrides.reliableCharacterCount ?? null,
    }),
    clock: () => new Date("2026-07-14T12:00:00.000Z"),
    settings: () => ({ provider: "gemini", tier: overrides.tier ?? "default" }),
  });
}

function response(
  patch: Partial<GeminiTransportResponse> = {},
): GeminiTransportResponse {
  return {
    modelVersion: "gemini-image-test",
    responseId: "fixture-response",
    candidateCount: 1,
    parts: [],
    finishReason: "STOP",
    safetyRatings: [],
    ...patch,
  };
}

function control(timeoutMs = 1_000) {
  return { signal: new AbortController().signal, timeoutMs };
}

function testCredential(): string {
  return ["GEMINI", "FIXTURE", "CREDENTIAL"].join("-");
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
    output: { minWidthPx: 256, minHeightPx: 256 },
  };
}

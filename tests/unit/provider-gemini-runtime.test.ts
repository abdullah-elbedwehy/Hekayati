import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  apiKeys: [] as string[],
  get: vi.fn(),
  generateContent: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    readonly models = {
      get: sdk.get,
      generateContent: sdk.generateContent,
    };

    constructor(input: { apiKey: string }) {
      sdk.apiKeys.push(input.apiKey);
    }
  },
}));

import { classifyGeminiError } from "../../src/providers/gemini/classify.js";
import { GoogleGenAiTransport } from "../../src/providers/gemini/client.js";
import { controlledGeminiCall } from "../../src/providers/gemini/control.js";
import {
  parseGeminiImage,
  parseGeminiText,
} from "../../src/providers/gemini/output-parser.js";
import type { GeminiTransportResponse } from "../../src/providers/gemini/client.js";

beforeEach(() => {
  sdk.apiKeys.length = 0;
  sdk.get.mockReset();
  sdk.generateContent.mockReset();
});

describe("official Gemini SDK transport", () => {
  it("creates a per-call client and forwards exact model plus abort signal", async () => {
    const signal = new AbortController().signal;
    sdk.get.mockResolvedValue({
      name: "models/gemini-exact",
      supportedActions: ["generateContent"],
    });
    const result = await new GoogleGenAiTransport().getModel(
      "key-one",
      "gemini-exact",
      signal,
    );
    expect(result).toEqual({
      name: "models/gemini-exact",
      supportedActions: ["generateContent"],
    });
    expect(sdk.apiKeys).toEqual(["key-one"]);
    expect(sdk.get).toHaveBeenCalledWith({
      model: "gemini-exact",
      config: { abortSignal: signal },
    });
  });

  it("maps text/image parts, safety detail, schema, and sparse responses", async () => {
    sdk.generateContent
      .mockResolvedValueOnce({
        modelVersion: "gemini-exact",
        responseId: "response-1",
        candidates: [
          {
            content: {
              parts: [
                { text: "hello" },
                { inlineData: { mimeType: "image/png", data: "cG5n" } },
              ],
            },
            finishReason: "SAFETY",
            safetyRatings: [{ category: "HARM", blocked: true }],
          },
          { content: { parts: [{ text: "second" }] } },
        ],
        promptFeedback: { blockReason: "SAFETY" },
      })
      .mockResolvedValueOnce({ candidates: undefined });
    const signal = new AbortController().signal;
    const transport = new GoogleGenAiTransport();
    const rich = await transport.generate(
      "key-two",
      {
        modelId: "gemini-exact",
        contents: [
          { text: "prompt" },
          { inlineData: { mimeType: "image/png", data: "cG5n" } },
        ],
        responseMimeType: "application/json",
        responseJsonSchema: { type: "object" },
        responseModalities: ["Text", "Image"],
      },
      signal,
    );
    expect(rich).toMatchObject({
      modelVersion: "gemini-exact",
      responseId: "response-1",
      candidateCount: 2,
      finishReason: "SAFETY",
      safetyBlocked: true,
      safetyRatings: [{ category: "HARM", blocked: true }],
    });
    expect(rich.parts).toEqual([
      { text: "hello", inlineData: undefined },
      {
        text: undefined,
        inlineData: { mimeType: "image/png", data: "cG5n" },
      },
      { text: "second", inlineData: undefined },
    ]);
    expect(sdk.generateContent.mock.calls[0]?.[0]).toMatchObject({
      model: "gemini-exact",
      config: {
        abortSignal: signal,
        responseMimeType: "application/json",
        responseJsonSchema: { type: "object" },
        responseModalities: ["Text", "Image"],
      },
    });
    await expect(
      transport.generate(
        "key-three",
        { modelId: "gemini-empty", contents: [{ text: "prompt" }] },
        signal,
      ),
    ).resolves.toEqual({
      modelVersion: undefined,
      responseId: undefined,
      candidateCount: 0,
      parts: [],
      finishReason: undefined,
      safetyRatings: [],
      safetyBlocked: false,
    });
    expect(sdk.apiKeys).toEqual(["key-two", "key-three"]);
  });
});

describe("Gemini call control and classification", () => {
  it("suppresses pre-canceled, externally canceled, and late results", async () => {
    const preCanceled = new AbortController();
    preCanceled.abort();
    await expect(
      controlledGeminiCall({ signal: preCanceled.signal, timeoutMs: 100 }, () =>
        Promise.resolve("late"),
      ),
    ).resolves.toMatchObject({
      ok: false,
      failure: { category: "user_canceled" },
    });

    const controller = new AbortController();
    let resolveLate: (value: string) => void = () => undefined;
    let innerSignal: AbortSignal | undefined;
    const pending = controlledGeminiCall(
      { signal: controller.signal, timeoutMs: 100 },
      (signal) => {
        innerSignal = signal;
        return new Promise<string>((resolve) => {
          resolveLate = resolve;
        });
      },
    );
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      failure: { category: "user_canceled" },
    });
    expect(innerSignal?.aborted).toBe(true);
    resolveLate("too late");
    await Promise.resolve();
  });

  it("normalizes timeout, rejection, and success exactly once", async () => {
    let timedSignal: AbortSignal | undefined;
    await expect(
      controlledGeminiCall(
        { signal: new AbortController().signal, timeoutMs: 1 },
        (signal) => {
          timedSignal = signal;
          return new Promise<never>(() => undefined);
        },
      ),
    ).resolves.toMatchObject({ ok: false, failure: { category: "timeout" } });
    expect(timedSignal?.aborted).toBe(true);
    await expect(
      controlledGeminiCall(
        { signal: new AbortController().signal, timeoutMs: 100 },
        () =>
          Promise.reject(
            Object.assign(new Error("rate limit"), { status: 429 }),
          ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      failure: { category: "rate_limited" },
    });
    await expect(
      controlledGeminiCall(
        { signal: new AbortController().signal, timeoutMs: 100 },
        () => Promise.resolve("ok"),
      ),
    ).resolves.toEqual({ ok: true, value: "ok" });
  });

  it("classifies all SDK-safe signals without depending on raw messages", () => {
    const cases: Array<[unknown, string]> = [
      [{ name: "AbortError" }, "user_canceled"],
      [{ status: 403 }, "invalid_credentials"],
      [{ code: "RESOURCE_EXHAUSTED" }, "quota_exhausted"],
      [{ message: "throttled" }, "rate_limited"],
      [{ status: 504 }, "timeout"],
      [{ status: 500 }, "network_failure"],
      [{ message: "content policy blocked" }, "safety_refusal"],
      [{ status: 404 }, "provider_unavailable"],
      [{ message: "malformed json" }, "malformed_output"],
      ["primitive", "unknown"],
      [{ code: { private: true } }, "unknown"],
    ];
    for (const [error, category] of cases) {
      expect(classifyGeminiError(error)).toBe(category);
    }
  });
});

describe("Gemini output parsing", () => {
  it("accepts one text candidate and rejects every ambiguous text shape", () => {
    expect(parseGeminiText(response({ parts: [{ text: " أهلاً " }] }))).toEqual(
      {
        ok: true,
        value: "أهلاً",
      },
    );
    for (const invalid of [
      response({ safetyBlocked: true }),
      response({ candidateCount: 2 }),
      response({ parts: [{ inlineData: { data: "cG5n" } }] }),
      response({ parts: [{ text: "   " }, {}] }),
    ]) {
      expect(parseGeminiText(invalid)).toMatchObject({ ok: false });
    }
  });

  it("validates PNG, JPEG, and WEBP bytes plus safe provider metadata", async () => {
    const images = await Promise.all([
      imageBytes("png"),
      imageBytes("jpeg"),
      imageBytes("webp"),
    ]);
    for (const [index, bytes] of images.entries()) {
      const mime = ["image/png", "image/jpeg", "image/webp"][index];
      const result = await parseGeminiImage(
        response({
          modelVersion: "models/gemini exact",
          responseId: "response/unsafe",
          finishReason: "STOP!",
          safetyRatings: [{ category: "HARM CATEGORY", blocked: false }],
          parts: [
            {
              inlineData: { mimeType: mime, data: bytes.toString("base64") },
            },
          ],
        }),
        { width: 64, height: 64 },
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          mime,
          providerMeta: {
            responseId: "response_unsafe",
            modelVersion: "models_gemini_exact",
            finishReason: "STOP_",
            safetyRatings: [{ category: "HARM_CATEGORY", blocked: false }],
          },
        },
      });
    }
  });

  it("rejects safety, ambiguity, bad base64, bad magic, and undersized images", async () => {
    const png = await imageBytes("png", 32, 32);
    const invalid = [
      response({ safetyBlocked: true }),
      response({ candidateCount: 0 }),
      response({ parts: [] }),
      response({
        parts: [
          {
            inlineData: { mimeType: "image/png", data: png.toString("base64") },
          },
          { text: "ambiguous" },
        ],
      }),
      response({
        parts: [{ inlineData: { mimeType: "image/png", data: "***" } }],
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
      response({
        parts: [
          {
            inlineData: { mimeType: "image/png", data: png.toString("base64") },
          },
        ],
      }),
    ];
    for (const item of invalid) {
      await expect(
        parseGeminiImage(item, { width: 64, height: 64 }),
      ).resolves.toMatchObject({ ok: false });
    }
  });
});

function response(
  patch: Partial<GeminiTransportResponse> = {},
): GeminiTransportResponse {
  return {
    modelVersion: "gemini-exact",
    responseId: "response-1",
    candidateCount: 1,
    parts: [],
    finishReason: "STOP",
    safetyRatings: [],
    ...patch,
  };
}

function imageBytes(
  format: "png" | "jpeg" | "webp",
  width = 96,
  height = 96,
): Promise<Buffer> {
  const pipeline = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 190, b: 60 },
    },
  });
  return pipeline[format]().toBuffer();
}

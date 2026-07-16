import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  GeminiGenerateRequest,
  GeminiModelInfo,
  GeminiTransport,
  GeminiTransportResponse,
} from "../../src/providers/gemini/client.js";
import type {
  CodexExecutionRequest,
  CodexProcessResult,
  CodexRunner,
} from "../../src/providers/codex/process-runner.js";
import { createRuntime } from "../../src/server/app.js";
import type { KeychainPort } from "../../src/server/providers/gemini-credential-service.js";
import { httpRequest } from "../helpers/http.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("provider settings and credential API", () => {
  it("starts and serves health without touching Keychain, Codex, or Gemini", async () => {
    const fixture = await apiFixture();
    expect(fixture.keychain.calls).toEqual({ get: 0, set: 0, delete: 0 });
    expect(fixture.codex.inspections).toBe(0);
    expect(fixture.gemini.modelCalls).toHaveLength(0);
    expect(fixture.gemini.generateCalls).toHaveLength(0);

    const health = await getJson(fixture.origin, "/api/health");
    expect(health.providers).toMatchObject({
      status: "available",
      connections: {
        mock: { state: "not_checked" },
        codex: { state: "not_checked" },
        gemini: { state: "not_checked" },
      },
    });
    expect(fixture.keychain.calls.get).toBe(0);
    expect(fixture.codex.inspections).toBe(0);
    expect(fixture.gemini.modelCalls).toHaveLength(0);
  });

  it("saves, masks, replaces, restarts, and deletes a Keychain-only credential", async () => {
    const directory = await temporaryDirectory("hekayati-provider-api-");
    cleanups.push(directory.cleanup);
    const keychain = new MemoryKeychain();
    const first = await runtimeAt(directory.path, keychain);
    let bootstrap = await getJson(first.origin, "/api/bootstrap");
    const canary = syntheticCredential("lifecycle");
    const saved = await mutate(
      first.origin,
      bootstrap.csrfToken,
      "/api/providers/gemini/credential",
      "PUT",
      { key: canary },
    );
    expect(saved.status).toBe(200);
    expect(saved.headers["cache-control"]).toBe("no-store");
    expect(saved.body).toBe('{"present":true,"masked":"••••••••"}');
    expect(saved.body).not.toContain(canary);
    expect(keychain.value).toBe(canary);

    const status = await httpRequest(
      first.origin,
      "/api/providers/gemini/credential",
    );
    expect(status.body).toBe('{"present":true,"masked":"••••••••"}');
    expect(await readCorpus(first.runtime.paths.root)).not.toContain(canary);

    const settings = await getJson(first.origin, "/api/settings");
    const update = settingsUpdate(settings, { geminiImageTier: "economy" });
    const settingsResponse = await mutate(
      first.origin,
      bootstrap.csrfToken,
      "/api/settings",
      "PUT",
      update,
    );
    expect(settingsResponse.status).toBe(200);
    await first.runtime.close();

    const second = await runtimeAt(directory.path, keychain);
    cleanups.push(second.runtime.close);
    bootstrap = await getJson(second.origin, "/api/bootstrap");
    expect(await getJson(second.origin, "/api/settings")).toMatchObject({
      schemaVersion: 4,
      geminiImageTier: "economy",
    });
    expect(
      await getJson(second.origin, "/api/providers/gemini/credential"),
    ).toEqual({ present: true, masked: "••••••••" });

    const deleted = await mutate(
      second.origin,
      bootstrap.csrfToken,
      "/api/providers/gemini/credential",
      "DELETE",
    );
    expect(deleted.body).toBe('{"present":false,"masked":null}');
    expect(keychain.value).toBeNull();
    expect(await readCorpus(second.runtime.paths.root)).not.toContain(canary);
  });

  it("forces only the selected provider check and reuses a safe cache projection", async () => {
    const fixture = await apiFixture();
    fixture.keychain.value = syntheticCredential("check");
    const bootstrap = await getJson(fixture.origin, "/api/bootstrap");
    const gemini = await mutate(
      fixture.origin,
      bootstrap.csrfToken,
      "/api/providers/gemini/test",
      "POST",
    );
    expect(gemini.status).toBe(200);
    expect(JSON.parse(gemini.body)).toMatchObject({
      tested: "gemini",
      provider: {
        state: "available",
        source: "cache",
        text: { available: true },
        image: {
          available: false,
          maxReferenceImages: null,
          reliableCharacterCount: null,
        },
      },
    });
    expect(fixture.gemini.modelCalls).toHaveLength(2);
    expect(fixture.gemini.generateCalls).toHaveLength(1);
    expect(fixture.codex.inspections).toBe(0);

    const status = await getJson(fixture.origin, "/api/providers/status");
    expect(status.providers.gemini).toMatchObject({
      state: "available",
      source: "cache",
    });
    expect(status.selected).toEqual({ text: "mock", image: "mock" });

    const codex = await mutate(
      fixture.origin,
      bootstrap.csrfToken,
      "/api/providers/codex/test",
      "POST",
    );
    expect(JSON.parse(codex.body)).toMatchObject({
      tested: "codex",
      provider: { state: "available", text: { available: true } },
    });
    expect(fixture.codex.inspections).toBe(1);
    expect(fixture.codex.executions).toBe(1);
    expect(fixture.gemini.modelCalls).toHaveLength(2);
  });

  it("partitions cached capabilities by exact model tuple and never substitutes", async () => {
    const fixture = await apiFixture();
    fixture.keychain.value = syntheticCredential("cache");
    const bootstrap = await getJson(fixture.origin, "/api/bootstrap");
    await mutate(
      fixture.origin,
      bootstrap.csrfToken,
      "/api/providers/gemini/test",
      "POST",
    );
    const current = await getJson(fixture.origin, "/api/settings");
    fixture.gemini.mismatchedModels.add("gemini-missing-exact");
    await mutate(
      fixture.origin,
      bootstrap.csrfToken,
      "/api/settings",
      "PUT",
      settingsUpdate(current, {
        textProvider: "gemini",
        models: { ...current.models, geminiText: "gemini-missing-exact" },
      }),
    );
    const beforeCheck = await getJson(fixture.origin, "/api/providers/status");
    expect(beforeCheck).toMatchObject({
      selected: { text: "gemini" },
      models: { geminiText: "gemini-missing-exact" },
      providers: { gemini: { state: "not_checked" } },
    });
    const checked = await mutate(
      fixture.origin,
      bootstrap.csrfToken,
      "/api/providers/gemini/test",
      "POST",
    );
    expect(JSON.parse(checked.body)).toMatchObject({
      provider: {
        state: "unavailable",
        text: { available: false, modelId: "gemini-missing-exact" },
      },
    });
    expect(
      (await getJson(fixture.origin, "/api/settings")).models.geminiText,
    ).toBe("gemini-missing-exact");
  });

  it("checks and confirms prompt policy without echoing the original prompt", async () => {
    const fixture = await apiFixture();
    const bootstrap = await getJson(fixture.origin, "/api/bootstrap");
    const prompt = "PRIVATE-PROMPT-CANARY بأسلوب Disney";
    const checkedResponse = await mutate(
      fixture.origin,
      bootstrap.csrfToken,
      "/api/providers/prompt-policy/check",
      "POST",
      { prompt, styleId: "soft_watercolor" },
    );
    expect(checkedResponse.status).toBe(200);
    expect(checkedResponse.body).not.toContain("PRIVATE-PROMPT-CANARY");
    expect(checkedResponse.body).not.toContain("Disney");
    const checked = JSON.parse(checkedResponse.body);
    expect(checked).toMatchObject({
      status: "confirmation_required",
      matchedCategories: ["franchise_trademark"],
      bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const confirmed = await mutate(
      fixture.origin,
      bootstrap.csrfToken,
      "/api/providers/prompt-policy/confirm",
      "POST",
      {
        prompt,
        styleId: "soft_watercolor",
        bindingHash: checked.bindingHash,
      },
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).not.toContain(prompt);

    const stale = await mutate(
      fixture.origin,
      bootstrap.csrfToken,
      "/api/providers/prompt-policy/confirm",
      "POST",
      {
        prompt: `${prompt} changed`,
        styleId: "soft_watercolor",
        bindingHash: checked.bindingHash,
      },
    );
    expect(stale.status).toBe(400);
    expect(stale.body).toBe('{"code":"PROMPT_CONFIRMATION_STALE"}');
    expect(await readCorpus(fixture.runtime.paths.root)).not.toContain(
      "PRIVATE-PROMPT-CANARY",
    );
  });

  it("requires the existing origin and CSRF boundary for provider mutations", async () => {
    const fixture = await apiFixture();
    const response = await httpRequest(
      fixture.origin,
      "/api/providers/gemini/credential",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: syntheticCredential("csrf") }),
      },
    );
    expect(response.status).toBe(403);
    expect(fixture.keychain.calls.set).toBe(0);
  });
});

class MemoryKeychain implements KeychainPort {
  value: string | null = null;
  readonly calls = { get: 0, set: 0, delete: 0 };
  set(_account: string, secret: string): Promise<void> {
    this.calls.set += 1;
    this.value = secret;
    return Promise.resolve();
  }
  get(): Promise<string | null> {
    this.calls.get += 1;
    return Promise.resolve(this.value);
  }
  delete(): Promise<boolean> {
    this.calls.delete += 1;
    const existed = this.value !== null;
    this.value = null;
    return Promise.resolve(existed);
  }
}

class RuntimeGeminiTransport implements GeminiTransport {
  readonly modelCalls: string[] = [];
  readonly generateCalls: GeminiGenerateRequest[] = [];
  readonly mismatchedModels = new Set<string>();
  getModel(_apiKey: string, requestedModel: string): Promise<GeminiModelInfo> {
    this.modelCalls.push(requestedModel);
    return Promise.resolve({
      name: this.mismatchedModels.has(requestedModel)
        ? "models/different-model"
        : `models/${requestedModel}`,
      supportedActions: ["generateContent"],
    });
  }
  generate(
    _apiKey: string,
    request: GeminiGenerateRequest,
  ): Promise<GeminiTransportResponse> {
    this.generateCalls.push(request);
    return Promise.resolve({
      modelVersion: request.modelId,
      responseId: "fixture-probe",
      candidateCount: 1,
      parts: [{ text: '{"probe":"ok"}' }],
      finishReason: "STOP",
      safetyRatings: [],
    });
  }
}

function syntheticCredential(label: string): string {
  return [["AI", "za"].join(""), "fixture", label].join("-");
}

class RuntimeCodexRunner implements CodexRunner {
  inspections = 0;
  executions = 0;
  inspect(): Promise<{
    version: CodexProcessResult;
    login: CodexProcessResult;
  }> {
    this.inspections += 1;
    return Promise.resolve({
      version: codexResult({ stdout: "codex-cli fixture" }),
      login: codexResult({ stdout: "Logged in using ChatGPT" }),
    });
  }
  execute(request: CodexExecutionRequest): Promise<CodexProcessResult> {
    this.executions += 1;
    return Promise.resolve(
      codexResult({
        stdout: `model: ${request.modelId}\n`,
        output: '{"probe":"ok"}',
        resolvedModel: request.modelId,
      }),
    );
  }
}

function codexResult(
  patch: Partial<CodexProcessResult> = {},
): CodexProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    canceled: false,
    processGroupGone: true,
    outputTruncated: false,
    ...patch,
  };
}

async function apiFixture() {
  const directory = await temporaryDirectory("hekayati-provider-api-");
  cleanups.push(directory.cleanup);
  const keychain = new MemoryKeychain();
  const codex = new RuntimeCodexRunner();
  const gemini = new RuntimeGeminiTransport();
  const running = await runtimeAt(directory.path, keychain, codex, gemini);
  cleanups.push(running.runtime.close);
  return { ...running, keychain, codex, gemini };
}

async function runtimeAt(
  path: string,
  keychain: MemoryKeychain,
  codex = new RuntimeCodexRunner(),
  gemini = new RuntimeGeminiTransport(),
) {
  const runtime = await createRuntime({
    dataDir: path,
    serveUi: false,
    providers: { keychain, codexRunner: codex, geminiTransport: gemini },
  });
  const origin = await runtime.start();
  return { runtime, origin, codex, gemini };
}

async function getJson(origin: string, path: string) {
  const response = await httpRequest(origin, path);
  expect(response.status).toBe(200);
  return JSON.parse(response.body);
}

function mutate(
  origin: string,
  csrfToken: string,
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
) {
  return httpRequest(origin, path, {
    method,
    headers: {
      origin,
      "x-hekayati-csrf": csrfToken,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function settingsUpdate(settings: any, overrides: Record<string, unknown>) {
  return {
    textProvider: settings.textProvider,
    imageProvider: settings.imageProvider,
    geminiImageTier: settings.geminiImageTier,
    models: settings.models,
    concurrencyPerProvider: settings.concurrencyPerProvider,
    typography: settings.typography,
    watermarkText: settings.watermarkText,
    diskWarnGb: settings.diskWarnGb,
    photoUploadMaxMb: settings.photoUploadMaxMb,
    photoMaxMegapixels: settings.photoMaxMegapixels,
    firstRunAcknowledged: settings.firstRunAcknowledged,
    ...overrides,
  };
}

async function readCorpus(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const chunks = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? readCorpus(path) : readFile(path, "utf8");
    }),
  );
  return chunks.join("\n");
}

import { appendFile } from "node:fs/promises";

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
import { LOOPBACK_HOST } from "../../src/config/defaults.js";
import { createRuntime } from "../../src/server/app.js";
import { parsePort } from "../../src/server/startup/bind.js";

const callLog = process.env.HEKAYATI_PROVIDER_CALL_LOG;
const keychainBinary = process.env.HEKAYATI_FAKE_SECURITY_BINARY;
if (!callLog || !keychainBinary) throw new Error("PROVIDER_FIXTURE_CONFIG");

class FixtureCodexRunner implements CodexRunner {
  constructor(private readonly logPath: string) {}

  async inspect(): Promise<{
    version: CodexProcessResult;
    login: CodexProcessResult;
  }> {
    await record(this.logPath, "codex:inspect");
    return {
      version: processResult({ stdout: "codex-cli fixture" }),
      login: processResult({ stdout: "Logged in using ChatGPT" }),
    };
  }

  async execute(request: CodexExecutionRequest): Promise<CodexProcessResult> {
    await record(this.logPath, "codex:execute");
    return processResult({
      stdout: `model: ${request.modelId}`,
      output: '{"probe":"ok"}',
      resolvedModel: request.modelId,
    });
  }
}

class FixtureGeminiTransport implements GeminiTransport {
  constructor(private readonly logPath: string) {}

  async getModel(_apiKey: string, modelId: string): Promise<GeminiModelInfo> {
    await record(this.logPath, `gemini:model:${modelId}`);
    return {
      name: `models/${modelId}`,
      supportedActions: ["generateContent"],
    };
  }

  async generate(
    _apiKey: string,
    request: GeminiGenerateRequest,
  ): Promise<GeminiTransportResponse> {
    await record(this.logPath, `gemini:generate:${request.modelId}`);
    return {
      modelVersion: request.modelId,
      responseId: "fixture-probe",
      candidateCount: 1,
      parts: [{ text: '{"probe":"ok"}' }],
      finishReason: "STOP",
      safetyRatings: [],
    };
  }
}

function processResult(
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

function record(path: string, event: string): Promise<void> {
  return appendFile(path, `${event}\n`, { encoding: "utf8" });
}

const runtime = await createRuntime({
  enableTestRoutes: true,
  providers: {
    keychainBinary,
    codexRunner: new FixtureCodexRunner(callLog),
    geminiTransport: new FixtureGeminiTransport(callLog),
    geminiLimits: { maxReferenceImages: 4, reliableCharacterCount: 4 },
    clock: () => new Date("2026-07-14T12:00:00.000Z"),
  },
});
const origin = await runtime.start({
  host: LOOPBACK_HOST,
  port: parsePort(process.env.HEKAYATI_PORT, 4317),
});
console.log(`Hekayati is ready at ${origin}`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await runtime.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

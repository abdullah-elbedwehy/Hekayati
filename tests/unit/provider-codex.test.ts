import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexProvider } from "../../src/providers/codex/adapter.js";
import {
  classifyCodexProcess,
  parseCodexAuth,
} from "../../src/providers/codex/classify.js";
import {
  CodexProcessRunner,
  codexSubscriptionEnvironment,
  type CodexExecutionRequest,
  type CodexProcessResult,
  type CodexRunner,
} from "../../src/providers/codex/process-runner.js";
import { generationTask, outputFixture } from "../helpers/provider-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Codex subscription adapter", () => {
  it("reports exact text capability and the fixed G1-I image limitation", async () => {
    const runner = new FixtureCodexRunner({
      inspection: goodInspection(),
      executions: [successExecution('{"probe":"ok"}')],
    });
    const capabilities = await provider(runner).getCapabilities();
    expect(capabilities).toMatchObject({
      providerId: "codex",
      auth: { state: "ok" },
      text: { available: true, modelId: "gpt-test" },
      image: {
        available: false,
        maxReferenceImages: null,
        reliableCharacterCount: null,
        unavailableReason: expect.stringContaining("G1-I"),
      },
    });
    expect(runner.executed[0]?.modelId).toBe("gpt-test");
  });

  it("distinguishes a missing binary, logged-out auth, and model mismatch", async () => {
    const missing = new FixtureCodexRunner({
      inspection: {
        version: processResult({ errorCode: "ENOENT", exitCode: null }),
        login: processResult({ errorCode: "ENOENT", exitCode: null }),
      },
    });
    expect(await provider(missing).getCapabilities()).toMatchObject({
      auth: { state: "error" },
      text: { available: false },
      unavailableReason: expect.any(String),
    });
    expect(missing.executed).toHaveLength(0);

    const loggedOut = new FixtureCodexRunner({
      inspection: {
        version: processResult({ stdout: "codex 1.0" }),
        login: processResult({ exitCode: 1, stderr: "Not logged in" }),
      },
    });
    expect(await provider(loggedOut).getCapabilities()).toMatchObject({
      auth: { state: "missing" },
      text: { available: false },
    });

    const mismatch = new FixtureCodexRunner({
      inspection: goodInspection(),
      executions: [successExecution('{"probe":"ok"}', "different-model")],
    });
    expect(await provider(mismatch).getCapabilities()).toMatchObject({
      text: {
        available: false,
        unavailableReason: expect.stringContaining("المعرّف"),
      },
    });
  });

  it("validates structured output locally and rejects resolved model drift", async () => {
    const task = generationTask("StoryPlan");
    const request = {
      schemaId: "StoryPlan" as const,
      task,
      languageDirectives: task.languageDirectives,
    };
    const successRunner = new FixtureCodexRunner({
      inspection: goodInspection(),
      executions: [
        successExecution(JSON.stringify(outputFixture("StoryPlan"))),
      ],
    });
    const success = await provider(successRunner).generateStructured(
      request,
      control(),
    );
    expect(success).toMatchObject({
      ok: true,
      provenance: { provider: "codex", modelId: "gpt-test" },
    });
    expect(successRunner.executed[0]).toMatchObject({
      modelId: "gpt-test",
      outputSchema: expect.any(Object),
    });

    const driftRunner = new FixtureCodexRunner({
      inspection: goodInspection(),
      executions: [
        successExecution(
          JSON.stringify(outputFixture("StoryPlan")),
          "gpt-other",
        ),
      ],
    });
    await expect(
      provider(driftRunner).generateStructured(request, control()),
    ).resolves.toMatchObject({
      ok: false,
      failure: { category: "provider_unavailable" },
    });
  });

  it("never invokes Codex for image generation", async () => {
    const runner = new FixtureCodexRunner({ inspection: goodInspection() });
    const result = await provider(runner).generateImage();
    expect(result).toMatchObject({
      ok: false,
      failure: { category: "provider_unavailable" },
    });
    expect(runner.executed).toHaveLength(0);
  });

  it("normalizes quota before ordinary throttling and never exposes raw text", () => {
    expect(
      classifyCodexProcess(
        processResult({ exitCode: 1, stderr: "usage_limit_reached 429" }),
      ),
    ).toBe("quota_exhausted");
    expect(
      classifyCodexProcess(
        processResult({ exitCode: 1, stderr: "ordinary 429 throttled" }),
      ),
    ).toBe("rate_limited");
    expect(
      parseCodexAuth(processResult({ stdout: "Logged in using ChatGPT" })),
    ).toBe("chatgpt_subscription");
  });

  it("strips API-key variables and sends prompts through stdin without a shell", async () => {
    const canary = ["OPENAI", "KEY", "CANARY"].join("-");
    const env = codexSubscriptionEnvironment({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OPENAI_API_KEY: canary,
      CODEX_API_KEY: canary,
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();

    const fixture = await fixtureExecutable();
    const runner = new CodexProcessRunner({ binary: fixture.binary });
    const result = await runner.execute(
      {
        modelId: "gpt-test",
        prompt: "PRIVATE-PROMPT-STDIN-CANARY",
        outputSchema: { type: "object" },
      },
      control(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('{"probe":"ok"}');
    expect(await readFile(fixture.stdin, "utf8")).toBe(
      "PRIVATE-PROMPT-STDIN-CANARY",
    );
    const args = await readFile(fixture.args, "utf8");
    expect(args).not.toContain("PRIVATE-PROMPT-STDIN-CANARY");
    expect(await readFile(fixture.secret, "utf8")).toBe("");
  });

  it("classifies every process and login signal with fixed precedence", () => {
    const processCases: Array<[Partial<CodexProcessResult>, string | null]> = [
      [{ canceled: true }, "user_canceled"],
      [{ timedOut: true }, "timeout"],
      [{ errorCode: "EACCES", exitCode: null }, "provider_unavailable"],
      [{ exitCode: 0 }, null],
      [
        { exitCode: 1, stderr: "model gpt-x not found" },
        "provider_unavailable",
      ],
      [{ exitCode: 1, stderr: "401 unauthorized" }, "invalid_credentials"],
      [{ exitCode: 1, stderr: "subscription limit 429" }, "quota_exhausted"],
      [{ exitCode: 1, stderr: "too many requests" }, "rate_limited"],
      [{ exitCode: 1, stderr: "deadline exceeded" }, "timeout"],
      [{ exitCode: 1, stderr: "connection refused" }, "network_failure"],
      [{ exitCode: 1, stderr: "content blocked by safety" }, "safety_refusal"],
      [{ exitCode: 1, stderr: "invalid json" }, "malformed_output"],
      [{ exitCode: 1, stderr: "unrecognized failure" }, "unknown"],
    ];
    for (const [patch, expected] of processCases) {
      expect(classifyCodexProcess(processResult(patch))).toBe(expected);
    }
    expect(parseCodexAuth(processResult({ errorCode: "EACCES" }))).toBe(
      "unknown",
    );
    expect(parseCodexAuth(processResult({ stdout: "API key auth" }))).toBe(
      "api_key_disallowed",
    );
    expect(
      parseCodexAuth(processResult({ exitCode: 1, stderr: "login required" })),
    ).toBe("missing");
    expect(parseCodexAuth(processResult({ stdout: "signed in" }))).toBe(
      "unknown",
    );
  });

  it("normalizes capability probe failures, invalid probes, and runner exceptions", async () => {
    const failedProbe = new FixtureCodexRunner({
      inspection: goodInspection(),
      executions: [processResult({ exitCode: 1, stderr: "quota exceeded" })],
    });
    await expect(
      provider(failedProbe).getCapabilities(),
    ).resolves.toMatchObject({
      text: { available: false, unavailableReason: expect.any(String) },
    });
    const invalidProbe = new FixtureCodexRunner({
      inspection: goodInspection(),
      executions: [successExecution("not-json")],
    });
    await expect(
      provider(invalidProbe).getCapabilities(),
    ).resolves.toMatchObject({
      text: {
        available: false,
        unavailableReason: expect.stringContaining("صالحة"),
      },
    });
    const throwing: CodexRunner = {
      inspect: () => Promise.reject(new Error("fixture")),
      execute: () => Promise.reject(new Error("fixture")),
    };
    await expect(provider(throwing).getCapabilities()).resolves.toMatchObject({
      auth: { state: "error" },
    });
  });

  it("covers text success, validation, malformed output, failure, and thrown execution", async () => {
    const request = {
      task: generationTask("ReviewFindings"),
      purpose: "review_note" as const,
    };
    await expect(
      provider(
        new FixtureCodexRunner({
          inspection: goodInspection(),
          executions: [successExecution(" نص مصري ")],
        }),
      ).generateText(request, control()),
    ).resolves.toMatchObject({ ok: true, value: { text: "نص مصري" } });
    await expect(
      provider(
        new FixtureCodexRunner({ inspection: goodInspection() }),
      ).generateText({} as never, control()),
    ).resolves.toMatchObject({
      ok: false,
      failure: { category: "invalid_input" },
    });
    for (const execution of [
      successExecution("   "),
      processResult({ exitCode: 1, stderr: "socket hang up" }),
      processResult({
        output: "content",
        resolvedModel: "gpt-test",
        outputTruncated: true,
      }),
    ]) {
      await expect(
        provider(
          new FixtureCodexRunner({
            inspection: goodInspection(),
            executions: [execution],
          }),
        ).generateText(request, control()),
      ).resolves.toMatchObject({ ok: false });
    }
    const throwing: CodexRunner = {
      inspect: () => Promise.resolve(goodInspection()),
      execute: () => Promise.reject(new Error("fixture")),
    };
    await expect(
      provider(throwing).generateText(request, control()),
    ).resolves.toMatchObject({
      ok: false,
      failure: { category: "unknown" },
    });
  });

  it("covers structured invalid, empty, malformed, and connection outcomes", async () => {
    const task = generationTask("PagePrompt");
    const request = {
      schemaId: "PagePrompt" as const,
      task,
      languageDirectives: task.languageDirectives,
    };
    const empty = processResult({ resolvedModel: "gpt-test" });
    const malformed = successExecution("{bad-json");
    for (const execution of [empty, malformed]) {
      await expect(
        provider(
          new FixtureCodexRunner({
            inspection: goodInspection(),
            executions: [execution],
          }),
        ).generateStructured(request, control()),
      ).resolves.toMatchObject({ ok: false });
    }
    await expect(
      provider(
        new FixtureCodexRunner({ inspection: goodInspection() }),
      ).generateStructured({} as never, control()),
    ).resolves.toMatchObject({
      ok: false,
      failure: { category: "invalid_input" },
    });
    const available = new FixtureCodexRunner({
      inspection: goodInspection(),
      executions: [successExecution('{"probe":"ok"}')],
    });
    await expect(provider(available).testConnection()).resolves.toMatchObject({
      ok: true,
    });
    const unavailable = new FixtureCodexRunner({
      inspection: {
        version: processResult({ stdout: "codex" }),
        login: processResult({ exitCode: 1, stderr: "login required" }),
      },
    });
    await expect(provider(unavailable).testConnection()).resolves.toMatchObject(
      {
        ok: false,
        failure: { category: "invalid_credentials" },
      },
    );
  });
});

class FixtureCodexRunner implements CodexRunner {
  readonly executed: CodexExecutionRequest[] = [];
  private readonly executions: CodexProcessResult[];

  constructor(
    private readonly fixture: {
      inspection: { version: CodexProcessResult; login: CodexProcessResult };
      executions?: CodexProcessResult[];
    },
  ) {
    this.executions = [...(fixture.executions ?? [])];
  }

  inspect(): Promise<{
    version: CodexProcessResult;
    login: CodexProcessResult;
  }> {
    return Promise.resolve(this.fixture.inspection);
  }

  execute(request: CodexExecutionRequest): Promise<CodexProcessResult> {
    this.executed.push(request);
    return Promise.resolve(
      this.executions.shift() ??
        processResult({ exitCode: 1, stderr: "fixture missing" }),
    );
  }
}

function provider(runner: CodexRunner) {
  return new CodexProvider({
    runner,
    modelId: () => "gpt-test",
    clock: () => new Date("2026-07-14T12:00:00.000Z"),
    settings: () => ({ textProvider: "codex", model: "gpt-test" }),
  });
}

function goodInspection() {
  return {
    version: processResult({ stdout: "codex-cli 1.0" }),
    login: processResult({ stdout: "Logged in using ChatGPT" }),
  };
}

function successExecution(output: string, resolvedModel = "gpt-test") {
  return processResult({
    stdout: `model: ${resolvedModel}\n`,
    output,
    resolvedModel,
  });
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

function control(timeoutMs = 1_000) {
  return { signal: new AbortController().signal, timeoutMs };
}

async function fixtureExecutable() {
  const directory = await temporaryDirectory("hekayati-codex-runner-");
  cleanups.push(directory.cleanup);
  const binary = join(directory.path, "codex-fixture");
  const args = join(directory.path, "args");
  const stdin = join(directory.path, "stdin");
  const secret = join(directory.path, "secret");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(args)}, args.join("\\n"));
fs.writeFileSync(${JSON.stringify(secret)}, process.env.OPENAI_API_KEY || "");
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdin)}, input);
  const outputIndex = args.indexOf("--output-last-message");
  fs.writeFileSync(args[outputIndex + 1], '{"probe":"ok"}');
  process.stdout.write("model: gpt-test\\n");
});
`;
  await writeFile(binary, script, { mode: 0o700 });
  await chmod(binary, 0o700);
  return { binary, args, stdin, secret };
}

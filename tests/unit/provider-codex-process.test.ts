import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexProcessRunner } from "../../src/providers/codex/process-runner.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Codex process lifecycle", () => {
  it("normalizes missing binaries and short-circuits an aborted control", async () => {
    const missing = new CodexProcessRunner({
      binary: "/definitely/missing/hekayati-codex",
    });
    const inspection = await missing.inspect(control());
    expect(inspection.version.errorCode).toBe("ENOENT");
    expect(inspection.login.errorCode).toBe("ENOENT");

    const controller = new AbortController();
    controller.abort();
    await expect(
      missing.execute(
        { modelId: "gpt-test", prompt: "never spawned" },
        control(100, controller.signal),
      ),
    ).resolves.toMatchObject({
      canceled: true,
      timedOut: false,
      processGroupGone: null,
    });
  });

  it("terminates the detached process group on timeout and AbortSignal", async () => {
    const binary = await executable(`
process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 1000);
`);
    const runner = new CodexProcessRunner({ binary });
    const timedOut = await runner.execute(
      { modelId: "gpt-test", prompt: "timeout" },
      control(5),
    );
    expect(timedOut).toMatchObject({
      timedOut: true,
      canceled: false,
      processGroupGone: true,
    });

    const controller = new AbortController();
    const pending = runner.execute(
      { modelId: "gpt-test", prompt: "cancel" },
      control(1_000, controller.signal),
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).resolves.toMatchObject({
      canceled: true,
      processGroupGone: true,
    });
  });

  it("bounds stdout, stderr, and output files and rejects ambiguous model evidence", async () => {
    const binary = await executable(`
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
fs.writeFileSync(output, "O".repeat(1024 * 1024 + 256));
process.stdout.write("model: gpt-test\\nmodel: other\\n" + "X".repeat(70 * 1024));
process.stderr.write("Y".repeat(70 * 1024));
`);
    const result = await new CodexProcessRunner({ binary }).execute(
      {
        modelId: "gpt-test",
        prompt: "bounded",
        outputSchema: { type: "object" },
      },
      control(2_000),
    );
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(result.output ?? "")).toBe(1024 * 1024);
    expect(result.resolvedModel).toBeUndefined();
  });

  it("supports inspect and a text execution with no schema or output file", async () => {
    const binary = await executable(`
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("codex fixture");
else if (args[0] === "login") process.stdout.write("Logged in using ChatGPT");
else process.stdout.write("model: gpt-test\\n");
`);
    const runner = new CodexProcessRunner({ binary });
    await expect(runner.inspect(control())).resolves.toMatchObject({
      version: { exitCode: 0 },
      login: { exitCode: 0 },
    });
    await expect(
      runner.execute({ modelId: "gpt-test", prompt: "no output" }, control()),
    ).resolves.toMatchObject({
      exitCode: 0,
      output: undefined,
      resolvedModel: "gpt-test",
    });
  });
});

function control(timeoutMs = 1_000, signal = new AbortController().signal) {
  return { timeoutMs, signal };
}

async function executable(body: string): Promise<string> {
  const directory = await temporaryDirectory("hekayati-codex-process-");
  cleanups.push(directory.cleanup);
  const path = join(directory.path, "codex-fixture");
  await writeFile(path, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

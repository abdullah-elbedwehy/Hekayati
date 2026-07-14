import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CallControl } from "../contract.js";

const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface CodexProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  timedOut: boolean;
  canceled: boolean;
  processGroupGone: boolean | null;
  outputTruncated: boolean;
  output?: string;
  resolvedModel?: string;
}

export interface CodexExecutionRequest {
  modelId: string;
  prompt: string;
  outputSchema?: object;
}

export interface CodexRunner {
  inspect(control: CallControl): Promise<{
    version: CodexProcessResult;
    login: CodexProcessResult;
  }>;
  execute(
    request: CodexExecutionRequest,
    control: CallControl,
  ): Promise<CodexProcessResult>;
}

export interface CodexProcessRunnerOptions {
  binary?: string;
  environment?: NodeJS.ProcessEnv;
}

export class CodexProcessRunner implements CodexRunner {
  private readonly binary: string;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: CodexProcessRunnerOptions = {}) {
    this.binary = options.binary ?? "codex";
    this.environment = codexSubscriptionEnvironment(options.environment);
  }

  async inspect(control: CallControl) {
    const [version, login] = await Promise.all([
      this.run(["--version"], control),
      this.run(["login", "status"], control),
    ]);
    return { version, login };
  }

  async execute(
    request: CodexExecutionRequest,
    control: CallControl,
  ): Promise<CodexProcessResult> {
    const directory = await mkdtemp(join(tmpdir(), "hekayati-codex-"));
    await chmod(directory, 0o700);
    const outputPath = join(directory, "output.txt");
    const args = executionArgs(request, outputPath);
    try {
      if (request.outputSchema) {
        await writeFile(
          join(directory, "schema.json"),
          JSON.stringify(request.outputSchema),
          { mode: 0o600 },
        );
      }
      const result = await this.run(args, control, request.prompt, directory);
      const output = await readBounded(outputPath);
      return {
        ...result,
        output: output?.value,
        outputTruncated: result.outputTruncated || Boolean(output?.truncated),
        resolvedModel: parseResolvedModel(`${result.stdout}\n${result.stderr}`),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private run(
    args: string[],
    control: CallControl,
    input?: string,
    cwd = tmpdir(),
  ): Promise<CodexProcessResult> {
    if (control.signal.aborted) return Promise.resolve(canceledResult());
    return runChild(this.binary, args, {
      control,
      cwd,
      env: this.environment,
      input,
    });
  }
}

export function codexSubscriptionEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowedNames = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "CODEX_HOME",
    "CODEX_CA_CERTIFICATE",
    "SSL_CERT_FILE",
  ];
  const result: NodeJS.ProcessEnv = { NO_COLOR: "1", CI: "1" };
  for (const name of allowedNames) {
    if (source[name] !== undefined) result[name] = source[name];
  }
  return result;
}

function executionArgs(
  request: CodexExecutionRequest,
  outputPath: string,
): string[] {
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--model",
    request.modelId,
  ];
  if (request.outputSchema) {
    args.push("--output-schema", "schema.json");
  }
  args.push("--output-last-message", outputPath, "-");
  return args;
}

function runChild(
  binary: string,
  args: string[],
  options: {
    control: CallControl;
    cwd: string;
    env: NodeJS.ProcessEnv;
    input?: string;
  },
): Promise<CodexProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    captureChild(child, options, resolve);
  });
}

function captureChild(
  child: ChildProcess,
  options: {
    control: CallControl;
    input?: string;
  },
  resolve: (result: CodexProcessResult) => void,
): void {
  const pid = child.pid;
  const state: CaptureState = {
    stdout: "",
    stderr: "",
    timedOut: false,
    canceled: false,
    outputTruncated: false,
  };
  let settled = false;
  captureStream(child.stdout, state, "stdout");
  captureStream(child.stderr, state, "stderr");
  child.once("error", (error: NodeJS.ErrnoException) => {
    state.errorCode = error.code;
  });
  const stopper = processStopper(child);
  const onCancel = (): void => {
    state.canceled = true;
    stopper.request();
  };
  options.control.signal.addEventListener("abort", onCancel, { once: true });
  const timeout = setTimeout(
    () => {
      state.timedOut = true;
      stopper.request();
    },
    Math.max(1, options.control.timeoutMs),
  );
  child.once("close", (exitCode, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    stopper.clear();
    options.control.signal.removeEventListener("abort", onCancel);
    void finishCaptured(state, pid, exitCode, signal).then(resolve);
  });
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(options.input ?? "");
}

interface CaptureState {
  stdout: string;
  stderr: string;
  errorCode?: string;
  timedOut: boolean;
  canceled: boolean;
  outputTruncated: boolean;
}

function captureStream(
  stream: NodeJS.ReadableStream | null,
  state: CaptureState,
  field: "stdout" | "stderr",
): void {
  stream?.on("data", (chunk: Buffer) => {
    const next = appendCaptured(state[field], chunk);
    state[field] = next.value;
    state.outputTruncated ||= next.truncated;
  });
}

function processStopper(child: ChildProcess): {
  request(): void;
  clear(): void;
} {
  let escalation: NodeJS.Timeout | undefined;
  return {
    request: () => {
      stopProcessGroup(child, "SIGTERM");
      escalation ??= setTimeout(() => stopProcessGroup(child, "SIGKILL"), 250);
      escalation.unref();
    },
    clear: () => {
      if (escalation) clearTimeout(escalation);
    },
  };
}

async function finishCaptured(
  state: CaptureState,
  pid: number | undefined,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): Promise<CodexProcessResult> {
  return {
    exitCode,
    signal,
    ...state,
    processGroupGone: await waitForProcessGroupExit(pid),
  };
}

function appendCaptured(current: string, chunk: Buffer) {
  const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current);
  if (remaining <= 0) return { value: current, truncated: true };
  if (chunk.byteLength <= remaining) {
    return { value: current + chunk.toString("utf8"), truncated: false };
  }
  return {
    value: current + chunk.subarray(0, remaining).toString("utf8"),
    truncated: true,
  };
}

function stopProcessGroup(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
  }
}

async function waitForProcessGroupExit(
  pid: number | undefined,
): Promise<boolean | null> {
  if (pid === undefined) return null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!processGroupAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processGroupAlive(pid);
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readBounded(
  path: string,
): Promise<{ value: string; truncated: boolean } | null> {
  try {
    const file = await open(path, "r");
    try {
      const stats = await file.stat();
      const length = Math.min(stats.size, MAX_OUTPUT_BYTES);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, 0);
      return {
        value: buffer.toString("utf8"),
        truncated: stats.size > MAX_OUTPUT_BYTES,
      };
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

function parseResolvedModel(output: string): string | undefined {
  const values = [...output.matchAll(/^model:\s+(\S+)\s*$/gm)].map(
    (match) => match[1],
  );
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : undefined;
}

function canceledResult(): CodexProcessResult {
  return {
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    canceled: true,
    processGroupGone: null,
    outputTruncated: false,
  };
}

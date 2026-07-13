import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type FailureCategory =
  | "provider_unavailable"
  | "invalid_credentials"
  | "quota_exhausted"
  | "rate_limited"
  | "timeout"
  | "network_failure"
  | "malformed_output"
  | "unknown";

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  timedOut: boolean;
  cancellationRequested: boolean;
  processGroupGone: boolean | null;
  outputTruncated: boolean;
};

type RunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  cancelAfterMs?: number;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_ROOT = path.join(SCRIPT_DIR, ".local-artifacts", "g1t");
const SCHEMA_PATH = path.join(SCRIPT_DIR, "fixtures", "g1t.schema.json");
const MAX_CAPTURE_BYTES = 64 * 1024;
const INVALID_MODEL = "hekayati-g1t-deliberately-invalid-model";
const OFFICIAL_CODEX_SOURCE_COMMIT =
  "fb350d1e7d52c4c3b42f230a4715ee4adf314f08";
const API_KEY_ENV_NAMES = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "AZURE_OPENAI_API_KEY",
];

function usage(): string {
  return [
    "Operator-triggered G1-T probe (uses the saved Codex ChatGPT login).",
    "",
    "Usage:",
    "  node --experimental-strip-types spikes/g1t-codex-text.ts [options]",
    "",
    "Options:",
    "  --codex-bin <path>        Codex executable (default: codex)",
    "  --model <exact-id>         Exact Codex model to probe (required; or G1T_CODEX_MODEL)",
    "  --timeout-ms <number>     Per live call timeout (default: 180000)",
    "  --cancel-after-ms <n>     Cancellation delay (default: 750)",
    "  --skip-invalid-model      Skip the one bounded invalid-model call",
    "  --skip-cancel             Skip the cancellation/process-group call",
    "  --help                    Print this help without probing",
    "",
    "The probe never reads Codex auth files and never forwards API-key variables.",
  ].join("\n");
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = readOption(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function makeSubscriptionEnvironment(): {
  env: NodeJS.ProcessEnv;
  withheldVariables: string[];
} {
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
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1", CI: "1" };
  for (const name of allowedNames) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return {
    env,
    withheldVariables: API_KEY_ENV_NAMES.filter(
      (name) => process.env[name] !== undefined,
    ),
  };
}

function appendCaptured(
  current: string,
  chunk: Buffer,
): { value: string; truncated: boolean } {
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
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function waitForProcessGroupExit(
  pid: number | undefined,
  waitMs = 1_500,
): Promise<boolean | null> {
  if (pid === undefined) return null;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessGroupAlive(pid);
}

async function runProcess(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let errorCode: string | undefined;
    let timedOut = false;
    let cancellationRequested = false;
    let settled = false;
    let killEscalation: NodeJS.Timeout | undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      const captured = appendCaptured(stdout, chunk);
      stdout = captured.value;
      outputTruncated ||= captured.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const captured = appendCaptured(stderr, chunk);
      stderr = captured.value;
      outputTruncated ||= captured.truncated;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      errorCode = error.code;
      stderr = `${stderr}\n${error.message}`;
    });

    const forceKill = (): void => {
      try {
        stopProcessGroup(child, "SIGKILL");
      } catch {
        // The scorecard's no-orphan check catches an unsuccessful kill.
      }
    };
    const requestStop = (): void => {
      try {
        stopProcessGroup(child, "SIGTERM");
      } catch {
        // The scorecard records whether the process group survived.
      }
      if (killEscalation === undefined) {
        killEscalation = setTimeout(forceKill, 1_000);
        killEscalation.unref();
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      requestStop();
    }, options.timeoutMs);
    const cancellation =
      options.cancelAfterMs === undefined
        ? undefined
        : setTimeout(() => {
            cancellationRequested = true;
            requestStop();
          }, options.cancelAfterMs);

    child.once("close", async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (cancellation !== undefined) clearTimeout(cancellation);
      if (killEscalation !== undefined) {
        clearTimeout(killEscalation);
        killEscalation = undefined;
        if (pid !== undefined && isProcessGroupAlive(pid)) forceKill();
      }
      const processGroupGone = await waitForProcessGroupExit(pid);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        errorCode,
        timedOut,
        cancellationRequested,
        processGroupGone,
        outputTruncated,
      });
    });
  });
}

function classifySignal(
  text: string,
  errorCode?: string,
  timedOut = false,
): FailureCategory {
  if (timedOut) return "timeout";
  if (errorCode === "ENOENT") return "provider_unavailable";
  const value = text.toLowerCase();
  if (
    /model[\s\S]{0,120}(not found|does not exist|unsupported|unavailable|invalid)/.test(
      value,
    ) ||
    /(not found|does not exist|unsupported)[\s\S]{0,120}model/.test(value)
  ) {
    return "provider_unavailable";
  }
  if (
    /not logged in|please log in|login required|invalid credentials|unauthorized|session expired|authentication failed|\b401\b/.test(
      value,
    )
  ) {
    return "invalid_credentials";
  }
  if (
    /usage limit|usage_limit_reached|quota exhausted|quota exceeded|insufficient quota|insufficient_quota|credits exhausted|subscription limit/.test(
      value,
    )
  ) {
    return "quota_exhausted";
  }
  if (/rate limit|too many requests|\b429\b|throttl/.test(value)) {
    return "rate_limited";
  }
  if (/timed out|timeout|deadline exceeded/.test(value)) return "timeout";
  if (
    /dns|connection reset|connection refused|network unavailable|socket hang up/.test(
      value,
    )
  ) {
    return "network_failure";
  }
  if (/malformed|invalid json|schema validation|output schema/.test(value)) {
    return "malformed_output";
  }
  if (/command not found|no such file|not installed/.test(value)) {
    return "provider_unavailable";
  }
  return "unknown";
}

function classifyResult(result: ProcessResult): FailureCategory | null {
  if (result.code === 0 && !result.timedOut) return null;
  return classifySignal(
    `${result.stderr}\n${result.stdout}`,
    result.errorCode,
    result.timedOut,
  );
}

function sanitizedLine(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/\/Users\/[^/\s]+/g, "~")
    .replace(/\b(?:sk|sess|eyJ)[-_A-Za-z0-9.]{20,}\b/g, "[TOKEN]")
    .replace(/https?:\/\/\S+/g, "[URL]")
    .replace(/[A-Za-z0-9+/=_-]{96,}/g, "[REDACTED_BLOB]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function parseAuthMode(result: ProcessResult): string {
  if (result.code !== 0) return classifyResult(result) ?? "unknown";
  const text = `${result.stdout}\n${result.stderr}`;
  if (/chatgpt/i.test(text)) return "chatgpt_subscription";
  if (/api[ -]?key/i.test(text)) return "api_key_disallowed";
  return "authenticated_method_unconfirmed";
}

function parseResolvedModel(output: string): string | null {
  const values = [...output.matchAll(/^model:\s+(\S+)\s*$/gm)].map((match) => match[1]);
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : null;
}

function validateStructuredFixture(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    JSON.stringify(keys) ===
      JSON.stringify(["message", "probe", "status", "values"]) &&
    record.probe === "G1-T" &&
    record.status === "ok" &&
    record.message === "synthetic Hekayati Codex text probe" &&
    Array.isArray(record.values) &&
    JSON.stringify(record.values) === JSON.stringify([1, 2, 3])
  );
}

function taxonomySelfTests(): Array<{
  signal: string;
  expected: FailureCategory;
  actual: FailureCategory;
  pass: boolean;
}> {
  const cases: Array<[string, string, string | undefined, FailureCategory]> = [
    ["missing_binary", "", "ENOENT", "provider_unavailable"],
    ["logged_out", "Not logged in. Run codex login.", undefined, "invalid_credentials"],
    [
      "invalid_model",
      "Requested model is unsupported and not found.",
      undefined,
      "provider_unavailable",
    ],
    [
      "subscription_usage_limit",
      "You've hit your usage limit (usage_limit_reached).",
      undefined,
      "quota_exhausted",
    ],
    [
      "api_quota_signal",
      "insufficient_quota",
      undefined,
      "quota_exhausted",
    ],
    [
      "ordinary_429_retry_limit",
      "exceeded retry limit, last status: 429",
      undefined,
      "rate_limited",
    ],
    [
      "refresh_token_unauthorized",
      "RefreshTokenFailed: Unauthorized",
      undefined,
      "invalid_credentials",
    ],
  ];
  return cases.map(([signal, text, errorCode, expected]) => {
    const actual = classifySignal(text, errorCode);
    return { signal, expected, actual, pass: actual === expected };
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(usage());
    return;
  }

  const codexBin = readOption("--codex-bin") ?? process.env.G1T_CODEX_BIN ?? "codex";
  const requestedModel = readOption("--model") ?? process.env.G1T_CODEX_MODEL;
  if (!requestedModel) throw new Error("--model or G1T_CODEX_MODEL is required; model IDs are configuration");
  const timeoutMs = readPositiveInteger("--timeout-ms", 180_000);
  const cancelAfterMs = readPositiveInteger("--cancel-after-ms", 750);
  const skipInvalidModel = process.argv.includes("--skip-invalid-model");
  const skipCancel = process.argv.includes("--skip-cancel");
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const runDir = path.join(LOCAL_ROOT, runId);
  const emptyHome = path.join(runDir, "empty-home");
  const emptyCodexHome = path.join(emptyHome, ".codex");
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await mkdir(emptyCodexHome, { recursive: true, mode: 0o700 });

  const subscriptionEnvironment = makeSubscriptionEnvironment();
  const commonRunOptions = {
    cwd: runDir,
    env: subscriptionEnvironment.env,
    timeoutMs,
  };

  const version = await runProcess(codexBin, ["--version"], {
    ...commonRunOptions,
    timeoutMs: 10_000,
  });
  const loginStatus = await runProcess(codexBin, ["login", "status"], {
    ...commonRunOptions,
    timeoutMs: 15_000,
  });
  const missingBinary = await runProcess(
    `${codexBin}-hekayati-intentionally-missing`,
    ["--version"],
    { ...commonRunOptions, timeoutMs: 5_000 },
  );
  const loggedOut = await runProcess(
    codexBin,
    [
      "--config",
      'cli_auth_credentials_store="file"',
      "login",
      "status",
    ],
    {
      ...commonRunOptions,
      env: {
        ...subscriptionEnvironment.env,
        HOME: emptyHome,
        CODEX_HOME: emptyCodexHome,
      },
      timeoutMs: 15_000,
    },
  );
  const authMode = parseAuthMode(loginStatus);
  const canUseSubscription = version.code === 0 && authMode === "chatgpt_subscription";

  let structured:
    | {
        attempted: false;
        reason: string;
      }
    | {
        attempted: true;
        exitCode: number | null;
        failureCategory: FailureCategory | null;
        schemaValid: boolean;
        requestedModel: string;
        resolvedModel: string | null;
        exactModelResolved: boolean;
        outputSha256?: string;
        outputTruncated: boolean;
      };

  if (!canUseSubscription) {
    structured = {
      attempted: false,
      reason: "ChatGPT-subscription login was not confirmed",
    };
  } else {
    const outputPath = path.join(runDir, "structured-result.json");
    const prompt = [
      "This is a synthetic Hekayati G1-T feasibility probe.",
      "Do not inspect files, run commands, browse, or use tools.",
      "Return only the JSON object required by the supplied output schema:",
      '{"probe":"G1-T","status":"ok","message":"synthetic Hekayati Codex text probe","values":[1,2,3]}',
    ].join(" ");
    const result = await runProcess(
      codexBin,
      [
        "--ask-for-approval",
        "never",
        "exec",
        "--ephemeral",
        "--color",
        "never",
        "--sandbox",
        "read-only",
        "--model",
        requestedModel,
        "--output-schema",
        SCHEMA_PATH,
        "--output-last-message",
        outputPath,
        prompt,
      ],
      commonRunOptions,
    );
    let schemaValid = false;
    let outputSha256: string | undefined;
    try {
      const output = await readFile(outputPath, "utf8");
      schemaValid = validateStructuredFixture(JSON.parse(output));
      outputSha256 = createHash("sha256").update(output).digest("hex");
    } catch {
      schemaValid = false;
    }
    structured = {
      attempted: true,
      exitCode: result.code,
      failureCategory: classifyResult(result),
      schemaValid,
      requestedModel,
      resolvedModel: parseResolvedModel(`${result.stdout}\n${result.stderr}`),
      exactModelResolved:
        parseResolvedModel(`${result.stdout}\n${result.stderr}`) === requestedModel,
      outputSha256,
      outputTruncated: result.outputTruncated,
    };
  }

  let invalidModel:
    | { attempted: false; reason: string }
    | {
        attempted: true;
        exitCode: number | null;
        failureCategory: FailureCategory | null;
        normalizedAsExpected: boolean;
      };
  if (!canUseSubscription || skipInvalidModel) {
    invalidModel = {
      attempted: false,
      reason: !canUseSubscription
        ? "ChatGPT-subscription login was not confirmed"
        : "Skipped by operator",
    };
  } else {
    const result = await runProcess(
      codexBin,
      [
        "--ask-for-approval",
        "never",
        "exec",
        "--ephemeral",
        "--json",
        "--sandbox",
        "read-only",
        "--model",
        INVALID_MODEL,
        "Return the single word probe. Do not inspect files or use tools.",
      ],
      commonRunOptions,
    );
    const failureCategory = classifyResult(result);
    invalidModel = {
      attempted: true,
      exitCode: result.code,
      failureCategory,
      normalizedAsExpected:
        result.code !== 0 && failureCategory === "provider_unavailable",
    };
  }

  let cancellation:
    | { attempted: false; reason: string }
    | {
        attempted: true;
        cancellationRequested: boolean;
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        processGroupGone: boolean | null;
        noOrphanObserved: boolean;
        failureCategory: FailureCategory | null;
      };
  if (!canUseSubscription || skipCancel) {
    cancellation = {
      attempted: false,
      reason: !canUseSubscription
        ? "ChatGPT-subscription login was not confirmed"
        : "Skipped by operator",
    };
  } else {
    const result = await runProcess(
      codexBin,
      [
        "--ask-for-approval",
        "never",
        "exec",
        "--ephemeral",
        "--json",
        "--sandbox",
        "read-only",
        "--model",
        requestedModel,
        "Produce a long synthetic analysis without inspecting files or using tools.",
      ],
      { ...commonRunOptions, cancelAfterMs },
    );
    cancellation = {
      attempted: true,
      cancellationRequested: result.cancellationRequested,
      exitCode: result.code,
      signal: result.signal,
      processGroupGone: result.processGroupGone,
      noOrphanObserved:
        result.cancellationRequested && result.processGroupGone === true,
      failureCategory: classifyResult(result),
    };
  }

  const classifierTests = taxonomySelfTests();
  const missingBinaryCategory = classifyResult(missingBinary);
  const loggedOutCategory = classifyResult(loggedOut);
  const naturallyObservedCategories = [
    structured.attempted ? structured.failureCategory : null,
    invalidModel.attempted ? invalidModel.failureCategory : null,
    cancellation.attempted ? cancellation.failureCategory : null,
  ].filter((value): value is FailureCategory => value !== null);
  const naturalQuotaSignal = naturallyObservedCategories.find(
    (category) =>
      category === "quota_exhausted" || category === "rate_limited",
  );

  const automatedChecksPass =
    version.code === 0 &&
    authMode === "chatgpt_subscription" &&
    structured.attempted &&
    structured.exitCode === 0 &&
    structured.schemaValid &&
    structured.exactModelResolved &&
    invalidModel.attempted &&
    invalidModel.normalizedAsExpected &&
    cancellation.attempted &&
    cancellation.noOrphanObserved &&
    missingBinaryCategory === "provider_unavailable" &&
    loggedOutCategory === "invalid_credentials" &&
    classifierTests.every((test) => test.pass);
  const status = automatedChecksPass
    ? "REVIEW_REQUIRED"
    : canUseSubscription
      ? "INCONCLUSIVE_OR_FAILED"
      : "BLOCKED_OR_FAILED";

  const checks = {
    gate: "G1-T",
    status,
    generatedAt: new Date().toISOString(),
    runtime: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      codexVersion:
        version.code === 0
          ? sanitizedLine(`${version.stdout}\n${version.stderr}`)
          : null,
      binaryInvocable: version.code === 0,
      authMode,
      configuredModel: requestedModel,
      loginStatusSummary: sanitizedLine(
        `${loginStatus.stdout}\n${loginStatus.stderr}`,
      ),
    },
    credentials: {
      authFilesReadByProbe: false,
      apiKeyVariablesForwarded: [],
      apiKeyVariableNamesWithheld: subscriptionEnvironment.withheldVariables,
    },
    structured,
    cancellation,
    taxonomy: {
      missingBinary: {
        actualCategory: missingBinaryCategory,
        pass: missingBinaryCategory === "provider_unavailable",
      },
      invalidModel,
      loggedOut: {
        actualCategory: loggedOutCategory,
        pass: loggedOutCategory === "invalid_credentials",
        isolatedEmptyCredentialStore: true,
        currentLoginMutated: false,
      },
      classifierTests,
      quotaExhaustionForced: false,
      naturallyObservedQuotaOrRateLimit: naturalQuotaSignal ?? null,
      officialSourceEvidence: {
        commit: OFFICIAL_CODEX_SOURCE_COMMIT,
        mappings: {
          usage_limit_reached: "quota_exhausted",
          insufficient_quota: "quota_exhausted",
          ordinary_http_429_retry_limit: "rate_limited",
          refresh_token_unauthorized: "invalid_credentials",
        },
        sources: [
          `https://github.com/openai/codex/blob/${OFFICIAL_CODEX_SOURCE_COMMIT}/codex-rs/codex-api/src/api_bridge.rs`,
          `https://github.com/openai/codex/blob/${OFFICIAL_CODEX_SOURCE_COMMIT}/codex-rs/protocol/src/error.rs`,
        ],
      },
    },
    complianceReview: {
      status: "PENDING_HUMAN_REVIEW",
      officialSources: [
        "https://learn.chatgpt.com/docs/developer-commands.md?surface=cli",
        "https://learn.chatgpt.com/docs/auth.md",
        `https://github.com/openai/codex/tree/${OFFICIAL_CODEX_SOURCE_COMMIT}`,
      ],
    },
    rawProviderOutputPersistedInScorecard: false,
    artifactDirectory: path.join(
      "spikes",
      ".local-artifacts",
      "g1t",
      runId,
    ),
  };
  const evidencePayloadHash = createHash("sha256")
    .update(JSON.stringify(checks))
    .digest("hex");
  const scorecard = { ...checks, evidencePayloadHash };
  const scorecardPath = path.join(runDir, "scorecard.json");
  await writeFile(scorecardPath, `${JSON.stringify(scorecard, null, 2)}\n`, {
    mode: 0o600,
  });

  console.log(`G1-T probe status: ${status}`);
  console.log(`Sanitized evidence: ${scorecard.artifactDirectory}/scorecard.json`);
  console.log("Committed scorecard template remains PENDING until human review.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  console.error(`G1-T probe failed safely: ${sanitizedLine(message)}`);
  process.exitCode = 1;
});

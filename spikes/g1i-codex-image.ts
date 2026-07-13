import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type FailureCategory =
  | "provider_unavailable"
  | "image_capability_unavailable"
  | "invalid_credentials"
  | "quota_exhausted"
  | "rate_limited"
  | "timeout"
  | "network_failure"
  | "unknown";

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  timedOut: boolean;
  processGroupGone: boolean | null;
  outputTruncated: boolean;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_ROOT = path.join(SCRIPT_DIR, ".local-artifacts", "g1i");
const EXPECTED_FILENAME = "hekayati-g1i-probe.png";
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const API_KEY_ENV_NAMES = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

function usage(): string {
  return [
    "Operator-triggered G1-I Codex subscription image probe.",
    "",
    "Usage:",
    "  node --experimental-strip-types spikes/g1i-codex-image.ts [options]",
    "",
    "Options:",
    "  --codex-bin <path>        Codex executable (default: codex)",
    "  --timeout-ms <number>     Image call timeout (default: 300000)",
    "  --help                    Print this help without probing",
    "",
    "The probe performs at most one image-generation attempt. It never reads",
    "Codex auth files, never forwards API keys, and never uses real-person data.",
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
  const env: NodeJS.ProcessEnv = {
    NO_COLOR: "1",
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
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
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
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
    let settled = false;
    let killEscalation: NodeJS.Timeout | undefined;

    const forceKill = (): void => {
      try {
        stopProcessGroup(child, "SIGKILL");
      } catch {
        // The process-group check below records an unsuccessful stop.
      }
    };

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

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        stopProcessGroup(child, "SIGTERM");
      } catch {
        // The process-group check below records an unsuccessful stop.
      }
      killEscalation = setTimeout(forceKill, 1_000);
      killEscalation.unref();
    }, options.timeoutMs);

    child.once("close", async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
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
        processGroupGone,
        outputTruncated,
      });
    });
  });
}

function classifyResult(result: ProcessResult): FailureCategory | null {
  if (result.code === 0 && !result.timedOut) return null;
  if (result.timedOut) return "timeout";
  if (result.errorCode === "ENOENT") return "provider_unavailable";
  const value = `${result.stderr}\n${result.stdout}`.toLowerCase();
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
  if (
    /image[\s\S]{0,120}(unavailable|unsupported|not available|cannot generate)|imagegen[\s\S]{0,120}(missing|not found|unavailable|unsupported)|no image/.test(
      value,
    )
  ) {
    return "image_capability_unavailable";
  }
  if (/dns|connection reset|connection refused|network unavailable|socket hang up/.test(value)) {
    return "network_failure";
  }
  if (/command not found|no such file|not installed/.test(value)) {
    return "provider_unavailable";
  }
  return "unknown";
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

function eventTypes(jsonl: string): string[] {
  const types = new Set<string>();
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        item?: { type?: unknown };
      };
      if (typeof event.type === "string") types.add(event.type);
      if (typeof event.item?.type === "string") {
        types.add(`${String(event.type)}:${event.item.type}`);
      }
    } catch {
      // Raw output is intentionally neither persisted nor reported.
    }
  }
  return [...types].sort();
}

async function listImageArtifacts(
  root: string,
  current = root,
  depth = 0,
): Promise<string[]> {
  if (depth > 5) return [];
  const found: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    if (entry.isDirectory()) {
      found.push(...(await listImageArtifacts(root, absolute, depth + 1)));
    } else if (/\.(?:png|jpe?g|webp)$/i.test(entry.name)) {
      found.push(relative);
    }
  }
  return found.sort();
}

async function inspectExpectedImage(expectedPath: string): Promise<{
  exists: boolean;
  regularFile: boolean;
  symbolicLink: boolean;
  byteLength: number | null;
  pngSignatureValid: boolean;
  plausibleSize: boolean;
  sha256?: string;
}> {
  try {
    const info = await lstat(expectedPath);
    const symbolicLink = info.isSymbolicLink();
    const regularFile = info.isFile() && !symbolicLink;
    const plausibleSize =
      regularFile && info.size >= 1_024 && info.size <= MAX_IMAGE_BYTES;
    if (!regularFile || info.size > MAX_IMAGE_BYTES) {
      return {
        exists: true,
        regularFile,
        symbolicLink,
        byteLength: info.size,
        pngSignatureValid: false,
        plausibleSize,
      };
    }
    const bytes = await readFile(expectedPath);
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const pngSignatureValid =
      bytes.byteLength >= pngSignature.byteLength &&
      bytes.subarray(0, pngSignature.byteLength).equals(pngSignature);
    return {
      exists: true,
      regularFile,
      symbolicLink,
      byteLength: info.size,
      pngSignatureValid,
      plausibleSize,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        exists: false,
        regularFile: false,
        symbolicLink: false,
        byteLength: null,
        pngSignatureValid: false,
        plausibleSize: false,
      };
    }
    throw error;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(usage());
    return;
  }

  const codexBin = readOption("--codex-bin") ?? "codex";
  const timeoutMs = readPositiveInteger("--timeout-ms", 300_000);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const runDir = path.join(LOCAL_ROOT, runId);
  const workspace = path.join(runDir, "workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });

  const subscriptionEnvironment = makeSubscriptionEnvironment();
  const baseOptions = {
    cwd: workspace,
    env: subscriptionEnvironment.env,
    timeoutMs: 15_000,
  };
  const gitInit = await runProcess(
    "git",
    ["init", "--quiet", "--initial-branch=g1i-probe", workspace],
    baseOptions,
  );
  if (gitInit.code !== 0) {
    throw new Error("could not initialize the isolated nested probe workspace");
  }

  const version = await runProcess(codexBin, ["--version"], {
    ...baseOptions,
    timeoutMs: 10_000,
  });
  const loginStatus = await runProcess(codexBin, ["login", "status"], baseOptions);
  const authMode = parseAuthMode(loginStatus);
  const canUseSubscription = version.code === 0 && authMode === "chatgpt_subscription";

  let imageRun:
    | { attempted: false; reason: string }
    | {
        attempted: true;
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        timedOut: boolean;
        failureCategory: FailureCategory | null;
        eventTypes: string[];
        imageRelatedEventObserved: boolean;
        processGroupGone: boolean | null;
        outputTruncated: boolean;
      };
  if (!canUseSubscription) {
    imageRun = {
      attempted: false,
      reason: "ChatGPT-subscription login was not confirmed",
    };
  } else {
    const prompt = [
      "$imagegen",
      "Generate one original synthetic 1024x1024 square icon for a feasibility probe:",
      "a friendly flat citrus fruit with two green leaves on a plain cream background.",
      "No people, photographs, brands, text, or reference images.",
      `Save exactly one PNG to ./${EXPECTED_FILENAME}.`,
      "Use only the built-in subscription image-generation capability.",
      "Do not call an API, use an API key, browse, inspect other files, or run shell commands.",
    ].join(" ");
    const result = await runProcess(
      codexBin,
      [
        "--ask-for-approval",
        "never",
        "exec",
        "--ephemeral",
        "--json",
        "--sandbox",
        "workspace-write",
        prompt,
      ],
      { ...baseOptions, timeoutMs },
    );
    const observedEventTypes = eventTypes(result.stdout);
    imageRun = {
      attempted: true,
      exitCode: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      failureCategory: classifyResult(result),
      eventTypes: observedEventTypes,
      imageRelatedEventObserved: observedEventTypes.some((type) =>
        /image|imagegen/i.test(type),
      ),
      processGroupGone: result.processGroupGone,
      outputTruncated: result.outputTruncated,
    };
  }

  const expectedPath = path.join(workspace, EXPECTED_FILENAME);
  const expectedImage = await inspectExpectedImage(expectedPath);
  const imageArtifacts = await listImageArtifacts(workspace);
  const unexpectedImageArtifacts = imageArtifacts.filter(
    (artifact) => artifact !== EXPECTED_FILENAME,
  );
  const exactArtifactPass =
    expectedImage.exists &&
    expectedImage.regularFile &&
    !expectedImage.symbolicLink &&
    expectedImage.pngSignatureValid &&
    expectedImage.plausibleSize &&
    unexpectedImageArtifacts.length === 0;
  const status = !canUseSubscription
    ? "BLOCKED_OR_FAILED"
    : exactArtifactPass && imageRun.attempted && imageRun.exitCode === 0
      ? "REVIEW_REQUIRED"
      : "EXPECTED_FAIL_OR_INCONCLUSIVE";

  const checks = {
    gate: "G1-I",
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
      loginStatusSummary: sanitizedLine(
        `${loginStatus.stdout}\n${loginStatus.stderr}`,
      ),
    },
    credentials: {
      authFilesReadByProbe: false,
      apiKeyVariablesForwarded: [],
      apiKeyVariableNamesWithheld: subscriptionEnvironment.withheldVariables,
    },
    isolation: {
      nestedGitWorkspaceInitialized: true,
      sandbox: "workspace-write",
      approvals: "never",
      ephemeralSession: true,
      rawProviderOutputPersisted: false,
      syntheticInputOnly: true,
    },
    imageRun,
    artifact: {
      expectedRelativePath: path.join("workspace", EXPECTED_FILENAME),
      ...expectedImage,
      discoveredImageArtifacts: imageArtifacts,
      unexpectedImageArtifacts,
      exactArtifactPass,
    },
    sevenQuestions: {
      programmaticSubscriptionInvocation:
        imageRun.attempted && authMode === "chatgpt_subscription",
      reliableStructuredResults: "DEFER_TO_G1_T_SCORECARD",
      imageGenerationInvocable: exactArtifactPass,
      predictableLocalArtifact: exactArtifactPass,
      quotaDetection:
        imageRun.attempted &&
        (imageRun.failureCategory === "quota_exhausted" ||
          imageRun.failureCategory === "rate_limited")
          ? `NATURALLY_OBSERVED_${imageRun.failureCategory}`
          : "INCONCLUSIVE_NOT_FORCED",
      resumableWithoutDuplication: "NOT_TESTED_NO_REPEAT_GENERATION",
      officialBehaviorCompliance: "PENDING_HUMAN_REVIEW",
    },
    complianceReview: {
      documentedInvocation: "$imagegen",
      status: "PENDING_HUMAN_REVIEW",
      officialSources: [
        "https://learn.chatgpt.com/docs/image-generation.md",
        "https://learn.chatgpt.com/docs/developer-commands.md?surface=cli",
      ],
    },
    quotaExhaustionForced: false,
    artifactDirectory: path.join(
      "spikes",
      ".local-artifacts",
      "g1i",
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

  console.log(`G1-I probe status: ${status}`);
  console.log(`Sanitized evidence: ${scorecard.artifactDirectory}/scorecard.json`);
  console.log("Committed scorecard template remains PENDING until human review.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  console.error(`G1-I probe failed safely: ${sanitizedLine(message)}`);
  process.exitCode = 1;
});

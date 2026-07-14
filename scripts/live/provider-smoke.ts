import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export type LiveProvider = "codex" | "gemini";

export interface SmokeIntent {
  provider: LiveProvider;
  includeImage: boolean;
}

export interface SmokeReport {
  status: "PASS" | "FAIL" | "SKIP";
  provider: LiveProvider | null;
  operation: "structured_probe" | "structured_and_image_probe" | null;
  reason: string;
  durationMs: number;
  evidenceHash?: string;
}

const CONFIRMATION = "I_UNDERSTAND_PROVIDER_COST";

export async function runSmoke(
  argv: string[],
  environment: NodeJS.ProcessEnv,
  execute: (intent: SmokeIntent) => Promise<SmokeReport>,
): Promise<SmokeReport> {
  const provider = providerArgument(argv);
  if (!provider) return skipped(null, "provider_flag_required");
  if (!argv.includes("--execute")) return skipped(provider, "dry_run");
  if (environment.HEKAYATI_LIVE_PROVIDER_CONFIRM !== CONFIRMATION) {
    return skipped(provider, "explicit_confirmation_required");
  }
  return execute({ provider, includeImage: argv.includes("--image") });
}

function providerArgument(argv: string[]): LiveProvider | null {
  const index = argv.indexOf("--provider");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value === "codex" || value === "gemini" ? value : null;
}

function skipped(provider: LiveProvider | null, reason: string): SmokeReport {
  return {
    status: "SKIP",
    provider,
    operation: null,
    reason,
    durationMs: 0,
  };
}

async function executeLive(intent: SmokeIntent): Promise<SmokeReport> {
  const startedAt = performance.now();
  const [{ resolveDataPaths, prepareDataPaths }, { DocumentStore }] =
    await Promise.all([
      import("../../src/config/paths.js"),
      import("../../src/domain/repository/document-store.js"),
    ]);
  const [{ SettingsService }, { Redactor }, { createProviderSubsystem }] =
    await Promise.all([
      import("../../src/domain/settings/settings.js"),
      import("../../src/security/log.js"),
      import("../../src/providers/runtime.js"),
    ]);
  const paths = resolveDataPaths(process.env.HEKAYATI_DATA_DIR);
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  try {
    const settings = new SettingsService(store, paths);
    settings.initialize();
    const providers = createProviderSubsystem(
      settings,
      new Redactor(store.secretRegistry),
    );
    const tested = await providers.test(intent.provider);
    const durationMs = Math.round(performance.now() - startedAt);
    const evidenceHash = safeEvidenceHash(intent, tested.provider);
    if (tested.provider.authState === "missing") {
      return report(intent, "SKIP", "not_configured", durationMs, evidenceHash);
    }
    if (tested.provider.state !== "available") {
      return report(
        intent,
        "FAIL",
        "provider_unavailable",
        durationMs,
        evidenceHash,
      );
    }
    if (intent.includeImage && !tested.provider.image?.available) {
      return report(
        intent,
        "SKIP",
        "image_gate_unverified",
        durationMs,
        evidenceHash,
      );
    }
    return report(
      intent,
      "PASS",
      "bounded_probe_passed",
      durationMs,
      evidenceHash,
    );
  } catch {
    return report(
      intent,
      "FAIL",
      "sanitized_runtime_failure",
      Math.round(performance.now() - startedAt),
    );
  } finally {
    store.close();
  }
}

function report(
  intent: SmokeIntent,
  status: SmokeReport["status"],
  reason: string,
  durationMs: number,
  evidenceHash?: string,
): SmokeReport {
  return {
    status,
    provider: intent.provider,
    operation: intent.includeImage
      ? "structured_and_image_probe"
      : "structured_probe",
    reason,
    durationMs,
    evidenceHash,
  };
}

function safeEvidenceHash(intent: SmokeIntent, projection: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ intent, projection }))
    .digest("hex");
}

const entry = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : "not-an-entrypoint";
if (import.meta.url === entry) {
  const result = await runSmoke(
    process.argv.slice(2),
    process.env,
    executeLive,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "FAIL") process.exitCode = 1;
}

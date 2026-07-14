import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export interface CreativeSmokeIntent {
  provider: "gemini";
  maxReferenceImages: number;
  reliableCharacterCount: number;
}

export interface CreativeSmokeReport {
  status: "PASS" | "FAIL" | "SKIP";
  provider: "gemini" | null;
  operation: "synthetic_creative_image" | null;
  modelId: string | null;
  reason: string;
  durationMs: number;
  maxReferenceImages?: number;
  reliableCharacterCount?: number;
  evidenceHash?: string;
}

const CONFIRMATION = "I_UNDERSTAND_PROVIDER_COST";

export async function runCreativeSmoke(
  argv: string[],
  environment: NodeJS.ProcessEnv,
  execute: (intent: CreativeSmokeIntent) => Promise<CreativeSmokeReport>,
): Promise<CreativeSmokeReport> {
  const provider = providerArgument(argv);
  if (!provider) return skipped(null, "provider_flag_required");
  if (provider !== "gemini") return skipped(null, "image_provider_required");
  if (!argv.includes("--execute")) return skipped(provider, "dry_run");
  if (environment.HEKAYATI_LIVE_PROVIDER_CONFIRM !== CONFIRMATION)
    return skipped(provider, "explicit_confirmation_required");
  const limits = verifiedLimits(environment);
  if (!limits) return skipped(provider, "g2_limits_unverified");
  return execute({ provider, ...limits });
}

function providerArgument(argv: string[]): "gemini" | "codex" | null {
  const index = argv.indexOf("--provider");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value === "gemini" || value === "codex" ? value : null;
}

function verifiedLimits(environment: NodeJS.ProcessEnv) {
  const maxReferenceImages = positiveInteger(
    environment.HEKAYATI_GEMINI_MAX_REFERENCE_IMAGES,
  );
  const reliableCharacterCount = positiveInteger(
    environment.HEKAYATI_GEMINI_RELIABLE_CHARACTER_COUNT,
  );
  return maxReferenceImages !== null && reliableCharacterCount !== null
    ? { maxReferenceImages, reliableCharacterCount }
    : null;
}

function positiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function skipped(
  provider: "gemini" | null,
  reason: string,
): CreativeSmokeReport {
  return {
    status: "SKIP",
    provider,
    operation: null,
    modelId: null,
    reason,
    durationMs: 0,
  };
}

async function executeLive(
  intent: CreativeSmokeIntent,
): Promise<CreativeSmokeReport> {
  const startedAt = performance.now();
  const [{ prepareDataPaths, resolveDataPaths }, { DocumentStore }] =
    await Promise.all([
      import("../../src/config/paths.js"),
      import("../../src/domain/repository/document-store.js"),
    ]);
  const [
    { SettingsService },
    { Redactor },
    { createProviderRuntime },
    { resolvedImageRequestSchema },
  ] = await Promise.all([
    import("../../src/domain/settings/settings.js"),
    import("../../src/security/log.js"),
    import("../../src/providers/runtime.js"),
    import("../../src/providers/contract.js"),
  ]);
  const paths = resolveDataPaths(process.env.HEKAYATI_DATA_DIR);
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  try {
    const settings = new SettingsService(store, paths);
    const current = settings.initialize();
    const expectedModelId = current.models.geminiImage;
    const runtime = createProviderRuntime(
      settings,
      new Redactor(store.secretRegistry),
      {
        geminiLimits: {
          maxReferenceImages: intent.maxReferenceImages,
          reliableCharacterCount: intent.reliableCharacterCount,
        },
      },
    );
    const provider = runtime.registry.get("gemini");
    const connection = await provider.testConnection();
    if (!connection.ok) {
      return liveReport(
        intent,
        connection.failure.category === "invalid_credentials" ? "SKIP" : "FAIL",
        expectedModelId,
        connection.failure.category === "invalid_credentials"
          ? "not_configured"
          : `connection_${connection.failure.category}`,
        startedAt,
      );
    }
    const capability = connection.capabilities.image;
    if (
      !capability.available ||
      capability.modelId !== expectedModelId ||
      capability.maxReferenceImages !== intent.maxReferenceImages ||
      capability.reliableCharacterCount !== intent.reliableCharacterCount
    )
      return liveReport(
        intent,
        "FAIL",
        expectedModelId,
        "exact_capability_mismatch",
        startedAt,
      );
    const request = resolvedImageRequestSchema.parse({
      schemaVersion: 1,
      styleId: "modern_cartoon",
      scene: {
        pageNumber: 1,
        description: "قمر ورقي صغير يطفو فوق حديقة خيالية بلا أشخاص",
        participants: [],
        environment: "حديقة خيالية آمنة ليلية",
        composition: "تكوين بسيط ومتوازن لكتاب أطفال",
        cameraFraming: "لقطة واسعة",
      },
      referenceImages: [],
      negativeConstraints: [
        "no_extra_people",
        "no_in_image_text",
        "no_photoreal_child_face",
      ],
      output: { minWidthPx: 1024, minHeightPx: 1024 },
    });
    const result = await provider.generateImage(request, {
      signal: new AbortController().signal,
      timeoutMs: 180_000,
    });
    if (!result.ok)
      return liveReport(
        intent,
        "FAIL",
        expectedModelId,
        `generation_${result.failure.category}`,
        startedAt,
      );
    if (result.provenance.modelId !== expectedModelId)
      return liveReport(
        intent,
        "FAIL",
        expectedModelId,
        "exact_model_mismatch",
        startedAt,
      );
    return liveReport(
      intent,
      "PASS",
      expectedModelId,
      "synthetic_probe_passed",
      startedAt,
      createHash("sha256")
        .update(result.value.imageBytes)
        .update(result.provenance.settingsSnapshotHash)
        .digest("hex"),
    );
  } catch {
    return liveReport(
      intent,
      "FAIL",
      null,
      "sanitized_runtime_failure",
      startedAt,
    );
  } finally {
    store.close();
  }
}

function liveReport(
  intent: CreativeSmokeIntent,
  status: CreativeSmokeReport["status"],
  modelId: string | null,
  reason: string,
  startedAt: number,
  evidenceHash?: string,
): CreativeSmokeReport {
  return {
    status,
    provider: intent.provider,
    operation: "synthetic_creative_image",
    modelId,
    reason,
    durationMs: Math.round(performance.now() - startedAt),
    maxReferenceImages: intent.maxReferenceImages,
    reliableCharacterCount: intent.reliableCharacterCount,
    evidenceHash,
  };
}

const entry = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : "not-an-entrypoint";
if (import.meta.url === entry) {
  const result = await runCreativeSmoke(
    process.argv.slice(2),
    process.env,
    executeLive,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "FAIL") process.exitCode = 1;
}

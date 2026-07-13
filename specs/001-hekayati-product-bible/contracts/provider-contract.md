# Contract: Canonical AI Provider Interface

**Feature**: `001-hekayati` | Normative for FR-090…FR-108. Domain code depends ONLY on this contract; adapters (mock, codex, gemini) implement it. TypeScript signatures are illustrative of shape, binding at implementation time.

## Design rules

1. No provider type, model name, prompt text, or provider error string crosses this boundary outward.
2. Every operation is cancelable, timeout-bounded, and returns either a validated result or a `NormalizedFailure`.
3. Adapters attach `Provenance` to every successful result.
4. Capability discovery is dynamic — the domain never assumes a capability (FR-098, FR-102).

## Types

```ts
type ProviderId = 'mock' | 'codex' | 'gemini';

interface ProviderCapabilities {
  providerId: ProviderId;
  auth: { state: 'ok' | 'missing' | 'expired' | 'error'; detail: string };
  text: { available: boolean; structured: boolean; modelId?: string };
  image: {
    available: boolean;                 // codex: false until gate G1-I passes
    modelId?: string;
    maxReferenceImages: number;         // per request, from capability matrix / live check
    reliableCharacterCount: number;     // measured (gate G2); drives C-08 warning
    economyTier: boolean;               // triggers FR-108 warning
  };
  limits: { concurrencySuggested: number };
  unavailableReason?: string;           // human-readable, shown in UI verbatim
}

interface Provenance {
  provider: ProviderId; modelId: string; at: string;   // ISO time
  inputVersionRefs: Record<string, string>;            // entity → versionId
  promptVersion: string; referenceAssetIds: string[];
  attempt: number; settingsSnapshotHash: string;
}

interface NormalizedFailure {
  category: FailureCategory;            // fixed taxonomy — see job-scheduler-contract.md
  message: string;                      // safe for UI, secret-redacted
  retryable: boolean;                   // derived from taxonomy, echoed for convenience
  providerDetail?: string;              // redacted raw snippet for diagnostics
}
```

## Operations

```ts
interface AiProvider {
  // Health & discovery — cheap, cache ≤5 min, forced refresh before batches (FR-098)
  getCapabilities(): Promise<ProviderCapabilities>;
  testConnection(): Promise<{ ok: boolean; failure?: NormalizedFailure }>;

  // Text (free-form) — used for review notes, transformations
  generateText(req: TextRequest, ctl: CallControl): Promise<Result<TextResult>>;

  // Structured — THE workhorse. Adapter must return JSON matching `schemaId`
  // from contracts/structured-outputs.md; the CALLER re-validates regardless (FR-091).
  generateStructured<T>(req: StructuredRequest, ctl: CallControl): Promise<Result<T>>;

  // Image — references + directives in, raw image bytes out (saved by caller via asset store)
  generateImage(req: ImageRequest, ctl: CallControl): Promise<Result<ImageResult>>;
}

interface CallControl { signal: AbortSignal; timeoutMs: number; }
type Result<T> = { ok: true; value: T; provenance: Provenance }
               | { ok: false; failure: NormalizedFailure };
```

### StructuredRequest

```ts
interface StructuredRequest {
  schemaId: 'StoryPlan' | 'StoryText' | 'SceneList' | 'PagePrompt' | 'ReviewFindings';
  task: GenerationTask;        // provider-free compiled payload (below)
  languageDirectives: { storyDialect: 'egyptian_arabic'; register: string; ageBand: string };
}
```

### GenerationTask (compiled by domain, consumed by adapters)

Provider-free description: story config snapshot, participant set (exact character version data incl. selected look, per-scene props from mentions), template version content, hidden-goal directives, content boundaries, negative constraints (`no persons beyond listed participants`, `no story text inside artwork`, `no onomatopoeia`, style-legal constraints per FR-071). **Adapters compile this to provider-specific prompts**; prompt templates are versioned (`promptVersion` in provenance).

### ImageRequest

```ts
interface ImageRequest {
  styleId: string;                          // one of the three shipped styles (FR-070)
  scene: CompiledSceneForImage;             // participants, actions, emotions, environment…
  referenceImages: { characterId: string; assetIds: string[] }[]; // sheet-first strategy (R12)
  negativeConstraints: string[];
  output: { minWidthPx: number; minHeightPx: number };  // sized for 300 DPI at A4 print area
}
interface ImageResult { imageBytes: Uint8Array; mime: string; providerMeta?: object }
```

Adapter obligations for images: reject (as `invalid_input`) requests exceeding `maxReferenceImages`; map provider safety blocks to `safety_refusal`; a response with text-but-no-image or unexpected multiple images → `malformed_output` (caller may accept first image only when adapter marks it unambiguous — default is failure).

## Error normalization (adapter responsibility)

| Provider signal (examples) | Category |
|---|---|
| CLI not installed / binary missing | provider_unavailable |
| Logged out / expired ChatGPT session / bad API key | invalid_credentials |
| Subscription usage limit / quota | quota_exhausted |
| HTTP 429 / throttle | rate_limited |
| Deadline exceeded | timeout |
| DNS/conn reset | network_failure |
| Safety/content block | safety_refusal |
| Unparseable / schema-mismatched payload | malformed_output |
| Parsed but fails domain validation | output_validation_failed |
| Model id not found / deprecated | provider_unavailable (with model detail — never substitute, FR-098) |

## Provider-specific notes

- **codex**: shells `codex exec` via `execFile` (no shell). Auth state read from CLI (`codex login status`-equivalent). `image.available=false` until gate G1-I passes (research R6); `unavailableReason` carries the recorded limitation text. Never reads/writes Codex auth files. Never uses an OpenAI API key (FR-100).
- **gemini**: `@google/genai` with key fetched from Keychain per call (never cached to disk); model ids from settings; availability via model list/probe. Economy model sets `economyTier=true`.
- **mock**: deterministic outputs keyed by request hash; scriptable fault injection (per-call category, latency, partial output); used by tests and demo mode (FR-099).

## Quota-pause protocol (FR-096)

On `quota_exhausted`: adapter returns the failure; the scheduler (not the adapter) pauses sibling jobs sharing the provider, records `pauseReason`, and surfaces the wait-vs-switch decision. Adapters never retry quota failures internally and never switch providers.

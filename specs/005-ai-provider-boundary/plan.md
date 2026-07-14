# Implementation Plan: AI Provider Boundary

**Feature**: `005-ai-provider-boundary`

**Spec**: [spec.md](spec.md)

**Canonical plan**: [integrated plan](../001-hekayati-product-bible/plan.md)

**Tasks**: T-P4-01–T-P4-10

## Technical context

Extend the existing Node 22+ / TypeScript / Fastify / React / zod application. Add the official `@google/genai` package for production Gemini calls and keep Codex behind the installed CLI invoked without a shell. No provider SDK/type may enter `src/domain`. No job worker, queue, generation pipeline, product-content persistence, or live call runs automatically in this slice.

Automated verification uses Vitest, real local SQLite/FS where persistence matters, fixture transports/executables, and Playwright. It reads neither the real Keychain nor Codex auth store and performs no provider request. Operator-triggered live scripts are separately gated and sanitize evidence.

All source files retain the repository 800-line guard and focused-function lint. Provider files receive the same ≥80% per-directory coverage threshold as domain/security.

## Source layout

```text
src/providers/
  contract.ts                 # canonical zod schemas + inferred public types
  failures.ts                 # category schema, safe normalization helpers
  diagnostics.ts              # content-free hashes/shape/issue paths
  provenance.ts               # canonical settings hash + provenance factory
  generation-task.ts          # strict GenerationTaskV1 operation union
  structured-outputs.ts       # five output schemas + request-aware validation
  capability-cache.ts         # injected clock, ≤5 minute cache, forced refresh
  registry.ts                 # selected adapter lookup; no fallback
  runtime.ts                  # production/test dependency assembly
  prompt/
    styles.ts                 # three versioned original style configs
    policy.ts                 # deny-list check + hash-bound confirmation
    compiler.ts               # provider-specific prompt envelopes
    reference-budget.ts       # deterministic fair allocation + reduction note
  mock/
    adapter.ts
    deterministic-fixtures.ts
    fault-script.ts
  codex/
    adapter.ts
    process-runner.ts
    classify.ts
    output-parser.ts
  gemini/
    adapter.ts
    client.ts                 # minimal injectable @google/genai facade
    classify.ts
    output-parser.ts
src/server/providers/provider-service.ts  # credential/status orchestration
src/server/routes/provider-api.ts
src/ui/components/providers/
  ProviderStatusCard.tsx
  GeminiCredentialPanel.tsx
  PromptPolicyConfirmation.tsx
src/ui/views/SettingsView.tsx
src/ui/views/HealthView.tsx
scripts/live/provider-smoke.ts
tests/contract/providers/
tests/unit/providers/
tests/integration/provider-*.test.ts
tests/e2e/providers.spec.ts
```

Exact splits may change to keep files/functions focused; boundaries may not collapse.

## Canonical schemas

### Provider primitives

Implement strict zod schemas for:

- provider ID, schema ID, failure category, result, call-control input limits;
- capabilities with per-operation reasons and nullable verified image limits;
- version refs, generation settings snapshot/hash, provenance;
- text/structured requests and results;
- persisted `ImageRequestDraft` and runtime-only `ResolvedImageRequest`;
- strict image results with supported MIME and allow-listed provider metadata; and
- safe diagnostic summaries.

`AbortSignal` and `Uint8Array` are runtime-validated, not serializable persistence schemas. A test proves `JSON.stringify` is never used on a resolved request and the logger rejects/does not receive its bytes.

### GenerationTaskV1

Use a strict discriminated union keyed by `schemaId`:

```text
common = schemaVersion + schemaId + inputVersionRefs + participants
       + languageDirectives + contentBoundaries + negativeConstraints

StoryPlan      input = story config subset + template/custom structure + storyPageCount
StoryText      input = validated StoryPlan + narration/dialogue target
SceneList      input = validated StoryText + author-owned scene constraints
PagePrompt     input = one validated scene + selected style + reference-plan metadata
ReviewFindings input = exact validated story/scenes/page prompts under review
```

Participant entries contain only the selected character reference, display label needed by the story, relationship/narrative role, selected appearance description, and explicitly relevant traits. Use strict allow-lists and length/count limits. The compiler that converts 004 records into this union belongs to 007; 005 supplies schemas/fixtures and refuses unknown/private fields.

### Structured outputs

Each top-level schema requires `schemaVersion: 1` and uses strict nested objects/count bounds. A validator map keyed by `schemaId` performs:

1. bounded text/JSON parse;
2. zod shape validation;
3. request-aware participant, page-count, page-number, speaker, look, reference-plan, and mandatory-negative-constraint checks;
4. a success value with no unknown fields, or normalized failure with privacy-safe structural diagnostics.

Cross-check failures are `output_validation_failed`; syntax/non-JSON and invalid image container/selection are `malformed_output`. No invalid value reaches caller persistence APIs.

## Provider behavior

### Registry and capabilities

`ProviderRegistry` owns an explicit map; lookup of a selected unavailable provider returns `provider_unavailable`, never another adapter. `CapabilityCache` keys by provider + exact configured model tuple, uses an injected monotonic clock, expires at five minutes, and accepts `force=true`. Settings edits invalidate only affected cache entries.

Capability states:

- mock: auth OK, deterministic text/structured/image, unlimited reference boundary represented by the schema's finite maximum (20) rather than `Infinity`;
- Codex: text available only after binary/login/exact model/schema health; image always unavailable with the recorded G1-I reason and null image limits;
- Gemini: auth missing until Keychain read succeeds; exact account/model checks must pass; referenced image work remains unavailable while G2 boundaries are null. Economy selection sets `economyTier=true` and the warning regardless of connection state.

The mock finite maximum mirrors Hekayati's own maximum participant/reference schema, avoiding non-JSON numbers.

### Deterministic mock

Canonicalize request JSON with recursively sorted object keys and hash with SHA-256. A seeded fixture generator derives valid output values and a small metadata-clean PNG from the hash. Injected clock yields stable provenance. Fault scripts match operation/call index and can return every category, latency, abort behavior, partial/malformed output, invalid cross-reference, and malformed image variants. The mock never reads product storage or network.

### Codex

Build a reusable process runner around `spawn`/`execFile` argument arrays with:

- `shell:false`, detached process group on macOS, stdin policy, bounded stdout/stderr;
- environment allow-list that excludes OpenAI/Codex API-key variables;
- timeout/AbortSignal termination (`SIGTERM`, bounded escalation to `SIGKILL`) and orphan check;
- `codex --version`, `codex login status`, and exact `codex exec --model … --output-schema …` paths;
- JSONL/final-output parsing that confirms the resolved model; and
- fixed classifier precedence for missing binary/model, auth, subscription quota, ordinary rate limit, timeout, network, malformed output, and unknown.

Never inspect `~/.codex`, auth files, browser sessions, or API keys. Fixture executables assert argv/env/stdin/cancel behavior. Production image calls return the static G1-I result without spawning Codex.

### Gemini

Define a small injectable facade around only the `@google/genai` methods used. Construct the SDK/client from a Keychain value inside each call scope; do not store the key on provider/service fields. Use exact settings model IDs, JSON response schema for structured output, and local revalidation. Model discovery/listing is not sufficient: the explicit connection check runs a bounded synthetic structured probe. Image parsing requires exactly one unambiguous supported image, magic-byte/MIME agreement, decode success, and no text-only response.

Classifiers operate on SDK status/code/reason fields before bounded redacted messages. The adapter performs no retry. Automated tests inject a facade factory and canary key; production code is the only place importing `@google/genai`.

## Credential and settings lifecycle

### Settings schema v3

Add `geminiImageTier: default | economy`, preserve every v2 value, and change only `deferredStatus.providerLifecycle` to `available` to mean the subsystem exists. Real connection status remains runtime capability data. Migration and restart tests cover v1→v2→v3 and direct v2→v3.

### Keychain service

`GeminiCredentialService` wraps the implemented `MacOsKeychain` under account `operator`. Input schema: trimmed string, 1–512 bytes, no response echo. Register with the redactor before the Keychain write/client factory can fail. Status reads return a constant mask such as `••••••••`, never suffix/length. Save and delete invalidate Gemini capabilities. A connection test reads the key per call and lets the reference fall out of scope immediately.

Production runtime creates the real wrapper. Unit/integration tests inject an in-memory fake with the same interface. The process-level E2E uses a test-only fake `security` executable whose isolated state lives outside the app data root so Keychain-like presence survives app restart; that binary is injectable only through an explicit test runtime option and never exists in the production assembly. No automated path selects the real Keychain. Routes are small, no-store, safe projections behind the existing CSRF/origin guard.

Secret tests inspect:

- full SQLite dump and every document;
- structured log corpus across success/error/SDK exception;
- health/settings/API JSON and E2E screenshots;
- child-process argv/env captures;
- generated diagnostic/evidence corpus; and
- staged diff patterns before commit.

## Prompt policy and reference budgeting

### Style configuration

Ship three immutable version-1 configs keyed by 004 IDs: `modern_cartoon`, `colorful_2d`, and `soft_watercolor`. Each has original visual directives, palette/composition guidance, and the four mandatory negative classes: no extra people, no in-image story text, no onomatopoeia, no photoreal face/photo paste. Provider wrappers may format syntax but cannot weaken the canonical constraints.

### Deny-list confirmation

Normalize with trim/collapsed whitespace/NFC/Arabic tashkeel removal/Latin lowercase. The versioned policy data maps exact phrases/aliases to `living_artist` or `franchise_trademark`; it makes no claim of completeness. A hit returns matched categories plus an original-style alternative assembled from the selected Hekayati style. The confirmation token is SHA-256 over policy version, original prompt, alternative, and match set. Compilation requires the unchanged token; otherwise `invalid_input`. Store only the eventual compiled prompt/version/provenance later—005 itself persists no prompt.

The reusable Arabic `PromptPolicyConfirmation` component shows the issue and alternative, requires an explicit checkbox/action, and is keyboard/axe tested. The 007 generation screen must reuse the same state contract rather than bypass it.

### Budget algorithm

Input is ordered participants with ordered candidate views plus verified capabilities. Reject null limits, non-positive limits, duplicate IDs, foreign views, participant count above reliable count without the already-recorded 004 acknowledgement, and `maxReferenceImages < participantCount`. Allocate first view for each participant, then additional views round-robin until the cap. Return selected refs, requested/selected counts per participant, and a reduction note whenever different. No implicit lookup or bytes occur.

## Server/UI integration

Extend runtime assembly with injected `ProviderRuntimeDependencies`. `ProviderService` composes settings, Keychain, registry/cache, and safe logger. The API registers:

```text
GET    /api/providers/status
POST   /api/providers/:providerId/test
GET    /api/providers/gemini/credential
PUT    /api/providers/gemini/credential
DELETE /api/providers/gemini/credential
POST   /api/providers/prompt-policy/check
POST   /api/providers/prompt-policy/confirm
```

All responses are `Cache-Control: no-store`. Provider tests are explicit mutations because they may consume quota/network and therefore require the unsafe-request boundary. Invalid provider IDs/keys never reveal secret detail.

Update Settings with provider cards, exact model/tier controls, credentials, tests, timestamps, and warnings. Update Health with safe provider aggregate/detail while queue/printer remain deferred. Use Citrus tokens, logical CSS, Arabic MSA UI, Western digits/bidi isolation for model IDs/timestamps, visible focus, ≥44px targets, reduced motion, and responsive stacking.

## Live scripts

`scripts/live/provider-smoke.ts` is opt-in and refuses to run without an explicit provider flag and confirmation environment variable. It uses only synthetic citrus fixtures. Gemini missing-key exits as an environment skip without a request. Codex uses the existing subscription state and exact configured model; no API-key environment is forwarded. Evidence output includes versions, status/category, timings, and hashes—never prompts, results, account IDs, keys, paths, auth files, or images. Live image smoke is a separate explicit flag because it can cost money and remains blocked by current G2/G4 state.

## Test-first order

1. contract/request/result/capability/failure/provenance schemas and adversarial fixtures;
2. all five output schemas and request-aware cross-validation;
3. diagnostics, prompt policy/styles, reference budget, and provenance hashing;
4. generic adapter conformance harness and deterministic mock/faults;
5. Codex runner/parser/classifier fixture tests, including process groups/env isolation;
6. Gemini facade/parser/classifier fixture tests and per-call Keychain retrieval;
7. settings v3 migration, credential service, registry/cache, health, and API integration;
8. Arabic Settings/Health/component behavior, secret scans, axe/responsive tests;
9. provider-free US8 E2E with restart and browser request capture;
10. opt-in live script dry-run/missing-configuration tests; real smoke only when operator config exists.

## Verification commands

```bash
npm run check
npm run coverage
npm run build
npm run test:e2e
npm run format:check
npm audit --audit-level=high
git diff --check
```

Also run a dependency-empty Node 22 lockfile install, staged secret/URL/binary audit, provider-boundary import scan, and live-script dry-run. Record exact results and any environment skip in `IMPLEMENTATION_NOTES.md`; never label a skipped live check PASS.

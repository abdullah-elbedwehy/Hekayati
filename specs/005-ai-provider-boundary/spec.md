# Feature Specification: AI Provider Boundary

**Feature ID**: `005-ai-provider-boundary`

**Status**: Ready for implementation

**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

**Delivery tasks**: [Phase 4](../001-hekayati-product-bible/tasks.md#phase-4--provider-neutral-ai-orchestration)

This leaf owns delivery and acceptance; it does not restate or override canonical requirements. Precedence remains constitution → product bible → shared contracts → this slice → implementation.

## Outcome and boundary

The operator can configure and inspect provider/model choices without exposing a credential, test a configured connection explicitly, see honest text/image capability states, and use a deterministic mock for every provider operation. Codex text uses only the existing ChatGPT-subscription CLI login. Codex images remain visibly unavailable under G1-I. Gemini uses only a Keychain API key and stays unavailable until its exact configured model/account checks pass. No operation silently changes provider, model, prompt policy, or reference set.

Primary ownership is **US8; FR-090–091, FR-094–095, FR-098–103, FR-105–108, FR-134; SC-004; CHK101–105, CHK108, CHK111–115, CHK119–120**. This slice implements the normalized failure vocabulary consumed by 006 but does not implement retries, quota-pause state transitions, durable jobs, generation persistence, or creative acceptance.

The automated checkpoint is fixture-driven and provider-free. T-P4-09 supplies operator-triggered live scripts; a missing real Gemini credential is recorded as `not_configured`, not treated as a passing connection and not replaced by mock/Codex. G2/G4 remain environment-blocked exactly as recorded in Phase 0. That blocks real Gemini creative acceptance in 007, not the mock/conformance/settings implementation here.

## Readiness decisions

1. **Adapter IDs and provider selections are distinct concepts.** `mock`, `codex`, and `gemini` implement `AiProvider`. A later manual external-image selection is not an adapter and must not be represented as a fake successful provider call in 005.
2. **Capabilities fail closed.** Per-operation unavailability has its own safe reason. `maxReferenceImages` and `reliableCharacterCount` are nullable until verified. `null` never becomes zero, three, fourteen, or any other implicit default; referenced real-image work is unavailable while either required boundary is unset.
3. **Capability checks are explicit and cache-bounded.** Provider status reads may reuse a result for at most five minutes. “اختبار الاتصال” and every future pre-batch check force a refresh. Opening the app does not trigger a paid/image generation. A connection test may run only the documented cheap synthetic text/model probe and reports what was not tested.
4. **Schema validation is two-sided.** Adapters request provider-side schema constraints where supported, then Hekayati parses, validates the versioned zod schema, and performs request-aware cross-checks. Only a validated value leaves the boundary. No result is persisted by 005.
5. **Diagnostics retain shape, not content.** Malformed/invalid output diagnostics contain only a response hash, byte count, top-level type/keys when available, and the first ten issue paths/codes. Prompt/output bodies, rejected values, child/profile text, reference bytes, command lines, and credentials never enter logs or documents.
6. **Image drafts and resolved calls stay separate.** Persistable `ImageRequestDraft` contains provider-eligible references and version pins but no bytes. Only the later pre-dispatch resolver may create an in-memory `ResolvedImageRequest`. Adapters receive exact privacy-clean bytes plus allow-listed metadata, and no `AssetStore`, private-original type, path, arbitrary asset ID, or domain service.
7. **Credential lifecycle is a dedicated service/API.** The Gemini Keychain service uses one fixed operator account. Save/replace accepts a bounded secret body, registers it with the shared redactor before any fallible action, and returns only `{present, masked}` with a constant mask. Read-for-call happens per invocation; delete is explicit. The key never enters Settings, DB, health snapshots, logs, URLs, exports, screenshots, process argv, or returned errors.
8. **Model IDs are persisted configuration, never adapter constants.** Settings migration adds the explicit Gemini default/economy selection while preserving all operator fields. Availability means the exact configured ID passed the relevant runtime check; catalog/list presence alone cannot substitute or rename it.
9. **Codex is subscription-only.** The adapter launches an argument array without a shell, withholds API-key environment variables, never reads Codex auth files, uses `codex login status` for auth inspection, validates the exact requested/resolved model, bounds captured output, and terminates the process group on timeout/cancel. The image operation always returns the recorded G1-I unavailable state.
10. **Prompt policy never rewrites silently.** The three shipped style IDs map to versioned original directives with no artist/franchise names. A versioned normalized deny-list yields either `allowed` or `confirmation_required` with matched categories and a proposed original alternative. Confirmation binds the original, alternative, policy version, and hash; a changed prompt invalidates it.
11. **Reference budgeting preserves participants.** A verified budget is allocated round-robin in deterministic project order, one reference per participant before optional additional views. If even one per participant does not fit, compilation blocks. Any reduction records requested versus selected views and a UI notice/provenance note; it never silently removes a participant or crosses family/version ownership.
12. **Provider exceptions do not escape.** Expected auth, CLI, SDK, HTTP, cancellation, timeout, malformed, safety, and model failures return a validated `NormalizedFailure`. `retryable` is derived from the canonical category table for 006; adapters do not retry, pause, switch, persist, or create assets.
13. **Runtime dependencies are injectable.** Automated tests use a fake Keychain, fixture Codex executable/runner, fixture Gemini transport, injected clock, and deterministic random/PNG fixtures. CI never reads the operator's Keychain/Codex auth and makes zero provider request.

## Provider-neutral request contract

Every structured request uses a strict `GenerationTaskV1` discriminated union. Common fields are:

- `schemaVersion: 1`, `schemaId`, and the expected output `schemaVersion`;
- exact `inputVersionRefs` for provenance, kept out of free-form prompt prose except opaque `characterRef` values needed for response binding;
- only the confirmed participant records needed for the operation: `characterRef`, display label, relationship/narrative role, selected appearance description, and operation-relevant traits;
- Egyptian-Arabic language/register/age directives, content boundaries, and versioned negative constraints; and
- a strict operation payload: configuration/template input for `StoryPlan`; validated plan for `StoryText`; validated story plus author-owned scene constraints for `SceneList`; one compiled scene/style/reference plan for `PagePrompt`; or the exact validated artifacts under review for `ReviewFindings`.

Unknown keys are rejected. Customer contact/consent records, unrelated characters, library-wide records, local paths, asset bytes, original/private IDs, runtime tokens, credentials, logs, and unneeded notes are not valid task fields. `generateText` uses the same envelope with purpose `rewrite | review_note | prompt_transformation`; it returns one bounded text value. `generateImage` accepts only the ephemeral resolved request from the shared contract.

## Settings, health, and API contract

Settings migrate insert-only from schema v2 to v3 and retain existing values. New provider-owned configuration is:

- text/image provider selection;
- exact Codex/Gemini model IDs already present;
- `geminiImageTier: default | economy`;
- concurrency 1–4; and
- provider-subsystem delivery status `available` (distinct from any provider connection state).

Safe local endpoints under the existing origin/CSRF boundary provide:

- combined provider status/capabilities with cache timestamp/source;
- forced connection test for one provider;
- Gemini credential presence/save-replace/delete; and
- prompt-policy check/confirmation for the reusable operator flow.

Unsafe credential/policy mutations require the existing exact-origin + runtime CSRF checks. No endpoint returns a key, command output, provider response body, reference bytes, or full prompt. Health replaces the foundation placeholder with per-provider safe states and leaves queue/printer cells deferred.

The Arabic RTL Settings UI shows separate text/image selections, exact model fields, Gemini key absent/present status with constant masking, save/replace/delete/test actions, Codex CLI/auth/model state, the G1-I image limitation, last checked time, cache/live source, and the persistent economy warning. Disabled/unavailable state uses icon + text, not color alone. Confirmation and destructive actions are keyboard reachable and named precisely.

## Stable failure semantics

The canonical failure categories remain the API/test contract. Provider/API projections use the same names and safe remediation; no raw provider string becomes a public code.

| Condition | Category / behavior |
| --- | --- |
| malformed command/request, over reference budget | `invalid_input`; no dispatch when detectable locally |
| CLI missing, exact model absent/deprecated, G1-I image request, unmeasured required image limits | `provider_unavailable`; no substitution |
| missing/deleted Gemini key, Codex logged out/expired | `invalid_credentials` |
| subscription/API quota signal | `quota_exhausted`; adapter returns only—006 owns pause |
| ordinary 429/throttle | `rate_limited`; adapter returns normalized retry metadata only |
| abort requested | `user_canceled`; process/request termination attempted, no late success returned |
| watchdog elapsed | `timeout` |
| DNS/reset/offline | `network_failure` |
| safety/content block | `safety_refusal`; never auto-varied or retried here |
| unparseable/schema-alien/multiple-or-invalid image response | `malformed_output` or `output_validation_failed` with structural diagnostics only |
| unclassified provider error | `unknown`; safe bounded detail only |

Resolver-, disk-, database-, and stale-dependency categories remain representable in the shared schema/mock faults for downstream conformance, but adapters do not manufacture them.

## Acceptance scenarios

| ID | Scenario | Required evidence |
| --- | --- | --- |
| A-005-01 | Parse valid and adversarial fixtures for all five structured outputs and all request/result/capability/failure/provenance shapes. | Strict schema v1; page/participant/look/negative-constraint cross-checks; alien or malformed output never returned as success. |
| A-005-02 | Invoke every mock operation twice with identical input/clock, then with one changed input. | Identical validated content/image bytes and provenance for identical request hash; changed input changes hash/output; zero network. |
| A-005-03 | Script every failure category, latency, timeout, cancel, partial JSON, invalid schema, text-only image, MIME mismatch, corrupt bytes, and multiple image candidates. | One normalized result per case; no throw/raw body/log leak; cancellation completes without a late success. |
| A-005-04 | Attempt to pass original IDs, paths, store handles, unrelated references, and oversized reference sets into image operations. | Types/schema/harness reject them before adapter invocation; payload snapshot contains only resolved privacy-clean bytes and allow-listed metadata. |
| A-005-05 | Run Codex against fixture executables for missing binary, logged out, exact-model mismatch, structured success, quota/rate distinction, timeout, and cancel. | Correct safe capability/failure; no shell/API-key env/auth-file read/orphan; image always shows the recorded G1-I reason. |
| A-005-06 | Save, replace, test, restart, and delete a synthetic Gemini-shaped canary through a fake Keychain. | Constant mask only; canary absent from DB, logs, health, API responses, screenshots, process args, and staged export-like corpus; deletion yields `invalid_credentials`. |
| A-005-07 | Run Gemini conformance through a fixture transport, including provider-side schema, local revalidation, model list/probe, safety/quota/network mappings, and image variants. | Exact configured IDs used; key acquired per call; malformed responses fail; no provider-specific type crosses outward. |
| A-005-08 | Change an available configured model to an unavailable ID and exercise cache expiry/forced refresh. | Selected ID remains unchanged; capability becomes unavailable with remediation; no fallback; forced refresh bypasses ≤5-minute cache. |
| A-005-09 | Select each valid text/image pairing and the economy tier, save, restart, and inspect Settings/Health. | Persisted exact choices; economy warning remains visible; Codex-image limitation remains visible; subsystem and connection states are not conflated. |
| A-005-10 | Compile each shipped style and a prompt containing versioned artist/franchise deny-list fixtures. | Four negative-constraint classes always present; original-style alternative requires hash-bound confirmation; unconfirmed/stale confirmation makes zero provider call. |
| A-005-11 | Budget 1–20 participants across verified limits, reductions, insufficient one-per-person, and nullable boundaries. | Deterministic fair selection; participant never dropped; reduction note emitted; nullable/insufficient limit blocks. |
| A-005-12 | Exercise populated Arabic Settings/Health at 390×844, 1440×900, and 1920×1080 with keyboard and axe, then `SIGKILL`/restart. | RTL/Western digits/focus/targets/no clipping; choices and key presence survive appropriately; secret never appears; fixture E2E makes zero external request. |
| A-005-13 | Run operator-triggered live scripts with and without configured provider state. | Without credential: explicit `not_configured`/environment skip and no call. With operator configuration: one bounded synthetic structured smoke and optional image smoke, sanitized result hashes only. |

## Dependencies and downstream contract

Inputs from implemented slices:

- 002: strict settings/migrations, Keychain stdin wrapper, redactor/secret registry, structured logger, asset/reference type boundaries, health surface, local request boundary, and injected runtime/test patterns.
- 003: provider-reference metadata resolver and consent semantics. 005 consumes only its DTO/type boundary for conformance; byte loading/current-consent re-resolution remains 006.
- 004: stable style IDs, version-pinned participant/scene/template/page DTOs, compile acknowledgements, and nullable verified capability input.

Outputs consumed later:

- 006 receives validated adapters/registry, normalized failures, capability refresh, cancellation, and provenance factories; it alone owns durable retry/quota/switch/commit semantics and byte resolution immediately before dispatch.
- 007/011 receive strict generation requests, prompt policy, budget plans, and validated results. They cannot bypass capability/confirmation/output validation.
- 010 scans settings/log/archive corpora and must continue excluding credentials/provider raw bodies.
- The later external-manual image flow extends provider selection/provenance without pretending to implement `AiProvider` or weakening this boundary.

## Delivery mapping and checkpoint

| Master task | Primary acceptance |
| --- | --- |
| T-P4-01 | A-005-01, A-005-04 |
| T-P4-02 | A-005-01, A-005-03–04, A-005-07 |
| T-P4-03 | A-005-02–03 |
| T-P4-04 | A-005-06–08 |
| T-P4-05 | A-005-05, A-005-08 |
| T-P4-06 | A-005-10 |
| T-P4-07 | A-005-11 |
| T-P4-08 | A-005-06, A-005-08–09, A-005-12 |
| T-P4-09 | A-005-13 |
| T-P4-10 | A-005-06, A-005-09, A-005-12 |

Checkpoint PASS requires T-P4-01–10 implementation, all fixture/mock contract tests, Arabic Settings/Health E2E, secret/payload scans, provider import-boundary lint, ≥80% provider branch coverage, clean build/audit/install, and `IMPLEMENTATION_NOTES.md`. A missing live Gemini credential remains a documented external gate; it cannot be reported as live PASS and cannot cause fallback.

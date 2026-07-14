# Implementation Notes: 005 AI Provider Boundary

**Status**: Checkpoint PASS — 2026-07-14

**Scope**: Master tasks T-P4-01–T-P4-10

**Evidence**: [1920×1080 provider settings](evidence/005-providers-1920x1080.png)

## Delivered provider boundary

- One strict provider-neutral contract covers text, five structured-output schemas, and images. Persisted image drafts carry only stable identifiers and intent; adapters receive a separate runtime-resolved request containing approved bytes and allow-listed metadata.
- Deterministic mock, Codex subscription CLI, and Gemini API adapters implement the same capability, operation, cancellation, safe-failure, and provenance contract. Selection is explicit: there is no provider/model substitution, retry, or mock fallback.
- All structured results are locally revalidated with request-aware identity, page, speaker, look, participant, and artifact-reference checks before a caller can persist them. Image signatures and declared MIME types are validated before use.
- Codex execution uses an argv array with `shell: false`, prompt input on stdin, private temporary output/schema files, an API-key-excluding environment allow-list, bounded capture, timeout/abort process-group termination, and exact returned-model verification. Its image slot fails safely with the recorded G1-I subscription limitation and spawns no process.
- Gemini uses the official SDK, retrieves the fixed-account credential from Keychain for each call, probes the exact configured text/image models, requests structured schemas, revalidates locally, parses bounded PNG/JPEG/WebP image variants, maps provider failures to the safe taxonomy, and never retries implicitly.
- Capability results are keyed by the exact provider/model/tier tuple, expire after at most five minutes, and can be force-refreshed. Nullable or unmeasured image limits remain blocking rather than becoming planning constants.
- Prompt compilation supplies three extensible style configurations, versioned negative constraints, participant exclusions, deny-list transformation, hash-bound operator confirmation, payload minimization, and fair reference budgeting from verified runtime capabilities.
- Arabic RTL Settings and Health surfaces expose exact selected model IDs, credential lifecycle, connection tests, cache source/time, per-operation capability reasons, economy warnings, Codex image remediation, and provider subsystem health without displaying a secret.
- Credential APIs retain the existing loopback/origin/CSRF boundary, use `no-store`, constant masking, bounded safe responses, and a test-only fake Keychain. Opening or restarting the app makes zero provider calls.
- An operator-only live script requires both `--execute` and a separate cost confirmation. Dry-run, unconfirmed, and missing-configuration paths make zero executor call and report PASS/FAIL/SKIP separately.

## Verification record

| Command / check | Result |
| --- | --- |
| `npm run check` | PASS; lint, 183-file size guard, 9-file font hash guard, typecheck, 34 test files / 226 tests |
| `npm run coverage` | PASS; 90.27% statements, 82.40% branches, 94.72% functions, 93.01% lines; provider boundary 91.63% statements, 83.68% branches, 92.95% functions, 93.41% lines |
| `npm run format:check` | PASS; all source, test, script, and configuration files match Prettier |
| `npm run build` | PASS; production Vite UI and server TypeScript build with local fonts |
| `npm run test:e2e` | PASS; 7/7 Playwright journeys using one worker, including the complete provider lifecycle |
| `npm audit --audit-level=high` | PASS; 0 vulnerabilities |
| Clean lockfile install under Node 22 | PASS in an empty temporary dependency root |
| Import/firewall and runtime-limit scans | PASS; no provider/SDK import in `src/domain/**`, no SDK import outside approved provider/server boundaries, and no hard-coded planning-example limits |
| `git diff --check` and staged-content audit | PASS at checkpoint packaging; no secret, credential canary, child image, provider output, or unrelated workspace change included |

The populated provider journey covers every text/image provider pairing, exact model edits, economy selection, missing/replace/delete credential behavior, explicit mock/Codex/Gemini tests, prompt confirmation, Health projection, keyboard/focus and 44px targets, reduced motion, axe, zero non-loopback browser requests, `SIGKILL`, and restart. It exercises 390×844, 1440×900, and 1920×1080 layouts. The committed 1920×1080 evidence is synthetic and has SHA-256 `f00ebe9243a4e016eca240e85caccc2671a58cf92fd8aa6f48c6d469d493903c`.

The fixture conformance suites cover every normalized failure category and operation. Secret-canary assertions scan persisted documents, logs, responses, diagnostics, screenshots, process argv/environment capture, and live evidence. All automated tests use the isolated fake Keychain and fixture transports; they cannot reach a real provider.

## Live validation record

| Provider / operation | Outcome | Evidence |
| --- | --- | --- |
| Codex structured output | PASS | Explicit operator-authorized probe completed in 8,132 ms; sanitized evidence SHA-256 `424f1e99332a68da13fb8acf2f5a3fcb2569e50f14e3f3d4422232a4f74b80b4` |
| Codex image | SKIP — unsupported | G1-I records that ChatGPT-subscription Codex cannot generate images in this environment; the adapter returned the exact safe unavailable reason and spawned nothing |
| Gemini structured output | SKIP — not configured | No Gemini credential was available; no request was attempted |
| Gemini image | SKIP — not configured | No Gemini credential was available; G2/G4 remain unmeasured and no request was attempted |
| Gemini dry run | SKIP — dry run | Returned `durationMs: 0` with zero executor call |

PASS, FAIL, and SKIP are intentionally distinct. Fixture success does not rewrite the Phase 0 G2/G4 environment outcome, and the unconfigured Gemini paths remain closed.

## Requirement closure and downstream ownership

| Task / boundary | Evidence complete in 005 | Required later recheck |
| --- | --- | --- |
| T-P4-01–03, CHK101–103/108 | Strict contract, local validation, safe diagnostics, binary-only resolved images, deterministic mock, full failure conformance | 006 may invoke adapters only through durable attempt orchestration |
| T-P4-04–05, CHK111–114 | Gemini/Codex adapters, exact model/tier capability cache, explicit unavailability, cancellation, and process/request containment | Re-run Gemini live validation when a credential is deliberately configured |
| T-P4-06–07, CHK104/105/115 | Versioned prompt policy, confirmation, minimized payloads, and verified-capability reference budgeting | 007 compiles project participants and persists generation provenance/results |
| T-P4-08–10, US8 | Credential lifecycle, Arabic Settings/Health, operator-gated smoke tools, restart-safe E2E, and secret/egress scans | Phase 10 repeats provider checks inside the integrated first-book journey |

## Deliberately deferred

- Slice 006 owns durable queues, leases, attempts, retry scheduling, cancellation state, crash recovery, and idempotent artifact commits. The 005 adapters themselves perform no retry or job persistence.
- Slice 007 owns generation workflow state, story/scene/image artifact persistence, review findings, approval/invalidation integration, and the final resolver that turns approved asset identities into per-call bytes.
- Real Gemini G2 identity consistency and G4 print-quality measurements remain blocked until the operator deliberately configures a credential and authorizes potentially billable calls. Until then, reliable-character and maximum-reference values are null and image planning fails closed.
- No customer project content, child photo, generated story/image, approval, layout PDF, print output, archive, deletion workflow, or Studio generation was added by this slice.

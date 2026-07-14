# Verification Checklist: 005 AI Provider Boundary

**Status**: Required at implementation checkpoint

**Canonical checklist**: [AI reliability](../001-hekayati-product-bible/checklists/ai-reliability.md)

## Contract and validation

- [x] 005-C01 CHK101: lint proves `src/domain/**` imports no provider/SDK symbol and only the registry/jobs boundary can reach adapters.
- [x] 005-C02 CHK102/103: all five schema-v1 output suites include valid, malformed, unknown-key, alien-character, page-count, speaker, look, and reference-plan fixtures; invalid values never reach a persistence call.
- [x] 005-C03 CHK104: all three styles and both provider prompt compilers preserve the four mandatory negative-constraint classes.
- [x] 005-C04 CHK105: versioned deny-list fixtures require a hash-bound explicit original-style confirmation; stale/unconfirmed prompts make zero adapter call.
- [x] 005-C05 CHK108: malformed/validation diagnostics contain only hash/count/type/keys/issue paths and no raw prompt/output/field values.
- [x] 005-C06 Resolved-image schema/harness accepts only runtime bytes and allow-listed metadata; original IDs/paths/store handles/arbitrary assets cannot enter an adapter.

## Adapter conformance and failure honesty

- [x] 005-C07 T-P4-02/03: generic conformance runs every operation and normalized category against deterministic mock/fault scripts.
- [x] 005-C08 Codex fixture suite covers missing binary, logged out, exact-model mismatch, subscription quota versus ordinary 429, malformed schema, timeout, AbortSignal, process-group kill, bounded capture, and API-key environment exclusion.
- [x] 005-C09 CHK112: Codex image capability/API returns the exact safe G1-I unavailable reason and spawns no process; no OpenAI API-key field/path/dependency exists.
- [x] 005-C10 Gemini fixture suite covers per-call Keychain retrieval, response schema plus local revalidation, exact model probe, economy flag, safety/quota/rate/network mapping, supported/mismatched/corrupt/text-only/multiple image variants, and no retry.
- [x] 005-C11 Every adapter failure returns the validated safe union; expected provider failures do not throw, switch provider/model, persist content, retry, or create an asset.
- [x] 005-C12 Cancellation/timeout tests prove no late success and no orphaned Codex process/request continuation.

## Capabilities, models, prompts, and references

- [x] 005-C13 CHK111: capability cache expires by injected monotonic time, forced checks bypass it, and exact unavailable IDs remain selected with `provider_unavailable` remediation.
- [x] 005-C14 CHK113: economy choice persists across restart and shows a text+icon warning in Settings and capability projection.
- [x] 005-C15 CHK114: nullable/unverified reliable/max-reference values block; no test/source hardcodes the planning example of three or coerces documented fourteen into runtime truth.
- [x] 005-C16 CHK115: fair deterministic budgeting gives every participant one reference before extras, blocks insufficient budgets, and exposes requested/selected reductions in notice/provenance data.
- [x] 005-C17 Payload-minimization snapshots contain only operation participants/fields or exact resolved references; no customer contact, consent record, unrelated library data, path, secret, original, or unnecessary photo.
- [x] 005-C18 Provenance records actual adapter/model, input refs, prompt version, references, attempt, time, and canonical settings hash; fixture response model mismatch fails.

## Credentials, API, and privacy

- [x] 005-C19 CHK119: Phase 0 G1/G2/G4 outcomes remain visible and are not rewritten as live success by fixture tests.
- [x] 005-C20 Gemini save/replace/status/test/delete uses constant masking, bounded no-store API responses, existing CSRF/origin protection, and the fixed Keychain account; no real Keychain in automated tests.
- [x] 005-C21 Synthetic credential canary is absent from SQLite dump, document JSON, logs, error details, health/settings/bootstrap/API responses, screenshots, argv/env capture, diagnostic/live evidence, and staged diff.
- [x] 005-C22 Opening/restarting the app makes no provider call; only explicit connection/live actions or future forced pre-batch checks may access provider network/CLI generation.
- [x] 005-C23 Provider health distinguishes subsystem delivery, credential/auth, exact text model, exact image model, unmeasured G2 boundaries, cache age/source, and per-operation reason.

## Arabic UI and checkpoint

- [x] 005-C24 US8 Arabic Settings/Health journey covers all pairings, exact model edits, credential lifecycle, connection errors, Codex remediation, economy warning, prompt confirmation component, save, `SIGKILL`, and restart.
- [x] 005-C25 Axe/keyboard/focus/44px/reduced-motion/bidi/Western-digit and 390×844, 1440×900, 1920×1080 fit checks pass on populated provider states.
- [x] 005-C26 Browser fixture capture has zero non-loopback request; live scripts are excluded from CI and dry-run/missing-config paths make zero call.
- [x] 005-C27 `src/providers/**` has ≥80% statements/branches/functions/lines; `npm run check`, build, full E2E, audit, format, clean install, file-size guard, and staged-content audit pass.
- [x] 005-C28 `IMPLEMENTATION_NOTES.md` records exact automated results, live PASS/FAIL/SKIP separately, screenshot hashes, known G2/G4 limitation, and downstream 006/007 ownership.

# Provider Capability Matrix

**Feature**: `001-hekayati` | Companion to `contracts/provider-contract.md`, research R5–R7, R12.
Status column: **Confirmed** (verified), **Documented** (current official model docs, still subject to account/runtime checks), **Unverified** (not used as a product fact), **Environment unavailable** (the local credential/account gate could not run), and **Gated** (blocked on a named feasibility gate). Cells marked *G2-measured* are filled only by G2's structured scorecard and become runtime defaults after that gate passes.

| Capability | Mock | Codex (subscription) | Gemini (default) | Gemini (economy) | Status |
|---|---|---|---|---|---|
| Auth mechanism | none | ChatGPT login via Codex CLI store | API key in Keychain | API key in Keychain | Confirmed pattern |
| Text generation | ✔ deterministic | ✔ live via `codex exec` 0.144.3 with exact tested model `gpt-5.5` | ✔ `gemini-3.5-flash` when account probe passes | ✔ same text model | Codex confirmed (G1-T); Gemini documented / environment unavailable (G4) |
| Structured output (schema-constrained) | ✔ | ✔ `--output-schema` + local revalidation | ✔ response JSON schema + local revalidation when account probe passes | ✔ same text model | Codex confirmed (G1-T); Gemini documented / environment unavailable (G4) |
| Image generation | ✔ synthetic fixtures | **✘ unavailable** — G1-I failed (R6) | ✔ `gemini-3.1-flash-image` when account probe passes | ✔ `gemini-3.1-flash-lite-image` when account probe passes | Codex confirmed unavailable; Gemini documented / environment unavailable (G4) |
| Reference-image input for identity | ✔ simulated | n/a | documented multi-image input, including up to 4 character images | documented object-reference input; identity use unverified | Documented; account/quality gate failed (G2/G4) |
| Max reference images / request | ∞ | n/a | docs: 14 total; runtime boundary unset | docs: 14 object refs; runtime boundary unset | Environment unavailable (G2) |
| Reliable characters per image (identity holds) | ∞ | n/a | **unset** — no empirical score | **unset** — no empirical score | Gated (G2); real generation unavailable until measured |
| Character consistency quality | deterministic | n/a | intended default; not yet scored | not yet scored; persistent conservative warning FR-108 | Environment unavailable (G2) |
| Egyptian Arabic text quality | canned corpus | unverified; operator review required | unverified; operator review required | unverified; same text model | Gated on later rubric-based story acceptance; no quality claim from Phase 0 |
| Quota/limit signaling | scriptable | usage limit, ordinary retry-limit 429, and auth classified separately | 429/quota errors (runtime unverified) | same | Codex classifier confirmed against pinned official source signals; live exhaustion not forced; Gemini environment unavailable |
| Rate-limit metadata (Retry-After) | scriptable | not relied upon; bounded backoff only | unverified; bounded backoff only | same | Unverified and intentionally non-normative |
| Cancellation | immediate | process-group termination; no orphan observed | AbortSignal on request | same | Codex confirmed; Gemini documented pattern |
| Timeout control | scriptable | per-invocation watchdog | per-request | same | Confirmed pattern |
| Model availability check | always ok | CLI version + login status + exact-model probe | exact ID in models list + direct probe | same | Codex confirmed; Gemini environment unavailable |
| Cost model | free | subscription usage (never API billing, FR-100) | per-call API billing | cheaper per call | Confirmed policy |
| Offline behavior | works | fails → provider_unavailable | fails → network_failure | same | Confirmed |
| Provenance fields available | full | configured model + exact resolved-model connection probe | `response.modelVersion` required when account probe runs | same | Codex confirmed; Gemini environment unavailable |

## Product consequences

1. **Default pairing**: Gemini text + default Gemini images is the intended end-to-end path, but it remains unavailable until the exact configured IDs pass the local account connection test. G1 outcomes do not silently switch or authorize it (FR-102).
2. **Codex+Codex combination** is visible in Settings, but its image half shows the recorded G1-I unavailable reason. Selecting Codex text still requires an explicit available image-provider choice (no silent fill-in, Constitution VII).
3. **C-08 warning threshold** binds to "reliable characters per image" of the *selected* image model; scenes exceeding it require confirmation (FR-075). An unset/unverified reliable count makes that real model unavailable—it does not silently adopt the planning assumption of three.
4. **Reference budgeting**: prompt compiler allocates sheet views per character within max-reference budget; if 3 characters × 2 views exceeds the measured limit, compiler drops to 1 view per character and records the reduction in provenance + a UI notice (never silently below 1).
5. Economy model selection → persistent settings-level and per-generation warnings (FR-108).
6. Any documented or unverified cell that fails runtime verification updates this file + risk register before dependent phases proceed (Constitution XII).

## External manual image mode (Flow mode, FR-149–159)

Not a column above because it has no API surface. Auth: none (operator's own Google Labs session, outside the app). Text generation: n/a (pairs with any text provider). Image generation: operator-executed in Google Flow; the app's contract is prompt-pack out (FR-150) and validated file import in (FR-154–156). Quota/rate limits, cancellation, timeouts, model availability: n/a — jobs sit in `waiting_external_import` (FR-153). Cost model: covered by the operator's existing Google Labs subscription; zero per-image API billing (SC-015). Provenance: `external_manual` + declared tool label + pack/prompt checksums (FR-157). Reliable characters per image and consistency quality are operator-judged in Flow's character builder; C-08 warnings do not apply, but FR-118 review remains mandatory. Runtime capability verification (FR-098) does not apply; import validation is the trust boundary.

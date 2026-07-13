# Provider Capability Matrix

**Feature**: `001-hekayati` | Companion to `contracts/provider-contract.md`, research R5–R7, R12.
Status column: **Confirmed** (verified), **Assumed** (from training-time knowledge — verify at Phase 0), **Gated** (blocked on feasibility gate). Cells marked *G2-measured* are filled by gate G2's structured scorecard and become the runtime defaults.

| Capability | Mock | Codex (subscription) | Gemini (default) | Gemini (economy) | Status |
|---|---|---|---|---|---|
| Auth mechanism | none | ChatGPT login via Codex CLI store | API key in Keychain | API key in Keychain | Confirmed pattern |
| Text generation | ✔ deterministic | ✔ via `codex exec` | ✔ configured text model | ✔ same text model | Assumed (G1-T / G4) |
| Structured output (schema-constrained) | ✔ | ◐ CLI schema/JSON flag if installed version supports; else validated-JSON prompting | ✔ responseSchema JSON mode | ✔ | Assumed (G1-T / G4) |
| Image generation | ✔ synthetic fixtures | **✘ unavailable pending G1-I** (expected fail, R6) | ✔ image model | ✔ lite image model | Gated (G1-I) / Assumed (G4) |
| Reference-image input for identity | ✔ simulated | n/a until G1-I | ✔ multi-image input | ✔ but weaker | Assumed (G2) |
| Max reference images / request | ∞ | n/a | *G2-measured* (working assumption: ≥6 → 2 sheet views × 3 characters) | *G2-measured* (lower) | Gated (G2) |
| Reliable characters per image (identity holds) | ∞ | n/a | *G2-measured* (working default 3 → C-08 threshold) | *G2-measured* (expect 1–2) | Gated (G2) |
| Character consistency quality | deterministic | n/a | strongest available in stack — chosen default (Nano Banana 2) | degraded — persistent warning FR-108 | Assumed (G2) |
| Egyptian Arabic text quality | canned corpus | strong (frontier text model) | strong | strong (text uses non-lite model) | Assumed |
| Quota/limit signaling | scriptable | usage-limit errors distinguishable from auth errors | 429/quota errors + headers | same | Assumed (G1-T/G4) |
| Rate-limit metadata (Retry-After) | scriptable | ✘ (poll/backoff only) | ✔ typically | ✔ | Assumed |
| Cancellation | immediate | process kill (`execFile` child) | AbortSignal on request | same | Confirmed pattern |
| Timeout control | scriptable | per-invocation watchdog | per-request | same | Confirmed pattern |
| Model availability check | always ok | CLI presence + login status + probe call | models list / probe | same | Assumed |
| Cost model | free | subscription usage (never API billing, FR-100) | per-call API billing | cheaper per call | Confirmed policy |
| Offline behavior | works | fails → provider_unavailable | fails → network_failure | same | Confirmed |
| Provenance fields available | full | model id from CLI output | model id echoed by API | same | Assumed |

## Product consequences

1. **Default pairing**: Gemini text + Gemini Nano Banana 2 images works end-to-end regardless of Codex gates → product is never blocked by G1 outcomes (FR-102).
2. **Codex+Codex combination** is exposed in Settings but image half shows "unavailable — <G1-I recorded reason>" until the gate passes; selecting it keeps text on Codex and requires an explicit image-provider choice (no silent fill-in, Constitution VII).
3. **C-08 warning threshold** binds to "reliable characters per image" of the *selected* image model; scenes exceeding it require confirmation (FR-075).
4. **Reference budgeting**: prompt compiler allocates sheet views per character within max-reference budget; if 3 characters × 2 views exceeds the measured limit, compiler drops to 1 view per character and records the reduction in provenance + a UI notice (never silently below 1).
5. Economy model selection → persistent settings-level and per-generation warnings (FR-108).
6. Any "Assumed" cell that fails verification updates this file + risk register before dependent phases proceed (Constitution XII).

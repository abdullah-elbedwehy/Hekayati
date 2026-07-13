# G2 — Gemini Reference Consistency Scorecard

**Task**: T-P0-05

**Checked**: 2026-07-14

**Status**: FAIL (environment) — no provider calls made

## Fixture and privacy

- Four fictional vector-illustrated characters, created deterministically for this probe; no real person/customer resemblance or data.
- Two source views per character are composited into one PNG contact sheet, keeping the four-character run within the documented four character-reference-image allowance.
- Fixture kind: `deterministic-synthetic-vector`; source SHA-256: `ff85a348c1bf2db55f8b42fdf3575875064daf1741183e67abfe18216a52e4be`.
- Probe configuration SHA-256: `84629fb3cb51dfcf40e3d54c109d7479b47eb90db378a3eca75ef6f04bcc894e`.
- Raw references, provider payloads, and generated outputs remain under ignored `spikes/.local-artifacts/g2/`.

## Predeclared reproducible protocol

- For each configured image model, run exactly five controlled scenes for each participant count 1, 2, 3, and 4 (20 identity calls per model, no automatic retry).
- Participant selection is the first N characters in `fixtures/g2/manifest.json`; scene order is the five-entry manifest order.
- A scene succeeds only when every selected fictional identity is recognizable, identity traits remain stable, clothing is followed, every selected participant is present, and no unselected, duplicated, merged, or swapped person appears.
- Single-character baseline PASS: at least 4 of 5 scenes succeed.
- `reliableCharacterCount`: largest participant count whose five-scene set meets the same ≥4/5 threshold.
- Reference-limit procedure sends each model's documented subtype mix up to 14 total references (configured character-reference cap plus synthetic objects; objects only where no separate character cap is documented), then one above that total. If the documented maximum is rejected as input, a no-retry binary search measures the lower boundary. Quota, auth, timeout, model, or provider failures are inconclusive—not reference-limit evidence.
- HTTP 400 / `INVALID_ARGUMENT` counts as a reference boundary only when structured provider details unambiguously identify reference count or type; otherwise it is inconclusive.
- Any inconclusive reference prerequisite or global auth, quota/rate, model, timeout, version, or provider-contract failure stops remaining paid calls and atomically preserves partial review evidence.
- Human review is recorded in ignored `.local-artifacts/g2/manual-review.json`; rerun `npm run g2 -- --review-only` to recompute sanitized evidence without provider calls.
- Catastrophic default-model result: one referenced fictional character cannot meet 4/5, usable reference-image generation is unavailable, or the measured input boundary contradicts the configured documented maximum.

## Results

| Model | 1 character | 2 characters | 3 characters | 4 characters | max refs accepted | reliable count |
|---|---:|---:|---:|---:|---:|---:|
| `gemini-3.1-flash-image` | pending | pending | pending | pending | docs: 14; runtime pending | pending |
| `gemini-3.1-flash-lite-image` | pending | pending | pending | pending | docs: 14; runtime pending | pending |

## Sanitized output hashes

| Model | Participants | Five scene outputs |
|---|---:|---|
| `gemini-3.1-flash-image` | 1 | none |
| `gemini-3.1-flash-image` | 2 | none |
| `gemini-3.1-flash-image` | 3 | none |
| `gemini-3.1-flash-image` | 4 | none |
| `gemini-3.1-flash-lite-image` | 1 | none |
| `gemini-3.1-flash-lite-image` | 2 | none |
| `gemini-3.1-flash-lite-image` | 3 | none |
| `gemini-3.1-flash-lite-image` | 4 | none |

## Gate decision

**FAIL / PENDING**. A PASS additionally requires schema-valid review JSON bound to the current probe configuration, fixture sources, rendered inputs, exact model versions, scene identities, and on-disk output hashes. No empirical identity claim may be promoted earlier. No alias, preview ID, model substitution, fallback, or real-person fixture is permitted.

# G4 — Gemini Model and Account Availability Scorecard

**Task**: T-P0-04

**Checked**: 2026-07-14

**Status**: FAIL (environment) — credential unavailable; no provider calls made

## Official documentation result

| Hekayati role | Exact stable model ID | Documented capability |
|---|---|---|
| Text/structured | `gemini-3.5-flash` | Text output; structured outputs supported |
| Default image | `gemini-3.1-flash-image` | Image+text output; up to 14 refs, including up to 4 character images |
| Economy image | `gemini-3.1-flash-lite-image` | 1K image+text output; up to 14 object refs; no separate character-consistency allowance documented |

Official model cards mark all three IDs stable. The deprecation table lists no announced shutdown date for the configured text/default-image IDs; the Lite image model is stable but not listed in that table. Image models are probed for image output only; structured JSON is probed on the configured text model.

Official sources:

- <https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash>
- <https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image>
- <https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image>
- <https://ai.google.dev/gemini-api/docs/image-generation>
- <https://ai.google.dev/gemini-api/docs/structured-output>
- <https://ai.google.dev/gemini-api/docs/deprecations>
- <https://github.com/googleapis/js-genai/releases/tag/v2.11.0>

## Runtime result

- SDK version: `@google/genai` 2.11.0.
- Probe configuration SHA-256: `84629fb3cb51dfcf40e3d54c109d7479b47eb90db378a3eca75ef6f04bcc894e`.
- Credential source: unavailable (value never printed or persisted).
- Every direct probe requires a present `response.modelVersion` explicitly allowed for its exact requested stable ID; missing or mismatched versions fail closed and abort remaining paid probes.
- Raw provider payloads and generated images: ignored `spikes/.local-artifacts/g4/` only.

| Exact requested ID | Role | Account listing | Observed `modelVersion` | Direct probe |
|---|---|---|---|---|
| `gemini-3.5-flash` | text-structured | not run | not observed | not run (credential_unavailable) |
| `gemini-3.1-flash-image` | default-image | not run | not observed | not run (credential_unavailable) |
| `gemini-3.1-flash-lite-image` | economy-image | not run | not observed | not run (credential_unavailable) |

## Gate decision

**FAIL (environment, 2026-07-14)** until every configured exact ID is listed and its direct probe passes. No alias, preview ID, model substitution, or fallback is permitted.

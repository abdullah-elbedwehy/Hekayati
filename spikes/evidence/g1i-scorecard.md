# G1-I — Codex subscription image scorecard

**Status**: FAIL (expected) — Codex image mode remains unavailable.

**Task ID**: T-P0-03
**Canonical decision**: `research.md` R6
**Probe**: `spikes/g1i-codex-image.ts`
**Official documentation checked**: [Codex image generation](https://learn.chatgpt.com/docs/image-generation.md), [Codex non-interactive mode](https://learn.chatgpt.com/docs/developer-commands.md?surface=cli)
**Run command**: `cd spikes && npm run g1i`

The probe uses a synthetic citrus icon, explicitly invokes `$imagegen`, withholds API-key environment variables, and confines writes to ignored `spikes/.local-artifacts/g1i/.../workspace`. Do not commit the generated image or raw Codex event stream. Commit only sanitized facts and hashes.

## Run metadata

| Field | Recorded value |
|---|---|
| Run date/time | 2026-07-14 02:17–02:18 EEST |
| Operator | Codex delivery loop (synthetic citrus probe) |
| macOS version | 26.0 (25A354), arm64 |
| Node version | 22.23.1 |
| Codex CLI version | 0.144.3 |
| Authentication mode | ChatGPT subscription; no API-key variables forwarded |
| Exact expected artifact path | `workspace/hekayati-g1i-probe.png` |
| Valid local image SHA-256 | none — no image artifact was produced |
| Sanitized local evidence SHA-256 | `2455f4f8f4a0d0805207394993f1779984f95f9eec46f64200514fe4c0333980` |

## Seven-question gate

| # | Required evidence | Result | Sanitized evidence / reason |
|---|---|---|---|
| 1 | Programmatic invocation under ChatGPT subscription | PASS | `codex exec` ran under confirmed ChatGPT auth and completed with exit 0. |
| 2 | Reliable structured results for orchestration | PASS | G1-T independently verified JSONL plus schema-constrained final output on the same CLI/auth path. |
| 3 | Image generation is invocable programmatically through documented `$imagegen` | FAIL | The bounded `$imagegen` run emitted no image-related event and produced no image file. |
| 4 | One valid image is saved to the exact predictable local path | FAIL | `workspace/hekayati-g1i-probe.png` did not exist; no other image artifact existed. |
| 5 | Quota exhaustion is reliably detectable and distinct from auth/rate limits | INCONCLUSIVE | Exhaustion was not forced. G1-T proves the shared Codex taxonomy, but no supported image operation exists to validate image-specific signaling. |
| 6 | A run can resume without duplicating an already completed artifact | FAIL | No documented subscription image artifact/idempotency contract exists, and an uncontrolled repeat was not used to manufacture evidence. |
| 7 | The workflow complies with current official product behavior | FAIL | Official docs describe built-in image use in Codex/ChatGPT surfaces but direct **programmatic image generation** to the Image API; that API-key path is forbidden by FR-100. |

## Artifact inspection

| Check | Result | Notes |
|---|---|---|
| Exact filename exists | FAIL | `hekayati-g1i-probe.png` absent |
| Regular file, not symlink | FAIL | no file |
| PNG signature valid | FAIL | no bytes |
| Non-empty plausible image size | FAIL | no bytes |
| No unexpected image artifact | PASS | zero image artifacts discovered |
| API-key variables forwarded | PASS | none |

## Decision

- **Overall G1-I**: FAIL (expected, non-catastrophic)
- **Codex image availability**: UNAVAILABLE
- **Operator-facing unavailable reason**: “Codex subscription image generation has no verified programmatic local-artifact workflow. Use an explicitly selected Gemini image model; no provider or API-key fallback occurs.”
- **Required canonical updates**: R6, feasibility-gate table, provider capability matrix, RR-01, T-P0-03.

G1-I passes only when every answer is affirmative. Any failure or unresolved answer keeps Codex images unavailable; Gemini remains the explicit image path, with no hidden API-key or provider fallback.

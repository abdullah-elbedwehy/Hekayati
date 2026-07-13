# G1-T — Codex subscription text scorecard

**Status**: PASS — Codex text is available through the verified subscription workflow.

**Task IDs**: T-P0-01, T-P0-02
**Canonical decision**: `research.md` R5
**Probe**: `spikes/g1t-codex-text.ts`
**Official documentation checked**: [Codex non-interactive mode](https://learn.chatgpt.com/docs/developer-commands.md?surface=cli), [Codex authentication](https://learn.chatgpt.com/docs/auth.md)
**Run command**: `cd spikes && G1T_CODEX_BIN="$(command -v codex)" npm run g1t -- --model gpt-5.5`

Only copy sanitized facts from the ignored `spikes/.local-artifacts/g1t/.../scorecard.json`. Never commit raw Codex output, auth data, account identifiers, home-directory paths, or provider payloads.

## Run metadata

| Field | Recorded value |
|---|---|
| Run date/time | 2026-07-14 02:44 EEST |
| Operator | Codex delivery loop (synthetic probe) |
| macOS version | 26.0 (25A354), arm64 |
| Node version | 26.3.0 (probe process) |
| Codex CLI version | 0.144.3 |
| Exact configured model | `gpt-5.5` |
| Authentication mode | ChatGPT subscription (`codex login status`); no API-key variables forwarded |
| Official Codex source revision | `fb350d1e7d52c4c3b42f230a4715ee4adf314f08` |
| Sanitized local evidence SHA-256 | `5757c226c611a7103b59e721b05fc73d3bbfb89253cac14a75817758e7d48789` |

## Gate questions

| # | Required evidence | Result | Sanitized evidence / reason |
|---|---|---|---|
| 1 | Installed CLI is invocable non-interactively under ChatGPT-subscription login | PASS | CLI 0.144.3 reported `Logged in using ChatGPT`; the live `exec` turn completed with no API-key environment forwarded. |
| 2 | `codex exec --output-schema` returns the exact synthetic JSON fixture and local validation passes for the requested model | PASS | The invocation explicitly requested `gpt-5.5`; the CLI's run header reported resolved model `gpt-5.5`; exit 0 and exact local validation passed. Output SHA-256 `2e6c7dcd46411bf847d34168b88a5c8f30b5a090903b80947a2886d2524f5557`. |
| 3 | Quota/usage-limit failures are distinguishable from auth and ordinary throttling | PASS (source-backed) | Exhaustion was not forced. Classifier fixtures are bound to pinned official Codex source signals: `usage_limit_reached`/`insufficient_quota` → quota, ordinary retry-limit 429 → rate limit, refresh-token unauthorized → credentials. This establishes deterministic recognition without claiming a live exhausted-account observation. |
| 4 | Cancellation terminates the CLI process group and leaves no observable orphan | PASS | SIGTERM cancellation requested; process group confirmed absent after termination. |
| 5 | Current official product behavior permits the tested local non-interactive subscription workflow | PASS | Official non-interactive docs explicitly support `codex exec` in scripts, saved CLI auth, JSONL, output schemas, and ChatGPT-managed auth for trusted local automation. |

## Failure taxonomy

| Probe | Expected normalized category | Result | Notes |
|---|---|---|---|
| Deliberately missing binary | `provider_unavailable` | PASS | Safe local ENOENT probe; no provider call |
| Empty temporary `CODEX_HOME` login-status command | `invalid_credentials` | PASS | Isolated empty credential store; current login was not mutated or read |
| Deliberately invalid model | `provider_unavailable` | PASS | One bounded call; no model substitution |
| Naturally observed subscription exhaustion | `quota_exhausted` | NOT FORCED | Official-source fixture passed; no account exhaustion was manufactured |
| Ordinary throttle signal | `rate_limited` | PASS | Official-source retry-limit 429 fixture classified separately from usage exhaustion |
| Invalid structured result | `malformed_output` or `output_validation_failed` | PASS | The local boundary validates the exact schema; the live valid fixture passed |

## Decision

- **Overall G1-T**: PASS
- **Codex text availability**: AVAILABLE when CLI/runtime model checks pass
- **Gate interpretation**: “detectable” is satisfied by an authoritative pinned-source signal contract plus executable classifier fixtures. Live quota exhaustion was deliberately not manufactured and is not claimed as observed evidence.
- **Recorded limitation shown to operator if unavailable**: current stable CLI 0.144.3 resolved and ran exact model `gpt-5.5`, but rejected configured `gpt-5.6-sol` as requiring a newer CLI even though that slug appeared in its model catalog. Catalog presence alone is insufficient; the exact direct probe controls availability and no model may be substituted.
- **Required canonical updates**: R5, feasibility-gate table, provider capability matrix, RR-02, T-P0-01/T-P0-02.

Passing requires all five gate questions to have affirmative evidence. A missing or ambiguous answer is not a pass.

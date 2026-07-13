# AGENTS.md — Hekayati (حكايتي)

Instructions for any AI coding agent (Claude Code, Codex CLI, Cursor, etc.) working in this repository.

## Project

Local single-operator macOS web app producing personalized, printed children's picture books. One employee, one Mac, browser UI at `127.0.0.1`. AI providers: Codex (ChatGPT subscription) and Gemini (API key). Output: Egyptian Arabic stories, character-consistent illustrations, watermarked preview PDFs, print-ready interior + cover PDFs. Handles sensitive photos of children.

## State

**Specification phase — do not implement.** Production code may only be written after the user approves the Spec Kit artifacts in `specs/001-hekayati/`.

## Reading order

1. `.specify/memory/constitution.md` — binding principles.
2. `specs/001-hekayati/spec.md` — what the product does.
3. `specs/001-hekayati/plan.md` — how it will be built.
4. `specs/001-hekayati/tasks.md` — phased tasks.
5. Supporting artifacts in the same directory (research, data-model, contracts/, state-machines, invalidation-matrix, edge-case-catalog, risk-register, checklists/, test-strategy).

Precedence: constitution > spec > plan > tasks > code. Fix artifacts on conflict; never silently diverge.

## Non-negotiable rules

- Bind all services to `127.0.0.1`. No LAN exposure.
- No secret (Gemini key, Codex auth, Keychain content) in DB, logs, exports, UI, or error text.
- Child images: local only; send providers the minimum required per call; consent must be recorded.
- Validate all AI output against canonical schemas before use.
- No silent fallback / model substitution / provider switch / regeneration of approved content.
- Jobs are durable, idempotent, resumable; completed artifacts survive restart and crash.
- Upstream changes invalidate downstream artifacts only via the explicit invalidation matrix.
- Locked or approved pages never change as a side effect.
- Arabic RTL, shaping, and print quality are requirements, not polish.

## Workflow

Spec Kit (Specify) is initialized. Stage semantics: constitution → specify → clarify → plan → checklist → tasks → analyze → implement (gated on user approval). Scripts: `.specify/scripts/bash/`. Templates: `.specify/templates/`.

## Conventions

- UI: simple Modern Standard Arabic, RTL. Story text: natural Egyptian Arabic.
- Commits: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci). Commit only when the user asks.
- Small focused files (≤800 lines). TDD during implementation. 80%+ coverage target.
- Model IDs are configuration, never constants. Verify availability at runtime.

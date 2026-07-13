# AGENTS.md — Hekayati (حكايتي)

Instructions for any AI coding agent (Claude Code, Codex CLI, Cursor, etc.) working in this repository.

## Project

Local single-operator macOS web app producing personalized, printed children's picture books. One employee, one Mac, browser UI at `127.0.0.1`. AI providers: Codex (ChatGPT subscription) and Gemini (API key). Output: Egyptian Arabic stories, character-consistent illustrations, watermarked preview PDFs, print-ready interior + cover PDFs. Handles sensitive photos of children.

## State

**Delivery phase — full graph approved.** The user authorized the complete delivery loop on 2026-07-14 via `prompts/codex-full-delivery-loop.md`. Phase 0 probes and ordered slice delivery are allowed; implementation remains constrained by the phase and per-slice readiness gates below.

### Current gate behavior

- Full-graph approval is satisfied for this delivery loop. Do not request routine per-slice approval when analyze passes and no true clarification blocker remains.
- A slice whose readiness pipeline has not passed still blocks implementation of that slice; advance it through specify → clarify → plan → checklist → tasks → analyze first.
- Phase 0 probes are authorized and precede product scaffolding. Record evidence in the canonical research, capability, and risk artifacts.
- Product code may be created only for the current dependency-ready slice and its master task IDs. Failed blocking gates stop dependent phases, not unrelated work.
- Live-provider checks are operator-triggered and use synthetic inputs only. Real child/customer data remains forbidden in development, tests, Git, and agent output.

## Reading order

1. `.specify/memory/constitution.md` — binding principles.
2. `specs/README.md` — spec registry and dependency order.
3. `specs/001-hekayati-product-bible/spec.md` — canonical product behavior and stable IDs.
4. The relevant numbered feature slice(s) under `specs/002-*` through `specs/011-*`.
5. `specs/001-hekayati-product-bible/plan.md` — integrated architecture.
6. `specs/001-hekayati-product-bible/tasks.md` — master phased task registry.
7. Supporting artifacts in the bible directory (research, data-model, contracts/, state-machines, invalidation-matrix, edge-case-catalog, risk-register, checklists/, test-strategy).
8. For frontend or print-identity work: `PRODUCT.md` → `DESIGN.md` → `brand-kits/02-citrus-playground.html`.

Precedence: constitution > product bible and normative companions > feature slice > plan > tasks > code. A slice cannot redefine canonical behavior; amend the bible first. Fix artifacts on conflict; never silently diverge.

## Artifact change discipline

- Read the complete artifact being changed, plus every directly affected normative artifact. Do not edit from headings or summaries alone.
- Product behavior changes start in `spec.md`; architecture changes start in `plan.md` only after the behavior is specified.
- Propagate each accepted change through affected contracts, data model, state machines, invalidation matrix, edge cases, risks, checklists, test strategy, quickstart, and tasks.
- Preserve stable IDs (`FR-*`, `SC-*`, `C-*`, `EC-*`, `IM-*`, `RR-*`, `CHK*`, `T-P*-*`). Add new IDs; do not renumber existing IDs casually.
- Keep traceability bidirectional: every requirement has acceptance evidence/tasks, and every task cites its requirement or gate.
- Record unresolved facts as explicit assumptions, risks, or feasibility gates. Never present an unverified provider or print capability as available.
- Constitution amendments require rationale, amendment history, version update, and propagation to affected artifacts.

## Planned architecture boundaries

These rules apply once implementation is approved:

- Keep one Node.js/TypeScript package and one local process: Fastify API, React/Vite RTL UI, and in-process durable worker.
- Domain code stays provider-neutral. Provider prompts, SDK/CLI types, raw errors, and model names remain inside adapters.
- Only scheduler/orchestration code invokes providers. Persist canonical requests/results and normalized errors, not provider-specific domain state.
- Use SQLite-backed repositories for documents/transactions and a content-addressed filesystem store for media. Large media does not belong in JSON documents.
- Store versioned content immutably; changes create new versions and advance explicit head pointers.
- Asset writes and generated-file commits use temp file + validation + atomic rename. Never expose partial output as completed.
- Printer geometry, color settings, ICC profiles, DPI, bleed, and spine width come from `PrinterProfile`; never guess or hardcode them.

## Safety while working

- Use synthetic fixtures by default. Never add real child photos, customer data, provider payloads, generated customer assets, DB files, exports, or print files to Git.
- Never print secrets or sensitive payloads in terminal output, test snapshots, screenshots, fixtures, logs, or agent responses. Do not inspect Keychain/Codex auth unless the task explicitly requires it.
- Do not use shell interpolation for secrets. Provider and Keychain processes must use argument-safe APIs such as `execFile`, with the secret transport decision governed by `RR-08`.
- Preserve EXIF/privacy rules in every image path: validate content, apply orientation, strip metadata, enforce consent before provider transmission, and send the minimum payload.
- Import/export code treats archives as hostile: block traversal, symlinks, executables, checksum failures, unsupported future schemas, and insufficient disk space before commit.
- No external telemetry, analytics, crash reporting, CDN assets, cloud storage, or network service may be introduced.

## Implementation and verification rules

- Implement only the current phase and task IDs. Do not pull later-phase features forward unless the plan is amended.
- Use TDD: failing behavior-focused test, minimal implementation, then refactor. Include failure paths, restart recovery, and stale/canceled commit rejection where relevant.
- Use the deterministic mock provider for automated tests. Live-provider checks are operator-triggered, manual, consent-gated, and never part of CI.
- Run the narrowest relevant tests during iteration, then the phase checkpoint suite. Report commands run, results, and any checks not run.
- Security-sensitive changes (credentials, uploads, provider boundary, logging, exports/imports) require targeted negative tests and redaction/secret scans.
- PDF work requires rendered-output inspection plus mechanical preflight; source-level or snapshot-only checks are insufficient for Arabic shaping and print geometry.
- UI work must be checked with Arabic content at narrow and wide widths, correct RTL flow, keyboard navigation, visible focus, and no clipped/overflowing text.
- Do not weaken tests, schemas, preflight thresholds, privacy checks, or invalidation rules merely to make a check pass.

## Working-tree and handoff rules

- Inspect `git status` before edits. Preserve user changes and avoid unrelated rewrites.
- Never commit, push, create branches, delete data, or run destructive Git commands unless the user asks.
- Keep generated/runtime files out of the repository. Update `.gitignore` before running a tool that creates persistent local artifacts.
- End each task with: files changed, requirement/task IDs affected, verification performed, and remaining risks or blockers.

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

## Design system (mandatory for frontend)

Canonical visual language: **Citrus Playground (ملعب الليمون)** — kit `brand-kits/02-citrus-playground.html`, tokens `brand-kits/citrus-playground.tokens.css`, strategy in root `PRODUCT.md` + `DESIGN.md`, sidecar `.impeccable/design.json`.

**Before any frontend UI work** (pages, components, layout, motion, visual polish):

1. Load and follow **`/impeccable`** (read `PRODUCT.md` + `DESIGN.md` via its loader; use craft/shape/polish/etc. as appropriate).
2. Load and follow **`/frontend-design`**.
3. Do not invent a competing palette, font stack, or dark-default theme.

Register default: **product** (operator tool). Brand-committed citrus is allowed only on identity moments (wordmark, ending page, watermark, empty/first-run, Studio header) per `DESIGN.md`.

## Workflow

Spec Kit (Specify) is initialized. Stage semantics: constitution → specify → clarify → plan → checklist → tasks → analyze → implement (gated on user approval). Scripts: `.specify/scripts/bash/`. Templates: `.specify/templates/`.

## Conventions

- UI: simple Modern Standard Arabic, RTL. Story text: natural Egyptian Arabic.
- Visual: Citrus Playground only (see Design system above).
- Commits: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci). Commit only when the user asks.
- Small focused files (≤800 lines). TDD during implementation. 80%+ coverage target.
- Model IDs are configuration, never constants. Verify availability at runtime.

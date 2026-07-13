# CLAUDE.md — Hekayati (حكايتي)

Guidance for Claude Code when working in this repository.

## What this project is

Hekayati is a **local, single-operator macOS web application** for producing highly personalized, printed children's picture books. A single employee operates it from a browser on one Mac. Customers interact only over WhatsApp (outside the app). The app orchestrates AI providers (Codex subscription mode and Gemini API mode) to write stories in Egyptian Arabic, generate character-consistent illustrations, and produce watermarked preview PDFs plus print-ready interior and cover PDFs.

The product handles **sensitive photos of children**. Privacy, consent, and local-only operation are non-negotiable.

## Current project state

**Specification phase.** No production code exists yet. Implementation MUST NOT begin until the user explicitly approves the Spec Kit artifacts.

## Source of truth

1. `.specify/memory/constitution.md` — project constitution. Binding on all work.
2. `specs/001-hekayati/spec.md` — product specification.
3. `specs/001-hekayati/plan.md` — technical plan and architecture decisions.
4. `specs/001-hekayati/tasks.md` — phased implementation tasks.
5. Supporting artifacts in `specs/001-hekayati/` (research, data model, contracts, state machines, invalidation matrix, edge-case catalog, risk register, checklists, test strategy).

When code and spec disagree, the spec wins. When spec artifacts disagree with the constitution, the constitution wins. Fix the artifact, do not silently diverge.

## Spec Kit workflow

This repo was initialized with GitHub Spec Kit (Specify). Templates live in `.specify/templates/`, helper scripts in `.specify/scripts/bash/`. The Cursor skill definitions in `.cursor/skills/speckit-*` describe each workflow stage; follow the same stage semantics when running the workflow from Claude Code:

- constitution → specify → clarify → plan → checklist → tasks → analyze → (implement, only after approval).

Use `.specify/scripts/bash/create-new-feature.sh` to create new feature spec directories; `check-prerequisites.sh` to validate stage inputs.

## Hard rules (from the constitution — read it in full)

- Local-first: services bind to `127.0.0.1` only. Never expose to LAN.
- Child photos and derived assets never leave the machine except as the minimum payload required by the selected AI provider for a specific generation call.
- Secrets (Gemini API key, Codex auth) live in macOS Keychain / Codex's own auth store. Never in the database, logs, exports, error messages, or UI.
- AI output is untrusted until validated against canonical schemas. Human review gates all creative deliverables.
- No silent fallback, no silent model substitution, no silent provider switch, no silent regeneration of approved content.
- Long-running work is resumable, observable, idempotent. Completed artifacts survive crashes and restarts.
- Upstream edits explicitly invalidate downstream artifacts per the invalidation matrix — never silently.
- Approved/locked pages never change as a side effect of other work.
- Arabic RTL correctness and print quality are product requirements, not polish.

## Conventions

- UI language: simple Modern Standard Arabic, RTL layout.
- Generated story language: natural, age-appropriate Egyptian Arabic.
- Commit format: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci).
- Do not commit or push unless the user asks.
- Many small files over few large files; 800-line hard cap per file.
- TDD once implementation starts; tests define externally observable behavior.

## What NOT to do

- Do not start implementation before user approval of the spec set.
- Do not add out-of-scope features (auth screens, payments, customer portal, WhatsApp API, cloud hosting, automatic backups — see spec §Out of Scope).
- Do not assume Codex subscription image generation works; it is gated by Phase 0 feasibility findings in `specs/001-hekayati/research.md`.
- Do not hardcode AI model IDs; they are configurable settings with runtime availability checks.

# Implementation Plan: Hekayati (حكايتي)

**Branch**: `001-hekayati` | **Date**: 2026-07-14 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-hekayati/spec.md`

## Summary

Build a local, single-operator macOS web application that produces personalized printed children's books: character library → AI character sheets → Egyptian-Arabic story + scene generation → character-consistent illustrations → programmatic Arabic layout → watermarked preview PDF → recorded customer approval → print-ready interior + cover PDFs. Approach: one Node.js/TypeScript process (Fastify API + React RTL SPA + in-process durable job worker), document model on embedded SQLite, content-addressed asset store, provider-neutral AI contract with Codex-CLI and Gemini adapters plus a deterministic mock, Playwright/Chromium print-to-PDF for Arabic-correct output, Ghostscript for optional CMYK. All research and feasibility gates: [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js current LTS (≥22)
**Primary Dependencies**: Fastify (HTTP, loopback-bound), React 18 + Vite (RTL SPA), better-sqlite3 (embedded document store, WAL), Playwright/Chromium (Arabic PDF rendering), sharp + macOS `sips` (image processing, HEIC), Ghostscript (CMYK/ICC conversion), yazl/yauzl (ZIP), zod (schema validation for canonical contracts), @google/genai (Gemini), Codex CLI via `execFile` (subscription mode)
**Storage**: SQLite file (document collections, JSON docs + indexed fields) at `~/Library/Application Support/Hekayati/hekayati.db`; content-addressed media under `.../assets/`; secrets in macOS Keychain only
**Testing**: Vitest (unit/integration), Playwright (E2E + visual regression incl. Arabic golden files), failure-injection harness over the mock provider; details in [test-strategy.md](./test-strategy.md)
**Target Platform**: macOS (Apple Silicon + Intel), single machine, browser UI at `http://127.0.0.1:<port>`
**Project Type**: Local web application (backend + frontend + worker in one process)
**Performance Goals**: UI interactions <200 ms p95 (local); PDF render of 24-page interior <120 s; 2 concurrent image generations per provider (configurable 1–4); app cold start <10 s
**Constraints**: Loopback-only binding (verified at startup); offline-capable except provider calls; no daemons besides the app itself; all state restart-safe; no secrets outside Keychain; 800-line file cap
**Scale/Scope**: 1 operator; ~dozens of projects/year; ~10² characters; ~10⁴ assets; ~10⁴ jobs lifetime — comfortably inside embedded-engine envelope

## Constitution Check

*GATE: evaluated against Constitution v1.0.0 before Phase 0 research; re-checked after design.*

| Principle | Status | Notes |
|---|---|---|
| I Spec source of truth | PASS | This plan implements spec.md; conflicts resolved in artifacts (see analyze log at bottom) |
| II Simplicity | PASS | One process, one DB file, no daemons; the four preserved seams (provider, scheduler, assets, doc production) are constitutionally sanctioned |
| III Local-first & privacy | PASS | Loopback bind check (FR-110), Keychain-only secrets, payload minimization (FR-134), consent gate (FR-004) |
| IV Human review gates | PASS | waiting_review job states; approval records; no auto-advance (FR-114) |
| V AI output untrusted | PASS | zod validation of canonical schemas before persistence (FR-091) |
| VI Provider independence | PASS | Domain depends only on `contracts/provider-contract.md`; adapters own prompts/errors |
| VII No silent degradation | PASS | Quota-pause + explicit choice (FR-096); no model substitution (FR-098); text-shrink floor (FR-082) |
| VIII Durable/idempotent work | PASS | Lease + idempotency-key scheduler (R3); atomic asset writes (R4) |
| IX Versioned content | PASS | Version lineage on characters/looks/story/scenes/pages (data-model.md) |
| X Explicit invalidation | PASS | invalidation-matrix.md is normative; staleness flags, never auto-regen |
| XI Behavior-focused tests | PASS | test-strategy.md: black-box + failure injection; golden files for Arabic |
| XII Researched choices | PASS | research.md R1–R12 with alternatives; gates G1–G4 |
| XIII Arabic & print quality | PASS | Chromium shaping (R9), preflight (R10), SC-006/SC-008 |
| XIV Credential isolation | PASS | Keychain (R8), redaction tests (FR-131), export secret-scan (FR-126) |
| XV Verifiable phases | PASS | tasks.md phases each end with checkpoint + DoD |

No violations → Complexity Tracking table empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-hekayati/
├── spec.md                      # Product specification (source of truth)
├── plan.md                      # This file
├── research.md                  # R1–R12 + feasibility gates G1–G4
├── data-model.md                # Entities, versioning, relationships
├── quickstart.md                # Operator setup & first book walkthrough
├── state-machines.md            # Project / job / page / approval FSMs
├── invalidation-matrix.md       # Normative invalidation rules
├── provider-capability-matrix.md
├── edge-case-catalog.md         # Cases A–H → requirements mapping
├── risk-register.md             # Risks, mitigations, gates
├── test-strategy.md
├── contracts/
│   ├── provider-contract.md     # Canonical AI provider interface
│   ├── structured-outputs.md    # Canonical schemas (story plan, scenes, prompts…)
│   └── job-scheduler-contract.md
├── checklists/
│   ├── product-acceptance.md
│   ├── ai-reliability.md
│   ├── privacy-security.md
│   ├── print-production.md
│   └── ux-arabic-rtl.md
└── tasks.md                     # Phased implementation tasks
```

### Source Code (repository root — created during implementation, not now)

```text
src/
├── server/                # Fastify app, loopback guard, routes
│   ├── routes/            # customers, characters, projects, pages, jobs, settings, export, health
│   └── startup/           # bind check, migrations, integrity scan, seed templates
├── domain/                # Provider-free business logic
│   ├── customers/  characters/  looks/  mentions/
│   ├── story/             # config, templates, compile-to-generation-payload
│   ├── pages/             # versions, locks, review states
│   ├── approvals/         # records + invalidation engine (matrix implementation)
│   └── versioning/        # lineage, preconditioned commits
├── providers/
│   ├── contract.ts        # canonical types (mirrors contracts/provider-contract.md)
│   ├── schemas/           # zod schemas (mirrors contracts/structured-outputs.md)
│   ├── mock/              # deterministic + fault injection
│   ├── codex/             # CLI adapter (execFile), error normalization
│   └── gemini/            # @google/genai adapter
├── jobs/                  # scheduler, worker pool, leases, idempotency, recovery
├── assets/                # content-addressed store, atomic writes, integrity scan
├── layout/                # text placement analysis, dialogue bubbles, typography rules
├── pdf/                   # HTML templates, Playwright renderer, watermark, preflight, cover/spine, Ghostscript CMYK
├── portability/           # export/import, manifest, secret-scan, ZIP safety
├── security/              # keychain wrapper, log redaction, file permissions
└── ui/                    # React RTL SPA (Arabic), feature-organized components

tests/
├── unit/  integration/  contract/   # contract tests run against mock + real adapters
├── e2e/                             # Playwright journeys (Arabic UI)
├── golden/                          # Arabic shaping corpus, PDF fixtures, preflight defect fixtures
└── failure-injection/               # crash/restart/disk/network/provider-fault suites
```

**Structure Decision**: Single Node package (no monorepo tool — one deployable, one maintainer; YAGNI). `domain/` is import-clean of `providers/` internals; `providers/*` may not be imported outside `jobs/` + `providers/contract.ts` consumers — enforced by lint rule.

## Key Architecture Decisions (with rationale)

1. **One process, DB-driven recovery** (R1, R3): crash safety comes from persisted job state + leases, not process supervision. Simplest credible answer to FR-113.
2. **Document model on embedded SQLite** (R2): NoSQL flexibility at the data-model layer, ACID underneath — the queue, version preconditions, and import atomicity all need real transactions. Engine hidden behind repositories (swap-friendly).
3. **Provider contract as the only AI boundary** (R5–R7): domain compiles a provider-free GenerationRequest; adapters compile prompts, normalize errors to the fixed taxonomy, and attach provenance. Mock adapter is a first-class citizen enabling Phases 1–3 with zero AI dependency.
4. **Character-sheet-first consistency strategy** (R12): approved sheet images become the reference anchor for all page generations — the single highest-leverage mitigation for identity drift.
5. **Chromium as the Arabic typesetting engine** (R9): the only locally available, battle-tested Arabic shaping + BiDi + font-embedding stack; also unifies UI preview and PDF output (same HTML/CSS).
6. **Printer truth lives in PrinterProfile** (R10): bleed/DPI/color/ICC/spine are per-printer data, never constants; spine width hard-blocks when unknown (FR-122).
7. **Codex image mode gated, not assumed** (R6): G1-I expected to fail; product ships with Gemini images and an honest capability notice — no secret fallbacks (FR-100/102).

## Complexity Tracking

> No constitution violations to justify — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| — | — | — |

## Cross-Artifact Analysis Log (speckit.analyze equivalent)

Findings fixed during consistency pass (2026-07-14):

1. Spec FR-087 initially implied print-profile change "may not require approval" ambiguously → tightened: never invalidates content approval, always re-triggers preflight. Matrix row IM-14 matches.
2. Research R8 argv-exposure concern lacked a risk entry → added RR-08 with Phase 1 verification action.
3. Edge case E-05 (system clock changes) had no owning requirement → scheduler contract §Leases now specifies monotonic-clock lease arithmetic; task T-P5-08 covers it.
4. C-08 default threshold (3 characters) had no measurement source → bound to gate G2 output; capability matrix carries the measured value; C-08 marked "tunable per matrix".
5. Preview watermark check existed only as generation-time behavior → added to preflight rule list (FR-123/124) so "final PDF still contains watermark" and "preview missing watermark" are both mechanically detected.
6. Template-from-story privacy stripping (FR-051) initially unmapped to a test → test-strategy §Privacy adds a dedicated fixture; task T-P3-07.

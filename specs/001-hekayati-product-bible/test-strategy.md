# Test Strategy

**Feature**: `001-hekayati` | Constitution XI: behavior-focused, failure-injection first-class, 80%+ coverage on domain/scheduler/adapters/PDF pipeline. TDD during implementation (red→green→refactor).

## Levels

### 1. Unit (Vitest)

Pure logic: mention parsing/resolution (Arabic diacritics, spaces, duplicates — FR-040), invalidation engine vs matrix rows (every IM row = at least one test), version lineage + commit preconditions, prompt compiler (negative constraints always present, deny-list FR-071), reference budgeting (capability matrix §4), narration/dialogue balance suggestion, text-placement region math, spine-block rule, idempotency key derivation, secret-scan patterns, ZIP entry validation.

### 2. Contract (Vitest)

Provider adapters tested against `contracts/provider-contract.md` + `structured-outputs.md`:

- **Mock**: full conformance (reference implementation).
- **Codex/Gemini**: same conformance suite behind env-gated live flags + recorded-fixture mode for CI; error-normalization table verified with synthesized provider errors (each taxonomy row → one test).
- Schema suite: valid/invalid fixtures per schema (page-count mismatch, alien characterRef, missing negative constraints, deny-list hits).

### 3. Integration (Vitest, real SQLite + real FS in tmp)

Scheduler: dependency ordering, fan-out concurrency caps, lease expiry/reclaim, duplicate enqueue, quota-pause protocol end-to-end, cancel-with-late-result, restart recovery (kill worker thread mid-job), monotonic-clock leases under simulated wall-clock jumps (EC-E05).
Asset store: atomic write crash simulation (kill between temp-write and rename → temp orphan swept; between rename and DB commit → unindexed rename swept, then an explicit retry creates one indexed asset and subsequent identical retries increment its refcount), dedup on identical bytes with canonical-metadata conflict rejection, integrity scan. A per-data-root process lock is acquired before destructive startup recovery so a second launch cannot sweep an in-flight first process's rename. Unowned non-empty data roots fail before mutation, and unknown filenames inside an owned assets directory survive GC.
Repositories: document validation, migration, permanent-delete cascade with media removal verification.
Local HTTP trust boundary: prove each forbidden listener address is rejected before socket open, then independently verify the accepted listener's effective address after listen; drive a raw HTTP harness across canonical/invalid authority, DNS-rebinding names, forwarded-host spoofing, cross-origin CORS/PNA preflights, source-header variants, every unsafe method, and current/stale CSRF tokens. Each rejection asserts that a persisted sentinel and route-dispatch counter are unchanged (FR-147, FR-148, SC-014).
Export/import: round-trip fidelity, every EC-G case as a fixture archive (corrupt, traversal, symlink, future-version, checksum mismatch, interrupted-commit rollback).

### 4. Failure injection (dedicated suite)

Scripted mock-provider faults per taxonomy row × retry-policy assertion; disk-full via quota'd tmpfs-like fixture (small dedicated volume/dir quota); network-loss (adapter-level fault); app-kill matrix: {during story gen, during image fan-out, during PDF render, during import commit} × restart → SC-002 assertions (no duplicates, completed intact).

### 5. E2E (Playwright, Arabic RTL UI)

Journeys mirror user stories US1–US11 using the mock provider; assertions on UI state, persisted state, and produced files. Includes: full first-book journey (quickstart script), quota-pause decision flow, page-7 regeneration isolation (checksum comparison of sibling page files — SC-003), approval invalidation flow (SC-010/011), settings key lifecycle with DB/log/export secret scans (SC-005), and canonical-origin restart/reload with stale-token rejection followed by a fresh-token success (SC-014).

### 6. Visual regression & golden files

- **Arabic shaping corpus** (gate G3): connected forms, lam-alef, tashkeel, Arabic punctuation, mixed-direction lines (Latin names/numbers), long names — rendered to PDF, rasterized, pixel-diffed against approved goldens (SC-008).
- **PDF geometry goldens**: A4+bleed page boxes, crop marks, cover spread geometry per test printer profile, watermark presence/absence.
- **Layout presets**: each placement mode + gradient/panel aids over fixture artwork; RTL screenshots at 1440×900 and 1920×1080 (SC-012); reduced-motion respected.

### 7. Preflight defect fixtures (SC-006)

One seeded defect fixture per FR-123 category (wrong dims, wrong count, missing image, low-res, overflow, missing font, missing bleed, unsafe margins, invalid spread, unknown spine, corrupt PDF, failed conversion, watermark-in-print, missing-watermark-in-preview) — preflight must flag each; suite fails if any fixture passes preflight.

### 8. Privacy & security suite

Secret-scan over: DB dump, full log corpus after a scripted "noisy" run, every export fixture (SC-005), and runtime-token canaries (FR-148). Log-redaction unit tests (Gemini key patterns, image bytes). File-permission assertions (0700/0600). Bind-address tests cover EC-H06 plus every FR-147 listener/authority fixture. Browser-request forgery tests cover EC-H09–H13 and CHK222–226, including `no-store` bootstrap assertions, without relying on browser CORS enforcement alone. Consent gate test (EC-H01). Template-from-story privacy stripping fixture (FR-051): source story with photos/names → template contains neither.

## Live-provider validation (manual, gated, not CI)

Phase 0 gate scripts G1-T/G1-I/G2/G3/G4 with structured scorecards recorded into research.md. Recurring smoke: one cheap Gemini structured call + one image call behind an operator-triggered "connection test" (FR-105) — never automatic in CI.

## Coverage & gates

- Coverage floor 80% on `domain/`, `jobs/`, `providers/`, `pdf/`, `portability/`, `security/`, and `server/security/` (per-directory, not just global).
- CI order: lint → typecheck → unit → contract(mock+fixtures) → integration → failure-injection → E2E(mock) → golden/visual → privacy suite.
- Every FR referenced by at least one test ID or checklist item (traceability audited at the analyze stage; checklists cross-link).
- AAA structure; descriptive behavior names; no implementation-detail assertions (Constitution XI).

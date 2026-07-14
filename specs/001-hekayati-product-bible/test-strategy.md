# Test Strategy

**Feature**: `001-hekayati` | Constitution XI: behavior-focused, failure-injection first-class, 80%+ coverage on domain/scheduler/adapters/PDF pipeline. TDD during implementation (red→green→refactor).

## Levels

### 1. Unit (Vitest)

Pure logic: customer/consent schemas and both stable refusal codes, including description-only vs photo-derived sheet lineage; family scope, exact name normalization, assign-once anchor, and duplicate-candidate policy; immutable character/look version append + head-CAS; exact 003-owned IM-01–03/05/21 multi-row classification plus 004-owned IM-04 project-override classification; photo compressed/pixel limits, versioned metric thresholds, and warning codes; mention parsing/resolution (Arabic diacritics, spaces, duplicates — FR-040), invalidation engine vs matrix rows (every IM row = at least one test), version lineage + commit preconditions, prompt compiler (negative constraints always present, deny-list FR-071), reference budgeting (capability matrix §4), narration/dialogue balance suggestion, text-placement region math, spine-block rule, idempotency key derivation, secret-scan patterns, ZIP entry validation.

### 2. Contract (Vitest)

Provider adapters tested against `contracts/provider-contract.md` + `structured-outputs.md`:

- **Mock**: full conformance (reference implementation).
- **Codex/Gemini**: same conformance suite behind env-gated live flags + recorded-fixture mode for CI; error-normalization table verified with synthesized provider errors (each taxonomy row → one test).
- **Image boundary**: adapters receive only ephemeral `ResolvedImageRequest` bytes/safe metadata; the harness proves they cannot load arbitrary assets/originals and that drafts, intake tokens, and image bytes never enter logs.
- Schema suite: valid/invalid fixtures per schema (page-count mismatch, alien characterRef, missing negative constraints, deny-list hits).

### 3. Integration (Vitest, real SQLite + real FS in tmp)

Scheduler: dependency ordering, fan-out concurrency caps, lease expiry/reclaim, duplicate enqueue, quota-pause protocol end-to-end, cancel-with-late-result, restart recovery (kill worker thread mid-job), monotonic-clock leases under simulated wall-clock jumps (EC-E05).
Asset store: atomic write crash simulation (kill between temp-write and rename → temp orphan swept; between rename and DB commit → unindexed rename swept, then an explicit retry creates one indexed asset and subsequent identical retries increment its refcount), dedup on identical bytes with canonical-metadata conflict rejection, integrity scan. A per-data-root process lock is acquired before destructive startup recovery so a second launch cannot sweep an in-flight first process's rename. Unowned non-empty data roots fail before mutation, and unknown filenames inside an owned assets directory survive GC.
Repositories: document validation, settings v1→v2 migration, insert-only versions/change events, compare-and-swap head success/stale/duplicate/rollback, and permanent-delete cascade with media removal verification.
Reference-photo intake (synthetic people only): real JPEG/PNG plus runtime macOS HEIC conversion; spoofed extension, unsupported/corrupt/truncated, over-byte and over-pixel files; orientation application and independent GPS/EXIF/IPTC/XMP removal checks; private-original vs working/thumbnail/required-face-crop linkage; character- and look-owned fixtures; opaque reservation/token expiry; atomic staged photo-only character creation; duplicate open-existing/create-separate; keyboard boxes for single- and multi-person faces; versioned metric/threshold evidence; provider-reference resolver refusal of originals/full-frame face assets; prepared-write cancel/rollback and child-process kill before metadata commit; startup GC/retry; original-namespace integrity, permissions, symlink, and unknown-file preservation. Every failure asserts no visible `ReferencePhoto`/new character, no advanced owning character/look head, and no ownerless indexed asset.
Local HTTP trust boundary: prove each forbidden listener address is rejected before socket open, then independently verify the accepted listener's effective address after listen; drive a raw HTTP harness across canonical/invalid authority, DNS-rebinding names, forwarded-host spoofing, cross-origin CORS/PNA preflights, source-header variants, every unsafe method, and current/stale CSRF tokens. Each rejection asserts that a persisted sentinel and route-dispatch counter are unchanged (FR-147, FR-148, SC-014).
Export/import: round-trip fidelity, every EC-G case as a fixture archive (corrupt, traversal, symlink, future-version, checksum mismatch, interrupted-commit rollback).

### 4. Failure injection (dedicated suite)

Scripted mock-provider faults per taxonomy row × retry-policy assertion; disk-full via quota'd tmpfs-like fixture (small dedicated volume/dir quota); network-loss (adapter-level fault); app-kill matrix: {during story gen, during image fan-out, during PDF render, during import commit} × restart → SC-002 assertions (no duplicates, completed intact).

### 5. E2E (Playwright, Arabic RTL UI)

Journeys mirror user stories US1–US11 using the mock provider; assertions on UI state, persisted state, and produced files. US1 runs with no provider: customer/consent → anchored family → photo/description/pet characters → two looks, duplicate choice, archive/restore, family-scope bypass rejection, warning/subject-selection flow, kill/restart persistence, and zero external requests. Includes: full first-book journey (quickstart script), quota-pause decision flow, page-7 regeneration isolation (checksum comparison of sibling page files — SC-003), approval invalidation flow (SC-010/011), settings key lifecycle with DB/log/export secret scans (SC-005), and canonical-origin restart/reload with stale-token rejection followed by a fresh-token success (SC-014).

### 6. Visual regression & golden files

- **Arabic shaping corpus** (gate G3): connected forms, lam-alef, tashkeel, Arabic punctuation, mixed-direction lines (Latin names/numbers), long names — rendered to PDF, rasterized, pixel-diffed against approved goldens (SC-008).
- **PDF geometry goldens**: A4+bleed page boxes, crop marks, cover spread geometry per test printer profile, watermark presence/absence.
- **Layout presets**: each placement mode + gradient/panel aids over fixture artwork; RTL screenshots at 1440×900 and 1920×1080 (SC-012); reduced-motion respected.

### 7. Preflight defect fixtures (SC-006)

One seeded defect fixture per FR-123 category (wrong dims, wrong count, missing image, low-res, overflow, missing font, missing bleed, unsafe margins, invalid spread, unknown spine, corrupt PDF, failed conversion, watermark-in-print, missing-watermark-in-preview) — preflight must flag each; suite fails if any fixture passes preflight.

### 8. Privacy & security suite

Secret-scan over: DB dump, full log corpus after a scripted "noisy" run, every export fixture (SC-005), and runtime-token canaries (FR-148). Log-redaction unit tests (Gemini key patterns, image bytes). File-permission assertions (0700/0600), including the private original namespace. Bind-address tests cover EC-H06 plus every FR-147 listener/authority fixture. Browser-request forgery tests cover EC-H09–H13 and CHK222–226, including `no-store` bootstrap assertions, without relying on browser CORS enforcement alone. Consent tests cover absent/refused/revoked-before-dispatch with zero adapter/network calls for direct photos and photo-derived sheets, plus successful no-consent description-only and wholly description-derived-sheet fixtures (EC-H01/H14). Upload tests prove bounded parts/files, generated private temp names, opaque non-URL intake tokens, no client path leakage, no image bytes/metadata in logs, originals unreachable through ordinary browser/provider APIs, and zero external analysis calls. Template-from-story privacy stripping fixture (FR-051): source story with photos/names → template contains neither.

## Live-provider validation (manual, gated, not CI)

Phase 0 gate scripts G1-T/G1-I/G2/G3/G4 with structured scorecards recorded into research.md. Recurring smoke: one cheap Gemini structured call + one image call behind an operator-triggered "connection test" (FR-105) — never automatic in CI.

## Coverage & gates

- Coverage floor 80% on `domain/`, `jobs/`, `providers/`, `pdf/`, `portability/`, `security/`, and `server/security/` (per-directory, not just global).
- CI order: lint → typecheck → unit → contract(mock+fixtures) → integration → failure-injection → E2E(mock) → golden/visual → privacy suite.
- Every FR referenced by at least one test ID or checklist item (traceability audited at the analyze stage; checklists cross-link).
- AAA structure; descriptive behavior names; no implementation-detail assertions (Constitution XI).

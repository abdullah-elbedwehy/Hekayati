# Implementation Notes: 006 Durable Job Orchestration

**Checkpoint**: PASS

**Date**: 2026-07-14

**Tasks**: T-P5-01–T-P5-09

## Delivered

- Added a strict registered-job model, validated immutable requests/targets, atomic multi-job DAG enqueue, canonical idempotency, SQLite indexes, priority/FIFO ordering, and compare-and-swap claims.
- Added boot/worker/claim-token/attempt fencing, monotonic leases and stalls, independent heartbeats, late/stale/canceled commit rejection, prepared-asset compensation, and restart recovery.
- Added metadata-first consent/reference guards, approved-sheet lineage ports, ephemeral clean-byte resolution, exact capability tickets, provider-neutral dispatch, and transactional owner commit callbacks.
- Added the exhaustive 18-category failure policy, fixed retry schedules, provider-wide quota/credential incidents, per-scope wait/continue decisions, immutable successor jobs, ordinary Settings target-change previews, and persistent storage stop/probe recovery.
- Added an in-process durable worker runtime that starts only after verified loopback readiness, dynamically respects provider concurrency Settings, and exposes safe queue/Health projections.
- Added no-store CSRF-protected job/settings APIs plus the Arabic RTL queue, reason-specific controls, explicit consequence confirmations, quota decision dialog, and queue-aware Home/Health surfaces.

The planned `commit.ts` and `recovery.ts` responsibilities were split across focused scheduler, worker, storage, history, and helper modules to preserve the 800-line guard. The boundary is unchanged: production registers only infrastructure/human-gate primitives; creative graph producers, sheet readers, and owner committers remain with slices 007–011.

## Requirement and task evidence

| Tasks | Implemented evidence |
| --- | --- |
| T-P5-01, T-P5-08 | `src/jobs/**` schemas, DAG validation, indexed repository, atomic claim, pre-dispatch resolver, capability ticketing, monotonic clocks, and claim fencing; scheduler/core/claim/pre-dispatch/reference/capability tests. |
| T-P5-02 | Canonical intent/request hashing, transactional success commits, asset compensation, privacy-safe `commit_rejected` history, and duplicate/late/canceled/stale/database-loss/concurrent-commit tests. |
| T-P5-03 | Exhaustive policy data plus synthesized tests for all 18 normalized failures, exact retry counts/delays, cancellation during delay, and immutable request/target/idempotency assertions. |
| T-P5-04 | Provider/operation quota incidents, scoped wait/continue and availability-resume actions, alternate-target validation, linked successors, mixed provenance, and audit persistence. |
| T-P5-05 | Prior-boot claim recovery and kill matrix for blocked, claimed, running, retry-delay, waiting-review, prepared, renamed-orphan, and completed-asset states. |
| T-P5-06 | Durable progress/history, independent heartbeat, ten-minute `no_progress`, owner-only human gate completion, and restart-safe gate blocking. |
| T-P5-07 | Arabic queue/Health UI and APIs for state reasons, dependencies, attempts, progress, provenance, pause/resume/cancel/retry/priority, project actions, incidents, and settings retarget confirmation. |
| T-P5-09 | ENOSPC/EACCES/EROFS pause-all, running-attempt fencing/abort, database-unavailable halt, persistent Health state, and explicit DB/directory/free-space/fsync/rename probe before resume. |

All 31 items in `checklist.md` are evidenced by the automated suites and the synthetic browser capture at `evidence/006-queue-1440x900.png`.

## Verification

| Gate | Result |
| --- | --- |
| `npm ci` | PASS — 368 packages installed; 0 vulnerabilities. |
| `npm audit --audit-level=high` | PASS — 0 vulnerabilities. |
| `npm run format:check` | PASS. |
| `npm run build` | PASS — TypeScript and production Vite build. |
| `npm run check` | PASS — lint/import firewall, 252-file size guard, 9 font hashes, typecheck, 57 test files / 388 tests. |
| `npm run coverage` | PASS — overall 89.57% statements, 81.77% branches, 93.81% functions, 92.31% lines. `src/jobs/**`: 88.02% statements, 80.65% branches, 92.11% functions, 90.78% lines. |
| `HEKAYATI_UPDATE_EVIDENCE=1 npm run test:e2e` | PASS — 8/8 journeys, including real `SIGKILL`/restart, stale-token rotation, axe, keyboard/focus, reduced motion, 390×844/1440×900/1920×1080 queue fit, synthetic-only evidence, and zero browser egress. |
| Restart/failure matrices | PASS — deterministic mock/injected faults only; no live provider or customer data. |
| Visual inspection | PASS — committed 1440×900 Arabic queue evidence uses Citrus Playground, readable RTL hierarchy, visible focus, Western digits, and synthetic IDs only. |
| Staged content audit | PASS — 93 intended files only; no secret-shaped additions, absolute local paths, customer artifacts, generated exports, or Flow/012 files. The sole binary is the synthetic queue evidence PNG. |

## Remaining constraints

- Real Gemini G2/G4 remains environment-blocked until an operator configures a credential. Slice 006 requires no live-provider acceptance and performed no real-provider call.
- Slice 007 must register the creative DAG, approved-sheet lineage reader, owner-specific committers, and review transactions before any book-generation job exists in production.
- The concurrent pending Flow/012 work was not implemented, modified, or used to widen scheduler state in this slice.

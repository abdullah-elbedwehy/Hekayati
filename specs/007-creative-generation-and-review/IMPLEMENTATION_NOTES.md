# 007 Implementation Notes — Creative Generation and Review

**Checkpoint**: PASS on 2026-07-14

**Scope**: `T-P2-07`, `T-P2-08`, `T-P2-11`, `T-P6-01`–`T-P6-09`

**Canonical coverage**: FR-004, FR-030–033, FR-041, FR-047–048, FR-058–066, FR-071, FR-082, FR-086–087, FR-092, FR-114–119; SC-003; IM-01–IM-21; 007-C01–007-C38

## Delivered behavior

- Added strict creative-run, character-sheet, page/version, review, approval, finding, audit, and lineage contracts with immutable SQLite-backed repositories and content-addressed assets.
- Added five independently scheduled character-sheet views, an atomic local finalizer, rendered compact Arabic sheet PDF, approval/change-request flows, supersession, affected-item reporting, and trusted photo-derived or description-only lineage.
- Added the complete persistent creative graph: story plan → story text → scenes → 12 page prompts → 12 independent illustrations → findings → human review gate. Canonical successor requests are compiled from validated predecessor output and the manifest exists before dispatch.
- Appended generated story and scene versions to slice 004 lineage without replacing prior manual content. Added page history, text-only rewrite, illustration-only regeneration, revert, lock/unlock, approval, safety-resolution successor, and layout delegation to slice 008.
- Added the closed IM-01–IM-21 invalidation table, transitive scoped consequences, idempotent hash-checked receipts, exact `bookVersion` behavior, and no automatic regeneration.
- Added hash-bound prompt-policy confirmation, deterministic sheet-first reference allocation, explicit capacity reduction confirmation, nullable-capability fail-closed behavior, and provider-output policy enforcement.
- Added an Arabic RTL creative workspace and API with explicit confirmations, review findings, page controls, keyboard/focus support, reduced-motion behavior, safe aggregate errors, and no browser egress.
- Added an opt-in synthetic Gemini live probe. It cannot run unless `--provider gemini --execute`, the exact model/tier variables, credential availability, and an explicit cost confirmation are all present.

## Verification evidence

- `npm ci`: 368 packages installed, 369 audited, 0 vulnerabilities, Node `v22.23.1`.
- `npm run check`: PASS — lint, font-integrity check, typecheck, file-size guard, and 77 Vitest files / 494 tests.
- `npm run coverage`: PASS — all source 91.25% statements, 84.00% branches, 94.99% functions, 93.74% lines; `src/domain/creative/**` 96.40%, 91.20%, 97.56%, 98.14%; `src/jobs/**` 89.34%, 82.23%, 93.50%, 91.93%.
- `npm run build`: PASS — production Vite build.
- `npm run format:check`: PASS.
- `npm audit --audit-level=high`: PASS — 0 vulnerabilities.
- `npm run test:e2e`: PASS — 10/10 Playwright journeys, including both creative journeys.
- Real process `SIGKILL`/restart: PASS — the 30-node manifest and job IDs survived; exactly one interrupted `story_plan` job reached attempt 2; no duplicate graph, version, asset, event, or successor; all 12 story pages completed.
- Independent-branch failure: PASS — one page image safety refusal remained failed without retry while 11 sibling branches completed.
- Revoked-consent pre-dispatch: PASS — zero capability lookup and zero provider dispatch.
- Prompt/capacity policy: PASS — named-IP work created zero jobs before an exact current-hash confirmation; stale confirmation created zero; deterministic two-to-one reference reduction required a separate capacity confirmation; null limits and forbidden output failed closed.
- Manual browser evidence with synthetic data: PASS at 390 and 1440 widths; document RTL, zero horizontal overflow, 44 px focused target, reduced-motion mode honored, and zero external requests. The automated suite additionally covers 1920 width and axe checks.
- Character-sheet PDF: PASS — one A5-landscape page (`594.96 × 420 pt`), 76,610 bytes, PDF 1.4, no JavaScript; rendered inspection confirmed Arabic shaping/order, all five labeled views, reference thumbnails, and no clipping.
- `npm run live:creative -- --provider gemini`: honest dry-run SKIP. The execute form with cost confirmation also returned `SKIP g2_limits_unverified` before any request because exact G2 limits were unavailable.
- `git diff --check`: PASS. Generated Playwright/PDF evidence remains ignored and outside the delivery commit.

One full-check attempt made while coverage workers were still saturating the machine timed out in existing subprocess/restart tests. Immediate isolated reruns and the final unloaded `npm run check` passed; no production or test weakening was applied.

## Residual risks and boundaries

- Real Gemini image acceptance remains unavailable until the operator configures a credential and the exact G2/G4 capability facts are verified. This is a recorded environment SKIP, not a fallback or model substitution, and it does not block deterministic slice-007 acceptance.
- All verification used synthetic fixtures. No real child/customer photo, provider payload, secret, database, export, or generated customer artifact is committed.
- Flow/external-manual generation in unapproved slice 012 remains outside this checkpoint and was not incorporated into slice 007.

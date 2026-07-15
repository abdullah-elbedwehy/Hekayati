# 008 Implementation Notes — Arabic Layout, Preview, and Approval

**Checkpoint**: PASS on 2026-07-15

**Scope**: `T-P7-01`–`T-P7-06`

**Canonical coverage**: FR-080–FR-083, FR-085–FR-087, FR-120, FR-124; SC-007, SC-008, SC-010; IM-01, IM-03–IM-14, IM-18–IM-20; 008-C01–008-C40

## Delivered behavior

- Added strict versioned composition-profile, layout-head/version, cover-composition, preview-workflow/output, approval-cycle/action, and approved-snapshot contracts. One restart-safe Project-v1/Page-v1 migration creates Project v2 and separate revisioned layout heads without changing creative lineage.
- Added a deterministic A4 Arabic layout policy with physical top/bottom/right/left placement, image-region measurement, fixed typography floors, gradient/panel aids, explicit overflow/action states, safe mixed-BiDi handling, and non-guessing dialogue anchors.
- Added immutable five-kind interior composition and customer-view cover proofs. Automatic sources are limited to exact reviewed story artwork and the main child's exact approved three-quarter character-sheet fallback; operator selections are in-project, checksum-pinned, and revision checked.
- Added durable local `page_layout` and `preview_pdf` jobs, an automatic `layout_pending` → `pdf_pending` → `ready` graph, exact claim/source/review/head fences, immutable successors, and restart-safe cardinality.
- Added one escaped offline composition document consumed by the browser preview and Chromium PDF renderer. Sharp creates deterministic placed-size preview derivatives; qpdf/Poppler inspection enforces page geometry, ordered map, embedded Arabic fonts with ToUnicode, watermark/footer coverage, effective PPI, size, and prohibited-feature/egress absence.
- Added atomic prepared-asset promotion inside the scheduler-owned SQLite commit transaction. Stale/canceled/late commits roll back metadata and discard unreferenced prepared files; startup GC recognizes interrupted temp and renamed-before-index artifacts.
- Added exact preview lifecycle actions (`sent`, `approved`, `changes_requested`) with scoped owner/revision/hash checks, append-only idempotency ledger, normalized strict affected scopes, approval-gate ownership, same-content successor behavior, and immutable `contentAuthorizationHash` handoff.
- Added `ApprovedBookSnapshotReader`, including exact succeeded-gate/content checks, source integrity blocking, observation-independent authorization, and byte-identical integrity recovery.
- Extended the production invalidation coordinator and emitters so real 008 records participate in the original transaction. IM-01/03–13 invalidate preview/approval once, IM-19/20 stale preview and recheck approval without a book bump, and compatible IM-14/IM-18 leave approval unchanged; replay uses the persisted receipt and never regenerates automatically.
- Added scoped no-store layout APIs and an Arabic RTL Citrus Playground preview workspace with page ordering, preset/action states, exact preview/gate identity, safe PDF download, approval controls, affected scopes, keyboard/focus support, and responsive 390/1440/1920 layouts.

## Verification evidence

- `npm ci`: PASS — 368 packages installed, 369 audited, 0 vulnerabilities.
- `npm run format:check`: PASS.
- `npm run check:size`: PASS — 398 files checked.
- `npm run check`: PASS — lint, file-size guard, bundled-font hashes, typecheck, and full Vitest graph.
- `npm run test`: PASS — 95 files / 583 tests with the deterministic two-worker ceiling required by concurrent Sharp/Chromium integration cases.
- `npm run coverage`: PASS — all source 90.82% statements, 82.88% branches, 94.74% functions, 93.29% lines; `src/domain/layout/**` 88.83%, 80.19%, 94.17%, 91.22%; `src/layout/**` 99.12%, 91.52%, 100%, 99.01%; `src/pdf/**` 90.73%, 84.04%, 92.53%, 93.02%.
- `npm run build`: PASS — production Vite build.
- `npm audit --omit=dev`: PASS — 0 vulnerabilities.
- `npm run test:e2e`: PASS — 11/11 Playwright journeys. The layout journey exercised exact sent/approved transitions at 390×844, 1440×900, and 1920×1080, axe, keyboard order, visible focus, ≥44 px targets, long Arabic/mixed-BiDi content, reduced motion, no document overflow, and zero external requests.
- Complete synthetic book proof: PASS — 24 interior pages plus front/back proof covers; 286,166 bytes; 26 pages; 23 images; every page carried the configured diagonal watermark and footer; A4 portrait boxes passed the 0.5 mm tolerance; Lemonada and IBM Plex Sans Arabic were embedded with ToUnicode; prohibited PDF features and browser egress were zero.
- Rendered PDF inspection: PASS — rasterized cover/interior evidence covered connected Arabic, lam-alef, tashkeel, punctuation, Western digits, all five interior templates, all physical placements, panel/gradient aids, dialogue bubbles, long names, and mixed BiDi without clipping.
- Real process `SIGKILL`/restart: PASS — killing one running page-layout job resumed that exact job at attempt 2 and produced exactly 16 layout heads/versions, one preview output, and one waiting approval gate. Killing inside preview rendering resumed the one preview job at attempt 2 with the same final cardinality. Shared asset tests additionally killed after temp fsync and after atomic rename, then removed the one recognized orphan and committed one indexed successor.
- Failure and atomicity evidence: PASS — stale/canceled commit rejection, duplicate same-content execution, validation refusal, owner-transaction rollback/discard, ENOSPC global storage stop, EACCES classification, interrupted temp cleanup, renamed-before-index GC, and missing/corrupt integrity behavior expose no ready metadata for missing bytes and no duplicate output/refcount.
- Invalidation evidence: PASS — 18 layout-participant integration cases plus real producer tests cover IM-01/03–14/18–20, exact affected IDs/actions/book-version behavior, waiting-gate cancellation, succeeded-gate immutability, locked-stale preservation, receipt replay, and no automatic regeneration.
- `git diff --check` and the exact staged privacy/secret/artifact scan: PASS. Generated PDF thumbnails, browser screenshots, Playwright output, coverage output, databases, and runtime files remain ignored and outside the delivery commit.

The first unrestricted and four-worker full-test attempts exposed CPU starvation in concurrent Sharp/Chromium cases and timed out with a local job still running. No assertion, behavior, or timeout was weakened. The package test and coverage commands now use the proven two-worker ceiling; the final full suite and coverage run passed in approximately 54 seconds each.

## Rendered evidence

Local ignored evidence is under `.tmp/layout-evidence/`:

- `008-preview-24.pdf` and `008-preview-24-validation.json`
- rasterized cover/interior page thumbnails
- 390×844, 1440×900, and 1920×1080 UI screenshots

The headless browser's PDF iframe surface is not used as sole visual evidence: the indexed download route is mechanically verified and the same PDF is independently rasterized and inspected.

## Staged SC-007 / SC-010 boundary

- SC-007 evidence completed here: the full 24-page customer preview plus two proofs stays below 16 MB and every preview page is watermarked. Slice 009 must separately prove that print-ready interior and cover files contain no watermark.
- SC-010 handoff completed here: `ApprovedBookSnapshotReader` returns the exact immutable authorization/content/source snapshot and blocks initial materialization on mismatch or integrity failure. Slice 009 must invoke that guard before print-job creation, local execution, and final artifact/head commit, and must prove a later block leaves no committed print output.

## Residual risks and boundaries

- Printer-specific bleed, crop marks, spine, blank pages, color space, ICC profile, and full-resolution print output remain exclusively in Slice 009. They are intentionally absent from the customer composition profile and preview PDF.
- All acceptance evidence uses synthetic data and deterministic local/mock paths. No real child/customer photo, provider payload, secret, database, generated customer asset, PDF, or screenshot is committed.
- No live AI-provider capability is required by this slice; no provider call occurred in automated verification.
- Pending Flow/external-generation work remains outside this checkpoint and was not staged or modified for Slice 008.

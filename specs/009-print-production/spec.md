# Feature Specification: Print Production

**Feature ID**: `009-print-production`
**Status**: Readiness/analyze PASS — implementation authorized
**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

This document is an ownership and acceptance slice. Canonical requirement wording and shared rules remain in the bible. On conflict: constitution → bible → this slice.

## Outcome

An approved book becomes printer-parameterized interior and cover PDFs only after mechanical preflight proves geometry, resolution, fonts, Arabic shaping, color handling, watermark absence, and approval-version fidelity.

## Requirements *(mandatory)*

Primary requirement ownership: **FR-121–123**.

Primary user journey: **US7**. Primary clarifications: **C-04 and C-12**. Full routing: [migration map](../MIGRATION.md).

Owned capability boundaries:

- Printer profiles for trim, bleed, safe margins, DPI, crop marks, color/ICC, blank technical pages, spine, and cover templates.
- Full-resolution interior assembly and RTL-bound back/spine/front cover spread by mapping the exact 008-approved customer composition into printer geometry; no customer-visible cover copy/artwork is invented here.
- Explicit RGB/CMYK path, proof approval after conversion, and hard blocking when printer truth is absent or conversion fails.
- Mechanical preflight across every FR-123 defect class and deliverable-state gating.

This feature consumes FR-057 for printer-only blank pages, FR-120 for output families, FR-124 for watermark separation, and 008's strict transient `ApprovedBookSnapshot`: customerContentHash, immutable approval/gate/output/review evidence, exact composition/cover/page/layout/text/source checksums, stable contentAuthorizationHash, and separate non-hashed observations. It contains no bytes, paths, preview derivatives, printer settings, or mutable latest heads. IM-19/new unapproved same-content previews preserve the stable hashes; IM-20 blocks only while a referenced checksum fails and exact repair may restore it. Materialization calls the reader in-transaction (failure creates zero job); every existing producer re-runs it before execution and commit (later failure leaves historical job state but no indexed artifact/current output). This feature does not own story/cover composition or customer approval.

## Dependencies and feasibility gates

- Depends on feature 008's exact approved-book snapshot guard, page/layout/cover map, parameterized renderer, and typed watermark-free full-resolution print input.
- Shared gate **G3** and Phase 0 cover/CMYK spike must pass before print implementation proceeds.
- Spine width and printer geometry are always data inputs, never inferred defaults beyond the explicitly documented profile defaults. A composition-compatible profile may add bleed/DPI/color/ICC/crop/spine mechanics; incompatible trim/aspect/safe-area input hard-blocks for explicit 008 composition migration and re-approval rather than silently reflowing.
- A failed preflight never produces a deliverable artifact or weakens a rule to pass.

## User Scenarios & Testing *(mandatory)*

Canonical story and scenarios: **US7** in the [product bible](../001-hekayati-product-bible/spec.md).

Independent acceptance: produce interior and cover PDFs from an approved mock book and test every seeded defect fixture; unknown spine, low resolution, wrong geometry/page map, missing fonts/bleed, Arabic shaping errors, conversion failure, or watermark leakage must be specific hard failures.

## Success Criteria *(mandatory)*

Primary measurable outcomes: **SC-006**, print repetition of **SC-008**, the print-watermark half of **SC-007**, and executed producer consumption of the **SC-010** guard. CHK301–CHK318, the G3 scorecard, and every canonical US7 scenario provide the remaining evidence.

## Required bible artifacts

- [Research R9/R10 and G3](../001-hekayati-product-bible/research.md)
- [PrinterProfile data model](../001-hekayati-product-bible/data-model.md)
- [Print edge cases](../001-hekayati-product-bible/edge-case-catalog.md)
- [Print checklist](../001-hekayati-product-bible/checklists/print-production.md)
- [Preflight fixture strategy](../001-hekayati-product-bible/test-strategy.md)

## Delivery mapping

Master tasks: **T-P0-06–T-P0-07** and **T-P8-01–T-P8-07**. Gate consolidation T-P0-08 remains shared in the bible.

Spec approval requires owned IDs, printer-data contract, G3 evidence, and all preflight categories to be accepted; it does not authorize implementation until the complete graph is approved.

## Clarified delivery contract

1. `PrinterProfile` is a revisioned global operator setting with immutable `PrinterProfileVersion` successors. A version pins name, portrait trim, bleed, normalized printer-safe rectangle, minimum effective DPI, RGB/CMYK mode, crop-mark geometry, spine source, optional imported cover-template evidence, and ordered printer-only blank-page rules. A print run pins one exact version and profile hash; mutable latest profile state is never read during a job.
2. Profile defaults are exactly A4 portrait, 3 mm bleed, 10 mm safe margin, 300 effective DPI, RGB, and crop marks off. These defaults do not claim printer truth. The default profile remains incomplete for cover production until an explicit positive spine width or a validated template supplies one. No spine, bleed, color, ICC, trim, or blank-page value is guessed from book content or page count.
3. ICC and printer-template imports are hostile uploads. The transient source path is never persisted or returned. Accepted bytes are size-bounded, content-sniffed, mechanically parsed, copied into the private content-addressed store, and referenced by indexed asset ID/checksum. ICC input must have a valid ICC header; CMYK profiles must declare four-channel CMYK. A cover template must be an unencrypted one-page PDF with no JavaScript, actions, forms, attachments, embedded files, remote references, or local paths and must match its declared back/spine/front geometry within tolerance.
4. Project profile assignment is owner- and revision-checked. It runs 008's pure compatibility predicate: portrait; width and height each within the approved composition tolerance without scale; and full containment of the approved safe rectangle inside the printer-safe rectangle. Initial compatible assignment and compatible printer-mechanics changes leave customer approval intact. Any failed term returns bounded `COMPOSITION_PROFILE_MISMATCH`, creates no print job, changes no project/profile head, and requires explicit 008 composition migration and re-approval.
5. A `PrintRun` is a revisioned project head pinned to the exact `ApprovedBookSnapshot`, `contentAuthorizationHash`, approval cycle/gate/output, CompositionProfile, PrinterProfileVersion/hash, render/font policy, interior/cover job IDs, current artifact IDs, preflight ID, optional converted-proof gate, and state. Interior and cover artifacts are immutable; invalidation changes only a revisioned current/stale projection and never rewrites bytes or lineage.
6. Materialization calls the 008 approved-book guard in the same SQLite transaction that inserts the run and jobs. Any missing authorization, mismatched content hash/gate/output/review/source evidence, unhealthy referenced asset, incompatible/incomplete profile, or missing CMYK ICC/spine/template creates zero run and zero job. The canonical request hash makes identical start replay return the existing run while a changed request requires an explicit successor.
7. Interior and cover are separate strict local durable producers so IM-15 can invalidate/rebuild only the cover. Their requests pin the run/profile/content authorization plus exact source checksums. Each producer re-runs the guard and profile/run fence before expensive execution and again inside scheduler-owned commit. A later block makes the attempt stale/canceled, discards prepared bytes, and advances no artifact/current head. IM-19 observation drift is accepted when the stable authorization hash is unchanged.
8. Interior order is the exact approved 16/24 customer page map. Printer-only blanks are added only at assembly in the profile's closed before/after positions, have explicit output page indices/kinds in preflight, and never acquire customer page numbers or alter preview/page hashes. Each customer page consumes exact full-resolution source assets and the approved layout/text/composition inputs; preview derivatives and mutable latest heads are forbidden.
9. Interior geometry maps the approved trim canvas by identity into the printer page. Without crop marks, MediaBox is trim plus bleed and TrimBox is inset by bleed. With crop marks, the profile's positive mark offset/length add an outer mark margin; BleedBox and TrimBox remain exact and marks never enter trim/safe content. Text remains inside the approved safe region; background artwork extends deterministically through bleed without changing the approved trim view. There is no auto-upscale, quality fallback, or alternate renderer.
10. Cover geometry is one landscape spread ordered back-left, spine-center, front-right for RTL binding. Trim width is `2 × trimWidth + spineWidth`; outer bleed and optional crop-mark margin follow the same profile rules. The renderer maps the exact approved front/back CoverCompositionVersion, text refs, artwork checksums, normalized regions, and brand/font hashes; it may add only printer geometry and the configured spine treatment. It invents no synopsis, title, child name, logo, art, or environment copy. Missing/zero spine or template disagreement blocks before render.
11. RGB is the default direct output. CMYK runs only when the pinned profile supplies an exact validated ICC asset. Ghostscript is invoked argument-safely with no shell, `-dSAFER`, and read permission limited to that staged ICC. Conversion writes a temporary candidate, then qpdf/Poppler/color checks prove one matching output intent, embedded four-channel profile/checksum, CMYK image/resources/operators, no residual RGB resources/operators, unchanged geometry/fonts/map, and valid PDF before atomic promotion. Missing tool/ICC, timeout, nonzero exit, wrong profile, failed check, or color conversion failure preserves any prior valid artifact and blocks delivery; there is no RGB fallback.
12. A CMYK run that passes mechanical preflight enters `converted_proof_pending`. One immutable proof bundle binds interior/cover checksums, ICC/profile hash, authorization hash, representative local rasters, and a scheduler-owned human gate. Only an owner/CSRF/revision/hash/idempotency-checked approval succeeds that exact gate and makes the run deliverable. Rejection records notes, cancels the gate, and leaves candidates non-deliverable. Generic queue controls cannot approve. RGB requires no conversion gate and becomes deliverable when its exact final preflight commits.
13. The preflight rule registry is closed and versioned. It reports bounded code, artifact/page, expected, actual, and severity for: parse/corruption/encryption; dimensions/orientation/MediaBox/TrimBox/BleedBox; exact approved page map plus declared blanks; missing/full-resolution source; effective DPI; text overflow; font identity/embedding/subsetting/ToUnicode/glyph coverage; bleed; safe margins; crop marks; cover back/spine/front order and spread dimensions; missing/unknown spine; RGB/CMYK mode, ICC/output intent and conversion; watermark present in either print file; approved preview watermark absence; prohibited PDF features/resources; and authorization/profile/checksum mismatch. Any blocking finding keeps the run non-deliverable. Tests include at least one seeded defect per FR-123 category and fail if any fixture passes.
14. Successful preflight persists exact actual measurements, ordered output/customer page mapping, printer blanks, fonts, image PPI, boxes, spread regions, color/output-intent facts, watermark counts, source/output checksums, tool/policy versions, and authorization/profile hashes. Reports contain no raw bytes, paths, customer text, child image data, command lines, ICC contents, or unbounded diagnostics.
15. Print asset commit uses prepared file → mechanical validation → atomic rename → one scheduler-owned SQLite transaction. The transaction rechecks claim/attempt, guard, run/profile version, source integrity, prepared checksum, and current artifact head before indexing the asset and advancing its head. Kill before/after render, during conversion/validation, after rename/before DB, cancellation, ENOSPC/EACCES, duplicate execution, or rollback exposes no partial/current artifact and recovery creates at most one current artifact per type.
16. The shared invalidation transaction includes print participants before any print-affecting emitter runs. Customer-visible rows stale applicable interior, cover, preflight, proof gate, and deliverable run; IM-14 preserves customer approval but invalidates both print artifacts/preflight; IM-15 preserves the exact interior and invalidates only cover/preflight; IM-18/19 change nothing in print and an in-flight IM-19 job may commit under the same authorization hash; IM-20 blocks referenced content while corrupt and exact-byte repair/reverification may restore the same authorization/run, while different bytes require a normal successor/re-approval row. Replay uses frozen receipt IDs/actions and never regenerates automatically.
17. Deliverable downloads are family/project scoped, `no-store`, attachment-safe, and serve only indexed current artifacts whose run, preflight, optional proof gate, authorization, profile version, and file integrity still pass. Candidate CMYK proofs are operator-only and visibly non-deliverable. No endpoint accepts a filesystem path or artifact ID outside the run.
18. The Arabic Citrus Playground print workspace exposes profile readiness/compatibility, exact approved version, interior/cover progress, printer blanks, RGB/CMYK and proof-gate state, every preflight finding/actual measurement, affected invalidation actions, and safe downloads. It uses Western digits, logical RTL layout, `<bdi>` for IDs/hashes, text+icon states, visible focus, ≥44 px controls, reduced motion, and no clipping at 390×844, 1440×900, and 1920×1080.
19. Automated acceptance uses only synthetic books, art, profiles, ICC/template fixtures, and local tools. It makes zero provider/network call and commits no generated PDF/raster/database/runtime output. The real printer's ICC/template round-trip and a physical proof remain explicit operator launch gates (CHK317/318), not fabricated automated evidence and not blockers to deterministic local implementation.
20. Feature 010 may export only indexed printer profile/run/output metadata and referenced assets through its hostile-archive contract; no raw operator source path or temporary conversion artifact exists to leak. Pending feature 012 Flow work is outside this slice; ordinary reviewed imported illustrations later consume the same full-resolution snapshot refs without a print bypass.

## Slice acceptance scenarios

- **A-009-01 — Strict profile/import model**: create/update/replay an A4 RGB profile, reject unknown/secret/path/raw-byte fields, invalid geometry/DPI/bleed/safe/crop/blank/spine combinations, and hostile/wrong-channel ICC or cover-template inputs; prior versions/assets remain immutable and private.
- **A-009-02 — Composition compatibility**: compatible trim within 0.5 mm and containing safe geometry assigns without changing approval; landscape, either dimension outside tolerance, scale requirement, or insufficient safe rectangle creates no assignment/run and returns explicit migration scope.
- **A-009-03 — Zero-work authorization gate**: start one exact approved fixture and prove a current run/jobs are inserted atomically. For every approval/gate/content/page/layout/review/source/profile/integrity mismatch, initial materialization creates zero run, job, asset, or head.
- **A-009-04 — Exact interior**: 16- and 24-page fixtures produce the approved order from full-resolution assets, exact trim/bleed/safe/crop geometry and optional declared before/after blanks. Customer numbering/hash is unchanged; preview derivatives, upscaling, mutable latest refs, watermark, and footer are absent.
- **A-009-05 — RTL cover spread**: explicit-spine and validated-template fixtures yield one back-left/spine/front-right spread with exact bleed/fold/crop geometry and approved front/back text/art hashes. Missing/zero/conflicting spine or reversed panels hard-blocks without output.
- **A-009-06 — RGB path**: default RGB interior/cover pass preflight and become deliverable without Ghostscript or a conversion gate; output has no watermark and preserves exact Arabic/font/page/source evidence.
- **A-009-07 — CMYK proof path**: exact four-channel ICC conversion proves output intent/profile hash, CMYK-only resources/operators, geometry/fonts/map parity, atomic failure safety, and a mandatory exact proof gate. Stale/colliding/rejected actions cannot deliver; approval can.
- **A-009-08 — Complete defect registry**: one seeded fixture for every FR-123 category is detected with the correct code/page/actual value and zero false deliverable; deleting a registry row makes the suite fail.
- **A-009-09 — Three guard fences**: content/profile/source change before materialization, before execution, and after prepare/before commit proves respectively zero job, stale/canceled job with no prepared exposure, and transaction rollback/discard with no artifact/head. IM-19 between those fences keeps the identical authorization committable.
- **A-009-10 — Invalidation**: real IM rows prove visible change stales all applicable print state, compatible IM-14 re-produces both without touching approval, IM-15 reuses interior and rebuilds cover only, IM-18/19 are no-ops, and IM-20 blocks then exact repair restores without automatic work.
- **A-009-11 — Atomic restart**: real process kills during interior render, cover render, CMYK conversion, validation, and rename/DB boundary recover to at most one current interior, cover, preflight, and proof gate with no missing indexed file or orphan download.
- **A-009-12 — Arabic/print evidence**: rasterized interior and cover goldens prove connected forms, lam-alef, tashkeel, punctuation, mixed BiDi, long names, safe margins, bleed continuity, spine alignment and no clipping; mechanical checks prove embedded pinned fonts/ToUnicode and effective ≥ profile DPI.
- **A-009-13 — Scoped API/download security**: wrong family/project/revision/hash/profile/artifact, paths, forged browser requests, hostile imports and non-deliverable downloads fail before mutation/bytes; every response is bounded/no-store and browser capture records zero egress.
- **A-009-14 — Arabic operator UI**: profile import/edit/assignment, compatibility block, production progress, findings, proof approval and downloads pass Arabic RTL axe/keyboard/focus/44px/reduced-motion/long-text/no-overflow checks at all three widths.
- **A-009-15 — Release boundary**: clean install/check/build/audit/coverage and staged privacy scans pass; implementation notes record G3 repetition, defect detection, rendered/mechanical evidence and real kill recovery, while actual-printer round-trip/physical proof remain clearly pending before commercial use.

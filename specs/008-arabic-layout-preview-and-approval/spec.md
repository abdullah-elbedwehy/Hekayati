# Feature Specification: Arabic Layout, Preview, and Approval

**Feature ID**: `008-arabic-layout-preview-and-approval`
**Status**: Readiness/analyze PASS — implementation authorized
**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

This document is an ownership and acceptance slice. Canonical requirement wording and shared rules remain in the bible. On conflict: constitution → bible → this slice.

## Outcome

Approved text-free illustrations become readable Arabic pages through deterministic layout; the operator can create a protected preview, record version-bound customer approval, and see that approval invalidated by exactly the documented visible changes.

## Requirements _(mandatory)_

Primary requirement ownership: **FR-080–083, FR-085–087, FR-120, FR-124**.

Primary user journey: **US6**. Primary clarifications: **C-03, C-06, C-14, C-26, C-27**. Full routing: [migration map](../MIGRATION.md).

Owned capability boundaries:

- Correct Arabic shaping/BiDi, embedded-font page rendering, placement presets, quiet-region analysis, readable fallback aids, overflow handling, and dialogue bubbles.
- Shared title/dedication/story/ending templates and customer-visible page composition.
- Versioned customer-composition geometry and customer-view front/back cover proofs approved before printer-specific spread assembly.
- Downsampled, watermarked preview PDF plus preview-sent/approved/changes-requested records bound to book versions.
- Approval invalidation and print blocking for customer-visible changes; internal-only changes remain non-invalidating.

Printer profiles, final interior/cover files, color conversion, and print preflight are owned by feature 009. Feature 009 consumes the shared renderer and FR-120/FR-124 output invariants.

## Dependencies and feasibility gate

- Depends on feature 007 reviewed page versions and change/invalidation events.
- Depends on shared gate **G3** passing before the Arabic/PDF renderer is accepted.
- Supplies an approved book-version/page map and shared HTML/CSS templates to feature 009.
- Uses the shared invalidation matrix; approval consequences cannot be privately redefined here.

## User Scenarios & Testing _(mandatory)_

Canonical story and scenarios: **US6** in the [product bible](../001-hekayati-product-bible/spec.md).

Independent acceptance: automatically continue a completed mock book through deterministic layouts, customer-view cover composition, durable `pdf_pending`, and a validated exact-snapshot preview; verify Arabic shaping/BiDi, layout floors/fallbacks, watermark/footer on every proof/interior page, ~150-DPI derivatives, hard size budget, embedded fonts, zero egress, kill/restart recovery, and exact-preview approval. Then drive the real invalidation ports through punctuation, layout, title/dedication, compatible printer-profile, internal-only, watermark, and asset-integrity rows; verify the prior preview/approval/print guard changes only as prescribed and an old-preview action fails.

## Success Criteria _(mandatory)_

Direct outcome: **SC-008**. This slice proves the preview half of **SC-007** and the authorization-guard half of **SC-010**; feature 009 must prove watermark absence and actual guard consumption in every print producer before those criteria close globally. CHK020–CHK021, CHK228, CHK309–CHK314 producer evidence, CHK428, Arabic layout goldens, and every canonical US6 scenario provide the remaining evidence.

## Required bible artifacts

- [Layout, approval, and output requirements](../001-hekayati-product-bible/spec.md)
- [Book approval state machine](../001-hekayati-product-bible/state-machines.md)
- [Layout, PreviewOutput, approval, and composition data model](../001-hekayati-product-bible/data-model.md)
- [Invalidation matrix](../001-hekayati-product-bible/invalidation-matrix.md)
- [Page/PDF edge cases](../001-hekayati-product-bible/edge-case-catalog.md)
- [Preview and stale-approval risks](../001-hekayati-product-bible/risk-register.md)
- [Research R9 and gate G3](../001-hekayati-product-bible/research.md)
- [Durable local/provider scheduler contract](../001-hekayati-product-bible/contracts/job-scheduler-contract.md)
- [Arabic/preview test strategy](../001-hekayati-product-bible/test-strategy.md)
- [Print/preview checklist](../001-hekayati-product-bible/checklists/print-production.md)
- [Privacy/security checklist](../001-hekayati-product-bible/checklists/privacy-security.md)
- [Arabic RTL UX checklist](../001-hekayati-product-bible/checklists/ux-arabic-rtl.md)
- [Product strategy](../../PRODUCT.md) and [Citrus Playground design rules](../../DESIGN.md)

## Delivery mapping

Master tasks: **T-P7-01–T-P7-06**. Phase checkpoint and definition of done remain canonical in [tasks.md](../001-hekayati-product-bible/tasks.md).

Spec approval requires owned IDs, G3 dependency, approval-version contract, and print handoff to be accepted; it does not authorize implementation until the complete graph is approved.

## Clarified delivery contract

1. Layout uses a versioned 210 × 297 mm A4 portrait customer-composition profile with normalized safe/placement regions and a pinned 0.5 mm dimension tolerance. It is not a printer profile. Compatibility is deterministic: both trim dimensions must match within tolerance without scaling and the composition safe rectangle must fit wholly inside the printer safe rectangle; bleed/DPI/color/ICC/crop/spine/blanks are printer-only. Any failed predicate hard-blocks until explicit composition migration creates new layouts/cover composition and approval.
2. The canonical 16/24 interior map remains title, dedication, 12/20 story pages, farewell, and brand. A closed source policy selects the first approved story illustration for front/title/farewell, then the main child's exact approved three-quarter sheet as fallback; unresolved required source enters operator action. Dedication/back default to no artwork, brand pins the bundled identity asset, and optional environment/synopsis default absent. Cover and special layouts pin policy/selection, text-source versions/hashes and assets; blocking cover warnings set `needs_operator`, while revision-checked source/cover edits emit IM-12/IM-11.
3. `LayoutPolicy/v1` fixes candidate regions, physical meanings of auto/top/bottom/right/left, quietness/contrast scoring, deterministic tie-breaks, padding, line-height, age-band typography, aid order, safe regions, and warnings. No hidden random choice or freeform drag is allowed.
4. Initial layout derivation creates a downstream `PageLayoutHead` over an exact reviewed creative snapshot and leaves a locked Page plus its creative heads byte-identical. Replacing or recalculating an existing layout is customer-visible and requires explicit unlock.
5. Every immutable `LayoutVersion` pins pageContentHash, exact text/asset refs, composition-input/layout hashes, story review ID/hash or special-page source-policy/selection, typography/font/policy, job/fence, result and `ready|needs_operator`. Page observation revision is only a running-job CAS fence and is excluded from customer authorization, so lock/unlock metadata cannot silently invalidate unchanged content. Story pages require the exact approved 007 review; special pages forbid that nonexistent prerequisite.
6. A dialogue pointer is emitted only when a normalized source position deterministically resolves to an on-canvas speaker anchor. Missing, ambiguous, or off-canvas position uses a speaker-labeled non-pointing RTL fallback with a warning; overflow never silently clips or shrinks below the floor.
7. Completing internal review idempotently starts a durable local workflow: `layout_pending` → `operator_action_required` when needed → `pdf_pending` → render/validate → ready. `pdf_pending` is persisted before the preview job; the workflow survives restart and never records a send/approval action automatically.
8. One immutable `PreviewOutput` pins book/project/composition/cover, customerContentHash, ordered 16/24 pageContent/review-or-selection/layout/text/source evidence, previewDerivative/font/typography/watermark/renderer policy hashes, PDF asset, ready-to-send cycle/gate, job, and mechanical report. Its approvalBundleHash adds exact preview/review/watermark/derivative evidence; invalidation changes only the revisioned status projection.
9. Preview rendering uses escaped text nodes, bundled fonts/assets, JavaScript-disabled/offline Chromium, deny-all HTTP(S)/file/CDN/script behavior, and transient deterministic ~150-DPI image derivatives. It excludes originals, print-resolution streams, local paths, internal IDs, contact/consent/provenance fields, attachments, forms, and active content.
10. A preview cannot become ready or sendable unless parsing, every page's MediaBox and applicable TrimBox matching the pinned composition dimensions/tolerance in portrait orientation, exact proof/interior order, Arabic glyph/font embedding/ToUnicode, per-page diagonal watermark and required footer, image PPI, prohibited-feature scan, zero egress, and hard ≤16 MB budget all pass. Failure reports actual values/pages and never silently lowers the pinned policy.
11. Rendered bytes use prepare → validate → atomic rename, then one fenced metadata transaction; ready DB state never precedes the canonical file. Kill, cancel, stale result, ENOSPC, or failure before/after rename exposes no partial/current output; recovery creates at most one asset/output/cycle/gate bundle.
12. Preview commit advances current-preview/current-cycle heads but not currentContentApprovalId. Same-customerContentHash watermark rerender preserves approved/print-ready lifecycle. Actions use owner/CSRF, append-only key+request-hash ledger and project/output/cycle/gate plus optional prior-content-approval CAS. Only approved succeeds the gate and advances authorization; changes requested cancels the gate and invalidates/clears any prior same-content authorization with strict page/cover scopes. Generic queue controls never approve.
13. The shared invalidation coordinator includes creative, layout, preview, approval/gate, and later print participants in the original frozen receipt; a second consumer is forbidden. Every pre-009 producer affecting 008 is audited and missing IM-06/08/09/11/12/13/19/20 paths completed. Staling an unapproved output cancels its waiting gate. IM-07 invalidates without illustration change; IM-18 is a no-op; IM-19 preserves approved hashes/authorization; IM-20 blocks only while a referenced checksum fails and exact-byte repair may restore it; compatible IM-14 remains unchanged.
14. Feature 009 receives only strict transient `ApprovedBookSnapshot`: customerContentHash, immutable approval/output/gate evidence, exact composition/cover/review/layout/text/source/full-resolution refs, stable contentAuthorizationHash, and separate non-hashed observations—never bytes, paths, latest heads, preview derivatives, or printer settings. Initial guard failure creates zero job; later failure stops an existing job before artifact/head commit.
15. Automated acceptance uses synthetic data and local deterministic work only. No provider call or Gemini G2/G4 fact is needed. Pending feature 012 Flow work is excluded from this slice; imported illustrations later enter the same layout/approval ports through their ordinary page versions.

## Slice acceptance scenarios

- **A-008-01 — Deterministic placement**: identical fixture pixels/text/settings yield byte-identical policy decisions for auto plus each explicit preset, with stable quietness/contrast tie-breaks.
- **A-008-02 — Fallback and floors**: fixtures exhaust presets, then gradient/panel, then `needs_operator`; 14pt/12pt floors, overflow, long names, word budget, safe regions, and no-safe-area warnings are exact and never silently degraded.
- **A-008-03 — Dialogue**: single/multi-speaker Arabic fixtures prove RTL shaping, correct deterministic pointer anchors, non-pointing ambiguous fallback, and visible overflow handling.
- **A-008-04 — Canonical composition**: title, dedication, story, farewell, brand, front-cover proof, and back-cover proof resolve from the closed default source policy or exact revision-checked operator selection; every source asset/checksum and special-page input is pinned. Missing required source enters operator action, optional empty art/synopsis stays explicit, interior order/count is exactly 16/24, and printer blanks/spine are absent.
- **A-008-05 — Locked initial derivation**: initial layout over a locked reviewed page leaves the Page and creative heads byte-identical; replacement fails until explicit unlock.
- **A-008-06 — Stale layout fencing**: changed page-content/review-or-selection/project/text/illustration/template/settings/font/composition input, canceled job, or old claim cannot advance a layout head or consume the wrong work request; a later lock/unlock-only revision changes no customerContentHash.
- **A-008-07 — Automatic durable preview**: internal-review completion persists the workflow and `pdf_pending`; real process kill during layout/PDF resumes to exactly one ready output/asset with no duplicate or partial file.
- **A-008-08 — Mechanical preview**: complete 24-page fixture plus two cover proofs is parseable, ≤16 MB, ~150 DPI, uses the exact page map/fonts/ToUnicode, has A4 portrait MediaBox/applicable TrimBox dimensions within the pinned CompositionProfile tolerance on every page, and has the configured diagonal watermark and footer on every PDF page with no prohibited feature/resource.
- **A-008-09 — Rendered Arabic evidence**: connected forms, lam-alef, tashkeel, punctuation, long names, mixed Arabic/Latin/Western digits, all presets/aids/templates, and cover proofs pass rasterized goldens and manual visual inspection.
- **A-008-10 — Hostile-content/no-egress**: script/markup/remote CSS/image/font/file URLs, bidi controls, local paths and internal/contact fields cannot execute, load, or leak; browser/PDF capture records zero external/file request.
- **A-008-11 — Exact approval**: approve one sent preview, proving only approval succeeds its gate/advances authorization; on a same-content successor request changes with strict page/cover scope, proving its gate and prior authorization are revoked and no print descendant starts. Ledger replay, stale/two-tab collision, timestamps/audit and all revisions are exact.
- **A-008-12 — Matrix exemplars**: IM-07/11/12/14/18/19/20 traverse real artifacts/emitters and frozen replay. A print job pinned before IM-19 retains the same contentAuthorizationHash and can commit; referenced IM-20 corruption blocks it, then byte-identical repair/reverification restores authorization.
- **A-008-13 — Lock/invalidation**: upstream change preserves locked creative bytes/heads and flags `locked_stale`; the applicable layout/preview/approval consequences still occur and no work auto-regenerates.
- **A-008-14 — Print handoff**: current content approval returns one strict full-resolution snapshot. Initial content/gate/integrity mismatch creates zero print job; invalidation after creation makes the existing job stale/canceled and commits no artifact/head. New unapproved/IM-19 previews preserve prior authorization but reject new action on stale files; restored exact IM-20 bytes may unblock.
- **A-008-15 — Composition compatibility**: portrait A4 printer trim within the pinned 0.5 mm width/height tolerance and containing the composition safe rectangle leaves preview/approval unchanged regardless of printer-only bleed/DPI/color/ICC/crop/spine/blanks; any failed orientation/dimension/safe-containment term hard-blocks with explicit migration scope and no guessed scaling/reflow.
- **A-008-16 — Arabic operator UI**: layout, warnings, preview download, exact version state, affected items, and manual approval controls pass Arabic RTL keyboard/focus/bidi/44px/reduced-motion/axe/no-overflow at 390×844, 1440×900, and 1920×1080.

# Feature Specification: Arabic Layout, Preview, and Approval

**Feature ID**: `008-arabic-layout-preview-and-approval`
**Status**: Approved scope — awaiting per-slice readiness pipeline
**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

This document is an ownership and acceptance slice. Canonical requirement wording and shared rules remain in the bible. On conflict: constitution → bible → this slice.

## Outcome

Approved text-free illustrations become readable Arabic pages through deterministic layout; the operator can create a protected preview, record version-bound customer approval, and see that approval invalidated by exactly the documented visible changes.

## Requirements *(mandatory)*

Primary requirement ownership: **FR-080–083, FR-085–087, FR-120, FR-124**.

Primary user journey: **US6**. Primary clarifications: **C-03, C-06, C-14**. Full routing: [migration map](../MIGRATION.md).

Owned capability boundaries:

- Correct Arabic shaping/BiDi, embedded-font page rendering, placement presets, quiet-region analysis, readable fallback aids, overflow handling, and dialogue bubbles.
- Shared title/dedication/story/ending templates and customer-visible page composition.
- Downsampled, watermarked preview PDF plus preview-sent/approved/changes-requested records bound to book versions.
- Approval invalidation and print blocking for customer-visible changes; internal-only changes remain non-invalidating.

Printer profiles, final interior/cover files, color conversion, and print preflight are owned by feature 009. Feature 009 consumes the shared renderer and FR-120/FR-124 output invariants.

## Dependencies and feasibility gate

- Depends on feature 007 reviewed page versions and change/invalidation events.
- Depends on shared gate **G3** passing before the Arabic/PDF renderer is accepted.
- Supplies an approved book-version/page map and shared HTML/CSS templates to feature 009.
- Uses the shared invalidation matrix; approval consequences cannot be privately redefined here.

## User Scenarios & Testing *(mandatory)*

Canonical story and scenarios: **US6** in the [product bible](../001-hekayati-product-bible/spec.md).

Independent acceptance: render a completed mock book to preview; verify shaping, RTL order, readability floor, watermark on every page, downsampling and size budget; record approval, then make punctuation-only and internal-only changes and verify only the matrix-prescribed approval/layout consequences occur.

## Success Criteria *(mandatory)*

Primary measurable outcomes: **SC-007 and SC-010**. CHK020–CHK021, Arabic layout goldens, and every canonical US6 scenario provide the remaining evidence.

## Required bible artifacts

- [Layout, approval, and output requirements](../001-hekayati-product-bible/spec.md)
- [Book approval state machine](../001-hekayati-product-bible/state-machines.md)
- [Invalidation matrix](../001-hekayati-product-bible/invalidation-matrix.md)
- [Research R9 and gate G3](../001-hekayati-product-bible/research.md)
- [Arabic/preview test strategy](../001-hekayati-product-bible/test-strategy.md)

## Delivery mapping

Master tasks: **T-P7-01–T-P7-06**. Phase checkpoint and definition of done remain canonical in [tasks.md](../001-hekayati-product-bible/tasks.md).

Spec approval requires owned IDs, G3 dependency, approval-version contract, and print handoff to be accepted; it does not authorize implementation until the complete graph is approved.

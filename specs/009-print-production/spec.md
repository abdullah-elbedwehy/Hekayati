# Feature Specification: Print Production

**Feature ID**: `009-print-production`
**Status**: Approved scope — awaiting per-slice readiness pipeline
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

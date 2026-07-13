# Feature Specification: Customer and Character Library

**Feature ID**: `003-customer-character-library`
**Status**: Approved scope — awaiting per-slice readiness pipeline
**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

This document is an ownership and acceptance slice. Canonical requirement wording and shared rules remain in the bible. On conflict: constitution → bible → this slice.

## Outcome

The operator can build a restart-safe, family-scoped library of customers, consent records, characters, pets, looks, and privacy-clean reference photos without configuring any AI provider.

## Requirements *(mandatory)*

Primary requirement ownership: **FR-001–004, FR-010–017, FR-020–024**.

Primary user journey: **US1**. Data produced here is prerequisite input for **US2**. Primary clarification: **C-13**. Full routing: [migration map](../MIGRATION.md).

Owned capability boundaries:

- Customer/consent and family records; family scoping and relationship modeling.
- Versioned character and look data, pets, project-only overrides, and reusable profiles.
- HEIC/JPEG/PNG intake, content validation, size limits, EXIF orientation/stripping, reference-quality warnings, and multi-face subject selection.

Permanent deletion is owned by feature 010 through FR-005. Character-sheet generation and approval are owned by feature 007 through FR-030–033. This feature exposes the versioned inputs and affected-entity inventory those workflows require.

## Dependencies and interfaces

- Depends on feature 002 persistence, asset intake, permissions, and Arabic shell.
- Supplies family-scoped character/look version references to features 004, 005, 007, and 011.
- Supplies deletion inventory and dependency references to feature 010.
- Consent is recorded here; feature 005 enforces provider payload minimization, and neither feature 007 nor 011 can enqueue image-bearing work without the consent gate.

## User Scenarios & Testing *(mandatory)*

Canonical story and scenarios: **US1** in the [product bible](../001-hekayati-product-bible/spec.md).

Independent acceptance: with no provider configured, create one customer/family, three differently sourced characters including a pet, and two looks; verify cross-family selection is blocked, photo privacy processing is applied, warnings are specific, and all state survives restart.

## Success Criteria *(mandatory)*

Measurable slice evidence: every canonical US1 acceptance scenario passes, CHK001–CHK006 are satisfiable, cross-family selection is structurally blocked, and all created state survives restart. No new SC ID is introduced; the integrated outcome remains SC-001.

## Required bible artifacts

- [Customer/family/character/look collections](../001-hekayati-product-bible/data-model.md)
- [Character and privacy edge cases](../001-hekayati-product-bible/edge-case-catalog.md)
- [Product and privacy checklists](../001-hekayati-product-bible/checklists/product-acceptance.md)
- [Invalidation matrix triggers IM-01–05](../001-hekayati-product-bible/invalidation-matrix.md)

## Delivery mapping

Master tasks: **T-P2-01–T-P2-06** plus the US1 portion of **T-P2-10**. Character-sheet tasks T-P2-07–08 route to feature 007; deletion task T-P2-09 routes to feature 010.

Spec approval requires owned IDs, the FR-005/FR-030 interface boundaries, and acceptance evidence to be accepted; it does not authorize implementation until the complete graph is approved.

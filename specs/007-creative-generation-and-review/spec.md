# Feature Specification: Creative Generation and Review

**Feature ID**: `007-creative-generation-and-review`
**Status**: Approved scope — awaiting per-slice readiness pipeline
**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

This document is an ownership and acceptance slice. Canonical requirement wording and shared rules remain in the bible. On conflict: constitution → bible → this slice.

## Outcome

The operator can generate and approve version-bound character sheets, produce a validated story-to-illustration pipeline, review every page, regenerate only the intended scope, preserve history, lock approved work, and resolve safety or staleness explicitly.

## Requirements *(mandatory)*

Primary requirement ownership: **FR-030–033, FR-062–066, FR-070–073, FR-075, FR-115–119**.

Primary user journeys: **US2, the creative portion of US4, and US5**. Primary clarifications: **C-05, C-08, C-10**. Full routing: [migration map](../MIGRATION.md).

Owned capability boundaries:

- Character-sheet generation/export/approval/superseding bound to exact character and look versions.
- Story-plan → story → scenes → prompts → page-image graph construction using validated canonical outputs.
- Illustration styles, original-concept transformation acceptance, identity/reference strategy, content safety, and human review findings.
- Page operations, version lineage, per-page isolation, locks, stale/locked-stale states, review checklists, and consistency comparison.
- Shared invalidation-engine implementation across every IM row; trigger ownership remains with the feature causing each change.

Arabic text placement and preview approval are owned by feature 008. Printer production is owned by 009. Single Image Studio is owned by 011 and reuses this slice's style/safety rules without joining the book graph. Scheduler and provider internals remain behind features 006 and 005.

## Dependencies and interfaces

- Depends on feature 003 versioned characters/photos/looks and feature 004 story configuration/mentions/book structure.
- Depends on feature 005 validated provider boundary/capabilities and feature 006 durable execution/review gates.
- Emits versioned pages, change events, review states, approved-sheet references, and reusable style/safety constraints consumed by features 008–011.
- Uses the complete shared invalidation matrix; no slice may implement a private subset or auto-regeneration shortcut.

## User Scenarios & Testing *(mandatory)*

Canonical stories and scenarios: **US2, US4, and US5** in the [product bible](../001-hekayati-product-bible/spec.md).

Independent acceptance combines two tests: approve then supersede a character sheet after a permanent appearance edit; generate a 16-page mock book, fix page 7 only, and verify every sibling artifact is byte-identical, old versions remain recoverable, locks remain immutable, stale/canceled commits fail, and downstream approval/preview state changes exactly per the matrix.

## Success Criteria *(mandatory)*

Primary measurable outcomes: **SC-003 and SC-011**. CHK007–CHK008, CHK012–CHK015, and one automated test per IM-01–IM-20 row provide the remaining acceptance evidence.

## Required bible artifacts

- [Structured-output schemas](../001-hekayati-product-bible/contracts/structured-outputs.md)
- [Page and approval data model](../001-hekayati-product-bible/data-model.md)
- [Page and approval state machines](../001-hekayati-product-bible/state-machines.md)
- [Normative invalidation matrix](../001-hekayati-product-bible/invalidation-matrix.md)
- [Creative and page edge cases](../001-hekayati-product-bible/edge-case-catalog.md)
- [Product/AI review checklists](../001-hekayati-product-bible/checklists/product-acceptance.md)

## Delivery mapping

Master tasks: **T-P2-07–T-P2-08**, the US2 portion of **T-P2-10**, and **T-P6-01–T-P6-09**.

Spec approval requires owned IDs, all cross-feature version interfaces, and every invalidation row's implementation evidence to be accepted; it does not authorize implementation until the complete graph is approved.

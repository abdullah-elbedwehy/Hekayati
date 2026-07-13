# Feature Specification: Single Image Studio

**Feature ID**: `011-single-image-studio`
**Status**: Approved scope — awaiting per-slice readiness pipeline
**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

This document is an ownership and acceptance slice. Canonical requirement wording and shared rules remain in the bible. On conflict: constitution → bible → this slice.

## Outcome

The operator can generate, review, regenerate, retain, and download one illustration from a top-level Arabic tab without creating a book project or changing any book page, preview, approval, or print state.

## Requirements *(mandatory)*

Primary requirement ownership: **FR-140–146**.

Primary user journey: **US11**. Primary clarification: **C-15**. Full routing: [migration map](../MIGRATION.md).

Owned capability boundaries:

- Standalone prompt/style input with optional same-family character/look references and optional negative constraints.
- Exactly one durable `studio_image` job per generation, nullable project scope, shared provider/concurrency behavior, and complete provenance.
- Append-only Studio history, regeneration, single-entry deletion, restart persistence, and PNG/JPEG download.
- Hard isolation from Project/Story/Scene/Page lineages, book change events, previews, approvals, and print artifacts.

This feature reuses rather than redefines FR-003/004, FR-070–075, FR-092/094/096, FR-108, and FR-134. It does not own character data, provider adapters, scheduler policy, book generation, or the invalidation matrix.

## Dependencies and interfaces

- Depends on feature 002 navigation, asset persistence, settings, and health services.
- Depends on feature 003 family scoping, character/look versions, reference photos, and consent records.
- Depends on features 005 and 006 for image capabilities, normalized provider behavior, durable jobs, quotas, provenance, and concurrency.
- Reuses feature 007 style/legal/safety constraints and reference-budgeting behavior while remaining outside its book page graph.
- Feature 010 deletion must include Studio history/assets when their owning customer or characters are permanently deleted.

## User Scenarios & Testing *(mandatory)*

Canonical story and seven acceptance scenarios: **US11** in the [product bible](../001-hekayati-product-bible/spec.md).

Independent acceptance: from the main navigation with no project open, generate with one consented character/look, regenerate, browse both versions, and download; verify no Project/Story/Page record or book invalidation event exists. Repeat prompt-only, cross-family, no-consent, capacity-warning, and concurrent-book cases exactly as specified.

## Success Criteria *(mandatory)*

Primary measurable outcome: **SC-013**. CHK026, CHK425, EC-C11–C13, E8, and the canonical US11 scenarios provide the remaining history, RTL, isolation, and boundary evidence.

## Required bible artifacts

- [Single Image Studio requirements and E8](../001-hekayati-product-bible/spec.md)
- [StudioGeneration data model](../001-hekayati-product-bible/data-model.md)
- [Standalone scheduler semantics](../001-hekayati-product-bible/contracts/job-scheduler-contract.md)
- [Explicit invalidation-matrix exclusion](../001-hekayati-product-bible/invalidation-matrix.md)
- [Studio edge cases](../001-hekayati-product-bible/edge-case-catalog.md)
- [Product and RTL checklist evidence](../001-hekayati-product-bible/checklists/product-acceptance.md)

## Delivery mapping

Master tasks: **T-P6-10–T-P6-12**. The Phase 6 checkpoint and definition of done remain canonical in [tasks.md](../001-hekayati-product-bible/tasks.md).

Spec approval requires owned IDs, cross-feature reuse contracts, and provable book-state isolation to be accepted; it does not authorize implementation until the complete graph is approved.

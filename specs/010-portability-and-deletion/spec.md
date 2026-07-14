# Feature Specification: Portability and Deletion

**Feature ID**: `010-portability-and-deletion`
**Status**: Approved scope — awaiting per-slice readiness pipeline
**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

This document is an ownership and acceptance slice. Canonical requirement wording and shared rules remain in the bible. On conflict: constitution → bible → this slice.

## Outcome

The operator can export a complete, versioned, secret-free project snapshot; safely import hostile or older archives through explicit modes; and permanently delete selected customer/project data with a verified dependent-media report.

## Requirements *(mandatory)*

Primary requirement ownership: **FR-005 and FR-125–129**.

Primary user journey: **US9**. Primary clarification: **C-07**. Full routing: [migration map](../MIGRATION.md).

Owned capability boundaries:

- Pre-deletion affected-item inventory, shared-character decisions, explicit confirmation, job cancellation, DB cascade, filesystem media removal, Studio history/assets, and verification report.
- Paused consistent export snapshot, versioned manifest, checksums, complete project contents, unrelated-data exclusion, and mandatory secret scan.
- Validated import modes, ID/customer conflict handling, older-schema migration, future-schema rejection, path/symlink/executable defenses, disk precheck, staging, and atomic commit/rollback.
- Honest export-is-not-backup messaging in the lifecycle workflow.

Customer/family/character ownership and dependency references come from feature 003. Job cancellation and snapshot safety use feature 006. Complete generated assets/approvals/PDFs come from features 007–009; standalone Studio history/assets come from feature 011.

## Dependencies and interfaces

- Deletion of library-only data depends on feature 003; deletion of generated projects additionally depends on feature 007 and scheduler cancellation from 006.
- Full-fidelity export/import depends on the current schema and asset roles from every completed upstream feature, including Studio records when their owning customer is in scope.
- The feature may proceed after 007 in parallel with 008/009, but final round-trip coverage expands when their PDF artifacts exist.
- Secret scans consume redaction/credential patterns from features 002 and 005; no archive may be released when scanning fails.

## User Scenarios & Testing *(mandatory)*

Canonical story and scenarios: **US9** in the [product bible](../001-hekayati-product-bible/spec.md).

Independent acceptance: export a completed project, prove checksums and zero secrets/unrelated data, corrupt and weaponize fixture archives to confirm pre-write rejection, import a valid archive into a fresh instance with full fidelity, interrupt an import to prove rollback, then permanently delete and verify every reported DB/media dependency—including owned Studio history/assets—is gone.

## Success Criteria *(mandatory)*

Primary measurable outcome: **SC-005**. CHK024, CHK209, CHK217–CHK219, and every canonical US9 scenario provide the remaining round-trip, deletion, and hostile-archive evidence.

## Required bible artifacts

- [Export/import and deletion requirements](../001-hekayati-product-bible/spec.md)
- [Export and entity data model](../001-hekayati-product-bible/data-model.md)
- [Research R11](../001-hekayati-product-bible/research.md)
- [Import/export state machine](../001-hekayati-product-bible/state-machines.md)
- [Archive and deletion edge cases](../001-hekayati-product-bible/edge-case-catalog.md)
- [Privacy checklist and archive fixtures](../001-hekayati-product-bible/checklists/privacy-security.md)

## Delivery mapping

Master tasks: **T-P2-09** and **T-P9-01–T-P9-06**. Phase checkpoints and definitions of done remain canonical in [tasks.md](../001-hekayati-product-bible/tasks.md).

Spec approval requires owned IDs, schema/version policy, deletion scope, and every hostile-archive behavior to be accepted; it does not authorize implementation until the complete graph is approved.

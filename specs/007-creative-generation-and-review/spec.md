# Feature Specification: Creative Generation and Review

**Feature ID**: `007-creative-generation-and-review`
**Status**: Readiness/analyze PASS — implementation authorized
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
- Uses the complete shared invalidation matrix, including visibility-only IM-21; no slice may implement a private subset or auto-regeneration shortcut.

## User Scenarios & Testing *(mandatory)*

Canonical stories and scenarios: **US2, US4, and US5** in the [product bible](../001-hekayati-product-bible/spec.md).

Independent acceptance combines two tests: approve then supersede a character sheet after a permanent appearance edit; generate a 16-page mock book, fix page 7 only, and verify every sibling artifact is byte-identical, old versions remain recoverable, locks remain immutable, stale/canceled commits fail, and downstream approval/preview state changes exactly per the matrix.

## Success Criteria *(mandatory)*

Primary measurable outcomes: **SC-003 and SC-011**. CHK007–CHK008, CHK012–CHK015, and one automated test per IM-01–IM-21 row provide the remaining acceptance evidence.

## Required bible artifacts

- [Structured-output schemas](../001-hekayati-product-bible/contracts/structured-outputs.md)
- [Page and approval data model](../001-hekayati-product-bible/data-model.md)
- [Page and approval state machines](../001-hekayati-product-bible/state-machines.md)
- [Normative invalidation matrix](../001-hekayati-product-bible/invalidation-matrix.md)
- [Creative and page edge cases](../001-hekayati-product-bible/edge-case-catalog.md)
- [Product/AI review checklists](../001-hekayati-product-bible/checklists/product-acceptance.md)

## Delivery mapping

Master tasks: **T-P2-07–T-P2-08, T-P2-11**, and **T-P6-01–T-P6-09**.

Spec approval requires owned IDs, all cross-feature version interfaces, and every invalidation row's implementation evidence to be accepted; it does not authorize implementation until the complete graph is approved.

## Clarified delivery contract

1. A character sheet is one immutable generation attempt. Its ID is the approval target version. Five independently fenced image jobs produce `face`, `front`, `threeQuarter`, `fullBody`, and `mainOutfit`; one local finalize job verifies all five inputs, creates the compact PDF, and commits the ready sheet atomically. Reference thumbnails and the rendered character name are local-only PDF inputs, never provider inputs.
2. A sheet pins the exact appearance selection. Base appearance has no fabricated look ID; shared-look appearance pins its real look/version. Project-only overrides are not reusable character-sheet approvals and are represented only in page-generation snapshots.
3. Approval and change-request actions are creative-owner transactions over the 006 human gate. Approval binds the ready sheet ID. A change request records notes and creates a successor sheet intent; it never mutates or silently retries the rejected attempt.
4. A `CreativeRun` stores the complete planned node/edge manifest before dispatch. Provider jobs are materialized stage-by-stage only when their canonical immutable requests can be compiled from validated predecessor output; creation is atomic with predecessor commit. This preserves an inspectable durable graph without placeholder provider requests.
5. Generated plan, story text, scenes, page prompts, illustrations, findings, and review state are immutable/version-bound records. Generated scene/story versions append to the 004 lineage and never overwrite manual versions.
6. The illustration fan-out has one independent prompt and image branch per story page. One-page operations create only that page's successor lineage. Tests compare every sibling asset checksum and domain head before/after.
7. Layout-only recalculation is a handoff intent for 008: 007 invalidates/requests the affected layout but does not fabricate placement. Narrative rewrite appends a scene/page text version; illustration regeneration appends only an illustration version.
8. `locked` freezes content and head pointers. Matrix consequences may set only `locked_stale`; mutation requires explicit unlock. Approval and lock actions require the exact current page/version and completed FR-118 checklist.
9. Every IM-01–IM-21 row is table-driven. One transaction applies a row left-to-right, records an audit event and idempotent receipt, bumps `bookVersion` exactly when the Book approval column is invalidated, and never starts regeneration. IM-21 changes visibility only.
10. Safety refusal is terminal for the attempt, identifies stage/page with safe metadata, and has no prompt-variation retry. AI findings are advisory; block findings require explicit operator acknowledgement before the internal-review gate can complete.
11. Page/sheet image requests use only 005 prompt/style policy and 006 pre-dispatch resolution. Current consent is checked before enqueue and again before dispatch for direct or transitively photo-derived input. Description-only work retains the FR-004 exception.
12. Nullable/unverified real-image limits remain unavailable. Mock capability is sufficient for automated acceptance. Real Gemini verification is an opt-in synthetic script and remains an honest environment SKIP until credential and G2 limits exist.
13. Pending feature 012 Flow/external-generation proposals are excluded. No PromptPack, external import state, or `external_manual` path is introduced by 007.

## Slice acceptance scenarios

- **A-007-01 — Sheet completeness**: five mock view jobs plus finalizer produce a version-bound ready sheet and compact Arabic PDF containing all required views, reference thumbnails, and character name.
- **A-007-02 — Approval lineage**: approve, request changes, regenerate, and edit permanent appearance; approvals stay bound to old sheet IDs and the applicable approval becomes superseded with exact affected items.
- **A-007-03 — Durable creative graph**: a 16-page project creates one complete run manifest; stage jobs appear only after validated predecessors and survive real process kill/restart without duplicate domain commits.
- **A-007-04 — Validated content**: plan, text, scenes, prompts, and findings pass 005 schemas and domain cross-checks before any product record is committed; malformed output stores no body.
- **A-007-05 — Page fan-out isolation**: regenerate story page 7 and prove pages 1–6 and 8–12 have byte-identical assets, unchanged heads, and unchanged provenance.
- **A-007-06 — Page operations/history**: text-only rewrite, illustration-only regeneration, layout handoff, revert, approve, lock, and unlock append/repoint only permitted lineage while all prior versions remain readable.
- **A-007-07 — Locks/staleness**: upstream change flags a locked page `locked_stale` without changing content; unlocked affected pages become stale with explicit actions and no generated job.
- **A-007-08 — Invalidation completeness**: one automated case per IM-01–IM-21 proves consequences, transitive order, receipt replay, audit evidence, and exact book-version behavior.
- **A-007-09 — Review gate**: each page requires identity, participant, pet, art/text, safety, and consistency checks; unacknowledged block findings prevent gate completion.
- **A-007-10 — Safety refusal**: a scripted refusal identifies the exact stage/page, performs zero automatic retries, and requires explicit operator correction/new intent.
- **A-007-11 — Consent/reference boundary**: revoked/not-recorded consent blocks photo-bearing sheet/page work before capability/provider calls; description-only sheets and approved-sheet lineage behave exactly per FR-004.
- **A-007-12 — Capacity/prompt policy**: excess verified character/reference capacity and named-artist/franchise prompts block with explicit confirmation/reduction choices; no silent drop or substitution occurs.
- **A-007-13 — Arabic operator UI**: sheet approval and page review work at 390, 1440, and 1920 widths with RTL order, keyboard operation, visible focus, no clipping, and axe checks.
- **A-007-14 — PDF evidence**: the compact sheet PDF passes mechanical page/media checks and rendered Arabic/visual inspection from synthetic assets.
- **A-007-15 — Honest live boundary**: automated acceptance makes zero real-provider calls; opt-in live scripts report PASS/FAIL/SKIP per exact configured provider/model without fallback.

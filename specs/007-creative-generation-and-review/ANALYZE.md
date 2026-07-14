# Analyze: 007 Creative Generation and Review

**Verdict**: PASS — ready for implementation

**Date**: 2026-07-14

**Open clarify blockers**: none

**External live constraints**: Real Gemini image acceptance remains environment-blocked until an operator credential and measured G2 limits are configured. Deterministic mock implementation and checkpoint may proceed. Missing live capability is an honest SKIP, never a substituted pass.

## Cross-artifact result

| Area | Result | Evidence |
| --- | --- | --- |
| Scope | PASS | 007 owns sheets/character approval, creative generation, pages/creative history, review/safety, and the shared invalidation engine. It defers Arabic layout/preview to 008, printer output to 009, deletion to 010, Studio to 011, and all pending Flow/012 behavior. |
| Requirements | PASS | FR-030–033, FR-062–066, FR-070–073, FR-075, FR-115–119; US2/US4-creative/US5; SC-003/011; T-P2-07/08/11 and T-P6-01–09 map to A-007-01–15 and 007-C01–38. |
| Version model | PASS | Sheets are immutable attempts and approval target versions; generated story/scenes append into 004; page text/prompt/illustration records are immutable; heads and workflow flags are explicit. |
| Appearance ambiguity | PASS | Base appearance is explicit and carries no invented look ID; shared look pins real IDs. Provider sheet references are nullable for base only. Project override is project/page scoped. |
| Durable DAG | PASS | Full logical manifest precedes dispatch. Actual provider jobs materialize only after validated predecessor content exists, atomically with commit, avoiding invalid placeholder requests while preserving dependency/restart evidence. |
| Provider boundary | PASS | 005 tasks/schemas/prompt policy and 006 pre-dispatch/capability/fenced commit are reused. Domain code has no adapter import or network call. |
| Privacy | PASS | Shared enqueue consent plus repeated dispatch consent, sheet transitive lineage, derived-only references, local thumbnails/PDF, content-free failures, and synthetic fixtures are explicit and testable. |
| Invalidation | PASS | Closed 21-row table, one-pass cascade, lock flags, idempotent hash receipts, audit, affected actions, and exact book-version semantics cover Constitution VII/X without regeneration. |
| Safety/review | PASS | FR-115 checklist, AI advisory findings, block acknowledgement, consistency compare, version-bound human gate, and terminal no-auto-retry refusal are specified. |
| PDF | PASS | One local Playwright/Chromium renderer, bundled Arabic font, no remote assets, atomic asset preparation, mechanical/rendered verification, and G3 fail-closed semantics are defined. |
| UX/accessibility | PASS | Citrus Playground Arabic RTL review workflow, three widths, keyboard/focus/bidi/targets/reduced motion/axe/no-overflow/zero-egress acceptance are explicit. |
| Testability | PASS | Deterministic 16-page mock graph, fault scripts, kill/restart, sibling checksums, every IM row, PDF render, privacy scans, and opt-in live SKIP/PASS evidence require no real customer data. |

## Requirement-to-task trace

| Requirement group | Master task / acceptance evidence |
| --- | --- |
| FR-030/031 | T-P2-07; A-007-01/14; 007-C06–08 |
| FR-032/033, IM-01 | T-P2-08/11; A-007-02; 007-C09–11/27–31 |
| FR-060/114 and generated lineage | T-P6-01/02/08; A-007-03/04; 007-C03/12–17 |
| IM-01–21, FR-058/086/087 | T-P6-03/08; A-007-08; 007-C27–31 |
| FR-004/075 reference strategy | T-P6-04; A-007-11/12; 007-C11/19/32/33 |
| FR-062–066, SC-003 | T-P6-05; A-007-05–07; 007-C20–24 |
| FR-041/047/048/071/082/092/115–119 | T-P6-06/07; A-007-09/10/12; 007-C18/24–26/33 |
| US4/US5 checkpoint and live script | T-P6-09; A-007-03/05/13–15; 007-C16/17/34–38 |

## Clarifications resolved during readiness

1. Resolved the base-appearance versus required-look contradiction: base sheets have `lookVersionId=null`; shared-look sheets require exact IDs. No sentinel masquerades as a domain version.
2. Defined the sheet ID as the immutable approval target version and separated generated content from mutable workflow projection.
3. Reconciled canonical immutable job requests with downstream-output-dependent generation: a complete run manifest is durable first, while executable jobs are materialized atomically at validated stage boundaries.
4. Made the five sheet views independent fenced image jobs and the PDF/sheet one local atomic finalizer; partial view results never appear as a ready sheet.
5. Defined generated authoring append behavior against the existing 004 blank/manual lineage rather than introducing a parallel story model.
6. Split creative page content from 008 layout. Layout-only action is an explicit downstream handoff/invalidation, not a guessed layout record.
7. Bound review completion to the exact page tuple and required checklist; a stale review cannot approve newer content.
8. Made every invalidation row executable through one closed table, including rows whose artifact owners arrive in 008/009 and visibility-only IM-21.
9. Made safety refusal terminal at the attempt and safe stage/page context domain-owned; no raw provider text is needed for resolution.
10. Kept pending Flow/012 artifacts out of the approved graph and all implementation/test expectations.

## Alternatives rejected

- Fabricate a base-look version ID: rejected because it would create false lineage and break version/reference validation.
- Mutate one character-sheet row through repeated generations: rejected because approval/provenance could drift and prior attempts would be lost.
- Persist placeholder story/page provider requests before predecessor output exists: rejected because 006 requires canonical immutable requests.
- Build the whole pipeline synchronously in one worker call: rejected because it removes per-stage durability, fan-out isolation, retry visibility, and human gates.
- Let route handlers or domain services call mock/Gemini directly: rejected by provider neutrality and scheduler-only invocation.
- Generate all pages as one image job or one combined asset: rejected by FR-062/063 and SC-003.
- Re-run the full book after a page edit: rejected by explicit invalidation and no-auto-regeneration rules.
- Store AI review as authoritative moderation: rejected; human review remains mandatory and findings are advisory annotations.
- Auto-vary a refused prompt: rejected by FR-116 and could alter approved intent invisibly.
- Implement PDF with remote fonts/assets or a second renderer fallback: rejected by local-only/G3 evidence and deterministic Arabic output requirements.
- Treat mock limits as Gemini capabilities: rejected; provider/model evidence is exact and nullable real limits fail closed.
- Implement pending Flow/012 alongside 007: rejected because it is outside the approved slice graph and would alter job/origin semantics.

## Counts and gates

- 12 unique master task IDs are in scope: T-P2-07, T-P2-08, T-P2-11, and T-P6-01–09.
- 15 slice acceptance scenarios: A-007-01–15.
- 38 implementation evidence checks: 007-C01–38.
- 21 invalidation rows require one direct automated case each plus replay/cascade coverage.
- Binding canonical product checks include CHK007–008 and CHK012–015; AI/privacy/UX checks referenced by the master tasks remain required.
- No privacy, money, legal, product, or architecture choice requires operator clarification. Live real-provider checks remain opt-in and externally constrained.

Analyze PASS is implementation approval under the authorized full-delivery loop. Implementation must preserve concurrent Flow/spec edits, satisfy the mock/PDF/UI checkpoint, and write `IMPLEMENTATION_NOTES.md` before the feature commit.

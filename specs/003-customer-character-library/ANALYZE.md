# Analyze: 003 Customer and Character Library

**Result**: PASS
**Date**: 2026-07-14
**Implementation authorization**: The approved full-delivery prompt auto-continues after a clean analyze gate; no additional slice confirmation is required.

## Inputs checked

- Constitution v1.0.0, repository agent rules, and the approved full-delivery loop.
- Product bible specification, plan, R4/R12 research, data model, provider/scheduler contracts, state machines, invalidation matrix, edge catalog, risk register, test strategy, quickstart, checklists, and master tasks.
- Slice 003, the dependency registry/migration map, and downstream interface consumers 004–007/011.
- Existing feature 002 persistence, asset, local-HTTP, settings, health, RTL shell, and verification notes.

## Findings resolved

1. Routine library removal is now reversible archive/restore; FR-005 permanent deletion remains exclusively in 010. Archive/restore is visibility-only IM-21 and never mutates pinned content, consent, approvals, or jobs.
2. Consent has three distinguishable states: absent, recorded refusal, and granted. The shared 003 gate runs before enqueue; 006 alone repeats current-state consent/reference resolution immediately before dispatch. Photo-derived sheets retain the photo gate, wholly description-derived sheets retain the zero-photo exception, and 005 adapters never query domain state.
3. Family membership has one source of truth. An empty family’s first active member atomically becomes its assign-once `main_child` anchor; the anchor ID/relationship cannot be reassigned. Missing or archived anchors block later member and Project/Studio selection without changing existing relationship meaning.
4. Character/Look versions are immutable. Append, expected-head compare-and-swap, and one outbox event per applicable IM row commit together. 003 emits IM-01–03/05/21; 004 owns project-only FR-014(a)/IM-04 storage; 007 consumes all rows through immutable receipts.
5. Reference intake is bounded and atomic. Runtime-only staging performs streaming byte/pixel/type/decode validation, duplicate choice, safe preview, and required face selection before any visible product record. A new photo-only character and first usable reference commit together; existing character/look intake appends the correct owning version.
6. Exact uploads live in a separate provider-ineligible `originals/` namespace. Working, thumbnail, and face-crop derivatives are newly encoded and metadata-clean; only the pinned `ReferencePhoto.providerAssetId` can resolve. Cancellation, expiry, failure, and restart leave no visible/dangling state or orphan beyond reserved files handled by startup GC.
7. Photo QA is local, explainable, and non-biometric. A versioned policy stores dimensions, blur/exposure/shadow and subject-box metrics with thresholds; subjective people/obstruction/filter/age/hair/clothing observations are operator-entered. Every face photo has a keyboard-operable rectangle, and multi-person input requires explicit intended-person selection.
8. The provider boundary now separates persisted `ImageRequestDraft` IDs from an ephemeral `ResolvedImageRequest`. The 006 resolver reads only approved clean bytes after all checks; adapters receive no asset-store/original handle. Master tasks and slice dependencies cover producer enqueue, centralized pre-dispatch validation, Project/Studio anchor rechecks, and trusted sheet lineage.
9. Master FR/EC traceability was repaired without renumbering IDs. All added requirements, decisions, matrix/risk/edge/checklist/task IDs and cross-slice handoffs are reflected in the migration map and canonical task graph.

## Owned traceability

| Requirement / decision | 003 evidence | Later evidence kept open |
| --- | --- | --- |
| FR-001–003, FR-018–019, C-18/C-19/C-21 | Customer/family lifecycle, immutable anchor, family-local duplicate decision, structural query/direct-ID scope tests | Project picker 004; Studio picker 011; permanent delete 010 |
| FR-004, C-13 | Persisted consent states, exact errors, shared enqueue policy, direct-photo resolver | Producer enqueue 007/011; centralized dispatch recheck 006; adapter isolation 005 |
| FR-010–017 | Immutable character/look/pet profiles, CAS heads, three-intent command, IM-01–03/05 events | FR-014(a)/IM-04 project storage 004; approvals/invalidation consumption 007 |
| FR-020–025, C-20 | Runtime staging, byte/pixel/type/decode limits, private originals, clean derivatives, atomic owner commit, versioned warnings and required face crop | Payload snapshots 005/007; permanent media deletion 010 |
| CHK001–005/027, CHK216/227 | Full provider-free US1 domain, filesystem, UI, restart, cancellation, and hostile-input evidence | Composite checklist closure at owning later slices / Phase 10 |
| CHK006/206/208/210/220 and CHK401–405/420–424/427 | Explicit 003 contribution recorded | Project/provider/export and full-journey contributions remain open |

## Automated consistency audit

- 120 FR IDs are defined and assigned to exactly one primary slice; every FR appears in at least one master task reference.
- All 14 SC IDs, 21 clarification IDs, 21 IM rows, 18 risks, 115 edge cases, 119 checklist IDs, and 97 master task IDs are defined and unique.
- Every edge case appears in a master task or checklist; all IM rows have one migration owner and shared-engine verification remains T-P6-03.
- Slice 003 contains no unresolved placeholder or clarification marker.
- All local Markdown links under `specs/` resolve.
- `git diff --check` passes.

## Gate decision

No constitution conflict, unresolved ownership seam, fundamental product ambiguity, privacy/consent gap, or feasibility blocker remains for the provider-free 003 checkpoint. Gemini G2/G4 account limitations do not affect this slice. Implementation may begin under the approved full-delivery loop.

# Feature Specification: Customer and Character Library

**Feature ID**: `003-customer-character-library`
**Status**: Ready for implementation — analyze PASS 2026-07-14
**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

This document is an ownership and acceptance slice. Canonical requirement wording and shared rules remain in the bible. On conflict: constitution → bible → this slice.

## Outcome

The operator can build a restart-safe, family-scoped library of customers, consent records, characters, pets, looks, and privacy-clean reference photos without configuring any AI provider.

## Requirements *(mandatory)*

Primary requirement ownership: **FR-001–004, FR-010–025** *(numeric gaps remain canonical; FR-018/019/025 were added by this readiness pass)*.

Primary user journey: **US1**. Data produced here is prerequisite input for **US2**. Primary clarifications: **C-13 and C-18–C-21**. Full routing: [migration map](../MIGRATION.md).

Owned capability boundaries:

- Customer/consent and child-anchored family records; assign-once anchor semantics; reversible archive/restore; family-local, non-biometric duplicate candidates with exact normalization; one structural family-scope policy for queries and mutations.
- Immutable character/look versions, compare-and-swap heads, pets derived from relationship, the closed three-intent edit command, classified IM-01–03/05/21 change-event outbox, and reusable profiles. IM-04 storage/emission is the 004 project-context destination.
- Bounded HEIC/JPEG/PNG intake with opaque runtime staging, atomic new-photo-character creation, a private provider-ineligible original namespace, content/decode and pixel validation, orientation/metadata-clean derivatives, atomic character/look-owned `ReferencePhoto` records, versioned explainable quality warnings, and a keyboard subject rectangle/crop for every face photo.
- A provider-neutral consent decision and provider-reference resolver: generation producers call the shared enqueue gate, 006 alone re-runs the resolver immediately before dispatch, and 005 adapters accept only the resulting ephemeral safe request.

Permanent deletion is owned by feature 010 through FR-005; 003 exposes only a read-only dependency inventory. Character-sheet generation and approval are owned by feature 007 through FR-030–033. Project persistence, narrative roles, and the enabled project-only edit destination are owned by 004. This feature exposes versioned inputs, typed provider-eligible references, and change events; it does not simulate any deferred subsystem.

## Readiness decisions

- `consent=null` is not recorded; a recorded refusal is distinct. Both block direct-photo and transitively photo-derived-sheet work with stable codes, while local data, description-only work, and wholly description-derived sheets remain allowed. Consent is re-read at enqueue and immediately before dispatch (FR-004, EC-H14).
- `Character.familyId` and `Look.characterId` are the only membership sources of truth. A family anchor is assigned once to its sole active `main_child`; the ID and relationship cannot be reassigned in v1. A missing/archived anchor blocks new Project/Studio selection without changing old meanings, while projects may later choose any eligible same-family non-pet hero (C-21).
- Versions are insert-only. Edit/revert appends a new version and advances the head only when the expected prior head still matches. The append, head CAS, and every applicable matrix-row event commit together.
- Exact uploads live only under the private `originals/` namespace. Working, thumbnail, and subject-crop assets are newly derived and metadata-clean. Every face reference sends only its selected crop. Only `ReferencePhoto.providerAssetId` may resolve toward provider orchestration; ordinary browser routes receive thumbnails, never originals.
- FR-023 uses a versioned local policy with recorded dimensions/blur/exposure/subject-box metrics and explicit operator observations. Every face photo receives an operator-drawn subject rectangle; multi-person input cannot commit without explicit intended-person placement. No provider call, biometric identity match, face embedding, age estimator, automatic merge, or cross-family duplicate disclosure exists in this slice.
- Intake preflight uses an opaque runtime reservation with no visible domain record. It returns only a safe thumbnail/findings and duplicate choice; commit either atomically creates the new photo-only character and first usable reference or appends the existing character/look owner version. Cancel, expiry, failure, and restart leave no residue.
- Routine removal is Arabic-labeled archive/restore. No permanent-delete endpoint, button, or side effect exists before 010.

Stable domain failures used by API/UI/tests are: `PHOTO_CONSENT_NOT_RECORDED`, `PHOTO_CONSENT_NOT_GRANTED`, `FAMILY_SCOPE_MISMATCH`, `FAMILY_ANCHOR_REQUIRED`, `FAMILY_ANCHOR_ARCHIVED`, `FAMILY_ANCHOR_IMMUTABLE`, `STALE_VERSION_HEAD`, `DUPLICATE_VERSION_ID`, `PHOTO_UNSUPPORTED_TYPE`, `PHOTO_DECODE_FAILED`, `PHOTO_FILE_TOO_LARGE`, `PHOTO_PIXEL_LIMIT_EXCEEDED`, and `PHOTO_SUBJECT_SELECTION_REQUIRED`. Arabic UI copy is actionable and never exposes filesystem paths, image metadata, or raw stack/provider text.

Stable advisory warning codes are: `PHOTO_LIMITED_REFERENCES`, `PHOTO_BLURRY`, `PHOTO_FACE_TOO_SMALL`, `PHOTO_MULTIPLE_PEOPLE`, `PHOTO_EXTREME_SHADOWS`, `PHOTO_OBSTRUCTED`, `PHOTO_FILTER_SUSPECTED`, `PHOTO_AGE_CONFLICT`, `PHOTO_HAIR_CONFLICT`, and `PHOTO_CLOTHING_CONFLICT`. Each record identifies `local_check` with policy/metric/threshold or `operator` with the explicit observation; warnings never block commit except the separate FR-024 subject-selection precondition.

## Dependencies and interfaces

- Depends on feature 002 persistence, asset intake, permissions, and Arabic shell.
- Extends 002 with insert-only/CAS repository primitives, bounded multipart input, private-original storage, prepared multi-file commits, integrity/health coverage, and settings v1→v2 photo limits.
- Supplies family-scoped character/look versions and `ProviderEligibleReference` records to project/Studio producers in 004/007/011 and the 005 contract; arbitrary asset IDs are not an adapter interface. Feature 006 consumes 003 directly and turns validated IDs into ephemeral `ResolvedImageRequest` bytes immediately before adapter dispatch.
- Supplies the append-only change outbox to 004/007 and read-only deletion inventory/dependency references to feature 010.
- Consent state, enqueue gate, and provider-reference resolver are implemented here. Producers in 007/011 call the enqueue gate; 006 alone repeats current-state consent/reference validation immediately before dispatch; 005 adapters never query domain state and accept only the resolved request.

## User Scenarios & Testing *(mandatory)*

Canonical story and scenarios: **US1** in the [product bible](../001-hekayati-product-bible/spec.md).

Independent acceptance: with no provider configured and synthetic people only, create one customer with consent, an anchored family, three differently sourced characters including an atomically created photo-only child and a pet, and two looks; exercise normalized duplicate choice, immutable/archived anchor behavior, and archive/restore; import a metadata-bearing HEIC plus warning/multi-person fixtures; use keyboard subject rectangles; reject a direct cross-family ID bypass; cancel and interrupt staged intake; kill/restart the app; verify every committed record/version/private original/derived asset survives, only safe derivatives are exposed, staging leaves no residue, and zero external request occurs.

Canonical US1 scenarios 1, 3, 5, and 6 close fully here. Scenario 2 closes local storage plus the shared consent/enqueue decision here; 007/011 recheck producer enqueue and 006 rechecks actual dispatch. Scenario 4 closes the structural family query/mutation invariant here and is rechecked in 004's project picker and 011's Studio picker.

## Success Criteria *(mandatory)*

No new SC ID is introduced; the integrated outcome remains SC-001. Slice closure is staged honestly:

| Requirement/check | 003 evidence | Required later recheck |
|---|---|---|
| FR-001/002/010–019; CHK001/027 | CRUD-with-archive, immutable anchor semantics, immutable profiles/looks/pets, exact duplicate choice, restart | Permanent deletion remains 010 |
| FR-003; CHK002/210 | Family-filtered queries and direct-ID mutation rejection | Project picker 004; Studio picker 011 |
| FR-004; CHK003/206 | Persisted current consent + shared absent/refused enqueue policy | Producer enqueue 007/011; centralized pre-dispatch recheck 006; adapter isolation 005 |
| FR-014; CHK006 | Closed three-intent domain command; base/new-look behavior | Project-only storage and enabled UI 004 |
| FR-015/017; IM-01–03/05/21 | Version/head CAS, exact field classification, append-only outbox | IM-04 project override 004; outbox consumption/invalidation 007 |
| FR-020–025; CHK004/005/216/227 | Opaque staging, atomic photo-only creation, content/decode limits, private original + clean derivatives, versioned warnings/face crop, character/look ownership | Payload snapshots confirm selected derivatives only in 005/007 |
| FR-005 interface | Complete read-only library dependency inventory | Confirmed destructive cascade 010 |
| CHK208 | Originals structurally provider-ineligible; derivatives metadata-clean | Actual provider payload evidence 005/007 |
| CHK220 | Upload-handling security review contribution | Provider and export/import contributions 005/010 |

## Required bible artifacts

- [Customer/family/character/look collections](../001-hekayati-product-bible/data-model.md)
- [Character and privacy edge cases](../001-hekayati-product-bible/edge-case-catalog.md)
- [Product checklist](../001-hekayati-product-bible/checklists/product-acceptance.md) and [privacy checklist](../001-hekayati-product-bible/checklists/privacy-security.md)
- [RTL/accessibility checklist](../001-hekayati-product-bible/checklists/ux-arabic-rtl.md)
- [Invalidation matrix triggers IM-01–03, IM-05, and IM-21](../001-hekayati-product-bible/invalidation-matrix.md)
- [Provider-reference contract](../001-hekayati-product-bible/contracts/provider-contract.md) and [pre-dispatch contract](../001-hekayati-product-bible/contracts/job-scheduler-contract.md)

## Delivery mapping

Master tasks: **T-P2-01–T-P2-06, T-P2-10, and T-P2-12**. Character-sheet tasks T-P2-07–08 plus US2 E2E T-P2-11 route to feature 007; permanent deletion T-P2-09 routes to feature 010.

The approved full-delivery loop auto-authorizes implementation after this slice's analyze PASS. No open product, privacy, architecture, or feasibility decision remains; Gemini G2/G4 are irrelevant to this provider-free checkpoint.

# Feature Specification: Story Authoring and Templates

**Feature ID**: `004-story-authoring-and-templates`
**Status**: Approved scope — awaiting per-slice readiness pipeline
**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

This document is an ownership and acceptance slice. Canonical requirement wording and shared rules remain in the bible. On conflict: constitution → bible → this slice.

## Outcome

The operator can configure a complete 16- or 24-page book, author scenes with identity-safe Arabic @mentions, and create/version reusable templates without contacting an AI provider.

## Requirements *(mandatory)*

Primary requirement ownership: **FR-035–041, FR-045–053, FR-055–060**.

Primary user journeys: **US3 and US10**. Primary clarification: **C-11**. Book-structure decisions C-03–05 and participant-capacity decision C-08 are consumed by later slices as mapped in [MIGRATION.md](../MIGRATION.md).

Owned capability boundaries:

- Stable ID-bound mentions, group expansion, Arabic-name search/edit behavior, scene properties, and prose/participant reconciliation.
- Story configuration, narrative roles, dedication, page count, tone, style selection, hidden-goal setup, and narration/dialogue suggestion.
- Versioned templates, privacy-safe template extraction, duplication, archives/disabling, seven seed templates, and pinning.
- Canonical interior book structure and page content model before generation/layout.

Not owned here: provider prompt compilation (005), durable jobs (006), generated story/image quality and page review (007), rendered Arabic layout and approval PDFs (008), or printer-only assembly (009).

## Dependencies and interfaces

- Depends on feature 003 family-scoped characters and looks.
- Produces version-pinned story configuration, templates, scenes, mention participants, and book structure for features 005–009.
- Participant warnings use capability values owned by feature 005; generation decisions and content review are owned by feature 007.
- Feature 009 consumes FR-057 printer-page assembly behavior without changing the customer-visible page map.

## User Scenarios & Testing *(mandatory)*

Canonical stories and scenarios: **US3 and US10** in the [product bible](../001-hekayati-product-bible/spec.md).

Independent acceptance: configure a full Space Adventure without a provider; author scenes containing two characters named أحمد; rename one; verify mentions remain ID-bound, zero-member groups block, prior template versions remain pinned, and template-from-story output contains no customer identity data.

## Success Criteria *(mandatory)*

Measurable slice evidence: every canonical US3/US10 acceptance scenario passes, CHK009–CHK011 are satisfiable, every FR-040 edit edge has a test, and template extraction carries zero customer names, photos, or identity-bound mentions. No new SC ID is introduced; the integrated outcome remains SC-001.

## Required bible artifacts

- [Project/template/story/scene/mention data model](../001-hekayati-product-bible/data-model.md)
- [Structured participant rules](../001-hekayati-product-bible/contracts/structured-outputs.md)
- [Authoring edge cases](../001-hekayati-product-bible/edge-case-catalog.md)
- [UX and privacy checklists](../001-hekayati-product-bible/checklists/ux-arabic-rtl.md)

## Delivery mapping

Master tasks: **T-P3-01–T-P3-08**. Phase checkpoint and definition of done remain canonical in [tasks.md](../001-hekayati-product-bible/tasks.md).

Spec approval requires owned IDs and downstream payload/page-map interfaces to be accepted; it does not authorize implementation until the complete graph is approved.

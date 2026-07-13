# Feature Specification: Local Foundation

**Feature ID**: `002-local-foundation`
**Status**: Approved scope — awaiting per-slice readiness pipeline
**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

This document is an ownership and acceptance slice. Canonical requirement wording and shared rules remain in the bible. On conflict: constitution → bible → this slice.

## Outcome

A safe local application foundation starts only on loopback, persists documents and assets across restarts, protects credentials and child data, renders an Arabic RTL shell, and exposes honest settings and health diagnostics without requiring an AI provider.

## Requirements *(mandatory)*

Primary requirement ownership: **FR-093, FR-097, FR-110, FR-130–133, FR-135, FR-137–138**.

Primary clarifications: **C-01, C-02, C-16**. Full routing: [migration map](../MIGRATION.md).

Owned capability boundaries:

- Single-process local shell, Citrus Playground visual foundation, loopback startup guard, document repository, content-addressed asset store, and restart-safe base state.
- File permissions, log redaction, telemetry absence, first-run no-backup warning, settings document, and health/diagnostics surface.
- Keychain transport mechanism and secret-safe process invocation as platform services; provider-specific key lifecycle remains owned by feature 005.
- Integrity detection and regeneration offers; actual regeneration is delegated to the feature that owns the affected artifact.

Not owned here: customer/domain workflows (003+), AI contracts/adapters (005), scheduler semantics (006), creative generation (007), document production (008–009), or archives/deletion (010).

## Dependencies and interfaces

- Full spec graph approval and completion of the shared Phase 0 gate record precede product scaffolding.
- Feature 005 consumes Keychain, settings, redaction, and asset services.
- Feature 006 consumes transactional persistence, health alerts, and atomic assets.
- Features 007–011 consume the asset store and integrity surface.
- Interface requirements owned elsewhere but exercised here include FR-094, FR-105–106, FR-109–114, and FR-125–129.

## User Scenarios & Testing *(mandatory)*

Independent acceptance: start on a clean Mac account; verify exclusive `127.0.0.1` binding, Arabic RTL shell, persisted settings and documents after kill/restart, safe data-directory permissions, actionable health state, no external telemetry, and zero secrets outside their approved stores.

## Success Criteria *(mandatory)*

Primary measurable outcome: **SC-012**. The Phase 1 checkpoint additionally requires restart persistence, loopback refusal tests, and secret-isolation evidence defined by the master tasks and checklists.

## Required bible artifacts

- [Integrated plan technical context](../001-hekayati-product-bible/plan.md)
- [Research R1, R2, R4, and R8](../001-hekayati-product-bible/research.md)
- [Product context](../../PRODUCT.md), [design system](../../DESIGN.md), and [canonical Citrus Playground kit](../../brand-kits/02-citrus-playground.html)
- [Data model: assets and settings](../001-hekayati-product-bible/data-model.md)
- [Privacy/security and UX checklists](../001-hekayati-product-bible/checklists/privacy-security.md)
- [Global test strategy](../001-hekayati-product-bible/test-strategy.md)

## Delivery mapping

Master tasks: **T-P1-01–T-P1-10**. Phase checkpoint and definition of done remain canonical in [tasks.md](../001-hekayati-product-bible/tasks.md).

Spec approval requires owned IDs, interfaces, and evidence routing to be accepted; it does not authorize implementation until the complete graph is approved.

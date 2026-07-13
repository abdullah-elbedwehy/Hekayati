# Feature Specification: AI Provider Boundary

**Feature ID**: `005-ai-provider-boundary`
**Status**: Approved scope — awaiting per-slice readiness pipeline
**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

This document is an ownership and acceptance slice. Canonical requirement wording and shared rules remain in the bible. On conflict: constitution → bible → this slice.

## Outcome

The system exposes one validated, provider-neutral AI boundary with honest runtime capabilities, safe credential handling, deterministic mock behavior, and conformant Codex/Gemini adapters. Domain behavior never depends on provider-specific types or silent substitutions.

## Requirements *(mandatory)*

Primary requirement ownership: **FR-090–091, FR-094–095, FR-098–103, FR-105–108, FR-134**.

Primary user journey: **US8** and the provider-facing portion of **US4**. Full routing: [migration map](../MIGRATION.md).

Owned capability boundaries:

- Canonical provider operations, structured-output validation boundary, provenance, health/capability discovery, and manual provider/model selection.
- Codex subscription text/image feasibility posture with no OpenAI API-key billing path.
- Gemini Keychain lifecycle, model configuration/availability, economy warnings, and minimum provider payloads.
- Deterministic mock adapter, adapter conformance, prompt compilation, legal/style transformations, and reference budgeting.

Failure retry policy, quota-pause transitions, and job durability are owned by feature 006. Creative acceptance of stories/images is owned by feature 007. Atomic asset storage and integrity services are owned by feature 002.

## Dependencies and feasibility gates

- Phase 0 gates **G1-T, G1-I, G2, and G4** are owned here; outcomes update the shared research, capability matrix, and risk register before dependent work.
- Delivery depends on feature 002 Keychain, redaction, settings, assets, and health surfaces.
- Feature 006 consumes normalized failures/capabilities and owns orchestration reactions.
- Features 007 and 011 consume only canonical requests, schemas, capabilities, and validated results.

## User Scenarios & Testing *(mandatory)*

Canonical story and scenarios: **US8** in the [product bible](../001-hekayati-product-bible/spec.md).

Independent acceptance: run the conformance suite against the mock and fixture adapters; verify malformed/alien structured data never persists, key material appears nowhere outside Keychain, model unavailability never substitutes, Codex image status matches G1-I, economy mode warns persistently, and every successful artifact has complete provenance.

## Success Criteria *(mandatory)*

Primary measurable outcome: **SC-004**. CHK101–CHK105, CHK111–CHK115, CHK119–CHK120, and the US8 acceptance scenarios supply the remaining gate/capability evidence.

## Required bible artifacts

- [Provider contract](../001-hekayati-product-bible/contracts/provider-contract.md)
- [Structured-output schemas](../001-hekayati-product-bible/contracts/structured-outputs.md)
- [Research R5–R7 and provider side of R12](../001-hekayati-product-bible/research.md)
- [Capability matrix](../001-hekayati-product-bible/provider-capability-matrix.md)
- [AI reliability checklist](../001-hekayati-product-bible/checklists/ai-reliability.md)

## Delivery mapping

Master tasks: **T-P0-01–T-P0-05** and **T-P4-01–T-P4-10**. Gate consolidation T-P0-08 remains shared in the bible.

Spec approval requires owned IDs, gate questions, canonical contracts, and downstream failure interfaces to be accepted; it does not authorize implementation until the complete graph is approved.

# Feature Specification: Local Foundation

**Feature ID**: `002-local-foundation`
**Status**: Implemented — Phase 1 checkpoint PASS 2026-07-14
**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

This document is an ownership and acceptance slice. Canonical requirement wording and shared rules remain in the bible. On conflict: constitution → bible → this slice.

## Outcome

A safe local application foundation starts only on loopback, persists documents and assets across restarts, protects credentials and child data, renders an Arabic RTL shell, and exposes honest settings and health diagnostics without requiring an AI provider.

## Requirements *(mandatory)*

Primary foundation ownership: **FR-093, FR-097, FR-110, FR-130–133, FR-135, FR-137–138, FR-147–148**.

Primary clarifications: **C-01, C-02, C-16–17**. Primary measurable outcomes: **SC-012, SC-014**. Full routing: [migration map](../MIGRATION.md).

Owned capability boundaries:

- Single-process local shell, Citrus Playground visual foundation, loopback startup guard, document repository, content-addressed asset store, and restart-safe base state.
- Literal-IP HTTP trust boundary: canonical authority validation, DNS-rebinding rejection, same-origin browser API, CSRF protection for every state change, and fail-closed CORS/PNA behavior.
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

Security-negative acceptance uses a seeded state-change counter and proves all of the following before any product route handler runs:

1. Wildcard, LAN, hostname, IPv6, and alternate-loopback listener configurations are rejected before socket open; the independent post-listen address check cannot be bypassed by configuration.
2. Missing/malformed authority, `localhost`, alternate `127/8`, and an attacker DNS name resolving to `127.0.0.1` are rejected with no application content or state access; spoofed forwarded-host headers do not change the decision.
3. Cross-origin `Origin` values, untrusted CORS preflights, and PNA preflights receive no cross-origin/private-network opt-in headers.
4. Every state-changing method rejects an invalid or missing `Origin`/`Referer`, opaque `Origin: null`, and missing/invalid/stale CSRF tokens; the state-change counter remains byte-identical.
5. A valid canonical-origin request with the current token succeeds. Restart invalidates the old token, a fresh same-origin bootstrap obtains a new token, and persisted settings remain intact.

## Success Criteria *(mandatory)*

Primary measurable outcomes: **SC-012** and **SC-014**. The Phase 1 checkpoint additionally requires restart persistence, exact-authority and request-forgery refusal tests, and secret-isolation evidence defined by the master tasks and checklists.

### Staged requirement closure

Slice 002 owns the shared mechanism or first visible surface for the following global requirements, but does not claim evidence that can exist only after later subsystems are delivered:

| Requirement | Phase 1 acceptance owned by 002 | Remaining completion evidence |
| ----------- | ------------------------------- | ----------------------------- |
| FR-097 | Startup and operator-triggered scans detect missing files and checksum mismatches for every indexed asset, report affected asset IDs/reasons in health, and never mutate or regenerate. | Periodic cadence plus per-asset regeneration-offer routing after artifact owners exist; completed by T-P10-02 against EC-C07/IM-20. |
| FR-130 | The data root and all foundation-created directories/files use the centralized 0700/0600 path and pass permission tests. | T-P10-03 audits files introduced by every later subsystem through the same service. |
| FR-131 | The centralized logger redacts secret canaries and image bytes, and its unit/integration corpus is clean. | Provider/export callers add their fixtures in 005/010; T-P10-03 scans the complete noisy-run corpus. |
| FR-132 | The foundation has no analytics dependency or telemetry path, and a baseline network-capture test observes no egress. | T-P10-03 repeats the capture after provider adapters exist and permits only the explicitly selected provider call under test—not analytics. |
| FR-133 | The first-run Arabic warning states that Hekayati has no automatic backup and that export is not a backup. | Feature 010 repeats the warning in the export screen and verifies it in T-P9-01/T-P9-06. |
| FR-135 | The canonical risk register contains the required pre-launch legal-review blocker and product copy makes no compliance claim. | T-P10-08 records scheduling/sign-off before commercial launch; it does not block local implementation. |
| FR-137 | Validated, restart-persistent settings infrastructure and Arabic screen for foundation-safe fields: provider/model selections as configuration, concurrency, typography minimums, watermark, disk threshold, and read-only storage paths; no secret field is persisted. | Gemini/Codex lifecycle, live capability state, and economy warnings in 005/T-P4-08; printer-profile management in 009/T-P8-01. |
| FR-138 | Health framework and Arabic screen report DB, disk threshold, foundation integrity summary, effective bind address, and explicit `not_configured`/`not_available` states for components not delivered yet. | Provider auth/availability in 005/T-P4-08; queue depth in 006/T-P5-07; full integrated health acceptance after those slices. |

The Phase 1 checkpoint records only the 002-column evidence above; it cannot close any listed later-integration evidence early.

## Required bible artifacts

- [Integrated plan technical context](../001-hekayati-product-bible/plan.md)
- [Research R1, R2, R4, R8, and R13](../001-hekayati-product-bible/research.md)
- [Product context](../../PRODUCT.md), [design system](../../DESIGN.md), and [canonical Citrus Playground kit](../../brand-kits/02-citrus-playground.html)
- [Data model: assets and settings](../001-hekayati-product-bible/data-model.md)
- [Privacy/security and UX checklists](../001-hekayati-product-bible/checklists/privacy-security.md)
- [Global test strategy](../001-hekayati-product-bible/test-strategy.md)
- [Edge-case catalog](../001-hekayati-product-bible/edge-case-catalog.md) and [risk register](../001-hekayati-product-bible/risk-register.md)

## Delivery mapping

Master tasks: **T-P1-01–T-P1-11**. Cross-slice closure tasks for global requirements are listed in the staged table above. Phase checkpoint and definition of done remain canonical in [tasks.md](../001-hekayati-product-bible/tasks.md).

Spec approval requires owned IDs, interfaces, and evidence routing to be accepted; it does not authorize implementation until the complete graph is approved.

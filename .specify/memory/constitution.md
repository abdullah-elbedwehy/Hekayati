# Hekayati Constitution

Binding principles for the Hekayati (حكايتي) personalized children's book production system. Every specification, plan, task, and line of code MUST comply. Conflicts are resolved in favor of this document; amendments follow the Governance section.

## Core Principles

### I. Specification Is the Source of Truth

The approved Spec Kit artifacts in `specs/` define the product. Code that contradicts the spec is a defect even if it "works." Behavior changes require spec changes first. Undocumented behavior is unspecified behavior and may not be relied upon.

### II. Simplicity First (KISS / YAGNI)

Prefer the simplest design that reliably satisfies **current** requirements. No speculative enterprise features: no multi-tenancy, no user management beyond the single operator, no microservices, no message brokers, no cloud dependencies. A new abstraction must be justified by a present, concrete need recorded in the plan. Exception: the provider boundary, job scheduler, asset store, and document production pipeline keep clean seams even in v1, because provider churn and print requirements are known, present risks — not speculation.

### III. Local-First and Child-Image Privacy (NON-NEGOTIABLE)

- All services bind to loopback (`127.0.0.1`) only. The app MUST verify its bind address at startup and refuse to start otherwise.
- Photos of children, derived assets, and customer data persist only on the local machine.
- The only data that may leave the machine is the minimum payload required by the operator-selected AI provider for a specific generation call.
- Photo consent status MUST be recorded per customer before their photos are used in any provider call.
- Permanent deletion MUST delete dependent media and be verifiable.
- No telemetry, no analytics, no crash reporting to external services.

### IV. Human Review at Creative Gates

AI never ships directly to a customer. Mandatory human gates: character sheet review, per-page illustration review, full-book preview review, print-file preflight review. The operator records customer approvals manually. Approval is versioned: it applies to a specific artifact version, never to "the latest."

### V. AI Output Is Untrusted Input

Every provider response — text, structured data, or image — is validated against a canonical schema or acceptance rule before it touches product state. Malformed, partial, unsafe, or out-of-contract output becomes a normalized failure, never a stored artifact. Validation failures are visible to the operator with the concrete reason.

### VI. Provider Independence

Core domain logic (projects, characters, stories, scenes, pages, jobs, versions, approvals, assets, PDFs) MUST NOT contain provider-specific types, prompts, error strings, or model names. Providers implement a canonical capability contract; prompt compilation and error normalization live in provider adapters. "Same behavior" means workflow parity and normalized outputs, not pixel-identical results.

### VII. No Silent Degradation (NON-NEGOTIABLE)

The system MUST NEVER silently: switch providers, substitute models, downgrade quality settings, regenerate approved content, shrink text below readable minimums, drop characters from scenes, or discard work. Every such transition requires an explicit operator decision presented with its consequences.

### VIII. Durable, Observable, Idempotent Work

Long-running generation is resumable after app restart, worker crash, machine restart, and network loss. Jobs carry idempotency keys; retries never duplicate completed artifacts; stale leases cannot overwrite newer versions; canceled jobs cannot commit results. Progress, queue position, blocking reasons, and failure causes are always visible to the operator.

### IX. Versioned, Recoverable Content

Stories, scenes, pages, character profiles, looks, prompts, and generated assets are versioned. Regeneration creates a new version; prior versions remain recoverable until explicit permanent deletion. Approvals bind to versions.

### X. Explicit Invalidation

Upstream changes invalidate downstream artifacts only through the documented invalidation matrix. Invalidation marks artifacts stale and shows the operator scope and regeneration options; it never auto-regenerates. Locked pages are exempt from side effects: a locked page changes only when the operator unlocks and edits it directly.

### XI. Behavior-Focused Testing

Tests specify externally observable behavior (API responses, persisted state, produced files, UI-visible state), not implementation internals. Failure-injection tests (crash, restart, disk-full, provider timeout, malformed output) are first-class. Target: 80%+ coverage on domain, scheduler, provider-adapter, and PDF-pipeline code.

### XII. Researched, Recorded Technical Choices

Every load-bearing technology choice is supported by a focused research entry comparing realistic alternatives with recorded reasoning (`research.md`). Capabilities are never assumed because they are desirable — feasibility gates (notably Codex subscription image generation) must pass before dependent work is planned as available.

### XIII. Arabic, Accessibility, and Print Quality Are Requirements

Correct Arabic shaping, RTL layout, embedded fonts, readable minimum text sizes, contrast, safe margins, bleed, and printer-parameterized cover geometry (including spine width — never guessed) are acceptance criteria, not polish. Preview PDFs are watermarked; print PDFs are watermark-free and preflighted.

### XIV. Credential Isolation (NON-NEGOTIABLE)

Secrets (Gemini API key, Codex authentication material) live only in macOS Keychain or the provider's own local auth store. They MUST NOT appear in: the database, exports, logs, error messages, screenshots/UI (beyond masked display), or crash output. Log redaction is tested.

### XV. Independently Verifiable Phases

Every development phase ends with a demonstrable, testable outcome with explicit preconditions, acceptance checkpoint, and definition of done. No phase begins while a blocking feasibility gate of a prior phase is unresolved.

## Operational Constraints

- Platform: macOS, one machine, one operator, browser-based desktop UI (RTL, simple Modern Standard Arabic).
- Generated story language: natural, age-appropriate Egyptian Arabic; dignity-preserving, no shaming, no preaching.
- Persistence: local document-oriented (NoSQL-style) data model; large media stored outside the document store when justified; all state survives restarts.
- No authentication screen, customer portal, payments, invoicing, shipping, WhatsApp integration, or automatic backups in v1. Manual export/import is the only portability mechanism, and the UI must warn it is not an automatic backup.
- Docker is permitted only where it demonstrably simplifies reliable local installation without harming Codex auth, Keychain access, file access, or startup reliability.

## Development Workflow

- Spec Kit stages in order: constitution → specify → clarify → plan → checklist → tasks → analyze → implement. Implementation starts only after explicit user approval of the artifact set.
- TDD during implementation: failing test → minimal implementation → refactor.
- Code review before merge; security review for credential, upload, export/import, and provider-boundary code.
- Conventional commits (`<type>: <description>`); commit/push only on user request.
- File size ≤800 lines; functions ≤50 lines; organize by feature/domain.

## Governance

This constitution supersedes all other practices in this repository. Amendments require: a documented rationale, an entry in the amendment history, and propagation of impacts to affected spec artifacts. Every PR/review verifies compliance; violations block merge. Complexity beyond these rules must be justified in the plan's Complexity Tracking table.

**Version**: 1.0.0 | **Ratified**: 2026-07-14 | **Last Amended**: 2026-07-14

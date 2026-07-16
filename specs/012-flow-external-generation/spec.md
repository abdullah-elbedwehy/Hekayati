# Feature Specification: Flow Mode — External Prompt Pack & Image Import

**Feature ID**: `012-flow-external-generation`
**Status**: Proposed amendment — requires spec-graph re-approval before its readiness pipeline
**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

This document is an ownership and acceptance slice. Canonical requirement wording and shared rules remain in the bible. On conflict: constitution → bible → this slice.

## Outcome

The operator produces a complete personalized book with **zero image-provider API cost** by selecting the External image provider: the app compiles an ordered, copyable Prompt Pack (character consistency blocks + per-page prompts) for Google Labs Flow, the operator generates the images there on their own subscription, and the app imports, validates, and version-commits the files into the unchanged review → layout → preview → approval → print pipeline.

## Requirements _(mandatory)_

Primary requirement ownership: **FR-149–159**.

Primary user journey: **US12**. Primary clarification: **C-22**. Example workflow: **E9**.

Owned capability boundaries:

- `external_manual` image-provider entry with FR-095 switch semantics and explicit switch-away confirmation (FR-149, FR-159).
- Versioned, append-only PromptPack compilation: character setup blocks (Flow character-builder ready), ordered page prompts, global style/no-text rules; per-block copy and single-file Markdown export (FR-150).
- Pack privacy invariant: the pack file embeds no image bytes, contact data, or secrets; per-character reference bundles (privacy-clean photo working copies and/or sheet renders) export only behind the FR-004 consent gate, an explicit operator action, an upload warning, and a logged record — `originals/` bytes never (FR-151).
- Version pinning, checksums, and stale marking driven by the invalidation matrix (FR-152).
- Durable `waiting_external_import` scheduler state for `character_sheet_view` and `page_illustration` jobs (FR-153).
- Untrusted-file import: magic-byte sniffing, size cap, decode validation, metadata stripping, atomic content-addressed writes (FR-154).
- Mapping UI and versioned commit with stale/locked rejection and partial-import persistence (FR-155).
- Import-time effective-DPI and aspect-tolerance warnings — never auto-crop/upscale (FR-156).
- `external_manual` provenance with tool label, pack/prompt checksums, filenames, timestamps (FR-157).

This feature reuses rather than redefines FR-004 (consent), FR-064/065 (locks, commit precondition), FR-071/073 (content rules), FR-092/093/094 (taxonomy, atomic writes, provenance), FR-095 (switching), FR-114 (pipeline chain), FR-115–119 (safety + review), FR-123/124 (preflight, watermark), and the invalidation matrix. It does not own page lineage, review UI, layout, preview, print, or deletion; imported assets are ordinary Assets covered by features 008–010.

## Explicit boundaries

- No Google Labs API calls, browser automation, scraping, or embedded webview; no Google credentials touch the app (C-22, bible out-of-scope list).
- The app itself sends nothing anywhere; identity references reach Flow only as consent-gated, logged, metadata-stripped reference bundles that the operator uploads — the same working-copy payload the API path would transmit, with the operator as transport. Exact `originals/` bytes are never exportable (FR-151, EC-I16).
- Single Image Studio (feature 011) is excluded from External mode in v1 (FR-158).
- Imported bytes are untrusted input until validated (Constitution: AI output untrusted; same posture for operator-imported media).

## Dependencies and interfaces

- Depends on feature 004 for story/scene/page-prompt versions the pack pins.
- Depends on feature 005 for the provider registry the `external_manual` entry joins and provenance rules.
- Depends on feature 006 for durable jobs, the new waiting state, and queue visibility (FR-111).
- Depends on feature 007 for page illustration lineage, commit protocol, locks, review checklist, and safety rules.
- Features 008/009 consume imported illustrations with no behavioral change; FR-123 preflight remains the hard print gate for low-DPI imports.
- Feature 010 export/import and permanent deletion include PromptPacks and imported assets.

## User Scenarios & Testing _(mandatory)_

Canonical story and seven acceptance scenarios: **US12** in the [product bible](../001-hekayati-product-bible/spec.md). Normative walkthrough: **E9**.

Independent acceptance: with mock text provider and External image provider, run story → prompts, export the pack (assert character blocks, ordered prompts, zero embedded image bytes/secrets), export one consented reference bundle (assert working copies + log entry, no `originals/` bytes) and one blocked no-consent bundle, import a full fixture set with mapping, then exercise every rejection: stale import after a scene edit, locked-page import, corrupt file, duplicate import (appends version), and low-DPI warning surviving to preflight. Verify partial import persists across restart and that downstream review/layout/preview/approval/print fixtures behave identically to API-generated ones.

## Success Criteria _(mandatory)_

Primary measurable outcome: **SC-015**. EC-I01–I16 provide rejection, privacy, and staleness evidence; SC-010/SC-011 continue to hold over imported versions.

## Required bible artifacts

- [Flow-mode requirements §3.25, US12, C-22, E9](../001-hekayati-product-bible/spec.md)
- [Prompt-pack staleness note in the invalidation matrix](../001-hekayati-product-bible/invalidation-matrix.md)
- [Edge cases EC-I01–I16](../001-hekayati-product-bible/edge-case-catalog.md)
- [External manual mode section of the capability matrix](../001-hekayati-product-bible/provider-capability-matrix.md)
- [Job scheduler contract — waiting states](../001-hekayati-product-bible/contracts/job-scheduler-contract.md)

## Delivery mapping

Master tasks: **T-P6-13–T-P6-15** (Phase 6 slice). The Phase 6 checkpoint and definition of done in [tasks.md](../001-hekayati-product-bible/tasks.md) include the Flow-mode path and SC-015.

Spec approval requires the amended bible IDs (FR-149–159, US12, SC-015, C-22, E9, EC-I01–I16) to be accepted into the approved graph; it does not authorize implementation until this slice passes its own readiness pipeline and analyze gate.

# UX & Arabic RTL Checklist: Hekayati

**Purpose**: Verify the operator experience: Arabic UI, RTL correctness, observability, and error clarity.
**Created**: 2026-07-14 | **Feature**: [spec.md](../spec.md), Constitution XIII

## Language & Direction

- [ ] CHK401 All UI strings in simple Modern Standard Arabic; no untranslated leaks (string-audit)
- [ ] CHK402 Document direction RTL globally; logical CSS properties (start/end) only — no left/right hardcoding
- [ ] CHK403 Mixed-direction content correct: Latin model IDs, numbers, file paths inside RTL layouts (bidi isolation)
- [ ] CHK404 Numerals policy consistent (Western digits throughout v1) — no mixed numeral styles per screen
- [ ] CHK405 Date/time in Arabic locale format

## Editor & Mentions

- [ ] CHK406 @ picker: thumbnail + name + relationship + role; keyboard navigable; duplicate-name disambiguation (FR-036)
- [ ] CHK407 Mention tokens visually distinct; partial-delete degrades to flagged plain text (FR-040)
- [ ] CHK408 Diacritic-insensitive mention search (C-11)
- [ ] CHK409 Scene property editing (action/emotion/look/dialogue) discoverable from the mention (FR-037)

## Observability & Trust

- [ ] CHK410 Queue view answers "why is this waiting?" for every non-running job (blocking reason verbatim) (FR-111)
- [ ] CHK411 Progress, attempts, and provenance visible per job/page (FR-094)
- [ ] CHK412 Quota decision dialog presents exactly wait-vs-continue with consequences (FR-096)
- [ ] CHK413 Affected-items view on invalidation: what, why (matrix row), per-item actions (FR-033, IM mechanics)
- [ ] CHK414 Health screen: DB, disk, integrity, providers, bind address (FR-138)
- [ ] CHK415 Capability warnings persistent where specified (economy model, Codex image unavailability) (FR-102/108)

## Error Clarity & Safety UX

- [ ] CHK416 Every normalized failure category has operator-actionable Arabic copy (no raw stack traces)
- [ ] CHK417 Destructive flows (delete, replace-import, unlock) require explicit confirmation with scope preview (FR-005/127)
- [ ] CHK418 No-backup + export≠backup warnings present and honest (FR-133)
- [ ] CHK419 Review checklist UI per page covers all FR-118 items; consistency view usable (FR-119)
- [ ] CHK425 Single Image tab («توليد صورة») reachable from main nav without opening a project; generate/history/download usable in Arabic RTL (FR-140/144, US11)

## Accessibility & Layout

- [ ] CHK420 Keyboard navigation through the full journey; visible focus states
- [ ] CHK421 Contrast ≥ WCAG AA for text and essential UI
- [ ] CHK422 1440×900 minimum: no horizontal scroll, no clipped controls (SC-012); larger sizes scale sanely
- [ ] CHK423 Reduced-motion preference respected for progress animations
- [ ] CHK424 Long Arabic names/titles truncate with tooltips, never break layout (FR-083 analog in UI)

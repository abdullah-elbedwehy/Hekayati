# Implementation Notes: 004 Story Authoring and Templates

**Status**: Checkpoint PASS — 2026-07-14
**Scope**: Master tasks T-P3-01–T-P3-09
**Evidence**: [1440×900 workspace](../../output/playwright/004-authoring-workspace.png) · [390×844 mobile](../../output/playwright/004-authoring-mobile.png)

## Delivered authoring workspace

- Family-scoped projects with immutable `ProjectVersion` snapshots, expected-head conflict checks, stable status/page configuration, pinned character and look versions, deterministic narration/dialogue balance, and restart-safe manual Story/Scene lineage.
- Atomic project-only appearance overrides that append an override version and project version together, emit one IM-04 change event, and leave shared character/look documents byte-identical.
- Strict ordered text/mention/group/unresolved scene segments. Arabic mention search is NFC- and tashkeel-insensitive; duplicate visible names remain separate identities; current names render after rename while compilation retains project-pinned versions.
- Provider-neutral compile with deterministic hero/friends/family groups, unresolved and empty-group blocks, selected-versus-mentioned reconciliation, injected verified-capacity acknowledgement, look ownership validation, and character replace/remove/cancel helpers. No provider SDK or request is present in this slice.
- Canonical 16/24-page interior maps with editable title, dedication, farewell, and brand copy; complete author-owned scene fields; and SHA-256/head-pinned expansion and shortening preflights that make no change before confirmation.
- Seven validated Arabic seed templates installed atomically and idempotently. Existing edited, disabled, or archived seed identities are never overwritten. Template create/edit/duplicate/disable/archive/restore operations preserve immutable pinned versions and do not mutate stories.
- Fail-closed template extraction from completed stories, with recursive forbidden-key/source-marker scans; same-family story copying preserves valid pins without changing the source, while cross-family copying produces structure-only role slots and blocks readiness until required roles are mapped.
- Arabic RTL Citrus Playground project workspace for creation, pinned roles/looks, configuration versioning, project-only overrides, page navigation/preflight, scene authoring and mention properties, template management, extraction, and explicit incomplete/complete states.
- Local Fastify API and startup wiring behind the existing loopback/origin/CSRF boundary. Responses expose safe authoring DTOs only; secrets, original/provider asset IDs, and authoritative display names are not persisted in mentions or templates.

## Verification record

| Command / check | Result |
| --- | --- |
| `npm run check` | PASS; lint, 135-file size guard, 9-file font hash guard, typecheck, 23 test files / 164 tests |
| `npm run coverage` | PASS; 89.94% statements, 81.49% branches, 95.31% functions, 92.25% lines; authoring domain 82.12% branches |
| `npm run format:check` | PASS; all source, test, script, and configuration files match Prettier |
| `npm run build` | PASS; production Vite UI and server TypeScript build with local fonts |
| `npm run test:e2e` | PASS; 6/6 Playwright journeys, including the complete 004 provider-free lifecycle |
| `npm audit --audit-level=high` | PASS; 0 vulnerabilities |
| Clean lockfile install under Node 22 | PASS; 333 packages installed in an empty temporary root, `npm ls --all` exited cleanly, 0 vulnerabilities |
| `git diff --check` and staged-content audit | PASS; recorded at checkpoint packaging; synthetic Arabic identities only and no provider call, credential, runtime token, or child image |

The 004 Playwright journey creates two synthetic families and two visually duplicate أحمد identities, pins a reusable look, edits the project configuration, authors and completes all 12 story scenes, renames one participant to علي, and proves the identity-bound mention renders the new name. It exercises an unresolved pasted token, mention properties, family and empty-friends groups, a stale project-only override followed by an isolated successful override, template disable/restore/duplicate/create/edit/extract, and exact 16→24→16 preflight behavior with no pre-confirm mutation.

The same journey proves story completion, source-story immutability, same-family duplication, cross-family identity stripping and required-role remapping, then performs a real `SIGKILL` and restart on the same data root. Browser capture observed zero non-loopback requests. Axe reported no serious WCAG A/AA violations on the populated workspace, and the 390×844, 1440×900, and 1920×1080 layouts fit without horizontal clipping. The evidence PNGs contain only synthetic data; their SHA-256 values are `37318d7bfd1fede492b490a092161ed9c39a2468359cfa1cde2a32e1f0ecf559` (mobile) and `fbfb1a46e9e3b4e29bb0a4b41856f81f8255d105b37c3470b3f5041a5aa8051b` (workspace).

## Requirement closure

| Task / boundary | Evidence complete in 004 | Required later recheck |
| --- | --- | --- |
| T-P3-01–02, IM-16 | Immutable lifecycle, exact selection status, seven stable seed keys, atomic idempotence, and non-overwrite behavior | 010 preserves versions through export/import |
| T-P3-03, IM-04 | Immutable family-scoped configuration, pinned participants, balance override, stale-head rejection, and atomic project-only appearance isolation | 007 consumes the invalidation event without changing approved content |
| T-P3-04–06 | Identity-bound mentions, Arabic search, properties, groups, unresolved/reconciliation/capacity/look blocks, and removal transforms | 005 supplies verified live capability values; 007 consumes the exact compiled set |
| T-P3-07, CHK211 | Completed-story extraction, fail-closed identity scan, same-family copy, and cross-family role remap | 010 repeats privacy invariants across archives |
| T-P3-08 | Provider-free full journey, restart, responsive/axe evidence, and zero browser egress | Phase 10 repeats the integrated first-book path |
| T-P3-09 | Exact 16/24 maps, guarded bidirectional preflight, manual scene completeness, and editable fixed-page copy | 008 renders the map; 009 adds printer-only structure without changing it |

## Deliberately deferred

- No provider credential, model lookup, prompt compilation, generation, durable job, image, approval, Arabic PDF, printer output, export/import, permanent deletion, or Studio workflow is implemented by 004.
- Real Gemini G2/G4 measurements remain environment-blocked from Phase 0. The verified-capability union fails closed for unavailable real models; the explicit provider-free mock used here never becomes a silent runtime fallback.
- Story and scene records contain the author-owned fields and empty downstream lineage only. Later slices must append generation/provenance/review/layout artifacts rather than reinterpret or overwrite these immutable versions.

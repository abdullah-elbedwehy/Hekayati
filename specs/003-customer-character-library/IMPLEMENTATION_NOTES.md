# Implementation Notes: 003 Customer and Character Library

**Status**: Checkpoint PASS — 2026-07-14
**Scope**: Master tasks T-P2-01–T-P2-06, T-P2-10, and T-P2-12

## Delivered library

- Restart-safe customer, consent, family, character, pet, look, reference-photo, and change-event records. Routine removal is reversible archive/restore only; no permanent-delete path was added.
- Assign-once family anchors, one structural family-scope policy for queries and direct-ID mutations, exact family-local duplicate preflight, and explicit open-existing/create-separate decisions.
- Insert-only character and look versions with expected-head compare-and-swap, append-based recovery, atomic current-head/outbox updates, and IM-01–03/05/21 classification.
- Shared consent/enqueue eligibility and provider-reference resolution boundaries. Only an explicitly pinned clean derivative can resolve; adapters, jobs, and real provider dispatch remain later-slice work.
- Settings schema v2 upload limits and streaming HEIC/JPEG/PNG intake with content sniffing, decode/pixel/byte bounds, `sips` HEIC conversion, orientation handling, newly encoded metadata-clean working/thumbnail/subject-crop derivatives, and a separate provider-ineligible exact-original store.
- Opaque runtime reservations with atomic new-photo-character or existing character/look attachment, cleanup on cancel/expiry/failure/restart, duplicate recheck, and safe browser projections that expose thumbnails but no original/working/provider asset identifiers.
- Versioned explainable photo QA with deterministic metrics/thresholds and explicit operator observations. Face and multi-person references require an interacted subject rectangle; multi-person intake requires intended-person confirmation, and a full-frame or rounding-to-full-frame selection is rejected.
- Arabic RTL Citrus library UI for all owned workflows, including consent states/codes, family rename, anchored members, pets, duplicate choices, description/photo modes, versions, looks, archive/restore, photo checklist/warnings, keyboard crop controls, safe thumbnails, and stale-session/restart recovery.
- Read-only deletion inventory with every library record/version/event plus per-photo media mappings and shared-asset reference counts. Feature 010 remains the sole owner of destructive cascades.

## Verification record

| Command / check | Result |
| --- | --- |
| `npm run check` | PASS; lint, 105-file size guard, 9-file font hash guard, typecheck, 18 test files / 129 tests |
| `npm run coverage` | PASS; 88.77% statements, 81.20% branches, 93.52% functions, 91.22% lines |
| `npm run build` | PASS; production Vite bundle and local server TypeScript build |
| `npm run test:e2e` | PASS; 5/5 Playwright journeys, including the complete 003 provider-free journey |
| `npm audit --audit-level=low` | PASS; 0 vulnerabilities |
| Isolated lockfile install under Node 22 | PASS; 333 packages, production build, and 2 native photo/library suites / 8 tests |
| `git diff --check` and file/fixture audit | PASS; no committed synthetic image, real child asset, credential, runtime token, or external URL path |

The 003 Playwright journey uses a generated synthetic illustration in an isolated temporary directory. It records absent/refused/granted consent, creates and renames an anchored family, creates description/photo/pet characters and two looks, exercises both duplicate outcomes, immutable-version append, archive/restore, and a direct cross-family bypass. Photo evidence includes operator warnings, keyboard selection, explicit multi-person confirmation, a rejected full-frame crop, derived-only browser data, and exact post-commit counts of one private original plus three clean derivatives.

The same journey cancels one staged intake, leaves another staged during a real `SIGKILL`, restarts on the same data root, observes the stale unsafe mutation, proves the old runtime reservation is gone, and verifies that committed records, versions, warnings, thumbnail route, private/derived file counts, and active statuses survived. Browser request capture observed zero non-loopback requests. Axe reported no WCAG A/AA violations on the populated library, visible keyboard focus passed, Western digits remained consistent, and 390×844, 1440×900, and 1920×1080 layouts fit without horizontal clipping.

Ordinary E2E runs no longer overwrite the historical 002 screenshot. It is regenerated only when `HEKAYATI_UPDATE_EVIDENCE=1` is set explicitly.

## Staged checklist closure

| Checklist / boundary | Evidence complete in 003 | Required later recheck |
| --- | --- | --- |
| CHK001–005, CHK216, CHK227 | Provider-free lifecycle, family isolation, consent states, photo conversion/privacy, warnings/crop, hostile input, atomicity, cancellation, and restart evidence | Machine-wide final journey repeats in Phase 10; permanent deletion remains 010 |
| CHK006 | Closed three-intent UI/domain union; update-base and new-look work, project-only is honestly disabled | 004 stores/enables project-only overrides and emits IM-04 |
| CHK206 | Current consent and exact absent/refused enqueue policy | 007/011 producers call it; 006 repeats it immediately before dispatch |
| CHK208 | Originals are structurally provider-ineligible; clean pinned derivatives resolve | 005/007 payload snapshots prove only resolved bytes reach adapters |
| CHK210 | Query and direct-ID family bypass tests plus E2E hostile request | 004 project picker and 011 Studio picker repeat the invariant |
| CHK220 | Upload-handling security review and hostile corpus complete | Provider/export reviews remain 005/010; integrated review remains Phase 10 |
| CHK401–405, CHK420–424, CHK427 | Populated 003 UI Arabic/RTL/bidi/digits/date, axe, keyboard, focus, target, truncation, and responsive evidence | Every later screen must independently retain the shared rules |

## Deliberately deferred

- No AI adapter, credential, provider request, durable job, project/story, character sheet, approval, generated illustration, PDF, print, export/import, permanent deletion, or Studio workflow is implemented by 003.
- Photo consent is enforced locally at the shared eligibility boundary here. The producing slices and centralized scheduler must still perform their owned enqueue/pre-dispatch rechecks without silent fallback.
- Real Gemini G2/G4 account measurements remain environment-blocked as recorded in Phase 0; this provider-free checkpoint required and made zero external request.

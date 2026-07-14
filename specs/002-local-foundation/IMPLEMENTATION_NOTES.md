# Implementation Notes: 002 Local Foundation

**Status**: Checkpoint PASS — 2026-07-14
**Scope**: Master tasks T-P1-01–T-P1-11
**Evidence screenshot**: [`evidence/002-shell-1440x900.png`](evidence/002-shell-1440x900.png)

## Delivered foundation

- One Node/TypeScript process with Fastify, Vite/React, Vitest, Playwright, strict linting, provider-boundary import rules, and an enforced 800-line file limit.
- Arabic RTL Citrus Playground shell with locally bundled and hash-pinned Lemonada, Source Sans 3, and IBM Plex Sans Arabic fonts; logical-direction CSS, Western digits, bidi isolation, explicit focus, responsive, and reduced-motion states.
- Embedded SQLite document repository with Zod validation, explicit version migrations, transactional rollback, WAL/FULL durability, and a retained OS-released exclusive database lock. A second process sharing the data root fails as `DATA_ROOT_IN_USE` before startup orphan recovery; graceful close, `SIGKILL`, and reboot release the lock through SQLite/OS semantics. A root-ownership marker refuses unowned non-empty or symlinked data paths before any chmod/write/GC action.
- Content-addressed asset store with temp-file sync, atomic rename, directory sync, private modes, canonical metadata-aware deduplication, reference counts, reserved-name-only orphan collection, and non-mutating integrity scans. Unknown files are never swept. Real child-process `SIGKILL` fixtures cover both temp-synced and renamed-before-DB crash windows.
- Strict asset provenance with actual provider/model/time, input-version refs, prompt version, reference IDs, attempt, and a versioned secret-free settings snapshot. Generated assets require provenance, stored reference photos require EXIF-stripped state, and same-byte metadata conflicts fail rather than lose traceability.
- Shared secret registry at every document and asset persistence boundary. It rejects known credential patterns and registered exact runtime secrets in values, free-form keys, and raw asset bytes before a DB/file write; the structured logger uses the same registry to redact values, keys, error names/messages, and binary payloads.
- macOS Keychain wrapper using `/usr/bin/security` without a shell: writes end argv at the prompting `-w` flag and send the secret through stdin. Fake-binary tests prove argv/error isolation, redactor registration, missing-binary normalization, account validation, and timeout kill behavior. No live Keychain item was created.
- Literal `127.0.0.1` listener plus independently verified effective address, exact authority/absolute-target checks, proxy distrust, exact source checks, no-store per-process CSRF bootstrap, token rotation, and fail-closed CORS/PNA behavior before body parsing or route dispatch.
- Restart-persistent validated settings, explicit deferred provider/printer states, actionable health diagnostics, startup/operator integrity reporting with asset IDs and reasons, a first-run no-backup/export-is-not-backup warning, and the Phase 3 seed-template installer hook (the seven real templates are intentionally not part of 002).

## Verification record

| Command / check | Result |
| --- | --- |
| Isolated-home, dependency-clean `npm ci` + `npm run build` copy | PASS; 315 packages, clean production build, 0 vulnerabilities |
| `npm run check` | PASS; lint, 44-file size guard, 9-file font hash guard, typecheck, 7 test files / 64 tests |
| `npm run coverage` | PASS; 93.56% statements, 84.01% branches, 97.77% functions, 96.44% lines |
| `npm run build` | PASS; production UI/server bundle built with all fonts local |
| `npm run test:e2e` | PASS; 4/4 Playwright journeys |
| `npm audit --audit-level=low` | PASS; 0 vulnerabilities |
| Manual local smoke | `/` 200, `/api/health` 200, `Host: localhost` 421, forged unsafe request 403, concurrent same-data-root launch refused, ownership marker 0600 |

The E2E suite proves Arabic `dir=rtl`, persisted settings, first-run failure/retry/persistence, no browser egress, axe checks through WCAG 2.2 AA tags, 390×844 and 1920×1080 fit, visible keyboard focus, reduced motion, real affected-asset health copy, and a true process `SIGKILL`/restart with stale-tab refusal, fresh bootstrap, and preserved state. Playwright tracing is disabled so failure artifacts cannot persist the runtime CSRF token. The committed baseline screenshot is exactly 1440×900.

The clean-install check used a dependency-empty repository copy with isolated `HOME` and data roots on the development Mac. It did not create a separate macOS user account. The network baseline is browser request capture plus dependency/source audit, not an OS-wide packet capture; Phase 10 repeats the complete integrated egress audit after provider adapters exist.

## Staged requirement closure

| Requirement | 002 evidence complete here | Still owned later |
| --- | --- | --- |
| FR-097 | Startup and operator scans report every indexed missing/checksum-mismatched asset with ID/reason and do not mutate it. | Periodic cadence and artifact-owner regeneration offers in T-P10-02. |
| FR-130 | Every foundation-created directory/file is recursively audited at 0700/0600. | T-P10-03 repeats after all subsystems add files. |
| FR-131 | Shared logger/registry and noisy file corpus cover exact/known secrets, free-form keys, errors, and image bytes. | Provider/export callers add fixtures in 005/010; T-P10-03 scans the complete corpus. |
| FR-132 | No analytics dependency/path; browser baseline observes no external request. | T-P10-03 performs the final integrated capture with only the selected provider call permitted. |
| FR-133 | First-run Arabic warning says no automatic backup and export is not a backup. | Export screen repeats it in 010/T-P9-01/T-P9-06. |
| FR-135 | No compliance claim is made and the legal-review risk remains recorded. | T-P10-08 records pre-commercial scheduling/sign-off. |
| FR-137 | Validated settings infrastructure and all foundation-safe fields are persistent; secrets are rejected. | Provider lifecycle in 005 and printer profiles in 009. |
| FR-138 | DB/disk/integrity/bind diagnostics and honest deferred cells are visible. | Provider health in 005, queue depth in 006, final integrated acceptance. |

SC-012 is evidenced here as the foundation shell baseline; the complete product journey remains Phase 10. SC-014 is fully exercised for this slice and remains a mandatory regression through Phase 10.

## Deliberately deferred

- No real provider credential, provider call, queue, printer profile, export/archive, or customer data is part of 002.
- Gemini G2/G4 live account measurements remain environment-blocked as recorded in Phase 0; they do not block 003–004 or mock-provider work.
- The Impeccable and frontend-design guidance shaped the restrained Citrus surface, local font use, RTL/logical layout, explicit degraded/deferred states, and accessibility/responsive evidence. It did not expand the slice into later product workflows.

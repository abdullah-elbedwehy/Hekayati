# 009 Implementation Notes — Print Production

**Evidence date**: 2026-07-16

**Checkpoint**: PASS — 009-C01–009-C44 closed with CHK317/318 retained as pending pre-commercial gates

**Scope**: `T-P8-01`–`T-P8-07`

**Canonical coverage**: FR-057, FR-086–FR-087, FR-120–FR-124; SC-006–SC-010; US7; IM-01/03–15 and IM-18–IM-20; CHK301–CHK318; 009-C01–009-C44

## Delivered behavior

- Added revisioned `PrinterProfile` heads and immutable profile versions with strict A4/RGB defaults, explicit readiness, exact profile hashes, bounded blank/crop/spine geometry, and owner/revision-checked project assignment. Incompatible composition geometry returns bounded failed predicates, changes no project/profile/print state, emits no IM-14, and is surfaced as an explicit Slice 008 composition-migration/re-approval action.
- Added hostile ICC and cover-template import boundaries. Accepted inputs are mechanically parsed, privately content-addressed, checksum-pinned, and represented only by indexed IDs and bounded facts; malformed, wrong-channel, active-content, oversized, path-like, or secret-bearing inputs leave no durable reference.
- Added pure interior and RTL cover geometry plus exact compilers. Interior output consumes the approved page/layout/text/review/source snapshot and adds only declared printer blanks and geometry. Cover output maps the approved back/spine/front content without inventing customer-visible copy or art. No renderer upscales, silently reflows, substitutes a source, or introduces a watermark/footer.
- Added separate durable interior, cover, and preflight jobs with materialization, pre-execution, and scheduler-owned commit fences. Files use prepare, validation, atomic rename, and one database commit; stale/canceled/duplicate/failed work cannot advance an artifact or deliverable head.
- Added the RGB direct path and exact-ICC CMYK conversion path. Ghostscript is invoked argument-safely and fail-closed; converted output is mechanically checked before promotion. CMYK stays non-deliverable behind an exact proof bundle and human gate, while RGB requires no conversion gate.
- Added the closed `hekayati.print-preflight.v1` registry with 32 blocking codes and bounded artifact/page/expected/actual evidence. Reports pin actual geometry, page/blank maps, fonts, PPI, color/output-intent, watermark, checksums, authorization/profile hashes, and policy/tool facts without persisting raw customer bytes, text, paths, ICC content, or command output.
- Added the print invalidation participant and exact IM behavior: customer-visible rows stale applicable current print projections without rewriting history; compatible IM-14 invalidates both print families while preserving approval; IM-15 preserves/reuses an exact interior; IM-18/19 are print no-ops; referenced IM-20 blocks and byte-identical repair restores the same lineage.
- Added scoped `no-store` profile, production, proof, and download APIs plus the Arabic RTL Citrus Playground print workspace. Final downloads recheck exact current run/report/proof/profile/authorization/file integrity; candidate proofs remain visibly non-deliverable.

## Verification ledger

| Evidence target                                            | Result                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run test`                                             | PASS — 124 test files, 814 tests                                                                 |
| `npm run coverage`                                         | PASS — every Slice 009 ownership group exceeds the 80% statements/branches/functions/lines floor |
| `npm run test:e2e`                                         | PASS — 14/14 Playwright journeys in 2.3 minutes, including all three print journeys              |
| Core `tests/e2e/print.spec.ts` journeys                    | PASS — 2/2: RGB SIGKILL/recovery/final downloads and CMYK candidate-proof gating/release         |
| Targeted long-error/blocked-finding Playwright journey     | PASS — 1/1 at 390×844, 1440×900, and 1920×1080                                                   |
| `tests/failure-injection/print-restart.test.ts` matrix     | PASS — 6/6 real SIGKILL boundaries                                                               |
| `tests/integration/print-rendered-evidence.test.ts` matrix | PASS — Arabic/geometry/blank/crop/bleed/cover and RGB-versus-CMYK raster evidence                |
| Post-`npm ci` print/restart smoke                          | PASS — 5 files / 23 tests                                                                        |
| `npm ci` / format / lint / fonts / typecheck / build       | PASS — clean lock install, 484-file size guard, 9 font hashes, production Vite build             |
| `npm audit --omit=dev`                                     | PASS — 0 vulnerabilities                                                                         |
| Exact staged delivery scan                                 | PASS — 120 explicit files; no generated/runtime/customer/provider artifact or real secret/path   |

The test and coverage runners use one Vitest worker. This removes the resource-contention hang observed with two concurrent PDF/Chromium-heavy workers without weakening or skipping any test. Persisted quota/credential incident assertions now follow the exact durable target order instead of assuming randomized ULID order.

### Staged privacy and artifact scan

- The final index contains 120 explicitly staged Slice 009 files; `git diff --cached --check` passes and no blanket staging command was used.
- No staged filename is a PDF, raster, ICC/ICM, database, archive, log, temporary file, or other generated/runtime artifact. The local `output/**` trees remain unstaged.
- Added-line scans found no real machine-specific home directory, credential/private-key-shaped value, personal email/phone, external-generation implementation reference, or binary payload.
- `/Users/operator/...`, `file:///synthetic/...`, and `C:\\private\\...` occur only as deliberate hostile synthetic path canaries in negative tests. They contain no real machine/user data and are expected to be rejected by the product boundary.
- The staged set contains only synthetic books/assets/profile facts and makes zero provider or browser egress call in automated acceptance. Canonical/Flow/010/011 user documentation changes and all generated prototype/PDF output remain unstaged.

### Coverage

| Ownership group               | Statements | Branches | Functions |  Lines |
| ----------------------------- | ---------: | -------: | --------: | -----: |
| All source                    |     90.82% |   83.53% |    95.09% | 93.45% |
| `src/jobs/**`                 |     87.56% |   80.87% |    93.64% | 90.47% |
| `src/domain/print/**`         |     90.81% |   84.96% |    96.89% | 93.80% |
| `src/print/**`                |     93.73% |   88.65% |      100% | 97.84% |
| Slice-owned `src/pdf/print-*` |     92.71% |   86.58% |    93.56% | 95.40% |

### Profiles, imports, and compatibility

- Schema/boundary tests cover strict unknown-key rejection, finite bounded geometry, exact defaults/readiness, immutable successors, CAS conflicts, asset roles, ICC length/signature/color-space/checksum, template one-page/box/panel geometry, active-content rejection, and zero-state-change failures.
- Compatibility tables cover independent width/height tolerance, portrait/no-scale, safe-region containment, and printer-only settings. Compatible assignment preserves approval and emits IM-14 only when applicable. An incompatible assignment returns `COMPOSITION_PROFILE_MISMATCH` with the exact failed predicates and expected/actual geometry, preserves all heads and print collections byte-for-byte, emits no invalidation event, and the UI directs the operator to explicit composition migration and new approval.

### Preflight and mechanical PDF evidence

- The seeded defect table is exactly equal to all 32 `PRINT_PREFLIGHT_CODES`; every seed produces its named blocking finding. Clean RGB and CMYK bundles produce zero blocking findings. Registry removal, renaming, unknown policy, and lookalike-font shortcuts fail closed.
- The 16-page renderer/workflow path produces a separate watermark-free interior and one RTL cover spread. The 24-page rendered matrix produces 24 approved customer pages plus two declared printer blanks, in exact order, and one back-left/spine/front-right cover.
- Actual candidate PDFs are parsed for MediaBox/BleedBox/TrimBox, rotation, page count/map/blanks, embedded and subset Lemonada/IBM Plex Sans Arabic fonts, ToUnicode, Arabic glyph coverage, effective PPI, source/output hashes, prohibited features, external resources, and watermark absence. The clean reports pass with no finding.
- Raster evidence covers connected Arabic, lam-alef, tashkeel, punctuation, Western digits, mixed BiDi, long names, all interior kinds, declared blanks, safe margins, crop marks, bleed continuity, and RTL cover/spine alignment without clipping. RGB and exact-ICC CMYK proofs preserve raster structure while showing a real color-space change. This is synthetic mechanism evidence, not physical color approval.

### Authorization, durability, and invalidation evidence

- Materialization mismatch tests prove approval/gate/output/composition/profile/page/layout/review/text/source/integrity failures create zero run, job, asset, action, or head. Exact replay returns one run/job set; collisions and stale revisions remain atomic.
- Producer/finalizer tests recheck authorization, profile, source, run, attempt, and artifact head before execution and commit. Failure injection covers ENOSPC, EACCES, missing tools, validation failure, duplicate execution, cancellation, rollback, disk recovery, temp-file interruption, and rename-before-database recovery without partial current output.
- The real restart matrix sends SIGKILL during `interior_render`, `cover_render`, `cmyk_conversion`, `validation`, `after_temp_sync`, and `after_rename_before_db`. Each restart converges to one run, one interior, one cover, one report, and at most one exact proof gate with no orphan deliverable.
- Invalidation tests freeze affected IDs/actions in the original receipt and replay without later resolution or regeneration. A real locked-page IM-07 keeps its content pointers, layout head, and source bytes exact, sets `locked_stale`, invalidates preview/approval, blocks the approved-snapshot reader and print start, and creates zero print work. IM-14/15/18/19/20 coverage verifies the reason-specific artifact/report/run/proof behavior and exact repair/reuse boundaries.

### API and Arabic UI evidence

- Hostile API tests cover wrong owner/family/project/profile/run/artifact/revision/hash, path injection, stale/non-deliverable downloads, unsafe multipart content, forged browser state changes, bounded errors, safe attachment headers, and `Cache-Control: no-store` before handler/parser/not-found responses.
- The two core Playwright journeys prove restart-safe RGB delivery and visibly non-deliverable CMYK proofs released only by the exact Arabic UI action. Both verify scoped downloads and zero external requests.
- The targeted blocked-finding journey proves long Arabic reason/expected/actual text and mutation errors remain programmatic and readable at all three widths, with RTL keyboard/focus/a11y/44 px/reduced-motion/Western-digit/no-horizontal-overflow assertions supplied by the shared print UI checks.

## Implementation surfaces and traceability

- Domain and jobs: `src/domain/print/**`, `src/jobs/print-definitions.ts`, and `src/jobs/print-preflight-definition.ts`.
- Print/PDF adapters: `src/print/**` and Slice-owned `src/pdf/print-*` modules.
- Runtime/API/UI: `src/server/print-runtime.ts`, `src/server/routes/print-api.ts`, `src/ui/components/print/**`, `src/ui/print-*`, and `src/ui/views/use-print-state.ts`.
- Acceptance evidence: `tests/unit/print-*`, `tests/integration/print-*`, `tests/failure-injection/print-restart.test.ts`, and `tests/e2e/print.spec.ts`.
- Requirement/task IDs affected: `T-P8-01`–`T-P8-07`; FR-057/086/087/120–124; SC-006–010; US7; IM-01/03–15/18–20; CHK301–CHK318; 009-C01–009-C44.

## Pending pre-commercial operator gates

- **CHK317 — PENDING**: print and inspect one physical proof before the first commercial order for Arabic shaping, real colors, margins, trim/bleed, and spine alignment.
- **CHK318 — PENDING**: import the actual printing company's profile/template/ICC, verify the exact bleed/color/spine contract, run the round-trip, approve the converted proof when applicable, and confirm the printer accepts the files.

The approved G3 and Slice 009 evidence uses synthetic books, printer profiles/templates, local ICC fixtures, and local tools. It proves deterministic software behavior only. It is not actual-printer acceptance, does not close CHK317/318, and must never be presented as permission to fulfill a commercial order before both manual gates pass.

## Residual risks

- Physical color, paper behavior, binding tolerance, and printer-specific acceptance remain deliberately unverified until CHK317/318. The product must continue to hard-block missing or incompatible printer truth; no synthetic or RGB fallback may bypass those gates.

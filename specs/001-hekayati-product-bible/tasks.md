# Tasks: Hekayati (حكايتي)

**Input**: Integrated design documents from `/specs/001-hekayati-product-bible/`; feature ownership slices are indexed by `/specs/README.md`.
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, state-machines.md, invalidation-matrix.md
**Tests**: REQUIRED (Constitution XI, TDD). Test tasks precede implementation within each group.

Format: `[ID] [P?] [Refs] Description` — **[P]** = parallelizable (different files, no dependency). Task IDs are stable (`T-P<phase>-<nn>`); cross-referenced from plan.md and checklists. Paths follow plan.md §Project Structure.

**Phase gating**: every phase lists Preconditions / User-visible outcome / Acceptance checkpoint / Definition of Done (DoD). No phase starts while a blocking gate of a prior phase is open (Constitution XV).

---

## Phase 0 — Feasibility & Risk Reduction (gates G1–G4)

**Preconditions**: spec set approved by user. No product code yet — gate scripts are throwaway probes living in `spikes/` (excluded from coverage).
**User-visible outcome**: research.md gate table + capability matrix filled with verified values; go/no-go recorded per provider capability.
**Dependencies**: none.

- [x] T-P0-01 [G1-T] Probe installed Codex CLI: version, non-interactive `exec`, subscription auth status, structured/JSON output flags; script `spikes/g1t-codex-text.ts`; record scorecard in research.md R5 — **PASS 2026-07-14**
- [x] T-P0-02 [G1-T] Codex quota/rate-limit/auth error differentiation probe (safe forced fixtures; account exhaustion not forced); map to taxonomy; record in R5 — **PASS 2026-07-14**
- [x] T-P0-03 [G1-I] Codex image-generation feasibility: answer all 7 gate questions against installed environment + current official docs; record in R6; update capability matrix + RR-01 status — **FAIL (expected) 2026-07-14**
- [x] T-P0-04 [P] [G4] Verify current Gemini model IDs vs requested defaults (`gemini-3.5-flash`, `gemini-3.1-flash-image`, lite); record renames/deprecations in R7; set settings defaults — **official IDs verified; account gate FAIL (environment) 2026-07-14**
- [x] T-P0-05 [G2] Gemini identity-consistency scorecard using synthetic fictional illustrated characters only: 2–3 refs × 5 sequential scenes; measure reliable-characters-per-image + max reference images for default AND economy models; commit sanitized scores/hashes only; fill capability matrix _G2-measured_ cells; set C-08 threshold — **protocol complete; execution FAIL/PENDING (environment), measured cells intentionally unset 2026-07-14**
- [x] T-P0-06 [P] [G3] Arabic PDF spike: select and locally bundle exact Arabic display/body fonts with authoritative embedding licenses + source/version/SHA-256 evidence; Playwright/Chromium print-to-PDF of shaping-stress corpus + A4+bleed geometry + font embedding/no-CDN inspection; record in R9 — **PASS 2026-07-14**
- [x] T-P0-07 [P] [G3] Cover-spread spike: back+spine+front single-PDF geometry from a sample printer template; Ghostscript CMYK conversion smoke test (R10) — **PASS 2026-07-14**
- [x] T-P0-08 Consolidate: update research.md gate table, provider-capability-matrix.md, risk-register.md; flag any FAILED gate to user before Phase 4/6/8 planning assumptions change — **complete 2026-07-14; G1-I/G2/G4 consequences recorded**

**Checkpoint**: all five gates answered with evidence; unavailable measurements are explicitly unset and block only their dependent real-provider paths. **DoD**: research.md gate table contains dated PASS/FAIL outcomes, with no expected result presented as fact.

---

## Phase 1 — Local Application Foundation

**Preconditions**: Phase 0 outcomes recorded. G1/G2/G4 outcomes inform later provider/creative work; a G3 failure blocks PDF-dependent Phases 7–8, not this local-foundation phase.
**User-visible outcome**: app starts on 127.0.0.1, Arabic RTL shell renders, settings + health screens work, data survives restart. No AI needed for the demo.
**Dependencies**: Phase 0.

- [x] T-P1-01 Scaffold single Node/TS package: Fastify server, Vite+React RTL Citrus Playground shell, Vitest, Playwright, lint (incl. provider-boundary import rule), 800-line file guard, and no analytics/telemetry dependency [R1, C-16, FR-132, SC-012]
- [x] T-P1-02 [P] Startup guard tests then impl: reject every nonliteral/noncanonical listener host before socket open, bind only literal `127.0.0.1`, independently verify the effective post-listen address before readiness, and create data dirs with 0700/0600 perms (`src/server/startup/`) [FR-110, FR-130, FR-147, EC-H06, CHK213/214/222]
- [x] T-P1-03 [P] Write repository validation/migration/crash-durability tests, then implement the better-sqlite3 document store: get/put/query, zod boundaries, schemaVersion migrations, and WAL/FULL durability (`src/domain/…/repo`) [R2]
- [x] T-P1-04 [P] Write crash, dedup, orphan, and integrity fixtures, then implement the content-addressed asset store with atomic temp+fsync+rename writes, refcounts, orphan GC, plus startup/operator-triggered missing/checksum-mismatch reporting without mutation (`src/assets/`) [FR-093, FR-097 foundation stage, R4, EC-C07, EC-E09/E10]
- [x] T-P1-05 [P] Write fake-binary credential-isolation tests, resolve RR-08 (stdin mode or `@napi-rs/keyring` decision), then implement the Keychain wrapper without shell invocation (`src/security/keychain.ts`) [FR-105, R8, RR-08]
- [x] T-P1-06 [P] Write redaction tests for key patterns, runtime-token canaries, and image bytes, then implement central structured logging safe for later provider/export callers (`src/security/log.ts`) [FR-131 foundation stage, FR-148, EC-H05]
- [x] T-P1-11 Write the raw-HTTP negative suite, then implement the earliest pre-body/pre-route exact-authority guard, exact `Origin`/parsed-`Referer` source guard for every unsafe method, runtime-only no-store CSRF bootstrap/token rotation, proxy trust disabled, and no CORS/PNA opt-in; fixtures cover DNS rebinding, forwarded-host spoofing, preflights, malformed/opaque source headers, and missing/bad/stale tokens while asserting zero route dispatch and persisted mutations (`src/server/security/`) [FR-147/148, R13, RR-17, EC-H09–H13, CHK223–226]
- [x] T-P1-07 Write settings schema/restart/API/UI tests, then implement the validated persistent Arabic RTL settings screen for provider/model selections, concurrency, typography minimums, watermark, disk threshold, and read-only storage paths; no secrets in the document and deferred provider/printer cells remain explicit `not_configured` [FR-137 foundation stage, CHK426]
- [x] T-P1-08 Write diagnostic success/degraded-state tests, then implement health endpoints and Arabic screen for DB, disk free (10 GB default warning), asset-integrity summary, verified bind address, and explicit `not_configured`/`not_available` provider and queue cells [FR-138 foundation stage, CHK414/426]
- [x] T-P1-09 Write first-run persistence/accessibility tests, then implement the Arabic no-automatic-backup/export-is-not-backup warning plus a seed-template installation hook whose data lands in Phase 3 [FR-133 foundation stage, CHK215]
- [x] T-P1-10 E2E: start app → Arabic shell → settings persist → kill → restart → state intact; stale CSRF token fails, reload bootstraps a fresh token, canonical unsafe request succeeds, and a baseline network capture observes no external telemetry [FR-132 foundation stage, SC-012, SC-014]

**Checkpoint**: quickstart §Install runs clean on a fresh Mac account and the complete SC-014 negative suite rejects before dispatch with zero mutations while the canonical journey succeeds. **DoD**: T-P1 tests green; SC-012 baseline screenshot recorded; CHK213/214 and CHK222–226 evidenced; no secret or runtime CSRF token persists outside approved memory/Keychain boundaries.

---

## Phase 2 — Customers, Families, Characters, Looks (US1, US2-data)

**Preconditions**: Phase 1.
**User-visible outcome**: provider-free customer/family/character library with consent, privacy-clean photo intake, looks, pets, archive/restore, and restart-safe versions. Character-sheet generation remains deferred to feature 007 after provider/scheduler dependencies.
**Dependencies**: Phase 1.

- [x] T-P2-01 [P] [US1] Customer + consent lifecycle, tests first: create/view/update/archive/restore, absent/granted/refused records with date+note, current-consent eligibility decision, queued-revocation fixture, and restart persistence (`src/domain/customers/`) [FR-001/004/018, C-13/C-18, EC-H01/H14, CHK003/206]
- [x] T-P2-02 [P] [US1] Family lifecycle with first-member `main_child`/assign-once anchor, uniqueness/immutability, missing-or-archived-anchor blocks without relationship reinterpretation, relationship-typed later members, exact C-19 name normalization plus checksum duplicate candidates, and one structural scope policy used by family-filtered queries plus direct-ID mutations; foreign-family bypass fixtures fail (`src/domain/customers/`) [FR-002/003/017–019, C-19/C-21, EC-A17/H02, CHK002/027/210]
- [x] T-P2-03 [US1] Immutable character/look versions, append+head-CAS+change-outbox transaction, prior-version recovery by append, relationship/pet/source-mode invariants, archive/restore, and exact IM-01–03/05/21 classification. The three edit intents are a closed domain union; project-only persistence/UI and IM-04 emission remain 004 (`src/domain/characters/`, `looks/`, `versioning/`) [FR-010–018, IM-01–03/05/21, EC-A01/A08, CHK001/006]
- [x] T-P2-04 [US1] Atomic bounded photo intake: settings v1→v2 limits; opaque runtime-only reservation and staged-new-character path; multipart streaming; content sniff + decode + compressed/pixel caps; private exact-original namespace; HEIC via `sips`; orientation then sharp re-encode/metadata strip; working/thumbnail/crop prepared writes; character/look ownership; duplicate decision before commit; provider-reference resolver that accepts only the pinned clean `providerAssetId`; one owner/version/photo/outbox transaction; cancel, expiry, crash, symlink, GC, permission, integrity, and no-browser-original fixtures (`src/assets/intake/`) [FR-004/019–022/025/134, R4/R12, CHK004/208/216/227]
- [x] T-P2-05 [US1] Explainable versioned local warning policy after T-P2-04: persist deterministic dimensions/blur/exposure/subject-box metrics with thresholds plus explicit operator observations for people/obstruction/filter/age/hair/clothing; every face-kind photo uses a keyboard-defined crop as its provider asset, and multi-person input cannot commit until the intended person is explicitly selected [FR-023/024, C-20, RR-18, EC-A02–A04, CHK005]
- [x] T-P2-06 [US1] Arabic RTL Citrus library UI: customer/consent, families/anchor/members/pets, immutable character/look editing, archive/restore, duplicate choice, description/photo modes, intake checklist/warnings, keyboard subject selection, derived thumbnails only, and empty/loading/error/restart states; verify simple MSA, logical layout, bidi-isolated WhatsApp/file data, Western digits, status text+icon, 44px targets, visible focus, axe, and 390×844/1440×900/1920×1080 fit [C-16, CHK401–405/420–424/427]
- [x] T-P2-10 [US1] E2E: no-provider journey creates customer + consent → anchored family → photo-based + description-only + pet characters → two looks; exercises duplicate choice, archive/restore, direct cross-family bypass rejection, consent codes, upload warnings/subject selection, app kill/restart, and zero external requests [US1, CHK001–005/206/208/210/216]
- [x] T-P2-12 [US1] Read-only customer-library dependency inventory for feature 010: customers/families, every character/look version, reference-photo records, private originals, working/thumbnails/crops, change events, and extensible downstream-reference slots. No destructive action exists in 003 [FR-005 interface, EC-H03/H04]

**003 checkpoint**: US1 provider-free journey passes with synthetic people only; prior versions and all local/private files survive restart; cross-family direct-ID access and unsafe/original-file routes fail; intake interruption leaves no visible/dangling state. **DoD**: T-P2-01–06/10/12 green; CHK001–005, CHK216, CHK227 and the 003 portions of CHK006/206/208/210/220/401–405/420–424/427 evidenced. Provider dispatch, project-only persistence, character sheets, and permanent deletion remain explicitly open for their owning slices.

---

## Phase 3 — Templates, Story Configuration, @Mentions (US3, US10)

**Preconditions**: Phase 2.
**User-visible outcome**: full story configuration; mention-aware scene editing; template library with 7 seeds.
**Dependencies**: Phase 2.

- [ ] T-P3-01 [P] [US10] Versioned template model + operations (create/edit/duplicate/archive/disable); pinning semantics tests [FR-050–052, IM-16, EC-B11]
- [ ] T-P3-02 [P] [US10] Author the 7 seed templates (Arabic content: premise, structure, role slots, variables, hidden goals, scene guidance, age rules, boundaries, endings) [FR-053]
- [ ] T-P3-03 [US3] Story configuration domain + UI: all FR-045 fields, narration/dialogue balance suggestion, missing/archived family-anchor rejection in the project picker without changing pinned projects, and the enabled FR-014(a) project-only appearance/look override destination with version-pinned storage and atomic IM-04 outbox emission [FR-014/017–018/045/046/049, C-21, IM-04, CHK006]
- [ ] T-P3-04 [US3] Mention engine (tests first): ID-bound tokens, diacritic-insensitive matching, spaces in names, duplicate disambiguation data, group mentions, unresolved-token degradation (`src/domain/mentions/`) [FR-035–040, C-11, EC-A05/A06]
- [ ] T-P3-05 [US3] Scene editor UI: @ picker (thumbnail/name/relationship/role), per-mention scene props, dialogue entry [FR-036/037, CHK406–409]
- [ ] T-P3-06 [US3] Scene compile step: group expansion, prose/participant reconciliation warnings, character removal resolution flow, look/profile compatibility validation, and C-08 participant-count warning [FR-038/039/041, FR-075, EC-A07/A09/A16]
- [ ] T-P3-07 [US10] Template-from-completed-story + story-duplication: privacy-stripping fixture test (photos/names/mentions → role slots), plus specific invalid-input handling for underspecified custom stories [FR-051/092, CHK211, EC-B12, E7]
- [ ] T-P3-08 E2E: US3 + US10 independent tests (incl. rename-two-أحمد journey, E6)

**Checkpoint**: US3/US10 scenarios pass with zero AI dependency. **DoD**: CHK009–011 satisfiable; mention unit suite ≥ every FR-040 edge.

---

## Phase 4 — Provider-Neutral AI Orchestration

**Preconditions**: Phase 1; gate G1/G2/G4 outcomes recorded (Phase 0).
**User-visible outcome**: settings show real provider health/capabilities; connection tests work; mock provider full-featured; Codex/Gemini adapters conformant.
**Dependencies**: Phases 0, 1 (parallel to 2–3 after contract tasks).

- [ ] T-P4-01 Canonical contract types + zod schemas in code, mirroring contracts/\*.md exactly, including persisted `ImageRequestDraft` vs ephemeral `ResolvedImageRequest`; schema fixture suite (valid/invalid per structured-outputs §§1–5) (`src/providers/contract.ts`, `schemas/`) [FR-090/091/134]
- [ ] T-P4-02 Provider conformance test harness (runs against any adapter): adapters receive only resolver-approved bytes/safe metadata and have no asset-store/original handle; operations, cancellation, timeout, error normalization table, provenance completeness, capability/account failures, malformed image variants, reference-capacity changes, and economy warnings [FR-075/092/094/098/102/103/105–108/134, EC-D01–D02/D04–D08/D13–D15/D17–D18]
- [ ] T-P4-03 Mock provider: deterministic outputs by request hash, scriptable faults per taxonomy row, synthetic image fixtures (`src/providers/mock/`) [FR-099]
- [ ] T-P4-04 [P] Gemini adapter: @google/genai, Keychain key per call, structured via responseSchema + local revalidation, multi-reference images, model probe, economy flag (`src/providers/gemini/`) [FR-105–108]
- [ ] T-P4-05 [P] Codex adapter (scope per G1-T outcome): execFile exec wrapper, auth-state detection, structured output per installed CLI, process-kill cancellation; image slot returns G1-I unavailableReason (`src/providers/codex/`) [FR-100–103]
- [ ] T-P4-06 Prompt compilers per adapter: GenerationTask → provider prompts; three extensible style configurations; versioned prompt templates; mandatory text-free, illustrated-likeness, safety, and participant negative constraints; deny-list transformation flow with operator confirmation UI [FR-070–073/115, CHK104/105]
- [ ] T-P4-07 Reference budgeting logic from capability matrix values (not constants); provenance notes on reduction [CHK114/115]
- [ ] T-P4-08 Settings/health integration: provider selection combos, key lifecycle, connection tests, auth/availability state, capability warnings (economy, Codex image unavailability), and model availability surfacing [FR-095/098, FR-137/138 provider stage, US8]
- [ ] T-P4-09 Live-validation scripts (operator-triggered, not CI): one structured + one image smoke per configured provider [test-strategy §live]
- [ ] T-P4-10 E2E: US8 scenarios incl. key lifecycle + secret-scan assertions (SC-005 partial)

**Checkpoint**: conformance suite green on mock + fixture-mode adapters; live smoke passes on operator machine. **DoD**: CHK101–115 satisfiable; lint boundary rule active.

---

## Phase 5 — Durable Task Scheduling

**Preconditions**: Phases 1, 2, 4 (003 consent/reference resolver plus provider contract types).
**User-visible outcome**: observable queue UI with pause/resume/cancel/retry/priority; restart recovery demonstrably safe.
**Dependencies**: Phases 1, 2, 4.

- [ ] T-P5-01 Scheduler core (tests first, from contract): states, DAG deps, priorities, atomic claim, per-provider concurrency, enqueue eligibility, and immediate pre-dispatch re-resolution of every provider reference plus current consent with zero adapter/network call on rejection (`src/jobs/`) [FR-004/021/025/109/112/114/134, EC-H14, CHK206/208]
- [ ] T-P5-02 Idempotency keys + commit protocol (lease check, input-snapshot precondition, single transaction); duplicate-delivery, database-loss, deletion-during-work, stale/late/canceled rejection tests [FR-065/093, EC-C01/C06, EC-E02–E04/E08/E12]
- [ ] T-P5-03 Failure taxonomy handling + retry policies exactly per contract table; per-row tests including rate limit, network loss, timeout, and provider-switch scope [FR-092/095/113, CHK106, EC-D09/D11–D12/D16]
- [ ] T-P5-04 Quota-pause protocol + wait/switch decision flow + audit events [FR-096, SC-009, EC-D03]
- [ ] T-P5-05 Restart recovery: bootId lease expiry, re-queue, tmp-GC sweep; kill-matrix failure-injection tests [FR-113, SC-002, EC-E01]
- [ ] T-P5-06 Progress events, stall detection ("no progress" flag), waiting_review gate states [FR-111/114, EC-E06]
- [ ] T-P5-07 Queue UI (Arabic): per-job blocking reasons, project pause/resume, cancel, retry, priority, and real queue-depth integration into the shared health surface [FR-111, FR-138 queue stage, CHK410–412]
- [ ] T-P5-08 Monotonic-clock lease arithmetic (bootId + monotonicMs); wall-clock-jump tests [EC-E05, scheduler §leases]
- [ ] T-P5-09 Disk-full / permission-failure pause-all + health alert integration [EC-E07/E13]

**Checkpoint**: failure-injection suite green incl. kill matrix. **DoD**: CHK016 satisfiable; scheduler coverage ≥80%.

---

## Phase 6 — Story & Illustration Production (US4, US5)

**Preconditions**: Phases 2–5; gates G2 values in matrix.
**User-visible outcome**: end-to-end book generation with review, page regeneration, locks, versions — on mock AND live providers.
**Dependencies**: Phases 2, 3, 4, 5.

- [ ] T-P2-07 [US2] Character sheet generation via mock provider job: views bound to versions, provenance, and trusted transitive `description_only|photo_derived` reference lineage for FR-004; compact sheet PDF export (`src/domain/characters/sheet.ts`, `src/pdf/sheet.ts`) [FR-004/030/031]
- [ ] T-P2-08 [US2] Character approval records + supersede-on-edit + affected-items flag flow (tests mirror US2-AS3) [FR-032/033, IM-01]
- [ ] T-P2-11 [US2] E2E: character sheet independent journey with mock provider, compact PDF, approval/change request, permanent-appearance edit, prior approval superseded, and exact affected-items consequences [US2, CHK007/008]
- [ ] T-P6-01 Generation pipeline jobs: plan → story → scenes → prompts → page fan-out, including the operator-confirmed one/two-sequential-image page rule, wired to dependency chain + waiting_review gates (`src/domain/story/pipeline.ts`) [FR-060/114, US4-AS1]
- [ ] T-P6-02 Story/scene/page version persistence from validated outputs, including every FR-059 page field; ChangeEvent emission (`src/domain/versioning/`) [FR-059, data-model hooks]
- [ ] T-P6-03 Invalidation engine implementing every IM row; idempotent outbox receipts, transitive cascade, affected-items view, and per-row unit tests (`src/domain/approvals/invalidation.ts`) [FR-033/058/086/087, IM-01…21]
- [ ] T-P6-04 Sheet-first reference strategy in image jobs: approved sheet views carry trusted transitive lineage; photo-derived sheets require current consent at enqueue/dispatch while wholly description-derived sheets retain the zero-photo exception [FR-004, R12, RR-03]
- [ ] T-P6-05 Page operations: regenerate-one (isolation checksums, SC-003), text-only rewrite, layout-only recalc, revert, lock/unlock/approve; locked_stale flagging [FR-062–066, US5, EC-C02–C05]
- [ ] T-P6-06 Mandatory human review UI: per-page identity/participant/pet checklist, consistency view, and advisory ReviewFindings display covering schema-length failures, register/shaming, copyright transformation, malformed output, and every pre-delivery safety category [FR-041/047/048/063/071/082/092/115–119, EC-A10–A15, EC-B01–B10/B13]
- [ ] T-P6-07 Safety-refusal handling: step/page identification, no auto-variation retry, operator resolution flow [FR-116, EC-D10]
- [ ] T-P6-08 Page-count-change guided expand/shorten flow [FR-058, IM-09]
- [ ] T-P6-09 E2E: US4 + US5 scenarios (mock), incl. E4 regeneration isolation + E5 quota journey; live-provider manual validation script
- [ ] T-P6-10 [US11] Single Image Studio domain + API: `studioGenerations` CRUD, `studio_image` job type, same-family plus active-anchor eligibility, and no Project/Story/Page side effects (`src/domain/studio/`) [FR-003/017–018/140–146, C-21]
- [ ] T-P6-11 [US11] Studio Arabic RTL tab UI: active-anchored family/character/look picker, actionable missing/archived-anchor state, prompt, style, generate/regenerate/history/download, consent, and capacity warnings [FR-140/141/144, C-15/C-21]
- [ ] T-P6-12 [US11] E2E: US11 + E8 — prompt-only and referenced generation, same-family enforcement, missing/archived-anchor rejection with old history intact, download, assert zero project records and zero book invalidation events; isolation vs concurrent book project (SC-013, C-21, EC-C11–C13)

**Checkpoint**: a full 16-page mock book produced, reviewed, page-7-regenerated with checksum-proven isolation; Studio one-shot image path green. **DoD**: CHK012–018 + CHK026 satisfiable; SC-003 and SC-013 tests green.

---

## Phase 7 — Text Layout, Preview & Approval (US6)

**Preconditions**: Phase 6; gate G3.
**User-visible outcome**: pages carry programmatically laid-out Arabic text; watermarked preview PDF; approval lifecycle with invalidation.
**Dependencies**: Phase 6.

- [ ] T-P7-01 Layout engine: quiet-region analysis, placement presets, gradient/panel aids, min-font floor, overflow warnings (tests over fixture artwork) (`src/layout/`) [FR-080–083, EC-C08–C10]
- [ ] T-P7-02 Dialogue bubbles: modern minimal, speaker pointing, RTL text flow [FR-083, CHK313]
- [ ] T-P7-03 HTML page templates (shared UI/PDF CSS): title, dedication, story, ending1 (hero farewell), ending2 (brand) [FR-055/056, C-03]
- [ ] T-P7-04 Preview PDF pipeline: downsample ~150 DPI, watermark every page, ≤16 MB budget check (`src/pdf/preview.ts`) [FR-120/124, C-06/C-14, SC-007]
- [ ] T-P7-05 Book approval records: preview_sent/approved/changes_requested + notes + affected pages; invalidation on customer-visible change; print-block enforcement [FR-085/086, SC-010/011]
- [ ] T-P7-06 E2E: US6 scenarios incl. punctuation-only invalidation (IM-07) and internal-change non-invalidation (IM-18)

**Checkpoint**: preview approved → text edit → approval invalidated → new preview cycle. **DoD**: CHK020/021 satisfiable; Arabic layout goldens green.

---

## Phase 8 — Print Production (US7)

**Preconditions**: Phase 7; gates G3 + spike T-P0-07.
**User-visible outcome**: deliverable interior + cover PDFs gated by preflight; printer profiles.
**Dependencies**: Phase 7.

- [ ] T-P8-01 Printer profile model + settings UI: trim/bleed/DPI/color/ICC/crop/spine/cover-template/blank-pages, replacing the foundation `not_configured` printer cell [FR-121/122, FR-137 printer stage]
- [ ] T-P8-02 Interior print PDF: full-res render, bleed geometry, optional crop marks, printer blanks at assembly only [FR-057/121, C-04]
- [ ] T-P8-03 Cover spread PDF: back synopsis + brand, spine (profile/template only — hard block when unknown), front (child, name, title, environment); RTL binding geometry [FR-122, US7-AS2/3, EC-F04/F10]
- [ ] T-P8-04 Ghostscript CMYK conversion path + converted-proof approval step [C-12, EC-F09, RR-11]
- [ ] T-P8-05 Preflight engine: all FR-123 rules incl. watermark presence/absence both ways; seeded defect fixture per category (SC-006) (`src/pdf/preflight.ts`) [FR-123/124, EC-F01–F14]
- [ ] T-P8-06 Arabic font licensing + embedding verification; shaping golden suite wired to CI [SC-008, CHK310/311]
- [ ] T-P8-07 E2E: US7 scenarios; physical-proof checklist entry recorded (CHK317 manual)

**Checkpoint**: preflight fixture suite 100% detection. **DoD**: CHK301–316 satisfiable; SC-006/007/008 green.

---

## Phase 9 — Import/Export & Deletion Hardening (US9)

**Preconditions**: Phases 2, 6 (content to export); independent of 7–8 otherwise.
**User-visible outcome**: portable project ZIPs; safe imports; verified deletion.
**Dependencies**: Phases 2, 6.

- [ ] T-P2-09 [US1/US9] Permanent deletion cascade consumes the 003 inventory, presents a pre-report, force-cancels dependent work, removes DB records plus private-original/derived/generated media, and verifies post-delete disk state [FR-005, EC-H03/H04, CHK209]
- [ ] T-P9-01 Export pipeline + Arabic export flow: pause-gate (C-07), manifest + checksums, content packaging per FR-125, automated secret-scan gate, and visible “export is not a backup” warning (`src/portability/export.ts`) [FR-125/126/129, FR-133 export stage, EC-E11/G11, CHK215]
- [ ] T-P9-02 Import validation: structure, manifest versioning (migrate old / reject future), checksums, path-safety (traversal/symlink/executable), disk pre-check [FR-128, EC-G01–G05, EC-G09/G10]
- [ ] T-P9-03 Import modes + conflict rules: as-new (ID remap), replace (confirmation), characters-only, templates-only; legacy template character references are stripped into role slots [FR-050/051/127, EC-G06/G07/G12/G13]
- [ ] T-P9-04 Staged-then-committed atomic import; interruption rollback fixture [FR-128, EC-G08]
- [ ] T-P9-05 Round-trip fidelity test: export → fresh instance import → deep-equality of project content
- [ ] T-P9-06 E2E: US9 scenarios including the export warning; SC-005 full sweep (DB dump + logs + archives) [FR-133, SC-005]

**Checkpoint**: every EC-G fixture behaves as cataloged and permanent deletion verifies every inventoried record/file absent. **DoD**: CHK217–219, CHK024/209 satisfiable.

---

## Phase 10 — Hardening & End-to-End Acceptance

**Preconditions**: Phases 1–9.
**User-visible outcome**: production-confidence release candidate + operator documentation.
**Dependencies**: all prior phases.

- [ ] T-P10-01 Full failure-injection sweep: kill matrix × all pipelines; disk-full; network loss; provider fault storm (mock) [SC-002, test-strategy §4]
- [ ] T-P10-02 Integrity scan end-to-end: exercise startup, periodic, and operator-triggered scans over manual asset deletion/corruption fixtures → flags plus per-owner regeneration offers, never automatic regeneration [FR-097 completion, EC-C07, IM-20]
- [ ] T-P10-03 Privacy suite final run: payload-minimization snapshots, telemetry-absence network capture, permissions audit [FR-130–134, CHK206–215]
- [ ] T-P10-04 Complete Arabic UI journey E2E from quickstart, timed against SC-001; SC-012 responsive audit
- [ ] T-P10-05 [P] Performance validation vs plan.md goals (UI p95, 24pp render <120 s, cold start <10 s)
- [ ] T-P10-06 [P] Operator documentation final pass: quickstart accuracy on a clean machine, troubleshooting table verification
- [ ] T-P10-07 Run all five checklists; record evidence; fix every failed item or document accepted deviation with user sign-off
- [ ] T-P10-08 Release checkpoint: constitution compliance review; FR-135/RR-13 legal-review scheduling confirmed before commercial launch [FR-135, RR-13]

**Checkpoint**: all checklists green/evidenced. **DoD**: SC-001…SC-014 all verified; risk register statuses current.

---

## Dependencies & Execution Order

```text
P0 ──▶ P1 ──▶ P2 ──▶ P3 ──▶ P6 ──▶ P7 ──▶ P8 ──▶ P10
        │                    ▲
        ├──▶ P4 ────────────┤ (P4 parallel to P2/P3 after T-P4-01)
        └──▶ P5 ────────────┘ (P5 needs P2 consent/reference state + P4 contract types)
P9 needs P2+P6; can run parallel to P7/P8.
```

MVP slice = P0–P6 + minimal P7 (preview): produces a reviewable book. Print delivery requires P8.

## Traceability

- Every FR appears in ≥1 task Ref; every EC-\* case appears in a task or checklist; SC-001…014 land in P6–P10 checkpoints; IM rows covered by T-P6-03 unit suite. Audit repeated at each phase exit (analyze-stage discipline).

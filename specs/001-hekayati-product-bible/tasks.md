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

- [ ] T-P1-01 Scaffold single Node/TS package: Fastify server, Vite+React RTL SPA shell, Vitest, Playwright, lint (incl. provider-boundary import rule), 800-line file guard
- [ ] T-P1-02 [P] Startup guard tests then impl: loopback-only bind verification (refuse otherwise), data-dir creation with 0700/0600 perms (`src/server/startup/`) [FR-110, FR-130, EC-H06]
- [ ] T-P1-03 [P] Document store on better-sqlite3: repository layer (get/put/query, zod validation, schemaVersion migrations), WAL config; tests for crash-durability + migration (`src/domain/…/repo`, R2)
- [ ] T-P1-04 [P] Content-addressed asset store with atomic temp+fsync+rename writes, dedup, refcount, orphan GC; crash-simulation tests (`src/assets/`) [FR-093, R4, EC-E09/E10]
- [ ] T-P1-05 [P] Keychain wrapper via `security` CLI (execFile, no shell); resolve RR-08 (stdin mode or @napi-rs/keyring decision); tests with fake binary (`src/security/keychain.ts`) [FR-105, R8]
- [ ] T-P1-06 [P] Log infrastructure with redaction layer + automated redaction tests (key patterns, image bytes) (`src/security/log.ts`) [FR-131]
- [ ] T-P1-07 Settings document + screen (Arabic RTL): providers, model IDs, concurrency, typography minimums, watermark text; no secrets in doc [FR-137]
- [ ] T-P1-08 Health/diagnostics screen + endpoints: DB, disk free (10 GB warn), integrity summary stub, bind address [FR-138]
- [ ] T-P1-09 First-run experience: no-backup warning, seed-template installation hook (templates land Phase 3) [FR-133]
- [ ] T-P1-10 E2E: start app → Arabic shell → settings persist → kill → restart → state intact

**Checkpoint**: quickstart §Install runs clean on a fresh Mac account. **DoD**: T-P1 tests green; SC-012 baseline screenshot recorded; no secret persists outside Keychain.

---

## Phase 2 — Customers, Families, Characters, Looks (US1, US2-data)

**Preconditions**: Phase 1.
**User-visible outcome**: full character library with photos, consent, looks, pets; character sheets via MOCK generation; sheet PDF export.
**Dependencies**: Phase 1.

- [ ] T-P2-01 [P] [US1] Customer + consent CRUD (tests first): fields, consent date/note, archived state (`src/domain/customers/`) [FR-001]
- [ ] T-P2-02 [P] [US1] Families + relationship-typed members; cross-family scoping enforcement tests (`src/domain/customers/`) [FR-002/003, EC-H02]
- [ ] T-P2-03 [US1] Versioned characters + looks: version lineage, head pointers, pets, description-only mode; edit-mode trichotomy (project-only/base/new-look) (`src/domain/characters/`, `looks/`) [FR-010–017, EC-A08]
- [ ] T-P2-04 [US1] Photo intake pipeline: HEIC via `sips`, EXIF orientation-then-strip, content-based type check, size limits (`src/assets/intake.ts`) [FR-020–022]
- [ ] T-P2-05 [P] [US1] Photo-quality warnings (blur, face size, multi-face, shadows, obstruction, filter, age/clothing conflicts) + multi-face person marking; fixture-driven tests [FR-023/024, EC-A02–A04]
- [ ] T-P2-06 [US1] Character library UI (Arabic RTL): intake checklist display, warnings, looks management
- [ ] T-P2-07 [US2] Character sheet generation via mock provider job: views bound to versions, provenance; sheet PDF export (compact) (`src/domain/characters/sheet.ts`, `src/pdf/sheet.ts`) [FR-030/031]
- [ ] T-P2-08 [US2] Character approval records + supersede-on-edit + affected-items flag flow (tests mirror US2-AS3) [FR-032/033, IM-01]
- [ ] T-P2-09 [US1] Permanent deletion cascade with pre-report + disk media removal verification tests [FR-005, EC-H03/H04]
- [ ] T-P2-10 E2E: US1 + US2 independent tests as scripted journeys (mock provider)

**Checkpoint**: US1/US2 acceptance scenarios pass. **DoD**: CHK001–008 satisfiable; restart-survival proven.

---

## Phase 3 — Templates, Story Configuration, @Mentions (US3, US10)

**Preconditions**: Phase 2.
**User-visible outcome**: full story configuration; mention-aware scene editing; template library with 7 seeds.
**Dependencies**: Phase 2.

- [ ] T-P3-01 [P] [US10] Versioned template model + operations (create/edit/duplicate/archive/disable); pinning semantics tests [FR-050–052, IM-16, EC-B11]
- [ ] T-P3-02 [P] [US10] Author the 7 seed templates (Arabic content: premise, structure, role slots, variables, hidden goals, scene guidance, age rules, boundaries, endings) [FR-053]
- [ ] T-P3-03 [US3] Story configuration domain + UI: all FR-045 fields, narration/dialogue balance suggestion [FR-045/046, FR-049]
- [ ] T-P3-04 [US3] Mention engine (tests first): ID-bound tokens, diacritic-insensitive matching, spaces in names, duplicate disambiguation data, group mentions, unresolved-token degradation (`src/domain/mentions/`) [FR-035–040, C-11, EC-A05/A06]
- [ ] T-P3-05 [US3] Scene editor UI: @ picker (thumbnail/name/relationship/role), per-mention scene props, dialogue entry [FR-036/037, CHK406–409]
- [ ] T-P3-06 [US3] Scene compile step: group expansion, prose/participant reconciliation warnings, character removal resolution flow, C-08 participant-count warning [FR-038/039/041, FR-075, EC-A07/A09]
- [ ] T-P3-07 [US10] Template-from-completed-story + story-duplication: privacy-stripping fixture test (photos/names/mentions → role slots) [FR-051, CHK211, E7]
- [ ] T-P3-08 E2E: US3 + US10 independent tests (incl. rename-two-أحمد journey, E6)

**Checkpoint**: US3/US10 scenarios pass with zero AI dependency. **DoD**: CHK009–011 satisfiable; mention unit suite ≥ every FR-040 edge.

---

## Phase 4 — Provider-Neutral AI Orchestration

**Preconditions**: Phase 1; gate G1/G2/G4 outcomes recorded (Phase 0).
**User-visible outcome**: settings show real provider health/capabilities; connection tests work; mock provider full-featured; Codex/Gemini adapters conformant.
**Dependencies**: Phases 0, 1 (parallel to 2–3 after contract tasks).

- [ ] T-P4-01 Canonical contract types + zod schemas in code, mirroring contracts/\*.md exactly; schema fixture suite (valid/invalid per structured-outputs §§1–5) (`src/providers/contract.ts`, `schemas/`) [FR-090/091]
- [ ] T-P4-02 Provider conformance test harness (runs against any adapter): operations, cancellation, timeout, error normalization table, provenance completeness [FR-092/094]
- [ ] T-P4-03 Mock provider: deterministic outputs by request hash, scriptable faults per taxonomy row, synthetic image fixtures (`src/providers/mock/`) [FR-099]
- [ ] T-P4-04 [P] Gemini adapter: @google/genai, Keychain key per call, structured via responseSchema + local revalidation, multi-reference images, model probe, economy flag (`src/providers/gemini/`) [FR-105–108]
- [ ] T-P4-05 [P] Codex adapter (scope per G1-T outcome): execFile exec wrapper, auth-state detection, structured output per installed CLI, process-kill cancellation; image slot returns G1-I unavailableReason (`src/providers/codex/`) [FR-100–103]
- [ ] T-P4-06 Prompt compilers per adapter: GenerationTask → provider prompts; versioned prompt templates; mandatory negative constraints; deny-list transformation flow (FR-071) with operator confirmation UI [CHK104/105]
- [ ] T-P4-07 Reference budgeting logic from capability matrix values (not constants); provenance notes on reduction [CHK114/115]
- [ ] T-P4-08 Settings integration: provider selection combos, connection tests, capability warnings (economy, Codex image unavailability), model availability surfacing [FR-095/098, US8]
- [ ] T-P4-09 Live-validation scripts (operator-triggered, not CI): one structured + one image smoke per configured provider [test-strategy §live]
- [ ] T-P4-10 E2E: US8 scenarios incl. key lifecycle + secret-scan assertions (SC-005 partial)

**Checkpoint**: conformance suite green on mock + fixture-mode adapters; live smoke passes on operator machine. **DoD**: CHK101–115 satisfiable; lint boundary rule active.

---

## Phase 5 — Durable Task Scheduling

**Preconditions**: Phases 1, 4 (contract types).
**User-visible outcome**: observable queue UI with pause/resume/cancel/retry/priority; restart recovery demonstrably safe.
**Dependencies**: Phases 1, 4.

- [ ] T-P5-01 Scheduler core (tests first, from contract): states, DAG deps, priorities, atomic claim, per-provider concurrency (`src/jobs/`) [FR-109/112/114]
- [ ] T-P5-02 Idempotency keys + commit protocol (lease check, input-snapshot precondition, single transaction); stale/late/canceled rejection tests [FR-065/093, EC-C01/C06, EC-E08/E12]
- [ ] T-P5-03 Failure taxonomy handling + retry policies exactly per contract table; per-row tests [FR-092, CHK106]
- [ ] T-P5-04 Quota-pause protocol + wait/switch decision flow + audit events [FR-096, SC-009, EC-D03]
- [ ] T-P5-05 Restart recovery: bootId lease expiry, re-queue, tmp-GC sweep; kill-matrix failure-injection tests [FR-113, SC-002, EC-E01]
- [ ] T-P5-06 Progress events, stall detection ("no progress" flag), waiting_review gate states [FR-111/114, EC-E06]
- [ ] T-P5-07 Queue UI (Arabic): per-job blocking reasons, project pause/resume, cancel, retry, priority [FR-111, CHK410–412]
- [ ] T-P5-08 Monotonic-clock lease arithmetic (bootId + monotonicMs); wall-clock-jump tests [EC-E05, scheduler §leases]
- [ ] T-P5-09 Disk-full / permission-failure pause-all + health alert integration [EC-E07/E13]

**Checkpoint**: failure-injection suite green incl. kill matrix. **DoD**: CHK016 satisfiable; scheduler coverage ≥80%.

---

## Phase 6 — Story & Illustration Production (US4, US5)

**Preconditions**: Phases 2–5; gates G2 values in matrix.
**User-visible outcome**: end-to-end book generation with review, page regeneration, locks, versions — on mock AND live providers.
**Dependencies**: Phases 2, 3, 4, 5.

- [ ] T-P6-01 Generation pipeline jobs: plan → story → scenes → prompts → page fan-out, wired to dependency chain + waiting_review gates (`src/domain/story/pipeline.ts`) [FR-114, US4-AS1]
- [ ] T-P6-02 Story/scene/page version persistence from validated outputs; ChangeEvent emission (`src/domain/versioning/`) [data-model hooks]
- [ ] T-P6-03 Invalidation engine implementing every IM row; transitive cascade; affected-items view; per-row unit tests (`src/domain/approvals/invalidation.ts`) [FR-033/058/086/087, IM-01…20]
- [ ] T-P6-04 Sheet-first reference strategy in image jobs (approved sheet views as references) [R12, RR-03]
- [ ] T-P6-05 Page operations: regenerate-one (isolation checksums, SC-003), text-only rewrite, layout-only recalc, revert, lock/unlock/approve; locked_stale flagging [FR-062–066, US5, EC-C02–C05]
- [ ] T-P6-06 Review UI: per-page checklist (FR-118), consistency view (FR-119), ReviewFindings display incl. register/shaming flags [FR-047/048, EC-B04–B08]
- [ ] T-P6-07 Safety-refusal handling: step/page identification, no auto-variation retry, operator resolution flow [FR-116, EC-D10]
- [ ] T-P6-08 Page-count-change guided expand/shorten flow [FR-058, IM-09]
- [ ] T-P6-09 E2E: US4 + US5 scenarios (mock), incl. E4 regeneration isolation + E5 quota journey; live-provider manual validation script
- [ ] T-P6-10 [US11] Single Image Studio domain + API: `studioGenerations` CRUD, `studio_image` job type, no Project/Story/Page side effects (`src/domain/studio/`) [FR-140–146]
- [ ] T-P6-11 [US11] Studio Arabic RTL tab UI: character/look picker, prompt, style, generate/regenerate/history/download; consent + capacity warnings [FR-140/141/144, C-15]
- [ ] T-P6-12 [US11] E2E: US11 + E8 — generate with refs, download, assert zero project records and zero book invalidation events; isolation vs concurrent book project (SC-013)

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

- [ ] T-P8-01 Printer profile model + UI: trim/bleed/DPI/color/ICC/crop/spine/cover-template/blank-pages [FR-121/122]
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

- [ ] T-P9-01 Export pipeline: pause-gate (C-07), manifest + checksums, content packaging per FR-125, automated secret-scan gate (`src/portability/export.ts`) [FR-125/126/129, EC-G11]
- [ ] T-P9-02 Import validation: structure, manifest versioning (migrate old / reject future), checksums, path-safety (traversal/symlink/executable), disk pre-check [FR-128, EC-G01–G05, EC-G09/G10]
- [ ] T-P9-03 Import modes + conflict rules: as-new (ID remap), replace (confirmation), characters-only, templates-only [FR-127, EC-G06/G07/G12]
- [ ] T-P9-04 Staged-then-committed atomic import; interruption rollback fixture [FR-128, EC-G08]
- [ ] T-P9-05 Round-trip fidelity test: export → fresh instance import → deep-equality of project content
- [ ] T-P9-06 E2E: US9 scenarios; SC-005 full sweep (DB dump + logs + archives)

**Checkpoint**: every EC-G fixture behaves as cataloged. **DoD**: CHK216–219, CHK024 satisfiable.

---

## Phase 10 — Hardening & End-to-End Acceptance

**Preconditions**: Phases 1–9.
**User-visible outcome**: production-confidence release candidate + operator documentation.
**Dependencies**: all prior phases.

- [ ] T-P10-01 Full failure-injection sweep: kill matrix × all pipelines; disk-full; network loss; provider fault storm (mock) [SC-002, test-strategy §4]
- [ ] T-P10-02 Integrity scan end-to-end: manual asset deletion/corruption fixtures → flags + regeneration offers [FR-097, EC-C07, IM-20]
- [ ] T-P10-03 Privacy suite final run: payload-minimization snapshots, telemetry-absence network capture, permissions audit [FR-130–134, CHK206–215]
- [ ] T-P10-04 Complete Arabic UI journey E2E from quickstart, timed against SC-001; SC-012 responsive audit
- [ ] T-P10-05 [P] Performance validation vs plan.md goals (UI p95, 24pp render <120 s, cold start <10 s)
- [ ] T-P10-06 [P] Operator documentation final pass: quickstart accuracy on a clean machine, troubleshooting table verification
- [ ] T-P10-07 Run all five checklists; record evidence; fix every failed item or document accepted deviation with user sign-off
- [ ] T-P10-08 Release checkpoint: constitution compliance review; RR-13 legal-review scheduling confirmed before commercial launch

**Checkpoint**: all checklists green/evidenced. **DoD**: SC-001…SC-012 all verified; risk register statuses current.

---

## Dependencies & Execution Order

```text
P0 ──▶ P1 ──▶ P2 ──▶ P3 ──▶ P6 ──▶ P7 ──▶ P8 ──▶ P10
        │                    ▲
        ├──▶ P4 ────────────┤ (P4 parallel to P2/P3 after T-P4-01)
        └──▶ P5 ────────────┘ (P5 needs P4 contract types)
P9 needs P2+P6; can run parallel to P7/P8.
```

MVP slice = P0–P6 + minimal P7 (preview): produces a reviewable book. Print delivery requires P8.

## Traceability

- Every FR appears in ≥1 task Ref; every EC-\* case appears in a task or checklist; SC-001…012 land in P6–P10 checkpoints; IM rows covered by T-P6-03 unit suite. Audit repeated at each phase exit (analyze-stage discipline).

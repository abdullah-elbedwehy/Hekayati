# Risk Register

**Feature**: `001-hekayati` | Scale: Likelihood/Impact H/M/L. Gates reference `research.md`.

| ID | Risk | L | I | Mitigation | Status/Owner |
|---|---|---|---|---|---|
| RR-01 | **Codex subscription image generation unavailable or non-compliant** (gate G1-I) | H | M | G1-I failed as expected: image mode ships visibly unavailable with the recorded reason; provider slot remains for a future compliant workflow. No API-key fallback ever. | Realized/contained; blocks Codex image mode only |
| RR-02 | Codex CLI programmatic text mode breaks (version churn, auth flow changes, structured-output flag instability) | M | M | G1-T passed on 0.144.3 with exact model `gpt-5.5`; catalog-listed `gpt-5.6-sol` still failed its direct probe. Adapter isolates CLI specifics; runtime version/exact-model/schema health is mandatory; mock keeps product testable. | Verified baseline; monitor in feature 005 |
| RR-03 | **Character identity drift across pages** — hardest quality problem | H | H | Sheet-first references; per-page regeneration; consistency review; human approval; honest “recognizable, not exact” positioning. G2 reliable-count remains unset, so real Gemini creative generation stays unavailable rather than using an assumed threshold. | Open; G2 blocked by missing credential |
| RR-04 | Gemini model IDs renamed/deprecated or unavailable to this account | H | L | Current official stable IDs are verified and configurable (FR-107); exact account listing/direct probes and per-batch availability checks (FR-098) still fail closed; UI gives remediation. | Public IDs verified; account gate unavailable |
| RR-05 | Arabic shaping/print defects reach the printer | M | H | G3 passed for pinned Chromium/fonts and the synthetic corpus; retain golden/visual regression, preflight font/shaping checks, and physical proof-print guidance. | Baseline verified; Phase 8 residual risk |
| RR-06 | **No automatic backup; single-disk data loss** (child photos, paid work) | M | H | Accepted per scope. Loud UI warnings (FR-133); manual export encouraged after milestones; risk explicitly communicated. Revisit post-v1 (Time Machine guidance in quickstart) | Accepted |
| RR-07 | Provider safety filters refuse legitimate child illustrations | M | M | Prompt hygiene (respectful, clothed, wholesome descriptors); no auto-variation retries (FR-116); operator rewording flow; document known trigger patterns as they're found | Phase 4/6 |
| RR-08 | Keychain via `security` CLI could expose a secret in argv (process table) | M | L | Resolved in Phase 1: installed CLI help verifies trailing `-w` prompt mode; wrapper uses `spawn` without a shell and sends the secret through stdin, while fake-binary tests prove argv/error isolation (R8) | Resolved/contained 2026-07-14 |
| RR-09 | Quota exhaustion mid-book stalls delivery timelines | H | L | Quota-pause + manual continue-with-Gemini (FR-096); completed work preserved; per-page provenance | Designed |
| RR-10 | Egyptian Arabic register quality varies by model | M | M | ReviewFindings register checks (FR-047); regenerate text-only scope; operator is final judge (assumption) | Phase 6/7 |
| RR-11 | Ghostscript CMYK conversion shifts colors unacceptably | M | M | Local G3 conversion/fail-closed mechanics passed. Keep RGB-default policy (C-12); convert only with the selected printer ICC; require converted proof approval (EC-F09). | Mechanism verified; printer-specific risk remains Phase 8 |
| RR-12 | Local machine compromise exposes child photos (no app-level auth) | L | H | OS user account + FileVault recommendation in quickstart; 0700/0600 permissions (FR-130); loopback-only; accepted residual risk per C-02 | Accepted + quickstart |
| RR-13 | Legal exposure: consent wording, child-image privacy, commercial use | M | H | **Pre-launch legal review required** (FR-135): consent language, privacy policy, provider ToS for child images, printing-vendor data handling. Spec makes no legal claims | Blocker for commercial launch, not for build |
| RR-14 | Preview PDFs leak print-quality assets or hidden local/internal data | L | M | Deterministic ~150-DPI derivative-only render, mandatory watermark/footer, HTML escaping, local bundled fonts, deny-all network/file/script policy, PDF resource/metadata inspection, and hard size/send gate (C-06, FR-120/124, SC-007) | Feature 008 |
| RR-15 | Scope creep re-introducing out-of-scope features | M | M | Spec §Out-of-scope is amendment-gated; constitution II; analyze-stage checks | Continuous |
| RR-16 | Single maintainer bus-factor on bespoke scheduler | L | M | Scheduler contract fully specified (not tribal knowledge); heavy behavior tests; ~small codebase by design | Phase 5 |
| RR-17 | Hostile browser content reaches the loopback API through DNS rebinding, forged authority/source headers, CORS/PNA, or CSRF | M | H | Canonical literal-IP listener and authority, proxy trust disabled, exact-origin source checks, runtime-only CSRF token, no CORS/PNA opt-in, and raw-HTTP negative tests that prove zero route dispatch or mutation (FR-147/148, SC-014, R13) | Phase 1 |
| RR-18 | Local photo-quality checks over-warn, miss defects, or are mistaken for biometric/age judgments | M | M | C-20 limits automatic checks to explainable local image metrics; subjective observations are operator-entered; warning source and reason stay visible; overrides are preserved; synthetic fixtures cover each category. No identity embedding, age estimator, automatic merge, or provider analysis. | Feature 003; advisory residual risk accepted |
| RR-19 | Customer approval is attached to the wrong preview, a new preview erases/borrows prior authorization, or printer geometry silently changes approved composition | L | H | Split preview-cycle/content-approval heads; customerContentHash vs immutable contentAuthorizationHash; exact output/cycle/gate/action ledger; reason-specific IM-19/20 guard; one-pass invalidation; deterministic composition compatibility and hard migration block (FR-085–087, C-26/C-27) | Feature 008 guard; feature 009 consumption |
| RR-20 | A mixed/crash-corrupt portability snapshot, duplicate replay side effect, stuck scope lock, or externally copied child-photo archive causes loss/disclosure | M | H | Durable hierarchical drain/snapshot/exclusive admission with no TTL unlock; one synchronous canonical snapshot-row/media-hold transaction before async staging; closed FR-160 action ledger, prepared/unlink ledgers and restart recovery; strict scoped manifest + two-pass secret/integrity gate; managed 0700/0600 archive; UI names child-photo scope and warns downloaded copies are external/untracked. External-copy custody remains an operator risk. | Feature 010; repeat real Studio participant in 011/Phase 10 |

## Feasibility gates (summary — normative detail in research.md)

| Gate | Result | Consequence |
|---|---|---|
| G1-T | **PASS** | Codex text may be enabled only while runtime version/login/model/schema health passes |
| G1-I | **FAIL (expected)** | Codex image mode is unavailable with the recorded reason; no fallback |
| G2 | **FAIL / PENDING (environment)** | Reliable counts remain unset; real Gemini creative generation/feature 007 is blocked |
| G3 | **PASS** | PDF-dependent planning may proceed; printer-specific proof remains mandatory |
| G4 | **FAIL (environment)** after official-ID verification | Gemini modes remain unavailable until a configured credential passes exact account probes |

## Genuine blockers requiring user input

None for local-foundation, customer/library, story-authoring, mock-provider, or scheduler work. Before real Gemini connection acceptance and feature 007's live creative gate, the operator must configure the Gemini credential so G4 and G2 can be rerun. Commercial launch separately requires RR-13 legal review.

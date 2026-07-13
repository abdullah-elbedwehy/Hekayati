# Risk Register

**Feature**: `001-hekayati` | Scale: Likelihood/Impact H/M/L. Gates reference `research.md`.

| ID | Risk | L | I | Mitigation | Status/Owner |
|---|---|---|---|---|---|
| RR-01 | **Codex subscription image generation unavailable or non-compliant** (gate G1-I) | H | M | Expected-fail posture already designed in: Gemini image path is the product default; Codex image mode ships as visibly unavailable with recorded reason; provider slot kept for future compliant support. No API-key fallback ever. | Phase 0 gate; blocking for Codex image mode only |
| RR-02 | Codex CLI programmatic text mode breaks (version churn, auth flow changes, structured-output flag instability) | M | M | Gate G1-T before enabling; adapter isolates CLI specifics; validated-JSON fallback prompting; pin tested CLI version in quickstart; mock provider keeps product testable | Phase 0/4 |
| RR-03 | **Character identity drift across pages** — hardest quality problem | H | H | Sheet-first reference strategy (R12); C-08 participant threshold from measured G2; per-page regeneration; consistency review view (FR-119); human approval gates; honest "recognizable, not exact" positioning (FR-016) | Continuous; G2 measures baseline |
| RR-04 | Gemini model IDs renamed/deprecated (requested defaults postdate training data) | H | L | IDs are configuration (FR-107); G4 verification at Phase 0; runtime availability checks (FR-098); UI surfaces model errors with remediation | Phase 0 |
| RR-05 | Arabic shaping/print defects reach the printer | M | H | Chromium engine choice (R9); gate G3 golden corpus; preflight font/shaping checks; physical proof-print recommended in quickstart before first customer order | Phase 0/8 |
| RR-06 | **No automatic backup; single-disk data loss** (child photos, paid work) | M | H | Accepted per scope. Loud UI warnings (FR-133); manual export encouraged after milestones; risk explicitly communicated. Revisit post-v1 (Time Machine guidance in quickstart) | Accepted |
| RR-07 | Provider safety filters refuse legitimate child illustrations | M | M | Prompt hygiene (respectful, clothed, wholesome descriptors); no auto-variation retries (FR-116); operator rewording flow; document known trigger patterns as they're found | Phase 4/6 |
| RR-08 | Keychain via `security` CLI exposes secret in argv (process table) briefly | M | L | Single-user machine reduces exposure; Phase 1 verification: prefer stdin-interactive mode or adopt `@napi-rs/keyring` if material (R8) | Phase 1 |
| RR-09 | Quota exhaustion mid-book stalls delivery timelines | H | L | Quota-pause + manual continue-with-Gemini (FR-096); completed work preserved; per-page provenance | Designed |
| RR-10 | Egyptian Arabic register quality varies by model | M | M | ReviewFindings register checks (FR-047); regenerate text-only scope; operator is final judge (assumption) | Phase 6/7 |
| RR-11 | Ghostscript CMYK conversion shifts colors unacceptably | M | M | RGB-default policy (C-12); conversion only with printer ICC; converted proof approval step (EC-F09); printer may accept RGB delivery | Phase 8 |
| RR-12 | Local machine compromise exposes child photos (no app-level auth) | L | H | OS user account + FileVault recommendation in quickstart; 0700/0600 permissions (FR-130); loopback-only; accepted residual risk per C-02 | Accepted + quickstart |
| RR-13 | Legal exposure: consent wording, child-image privacy, commercial use | M | H | **Pre-launch legal review required** (FR-135): consent language, privacy policy, provider ToS for child images, printing-vendor data handling. Spec makes no legal claims | Blocker for commercial launch, not for build |
| RR-14 | Preview PDFs leak print-quality assets | L | L | Downsampled preview pipeline (C-06) + watermark + size budget (SC-007) | Designed |
| RR-15 | Scope creep re-introducing out-of-scope features | M | M | Spec §Out-of-scope is amendment-gated; constitution II; analyze-stage checks | Continuous |
| RR-16 | Single maintainer bus-factor on bespoke scheduler | L | M | Scheduler contract fully specified (not tribal knowledge); heavy behavior tests; ~small codebase by design | Phase 5 |

## Feasibility gates (summary — normative detail in research.md)

| Gate | What must be true | Fail consequence |
|---|---|---|
| G1-T | Codex text: programmatic + structured + quota-detectable + compliant | Codex text mode disabled with visible reason; Gemini text remains |
| G1-I | Codex images: all 7 questions pass | Codex image mode marked unavailable (RR-01 posture); product unaffected otherwise |
| G2 | Gemini identity consistency acceptable; limits measured | Adjust capability matrix, C-08 threshold, possibly style guidance; if catastrophic → escalate to user (product-level decision) |
| G3 | Arabic PDF pipeline correct (shaping, fonts, bleed) | Blocker: alternative renderer research before Phases 7–8 proceed |
| G4 | Gemini model IDs verified current | Config defaults updated; no code impact |

## Genuine blockers requiring user input

None for specification completion. For implementation: none upfront — G1-I failure is pre-accommodated; G2/G3 catastrophic failure would trigger a user decision (documented above). Commercial launch has one hard external dependency: RR-13 legal review.

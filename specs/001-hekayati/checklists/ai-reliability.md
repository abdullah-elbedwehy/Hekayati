# AI Reliability Checklist: Hekayati

**Purpose**: Verify provider integration robustness, output validation, and no-silent-degradation guarantees.
**Created**: 2026-07-14 | **Feature**: [spec.md](../spec.md), [provider-contract](../contracts/provider-contract.md)

## Contract & Validation

- [ ] CHK101 Domain code imports zero provider-specific symbols (lint-enforced boundary) (Constitution VI)
- [ ] CHK102 Every structured output validated against canonical schemas before persistence; invalid never stored (FR-091, SC-004)
- [ ] CHK103 Alien characterRef (non-participant) fails validation — providers cannot invent people (FR-041)
- [ ] CHK104 PagePrompt always carries the four mandatory negative-constraint classes (extra-person, in-image text, onomatopoeia, photo-real face)
- [ ] CHK105 Deny-list blocks living-artist/franchise prompts; transformation-to-original flow shown for confirmation (FR-071)

## Failure Semantics

- [ ] CHK106 Every taxonomy row has: one synthesized-error normalization test + retry-policy assertion (FR-092)
- [ ] CHK107 Safety refusal: no auto prompt-variation retries; step+page identified; safe work preserved (FR-116)
- [ ] CHK108 malformed_output retains redacted raw payload for diagnosis
- [ ] CHK109 Late/stale/canceled results rejected at commit; test covers cancel-then-provider-returns (EC-C06, EC-E08)
- [ ] CHK110 Retry never duplicates assets (content addressing + idempotency verified under forced double-run)

## Capability Honesty

- [ ] CHK111 Model availability checked before batches; unavailable model surfaces error, never substitutes (FR-098)
- [ ] CHK112 Codex image mode reflects gate G1-I record verbatim in UI; no API-key path exists in code (FR-100/102)
- [ ] CHK113 Economy image model shows persistent consistency warning (FR-108)
- [ ] CHK114 C-08 participant threshold reads from capability matrix values (not hardcoded) (FR-075)
- [ ] CHK115 Reference budgeting reductions recorded in provenance + UI notice (capability matrix §4)

## Quota & Switching

- [ ] CHK116 Quota-pause pauses only affected provider's jobs; running siblings commit normally
- [ ] CHK117 Wait/switch decision applies only to remaining + explicit regenerations; audit event written (SC-009)
- [ ] CHK118 Provenance shows mixed-provider books accurately per page (E5)

## Gates

- [ ] CHK119 G1-T/G1-I/G2/G3/G4 scorecards completed and recorded in research.md before dependent phases (Constitution XII)
- [ ] CHK120 Any Assumed cell in capability matrix verified or downgraded before Phase 6 exit

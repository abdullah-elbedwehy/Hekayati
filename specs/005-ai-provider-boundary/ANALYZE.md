# Analyze: 005 AI Provider Boundary

**Verdict**: PASS — ready for implementation

**Date**: 2026-07-14

**Open clarify blockers**: none

**External live constraints**: Gemini G2/G4 remain environment-blocked because no operator credential is configured. Fixture/mock implementation may proceed; live Gemini must remain visibly unavailable and may not be reported as PASS.

## Cross-artifact result

| Area | Result | Evidence |
| --- | --- | --- |
| Scope | PASS | The leaf owns canonical contracts, adapters, prompt/reference policy, settings/credentials/capabilities, fixtures, and live scripts. It explicitly defers jobs, retries, quota decisions, content persistence, creative review, and generated assets to 006/007. |
| Requirements | PASS | US8; FR-090–091/094–095/098–108/134; SC-004; T-P4-01–10; and CHK101–105/108/111–115/119–120 map to A-005-01–13 and 005-C01–28. |
| Gate honesty | PASS | G1-T stays runtime-checked; G1-I is a fixed Codex-image unavailable result; nullable G2 limits block rather than inventing counts; G4 missing credential is `not_configured`, not a fixture/live success. |
| Contract | PASS | Shared capability types now support per-operation reasons and nullable verified limits. Text request/result and strict image MIME are explicit. Every structured output visibly requires schemaVersion 1. |
| Privacy | PASS | Keychain-only lifecycle, per-call retrieval, constant masking, resolver-only image bytes, minimal task allow-lists, no store/original handle, and content-free malformed diagnostics are testable boundaries. |
| Failure semantics | PASS | All canonical categories remain representable; mock scripts cover all, adapters normalize applicable provider signals, and 006 retains exclusive retry/pause/switch ownership. |
| No silent degradation | PASS | Exact provider/model selection, cache/forced refresh, hash-bound prompt confirmation, deterministic reference budgeting, and explicit null/insufficient blocks make every substitution/reduction visible. |
| Persistence | PASS | Only settings v3 and Keychain lifecycle persist here. Provider outputs are returned validated but not stored; later jobs/assets attach immutable provenance and commit preconditions. |
| Testability | PASS | Fixture executable/transport, fake Keychain, injected clock, deterministic PNG/output, fault scripts, secret scans, import lint, responsive axe, restart, and zero-egress paths require no live provider. |
| Dependencies | PASS | Implemented 002–004 interfaces are named. 006/007/010 consumers receive strict outputs without forward-implementing their state machines. |
| UX/accessibility | PASS | Settings/Health states, destructive credential actions, economy/Codex warnings, exact model IDs, timestamps, bidi, keyboard, focus, target, axe, and three viewports have acceptance evidence. |

## Requirement-to-task trace

| Requirement group | 005 task / acceptance | Intentionally staged downstream completion |
| --- | --- | --- |
| FR-090–091, SC-004 | T-P4-01/02; A-005-01/03/07; 005-C01–06 | 006/007 callers persist only validated results under job commit rules. |
| FR-092 | T-P4-02/03/04/05; A-005-03/05/07 | CHK106 retry table, quota pause, and late-result commit behavior remain 006. |
| FR-094 | T-P4-01/02; A-005-02/07; 005-C18 | 006 writes task provenance; 007/asset store writes generated artifact provenance. |
| FR-095 | T-P4-08; A-005-08/09 | 006 applies explicit switches only to future/remaining/regenerated jobs and records decisions. |
| FR-098 | T-P4-02/04/05/08; A-005-05/07/08 | 006 forces refresh before batches. |
| FR-099 | T-P4-03; A-005-02/03 | 006/007 use it for durable/fan-out/full-book paths. |
| FR-100–103 | T-P4-05/08; A-005-05/09 | 007 consumes Codex text; image remains unavailable until a future compliant gate amendment. |
| FR-105–108 | T-P4-04/08/10; A-005-06–09/12 | SC-005 full export scan remains 010/Phase 10. |
| FR-070–073/115 | T-P4-06; A-005-10 | 007 reuses the same compiler/confirmation component in generation/review. |
| FR-075/C-08, FR-134 | T-P4-02/07; A-005-04/11; 005-C15–18 | 006 re-resolves bytes/current consent immediately before dispatch; 007 consumes the budget. |
| T-P4-09 | A-005-13 | Real Gemini PASS requires operator configuration; absence is an honest SKIP/FAIL-environment record. |

## Fixes made during analyze

1. Changed provider capabilities so text and image have separate safe unavailability reasons; mixed Codex capability can no longer be misrepresented by one provider-wide message.
2. Made max-reference and reliable-character boundaries nullable until verified. This resolves the contract-versus-capability-matrix contradiction and prevents invented G2 defaults.
3. Required `schemaVersion: 1` explicitly in all five structured outputs instead of leaving it only in prose.
4. Defined the previously implicit `TextRequest`/`TextResult` and narrowed image MIME/provider metadata.
5. Replaced raw malformed-output retention with privacy-safe structural diagnostics. This aligns CHK108 with Constitution III/XIV and prevents child/profile/story bodies entering logs.
6. Defined a strict provider-neutral GenerationTaskV1 union and payload allow-list rather than an unconstrained object or provider-specific prompt type.
7. Separated subsystem delivery state, credential/auth state, exact model availability, per-operation capability, and G2 measurement state.
8. Defined settings v3/economy-tier persistence and explicit Keychain API semantics without storing a key-presence secret surrogate in Settings.
9. Bound prompt transformations and reference reductions to explicit hash/provenance/UI evidence; neither can happen silently.
10. Defined fixture-only automation and opt-in live scripts so CI cannot consume quota, access the real Keychain/Codex auth, or turn a missing credential into a false success.

## Alternatives rejected

- Treat documented Gemini limits (14 or planning example 3) as runtime defaults: rejected because G2/G4 are unverified and Constitution XII requires evidence.
- Auto-fallback from Codex image or unavailable Gemini model to mock/another provider: rejected by Constitution VII and FR-095/098/102.
- Store the Gemini key, last four characters, hash, or encrypted copy in SQLite: rejected; Keychain presence plus constant masking is sufficient.
- Cache a Gemini key on a long-lived client/provider object: rejected; per-call retrieval limits lifetime and preserves replacement/deletion semantics.
- Let adapters query the library/asset store or accept paths/original IDs: rejected by FR-134 and the implemented 003 reference boundary.
- Log redacted raw provider output: rejected because arbitrary story/profile content remains sensitive even when credential patterns are removed.
- Implement retry/quota switching in adapters: rejected; it would split scheduler authority and enable duplicate/silent behavior.
- Parse the Markdown capability matrix at runtime: rejected; runtime capability probes and versioned measured configuration are machine contracts, documentation is evidence.
- Ship a provider-specific domain DTO: rejected by Constitution VI and the import firewall.

## Counts and gates

- Phase 4 has 10 unique master task IDs: T-P4-01–10.
- The leaf has 13 provider/settings acceptance scenarios: A-005-01–13.
- The slice checklist has 28 evidence items: 005-C01–28.
- Binding canonical checklist scope: CHK101–105, CHK108, CHK111–115, CHK119–120. CHK106/109/110/116–118 remain 006/007-owned.
- No privacy, money, legal, or architecture choice requires user clarification. Live provider calls remain opt-in; the missing Gemini credential is an external capability constraint, not permission to alter the product.

Analyze PASS is implementation approval under the authorized full-delivery loop. Implementation must preserve concurrent Flow/spec edits, satisfy the checkpoint, and write `IMPLEMENTATION_NOTES.md` before its feature commit.

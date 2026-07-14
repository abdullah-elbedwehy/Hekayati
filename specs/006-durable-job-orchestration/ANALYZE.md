# Analyze: 006 Durable Job Orchestration

**Verdict**: PASS — ready for implementation

**Date**: 2026-07-14

**Open clarify blockers**: none

**External live constraints**: Gemini G2/G4 remain environment-blocked, but 006 acceptance is deterministic/mock-only. No real-provider call or invented capability is required.

**Pending amendment isolation**: slice 012/Flow is unapproved and remains outside this implementation. The scheduler is extensible but does not add `external_manual`, `waiting_external_import`, Prompt Pack, or import behavior.

## Cross-artifact result

| Area | Result | Evidence |
| --- | --- | --- |
| Scope | PASS | The leaf owns generic jobs, claims, leases, retries, recovery, pre-dispatch privacy, provider dispatch, commit fencing, quota/storage incidents, queue API/UI, and fixture evidence. It explicitly defers every creative domain graph/result and 012. |
| Requirements | PASS | US4 orchestration; FR-004/021/025/065, FR-092–096, FR-109, FR-111, FR-112, FR-113, FR-114, FR-134; SC-002/009; T-P5-01–09; and routed checklist IDs map to A-006-01–15 and 006-C01–31. |
| Architecture | PASS | One process/SQLite/worker, no daemon/dependency. Validated JSON jobs use indexed SQL CAS; registered executor/guard/committer ports preserve provider-neutral domain boundaries. |
| Lease safety | PASS | Boot ID + monotonic expiry is now supplemented by a unique claim token/attempt fence, closing same-worker reclaim and old-attempt commit holes. |
| Idempotency | PASS | Stable intent/key/request hash distinguishes duplicate delivery, automatic retry, explicit regeneration, and provider successor work without mutating success history. |
| Privacy | PASS | Metadata/consent check occurs before capability/adapter network; a second guard closes the gap; only clean selected bytes are loaded ephemerally. Raw malformed bodies were removed from conflicting canonical text. |
| Failure semantics | PASS | Every category has exact retry/pause behavior; rate-limit retries are bounded; cancellation and storage/database outcomes are explicit; adapters remain policy-free. |
| Human review | PASS | Gate records are durable and dependency-blocking but have no scheduler auto-approval/API path. Owning features must verify target version in one transaction. |
| No silent degradation | PASS | Quota incidents are provider-wide, decisions scope-specific, alternate target explicit, and successors immutable/linked. Completed work and global Settings remain unchanged. |
| Ordinary switching | PASS | Global provider/model/tier changes have an impact preview and one atomic Settings+successor confirmation; running/completed work retains exact provenance and concurrency-only edits do not retarget content. |
| Crash/storage | PASS | Recovery order, prior-boot requeue, prepared-file compensation/GC, persistent storage stop, and explicit health probe are testable for every required kill/failure point. |
| Testability | PASS | Injected monotonic/wall clocks, workers, executors, sheet lineage, storage faults, and deterministic provider fixtures cover all behavior without customer data or live providers. |
| UX/accessibility | PASS | Queue/Health content, state-valid controls, exact quota dialog, bidi/focus/targets/reduced-motion/axe, three viewports, restart, and zero-egress have acceptance evidence. |

## Requirement-to-task trace

| Requirement group | 006 task / acceptance | Intentionally staged downstream completion |
| --- | --- | --- |
| FR-109/112/114, C-09 | T-P5-01/06/08; A-006-01–03/13–14; C01–08/C27 | 007 builds the canonical creative DAG and supplies actual review owner transactions; 011 registers isolated Studio jobs. |
| FR-065/093, SC-002 | T-P5-02/05; A-006-05/08; C09–11/C26 | 007–010 commit actual page/PDF/export result versions through the port. |
| FR-092/113 | T-P5-03/05/09; A-006-04/08/12; C18–21/C24–26 | Phase 10 repeats full creative/PDF/import kill matrix. |
| FR-096/SC-009 | T-P5-04; A-006-09–10; C22–23 | 007 E5 proves mixed provider provenance on real page versions. |
| FR-004/021/025/134 | T-P5-01; A-006-06–07; C12–17 | 007 supplies approved sheet lineage and generation producers; 011 consumes same port. |
| FR-111/138 queue | T-P5-06/07/09; A-006-11–15; C21/C25–30 | Later screens link job result/gate IDs to creative/PDF/Studio views. |
| CHK106–110/116–118 | T-P5-02–05; A-006-04–10 | CHK118 final per-page artifact proof repeats in 007; scheduler fixture proves task-level mixed provenance now. |
| CHK016–017/410–412 | T-P5-04–07; A-006-08–15 | Full first-book Phase 10 repeats with every integrated stage. |

## Fixes made during analyze

1. Added a per-claim unique fencing token and attempt to the lease/commit precondition. Worker ID + expiry alone allowed a stale attempt to pass after same-worker reclaim.
2. Replaced ambiguous `attemptScope` idempotency input with a stable producer-supplied intent ID and separate request hash; defined duplicate, retry, regeneration, and provider-successor behavior.
3. Removed canonical instructions to retain raw malformed provider samples from US4, the scheduler table, data model, and edge cases. Only 005 privacy-safe structural diagnostics may persist.
4. Replaced “unlimited within batch window” rate-limit retries with three bounded retries honoring normalized Retry-After or 15s/1m/5m. Retry counts are explicitly retries after the initial attempt.
5. Defined exact dependency validation, cycle/cross-scope rejection, and blocked-descendant behavior instead of leaving failure/cancel propagation implicit.
6. Made human review gates require ordinary `succeeded` dependency state after an owner-verified transaction; removed the ambiguous “acknowledged where allowed” shortcut.
7. Ordered pre-dispatch so current consent/reference metadata rejects before capability or adapter network, repeats after the capability ticket, then loads only approved bytes.
8. Defined the approved-sheet lineage port and fail-closed absence behavior without forward-implementing feature 007.
9. Defined immutable provider-switch successors, provider-wide quota incidents, per-scope decisions, and no automatic global Settings change.
10. Distinguished operator, quota, credential, dependency/retry, and storage pauses; generic resume cannot erase a required remediation.
11. Defined persistent pause-all and explicit storage write probe, plus database-unavailable halt behavior.
12. Bound startup recovery and worker start to existing GC/data-root lock and verified loopback readiness; no queued work means no provider call.
13. Defined a specialized indexed/CAS repository over existing JSON documents, preserving R2/R3 while making atomic claim/unique key behavior implementable.
14. Added strict safe history/API projections, expected-revision mutations, failure-injection points, coverage floor, and synthetic UI evidence requirements.
15. Separated quota continuation from ordinary global Settings switches and specified impact preview, atomic Settings+successor commit, unavailable-target pause, and explicit post-wait availability resume.

## Alternatives rejected

- In-memory queue with replay: rejected because a crash cannot prove exactly-once commit or preserve pause/gate state.
- Redis/BullMQ/Temporal/worker daemon: rejected by R3 and the single-process/local simplicity constraints.
- Lease ownership by worker ID only: rejected because same-worker reclaim permits an old attempt to impersonate the new claim.
- Wall-clock lease deadlines: rejected because EC-E05 can expire or immortalize work.
- Mutable provider/model on an existing job after quota: rejected because it corrupts intent/idempotency/history; linked successors are explicit.
- Quota switch that rewrites global Settings: rejected because the dialog is work-scope-specific and would silently affect unrelated future projects.
- Auto-cancel descendants of a failed dependency: rejected because it discards operator choices; exact blocking remains visible.
- Queue-level review approval button: rejected because it bypasses owner-specific version/review checks and Constitution IV.
- Let adapters resolve photos, consent, assets, or retry: rejected by the 003/005 boundaries and single scheduler authority.
- Store redacted raw provider bodies: rejected because child/profile/story content remains sensitive even when credentials are masked.
- Force a capability network probe before current consent check: rejected because revoked photo-bearing jobs must make zero adapter/network call.
- Pre-implement Flow external-wait state: rejected because slice 012 is a pending unapproved graph amendment.

## Counts and gates

- Phase 5 has 9 unique master task IDs: T-P5-01–09.
- The leaf has 15 acceptance scenarios: A-006-01–15.
- The slice checklist has 31 evidence items: 006-C01–31.
- Canonical ownership: CHK016–017, CHK106–110, CHK116–118, pre-dispatch CHK206/208, CHK410–412.
- No privacy, legal, money, product-shape, or architecture choice remains equally plausible enough to require user clarification. The conservative choices preserve work, minimize provider calls, and make every transition explicit.

Analyze PASS is implementation approval under the authorized full-delivery loop. Implementation must preserve concurrent Flow/spec/prototype edits, satisfy the checkpoint, and write `IMPLEMENTATION_NOTES.md` before its feature commit.

# Feature Specification: Durable Job Orchestration

**Feature ID**: `006-durable-job-orchestration`

**Status**: Ready for implementation

**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

**Delivery tasks**: [Phase 5](../001-hekayati-product-bible/tasks.md#phase-5--durable-task-scheduling)

This leaf owns delivery and acceptance; it does not restate or override canonical requirements. Precedence remains constitution → product bible → shared scheduler/provider contracts → this slice → implementation.

## Outcome and boundary

Long-running provider work executes as an observable deterministic queue that survives process and machine failure, prevents duplicate or stale commits, respects dependencies and human gates, and never changes provider/model or retries outside the documented policy. The operator sees why every item is waiting and can pause, resume, cancel, retry, reprioritize, or make an explicit quota decision in Arabic RTL.

Primary ownership is the durable-orchestration portion of **US4; FR-092, FR-096, FR-109, FR-111, FR-112, FR-113, FR-114; SC-002, SC-009; C-09; T-P5-01–09; CHK016–017, CHK106–110, CHK116–118, CHK206/208, CHK410–412**.

This slice implements a generic scheduler, worker/executor ports, current-consent/reference resolution, provider dispatch, commit fencing, queue API/UI, and fixture-only acceptance graph. It does **not** construct or persist character sheets, stories, scenes, page versions, approvals, PDFs, Studio records, invalidation consequences, or external-import workflows. Those owners register executors, commit guards, and graph producers in 007–011. The pending unapproved 012 amendment is not part of this checkpoint.

No real provider is required for acceptance. Automated evidence uses the deterministic mock and injected clocks/failures. The missing Gemini credential and G2/G4 measurements do not block scheduler delivery and may not be bypassed or represented as success.

## Readiness decisions

1. **One scheduler owns every execution policy.** Adapters return one validated result or normalized failure and never retry, pause, switch, persist, or create an asset. Only `src/jobs/**` may invoke generation operations outside the explicit 005 connection-test path.
2. **Jobs persist canonical requests, never runtime material.** A job stores a strict text/structured request or `ImageRequestDraft`, exact provider/model/operation target, version snapshot, settings hash, dependency IDs, and result references. It never stores `ResolvedImageRequest`, bytes, paths, secrets, original-asset IDs, raw prompts/responses beyond already-authorized canonical product content, or arbitrary provider payloads.
3. **Job types are registered, not guessed.** The scheduler accepts only a bounded registered job definition. A definition supplies a strict request schema, pre-dispatch guard/resolver, executor, and transactional commit handler. Unknown types fail before enqueue. Slice 006 production starts with infrastructure and human-gate primitives; fixture executors exist only in test runtime.
4. **The DAG is validated at enqueue.** Dependencies must exist, be unique, exclude self, use the same project/work scope unless a registered definition explicitly permits otherwise, and remain acyclic. A dependency must reach `succeeded`; `waiting_review`, paused, failed, and canceled dependencies keep descendants blocked with exact IDs/reasons. No failure silently cancels descendants.
5. **Priority is simple and deterministic.** Project priority is an integer 1–5, default 3; higher value wins, then job creation sequence/ID gives FIFO. Reprioritization affects only unclaimed work. The API returns the derived queue position; it is not persisted as truth.
6. **Every claim has a fencing token.** A lease contains `workerId`, per-process `bootId`, unique `claimToken`, and monotonic expiry. Commit and heartbeat require all four. Reclaim by the same worker after expiry still receives a new token, so an older attempt cannot pass merely because its worker ID matches.
7. **Lease time is never wall time.** Lease/heartbeat/stall arithmetic uses an injected monotonic clock. ISO timestamps exist for operator history only. A new process creates a new `bootId`; every prior-boot claim is expired regardless of wall-clock movement.
8. **Idempotency is tied to generation intent.** Producers supply a stable opaque `intentId` for duplicate delivery and automatic retries. The key hashes job type, canonical request/input-version snapshot, provider/model/operation, settings hash, and intent ID. A duplicate key with the same request hash returns the existing job; a mismatched request is a hard collision error. Explicit regeneration or provider retarget creates a linked successor intent/job; it never mutates a succeeded job.
9. **Attempts are immutable history.** Claiming increments the 1-based attempt number and appends an event. Automatic retries reuse the job and idempotency key with a delayed eligibility time. Explicit operator retry appends its own decision event. No retry erases prior failure, timing, provider, or provenance.
10. **Pre-dispatch is fail-closed and ordered.** Under the active claim, the worker first re-reads the immutable input/version/reference metadata and current consent without loading bytes or calling a provider. A rejection makes zero adapter/network call. It then obtains one exact provider/model capability ticket for the batch, repeats the current guard, and only then loads selected clean derivative/sheet bytes into an in-memory resolved request immediately before generation.
11. **Sheet lineage is an injected downstream port.** Direct-photo resolution uses the implemented 003 library/asset boundary. Approved sheet references require a trusted lineage reader registered by 007; until present they fail `missing_reference_asset`. Fixture readers prove both wholly description-derived and transitively photo-derived consent behavior without forward-implementing sheets.
12. **Creative commits are transactional callbacks.** Provider output is validated before the scheduler calls the registered committer. Asset bytes are prepared atomically outside the DB transaction; the transaction rechecks running state, complete lease fence, current target lineage, and domain preconditions, then commits asset metadata, domain result/version references, job success, and history together. Any rejection discards/unlinks an uncommitted prepared file and never changes the current domain version.
13. **Retry counts mean retries after the initial attempt.** The canonical table is exact. `Retry-After` is honored for at most three rate-limit retries and is bounded to the normalized one-day maximum; without it the fixed 15s/1m/5m schedule applies. Exhausted automatic policy pauses for an explicit operator decision. This replaces the unimplementable “unlimited within batch window” phrase.
14. **Human gates never auto-pass.** A `waiting_review` job has a named gate and target version. Only the owning feature's explicit review/approval transaction may transition it to `succeeded`; descendants require that success. Queue controls display and link the gate but cannot approve creative work.
15. **Pause is reason-specific.** Project pause stops queued/blocked work; already-running attempts may finish and commit, preserving paid work. Resume affects only `paused(operator)`. Quota, credential, dependency, retry-exhausted, and storage pauses require their specific remediation/decision. Cancel marks state before signaling abort, so every late result fails commit.
16. **Quota is provider-wide; decisions are work-scope-specific.** The first quota signal opens a persisted incident and pauses queued/blocked work targeting that provider across scopes. Other providers and completed work are untouched; running siblings may finish. Each project/standalone scope records exactly `wait` or `continue remaining with <explicit available provider>`. Continue creates linked successor jobs for only that scope's remaining work; it does not rewrite global Settings or completed provenance.
17. **Ordinary Settings switches are coordinated.** Changing selected provider, exact model, or image tier previews every affected unstarted job for that operation. One explicit global confirmation atomically saves Settings and creates linked successors on the new exact target for queued/blocked/reason-paused remaining work across scopes. Claimed/running and completed work retain their old target/provenance. Concurrency-only edits affect future claims and do not rewrite intent.
18. **Storage failure is a persistent global stop.** `disk_write_failure` or `insufficient_disk_space` pauses all executable non-terminal scheduler work, stops new claims, aborts running attempts after fencing, and raises Health. Durable human review gates stay `waiting_review` but cannot release executable descendants while the incident is active. Restart does not clear it. An explicit resume requires a successful DB/directory/write-space probe. `database_unavailable` halts the worker without pretending it persisted a transition.
19. **Recovery is state-only before dispatch.** Startup runs managed temp GC first, creates a new boot ID, requeues prior-boot claimed/running jobs, keeps succeeded/canceled/failed/waiting-review and all pause reasons intact, and appends recovery events. The worker starts only after the listener has been verified at `127.0.0.1`; an empty queue makes no provider call.
20. **History is content-safe.** Jobs/events retain category, safe Arabic message, bounded structural diagnostics, retry timing, state transition, attempt, and provenance references. Raw provider output, rejected field values, prompt/image bytes, child/profile text copied from a failure, stack traces, credentials, and command output never enter DB/log/API/UI.
21. **The queue API is optimistic and no-store.** Every mutation carries expected state/version, uses the existing origin/CSRF boundary, and returns a bounded safe projection. Stale controls fail explicitly. Test-only enqueue/fault routes are registered only under the existing test-runtime flag.

## Canonical observable model

The detailed transition and failure rules remain in the [scheduler contract](../001-hekayati-product-bible/contracts/job-scheduler-contract.md). The slice implements these externally visible concepts:

- job state plus reason/disposition, dependency blockers, attempt/progress/stall data, exact provider/model, queue position, timestamps, and result/provenance references;
- append-only transition/progress/attempt/decision/rejection history;
- persisted provider-quota and storage-pause incidents;
- human-gate records that are durable but executable only by their owning feature; and
- safe audit events for quota wait/continue and provider successor creation.

Progress is 0–100 per attempt and nondecreasing within that attempt. A retry may start again at zero while history preserves the earlier attempt. Heartbeats keep ownership alive but do not count as progress; ten monotonic minutes without a new progress event sets the visible `no_progress` flag and never auto-kills the work.

## Pre-dispatch and commit boundary

For image drafts, metadata validation proves family/owner/version links, provider-eligible derivative role, approved-sheet state/lineage, and current consent before any adapter/capability network action. Originals and ordinary full-frame face working assets have no valid conversion path. The final resolver reads only the selected `providerAssetId` or approved sheet asset and returns the 005 runtime-only type; it does not mutate the draft.

For every operation, a batch capability ticket binds provider, exact model, operation, settings hash, checked time, and available result. Tickets are invalidated by settings/target changes and live no longer than the 005 cache boundary. Unavailable/mismatched targets pause with remediation; they never invoke another adapter.

The generic commit protocol deliberately knows no page/story/approval rules. A registered committer receives the validated result plus claim context and must perform its owner-specific lineage check/write inside the scheduler's SQLite transaction. Slice 006 supplies fixture committers that write only synthetic job-result documents/assets; later owners cannot bypass the lease/state/input preconditions.

## Failure and operator-decision semantics

The fixed category vocabulary is owned jointly with 005; [the canonical table](../001-hekayati-product-bible/contracts/job-scheduler-contract.md#failure-taxonomy--retry-policy-fr-092) controls scheduling. Automatic retry never changes request, prompt, references, provider, model, quality, or settings. It reuses the same intent and is canceled by any explicit cancellation, stale input, global storage stop, or provider quota incident.

Quota “continue” requires a currently available alternate for the same operation, shows the selected provider/model and affected remaining count, and creates successors only after confirmation. “Wait” records the decision and leaves work paused until a later explicit availability check/resume. New work targeting an open quota incident enters `paused(quota)` rather than probing repeatedly.

An ordinary Settings provider/model/tier change is a separate global action: the impact preview lists all unstarted remaining jobs for the affected operation, confirmation saves Settings and creates successors in one transaction, and running/completed work stays on its recorded target. Saving an unavailable exact target remains allowed but successors start visibly paused; no alternate is chosen.

## Arabic queue and Health surface

Add a main navigation destination «قائمة المهام». It groups work by project (and later standalone scope), with compact state/reason, progress, attempts, exact provider/model in bidi isolation, dependency chain, position, last update, and provenance/result links where present. Filters and state text must not rely on color. Controls expose only actions valid for the current state and describe consequences before cancel, retry, priority change, or provider continuation.

The quota dialog presents exactly two decisions when an alternate is available: «انتظار عودة المزوّد» and «متابعة المهام المتبقية عبر …». It explicitly states that completed work/provenance do not change. Health replaces the queue placeholder with depth by state, running counts per provider, storage/provider pause incidents, stalled count, worker status, and last recovery time. It never starts a provider check merely by opening.

## Acceptance scenarios

| ID | Scenario | Required evidence |
| --- | --- | --- |
| A-006-01 | Enqueue valid, duplicate, unknown-type, missing-dependency, cross-scope, self-edge, and cyclic fixture graphs. | Valid DAG orders deterministically; same key/request returns one job; every invalid graph leaves zero partial jobs. |
| A-006-02 | Race multiple claimers at the provider concurrency boundary, including same-worker reclaim after lease expiry. | Exactly one claim per slot; cap 1–4 honored; every claim has a new fence; stale claimant cannot heartbeat or commit. |
| A-006-03 | Jump wall time backward/forward while advancing injected monotonic time. | Lease/heartbeat/stall outcomes depend only on boot ID + monotonic values; ISO display time may change without ownership corruption. |
| A-006-04 | Exercise every normalized category through the mock with exact retry/backoff schedules and cancellation during delay. | Counts/timing/disposition match the canonical table; no adapter retry; no prompt/provider/model/reference mutation. |
| A-006-05 | Run duplicate/double-return, cancel-then-return, stale-lineage, expired-fence, DB-loss, and same-target concurrent commit fixtures. | One transactional result/asset at most; current result preserved; rejected bytes unlinked or GC-safe; rejection history names no content. |
| A-006-06 | Enqueue direct-photo, photo-derived-sheet, description-only, and description-derived-sheet jobs; revoke/refuse/clear consent before dispatch. | Exact consent codes; rejected cases make zero capability/adapter/network call and load zero bytes; description-only exceptions succeed. |
| A-006-07 | Substitute original, full-frame face working, cross-family, wrong-owner/version, missing, corrupt, and unapproved-sheet references. | Resolver rejects before adapter; payload snapshot contains only approved clean bytes and allow-listed metadata. |
| A-006-08 | Kill/restart during blocked, claimed, provider-running, prepared-file, post-rename/pre-DB, retry-delay, and waiting-review stages. | Completed records/assets remain; prior-boot work safely requeues; no duplicate record/refcount; pauses/gates persist; orphans are swept narrowly. |
| A-006-09 | Inject quota with 14 synthetic successes and remaining work plus another provider's jobs. | Only exhausted-provider remaining jobs pause; running successes may commit; completed/other-provider work unchanged; no automatic switch. |
| A-006-10 | Choose wait, then choose continue for one affected project while another remains paused. | Two explicit decisions and audit records; successors target the chosen exact provider/model only for selected remaining scope; originals/history remain. |
| A-006-11 | Pause/resume/reprioritize/cancel/retry and perform ordinary provider/model Settings switches with stale expected-state requests. | Only valid transitions commit atomically; global switch impact is confirmed and successor-scoped; running pause behavior is honest; late cancellation rejects; stale controls return safe conflict. |
| A-006-12 | Inject ENOSPC, EACCES, SQLite busy/unavailable, and recovery-probe failure/success. | Persistent pause-all and Health reason for storage failures; no torn/completed artifact; DB failure halts; only successful explicit probe resumes. |
| A-006-13 | Keep a healthy long job heartbeating without progress, then emit progress. | Lease remains owned; `no_progress` appears after ten monotonic minutes, clears after progress, and never auto-cancels. |
| A-006-14 | Create a named human gate and attempt scheduler/API auto-advance. | Gate survives restart, blocks descendants, names target/version, and only the injected owner transaction may mark success. |
| A-006-15 | Exercise populated Arabic queue/Health at 390×844, 1440×900, and 1920×1080, keyboard/axe/reduced motion, then `SIGKILL`/restart. | Every wait reason/action is understandable, no clipping/egress, target/focus/bidi rules pass, and fixture queue resumes without duplicates. |

## Dependencies and downstream contract

Inputs from implemented slices:

- 002: SQLite transactions, document repositories, prepared/atomic asset writes and narrow GC, process data-root lock, Settings concurrency, structured logging/redaction, Health, local request boundary, and restart fixtures.
- 003: current consent decisions, immutable family/character/look/reference records, provider-eligible direct-photo metadata resolver, and private-original separation.
- 004: immutable project/story/scene/page-map version snapshots used by future producers and commit guards; no creative generation record is written here.
- 005: strict requests/results, `ImageRequestDraft`/`ResolvedImageRequest`, provider registry/capabilities, no-retry adapters, normalized failures, provenance, deterministic mock, and cancellation.

Outputs consumed later:

- 007 registers character-sheet/story/scene/prompt/page/review executors and transactional domain committers, plus the approved-sheet lineage reader and actual book DAG producer.
- 008–010 register PDF/export/deletion coordination while preserving scheduler fences; deletion cancels before removal.
- 011 registers `studio_image` with an empty book DAG and no human gate while sharing provider concurrency/quota/consent/commit semantics.
- The pending 012 proposal may add an external-wait primitive only after its graph amendment is approved; 006 does not pre-implement it.

## Delivery mapping and checkpoint

| Master task | Primary acceptance |
| --- | --- |
| T-P5-01 | A-006-01–03, A-006-06–07, A-006-14 |
| T-P5-02 | A-006-02, A-006-05, A-006-08 |
| T-P5-03 | A-006-04, A-006-11 |
| T-P5-04 | A-006-09–10 |
| T-P5-05 | A-006-05, A-006-08 |
| T-P5-06 | A-006-13–14 |
| T-P5-07 | A-006-09–11, A-006-15 |
| T-P5-08 | A-006-02–03, A-006-08 |
| T-P5-09 | A-006-12 |

Checkpoint PASS requires T-P5-01–09, all category/lease/idempotency/consent/reference/commit/storage/restart tests, an Arabic queue/Health E2E with real process kill, zero-egress and privacy scans, ≥80% `src/jobs/**` statements/branches/functions/lines, clean check/build/audit/install/format, staged-content audit, and `IMPLEMENTATION_NOTES.md`. Real Gemini stays outside this provider-free checkpoint.

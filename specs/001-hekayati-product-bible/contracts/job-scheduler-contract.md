# Contract: Durable Job Scheduler

**Feature**: `001-hekayati` | Normative for FR-109…FR-114, FR-092. Deterministic, rule-based, DB-backed (research R3). No AI scheduling.

## Job states

```text
created → blocked(unmet dependencies) → queued → claimed → running → succeeded
   │                                      │         │         ├→ queued(notBefore)  # automatic retry remains
   └──────────────────────────────────────┴─────────┴─────────├→ failed(permanent)
                                                             ├→ paused(quota|operator|dependency|credentials|storage|retry_exhausted)
                                                             └→ canceled
waiting_review → succeeded  # only an owning feature's explicit version-checked review transaction
any pre-terminal state → canceled (operator)
```

A retryable failure within policy appends failure/retry history and returns the same job to `queued` with delayed eligibility; it does not create an observable transient `failed` state. Exhaustion follows the policy table's pause disposition. Permanent invalid/stale work enters `failed`. Every state also carries a bounded stable reason; history is append-only.

Full diagrams: `../state-machines.md`.

## Claiming & leases

- Workers claim atomically (single UPDATE … WHERE state='queued' transaction) setting `lease = { workerId, bootId, claimToken, expiresAtMono }` and incrementing the 1-based attempt. `claimToken` is unique for every claim/reclaim and is the fencing token; matching a reused worker ID is never sufficient.
- Lease arithmetic uses a **monotonic clock source persisted as (bootId, monotonicMs)** — wall-clock changes (edge case E-05) cannot prematurely expire or immortalize leases. On restart (new bootId) all leases from prior boots are expired by definition.
- Expired lease ⇒ job reclaimable with a new claim token even when the same worker later reclaims it. The old attempt's heartbeat/result is rejected at commit (below).
- Heartbeat requires the complete current fence and extends the lease every `leaseTtl/3`; a job without progress events for `stallThreshold` (default 10 min) is flagged "no progress" in UI (edge E-06) but not auto-killed. Heartbeat itself is not progress.

## Idempotency & commit protocol

- A producer supplies one opaque stable `intentId` for a logical generation intent. `idempotencyKey = hash(jobType + canonical request/input-version snapshot + exact provider/model/operation + settingsHash + intentId)`; a unique index enforces it. The job also stores the independent canonical `requestHash`. Same key + same hash returns the existing job; same key + different hash is a hard collision error (edge E-03). Automatic retries reuse both. Explicit regeneration and provider retargeting create linked successor jobs with a new intent/key; a succeeded job is immutable.
- **Commit is transactional and preconditioned**:
  1. verify job state is `running` AND lease worker/boot/claim token + attempt all match AND the monotonic lease is unexpired;
  2. verify `inputSnapshot` version lineage still current for the target (FR-065);
  3. asset already written atomically (temp+fsync+rename, R4) — DB records asset + result + state flip in ONE transaction.
- Violations ⇒ result discarded; a new uncommitted file is compensated/left only as a recognized GC-safe orphan. A privacy-safe `stale_commit_rejected`/`late_commit_rejected` event may be appended without mutating a newer active attempt. This kills: same-worker reclaim races, stale-worker overwrites, canceled-job commits, and old-result-over-new-version (edge cases C-01, C-05, E-08).

## Dependencies & ordering

- DAG via `dependsOn[]`. Enqueue atomically rejects missing, duplicate, self, cyclic, or forbidden cross-scope edges. A job is `blocked` until every dependency is `succeeded`. Paused, failed, canceled, and `waiting_review` dependencies remain visible blockers; no hidden cascade cancels descendants.
- Canonical chain (FR-114): character inputs → character sheet → **character approval (waiting_review)** → story plan → story → scenes → image prompts → page illustrations (fan-out, parallel) → **internal review (waiting_review)** → preview PDF → **customer approval (waiting_review)** → print PDFs.
- **Standalone exception**: job type `studio_image` (FR-142) has empty `dependsOn`, nullable `projectId`, and never enters the book chain or `waiting_review` stages. It still uses leases, idempotency, atomic commit, failure taxonomy, and quota-pause.
- Priority: project priority integer 1–5 (default 3), then FIFO by creation sequence/ID. Reprioritization affects unclaimed work only. Page-illustration fan-out respects `concurrencyPerProvider` (default 2, C-09). Studio jobs share the same per-provider concurrency pool unless settings later add a separate cap (v1: shared pool).
- Failure of one page-illustration job never blocks sibling pages (independent subtrees). Studio failures never block book jobs and vice versa.

## Pre-dispatch validation

Before enqueue, the scheduler applies the same current consent and provider-reference metadata checks to the proposed immutable input snapshot; rejection creates no job. This early decision is advisory against later change, never a cached authorization.

After claim and before any capability/adapter network call, the worker MUST re-read and validate the current input state without loading image bytes:

1. input version IDs still exist and match the immutable job snapshot;
2. the exact configured provider/model remains available (FR-098);
3. every `ProviderEligibleReference` in the persisted `ImageRequestDraft` re-resolves through its source `ReferencePhoto` or approved character sheet, the family/owner/version links and allowed derived-asset role match, and no private original/full-frame face asset can enter the payload (FR-021/025/134);
4. current customer consent is `granted` for every direct photo and every approved sheet whose trusted transitive lineage is `photo_derived`; a wholly `description_only` sheet has zero photo lineage and follows FR-004's exception.

Missing/changed versions or references become `stale_dependency` / `missing_reference_asset` before bytes are loaded. Missing or refused consent transitions the job to `paused(dependency)` with `PHOTO_CONSENT_NOT_RECORDED` or `PHOTO_CONSENT_NOT_GRANTED`; after the operator records a new decision, retry repeats the full validation. A passing metadata/consent check is followed by one exact provider/model capability ticket for the bounded batch, then the worker repeats the current guard to close that check's gap. Only then does the resolver read selected clean derivatives into an ephemeral `ResolvedImageRequest`; adapters have no asset-store access. Description-only requests and wholly description-derived sheets skip the consent gate. Tests assert zero adapter/capability invocation and zero network access for every initially rejected fixture, including consent revoked after enqueue (EC-H14).

## Failure taxonomy & retry policy (FR-092)

| Category | Auto-retry | Policy |
|---|---|---|
| invalid_input | no | needs new input; surfaced immediately |
| missing_reference_asset | no | operator fixes asset (or regenerates dependency) |
| provider_unavailable | delayed | retry ×3, backoff 30s/2m/10m; then pause for operator |
| invalid_credentials | no | pause project provider work; settings remediation |
| quota_exhausted | no | **quota-pause protocol** (below) |
| rate_limited | delayed | retry ×3; honor bounded Retry-After (max 24h) if present, else backoff 15s/1m/5m; then pause |
| timeout | yes | retry ×2 (same idempotency scope); then pause |
| network_failure | yes | retry ×3, backoff 10s/1m/5m; then pause |
| safety_refusal | **never** | no prompt-variation auto-retry (FR-116); operator edits & explicitly retries |
| malformed_output | yes | retry ×2 (models are stochastic); then pause with privacy-safe structural diagnostics only |
| output_validation_failed | yes | retry ×2; then pause with bounded issue paths/codes only |
| media_decode_failure | yes | retry ×1; then pause |
| disk_write_failure | no | pause ALL jobs; health alert |
| insufficient_disk_space | no | pause ALL jobs; health alert |
| database_unavailable | no | worker halts; startup recovery handles |
| user_canceled | never | terminal |
| stale_dependency | no | job voided; UI links to invalidation flow |
| unknown | no | pause for operator; diagnostics retained |

Retries reuse the idempotency scope → a retry that ends up double-generating hashes to the same content-addressed asset or is rejected at commit — **no duplicate artifacts** (FR-093, SC-002).

All counts above mean retries after the initial attempt. Automatic retry never changes request, prompt, references, provider, model, quality, or settings. Exhaustion is durable and requires an explicit operator action. Failure/job history may persist only the normalized safe message and bounded structural diagnostics defined by CHK108; raw provider output/rejected values never enter logs, documents, API, or UI.

## Quota-pause protocol (FR-096)

1. First `quota_exhausted` for provider P/operation opens a persisted incident and transitions all queued+blocked jobs targeting that provider/operation across work scopes to `paused(quota)` with the exact safe reason.
2. Completed work untouched. Running siblings finish and commit normally.
3. UI decision (per project/standalone work scope): **wait** (jobs stay paused; operator resumes later) or **continue remaining with <explicit available provider/model>**. Continue creates linked successor jobs for only that scope's paused/remaining work. It does not mutate global Settings or completed jobs; future regeneration remains a separate explicit intent/provider choice.
4. Decision and successor links are recorded in `auditEvents` (SC-009). Other providers are untouched. New work targeting an open incident starts paused. No automatic switching, ever.

## Cancellation

- Cancel queued/blocked: immediate.
- Cancel running: AbortSignal to adapter (process kill for codex CLI); state → `canceled`; late provider results rejected by commit protocol (US5-AS3).
- Project pause moves its queued/blocked work to `paused(operator)`; already-running paid attempts may finish and commit. Generic resume restores only operator-paused work. Quota, credentials, dependency/retry, and storage pauses require their specific remediation/decision.
- Project deletion while jobs run (edge E-04): deletion flow force-cancels jobs first, then deletes — jobs never write into a deleted project (commit precondition also guards).

## Manual provider/model changes (FR-095)

- A Settings change to selected provider, exact model, or image tier first shows a bounded impact preview for all queued/blocked/reason-paused remaining jobs of the affected operation. The explicit global confirmation saves Settings and creates linked successor jobs on the new exact target in one transaction.
- Claimed/running attempts may finish on their original target; succeeded/failed/canceled history and provenance never change. Concurrency-only edits affect future claims without retargeting content.
- An unavailable newly selected exact target remains selected and its successors pause with remediation. The coordinator never keeps/chooses another model silently.
- This global Settings flow is distinct from a quota dialog's per-work-scope continuation, which never mutates Settings. Both write safe audit events.

## Restart recovery (FR-113)

On startup after narrow managed temp GC: create a new boot ID → expire all prior-boot leases → `claimed/running` jobs revert to `queued` with recovery history (their partial temp files are compensated or GC-safe; committed work is durable) → rebuild worker pool → resume respecting pauses and reviews. Waiting-review, quota/operator/dependency/storage pauses, failures, cancellation, and success are never cleared by restart. Recovery is idempotent and safe to repeat. The worker starts only after the loopback listener is verified; an empty queue makes no provider call.

## Observability (FR-111)

Every job exposes: revision, state, attempts, progress events, derived queue position, exact target, blocking reason (`blocked` lists unmet dependency IDs/states; `paused` carries its reason; `waiting_review` names target + version), provenance, and privacy-safe failure detail. Queue mutations require expected revision/state. Queue view groups by project with controls: pause/resume project, cancel, retry, priority change, regenerate page. Health exposes real queue depth/state counts, provider-running counts, stalls, worker status, active quota/storage incidents, and last recovery.

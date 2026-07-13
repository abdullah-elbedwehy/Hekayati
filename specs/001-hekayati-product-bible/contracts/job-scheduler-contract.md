# Contract: Durable Job Scheduler

**Feature**: `001-hekayati` | Normative for FR-109…FR-114, FR-092. Deterministic, rule-based, DB-backed (research R3). No AI scheduling.

## Job states

```text
created → queued → claimed → running → succeeded
                     │            ├→ failed(retryable) → queued (after backoff, attempts < max)
                     │            ├→ failed(permanent)
                     │            ├→ paused(quota|operator|dependency)
                     │            └→ canceled
queued → blocked (unmet dependencies) → queued (deps satisfied)
any-pre-terminal → canceled (operator)
waiting_review — special terminal-until-human state for review-gated stages (FR-114)
```

Full diagrams: `../state-machines.md`.

## Claiming & leases

- Workers claim atomically (single UPDATE … WHERE state='queued' transaction) setting `lease = { workerId, expiresAtMono }`.
- Lease arithmetic uses a **monotonic clock source persisted as (bootId, monotonicMs)** — wall-clock changes (edge case E-05) cannot prematurely expire or immortalize leases. On restart (new bootId) all leases from prior boots are expired by definition.
- Expired lease ⇒ job reclaimable. The old worker's eventual result is rejected at commit (below).
- Heartbeat extends the lease every `leaseTtl/3`; a job without progress events for `stallThreshold` (default 10 min) is flagged "no progress" in UI (edge E-06) but not auto-killed.

## Idempotency & commit protocol

- `idempotencyKey = hash(jobType + inputRefs versionIds + settingsHash + attemptScope)`; unique index. Enqueueing a duplicate returns the existing job (duplicate delivery, edge E-03).
- **Commit is transactional and preconditioned**:
  1. verify job state is `running` AND lease.workerId == committer AND lease unexpired;
  2. verify `inputSnapshot` version lineage still current for the target (FR-065);
  3. asset already written atomically (temp+fsync+rename, R4) — DB records asset + result + state flip in ONE transaction.
- Violations ⇒ result discarded, recorded as `stale_commit_rejected` in job history. This kills: stale-worker overwrites, canceled-job commits, old-result-over-new-version (edge cases C-01, C-05, E-08).

## Dependencies & ordering

- DAG via `dependsOn[]`. A job is `blocked` until all deps `succeeded` (or `waiting_review` deps acknowledged where the stage allows).
- Canonical chain (FR-114): character inputs → character sheet → **character approval (waiting_review)** → story plan → story → scenes → image prompts → page illustrations (fan-out, parallel) → **internal review (waiting_review)** → preview PDF → **customer approval (waiting_review)** → print PDFs.
- **Standalone exception**: job type `studio_image` (FR-142) has empty `dependsOn`, nullable `projectId`, and never enters the book chain or `waiting_review` stages. It still uses leases, idempotency, atomic commit, failure taxonomy, and quota-pause.
- Priority: project priority then FIFO. Page-illustration fan-out respects `concurrencyPerProvider` (default 2, C-09). Studio jobs share the same per-provider concurrency pool unless settings later add a separate cap (v1: shared pool).
- Failure of one page-illustration job never blocks sibling pages (independent subtrees). Studio failures never block book jobs and vice versa.

## Failure taxonomy & retry policy (FR-092)

| Category | Auto-retry | Policy |
|---|---|---|
| invalid_input | no | needs new input; surfaced immediately |
| missing_reference_asset | no | operator fixes asset (or regenerates dependency) |
| provider_unavailable | delayed | retry ×3, backoff 30s/2m/10m; then pause for operator |
| invalid_credentials | no | pause project provider work; settings remediation |
| quota_exhausted | no | **quota-pause protocol** (below) |
| rate_limited | delayed | honor Retry-After if present, else backoff 15s/1m/5m; unlimited within batch window, then pause |
| timeout | yes | retry ×2 (same idempotency scope); then pause |
| network_failure | yes | retry ×3, backoff 10s/1m/5m; then pause |
| safety_refusal | **never** | no prompt-variation auto-retry (FR-116); operator edits & explicitly retries |
| malformed_output | yes | retry ×2 (models are stochastic); then pause with raw sample |
| output_validation_failed | yes | retry ×2; then pause with validation issues |
| media_decode_failure | yes | retry ×1; then pause |
| disk_write_failure | no | pause ALL jobs; health alert |
| insufficient_disk_space | no | pause ALL jobs; health alert |
| database_unavailable | no | worker halts; startup recovery handles |
| user_canceled | never | terminal |
| stale_dependency | no | job voided; UI links to invalidation flow |
| unknown | no | pause for operator; diagnostics retained |

Retries reuse the idempotency scope → a retry that ends up double-generating hashes to the same content-addressed asset or is rejected at commit — **no duplicate artifacts** (FR-093, SC-002).

## Quota-pause protocol (FR-096)

1. First `quota_exhausted` for provider P: scheduler transitions all queued+blocked jobs targeting P in affected projects to `paused(quota)` with reason "Codex quota exhausted" (or Gemini equivalent).
2. Completed work untouched. Running siblings finish and commit normally.
3. UI decision (per project): **wait** (jobs stay paused; operator resumes later) or **continue remaining with <other configured provider>** — applies only to paused/remaining jobs and future explicit regenerations; already-succeeded jobs keep their provenance.
4. Decision recorded in `auditEvents` (SC-009). No automatic switching, ever.

## Cancellation

- Cancel queued/blocked: immediate.
- Cancel running: AbortSignal to adapter (process kill for codex CLI); state → `canceled`; late provider results rejected by commit protocol (US5-AS3).
- Project pause = bulk transition of its non-terminal jobs to `paused(operator)`.
- Project deletion while jobs run (edge E-04): deletion flow force-cancels jobs first, then deletes — jobs never write into a deleted project (commit precondition also guards).

## Restart recovery (FR-113)

On startup: expire all prior-boot leases → `claimed/running` jobs revert to `queued` (their partial temp files are orphans, swept by tmp-GC; committed work is durable) → rebuild worker pool → resume respecting pauses and reviews. Recovery is idempotent and safe to repeat.

## Observability (FR-111)

Every job exposes: state, attempts, progress events, blocking reason (`blocked` lists unmet deps; `paused` carries pauseReason; `waiting_review` names the gate), provenance, failure detail (redacted). Queue view groups by project with controls: pause/resume project, cancel, retry, priority change, regenerate page.

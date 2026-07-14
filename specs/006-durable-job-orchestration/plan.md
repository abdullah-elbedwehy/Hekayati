# Implementation Plan: Durable Job Orchestration

**Feature**: `006-durable-job-orchestration`

**Spec**: [spec.md](spec.md)

**Canonical plan**: [integrated plan](../001-hekayati-product-bible/plan.md)

**Tasks**: T-P5-01–T-P5-09

## Technical context

Extend the existing Node 22+ / TypeScript / Fastify / React / zod application with one in-process worker pool backed by the same `better-sqlite3` database. Add no queue daemon, worker process, network service, or dependency. Automated tests use the 005 deterministic mock and injected clocks/executors; no real provider, Keychain, customer data, or child image is required.

The scheduler is infrastructure in `src/jobs/**`, not domain policy. Provider adapters may be imported only by the scheduler/runtime assembly and the already-approved connection-test service. Domain producers register strict job definitions and transactional commit ports; they cannot invoke adapters directly or bypass claim/input/commit fencing.

Jobs remain validated JSON documents in the existing `documents` table. A scheduler migration adds partial/expression indexes for unique idempotency key, state/eligibility, project/provider, and dependency queries. A dedicated repository performs SQL compare-and-swap/atomic claim operations rather than generic upsert. Append-only job and audit events remain validated documents. This preserves the researched flexible document model while making queue invariants first-class in SQLite.

All files retain the 800-line guard and focused-function lint. `src/jobs/**` receives an 80% threshold for statements, branches, functions, and lines.

## Source layout

```text
src/jobs/
  schemas.ts                 # Job/lease/event/incident/input schemas
  types.ts                   # Registered definition and commit/resolver ports
  errors.ts                  # Stable internal/API-safe job codes
  idempotency.ts             # Canonical request hash + intent key
  retry-policy.ts            # Exact taxonomy table and eligibility schedule
  clocks.ts                  # Wall/monotonic/boot injected sources
  repository.ts              # Indexed SQL CAS, claims, events, incidents
  dag.ts                     # Dependency/scope/cycle validation and unblocking
  scheduler.ts               # Enqueue/actions/queue projection
  worker-pool.ts             # Claim/heartbeat/dispatch/abort lifecycle
  pre-dispatch.ts            # Current guards, capability ticket, byte resolver
  commit.ts                  # Fence + lineage + prepared-asset transaction
  recovery.ts                # Prior-boot expiry/requeue and persistent pauses
  runtime.ts                 # Production/test registry and lifecycle assembly
src/server/routes/job-api.ts
src/server/health/health-service.ts
src/ui/views/QueueView.tsx
src/ui/components/jobs/
  JobStateBadge.tsx
  JobRow.tsx
  JobDetails.tsx
  QueueControls.tsx
  QuotaDecisionDialog.tsx
src/ui/jobs.css
tests/unit/jobs-*.test.ts
tests/integration/job-*.test.ts
tests/failure-injection/jobs-*.test.ts
tests/e2e/jobs.spec.ts
tests/fixtures/start-job-app.ts
tests/fixtures/job-worker-crash.ts
```

Exact splits may change to keep files/functions focused; the boundaries and test-only isolation may not collapse.

## Persisted schemas and indexes

### Job document v1

Use strict discriminated schemas for registered provider operation and human-gate jobs. Shared fields include:

```text
identity: id, schemaVersion, createdAt, updatedAt, revision
scope: projectId?, standaloneScopeId?, jobType
ordering: priority(1..5), createdSequence, dependsOn[]
intent: intentId, idempotencyKey, requestHash
target: providerId, exact modelId, operation, settingsHash
request: canonical text/structured request | ImageRequestDraft | gate descriptor
inputSnapshot: bounded stable entity/version refs
state: state + stateReason + nextEligibleAt?
lease: workerId + bootId + claimToken + expiresAtMono | null
attempts: count, autoRetryIndex, manualRetryCount
progress: attempt, pct, noteCode, updatedAtMono, noProgress
failure: normalized safe category/message/detail/retryAfter only
resultRefs/provenance: IDs and validated provider provenance, no bytes
lineage: supersedesJobId?, successorJobIds[]
```

`revision` is incremented by every state mutation and required by API actions. Request/target/input/intent fields are immutable after insert. Provider continuation therefore inserts successors rather than rewriting them.

The scheduler migration creates:

- one partial unique index over `idempotencyKey` for `collection='jobs'`;
- state + next-eligible + priority + creation indexes for claims;
- provider + state and project/scope + state indexes for concurrency/pause/UI;
- a job-event index over job ID and sequence; and
- a unique audit decision ID/index.

On a duplicate-key conflict, load/validate the existing document and compare `requestHash`; mismatch is `JOB_IDEMPOTENCY_COLLISION`, never “close enough”.

### Job events and incidents

Events are append-only and bounded: transition, claim, heartbeat summary, progress, failure, retry scheduled, pause/resume, cancel, commit/rejection, recovery, gate completion, priority, and successor link. Progress coalescing may update the current job projection but never remove the append-only milestone history. Notes are stable codes plus safe Arabic projections; no arbitrary provider/result text.

Quota incidents bind provider + operation + opened time/status and affected scope IDs. Storage control records active category, safe reason, detected time, and last failed/successful probe. Audit decisions bind project/scope, incident, `wait|continue`, selected alternate target when applicable, affected/successor job IDs, and time.

## Clock, claim, and worker model

Create one random boot ID per runtime and stable worker IDs within it. `MonotonicClock.nowMs()` comes from `performance.now()` in production and an explicit fake in tests; wall `nowIso()` is independent. Default lease TTL is 30 seconds, heartbeat every 10 seconds, and stall threshold 10 minutes. Tests inject smaller values; production values are configuration constants, not Settings fields.

Claiming is one SQLite transaction:

1. stop if storage/global worker control is paused;
2. promote dependency-satisfied blocked jobs and eligible delayed retries;
3. select the highest-priority FIFO queued job whose provider concurrency has a slot;
4. CAS state/revision, generate a fresh claim token, set boot/worker/expiry, increment attempt, and append claim event; and
5. return the parsed claimed document.

The worker CASes `claimed → running`, starts an independent heartbeat timer, and creates an `AbortController`. Every heartbeat checks state/revision/fence and extends only the matching current lease. Failed heartbeat ownership aborts local execution without changing the new owner's record.

The worker pool begins after verified HTTP start and stops claiming before graceful shutdown. Graceful shutdown aborts local operations and safely requeues only claims it still owns; abrupt death leaves prior-boot claims for next-start recovery.

## DAG and human gates

`DagValidator` loads every proposed dependency and walks persisted edges in one read transaction. It rejects unknown IDs, duplicate/self edges, cycles, forbidden cross-scope edges, and dependencies on a job definition that cannot feed the requested type. Multi-job enqueue validates the complete proposed graph and inserts all-or-none.

Dependency projection rules:

- all dependencies `succeeded` → queue;
- any dependency not succeeded → blocked with exact IDs/states;
- permanent/canceled/stale dependency remains blocked and actionable rather than cascading a hidden cancellation; and
- owner cancellation/replacement may explicitly cancel/rebuild a subtree in a later domain transaction.

Human gates are registered non-provider jobs. Creation puts them directly in `waiting_review`; no worker claims them. `completeGate` is an internal owner-only transaction port requiring job ID, target version, expected revision, and a domain verification callback. The public queue API has no approval endpoint.

## Pre-dispatch resolver

Implement a two-phase `PreDispatchGuard`:

1. **metadata/current authorization**: validate input snapshot through the registered owner guard; for each direct photo use `LibraryService.resolveProviderPhotoReferenceMetadata`; for sheets use an injected `ApprovedSheetLineageReader`; evaluate current consent and record only safe selected asset IDs/lineage kinds;
2. **target capability**: reuse/force one exact provider/model/operation ticket for a bounded batch only after phase 1 passes;
3. repeat phase 1 to close the capability-check gap; and
4. **ephemeral load**: read each approved clean asset through `AssetStore.read`, verify record/checksum/MIME, assemble `ResolvedImageRequest`, and pass it directly to the executor without serialization/logging.

Description-only requests have no image references. Description-derived sheet lineage explicitly skips consent; photo-derived lineage requires the current customer decision. Any mismatch returns `stale_dependency`, `missing_reference_asset`, or exact consent code before bytes/provider dispatch. If no real sheet reader is registered, sheet references fail closed.

Capability tickets key provider + exact model + operation + settings hash and expire at the stricter of the provider cache and current runtime ticket boundary. A settings update invalidates affected tickets. Capability checks never choose a provider/model.

## Registered executors and commit protocol

Define a `JobDefinition<Request, Result, Prepared>` with:

- strict persisted request schema and allowed dependency/scope rules;
- `guard(job)` and optional `resolve(job)`;
- `execute(job, resolved, {signal, timeoutMs, attempt})` returning validated provider result/failure;
- optional `prepare(result)` for asset bytes; and
- `commit(tx, job, result, prepared)` which rechecks owner lineage and writes domain result references.

The worker never catches a successful provider value and writes it directly. `CommitCoordinator`:

1. prepares/validates any file through `AssetStore.prepare`;
2. opens one `DocumentStore.transaction`;
3. reloads job and verifies `running`, boot/worker/claim token, monotonic unexpired lease, and expected attempt;
4. calls the owner's current-lineage guard;
5. commits prepared asset metadata and owner result/version records;
6. writes provenance/result refs, flips job to `succeeded`, clears lease, and appends event; and
7. on any transaction failure, calls `discardPrepared` outside the rollback and records only a safe rejection when it still owns a mutable job.

An old fence never changes an active newer attempt; it may append a separately validated rejection event without altering that job projection. A canceled/stale job remains terminal. Two returns for one claim cannot increment an existing asset refcount twice because only the first state/fence CAS can enter commit.

The 006 fixture committer stores synthetic validated result documents and small deterministic mock assets only. Production creative committers arrive in later slices.

## Failure, retry, and pause engine

Encode the canonical table as exhaustive TypeScript data checked against `failureCategorySchema`. Each entry declares outcome, retry delays/count, and terminal/pause behavior. A unit test fails if a category has no policy.

On retryable failure within budget, atomically clear lease, set `queued` with persisted eligibility wall timestamp plus remaining delay metadata, and append failure/retry events. On same boot, eligibility is driven by monotonic delay; after restart, the conservative remaining delay is reconstructed from persisted schedule and clamped so wall jumps cannot create an immortal retry. Lease ownership never depends on that wall value.

Provider-unavailable/rate-limit/timeout/network/malformed/validation/media policies pause after exact exhaustion. Invalid input, missing dependency asset, safety refusal, and stale dependency do not auto-retry. Credentials pause matching provider work. Unknown pauses for operator. Cancellation wins over any concurrent failure.

Explicit retry is a revision-checked operator mutation allowed only after the reason's remediation contract. It preserves history, queues the same immutable intent, and starts a new documented auto-retry cycle. If input/provider/model must change, the owning flow creates a successor instead.

The scheduler treats category, not an adapter's convenience `retryable` boolean, as authority. Invalid credentials opens a provider-wide credential pause so other queued work does not repeatedly call the same broken account; explicit Settings remediation plus a successful exact connection/capability check restores only those jobs.

## Quota and storage incidents

### Quota

In the quota failure transaction:

- mark the failing job `paused(quota)`;
- create/reuse the open provider+operation incident;
- pause all queued/blocked matching jobs, retaining prior reason in history;
- leave other providers and terminal work untouched; and
- signal running matching attempts that an incident exists, but allow them to finish unless they themselves fail/cancel.

The wait decision is append-only and leaves jobs paused. Continue validates an alternate exact target/capability, displays affected scope count, and in one transaction inserts linked successor jobs with new keys, marks originals superseded/canceled-for-switch, rewires only still-unstarted descendants where the registered graph permits, and writes audit. No global Settings mutation occurs.

After a wait decision, a separate “check availability and resume” action force-checks the exact incident target. Failure leaves the incident/jobs untouched; success plus confirmation closes the incident and restores only its still-paused jobs. Continue decisions for one scope do not close an account-wide incident that still protects other/future work.

### Ordinary Settings target switch

Wrap provider/model/tier Settings mutations in `ProviderTargetChangeCoordinator`. It computes a bounded impact preview for text/structured versus image operations. Confirmation performs one SQLite transaction that saves the new Settings document, inserts successor jobs for queued/blocked/reason-paused remaining work across scopes, marks their predecessors superseded, and appends audit. Claimed/running attempts are allowed to finish on the old target and terminal work is immutable. A new target may remain unavailable, but successors are visibly paused rather than silently using the old one. Changing only concurrency updates Settings and future claim capacity without successor creation.

### Storage

Classify Node/SQLite errors before any public projection. ENOSPC maps insufficient space; EACCES/EPERM/EROFS/atomic-rename/fsync failure maps disk write; busy/corrupt/closed DB maps database unavailable. Storage failure opens a global persistent control, fences/pauses non-terminal work, stops claims, aborts owned running operations, and updates queue Health. A prepared orphan is handled by existing narrow GC.

Resume runs DB `SELECT`/transaction, managed-directory ownership/symlink checks, free-space threshold check, and a private create-write-fsync-rename-delete probe in the data root. Any failure retains pause. Success plus explicit confirmation closes the incident and restores only jobs paused by that incident to their previous eligible state.

## Runtime, API, and Health

`JobRuntime` is assembled after settings/library/assets/providers and before Health so Health receives a safe snapshot port. Recovery runs after existing asset/original GC. Worker start is called only after `LocalRequestBoundary.activate`; runtime close stops the worker before closing Fastify/store.

Production registers no test executor. The E2E fixture runtime injects deterministic text/image/noop/gate definitions, clocks/fault hooks, and test-only routes. Test routes cannot be enabled by ordinary production startup options/environment.

API surface:

```text
GET  /api/jobs
GET  /api/jobs/:id
POST /api/jobs/:id/pause
POST /api/jobs/:id/resume
POST /api/jobs/:id/cancel
POST /api/jobs/:id/retry
PUT  /api/jobs/:id/priority
POST /api/jobs/quota/:incidentId/decision
POST /api/jobs/quota/:incidentId/resume
POST /api/jobs/storage/resume
POST /api/jobs/provider-target/impact
POST /api/jobs/provider-target/confirm
```

Project pause/resume endpoints may operate on a bounded list and return counts. Every response uses `Cache-Control: no-store`; mutations require expected revision/state and the existing CSRF/origin boundary. Errors expose stable codes and safe Arabic mapping only.

Health queue projection contains worker `running|paused|halted`, total/queued/blocked/running/paused/failed/waiting-review/stalled counts, running counts by provider, active incident reasons, and last recovery time. The UI fetches queue state on view entry and bounded polling while visible; it respects reduced motion and stops polling when hidden.

## Arabic UI implementation

Add «قائمة المهام» to the existing Citrus Playground shell and reuse established cards/status primitives. The working view is dense but calm: project groups, one-line state/reason first, then progress/dependencies/provider details on expansion. Use logical CSS, IBM Plex Sans Arabic, Western digits, `<bdi>` for model/IDs, text+icon status, ≥44px controls, visible focus, `aria-live` only for operator-triggered updates, and no animation under reduced motion.

Confirm cancel and provider continuation with affected counts. Priority uses five named Arabic levels backed by 1–5. Invalid controls are omitted or disabled with an explained reason. A human gate links to its owning future screen and never presents an approve button here.

## Test-first order

1. strict job/lease/event/incident schemas, category-policy exhaustiveness, idempotency canonicalization;
2. repository migration/indexes, duplicate/collision, atomic CAS/claim, priority/FIFO and DAG validation;
3. monotonic lease/heartbeat/fence/reclaim/stall behavior including same-worker and wall jumps;
4. retry/backoff/cancel/pause/resume policies across all 18 categories;
5. direct-photo/sheet lineage/consent metadata guard and ephemeral resolver payload snapshots;
6. executor registry, capability tickets, provider dispatch, transactional commit and asset compensation;
7. quota/credential incidents, ordinary target-switch successors/audit, and storage pause/probe/Health behavior;
8. startup/graceful/abrupt recovery and child-process kill matrix;
9. API conflict/security/no-store tests and Arabic queue/Health component behavior;
10. full fixture E2E: 16-page-equivalent graph, 14-success quota journey, `SIGKILL`/restart, axe/responsive/zero-egress/privacy scans.

## Verification commands

```bash
npm run check
npm run coverage
npm run build
npm run test:e2e
npm run format:check
npm audit --audit-level=high
git diff --check
```

Also run a clean Node 22 lockfile install, scheduler-only coverage audit, process-level kill fixtures, staged secret/binary/customer-data scan, provider import-firewall scan, and manual visual inspection of committed synthetic queue evidence. Record exact outcomes in `IMPLEMENTATION_NOTES.md`.

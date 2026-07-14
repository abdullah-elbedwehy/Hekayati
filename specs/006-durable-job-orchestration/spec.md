# Feature Specification: Durable Job Orchestration

**Feature ID**: `006-durable-job-orchestration`
**Status**: Approved scope — awaiting per-slice readiness pipeline
**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

This document is an ownership and acceptance slice. Canonical requirement wording and shared rules remain in the bible. On conflict: constitution → bible → this slice.

## Outcome

Long-running work executes as observable, deterministic, idempotent jobs that survive app or machine failure, respect dependencies and review gates, reject stale/canceled commits, and require explicit operator decisions for quota/provider changes.

## Requirements *(mandatory)*

Primary requirement ownership: **FR-092, FR-096, FR-109, FR-111–114**.

Primary journey: the durable-orchestration portion of **US4**. Primary clarification: **C-09**. Full routing: [migration map](../MIGRATION.md).

Owned capability boundaries:

- Job DAG/state machine, claims, monotonic leases, idempotency keys, priorities, progress, concurrency, review gates, and restart recovery.
- Fixed failure taxonomy reactions, bounded retries/backoff, pause-all storage failures, cancellation, and stale/late commit rejection.
- Quota pause with explicit wait/continue decision, audit record, remaining-work-only switching, and preserved completed work.
- Arabic queue controls and complete blocking/failure observability.

Provider error normalization at the adapter boundary is owned by feature 005; this feature owns policy after normalization. Creative graph construction and version commits are owned by feature 007 but must use this scheduler contract.

## Dependencies and interfaces

- Depends on feature 002 transactional storage, atomic assets, health alerts, and settings.
- Depends on feature 003's shared consent/enqueue policy, provider-reference resolver, immutable owner versions, and trusted sheet-lineage contract.
- Depends on feature 005 provider contract, capabilities, provenance, and normalized failures.
- Supplies durable execution and human-gate primitives to features 007–011; Studio jobs in 011 deliberately use no human review gate or book dependency chain.
- Consumes version snapshots from feature owners; it alone re-reads consent/reference state and creates ephemeral resolved requests immediately before dispatch, while never inferring invalidation or approval policy itself.

## User Scenarios & Testing *(mandatory)*

Canonical story and scenarios: orchestration clauses of **US4** in the [product bible](../001-hekayati-product-bible/spec.md).

Independent acceptance: run a 16-page deterministic mock graph, kill and restart at mid-flight, verify completed assets remain intact and no duplicates appear; revoke consent after enqueue and attempt an original/full-frame reference to prove the immediate recheck makes zero adapter/network call; inject quota exhaustion, late results, wall-clock jumps, disk full, and cancellation, verifying every canonical transition and operator-visible reason.

## Success Criteria *(mandatory)*

Primary measurable outcomes: **SC-002 and SC-009**. CHK106–CHK110, CHK116–CHK118, CHK016–CHK017, the pre-dispatch portions of CHK206/208, and the scheduler failure-injection matrix provide the remaining evidence.

## Required bible artifacts

- [Scheduler contract](../001-hekayati-product-bible/contracts/job-scheduler-contract.md)
- [Job and project state machines](../001-hekayati-product-bible/state-machines.md)
- [Research R3](../001-hekayati-product-bible/research.md)
- [Queue/storage edge cases](../001-hekayati-product-bible/edge-case-catalog.md)
- [Failure-injection strategy](../001-hekayati-product-bible/test-strategy.md)

## Delivery mapping

Master tasks: **T-P5-01–T-P5-09**. Phase checkpoint and definition of done remain canonical in [tasks.md](../001-hekayati-product-bible/tasks.md).

Spec approval requires owned IDs, scheduler semantics, provider handoff, and failure-injection evidence to be accepted; it does not authorize implementation until the complete graph is approved.

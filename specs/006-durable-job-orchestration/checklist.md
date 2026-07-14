# Verification Checklist: 006 Durable Job Orchestration

**Status**: PASS — evidenced at implementation checkpoint (2026-07-14)

**Canonical checklists**: [AI reliability](../001-hekayati-product-bible/checklists/ai-reliability.md) · [product acceptance](../001-hekayati-product-bible/checklists/product-acceptance.md) · [privacy/security](../001-hekayati-product-bible/checklists/privacy-security.md) · [Arabic RTL UX](../001-hekayati-product-bible/checklists/ux-arabic-rtl.md)

## Schema, DAG, and persistence

- [x] 006-C01 T-P5-01: strict job/request/event/incident schemas reject unknown job types, binary/runtime requests, paths, originals, secrets, raw provider bodies, and unknown keys before persistence.
- [x] 006-C02 Multi-job enqueue is atomic and rejects unknown/duplicate/self/cyclic/cross-scope dependencies; every blocked projection lists exact unmet IDs/states/reasons.
- [x] 006-C03 Idempotency key canonicalization includes intent, job type, request/input versions, exact target, and settings hash; same key+hash returns one job and key+different hash fails hard.
- [x] 006-C04 Priority 1–5 + FIFO order is deterministic; reprioritization changes only unclaimed work and queue position is derived rather than persisted as truth.
- [x] 006-C05 Scheduler indexes/migration are idempotent, preserve existing documents, and atomic SQL claim/CAS paths never rely on generic last-write-wins upsert.

## Leases, attempts, and commits

- [x] 006-C06 T-P5-08: lease ownership requires worker ID, boot ID, unique claim token, attempt, and monotonic unexpired deadline; same-worker reclaim receives a new fence.
- [x] 006-C07 Wall-clock forward/backward jumps do not alter claim/heartbeat/expiry/stall outcomes; new boot IDs expire all old claims without trusting wall time.
- [x] 006-C08 Heartbeat runs independently from progress; no-progress appears after ten monotonic minutes, clears on progress, and never auto-kills a healthy lease.
- [x] 006-C09 CHK109: late, expired-fence, canceled, stale-lineage, wrong-attempt, and double-return commits are rejected without changing an active/newer job or current domain result.
- [x] 006-C10 CHK110: prepared asset + owner result + job success commit atomically; rollback compensates new files; forced duplicate/double-run creates one result and no duplicate/refcount inflation.
- [x] 006-C11 Database-loss and same-target concurrent commit fixtures preserve the newer result and append only privacy-safe rejection history where possible.

## Pre-dispatch privacy and provider boundary

- [x] 006-C12 CHK206: enqueue and immediate dispatch checks distinguish absent/refused consent and direct-photo/photo-derived-sheet versus both description-only exceptions.
- [x] 006-C13 Consent revoked/cleared after enqueue makes zero capability/adapter/network call, loads zero bytes, and preserves local/completed state with the exact code.
- [x] 006-C14 CHK208: resolver accepts only current same-family/owner/version clean provider assets or approved sheet renders and rejects original/full-frame face/cross-family/wrong-link/missing/corrupt fixtures.
- [x] 006-C15 Ephemeral `ResolvedImageRequest` is never serialized, persisted, logged, cached, or returned by API; adapter payload snapshot contains only selected clean bytes and allow-listed metadata.
- [x] 006-C16 Exact provider/model/operation capability ticket is checked after initial authorization and invalidated by target/settings changes; unavailability never substitutes or dispatches elsewhere.
- [x] 006-C17 Provider import firewall proves generation adapter calls outside explicit connection tests originate only from `src/jobs/**`; adapters still contain zero retry/persistence/domain lookup.

## Failure policy, pause, and quota

- [x] 006-C18 CHK106: all 18 taxonomy categories have one exhaustive policy entry and synthesized end-to-end assertion for retry count, delays, final state, and operator remediation.
- [x] 006-C19 Rate limits honor normalized Retry-After with three-retry/one-day bound or exact 15s/1m/5m fallback; every other retry count matches the canonical table and means retries after initial attempt.
- [x] 006-C20 CHK107/108: safety never auto-retries or varies a prompt; malformed/validation history contains only bounded structural diagnostics and no raw values/body.
- [x] 006-C21 Pause/resume/cancel/retry actions are expected-revision CAS operations; operator pause preserves running paid work, reason-specific pauses cannot be cleared by generic resume, and cancel fences before abort.
- [x] 006-C22 CHK116: quota opens one provider/operation incident, pauses only matching queued/blocked work, leaves other providers/completed work intact, and allows running sibling successes to commit.
- [x] 006-C23 CHK117/118: wait/continue and later availability-resume are explicit per-scope/incident actions; continue validates exact alternate, creates linked successors only for remaining work, preserves mixed provenance, writes audit, and never changes global Settings automatically.
- [x] 006-C24 FR-095: ordinary provider/model/tier Settings change previews all affected unstarted work, atomically saves + creates global remaining-work successors after confirmation, preserves running/completed targets, and never treats concurrency-only edits as a content retarget.
- [x] 006-C25 T-P5-09: ENOSPC/EACCES/EROFS pause all executable work, stop claims, fence/abort running work, preserve human-gate state, and persist Health reason; restart does not clear; only an explicit successful probe resumes incident-owned jobs.
- [x] 006-C26 Database unavailable halts worker without a false persisted transition; recovery is safe when storage returns.

## Recovery, review gates, UI, and checkpoint

- [x] 006-C27 CHK016/SC-002: kill matrix covers blocked, claimed, provider-running, prepared, renamed-before-DB, retry-delay, and waiting-review; completed artifacts remain and restart resumes without duplicates.
- [x] 006-C28 Human gate survives restart, names target/version, blocks descendants, exposes no queue approval action, and transitions only through an owner-verified transaction.
- [x] 006-C29 CHK410–412/CHK017: Arabic queue/Health shows every reason, dependency, progress, attempt, provenance, worker/incident state, and exactly wait-vs-continue quota consequences.
- [x] 006-C30 Keyboard/focus/axe/44px/reduced-motion/bidi/Western-digit and 390×844, 1440×900, 1920×1080 fit checks pass; browser capture has zero non-loopback request; screenshot uses synthetic data only.
- [x] 006-C31 `src/jobs/**` has ≥80% statements/branches/functions/lines; check, build, full E2E, audit, format, clean install, file-size, staged privacy/content audit, and `IMPLEMENTATION_NOTES.md` all pass.

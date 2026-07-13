# State Machines: Hekayati

**Feature**: `001-hekayati` | Normative companions to spec §3 and the scheduler contract.

## 1. Project

```text
draft ──configure──▶ characters_ready ──sheets generated──▶ awaiting_character_approval
awaiting_character_approval ──approval recorded──▶ generating (plan→story→scenes→prompts→illustrations)
generating ──all pages done──▶ internal_review
internal_review ──operator OK──▶ preview_ready ──preview PDF──▶ awaiting_customer_approval
awaiting_customer_approval ──approved──▶ approved ──print PDFs + preflight pass──▶ print_ready
awaiting_customer_approval ──changes requested──▶ revising ──edits──▶ (re-enter generating/internal_review for affected scope)
approved ──any customer-visible change──▶ revising (approval invalidated, FR-086)
any ──operator──▶ paused ⇄ previous state
any ──operator (confirmed)──▶ archived | deleted(permanent)
```

Notes: transitions marked with approvals are `waiting_review` job gates — never automatic (FR-114). `revising` re-runs only invalidated scope (matrix), never whole-book (Constitution VII).

## 2. Job

See `contracts/job-scheduler-contract.md` for the normative machine:
`created → queued ⇄ blocked → claimed → running → { succeeded | failed(retryable→queued) | failed(permanent) | paused(quota|operator|dependency) | canceled }` + `waiting_review` for human gates. Late/stale commits rejected at the commit precondition — not a state, an invariant.

## 3. Page

```text
                        ┌───────────── regenerate illustration ─────────────┐
empty → generating → generated → reviewed(flagged | approved)               │
   ▲         │              │  edit text / layout-only / revert version ────┤ (new version, others untouched)
   │         └─ failed ─────┘                                               ▼
   └────────────────────────────────────────────────────────── new IllustrationVersion

approved ──lock──▶ locked ──unlock──▶ approved
locked + upstream ChangeEvent ⇒ locked_stale (flag only; content frozen until operator unlocks, FR-064)
any unlocked + upstream ChangeEvent per matrix ⇒ stale (flag + regeneration offer, no auto-regen)
```

Invariants: (a) regenerating page N touches no other page (FR-063, SC-003); (b) version history append-only until permanent deletion (FR-066); (c) commit requires input-snapshot lineage match (FR-065).

## 4. Character approval

```text
none → sheet_generating → sheet_ready → preview_sent → approved
                                   └──▶ changes_requested → (edit → new sheet version → sheet_generating)
approved + character version bump ⇒ approved(superseded)   # binds to old version forever (FR-033)
```

## 5. Book (customer) approval

```text
none → preview_sent → approved ──customer-visible change──▶ invalidated (cause recorded)
preview_sent → changes_requested(notes, affectedPages)
invalidated → (new preview) → preview_sent → …
print PDFs producible ONLY from state=approved with matching bookVersion (FR-086, SC-010)
```

## 6. Provider availability (per provider)

```text
unknown → checking → available
checking → unavailable(reason: not_installed | logged_out | invalid_key | model_missing | network)
available ──quota_exhausted──▶ quota_paused ──operator wait/switch decision──▶ available (later)
unavailable/quota states surface verbatim in Settings + queue blocking reasons; no silent transitions.
```

## 7. Export/Import

```text
Export: requested → require_paused_generation → snapshotting → secret_scan → { ready | failed(reason) }
Import: file_selected → validating(structure, manifest, checksums, path-safety, disk)
        → staged → committing(tx) → { imported | rolled_back(reason) }
No state writes anything user-visible before `committing` succeeds (FR-128).
```

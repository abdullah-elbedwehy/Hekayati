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

## 8. Photo consent eligibility

```text
not_recorded ──record granted──▶ granted
not_recorded ──record refusal──▶ not_granted
granted ⇄ not_granted          # each recorded decision carries a fresh date + note
any ──clear record──▶ not_recorded
```

Direct-photo and transitively photo-derived-sheet work requires `granted` both before enqueue and immediately before dispatch; wholly description-derived work does not. `not_recorded` returns `PHOTO_CONSENT_NOT_RECORDED`; `not_granted` returns `PHOTO_CONSENT_NOT_GRANTED`. A transition away from `granted` blocks queued photo-bearing work before network access but does not delete local/reference/completed artifacts (FR-004, EC-H14).

## 9. Library visibility lifecycle

```text
active ⇄ archived
archived ──feature 010 pre-report + explicit confirmation──▶ permanently_deleted
```

Archive/restore is reversible picker visibility only (FR-018, IM-21). Archiving a customer/family hides its descendants from new selection; existing pinned versions remain readable and carry an archived indicator. Permanent deletion is never an alias or automatic consequence of archive.

Family anchor substate is monotonic: `empty_unanchored ──create first main_child atomically──▶ anchored`; `anchored ──archive anchor──▶ anchor_archived ──restore same anchor──▶ anchored`. Later-member creation and new Project/Studio selection require `anchored`. There is no v1 reassign transition, so old relationship versions can never silently change meaning (C-21).

## 10. Reference-photo intake

```text
selected → private_runtime_reservation → streaming_limits → sniff_and_decode
→ original_and_clean_derivatives_prepared → quality_findings
quality_findings ──face kind──▶ subject_selection → crop_prepared
quality_findings ──non-face kind──▶ ready_to_commit
crop_prepared → ready_to_commit
ready_to_commit ──possible duplicate──▶ operator(open_existing | create_separate)
create_separate / no_duplicate → atomic_owner_commit → attached
open_existing / cancel / expiry → rolled_back
any pre-commit state ──failure or restart──▶ rolled_back_or_startup_gc
```

The reservation is not a visible domain record. Every face-kind intake requires a keyboard-operable subject rectangle; multi-person input cannot commit until the intended person is explicitly marked. `atomic_owner_commit` has two valid forms: (a) new photo-only character identity + first usable `CharacterVersion` + family-anchor assignment when applicable, or (b) append an existing owning `CharacterVersion`/`LookVersion` under expected-head CAS. In both forms the exact original, working copy, thumbnail, crop when required, immutable `ReferencePhoto`, head, and classified change events become visible together or not at all (FR-019/024/025). Normal cancellation compensates all prepared files; a crash before DB commit leaves only recognized unindexed reservation files for startup GC.

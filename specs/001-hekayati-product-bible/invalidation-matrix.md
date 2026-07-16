# Artifact Invalidation Matrix

**Feature**: `001-hekayati` | Normative for FR-033, FR-058, FR-086, FR-087, Constitution X.

Rules: invalidation **marks stale + surfaces scope + offers actions**; it never auto-regenerates (Constitution VII/X). Locked pages get flags only (`locked_stale`), content frozen (FR-064). "Book approval" = full-book customer approval; invalidating it blocks print output until a new approval (SC-010).

**Single Image Studio (FR-145)**: `studio_image` jobs and `studioGenerations` history are **outside this matrix**. Creating, regenerating, or deleting a studio image MUST NOT emit book ChangeEvents and MUST leave every column below unchanged.

**Flow-mode Prompt Pack (FR-152)**: a `PromptPack` is a **derived** artifact, not a matrix column. Any row that marks a page illustration ✖ also marks every pack pinned to that page's superseded versions stale (with the row ID as reason). Pack recompilation itself invalidates nothing. Imported illustrations are ordinary page illustration versions: committing one behaves exactly like IM-10, and stale imports are rejected at commit (FR-155) rather than entering the matrix.

Legend: ✖ = invalidated/stale, ⚠ = flagged for re-check (no invalidation), — = unaffected.

| # | Upstream change | Char. approval | Char. sheet | Story plan/text | Scene(s) | Page illustration(s) | Page layout | Preview PDF | Book approval | Print PDFs / preflight |
|---|---|---|---|---|---|---|---|---|---|---|
| IM-01 | Character appearance/source edit (`appearanceDescription`, source mode, age/gender, physical fields, refs, appearance-capable notes/traits) | ✖ superseded | ✖ | — | — | ✖ pages using that character version | ⚠ | ✖ | ✖ | ✖ |
| IM-02 | Character narrative/non-visual edit (age/gender, relationship, interests, favorites, personality, speaking style, notes/traits) | — | — | ⚠ (story may reference traits) | ⚠ | — | — | — | — | — |
| IM-03 | Shared LookVersion edit (name, clothing, appearance overrides, references) | — | ✖ if sheet used that look | — | — | ✖ pages using that look | ⚠ | ✖ | ✖ | ✖ |
| IM-04 | Project-only look override changed | — | — | — | — | ✖ affected pages only | ⚠ | ✖ | ✖ | ✖ |
| IM-05 | Character name/nickname changed | — | ⚠ (name on sheet) | ⚠ mentions re-render | ⚠ | — (art has no text) | ✖ if name appears in rendered text | ✖ | ✖ | ✖ |
| IM-06 | Scene action/description/participants edit | — | — | — | (self: new version) | ✖ that page only | ✖ that page | ✖ | ✖ | ✖ |
| IM-07 | Narrative text edit — any visible change incl. punctuation | — | — | (self) | — | — (no regen needed) | ✖ that page layout | ✖ | ✖ | ✖ |
| IM-08 | Story-level regeneration / plan change | — | — | (self) | ✖ all scenes | ✖ all unlocked pages | ✖ | ✖ | ✖ | ✖ |
| IM-09 | Page count change (16↔24) | — | — | ✖ structure (guided expand/shorten flow, FR-058) | ✖ | ✖ affected pages | ✖ | ✖ | ✖ | ✖ |
| IM-10 | Illustration regenerated (operator action) | — | — | — | — | (self: new version) | ⚠ recompute placement | ✖ | ✖ | ✖ |
| IM-11 | Layout-only recalculation | — | — | — | — | — | (self) | ✖ | ✖ | ✖ |
| IM-12 | Dedication / title / cover content edit | — | — | — | — | — | ✖ affected title/dedication special-page layout(s); cover composition is the changed version itself | ✖ | ✖ | ✖ |
| IM-13 | Illustration style change (project-wide) | — | ⚠ sheet style mismatch warning | — | — | ✖ all unlocked pages | ✖ | ✖ | ✖ | ✖ |
| IM-14 | Composition-compatible printer profile change (bleed/DPI/color/ICC/crop/spine mechanics) | — | — | — | — | — | — | — | — | ✖ re-preflight + re-produce print files only (FR-087) |
| IM-15 | Spine width / cover template change | — | — | — | — | — | — | — | — | ✖ cover PDF only |
| IM-16 | Template edited (new template version) | — | — | — existing stories pinned to old version (FR-052) | — | — | — | — | — | — |
| IM-17 | Provider/model switch (settings) | — | — | — | — | — future work only (FR-095) | — | — | — | — |
| IM-18 | Internal-only changes (job logs, audit, retention cleanup, integrity re-hash) | — | — | — | — | — | — | — | — (FR-087) | — |
| IM-19 | Watermark text setting change | — | — | — | — | — | — | ✖ preview only | ⚠ (approval referenced old preview file; record note) | — |
| IM-20 | Asset file found missing/corrupt (integrity scan) | — | ✖ if sheet asset | — | — | ✖ affected page (regeneration offered) | — | ✖ if referenced | ⚠ | ✖ if referenced |
| IM-21 | Customer/family/character/look archive or restore (visibility only) | — | — | — | — | — | — | — | — | — |

## Cascade mechanics

1. Version append + compare-and-swap head update emits one immutable `changeEvents` outbox record per applicable matrix row in the same transaction (data-model.md §hooks). Multiple rows may apply to one edit; no "strongest row only" shortcut is allowed.
2. Invalidation engine resolves affected rows top-down; consequences are transitively applied left→right in one pass (e.g., IM-06 → page ✖ → preview ✖ → book approval ✖ → print ✖). IM-21 changes picker visibility only: descendants of an archived parent are excluded from new selection, while every existing pinned reference remains readable with an archived indicator.
3. Affected-items view shows: what, why (matrix row id), and per-item actions (regenerate / keep-stale / unlock-and-edit for locked).
4. `bookVersion` bump ⟷ exactly the rows marked ✖ under Book approval (FR-086 definition of customer-visible).
5. Every invalidation writes an `auditEvents` record (SC-010 evidence).
6. Preview and approval consequences are applied by the same original transaction/receipt as creative consequences. The artifact participant set is assembled before any producer can emit; a second downstream consumer is forbidden. A consumed event freezes its affected IDs and consequence hash, so later-created layouts/previews/approvals are never retroactively attached on replay.
7. Preview ✖ marks the exact current `PreviewOutput` stale. Book approval ✖ changes the bound cycle to `invalidated`; ⚠ appends an attention reason while preserving state. Separate current-preview/current-content-approval heads plus `customerContentHash` distinguish an old file from unchanged approved content. Mutable preview/attention revisions do not alter `contentAuthorizationHash`.
8. Locked creative Page records and creative heads remain byte-identical. Initial downstream layout derivation may create a separate `PageLayoutHead` from that frozen reviewed snapshot; replacing an existing layout requires explicit unlock. Invalidation can mark the downstream layout stale and the Page `locked_stale`, but cannot advance either content head.
9. IM-14 applies only when the printer profile preserves the approved composition profile. Incompatible trim/aspect/safe-area requirements hard-block and enter an explicit composition migration that creates IM-11/12 consequences and a new approval cycle (FR-087, C-27).
10. When a PreviewOutput is staled before its cycle reaches `approved`, the same invalidation transaction cancels/supersedes its still-`waiting_review` approval gate; the route and queue can no longer act on it, and descendants remain blocked. A gate already succeeded by approval is immutable: a ✖ row invalidates the cycle/authorization guard, while sole IM-19 preserves approved content authorization and adds only the documented attention reason.
11. IM-20 attention does not silently become approval invalidation. The print guard blocks while any exact source/full-resolution asset it would consume fails checksum/integrity. Repairing or restoring byte-identical content and re-verifying the expected checksum may remove that runtime block without a new customer approval; different bytes require a new version and the applicable visible-change row. A corrupt/missing preview PDF alone remains stale evidence but is not a print input.

## Worked examples (from spec §8)

- **E4** (page 7 look fix): IM-04 → page 7 ✖, others —; preview ✖; book approval ✖; print ✖. Pages 1–6/8–16 untouched (SC-003).
- **Punctuation fix**: IM-07 → layout of that page recalculated; no illustration regen; approval ✖ (visible text changed) — matches US6-AS4.
- **Character face change after approval**: IM-01 → sheet ✖, char approval superseded, affected pages ✖ listed, book approval ✖; nothing regenerates until operator chooses (FR-033).

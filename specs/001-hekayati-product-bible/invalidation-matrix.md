# Artifact Invalidation Matrix

**Feature**: `001-hekayati` | Normative for FR-033, FR-058, FR-086, FR-087, Constitution X.

Rules: invalidation **marks stale + surfaces scope + offers actions**; it never auto-regenerates (Constitution VII/X). Locked pages get flags only (`locked_stale`), content frozen (FR-064). "Book approval" = full-book customer approval; invalidating it blocks print output until a new approval (SC-010).

**Single Image Studio (FR-145)**: `studio_image` jobs and `studioGenerations` history are **outside this matrix**. Creating, regenerating, or deleting a studio image MUST NOT emit book ChangeEvents and MUST leave every column below unchanged.

Legend: ✖ = invalidated/stale, ⚠ = flagged for re-check (no invalidation), — = unaffected.

| # | Upstream change | Char. approval | Char. sheet | Story plan/text | Scene(s) | Page illustration(s) | Page layout | Preview PDF | Book approval | Print PDFs / preflight |
|---|---|---|---|---|---|---|---|---|---|---|
| IM-01 | Character permanent appearance edit (face, hair, skin tone, base look) | ✖ superseded | ✖ | — | — | ✖ pages using that character version | ⚠ | ✖ | ✖ | ✖ |
| IM-02 | Character non-visual edit (interests, personality, speaking style) | — | — | ⚠ (story may reference traits) | ⚠ | — | — | — | — | — |
| IM-03 | Look edited (shared look version bump) | — | ✖ if sheet used that look | — | — | ✖ pages using that look | ⚠ | ✖ | ✖ | ✖ |
| IM-04 | Project-only look override changed | — | — | — | — | ✖ affected pages only | ⚠ | ✖ | ✖ | ✖ |
| IM-05 | Character renamed | — | ⚠ (name on sheet) | ⚠ mentions re-render | ⚠ | — (art has no text) | ✖ if name appears in rendered text | ✖ | ✖ | ✖ |
| IM-06 | Scene action/description/participants edit | — | — | — | (self: new version) | ✖ that page only | ✖ that page | ✖ | ✖ | ✖ |
| IM-07 | Narrative text edit — any visible change incl. punctuation | — | — | (self) | — | — (no regen needed) | ✖ that page layout | ✖ | ✖ | ✖ |
| IM-08 | Story-level regeneration / plan change | — | — | (self) | ✖ all scenes | ✖ all unlocked pages | ✖ | ✖ | ✖ | ✖ |
| IM-09 | Page count change (16↔24) | — | — | ✖ structure (guided expand/shorten flow, FR-058) | ✖ | ✖ affected pages | ✖ | ✖ | ✖ | ✖ |
| IM-10 | Illustration regenerated (operator action) | — | — | — | — | (self: new version) | ⚠ recompute placement | ✖ | ✖ | ✖ |
| IM-11 | Layout-only recalculation | — | — | — | — | — | (self) | ✖ | ✖ | ✖ |
| IM-12 | Dedication / title / cover content edit | — | — | — | — | — | — | ✖ | ✖ | ✖ |
| IM-13 | Illustration style change (project-wide) | — | ⚠ sheet style mismatch warning | — | — | ✖ all unlocked pages | ✖ | ✖ | ✖ | ✖ |
| IM-14 | Printer profile change (bleed/DPI/color/ICC/crop) | — | — | — | — | — | — | — | — | ✖ re-preflight + re-produce print files only (FR-087) |
| IM-15 | Spine width / cover template change | — | — | — | — | — | — | — | — | ✖ cover PDF only |
| IM-16 | Template edited (new template version) | — | — | — existing stories pinned to old version (FR-052) | — | — | — | — | — | — |
| IM-17 | Provider/model switch (settings) | — | — | — | — | — future work only (FR-095) | — | — | — | — |
| IM-18 | Internal-only changes (job logs, audit, retention cleanup, integrity re-hash) | — | — | — | — | — | — | — | — (FR-087) | — |
| IM-19 | Watermark text setting change | — | — | — | — | — | — | ✖ preview only | ⚠ (approval referenced old preview file; record note) | — |
| IM-20 | Asset file found missing/corrupt (integrity scan) | — | ✖ if sheet asset | — | — | ✖ affected page (regeneration offered) | — | ✖ if referenced | ⚠ | ✖ if referenced |

## Cascade mechanics

1. Version bump emits `ChangeEvent` (data-model.md §hooks).
2. Invalidation engine resolves affected rows top-down; consequences are transitively applied left→right in one pass (e.g., IM-06 → page ✖ → preview ✖ → book approval ✖ → print ✖).
3. Affected-items view shows: what, why (matrix row id), and per-item actions (regenerate / keep-stale / unlock-and-edit for locked).
4. `bookVersion` bump ⟷ exactly the rows marked ✖ under Book approval (FR-086 definition of customer-visible).
5. Every invalidation writes an `auditEvents` record (SC-010 evidence).

## Worked examples (from spec §8)

- **E4** (page 7 look fix): IM-04 → page 7 ✖, others —; preview ✖; book approval ✖; print ✖. Pages 1–6/8–16 untouched (SC-003).
- **Punctuation fix**: IM-07 → layout of that page recalculated; no illustration regen; approval ✖ (visible text changed) — matches US6-AS4.
- **Character face change after approval**: IM-01 → sheet ✖, char approval superseded, affected pages ✖ listed, book approval ✖; nothing regenerates until operator chooses (FR-033).

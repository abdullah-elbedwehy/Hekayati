# Spec Audit & Fill Gaps

Paste into Codex / Claude after you finish editing specs.

---

## Mission

Read **every** spec artifact in this repo **after my recent edits**. Detect gaps, contradictions, and orphan IDs. **Fill missing information** so the graph is implementation-ready. Spec/docs only — **no product implementation** unless I explicitly ask later.

## Read order (mandatory, full files — not headings only)

1. `AGENTS.md`, `CLAUDE.md`, `.specify/memory/constitution.md`
2. `specs/README.md`, `specs/MIGRATION.md`
3. Entire bible: `specs/001-hekayati-product-bible/` (spec, plan, tasks, research, data-model, contracts/, state-machines, invalidation-matrix, edge-case-catalog, risk-register, checklists/, test-strategy, quickstart, provider-capability-matrix)
4. Every leaf: `specs/002-*` … `specs/011-*/**`
5. `PRODUCT.md`, `DESIGN.md` (and note brand kit 02 if UI-related gaps)
6. `git status` + diff of my uncommitted/recent spec edits — treat my edits as intentional; do not revert them

## What “fill missing” means

For each gap you find, **write the missing content into the correct artifact** (prefer bible for canonical FRs/contracts; leaf specs for ownership/acceptance only). Preserve stable IDs. Add new IDs; never renumber casually.

Fill / fix when you find:

| Gap type                                                              | Action                                                                                 |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Missing FR / acceptance / edge case for stated behavior               | Add FR + map to tasks/checklist/EC                                                     |
| Leaf mentions ownership but bible missing the rule                    | Add to bible, link from leaf                                                           |
| Bible has FR with no task / no test / no checklist                    | Add task Ref and/or CHK/EC                                                             |
| Task with no requirement                                              | Attach FR/gate or delete orphan task                                                   |
| Contradictory rules across files                                      | Fix to one rule; bible wins over leaf                                                  |
| `Assumed` / VERIFY / TODO / TBD / “expected” left as fake certainty   | Either resolve conservatively + label assumption `C-xx`, or mark explicit Phase 0 gate |
| Clarification still open that is deferrable                           | Close with conservative assumption + rationale                                         |
| Clarification that changes product shape / privacy / money            | **Ask me** (batched ≤5); do not guess                                                  |
| Studio (011) / Citrus / Single Image / other new edits not propagated | Propagate to MIGRATION, README, tasks, checklists, data-model, invalidation            |
| Examples / edge cases incomplete vs new behavior                      | Add E* / EC* rows                                                                      |
| Out-of-scope feature accidentally reintroduced                        | Remove or move to explicit post-v1 note                                                |

## Quality bar (before you stop)

- [ ] Every leaf `spec.md` has clear Outcome, owned FR/US/SC IDs, deps, acceptance test
- [ ] MIGRATION.md routes every FR / US / SC / major EC / CHK / task ID exactly once (or documents shared)
- [ ] No material contradiction between constitution, bible, and leaves
- [ ] No silent “Assumed provider capability” presented as Confirmed
- [ ] Invalidation matrix covers new entities (e.g. Studio) or explicitly excludes them
- [ ] Design/brand decisions (Citrus, C-16) referenced where UI/print identity matters
- [ ] My edits preserved and integrated, not overwritten casually

## Process

1. Inventory: list files read + what I changed (from git diff).
2. Gap list: table `ID | Location | Problem | Fix planned`.
3. Apply fixes in dependency order (constitution → bible → migration/README → leaves → PRODUCT/DESIGN refs).
4. Re-scan once for leftover gaps.
5. **Do not commit/push** unless I ask.
6. **Do not implement** `src/` or run Phase 0 product code.

## Clarifications

Ask me only when a missing decision:

- changes fundamental product behavior, or
- has material privacy / legal / financial / ops impact, or
- has two equally plausible options that fork the product.

Otherwise: choose the conservative option, document as `C-xx` / assumption, continue.

## Final report (required)

```text
SPECS AUDIT COMPLETE
Files updated: …
Gaps filled: … (bullets)
Assumptions added: C-xx …
Questions for you: … (or None)
Remaining known risks: …
Ready for: delivery loop / slice 002 / your approval
```

## Start

Begin with git diff + full read of the spec graph. Fill gaps until the checklist above passes. Work until done; do not stop after a summary-only pass.

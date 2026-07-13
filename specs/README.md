# Hekayati Specification Registry

The complete spec graph was approved for the full delivery loop on 2026-07-14. Phase 0 is authorized; each feature slice advances through its own readiness pipeline and analyze gate before implementation.

## Authority

1. [Constitution](../.specify/memory/constitution.md)
2. [Product bible](./001-hekayati-product-bible/spec.md) and its supporting artifacts
3. Numbered feature slices below
4. Integrated [plan](./001-hekayati-product-bible/plan.md) and master [tasks](./001-hekayati-product-bible/tasks.md)

Canonical requirement wording, stable IDs, contracts, state machines, invalidation rules, risks, tests, and checklists stay in the product bible. Feature slices define bounded ownership and acceptance evidence; they link to the bible instead of copying it. See [migration map](./MIGRATION.md).

## Feature slices

| Order | Spec | Primary scope | Master task slice |
|---|---|---|---|
| 001 | [Product bible](./001-hekayati-product-bible/spec.md) | Shared product rules and integrated design | P0/P10 coordination |
| 002 | [Local foundation](./002-local-foundation/spec.md) | Local platform, brand shell, assets, security, settings, health | P1 |
| 003 | [Customer and character library](./003-customer-character-library/spec.md) | Customers, consent, families, characters, looks, photo intake | P2 data slice |
| 004 | [Story authoring and templates](./004-story-authoring-and-templates/spec.md) | Mentions, story configuration, templates, book structure | P3 |
| 005 | [AI provider boundary](./005-ai-provider-boundary/spec.md) | Canonical AI contract, Codex/Gemini/mock, credentials, capabilities | P0 provider gates + P4 |
| 006 | [Durable job orchestration](./006-durable-job-orchestration/spec.md) | Scheduler, retries, leases, recovery, quota decisions | P5 |
| 007 | [Creative generation and review](./007-creative-generation-and-review/spec.md) | Character sheets, book generation, page versions, locks, safety, review | P2 sheet slice + P6 book slice |
| 008 | [Arabic layout, preview, and approval](./008-arabic-layout-preview-and-approval/spec.md) | Arabic layout, preview PDF, customer approval | P7 |
| 009 | [Print production](./009-print-production/spec.md) | Printer profiles, interior/cover PDFs, preflight | P0 print gates + P8 |
| 010 | [Portability and deletion](./010-portability-and-deletion/spec.md) | Export/import and permanent deletion | P2 deletion slice + P9 |
| 011 | [Single Image Studio](./011-single-image-studio/spec.md) | Standalone image generation isolated from book state | P6 Studio slice |

## Dependency order

```text
full spec-graph approval → shared Phase 0 gates → 002
002 ──▶ 003 ──▶ 004 ─────────────┐
  └──▶ 005 ──▶ 006 ──────────────┤
003 + 004 + 005 + 006 ──▶ 007 ──▶ 008 ──▶ 009
                              ├──▶ 010 (parallel with 008/009)
                              └──▶ 011 (parallel with 008/009/010)
009 + 010 + 011 ──▶ shared Phase 10 acceptance
```

Leaf folders intentionally contain specification only. The bible retains the integrated plan/tasks until each leaf separately advances through later Spec Kit stages. On `main`, set the intended feature explicitly before using helpers that expect one active feature directory.

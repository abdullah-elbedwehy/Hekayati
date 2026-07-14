# Implementation Plan: Creative Generation and Review

**Feature**: `007-creative-generation-and-review`

**Spec**: [spec.md](spec.md)

**Canonical plan**: [integrated plan](../001-hekayati-product-bible/plan.md)

**Tasks**: T-P2-07–T-P2-08, T-P2-11, T-P6-01–T-P6-09

## Technical context

Extend the existing single-process TypeScript application with a provider-neutral creative domain layered over the implemented 003 library, 004 authoring model, 005 validated provider contracts, and 006 scheduler. No provider SDK type enters the domain. No additional service, database, queue, cloud store, telemetry, or real customer fixture is introduced.

Automated acceptance uses the deterministic mock provider and synthetic characters. Production registration supports the exact selected provider/model only when 005 capabilities pass. Real Gemini image work remains unavailable while credential or measured G2 limits are null. Codex remains text/structured-only. Every image result is prepared through the content-addressed asset store and enters a creative record only inside the scheduler's fenced commit transaction.

The existing documents table remains the persistence boundary. Creative records are strict zod documents with immutable version records and small mutable identity/workflow heads. Repository writes share the scheduler transaction. Generated output bodies are product records only after 005 validation; rejected/raw output is never persisted or logged.

## Canonical model decisions

### Character sheets and approvals

`CharacterSheet` is an immutable attempt record:

```text
id, projectId?, customerId, familyId, characterId, characterVersionId
appearance: base | shared_look(lookId, lookVersionId)
views { face, front, threeQuarter, fullBody, mainOutfit } -> assetId
referenceThumbnailAssetIds[], referenceLineage, pdfAssetId
status ready|revision_needed|approved|approved_superseded
provenanceByView, priorSheetId?, generationJobIds[]
```

The row is inserted only by the local finalizer after all five view assets and the prepared PDF exist. Later workflow-state transitions preserve its content and provenance byte-for-byte. `Approval` is append-only and targets `sheet.id`; the current applicable state is a deterministic projection. The character-approval gate is completed only by the creative approval transaction. A permanent appearance/selected-look event supersedes applicable approval but never deletes the sheet or PDF.

Base appearance is represented explicitly and carries no synthetic look ID. Provider sheet references make `lookVersionId` nullable only for base sheets; a shared-look reference requires both IDs. Page requests may use approved base or shared-look sheets whose pinned character/appearance matches the page input.

### Creative run and progressive job materialization

`CreativeRun` contains an immutable manifest with all logical nodes and edges:

```text
sheet views/finalize/gate per participant
story_plan -> story_text -> scene_list
per page: page_prompt -> page_illustration
review_findings -> internal_review gate
```

Node state references the materialized job ID when available. The manifest is created before the first provider dispatch. A predecessor commit validates/persists its output, compiles the next canonical request, and enqueues the successor in the same outer SQLite transaction. This avoids placeholder requests and ensures restart cannot leave committed output without its next stage. Fan-out prompt jobs are created together after scene commit; each image job is created with only its prompt predecessor and has an independent failure subtree.

`CreativePipelineService` is the sole producer. It resolves current project/character/sheet input, applies FR-004 enqueue consent, exact capability/capacity checks, preallocates stable intent IDs, and creates the manifest/jobs. It does not call provider adapters. Job definitions use 006 `PreDispatchCoordinator` and `ProviderDispatchGateway`; current-lineage guards compare every `inputSnapshot` before dispatch and commit.

### Generated story and pages

Story plan/text/scene outputs are immutable run artifacts. Scene-list commit appends generated `SceneVersion` records to the existing 004 scene heads and appends one generated `StoryVersion` with validated `planJson` and exact scene IDs. Previous manual/generated versions stay readable.

`Page` is one identity per canonical customer-visible page and contains lock/review/staleness workflow state plus illustration/layout head pointers. `PageTextVersion`, `PagePromptVersion`, and `IllustrationVersion` are immutable. A story page pins its scene version. Title/dedication/ending page identities are created without illustrations and remain available to 008.

An illustration commit performs, in one transaction:

1. re-read page/run/project/scene/sheet heads and compare the job snapshot;
2. reject stale, canceled, superseded, or locked targets;
3. commit the prepared asset and immutable illustration version;
4. advance only that page head, set review to unreviewed, and clear only resolved staleness;
5. append IM-10 event/audit and bump `bookVersion`; and
6. return asset/version references to the job commit.

Regeneration creates a successor prompt/image branch for one page. Revert points the head to a selected historical version through an explicit new lineage action and preserves every version. Text rewrite appends 004 scene and page-text versions, then applies IM-07. Layout-only recalc writes a 008 work request/invalidation marker; 007 never invents placement.

### Review and safety

`PageReview` binds the exact page text/illustration version tuple and contains required boolean/notes fields for participant accuracy, face/outfit/identity, pet anatomy, age/register, no in-image text, story/art consistency, and FR-115 safety categories. Completion rejects incomplete/stale tuples. `ReviewFinding` remains immutable advisory output with acknowledgement records; `block` prevents internal-review gate completion until explicitly acknowledged with a note.

`safety_refusal` follows 006's terminal no-retry policy. Creative projections add safe stage/page context from job metadata, never provider bodies. Retry after an edit is a new explicit successor intent.

### Invalidation engine

Implement a closed `IM-01`–`IM-21` rule table. A rule declares direct consequences, downstream cascade, affected resolver, customer-visible/book-version behavior, and allowed operator actions. The engine consumes existing 003/004 change events and new 007–009 event kinds through a normalized internal event type.

Processing is one SQLite transaction: validate event → resolve affected records from pinned versions → apply consequences left-to-right → append audit event → insert receipt keyed by event ID. Replay compares the canonical consequence hash and is otherwise a no-op. Locked pages receive only `locked_stale`; no rule enqueues work. IM-21 produces a receipt/audit with no artifact mutations. Rows owned by 008/009 can be invoked and tested now against their absent/present artifact ports without implementing those slices.

## Source layout

```text
src/domain/creative/
  schemas.ts                  # sheet/run/page/version/review/approval/audit schemas
  repositories.ts             # strict creative collections
  errors.ts                   # stable creative/API-safe codes
  sheets.ts                   # sheet graph, finalization, approval, lineage reader
  pipeline.ts                 # run manifest + progressive stage compiler
  generation-context.ts       # 004/library -> GenerationTaskV1 compilation
  pages.ts                    # page heads, operations, history, isolation
  review.ts                   # checklist/findings/gate completion
  invalidation-rules.ts       # exhaustive IM table
  invalidation.ts             # transaction engine/receipts/affected view
  service.ts                  # scoped public orchestration facade
src/jobs/creative-definitions.ts
src/pdf/character-sheet.ts
src/server/routes/creative-api.ts
src/ui/views/CreativeView.tsx
src/ui/components/creative/**
src/ui/creative.css
scripts/live/creative-smoke.ts
tests/unit/creative-*.test.ts
tests/integration/creative-*.test.ts
tests/failure-injection/creative-restart.test.ts
tests/e2e/creative.spec.ts
```

Focused splits may vary to retain the 800-line guard. These ownership boundaries may not collapse into provider adapters or route handlers.

## Job definitions and requests

Registered job types:

- `character_sheet_view`: image request; result commits one `sheet_view` asset only.
- `character_sheet_finalize`: local request; validates all five succeeded view jobs, renders/prepares PDF, commits sheet/PDF, and materializes the approval gate.
- `story_plan`, `story_text`, `scene_list`, `page_prompt`, `review_findings`: strict structured requests with validated 005 output.
- `page_illustration`: image request; result commits one illustration asset/version.

Human gates retain the 006 built-in `human_gate` registration. The run manifest, rather than a permissive job payload, supplies stable future-node intent. Local finalizer payloads are addressed by a hash over a persisted strict finalize descriptor; `prepare` re-loads and validates the descriptor and dependencies.

All provider job definitions share:

- exact request schema matching request kind;
- scope and input-snapshot validation at enqueue;
- current project/character/sheet/page guard before capability and dispatch;
- direct-photo or approved-sheet resolver only;
- strict result parser/type assertion before commit;
- prepared generated assets with provenance built from returned provider provenance plus job ID/settings snapshot; and
- compensation on late/canceled/stale commit rejection.

## Prompt/reference/capacity policy

Build tasks through 005 `GenerationTaskV1`; use the established Egyptian-Arabic directives and canonical output schemas. PagePrompt output is checked again for mandatory no-extra-person, no-text, no-onomatopoeia, no-photoreal-face constraints. Named living-artist/franchise transformation uses the existing hash-bound confirmation and is recorded in prompt-version provenance.

Sheet generation uses sanitized direct-photo references when present and consented; description-only sheets send no bytes. Page generation is sheet-first. Reference-plan views are reduced only by the deterministic 005 budget planner with an explicit operator-confirmed plan. If participant count exceeds a verified reliable count, or a real limit is null, enqueue blocks. Mock's measured fixture limits are valid only for mock acceptance.

## Compact sheet PDF

Use a direct pinned Playwright runtime dependency and local Chromium to render one compact RTL HTML sheet to PDF. The template embeds only derived thumbnails/generated views as data URLs, escapes all text, uses bundled IBM Plex Sans Arabic, contains no remote URLs/scripts, and writes through `AssetStore.prepare`/atomic commit. PDF role is `pdf_preview` with local-derived provenance and the source sheet ID.

Verification renders the PDF to images, checks page count/media size/text presence mechanically, and visually inspects Arabic shaping/order, all required view labels, no clipping, and compact file size using only synthetic fixtures. A missing Chromium/G3 is a blocking sheet-PDF failure, not an alternate renderer.

## API and Arabic UI

Add owner-scoped endpoints under `/api/creative` for sheet generation/status/export/approval/change request, run start/status, page list/history/operations/review/lock, finding acknowledgement, internal-review completion, and affected items. Every mutation requires CSRF plus expected head/revision/version tuple. Responses are no-store and return safe stable codes only.

Add «الإبداع والمراجعة» inside the existing Citrus Playground shell. The view uses a compact run rail, character-sheet review cards, page filmstrip plus focused page inspector, required checklist, consistency compare, findings, history, and explicit stale/locked actions. Use logical CSS, bundled Arabic font, Western digits for IDs/versions, `<bdi>` for hashes/models, ≥44px targets, visible focus, text+icon statuses, reduced motion, and no horizontal clipping at 390/1440/1920 widths. No approval control lives in the generic queue.

## Test-first order

1. strict creative schemas, base/shared appearance union, append-only repositories, scope/privacy failures;
2. exhaustive IM table and one unit case per row, receipt replay/hash conflict, locked flags, book-version rules;
3. sheet five-view graph, current consent, generated-asset commit, finalizer/PDF, owner gate approval and superseding;
4. task compilation and generated plan/text/scene append into 004 lineage;
5. run manifest and atomic progressive materialization, page prompt/image fan-out, independent failures;
6. page lineage, single-page regeneration checksum isolation, text/layout/revert/lock/approve operations;
7. review checklist/findings/block acknowledgement, consistency projection, safety refusal context;
8. production runtime/route wiring and restart/stale/canceled commit fault matrix;
9. Arabic UI keyboard/responsive/axe/zero-egress and rendered PDF evidence;
10. full 16-page mock project checkpoint plus opt-in live script SKIP/PASS honesty.

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

Also run a clean Node 22 lockfile install, creative-domain coverage audit at ≥80% statements/branches/functions/lines, real `SIGKILL` restart fixture, 21-row matrix audit, page sibling checksum script, compact-PDF render/mechanical inspection, staged secret/path/customer-data scan, provider import-firewall scan, and manual visual inspection of committed synthetic UI/PDF evidence. Record exact outcomes in `IMPLEMENTATION_NOTES.md`.

# Implementation Plan: Arabic Layout, Preview, and Approval

**Feature**: `008-arabic-layout-preview-and-approval`

**Spec**: [spec.md](spec.md)

**Canonical plan**: [integrated plan](../001-hekayati-product-bible/plan.md)

**Tasks**: T-P7-01–T-P7-06

## Technical context

Extend the existing one-process TypeScript application with provider-neutral layout, customer-composition, preview, and approval domains. Use the implemented 007 page/review/version lineage, 006 local durable-job protocol, content-addressed asset store, SQLite document repositories, bundled Arabic fonts, Sharp, and pinned Playwright/Chromium. Add no service, daemon, provider call, cloud store, telemetry, CDN, customer portal, WhatsApp integration, or printer guess.

G3 is PASS for Playwright 1.61.1, Chromium 149, the pinned Lemonada/IBM Plex Arabic fonts, Arabic shaping/BiDi, 300-PPI placement, and offline rendering. Slice acceptance repeats those checks against the production 008 pipeline. Gemini G2/G4 are irrelevant: every automated and manual checkpoint uses synthetic local fixtures and makes zero provider calls.

PDF and image bytes remain outside JSON documents. Strict documents hold only IDs, hashes, bounded geometry/validation facts, workflow state, and audit evidence. Every generated file follows prepare → validate → atomic rename/asset commit; no partial output can be ready or downloadable.

## Canonical model decisions

### Customer composition versus printer geometry

`CompositionProfile/a4-portrait-v1` is the explicit customer-visible canvas. It contains 210 × 297 mm A4 trim dimensions, a pinned 0.5 mm dimension tolerance, normalized safe/placement regions, and typography scale. It is versioned, hashed, and pinned by every layout, cover composition, preview, and approval. It is not a printer profile and supplies no DPI, color, ICC, crop, bleed, spine, or cover-spread claim.

Feature 009 receives this profile and applies one pure compatibility predicate: portrait orientation; absolute width and height deltas each ≤ the pinned 0.5 mm tolerance with no scale transform; and the normalized composition safe-content rectangle, converted through the identity trim mapping, wholly contained by the printer safe rectangle. Bleed, DPI, color, ICC, crop, spine, and printer-only blanks are excluded from that predicate. Any failed term returns `COMPOSITION_PROFILE_MISMATCH` with bounded expected/actual geometry and creates no print work. The operator must explicitly migrate composition; that creates new layout/cover versions, IM-11/12 consequences, and a new preview approval. Ordinary compatible printer mechanics remain IM-14 and never invalidate content approval.

### Layout policy and immutable versions

`LayoutPolicy/v1` is closed/versioned data plus pure functions:

- candidate regions and deterministic order for `auto`, `top`, `bottom`, `right`, `left`;
- normalized region geometry and physical meaning in RTL pages;
- quietness score from local grayscale edge/variance sampling and contrast score against candidate foreground colors;
- stable tie-break by policy order, never random or locale-dependent;
- padding, line-height, maximum line length, age-band start size and hard 14pt/12pt floor;
- fallback order: approved presets → gradient/panel aid → `needs_operator` warning;
- normalization/escaping/bidi isolation rules and prohibited-control warnings; and
- bubble regions, collision/overflow rules, and deterministic supported speaker-position mapping.

`PageLayoutHead` is a downstream mutable pointer keyed by page ID. It replaces the unused 007 nullable layout pointer through a schema migration. `LayoutVersion` is immutable and pins exact project/page-content/text/illustration/template/composition/typography/font/policy inputs, customer-visible `pageContentHash`, story PageReview ID/hash when applicable, special-page source-policy/selection when applicable, text/source refs, requested/resolved placement, region, aid, font size, measurement hash, warnings, bubble geometry, job/work-request IDs, and acceptance state. Operational `pageObservationRevision` fences the running job but is excluded from customer-content authorization, so later lock/unlock/review metadata alone cannot stale approved bytes.

Initial derivation from an exact reviewed creative snapshot may create a layout head even when the Page is locked because the Page, text head, illustration head, review, and lock remain byte-identical. Any successor/recalculation requires explicit unlock. A stale/canceled/old-fence result, changed source head, or mismatched pending work request cannot advance the layout head.

### Special pages and customer-view cover

One composition compiler resolves each kind without assuming artwork:

- title: pinned project title and selected approved hero/sheet/story artwork when available;
- dedication: exact `ProjectVersion.dedicationText`, local decorative template, optional approved artwork;
- story: current PageTextVersion + IllustrationVersion;
- ending1: pinned editable farewell text and hero artwork;
- ending2: pinned brand line, child display name, bundled identity asset, no remote logo;
- front-cover proof: title, child name, environment line, selected approved artwork;
- back-cover proof: optional editable synopsis, exact brand line, and optional approved artwork.

The five interior templates share one escaped HTML/CSS composition input with the browser view and PDF renderer. For the first automatic draft, the closed `CompositionSourcePolicy/v1` selects the first approved story-page illustration in ascending page order for front cover, title, and farewell; if none exists it selects the exact approved `threeQuarter` character-sheet view matching the main child's project-pinned appearance. Dedication defaults to no artwork, ending2 uses one hash-pinned bundled identity asset, and back cover defaults to no artwork. The closed cover text policy pins title, main-child display name, and ending-page brand line from exact versions while leaving optional front environmentLine and back synopsis absent; only an explicit cover edit may add them. If the required front/title/farewell source cannot be resolved, workflow enters `operator_action_required` with `COMPOSITION_SOURCE_REQUIRED`; it never guesses.

Every special-page layout work request and final LayoutVersion persist that policy version, `automatic_v1|operator` selection source, exact text refs, selected asset IDs/checksums, and resolved text/template input hash. A revision/lock-checked owning endpoint may create a successor request with another eligible approved in-project asset; it emits IM-12/IM-11 as applicable and never mutates an existing LayoutVersion. `CoverCompositionVersion` is separate, immutable, customer-visible content with the same policy/selection provenance, normalized front/back geometry, closed advisory/blocking warnings, `ready|needs_operator`, and no spine/bleed/printer spread. Its initial deterministic draft uses the same front source, pinned project text, absent optional synopsis/environment, and no back artwork; a revision-checked cover endpoint appends a new version for eligible asset/text changes and emits IM-12. Any blocking warning prevents `pdf_pending`. No path starts provider generation.

### Dialogue behavior

The scene/page text supplies speaker character IDs and optional normalized source-position hints. A pointer is drawn only when a versioned mapping recognizes one unambiguous, on-canvas position for that speaker and the bubble solver avoids prohibited collisions. Otherwise the renderer uses a speaker-labeled, non-pointing RTL bubble/panel and persists `SPEAKER_ANCHOR_INDETERMINATE`. It never guesses from image pixels or runs face/object detection.

### Durable automatic workflow

Completing 007's internal-review gate calls an idempotent `PreviewWorkflowCoordinator` in the same transaction and no longer marks the project `preview_ready` prematurely. For story pages the coordinator pins the exact approved PageReview, page/text/illustration heads, and lock state. Title, dedication, farewell, and brand pages have no 007 PageReview prerequisite: their exact inputs are the ProjectVersion, closed composition-source policy or operator selection, eligible asset checksums, template/font hashes, and page identity. The coordinator creates `layout_pending` and materializes strict local `page_layout` jobs for missing exact inputs. Layout/cover commits may legitimately bump `bookVersion`; immediately before `pdf_pending`, the coordinator atomically captures the final current bookVersion plus all ready layout/cover heads and hashes that exact preview request. One strict local `preview_pdf` job is then materialized.

Unresolved layout/cover warnings set `operator_action_required` with exact page/cause/actions and create no PDF job. Manual placement/recalculation creates a successor layout intent only after expected-revision and lock checks. Restart reconstructs workflow/job projections from DB; no in-memory queue or route callback is authoritative.

Local jobs have `target: null` and strict `localJobRequest { payloadHash }`. Their immutable descriptors live in layout repositories and are loaded/validated by the registered definition. They use the canonical scheduler's lease, idempotency, local failure/retry, cancel, and restart semantics, but never pass through provider capability, consent, adapter, provider concurrency/incident, or provider retry-selection code.

### Preview snapshot and render boundary

`PreviewOutput` binds:

- project/projectVersion/bookVersion and composition profile;
- exact CoverCompositionVersion;
- one `customerContentHash` over composition/cover/order/page-content/layout/text/source/full-resolution customer-visible fields only;
- ordered 16/24 interior entries with operational observation revision, customer page-content hash, exact story-review evidence or special-page source-policy/selection, layout/text/illustration IDs, composition-input hashes, text refs, and every source asset ID/checksum including special-page and bundled identity media;
- approval-bundle/page-map/preview-snapshot hashes;
- typography/font/watermark/preview-derivative/renderer policy hashes;
- durable render job, immutable `ready_to_send` approval-cycle ID, immutable customer-approval gate job (whose target version is this PreviewOutput), and final `pdf_preview` asset IDs; and
- bounded mechanical validation facts and stale projection.

The PDF order is front-cover proof → exactly 16/24 numbered interior pages → back-cover proof. Cover proofs do not alter interior numbering. Printer blanks, spine, crop marks, bleed expansion, CMYK, and print-resolution assets are absent.

Rendering uses JavaScript-disabled Chromium, local data URLs, escaped text nodes, and an explicit route/resource guard that aborts HTTP(S), `file:`, websocket, worker, and unexpected schemes. Fonts are loaded from exact hash-verified bundled files. Sharp produces transient deterministic ~150-PPI derivatives for the exact placed size; the original/full-resolution asset never enters the preview document or output resources. The derivative policy has fixed format/quality and does not lower quality opportunistically to meet size.

The preview validator must pass before commit:

1. parseable PDF, no encryption/corruption;
2. every page's MediaBox and applicable TrimBox dimensions match the pinned CompositionProfile within its declared tolerance and remain portrait;
3. exact total proof/interior page count and ordered map;
4. exact bundled Arabic font identities, embedding, ToUnicode/glyph coverage;
5. diagonal configured watermark and required footer on every PDF page;
6. image effective-PPI range and no source-resolution stream/hash;
7. hard ≤16 MB for the complete 24-page default fixture plus both proofs;
8. no JavaScript, actions, forms, attachments, embedded files, remote references, hidden contact/internal/provenance text, or local paths; and
9. render request capture count zero outside the in-memory document.

Any failure yields a stable code and actual bounded measurements/pages. It never creates a ready output, download head, send action, or silent alternate renderer/policy.

### Atomic commit and failure recovery

The `preview_pdf` definition prepares transient derivatives and PDF bytes, validates them, then enters the 006 commit coordinator. It atomically promotes the prepared file to its canonical content-addressed name first, then begins one SQLite transaction that rechecks claim/attempt/fence, workflow revision, project revision/book head, cover readiness/head, PreviewOutput projection revision where applicable, every layout/review/text/source-asset head/checksum, settings/font/derivative hashes, and current snapshot hash; indexes the asset and commits the cross-linked PreviewOutput, revision-0 `ready_to_send` BookApprovalCycle, workflow/current-preview/current-cycle heads, version-bound customer-approval human gate, job result, and audit. It does not advance or clear `currentContentApprovalId`. Project lifecycle status is orthogonal to derivative preview workflow: if that content-approval head still authorizes the identical `customerContentHash`, an IM-19 replacement preview preserves `approved`/`print_ready`; otherwise newly ready unapproved content moves to `preview_ready`. A crash after rename and before DB commit leaves only a recognized unindexed orphan for startup GC; a failed/stale transaction compensates the new file when unreferenced. Ready DB state can therefore never precede the file.

Failure injection covers kill before PDF creation, after temp fsync, after rename/before DB commit, and during validation; ENOSPC/EACCES; stale/canceled/old-fence return; and duplicate execution. Recovery produces at most one indexed asset/output and exposes no partial download.

### Approval cycle and print authorization

`BookApprovalCycle` has immutable target fields: project, exact PreviewOutput, its exact approvalGateJobId, bookVersion, customerContentHash, approvalBundleHash, ordered page-map hash, cover version, preview snapshot, and watermark hash. The gate request's targetVersionId must equal the PreviewOutput ID. Mutable state starts at revision-0 `ready_to_send` and is version/revision checked through `preview_sent`, `approved`, `changes_requested`, or `invalidated`; attention reasons do not alter approval state.

`preview_sent` is only a manual attestation that the operator sent the exact file outside Hekayati and does not complete the gate. Only `approved` completes the customer-approval human gate to `succeeded`, atomically advances `currentContentApprovalId` to that cycle, and may unblock print dependencies. `changes_requested` is an owning-feature rejection transaction: it records the exact cycle/notes/scopes/audit, moves the project to `revising`, cancels/supersedes that gate, and—when a prior content-approval head still authorizes this same content bundle—marks that prior cycle invalidated and clears the authorization head so no print work remains authorized. Neither outcome is available through generic queue controls. Every action requires owner scope, current CSRF boundary, exact preview/output/bundle, expected project/output/approval/gate revisions plus expected prior content-approval ID/revision when present, and an idempotency key. An append-only BookApprovalAction row uniquely binds the scoped key to a canonical request hash—including normalized notes plus strict page/cover scopes—and stored result; that row, all compare-and-swaps, gate transition, prior-authorization invalidation, and audit commit together. Changes requested require non-empty notes and at least one unique `{ kind: page, pageId }` from that PreviewOutput or `{ kind: cover, side: front|back|both }` from its cover version. A duplicate identical action returns the ledger result; a key/hash collision or stale tab changes nothing. A successor preview gets a new gate; old gates cannot authorize it, but creating an unapproved or watermark-only successor alone does not erase a still-valid prior content-approval head.

`ApprovedBookSnapshotReader` is the only 009 handoff. It reads the Project's `currentContentApprovalId`, atomically verifies that exact linked gate completed with `approved`, its target is the bound PreviewOutput, and the current `customerContentHash` still matches the approved composition/cover/page/layout/text/source assets. It returns a strict snapshot with exact review/text/source/full-resolution evidence, stable `contentAuthorizationHash = customerContentHash + immutable approval/output/gate outcome evidence`, and separate non-hashed observation revisions; it returns no runtime bytes. It does not require that cycle to equal `currentPreviewCycleId`, compare current watermark, or block on mutable preview/attention revisions. IM-19 and a newer unapproved same-content preview leave both prior hashes valid but reject new actions on a stale file. IM-20 blocks only while an asset actually referenced by print/customer content fails checksum/integrity; byte-identical repair/reverification restores the guard without new approval. A customer-visible ✖ row invalidates the approval head; gate/content hash mismatch or unresolved referenced-asset integrity failure blocks. Initial print-job materialization invokes this reader in the same transaction and creates zero job on block; existing jobs re-run it before local execution and commit, becoming stale/canceled with no indexed artifact/current head if a later block appears.

### Shared invalidation transaction

Refactor the 007 engine around registered `InvalidationArtifactParticipant` ports assembled once by production runtime. Creative and 008 participants resolve/apply in the original event transaction; future 009 participants join the same registry. Every mutation service receives this coordinator—no service constructs a partial consumer. Startup fails closed if a required participant is missing.

The coordinator freezes all consequences in one receipt hash. Replays project the persisted receipt/audit rather than re-resolving later artifacts. Implement real 008 effects for layout heads, PreviewOutput, BookApprovalCycle, workflow/head, exact approval gate, and approved-snapshot guard. If any row stales a PreviewOutput before approval—including IM-19—the same transaction cancels/supersedes its still-waiting gate so it cannot remain actionable or unblock descendants. An already-succeeded approval gate is immutable; ✖ invalidates the cycle/guard, while sole IM-19 only adds attention and preserves approved content authorization. Audit all production emitters before implementation and complete every missing pre-009 producer that can affect 008 artifacts: current source requires authoring IM-06/08/09/12/13, layout IM-11/12, watermark IM-19, and asset-integrity IM-20 coverage in addition to proving the existing IM-01–05/07/10/21 paths. A 007 pending `LayoutWorkRequest` already carrying its IM-11 event is consumed without a second event; an initial layout without a request emits IM-11 at commit. Exactly one logical event bumps `bookVersion` once when the matrix says so.

## Source layout

```text
src/domain/layout/
  schemas.ts                  # composition/layout/cover/workflow/output/approval contracts
  repositories.ts             # strict documents and schema migration
  policy.ts                   # deterministic candidate/quietness/contrast/fallback rules
  composition.ts              # five interior kinds + cover composition inputs
  layouts.ts                  # immutable commit/head/work-request coordination
  workflow.ts                 # automatic layout -> pdf_pending continuation
  approvals.ts                # exact preview lifecycle and 009 snapshot reader
  invalidation-participant.ts # real layout/preview/approval consequences
src/layout/
  image-analysis.ts           # bounded Sharp grayscale/edge/contrast facts
  measure.ts                  # DOM measurement contract
  bubbles.ts                  # anchors, collision, non-pointing fallback
src/pdf/
  composition-document.ts     # escaped offline shared document builder
  preview-derivatives.ts      # deterministic transient ~150-PPI assets
  preview-renderer.ts         # typed watermarked preview entry point
  preview-validator.ts        # mechanical ready/send gate
src/jobs/layout-definitions.ts
src/server/routes/layout-api.ts
src/ui/views/PreviewView.tsx
src/ui/components/preview/**
src/ui/preview.css
tests/unit/layout-*.test.ts
tests/integration/layout-*.test.ts
tests/failure-injection/preview-restart.test.ts
tests/e2e/preview.spec.ts
tests/golden/layout/**
```

The renderer has separate typed preview and future print entry points; no unsafe `watermark: boolean` or `quality: preview|print` switch can accidentally expose print assets.

## API and UI contract

All responses are `Cache-Control: no-store`; mutations use the existing exact-origin/CSRF boundary, owner scope, expected revisions/hashes, and stable safe errors.

```text
GET  /api/layout/projects/:projectId
POST /api/layout/pages/:pageId/recalculate
POST /api/layout/pages/:pageId/composition-source
POST /api/layout/projects/:projectId/cover-composition
POST /api/layout/projects/:projectId/preview-regenerate
GET  /api/layout/previews/:previewOutputId/pdf
POST /api/layout/previews/:previewOutputId/sent
POST /api/layout/previews/:previewOutputId/approve
POST /api/layout/previews/:previewOutputId/changes-requested
GET  /api/layout/projects/:projectId/approved-snapshot-status
```

Automatic generation is primary; the explicit regenerate endpoint is a version-checked successor action, not a bypass. PDF download serves only an indexed ready asset through the existing safe asset boundary and never accepts paths.

The Citrus Playground Arabic RTL view shows the ordered book, placement/preset/aid/warning facts, shared browser composition, cover proofs, workflow/`pdf_pending`, exact preview version/hash summary, download, sent/approved/changes-requested controls, invalidation cause and affected items. Status is text+icon, not color-only. Use logical CSS, Western digits, `<bdi>` for IDs/hashes, ≥44px controls, visible focus, programmatic labels/errors, reduced-motion behavior, and no horizontal clipping at 390×844, 1440×900, or 1920×1080.

## Test-first order

1. strict schemas, customer-content/approval/derivative hashes, composition-profile compatibility, repository migration and CAS;
2. pure LayoutPolicy fixtures for every placement, score tie, aid, floor, overflow, name, safe-area, bidi and bubble path;
3. layout head/work-request commit, lock semantics, stale/canceled/fence rejection;
4. special-page/cover compilers and escaped browser/PDF shared inputs;
5. workflow persistence and strict local job definitions;
6. transient derivative policy, offline renderer, mechanical validator and atomic PreviewOutput commit;
7. approval lifecycle, idempotency/two-tab race and ApprovedBookSnapshotReader;
8. one-pass invalidation registry, missing IM producers, all affecting matrix rows and receipt replay;
9. API/UI, 390/1440/1920 RTL accessibility/no-egress tests;
10. real SIGKILL/ENOSPC/rename recovery, 16/24 E2E, Arabic/PDF goldens, coverage and staged scans.

## Checkpoint evidence

Implementation may mark slice 008 complete only when every 008-C item passes; the full test/check/build/format/audit/clean-install suite is green; `src/domain/layout/**`, `src/layout/**`, and slice-owned `src/pdf/**` meet at least 80% statements/branches/functions/lines; the complete 24-page synthetic preview plus cover proofs is mechanically validated and visually inspected; real kill/restart proves one output; browser/PDF capture proves zero egress; and `IMPLEMENTATION_NOTES.md` records commands, counts, rendered artifacts, staged SC-007/010 boundaries, and residual risks.

Feature 009 remains blocked until the immutable approved-book snapshot guard exists. Slice 008 does not claim print watermark absence, printer preflight, or executed print-producer blocking.

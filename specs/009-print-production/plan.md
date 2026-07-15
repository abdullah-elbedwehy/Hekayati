# Implementation Plan: Print Production

**Feature**: `009-print-production`

**Spec**: [spec.md](spec.md)

**Canonical plan**: [integrated plan](../001-hekayati-product-bible/plan.md)

**Tasks**: T-P8-01–T-P8-07

## Technical context

Extend the existing one-process TypeScript application with a provider-free print domain. Reuse Slice 008's immutable approved-book reader, composition compatibility predicate, Arabic composition primitives, bundled fonts, Chromium renderer, qpdf/Poppler inspection, content-addressed asset store, SQLite repositories, durable local scheduler, invalidation transaction, loopback API boundary, and Citrus Playground UI. Use Ghostscript only for an explicitly CMYK profile with an exact imported four-channel ICC asset.

G3 and T-P0-07 are PASS. Current local tools are Ghostscript 10.07.1, qpdf 12.3.2, Poppler 26.05.0, and the Playwright-pinned Chromium/font stack already exercised by 008. No Gemini/Codex capability or credential is needed. The real printer's profile/template and physical proof remain manual launch evidence; synthetic profiles cover implementation acceptance without pretending to be printer truth.

All PDF, ICC, template, proof-raster, and full-resolution image bytes stay outside JSON. Documents persist strict IDs, hashes, geometry, bounded validation facts, revisions, states, and audit evidence only. No network, sidecar service, external telemetry, cloud store, raw operator path, or alternate renderer is introduced.

## Constitution and dependency check

- **Local-only / privacy**: PASS — loopback API, private indexed assets, offline renderer/converter, no provider calls or external resources.
- **Durability**: PASS — strict local jobs, immutable artifacts, revisioned heads, claim/source/authorization fences, atomic file promotion and restart recovery.
- **Human gates**: PASS — customer approval is consumed, never recreated; CMYK conversion adds one exact operator proof gate and generic queue controls cannot complete it.
- **No silent fallback**: PASS — missing Ghostscript/ICC/spine/template or any failed preflight blocks; no RGB substitution, guessed geometry, quality reduction, upscale, or renderer switch.
- **Arabic and print quality**: PASS — same approved composition/fonts, full-resolution sources, mechanical preflight plus raster inspection and G3 corpus repetition.
- **Invalidation**: PASS — print joins the original frozen transaction; IM-14/15/18/19/20 are reason-specific and no event auto-regenerates.
- **008 dependency**: PASS — `f9acf9a` supplies approved snapshot, stable authorization hash, source integrity guard, compatible geometry predicate, PDF infrastructure, and preview watermark evidence.
- **Feasibility**: PASS — G3/T-P0-07 evidence and required local binaries exist. Actual-printer CHK317/318 remain pre-commercial manual gates, not implementation blockers.

## Canonical model decisions

### Printer profile lineage

`PrinterProfile` is a revisioned head:

```text
id, schemaVersion, createdAt, updatedAt, revision,
name, currentVersionId, archived
```

`PrinterProfileVersion` is immutable and pins:

```text
profileId, previousVersionId,
trim { widthMm, heightMm, orientation: portrait },
bleedMm,
safeContentRegion { x, y, width, height },
dpiMin,
color { mode: rgb|cmyk, iccAssetId?, iccChecksum? },
cropMarks { enabled, offsetMm, lengthMm, strokePt },
spine { source: explicit|template|missing, widthMm? },
coverTemplate? {
  assetId, checksum, pageWidthMm, pageHeightMm,
  backRegion, spineRegion, frontRegion, toleranceMm
},
requiredBlankPages[] { position: before_interior|after_interior, count, label },
profileHash, readiness: ready|incomplete, blockingReasons[]
```

All numeric ranges are finite, positive where applicable, bounded, and cross-checked. Safe geometry is normalized and must contain the approved composition safe rectangle after identity trim mapping. Blank rules are unique by position, bounded, and never accept content. A template-sourced spine must equal the template center region. CMYK requires an indexed valid four-channel ICC. RGB forbids a CMYK-only conversion claim. Unknown keys, raw bytes, source paths, commands, provider data, secrets, and unbounded notes reject.

ICC/template uploads are transient requests. ICC sniffing checks header length, `acsp` signature, declared data color space, byte cap, and checksum. Template PDF inspection checks one page, parseability, encryption, boxes, dimensions, and prohibited features before indexing. The profile stores only asset IDs/checksums. AssetStore adds closed roles `icc_profile`, `printer_template`, `pdf_interior`, `pdf_cover`, and `print_proof` with compatible MIME/metadata rules.

### Print run and immutable outputs

`PrintRun` is a revisioned project-owned workflow:

```text
projectId, familyId, customerId,
requestHash, contentAuthorizationHash,
approvalCycleId, approvalGateJobId, previewOutputId,
customerContentHash, compositionProfileId/hash,
printerProfileId, printerProfileVersionId/hash,
state: queued|producing|preflight_pending|converted_proof_pending|
       deliverable|blocked|stale|rejected,
interiorJobId, coverJobId, preflightJobId?, convertedProofGateJobId?,
currentInteriorArtifactId?, currentCoverArtifactId?,
currentPreflightReportId?, convertedProofBundleHash?,
blockingReasons[], staleReasons[], invalidatedByEventIds[]
```

`PrintArtifact` is immutable and has `kind: interior|cover`, exact run/job/profile/authorization IDs and hashes, indexed asset ID/checksum/bytes, color mode/ICC hash, renderer/converter/font policy versions, source snapshot hash, page/spread map hash, and bounded render facts. It never stores source bytes, paths, customer text, command output, or a mutable latest reference.

`PrintPreflightReport` is immutable and pins the exact run, both artifact IDs/checksums, preview evidence, profile/authorization hashes, registry version, tool versions, ordered findings, measurements, page map/blanks, font/PPI/box/spread/color/watermark facts, and `passed`. `passed` means zero blocking finding and cannot be edited.

`ConvertedProofAction` is an append-only idempotency ledger for `approved|rejected`, binding owner scope, run/gate/artifact/profile/ICC/authorization hashes, input revisions, normalized notes, and exact stored result. Only approval succeeds the human gate and advances the run to deliverable/project to `print_ready`.

### Geometry contracts

Interior and cover share a pure `PrinterGeometry` compiler:

- `trimOffset = bleed + cropMarkMargin`;
- `cropMarkMargin = enabled ? offset + length : 0`;
- interior MediaBox = trim + two outer `(bleed + cropMarkMargin)` margins;
- BleedBox excludes crop-mark margin; TrimBox additionally excludes bleed;
- approved normalized composition regions map by identity inside TrimBox;
- printer-safe containment is checked before materialization and again in preflight;
- background art extends through BleedBox with the already-approved fit; no scale changes the trim mapping;
- blank pages use identical boxes, no customer number, no hidden content, and explicit report entries.

Cover spread trim width is `back trim + spine + front trim`; height is one trim height. Back begins at the left trim edge, spine is centered, front is right. Outer bleed/crop margins surround the entire spread; panel boundaries/fold lines are facts, not customer-visible content. Template geometry must match this compilation within its pinned tolerance. Crop marks remain outside BleedBox and do not intersect panel safe regions.

### Renderer and color boundary

Use separate typed entry points:

```text
renderPrintInterior(ApprovedBookSnapshot, PrinterProfileVersion, assets)
renderPrintCover(ApprovedBookSnapshot, PrinterProfileVersion, assets)
```

There is no `watermark` boolean and no generic preview/print quality switch. Both entry points:

- consume full-resolution indexed sources by exact checksum;
- compile escaped local HTML/CSS with bundled hash-verified Arabic fonts;
- disable JavaScript and abort HTTP(S), file, websocket, worker, and unknown schemes;
- preserve approved text/layout/cover data and expose DOM overflow/safe-region facts;
- render RGB candidates with explicit MediaBox/TrimBox/BleedBox geometry and optional marks; and
- return bytes plus bounded page/spread/source/font/PPI metadata.

For CMYK, `convertPdfToCmyk` stages the exact ICC asset, calls Ghostscript via `execFile` with a fixed argument vector and `-dSAFER` permit limited to that file, enforces timeout/output caps, and validates the temporary candidate with qpdf/Poppler before atomic promotion. The validator requires the selected ICC checksum/output intent, four channels, CMYK-only resources/operators/images, unchanged page boxes/count/fonts, and no watermark/prohibited content. Any failure returns a stable normalized category and never promotes or falls back.

### Closed preflight registry

`PrintPreflightPolicy/v1` is an exhaustive code-keyed registry. Every rule declares applicable artifact family, severity, measurement, and expected value. The report is sorted by artifact, page, and registry order so identical inputs are deterministic. Blocking codes include:

```text
PDF_CORRUPT / PDF_ENCRYPTED
PAGE_DIMENSIONS_MISMATCH / PAGE_ORIENTATION_INVALID
PAGE_COUNT_MISMATCH / PAGE_MAP_MISMATCH / PRINTER_BLANK_MISMATCH
SOURCE_ASSET_MISSING / SOURCE_CHECKSUM_MISMATCH
IMAGE_PPI_LOW / TEXT_OVERFLOW
FONT_MISSING / FONT_NOT_EMBEDDED / FONT_NOT_SUBSETTED /
FONT_TOUNICODE_MISSING / GLYPH_COVERAGE_MISSING
BLEED_MISSING / SAFE_MARGIN_VIOLATION / CROP_MARKS_INVALID
COVER_SPREAD_INVALID / COVER_PANEL_ORDER_INVALID / SPINE_WIDTH_UNKNOWN
COLOR_MODE_MISMATCH / ICC_PROFILE_MISSING / ICC_OUTPUT_INTENT_MISMATCH /
COLOR_CONVERSION_FAILED
PRINT_WATERMARK_PRESENT / PREVIEW_WATERMARK_MISSING
PDF_PROHIBITED_FEATURE / EXTERNAL_RESOURCE_PRESENT
AUTHORIZATION_MISMATCH / PROFILE_VERSION_MISMATCH
```

The seeded-defect table is itself tested against the registry so removing a required category fails SC-006. Arabic shaping correctness remains rendered/golden/manual evidence; mechanical glyph/font/overflow facts do not overclaim visual semantics.

## Durable workflow and authorization fences

### Materialization

`PrintProductionService.start` takes owner scope, project ID, expected project/profile versions, exact content authorization hash, and idempotency key. It validates imported assets/profile compatibility, then executes one SQLite transaction that:

1. reads and verifies the current 008 approved snapshot with synchronous indexed-integrity facts;
2. compares every exact request/snapshot/profile hash;
3. returns an identical current run for an exact replay;
4. inserts one run and deterministic `print_interior`/`print_cover` local jobs; and
5. changes no project content/approval version.

Any failure rolls back all records. No placeholder run or blocked job is created. Blocking compatibility facts are returned ephemerally to the UI.

### Producers and finalizer

Interior and cover jobs each perform:

1. **prepare fence**: guard + authorization + run + profile + source integrity;
2. **render/convert/validate**: prepare an unindexed asset;
3. **commit fence** inside `scheduler.commitWith`: repeat guard/profile/source/run/head checks, atomically index bytes and insert one immutable artifact/head; and
4. advance the run. When both exact artifacts exist, enqueue one deterministic `print_preflight` job.

The preflight job repeats the same guard before reading assets and at commit. Its commit inserts the immutable report. RGB success atomically marks the run `deliverable` and Project `print_ready`. CMYK success enqueues one version-bound `human_gate` and marks `converted_proof_pending`; the proof action later owns the final transition. Failure records bounded job/run state, never deliverable state.

IM-15 successors may reuse an exact non-stale interior artifact only when authorization, composition, interior-relevant profile hash, source checksums, and integrity all match. Every other invalidation re-renders the affected artifact. Reuse is explicit lineage in the new run, not a mutable alias or hidden skip.

### Invalidation

Add a print participant to the already assembled invalidation transaction. It resolves current run, interior, cover, report, proof gate, and project print-ready state before the receipt is written. Consequences:

- IM-01/03–13 customer-visible rows: stale applicable interior/cover/report/run, cancel waiting jobs/proof gate, clear deliverable current projection, keep immutable history, no regeneration;
- IM-14: approval unchanged; stale both print artifacts/report/run for the compatible new profile;
- IM-15: preserve interior; stale cover/report/run and cancel proof gate;
- IM-16/17/18/19/21: no print consequence; IM-19 in-flight commit remains valid under the same authorization hash;
- IM-20: exact referenced integrity block with affected IDs; no download/commit while bad. Byte-identical repair/reverification can clear only the integrity block and restore the same run/artifacts; different bytes enter ordinary version/invalidation/approval flow.

Receipt replay returns frozen IDs/hash/actions and never queries later artifacts. One correlation bumps `bookVersion` only where the canonical row already prescribes it; print-only rows do not bump content version.

## API and UI contract

All responses are `Cache-Control: no-store`. Unsafe requests require the existing exact origin/CSRF token. Project routes require exact customer/family ownership; profile routes are operator-local but still revision/CSRF checked. No route accepts or returns a filesystem path.

```text
GET    /api/print/profiles
POST   /api/print/profiles
PUT    /api/print/profiles/:profileId
POST   /api/print/profile-assets/icc
POST   /api/print/profile-assets/cover-template
PUT    /api/print/projects/:projectId/profile
GET    /api/print/projects/:projectId
POST   /api/print/projects/:projectId/start
POST   /api/print/runs/:runId/proof/approve
POST   /api/print/runs/:runId/proof/reject
GET    /api/print/runs/:runId/interior.pdf
GET    /api/print/runs/:runId/cover.pdf
GET    /api/print/runs/:runId/proof/:proofId
```

Downloads verify current run/head/preflight/proof/authorization/profile/file integrity at request time, set safe attachment names and exact MIME/content length, and never serve non-deliverable output through final routes. Proof routes are visibly candidate-only.

The Arabic RTL print workspace has three layers: printer profile readiness/import, project production timeline, and preflight/proof/download. It shows actual versus expected values and remediation without exposing internal paths/commands. Status never relies on color alone. Use logical CSS, Western digits, `<bdi>`, semantic tables/lists, focus-visible, programmatic errors/live regions, ≥44 px targets, reduced motion, and responsive single-column collapse.

## Source layout

```text
src/domain/print/
  schemas.ts                 # strict profile/run/artifact/report/action contracts
  repositories.ts            # immutable/revisioned SQLite documents
  profiles.ts                # import, versioning, compatibility, project assignment
  geometry.ts                # interior/crop/bleed/cover spread calculations
  preflight.ts               # closed FR-123 rule registry and reports
  workflow.ts                # guarded materialization and artifact/preflight heads
  proof-approval.ts          # CMYK exact human gate + action ledger
  invalidation.ts            # print participant and integrity restoration
  workspace.ts               # scoped UI projection/download guards
src/print/
  icc.ts                     # bounded ICC inspection
  template.ts                # hostile one-page template inspection
  cmyk.ts                    # argument-safe Ghostscript conversion
src/pdf/
  print-document.ts          # exact full-resolution interior/cover composition
  print-renderer.ts          # typed interior and cover entry points
  print-preflight.ts         # qpdf/Poppler PDF inspection adapters
src/jobs/print-definitions.ts
src/server/routes/print-api.ts
src/ui/views/PrintView.tsx
src/ui/components/print/**
src/ui/print.css
tests/unit/print-*.test.ts
tests/integration/print-*.test.ts
tests/failure-injection/print-restart.test.ts
tests/e2e/print.spec.ts
```

Keep production files ≤800 lines by extracting policy, validation, and projection helpers. Extend shared code only where the print contract genuinely consumes it; no 009 behavior belongs in provider adapters.

## Test-first order

1. strict profile/run/artifact/report/action schemas, repository CAS/immutability, ICC/template hostile parsers;
2. pure compatibility and interior/cover/crop/blank geometry tables;
3. exhaustive preflight registry and every seeded FR-123 defect fixture;
4. approved-snapshot materialization zero-work matrix and exact idempotency;
5. full-resolution offline interior/cover RGB renderers and mechanical/raster evidence;
6. Ghostscript CMYK conversion, output-intent/color checks, failure preservation, and proof gate ledger;
7. durable separate producers/finalizer with pre-execution/commit fences, cancellation, duplicate and real restart injection;
8. print invalidation participant for all applicable IM rows, frozen replay, IM-19 continuity, IM-20 repair, and IM-15 interior reuse;
9. no-store scoped API/download/hostile-upload tests and Arabic three-width UI E2E;
10. clean install, full check/build/audit/coverage, rendered evidence, staged scan, implementation notes, commit and push.

## Alternatives rejected

- **One mutable printer record**: cannot pin jobs, compare stale tabs, or reproduce output; use immutable versions behind a revisioned head.
- **Persist raw ICC/template paths**: leaks operator filesystem structure and allows later path substitution; import bytes into the indexed private store and pin checksum.
- **One opaque combined print producer**: prevents IM-15 cover-only invalidation/reuse and hides independent artifact fences; use interior, cover, then exact preflight finalizer.
- **Guess spine from page count/paper stock**: printer-dependent and explicitly forbidden; require explicit/template truth.
- **Silently deliver RGB after CMYK failure**: violates no-fallback and printer intent; block with the exact conversion finding.
- **Use PDFKit/pdf-lib as a second renderer**: loses G3 Arabic parity and creates divergent composition; retain Chromium with mechanical inspection.
- **Trust generation metadata without parsing PDFs**: cannot catch corrupt boxes/fonts/resources/watermarks; preflight actual candidate bytes plus pinned render facts.
- **Treat preflight as advisory**: violates FR-123; any blocking finding keeps artifacts non-deliverable.
- **Auto-complete converted proof**: color acceptability is human judgment; use one exact waiting-review gate.
- **Require actual printer hardware for code acceptance**: would fabricate or externally block deterministic implementation; record CHK317/318 as explicit pre-commercial manual gates.

## Checkpoint evidence

Implementation may mark Slice 009 complete only when every 009 checklist item passes; all required FR-123 defect categories are caught; 16/24 RGB and CMYK synthetic runs produce exact interior/cover geometry with zero print watermark; actual producers prove guard checks at materialization, pre-execution, and commit; real restart/failure tests prove no partial/current output; rendered Arabic/bleed/spine evidence is inspected; UI/API security passes at three widths; `src/domain/print/**`, `src/print/**`, and slice-owned print PDF modules each meet ≥80% statements/branches/functions/lines; clean install/check/build/audit/format/staged scans pass; and `IMPLEMENTATION_NOTES.md` records residual actual-printer proof requirements honestly.

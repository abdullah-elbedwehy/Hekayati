# Verification Checklist: 009 Print Production

**Status**: READY — evidence required at implementation checkpoint

**Canonical checklists**: [product acceptance](../001-hekayati-product-bible/checklists/product-acceptance.md) · [print production](../001-hekayati-product-bible/checklists/print-production.md) · [privacy/security](../001-hekayati-product-bible/checklists/privacy-security.md) · [Arabic RTL UX](../001-hekayati-product-bible/checklists/ux-arabic-rtl.md)

## Printer truth, persistence, and imports

- [x] 009-C01 Strict PrinterProfile/head/version schemas cover exact trim/bleed/safe/DPI/color/ICC/crop/spine/template/blank fields, readiness and immutable profile hash; reject unknown keys, raw bytes/commands/provider bodies, arbitrary paths, secrets, NaN/infinite/out-of-range geometry, invalid state pairs, and unbounded diagnostics.
- [x] 009-C02 Built-in defaults are A4 portrait, 3 mm bleed, 10 mm safe margin, 300 DPI, RGB and crop marks off, but remain visibly incomplete for cover until explicit/template spine truth exists; defaults never claim actual-printer verification.
- [x] 009-C03 Revisioned profile heads use exact CAS and immutable successors. Duplicate/replay behavior is deterministic; editing never mutates a prior version or a running job's pinned version/hash.
- [x] 009-C04 ICC import is bounded/content-sniffed and validates ICC length/signature/data color space/checksum. CMYK requires four channels; malformed/RGB-as-CMYK/oversize/secret/path/symlink-like input leaves zero profile asset/reference.
- [x] 009-C05 Cover-template import accepts only a parseable unencrypted one-page PDF, validates boxes and declared back/spine/front geometry, rejects active content/forms/attachments/embedded/remote/file refs, and stores only indexed asset ID/checksum plus bounded facts.
- [x] 009-C06 Asset roles/MIME/origin rules separate ICC, template, interior, cover and proof assets; every imported/generated file is private, content addressed, mode-safe, integrity-verifiable, and absent from JSON/logs/UI except IDs/checksums/bounded facts.
- [x] 009-C07 Project profile assignment enforces owner and project/profile revisions, exact compatibility and readiness. Failure changes no project/profile/run/job state and returns explicit bounded migration reasons.
- [x] 009-C08 Compatibility tables cover portrait, both independent trim tolerances, no scaling, normalized safe containment and every boundary equality; bleed/DPI/color/ICC/crop/spine/blanks never alter the approved composition predicate.

## Geometry, composition, and source fidelity

- [x] 009-C09 Pure interior geometry fixes MediaBox/BleedBox/TrimBox and crop-mark margin/offset/length for marks on/off, maps approved trim regions by identity, and keeps marks/text outside prohibited regions across boundary fixtures.
- [x] 009-C10 Pure cover geometry fixes back-left/spine-center/front-right RTL order, outer bleed/crop margin, fold/panel regions and total dimensions from exact explicit/template spine; zero/missing/conflicting/reversed geometry blocks before render.
- [x] 009-C11 Exact 16/24 approved page maps produce exact customer order. Closed before/after printer blank rules add only bounded blank output pages with explicit report indices/kinds and never change preview numbering, page hashes or customer page numbers.
- [x] 009-C12 Interior compiler consumes only ApprovedBookSnapshot page/layout/composition/text/source refs and exact full-resolution indexed checksums. Mutable latest heads, preview derivatives, source paths, automatic upscale/crop/enhance and hidden quality fallback are impossible.
- [x] 009-C13 Cover compiler consumes the exact approved CoverCompositionVersion front/back text/assets/regions and adds only pinned printer geometry/spine treatment. It cannot invent or edit title, child name, synopsis, brand, environment, logo or artwork.
- [x] 009-C14 Background bleed expansion preserves the approved trim view and is deterministic; text/safe content stays inside the approved safe region. Overflow or insufficient source resolution becomes an exact blocking finding, not reflow/shrink/upscale.
- [x] 009-C15 Browser templates are escaped, JavaScript-disabled and deny HTTP(S), file, websocket, worker, CDN and unexpected schemes; hostile markup/BiDi/internal/contact/consent/provenance fixtures execute/load/leak nothing and capture zero egress.

## RGB, CMYK, PDF, and preflight

- [x] 009-C16 Typed interior/cover print entry points contain no watermark/footer and cannot be invoked through a preview-quality/watermark boolean. RGB default never calls Ghostscript and produces exact indexed PDF families.
- [x] 009-C17 Ghostscript uses argument-safe execution, fixed options, timeout/output caps, `-dSAFER`, and read permission limited to the exact staged ICC; no shell interpolation, ambient source path, broad filesystem permit, raw stderr or command line is persisted/logged/returned.
- [x] 009-C18 CMYK validation proves selected ICC checksum/output intent, embedded four-channel profile, CMYK image/resources/operators, no residual RGB resources/operators, geometry/page/font parity, parseability and atomic candidate promotion. Any missing tool/profile, timeout, nonzero exit, wrong channel or failed check blocks with no RGB fallback.
- [x] 009-C19 Converted-proof bundle pins interior/cover/ICC/profile/authorization checksums and representative local rasters. One exact owner/revision/hash/idempotency human gate is mandatory; only approval succeeds it/delivers, rejection records normalized notes, and generic controls cannot approve.
- [x] 009-C20 Preflight registry is closed/versioned and its completeness test requires every FR-123 category. Removing/renaming a mandatory row or accepting an unknown policy makes the suite fail.
- [x] 009-C21 Parse/corrupt/encrypted, dimensions/orientation/boxes, page count/map/blanks, missing/checksum source, effective DPI, text overflow, font embedding/subsetting/ToUnicode/glyph, bleed, safe margin, crop mark, spread/panel/spine, color/ICC/conversion, watermark, prohibited-resource and authorization/profile rules report exact bounded code/artifact/page/expected/actual facts.
- [x] 009-C22 One seeded defect fixture per FR-123 category is caught with zero false deliverable; watermark present in either print artifact and missing from approved preview are separate checks. A clean RGB and a clean CMYK bundle have zero blocking finding.
- [x] 009-C23 Successful reports persist exact actual boxes/map/blanks/fonts/PPI/spread/color/output-intent/watermark/source/output/tool/policy facts but no raw bytes, customer text/image data, paths, ICC content, command output or unbounded diagnostics.
- [x] 009-C24 16- and 24-page full-resolution outputs meet profile DPI, embed the pinned Lemonada/IBM Plex fonts with ToUnicode/glyph coverage, preserve Arabic shaping/BiDi and contain zero print watermark/footer; cover is exactly one valid spread.

## Authorization, durability, and invalidation

- [x] 009-C25 Materialization invokes the 008 guard inside the run/job transaction and pins stable contentAuthorizationHash plus exact approval/gate/output/composition/profile/page/layout/review/text/source evidence. Every mismatch/integrity/profile block creates zero run, job, asset, action or head.
- [x] 009-C26 Exact start replay returns one run/job set after restart; key/hash collision, stale project/profile revision or changed authorization creates no partial state. No print start changes bookVersion/customer approval.
- [x] 009-C27 Interior and cover are separate strict local jobs with exact dependencies and source requests. Each rechecks guard/profile/run/source before execution and inside commit; stale/canceled/superseded/old-fence output advances no artifact/head.
- [x] 009-C28 When both exact artifacts exist, one deterministic preflight job is enqueued. RGB preflight commit atomically delivers/project `print_ready`; CMYK commit creates one proof gate and remains non-deliverable until its exact approval.
- [x] 009-C29 File commit is prepare → validate → atomic rename → scheduler-owned DB transaction. Ready/current metadata never precedes bytes; rollback/discard/GC cannot delete a prior valid same-hash artifact or leave an unindexed downloadable file/refcount.
- [x] 009-C30 Real SIGKILL during interior render, cover render, CMYK conversion, validation, after temp fsync and after rename/before DB resumes idempotently to at most one current interior, cover, report and proof gate with exact attempts and no partial exposure.
- [x] 009-C31 ENOSPC/EACCES/tool absence/validation failure/duplicate execution/cancel/rollback and disk recovery preserve completed history, create no blocked-attempt artifact/head, keep storage stop semantics and require no weakened policy.
- [x] 009-C32 Original invalidation transaction resolves/applies print participants and freezes run/artifact/report/gate IDs/actions in the receipt. Replay never resolves later state, every current job/gate is canceled or preserved exactly, and no regeneration starts automatically.
- [x] 009-C33 Real customer-visible IM rows stale applicable print artifacts/report/run and clear current deliverability while preserving immutable history; a locked page remains byte-identical/locked_stale upstream and still blocks print authorization.
- [x] 009-C34 Compatible IM-14 leaves approval intact and invalidates both print artifacts/report only; IM-15 preserves/reuses exact interior and invalidates cover/report only; incompatible profile fails before IM-14 and requests 008 migration.
- [x] 009-C35 IM-18/19 change no print record or authorization; IM-19 between prepare and commit preserves identical contentAuthorizationHash and succeeds. New actions against stale preview remain rejected independently.
- [x] 009-C36 Referenced IM-20 blocks execution/commit/download; byte-identical repair plus integrity recheck restores the same authorization/run/artifacts without new approval, while different bytes cannot clear the block and require ordinary version/invalidation/reapproval.

## API, UI, and release evidence

- [x] 009-C37 Scoped no-store APIs reject wrong family/project/profile/run/artifact/revision/hash, paths, non-current/non-deliverable output, unsafe MIME/size/templates and forged browser requests before body mutation or bytes; downloads use indexed current assets and safe attachment headers only.
- [x] 009-C38 Arabic Citrus Playground UI exposes profile defaults/readiness/import/assignment/compatibility, exact approved/profile/run versions, interior/cover/preflight/proof progress, blank-page map, actual findings and safe proof/final downloads without presenting incomplete printer truth as healthy.
- [x] 009-C39 UI passes RTL keyboard order, visible focus, programmatic labels/errors/live status, ≥44px targets, Western digits/mixed BiDi, text+icon state, reduced motion, axe, long findings/profile names, no color-only action and no horizontal clipping at 390×844, 1440×900 and 1920×1080.
- [x] 009-C40 Rasterized evidence proves connected Arabic, lam-alef, tashkeel, punctuation, mixed BiDi, long names, all interior kinds, blank mapping, safe margins, bleed continuity, crop marks, RTL cover/spine alignment, RGB/CMYK proof comparison and no clipping.
- [x] 009-C41 Clean install, format, lint, font check, typecheck, unit/integration/failure/E2E/golden suites, build and dependency audit pass; `src/domain/print/**`, `src/print/**` and slice-owned print PDF code each meet ≥80% statements/branches/functions/lines.
- [x] 009-C42 Staged scan finds no real child/customer data, secrets, home paths, DB/runtime/generated PDF/raster/ICC/template output or provider payload; fixtures are synthetic, automated suites make zero provider/network call, and unrelated Flow work remains unstaged.
- [x] 009-C43 `IMPLEMENTATION_NOTES.md` records commands/counts/coverage, defect-registry detection, RGB/CMYK mechanical reports, rendered evidence, authorization-fence/invalidation/restart fault evidence, files/IDs affected and residual risks.
- [x] 009-C44 CHK317 physical proof and CHK318 actual-printer profile/template/ICC round-trip are recorded as explicit pending pre-commercial operator gates unless real evidence is supplied; synthetic G3/009 evidence is never mislabeled as actual printer acceptance.

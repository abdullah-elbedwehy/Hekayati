# Analyze Report: 009 Print Production

**Date**: 2026-07-15

**Verdict**: PASS — ready for implementation

**Master tasks**: T-P8-01–T-P8-07

**Feasibility**: G3 and T-P0-07 PASS; required local tools present; no provider/account gate applies

## Scope and dependency result

Slice 008 is implemented and pushed as `f9acf9a`. It supplies the strict approved-book snapshot, stable content authorization hash, exact source/review/layout/cover lineage, integrity guard, customer-composition compatibility predicate, offline Chromium/font stack, PDF inspection primitives, content-addressed asset commit, scheduler transaction, and invalidation handoff required by 009.

The slice now owns only printer truth and output mechanics: versioned profiles, full-resolution interior, RTL cover spread, optional ICC-bound CMYK conversion with proof approval, exhaustive preflight, exact guarded production, invalidation, and operator delivery UI. It does not edit story/layout/cover content, recreate customer approval, infer printer geometry, call an AI provider, export archives, or implement Flow.

| Area | Analyze result |
|---|---|
| Scope | PASS — FR-121–123 and US7 are owned; FR-057/086/087/120/124 are consumed at exact boundaries without absorbing 008 or 010 |
| Dependency | PASS — 008 approved snapshot and guard are implemented; Phase 7 checkpoint is green |
| Feasibility | PASS — G3/T-P0-07, Ghostscript 10.07.1, qpdf 12.3.2, Poppler and Chromium/font evidence exist |
| Printer model | PASS — revisioned head + immutable version, exact defaults/readiness, indexed hostile ICC/template imports, closed spine/template/blank/crop geometry |
| Compatibility | PASS — portrait, independent trim tolerance, no scaling and safe containment are pure; incompatible input creates zero work and requires 008 migration |
| Output lineage | PASS — run, separate immutable interior/cover artifacts, report and optional proof gate pin authorization/profile/source hashes |
| Geometry | PASS — Media/Bleed/Trim boxes, crop margin, blank positions and back-left/spine/front-right spread math are closed |
| Rendering | PASS — typed watermark-free full-resolution entry points reuse G3 Arabic Chromium stack and deny all egress |
| Color | PASS — RGB default; CMYK requires exact four-channel ICC, argument-safe fail-closed Ghostscript, output-intent/resource checks and human proof approval |
| Preflight | PASS — closed registry enumerates every FR-123 defect category and requires a seeded failing fixture per category |
| Durability | PASS — zero-work materialization, pre-execution and commit guard fences, separate jobs/finalizer, atomic files, restart/fault behavior are specified |
| Invalidation | PASS — customer-visible, IM-14, IM-15, IM-18/19 and IM-20 semantics are explicit, frozen and non-regenerating |
| API/UI | PASS — scoped no-store imports/status/proof/download contract and three-width Arabic RTL acceptance are closed |
| Release boundary | PASS — deterministic local acceptance is separable from honestly pending actual-printer physical proof/round-trip |

## Traceability

| Requirement / criterion | Slice evidence route |
|---|---|
| FR-057 / C-04 | Clarified contract 8; A-009-04; 009-C11/C24 |
| FR-086 / SC-010 | Clarified contract 5–7/15–17; A-009-03/09/10/11; 009-C25–C36 |
| FR-087 / C-27 | Clarified contract 4/16; A-009-02/10; 009-C07–C10/C34 |
| FR-120–122 / C-12 | Clarified contract 1–12; A-009-01/04–07; 009-C01–C19 |
| FR-123 / SC-006 | Clarified contract 13–14; A-009-08; 009-C20–C24 |
| FR-124 / SC-007 | Clarified contract 10/13; A-009-04–08/12; 009-C16/C21–C24/C40 |
| SC-008 | A-009-04–07/12/14; 009-C12–C24/C38–C41 |
| US7-AS1–5 | A-009-01–15; 009-C01–C44; T-P8-01–07 |
| EC-F01–F14 | Closed preflight registry; A-009-05/07/08; 009-C18–C24 |
| IM-14/15/18/19/20 | Clarified contract 16; A-009-09/10; 009-C32–C36 |
| RR-05/RR-11/RR-19 | Arabic/render evidence, converted-proof gate, exact authorization/profile fences, and manual actual-printer boundary |
| CHK301–316 | Mapped into 009-C09–C43 and implementation notes evidence |
| CHK317/318 | 009-C44 records them as explicit pre-commercial manual gates |

Every owned master task has an implementation and acceptance route. Every blocking FR-123 category has a named preflight code family and seeded-defect obligation. No requirement is silently relaxed into an advisory.

## Blocking questions resolved during readiness

1. **How are printer settings pinned?** A mutable settings blob would make old output irreproducible. One revisioned PrinterProfile head now points to immutable versions; every run pins version ID/hash.
2. **How are ICC/template files persisted safely?** Raw paths would leak or later substitute bytes. Imports now copy mechanically validated bytes into private indexed assets and persist only IDs/checksums/facts.
3. **Can an A4 default produce a cover?** No. Defaults are visible but incomplete until positive explicit/template spine truth exists. Missing spine creates zero print work.
4. **How can IM-15 rebuild only the cover?** Interior and cover are separate producers/artifacts followed by one exact preflight finalizer; a successor may explicitly reuse a still-current exact interior.
5. **When does authorization run?** At materialization inside the run/job transaction, again before each producer/finalizer executes, and again inside each scheduler-owned commit. Stable IM-19 observation drift is excluded; actual content/profile/source mismatch blocks.
6. **What happens if one producer completed before later invalidation?** Its immutable history remains indexed, but the current run/report/deliverable projection is staled and downloads block. A blocked pending attempt commits no new artifact/head.
7. **How is bleed added without changing approved composition?** The approved trim maps by identity into TrimBox. Bleed expands only outside trim; printer-safe containment is checked before work and text never reflows.
8. **How are crop marks dimensioned?** Offset/length/stroke are profile data. Enabled marks add a deterministic outer margin; they remain outside BleedBox and safe content.
9. **How are printer blanks represented?** Closed before/after blank rules add report-only output pages without content/customer numbering/hash changes.
10. **Does CMYK fall back to RGB?** Never. Any tool/ICC/conversion/output-intent/color failure blocks and preserves prior valid output.
11. **Who approves converted color?** A dedicated exact human gate and append-only action ledger; no automated or generic queue approval.
12. **How is visual Arabic/color quality proven?** Mechanical font/glyph/geometry checks plus rasterized G3/production evidence and manual inspection. Mechanical facts alone do not claim semantic visual correctness.
13. **Does implementation require a real printer today?** No. G3 proves the mechanism with synthetic fixtures. Actual printer profile/template/ICC round-trip and physical proof remain explicit CHK317/318 gates before a commercial order.
14. **Can Flow alter this scope?** No. Pending 012 changes remain outside 009; any later reviewed imported image reaches print only through the same 008 snapshot refs.

## Alternatives rejected

- Persist mutable profile fields directly on Project: loses reusable profile lineage and makes jobs drift.
- Store operator ICC/template paths: violates privacy/portability and permits time-of-use substitution.
- Guess spine from book pages: explicitly forbidden and printer/paper dependent.
- Build one combined opaque PDF job: cannot honor IM-15 cover-only invalidation or independently fence artifacts.
- Deliver artifacts before preflight/proof: violates FR-123 and color-risk controls.
- Treat conversion warnings as advisory or retry RGB: violates fail-closed/no-fallback rules.
- Add a Python/WeasyPrint or PDFKit path: second runtime/renderer diverges from G3 Arabic composition.
- Trust HTML/render metadata without parsing actual PDF bytes: misses corruption, boxes, fonts, resources, output intent and watermark leakage.
- Make actual physical printer access an implementation blocker: confuses deterministic product completion with a clearly recorded operational launch gate.

## Readiness decision

No constitution conflict, user-choice ambiguity, provider credential dependency, missing local mechanism, or unowned behavior remains. The actual printer's production profile and physical proof are intentionally external operator inputs; the product explicitly blocks delivery until configured and does not need to fabricate them to implement the workflow.

Slice 009 is ready for TDD implementation in T-P8-01 → T-P8-07 order. Product code remains limited to this dependency-ready slice and the exact tasks above.

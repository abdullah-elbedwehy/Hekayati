# Print Production Checklist: Hekayati

**Purpose**: Verify print-ready output quality: geometry, color, Arabic typography, preflight.
**Created**: 2026-07-14 | **Feature**: [spec.md](../spec.md) §3.19, research R9/R10

## Geometry & Structure

- [ ] CHK301 Interior: A4 portrait trim + configured bleed (default 3 mm) on every page; measured in produced PDF (FR-121)
- [ ] CHK302 Page count/order matches approved bookVersion; printer blanks flagged, invisible to preview numbering (FR-057, EC-F14)
- [ ] CHK303 Safe margins respected; violations preflagged (FR-123)
- [ ] CHK304 Crop marks togglable per printer profile and geometrically correct
- [ ] CHK305 Cover spread: back + spine + front geometry per profile/template; RTL binding orientation correct (EC-F10)
- [ ] CHK306 Spine width only from profile/template; unknown → blocked (FR-122, EC-F04)

## Image & Color

- [ ] CHK307 Effective image resolution ≥ profile DPI (default 300) verified per placed image (EC-F02)
- [ ] CHK308 RGB default; CMYK conversion runs only with profile ICC; failure blocks; converted proof approval step exists (C-12, EC-F09)
- [ ] CHK309 Preview downsampled ~150 DPI; ≤16 MB @24pp (C-06, SC-007)

## Arabic Typography

- [ ] CHK310 Shaping golden corpus passes in produced PDFs: connected forms, lam-alef, tashkeel, punctuation, mixed-direction (SC-008, gate G3)
- [ ] CHK311 Both licensed Arabic fonts embedded (subset) — verified by PDF font inspection (EC-F06)
- [ ] CHK312 Text never below age-band minimum (14pt/12pt defaults); fallback chain warns instead of shrinking (FR-082)
- [ ] CHK313 Dialogue bubbles point to correct speakers on fixture set (FR-083)

## Watermark & Preflight

- [ ] CHK314 Watermark on every preview page; absent from every print page; both preflight-enforced (FR-124, EC-F11/F13)
- [ ] CHK315 Each FR-123 defect category has a seeded fixture caught by preflight — suite fails otherwise (SC-006)
- [ ] CHK316 Preflight failure list is specific (what, where, expected vs actual) and blocks "deliverable" marking

## Physical Validation

- [ ] CHK317 One physical proof print inspected before first commercial order: shaping, colors, margins, spine alignment (RR-05/RR-11, quickstart §9)
- [ ] CHK318 Printer-profile round-trip verified with the actual printing company's specs (bleed, color mode, spine source)

# G3 — Arabic PDF and Cover/CMYK Scorecard

**Tasks**: T-P0-06, T-P0-07
**Date**: 2026-07-14
**Operator**: Codex delivery loop (synthetic local fixtures)
**Commit**: recorded by the Phase 0 evidence commit
**Status**: PASS

## Safety and fixture declaration

- The corpus and artwork are deterministic synthetic fixtures. They contain no child, customer, or provider data.
- Chromium runs offline. Any HTTP(S) request is blocked and makes the probe fail.
- Fonts are read only from `spikes/fixtures/fonts/`; generated HTML, PDFs, Poppler output, and rasters stay under ignored `spikes/.local-artifacts/g3/`.
- The committed scorecard may contain hashes, tool versions, dimensions, and review findings only. Do not attach generated PDFs or raster output to Git.

## Environment

| Item | Observed value |
|---|---|
| macOS version / architecture | 26.0 (25A354), arm64 |
| Node.js | 26.3.0, captured by the fresh `arabic-result.json` probe process |
| Playwright | 1.61.1 |
| Chromium | 149.0.7827.55 (Playwright-pinned) |
| Poppler (`pdfinfo`, `pdffonts`, `pdfimages`, `pdftoppm`) | 26.04.0 |
| Ghostscript | 10.07.1 |
| qpdf | 12.3.2 |
| Generic CMYK ICC path | `/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc` |
| Generic CMYK ICC SHA-256 | `0c8a584b288a306eac9e1d3f1e68bc1b64331c717ceb051420e6257f17b3509a` |

## Font provenance and embedding

Authoritative URLs, pinned versions/commits, licenses, and checked-in binary hashes live in [`../fixtures/fonts/SOURCES.md`](../fixtures/fonts/SOURCES.md). Copy the observed hashes from `arabic-result.json` and confirm they match that manifest.

| Role | Local file | Version/source pin | License | Expected SHA-256 | Observed SHA-256 | Embedded + subsetted |
|---|---|---|---|---|---|---|
| Display | `Lemonada-SemiBold.ttf` | Lemonada v4.005 / pinned Google Fonts commit | SIL OFL 1.1 | `7a51391cbecb60a7b6dac8b2b45ef72109e93568ae78016e246027ce09af9d4a` | exact match | yes / yes |
| Body | `IBMPlexSansArabic-Regular.ttf` | IBM package 1.1.0 / pinned peeled commit | SIL OFL 1.1 | `8e0f1046c736bf939d4939ee3ae0116acf61cbcd6592deae7656761627080981` | exact match | yes / yes |

- [x] Both browser font checks report loaded.
- [x] `pdffonts` reports every font embedded and subsetted with Unicode maps.
- [x] Zero CDN/HTTP(S) requests attempted.
- [x] Font hashes match `SOURCES.md` exactly.

## T-P0-06 — Arabic interior probe

Run:

```bash
cd spikes
npm run g3:arabic
```

Expected deterministic geometry:

| Check | Expected | Observed | Result |
|---|---:|---:|---|
| Page count | 2 | 2 | PASS |
| CSS/PDF page size | 216 × 303 mm | 612 × 858.96 pt (within 0.75 pt tolerance) | PASS |
| Trim | 210 × 297 mm, inset 3 mm | DOM and visual guides at 3 mm | PASS |
| Synthetic PNG | 1800 × 1200 px | 1800 × 1200 px | PASS |
| Placed size | 152.4 × 101.6 mm (6 × 4 in) | 152.4 × 101.6 mm | PASS |
| Effective image resolution | 300 ±1 PPI on each axis | 300 × 300 PPI (Poppler) | PASS |
| Poppler rasters | 2 pages at 144 DPI | 2 visually inspected pages | PASS |

Mechanical evidence paths (ignored runtime output):

- `.local-artifacts/g3/arabic-result.json`
- `.local-artifacts/g3/arabic-pdfinfo.txt`
- `.local-artifacts/g3/arabic-pdffonts.txt`
- `.local-artifacts/g3/arabic-pdfimages.txt`
- `.local-artifacts/g3/arabic-pdftotext.txt`
- `.local-artifacts/g3/arabic-raster-1.png`
- `.local-artifacts/g3/arabic-raster-2.png`

Manual inspection rubric:

- [x] Initial, medial, final, and isolated Arabic forms join correctly.
- [x] `لا / لأ / لإ / لآ` lam-alef forms render correctly.
- [x] Tashkeel remains attached and legible without collisions.
- [x] Arabic punctuation, guillemets, Arabic-Indic digits, decimal separator, and Latin punctuation appear in correct visual order.
- [x] Mixed Arabic/Latin names, IDs, dates, and numerals follow correct BiDi order.
- [x] Long Arabic name remains inside the trim/safe boundary without clipping.
- [x] No tofu, black squares, missing glyphs, overlap, or text clipping.
- [x] Crop, bleed, trim, and safe guides appear at the expected edges.
- [x] Synthetic raster art is sharp at its stated physical size.

**T-P0-06 result**: PASS

## T-P0-07 — Cover spread and CMYK probe

Run:

```bash
cd spikes
npm run g3:cover
```

Default synthetic printer geometry:

| Region | X origin | Width | Y origin | Height | Observed | Result |
|---|---:|---:|---:|---:|---|---|
| Full spread | 0 mm | 436 mm | 0 mm | 303 mm | 435.996 × 302.998 mm at (0, 0) | PASS |
| Back (left) | 3 mm | 210 mm | 3 mm | 297 mm | 209.996 × 296.999 mm at (2.997, 2.997) | PASS |
| Spine (center) | 213 mm | 10 mm | 3 mm | 297 mm | 9.996 × 296.999 mm at (212.998, 2.997) | PASS |
| Front (right) | 223 mm | 210 mm | 3 mm | 297 mm | 209.996 × 296.999 mm at (222.998, 2.997) | PASS |

CMYK and failure-path checks:

- [x] RGB source PDF is one 436 × 303 mm page.
- [x] Ghostscript uses the system Generic CMYK ICC profile through an argument-safe process call; `-dSAFER` has an explicit read permit for only that profile.
- [x] CMYK output remains one 436 × 303 mm page with embedded/subsetted font.
- [x] qpdf reports exactly one `/GTS_PDFX` output intent whose embedded four-channel ICC stream SHA-256 exactly matches the selected profile.
- [x] Every image resource is `/DeviceCMYK`; no `/DeviceRGB` resource or `rg`/`RG` page-content operator remains, and CMYK `k`/`K` operators are present.
- [x] `inkcov` reports non-zero C, M, Y, and K coverage; observed values recorded below.
- [x] A deliberately missing ICC returns non-zero and no failed temporary output is promoted to the final CMYK path.
- [x] Supplying Ghostscript's sRGB ICC as the output profile fails the RGB-operator guard; the prior valid final PDF SHA-256 remains byte-for-byte unchanged.
- [x] Geometry, fonts, qpdf integrity/color-space/output-intent checks, ink coverage, and rasterization all pass against the temporary PDF before one atomic rename replaces the final path; the prior final is never unlinked first.
- [x] RGB and CMYK Poppler rasters were compared; the smoke-fixture shift is acceptable.

Observed CMYK coverage: `C=0.98997 M=0.99507 Y=0.99210 K=0.28459`

Mechanical evidence paths (ignored runtime output):

- `.local-artifacts/g3/cover-result.json`
- `.local-artifacts/g3/cover-rgb-pdfinfo.txt`
- `.local-artifacts/g3/cover-rgb-pdffonts.txt`
- `.local-artifacts/g3/cover-invalid-icc.txt`
- `.local-artifacts/g3/cover-gs-cmyk.txt`
- `.local-artifacts/g3/cover-cmyk-pdfinfo.txt`
- `.local-artifacts/g3/cover-cmyk-pdffonts.txt`
- `.local-artifacts/g3/cover-cmyk-qpdf-check.txt`
- `.local-artifacts/g3/cover-cmyk-inkcov.txt`
- `.local-artifacts/g3/cover-rgb-raster-1.png`
- `.local-artifacts/g3/cover-cmyk-raster-1.png`

Manual inspection rubric:

- [x] Physical order is back-left, spine-center, front-right.
- [x] Back/front trim widths, spine width, bleed, fold lines, and crop marks align exactly.
- [x] Artwork crosses bleed continuously without white seams.
- [x] Arabic text shapes correctly on front, back, and vertical spine.
- [x] No clipping, unexpected rotation, extra pages, or font substitution.
- [x] CMYK proof color shift is acceptable for this smoke fixture; production still requires the printer-supplied ICC/profile and an approved converted proof.

**T-P0-07 result**: PASS

## Gate decision

**G3 decision**: PASS

PASS requires all mechanical assertions plus manual raster inspection to pass. A font/CDN, shaping/BiDi, geometry, image-resolution, embedding, CMYK-conversion, or fail-closed defect is a G3 failure. Per the risk register, catastrophic G3 failure blocks PDF-dependent Phases 7–8 and triggers alternative-renderer research; it does not silently relax print requirements.

Notes / defects / follow-up:

- The first CMYK attempt failed closed because Ghostscript 10.07.1 `-dSAFER` denied the ICC read. The probe now grants an explicit read permit for the selected ICC path and nothing broader; the rerun passed.
- Mechanical shaping checks are not treated as semantic proof by themselves. The committed PASS includes visual inspection of both Arabic pages and both RGB/CMYK cover rasters.
- The system Generic CMYK profile proves the local conversion path only. A production printer profile must still provide and approve its own ICC/template.

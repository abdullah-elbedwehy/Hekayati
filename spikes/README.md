# Phase 0 Spikes

Throwaway feasibility probes for master tasks T-P0-01–T-P0-08. These are not product code and are excluded from product coverage.

## Safety

- Synthetic fictional characters and deterministic artwork only. Never use customer data or a real child's image.
- Never read or copy Codex auth files. `codex login status` is the only auth inspection.
- Gemini credentials may be read into process memory from macOS Keychain service `com.hekayati.gemini-api-key`; scripts never print, persist, pass through argv, or include the value in evidence.
- Raw JSONL, provider payloads, generated images, PDFs, rasters, and caches live under ignored `spikes/.local-artifacts/`.
- Commit scripts, deterministic source fixtures, font/license sources, sanitized scorecards, tool versions, and hashes only.
- A missing credential is recorded as a dated gate failure/unavailable environment, never worked around with another billing/auth path.

## Setup

```bash
cd spikes
npm install
npx playwright install chromium
npm run typecheck
```

Ghostscript, Poppler, and qpdf are host tools. On macOS:

```bash
brew install ghostscript poppler qpdf
```

Font fixtures are local files under `fixtures/fonts/`; see their `SOURCES.md` for authoritative sources, licenses, and SHA-256 hashes. No runtime CDN request is permitted.

## Gates

| Gate | Command | Sanitized evidence |
|---|---|---|
| G1-T Codex text | `G1T_CODEX_BIN="$(command -v codex)" npm run g1t -- --model <exact-id>` | `evidence/g1t-scorecard.md` |
| G1-I Codex image | `npm run g1i` | `evidence/g1i-scorecard.md` |
| G4 Gemini IDs/account | `npm run g4` | `evidence/g4-scorecard.md` |
| G2 Gemini consistency | `npm run g2` | `evidence/g2-scorecard.md` |
| G3 Arabic PDF | `npm run g3:arabic` | `evidence/g3-scorecard.md` |
| G3 cover/CMYK | `npm run g3:cover` | `evidence/g3-scorecard.md` |

Run G4 before G2. Gate scripts fail closed: an unverified mandatory condition is a FAIL, not an assumption.

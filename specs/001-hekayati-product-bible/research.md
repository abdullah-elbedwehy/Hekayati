# Research: Hekayati — Technology Decisions & Feasibility

**Feature**: `001-hekayati` | **Date**: 2026-07-14 | **Status**: Complete (runtime-verification items marked)

Each entry: Decision / Rationale / Alternatives considered / Verification status. Entries marked **[VERIFY AT PHASE 0]** contain assumptions about fast-moving external tools that MUST be re-verified against the installed versions and current official docs before dependent implementation (they are feasibility-gate inputs, not settled facts).

---

## R1 — Local web application architecture on macOS

**Decision**: Single Node.js (current LTS) + TypeScript process, running an HTTP server (Fastify) bound to `127.0.0.1`, serving a React SPA (Vite build, RTL-first) and hosting the in-process job worker loop. Started via a simple launcher script (`npm run app` → builds if needed, starts server, opens browser). No Docker for the core app. Optional launchd agent for auto-start is a post-v1 nicety.

**Rationale**:
- One employee, one Mac: a single supervised process is the simplest thing that satisfies restart-recovery requirements (recovery is DB-driven, not process-driven).
- Codex CLI invocation, macOS Keychain (`security` CLI), `sips` (HEIC), and direct filesystem access all require host execution — Docker would break or complicate all four (constitution: Docker only where it helps).
- Node has first-party SDKs for both provider families and mature tooling for every other subsystem (Playwright, sharp, better-sqlite3).
- Browser UI requirement is explicit; Electron adds packaging complexity without benefit for a localhost-only tool.

**Alternatives**:
- *Electron/Tauri app*: heavier packaging, no requirement for native windowing; browser-based UI explicitly requested.
- *Python (FastAPI) backend*: viable, but Codex SDK, Playwright-PDF, and the JS UI stack make a single-language TS codebase simpler for one maintainer.
- *Docker Compose stack*: rejected for core (Keychain/Codex/sips access, startup reliability); permitted later only for optional isolated add-ons if ever needed.

---

## R2 — Local NoSQL persistence

**Decision**: Document-oriented data model implemented on **embedded SQLite via `better-sqlite3`**: one table per collection (`customers`, `characters`, `projects`, `jobs`, …) with `id TEXT PRIMARY KEY`, `doc JSON` (validated at the repository boundary), plus generated columns/indexes for hot query fields. WAL mode, synchronous=FULL for job/version commits. A thin repository layer exposes only document semantics (get/put/query by indexed fields), so the engine can be swapped for MongoDB later without touching domain code. This satisfies spec clarification C-01 (flexible NoSQL **data model**; engine is a plan decision).

**Rationale**:
- Zero-daemon: survives restarts trivially, no service management for a non-technical operator, single-file backup semantics.
- Real ACID transactions — required for job leases, idempotent commits, and version preconditions (FR-065, FR-109). Mongo single-node transactions require a replica-set config; SQLite gives this for free.
- `better-sqlite3` is synchronous → simple, race-free queue operations in one process.
- JSON documents keep schema flexibility (characters with arbitrary trait sets, template variables).

**Alternatives**:
- *MongoDB (Homebrew service)*: closest to literal "NoSQL"; rejected: daemon lifecycle management by one non-ops employee, transactions need replica set, heavier install. Revisit only if multi-process scaling ever appears (out of scope).
- *CouchDB/PouchDB*: replication features unneeded; weaker ad-hoc queries; extra service (CouchDB) or weaker durability story (PouchDB/LevelDB).
- *LowDB / JSON files*: no transactions, corruption-prone under crash — fails FR-113.

---

## R3 — Durable background-job scheduling without extra infrastructure

**Decision**: Bespoke minimal scheduler persisted in the same SQLite DB (`jobs` collection): dependency edges, priority, state machine, **lease-based claiming** (worker claims with `lease_expires_at`; expired leases are reclaimable), **idempotency keys** (unique index), attempt counters, normalized failure categories, progress events table. Single in-process worker pool with per-provider concurrency limits. Full semantics in `contracts/job-scheduler-contract.md`.

**Rationale**: Every off-the-shelf durable queue drags in a daemon (BullMQ→Redis, pg-boss→Postgres, Agenda→Mongo, Temporal→cluster). The required feature set (deps, leases, idempotency, pause reasons, restart recovery) is small and must be exactly right for this product's semantics (quota-pause, stale-lease commit rejection) — features no generic queue provides natively. Deterministic rules only; "smart scheduler" explicitly does not mean AI (FR-109).

**Alternatives**: BullMQ (Redis daemon — rejected), pg-boss (wrong DB), in-memory queue + crash-replay (fails FR-113), Temporal/Windmill (grossly over-engineered for one machine).

---

## R4 — Media asset storage & atomic writes

**Decision**: Content-addressed asset store on the filesystem at `~/Library/Application Support/Hekayati/assets/<sha256[0:2]>/<sha256>.<ext>`; DB stores metadata (checksum, mime, dimensions, provenance, role). Writes: temp file in same volume dir → `fsync` → atomic `rename` → DB insert in the committing transaction. Deletion = DB unlink then physical delete via reference counting. Directory perms 0700, files 0600 (FR-130).

**Rationale**: Large binaries out of the document DB (explicit permission in operating context); content addressing gives free dedup (retry-produced duplicates hash identically → no duplicates, FR-092/FR-093), corruption detection (FR-097), and cheap export checksums (FR-125).

**Alternatives**: BLOBs in SQLite (bloats DB, slow backups; fine for thumbnails only — allowed later), UUID-named files (no dedup/integrity), external object store (absurd locally).

---

## R5 — Codex subscription authentication & programmatic orchestration **[VERIFY AT PHASE 0]**

**Decision (provisional)**: Integrate Codex via the **Codex CLI in non-interactive mode** (`codex exec`), using the employee's existing ChatGPT-subscription login (managed by `codex login`, stored in Codex's own auth store — never copied by Hekayati). Structured output via the CLI's JSON/schema output options where supported by the installed version; otherwise strict prompt-and-validate against our canonical schemas. Adapter shells out with `execFile` (no shell interpolation), per-call timeout, cancellation via process kill, and exit-code/stderr → normalized-failure mapping.

**Known at time of writing** (Jan 2026 knowledge — re-verify): Codex CLI supports non-interactive `exec` runs, ChatGPT-account auth without an API key, JSON event output, and an experimental structured-output/schema flag; an official TypeScript SDK wrapping the CLI exists. Quota exhaustion surfaces as rate-limit/usage errors distinguishable from auth errors.

**Feasibility gate G1-T (Codex text)** — must answer before Phase 4 marks Codex text mode available:
1. Installed CLI invocable programmatically under subscription login? 2. Reliable structured results (schema or validated JSON)? 3. Rate-limit/quota exhaustion detectable & distinguishable from auth failure? 4. Cancellation kills the run without orphan processes? 5. Behavior complies with current official product terms for programmatic local use?

**Alternatives**: OpenAI API with API key — **forbidden** by FR-100; Codex MCP server mode — viable alternate transport, evaluate at G1-T if `exec` proves awkward; screen automation of ChatGPT — non-compliant and fragile, rejected.

---

## R6 — Codex subscription image generation **[VERIFY AT PHASE 0 — expected NEGATIVE]**

**Decision (provisional)**: Treat **Codex-mode image generation as UNAVAILABLE** pending gate G1-I. As of the model knowledge cutoff, Codex CLI is a coding agent: it accepts image *input* but exposes no supported programmatic image *generation* under subscription usage, and no documented path saves generated illustration artifacts to a local path. Consequences (already encoded in FR-102): Codex image mode shown as unavailable with the recorded limitation; no secret API-key fallback; Gemini image mode remains the working image path; provider interface keeps an image slot for a future compliant implementation.

**Feasibility gate G1-I** — the seven questions from the product brief, answered against the installed environment:
1. Programmatic invocation under subscription? 2. Reliable structured results? 3. Image generation invocable programmatically? 4. Artifacts savable to a predictable local path? 5. Quota exhaustion reliably detectable? 6. Resumable without duplicating completed work? 7. Compliant with current official product behavior?
**Pass requires ALL seven.** Any failure → record in this file + risk register RR-01, keep UI limitation notice. Do not proceed with Codex image pipeline work on hope.

---

## R7 — Gemini structured output & image generation **[VERIFY AT PHASE 0]**

**Decision (provisional)**: Official `@google/genai` JS SDK. Text/structured: configured text model with `responseSchema`/JSON-mode structured output validated again locally (never trust provider-side validation alone). Images: configured image model with multi-reference image inputs (character reference images + style directives), response images saved via the atomic asset path.

**Model IDs are configuration, not constants** (FR-107). Requested defaults — `gemini-3.5-flash` (text), `gemini-3.1-flash-image` "Nano Banana 2" (image), `gemini-3.1-flash-lite-image` "Nano Banana 2 Lite" (economy) — postdate this document's training data and MUST be checked against `models.list` + current official docs at Phase 0; record renames/deprecations here. Runtime re-checks availability before every batch (FR-098). The economy model carries a persistent weaker-consistency warning (FR-108).

**Feasibility gate G2 (Gemini image references & consistency)**: with 2–3 reference images of one child, across 5 sequential scene prompts, does the configured default image model hold recognizable identity (human judgment, structured scorecard)? How many distinct characters per image before identity degradation (informs capability matrix + C-08 threshold)? Does the API accept enough reference images per request for 3 characters?

**Alternatives**: Vertex AI (needs GCP project + service accounts — heavier auth for one operator; rejected), REST without SDK (more code, no benefit).

---

## R8 — macOS Keychain credential storage

**Decision**: Use the macOS `security` CLI (`add-generic-password -U`, `find-generic-password -w`, `delete-generic-password`) via `execFile` with argument arrays (no shell), service name `com.hekayati.gemini-api-key`, account = key label. Key material lives only in Keychain; the app holds it in memory per call and redacts it from all logging (FR-105/106, tested).

**Rationale**: Zero native-module dependencies, works on every macOS, ACL ties access to the invoking user session. `execFile` avoids shell-history/escaping leaks; the secret is passed via `-w` argument — acceptable for a single-user machine but see risk RR-08 (argv briefly visible in process table) with mitigation (use `security add-generic-password` interactive stdin mode if the installed macOS supports it; verify at Phase 1).

**Alternatives**: `keytar` (unmaintained/deprecated — rejected), `@napi-rs/keyring` (maintained native module; adopt if the `security`-CLI argv concern proves material at Phase 1), plaintext dotfile (forbidden by constitution XIV).

---

## R9 — Arabic text shaping, RTL, font embedding & PDF generation

**Decision**: **HTML/CSS → headless Chromium print-to-PDF via Playwright** for all three outputs (preview, interior, cover). Chromium's text stack (HarfBuzz + BiDi) gives correct Arabic shaping, ligatures (lam-alef), diacritics, RTL ordering, and embeds subsetted fonts in the PDF. Page geometry via `@page { size: 216mm 303mm }` (A4 + 2×3 mm bleed) with trim/safe guides drawn from the printer profile; crop marks drawn as vector elements in the template. Fonts: two licensed embeddable Arabic families (one display for titles, one high-legibility text face, e.g., from the SIL-OFL Arabic families), preloaded and verified embedded in preflight.

**Rationale**: Every JS PDF library (pdf-lib, PDFKit, jsPDF) lacks full Arabic shaping/BiDi without fragile manual HarfBuzz integration. The browser engine is the only battle-tested local Arabic typesetter available to this stack, and it doubles as the layout engine for text-placement presets (same CSS in UI preview and PDF → WYSIWYG parity). Playwright pins its Chromium → reproducible output.

**Alternatives**: pdf-lib/PDFKit + harfbuzzjs (high-risk hand-rolled shaping — rejected), WeasyPrint (Python sidecar; good shaping but adds a second runtime), Typst/LaTeX (template authoring burden, weaker HTML/CSS parity with UI), InDesign automation (nonstarter locally).

**Feasibility gate G3 (Arabic print pipeline)**: golden-file test of a shaping-stress corpus (connected forms, lam-alef, tashkeel, Arabic punctuation, mixed-direction lines with Latin names/numbers) rendered to PDF; manual + snapshot verification; font-embedding check via PDF inspection; 300 DPI image placement verified at physical size.

---

## R10 — Print production: bleed, CMYK, ICC, crop marks, cover spread, spine

**Decision**:
- Interior: A4 portrait trim + 3 mm default bleed (printer-profile override), safe margin default 10 mm, effective-DPI preflight ≥300 (configurable), optional crop marks.
- Color: **RGB PDF by default** (C-12); when a printer profile demands CMYK, convert via **Ghostscript** with the profile's ICC (`-sColorConversionStrategy=CMYK -sOutputICCProfile=…`), then re-preflight; conversion failure blocks delivery (FR-123).
- Cover: single spread PDF = back + spine + front + wraparound bleed. Spine width is **never computed by guess**: it comes from the printer profile (explicit mm value) or an imported printer template (PDF/dimensions spec); absent both → production blocked (FR-122). Page-count changes re-flag spine confirmation.
- Preflight implemented as an explicit rule list over the produced PDF (parse via `pdf-lib`/`pdfinfo`-class tooling + our render metadata): dimensions, page count, image effective resolution, font embedding, bleed presence, safe-margin violations, watermark presence/absence, spread geometry, corrupt-file check.

**Rationale**: Matches printing-industry norms while honoring "defaults are not universal printer truth" — everything printer-variable lives in PrinterProfile. Ghostscript is the only dependable local CMYK/ICC converter with scriptable CLI.

**Alternatives**: pdfcpu (no color conversion), commercial preflight (cost/cloud), asking the printer to convert (kept as an allowed workflow — profile can mark "deliver RGB").

---

## R11 — Project ZIP export/import & archive security

**Decision**: `yazl`/`yauzl` (streaming, no zip-slip-prone extract helpers). Export: stage manifest (`manifest.json`: schemaVersion, appVersion, createdAt, project ID map, file list + sha256) → write entries → finalize; then run the automated secret-scan (pattern set: Gemini key format, `auth.json` markers, Keychain dump signatures) before handing the file to the operator (FR-126). Import: read central directory → validate every entry name (reject `..`, absolute paths, symlink entries, zero-byte-name), reject executables by content sniff, verify manifest + checksums, check disk space → extract to staging dir → transactional DB import with ID remapping → move assets into store → commit; any failure = delete staging, nothing visible (FR-128).

**Alternatives**: `adm-zip` (memory-bound, historical traversal issues — rejected), tar (weaker Windows interchange later; zip requested).

---

## R12 — Image-reference & character-consistency limitations across providers

**Findings (encoded in `provider-capability-matrix.md`)**:
- No current image model guarantees identity consistency; drift grows with participant count, unusual poses, and style distance from references. Product stance already set: "recognizable, consistent, approved likeness" + mandatory human review (FR-016, FR-117).
- Practical mitigations specified: character-sheet-first workflow (generate canonical illustrated views once, then use *sheet images* as references for pages — anchors style + identity), ≤3 characters per image warning threshold (C-08, tunable per matrix), per-scene negative constraints against extra people (FR-041), consistency review view (FR-119).
- Economy-tier image models measurably weaker on multi-reference identity → persistent warning (FR-108).
- Codex family: image generation unavailable pending G1-I (R6) → matrix rows marked accordingly.
- HEIC intake: macOS `sips` converts HEIC→PNG/JPEG natively (no patent-encumbered lib needed); `sharp` handles resize/crop/format thereafter. EXIF orientation applied before stripping metadata (FR-021).

---

## Feasibility gates summary (Phase 0 exit criteria)

| Gate | Question | Expected | Blocking for |
|---|---|---|---|
| G1-T | Codex text via subscription, programmatic + structured + quota-detectable + compliant | Likely PASS (verify) | Codex text mode availability |
| G1-I | Codex image generation under subscription (7 questions, all must pass) | Likely FAIL — record limitation | Codex image mode only (product proceeds via Gemini) |
| G2 | Gemini multi-reference character consistency acceptable; per-image character capacity measured | PASS with measured limits | Default image pipeline parameters, C-08 threshold |
| G3 | Arabic shaping/RTL/font-embedding/bleed correct in Chromium-printed PDF | PASS (verify with golden corpus) | Entire PDF pipeline |
| G4 | Verified current Gemini model IDs recorded; renames noted | Config update only | Settings defaults |

Gate outcomes are recorded by editing this file's gate table + risk register; a failed gate never silently downgrades — it changes visible product capability messaging (FR-102).

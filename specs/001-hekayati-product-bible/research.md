# Research: Hekayati — Technology Decisions & Feasibility

**Feature**: `001-hekayati` | **Date**: 2026-07-14 | **Status**: Phase 0 complete — dated PASS/FAIL outcomes recorded; G2/G4 await a Gemini credential

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

- _Electron/Tauri app_: heavier packaging, no requirement for native windowing; browser-based UI explicitly requested.
- _Python (FastAPI) backend_: viable, but Codex SDK, Playwright-PDF, and the JS UI stack make a single-language TS codebase simpler for one maintainer.
- _Docker Compose stack_: rejected for core (Keychain/Codex/sips access, startup reliability); permitted later only for optional isolated add-ons if ever needed.

---

## R2 — Local NoSQL persistence

**Decision**: Document-oriented data model implemented on **embedded SQLite via `better-sqlite3`**: one `documents` table keyed by `(collection, id)` with validated JSON, schema version, and timestamps, plus indexes/generated columns for hot query fields as they appear. WAL mode and synchronous=FULL protect job/version commits. The app connection uses SQLite's OS-released exclusive locking mode for its lifetime, acquired before startup asset recovery; a second process sharing the data root fails as `DATA_ROOT_IN_USE` before it can sweep or mutate data. A thin repository layer exposes only document semantics (get/put/query by indexed fields), so the engine can be swapped later without touching domain code. This satisfies spec clarification C-01 (flexible NoSQL **data model**; engine is a plan decision).

The configured data root is claimed before any child directory, database, or cleanup is created: a valid `.hekayati-data-root.json` ownership marker is required on reuse, while an unowned non-empty root and symlinked root/managed child directory fail closed. This prevents a mistaken `HEKAYATI_DATA_DIR` from turning an unrelated directory into application-owned storage.

**Rationale**:

- Zero-daemon: survives restarts trivially, no service management for a non-technical operator, single-file backup semantics.
- Real ACID transactions — required for job leases, idempotent commits, and version preconditions (FR-065, FR-109). Mongo single-node transactions require a replica-set config; SQLite gives this for free.
- `better-sqlite3` is synchronous → simple, race-free queue operations in one process.
- JSON documents keep schema flexibility (characters with arbitrary trait sets, template variables).
- The retained OS-level exclusive database lock enforces the specified single-process topology and disappears automatically on graceful close, `SIGKILL`, or reboot; no PID/stale-lock reclamation protocol is needed.

**Alternatives**:

- _MongoDB (Homebrew service)_: closest to literal "NoSQL"; rejected: daemon lifecycle management by one non-ops employee, transactions need replica set, heavier install. Revisit only if multi-process scaling ever appears (out of scope).
- _CouchDB/PouchDB_: replication features unneeded; weaker ad-hoc queries; extra service (CouchDB) or weaker durability story (PouchDB/LevelDB).
- _LowDB / JSON files_: no transactions, corruption-prone under crash — fails FR-113.

---

## R3 — Durable background-job scheduling without extra infrastructure

**Decision**: Bespoke minimal scheduler persisted in the same SQLite DB (`jobs` collection): dependency edges, priority, state machine, **lease-based claiming** (worker claims with `lease_expires_at`; expired leases are reclaimable), **idempotency keys** (unique index), attempt counters, normalized failure categories, progress events table. Single in-process worker pool with per-provider concurrency limits. Full semantics in `contracts/job-scheduler-contract.md`.

**Rationale**: Every off-the-shelf durable queue drags in a daemon (BullMQ→Redis, pg-boss→Postgres, Agenda→Mongo, Temporal→cluster). The required feature set (deps, leases, idempotency, pause reasons, restart recovery) is small and must be exactly right for this product's semantics (quota-pause, stale-lease commit rejection) — features no generic queue provides natively. Deterministic rules only; "smart scheduler" explicitly does not mean AI (FR-109).

**Alternatives**: BullMQ (Redis daemon — rejected), pg-boss (wrong DB), in-memory queue + crash-replay (fails FR-113), Temporal/Windmill (grossly over-engineered for one machine).

---

## R4 — Media asset storage & atomic writes

**Decision**: Content-addressed derived/generated asset store on the filesystem at `~/Library/Application Support/Hekayati/assets/<sha256[0:2]>/<sha256>.<ext>`; DB stores metadata (checksum, mime, dimensions, provenance, role). Exact reference-photo uploads use a structurally separate private namespace, `.../originals/<sha256[0:2]>/<sha256>.<ext>`, whose IDs cannot enter provider requests. Both namespaces share one prepared-write primitive: temp file in the same volume dir → `fsync` → atomic `rename`; all logical asset/reference/version metadata is then inserted in one committing transaction. Deletion = DB unlink then physical delete via reference counting. Startup GC removes only reserved `.hekayati-tmp-*` files and canonical `<sha256>.<ext>` names that are unindexed within the exact managed namespace/depth; unknown filenames are never swept. A failed normal intake compensates its prepared files immediately, while a crash before DB commit leaves only recognized unindexed files for startup GC. Directory perms 0700, files 0600; ownership/symlink checks cover both roots (FR-025/130).

**Rationale**: Large binaries out of the document DB (explicit permission in operating context); content addressing gives free dedup (retry-produced duplicates hash identically → no duplicates, FR-092/FR-093), corruption detection (FR-097), and cheap export checksums (FR-125). The separate exact-original namespace makes "never sent to providers" a type/path boundary and avoids forcing incompatible original/working metadata onto one globally unique asset hash.

**Alternatives**: BLOBs in SQLite (bloats DB, slow backups; fine for thumbnails only — allowed later), UUID-named files (no dedup/integrity), external object store (absurd locally).

---

## R5 — Codex subscription authentication & programmatic orchestration **[VERIFIED — G1-T PASS 2026-07-14]**

**Decision**: Integrate Codex via the **Codex CLI in non-interactive mode** (`codex exec`), using the employee's existing ChatGPT-subscription login (managed by `codex login`, stored in Codex's own auth store — never copied by Hekayati). Use JSONL events plus `--output-schema`, then validate the final result again against Hekayati's canonical schema. The adapter shells out with `execFile` (no shell interpolation), with per-call timeout, process-group cancellation, exact-model checks, and normalized failure mapping.

**Verified result**: Codex CLI 0.144.3, Node 26.3.0 in the probe process, and the saved ChatGPT login completed a live synthetic schema-constrained call explicitly requesting `gpt-5.5`; the CLI run header reported the same resolved model and the exact local schema validator passed. Cancellation removed the process group; isolated logged-out, missing-binary, and invalid-model probes normalized correctly. Pinned official Codex source revision `fb350d1e7d52c4c3b42f230a4715ee4adf314f08` distinguishes subscription `usage_limit_reached`/API `insufficient_quota`, ordinary retry-limit 429, and refresh-token unauthorized signals. Executable classifier fixtures prove those documented signals map to distinct local categories; live account exhaustion was deliberately not forced and is not claimed as observed. For this gate, “detectable” means a pinned authoritative signal contract plus executable classification, not manufacturing an exhausted account. Official non-interactive and authentication docs explicitly support `codex exec`, schemas, and trusted local automation with ChatGPT-managed auth. No API-key variable or auth file was read or forwarded by the probe.

Current stable CLI 0.144.3 listed `gpt-5.6-sol` in its model catalog but still rejected a direct call as requiring a newer CLI; exact model `gpt-5.5` passed. Therefore catalog presence does not enable a model: CLI version plus a direct exact-model/schema probe remains the runtime health check, and Hekayati never silently substitutes a model. Sanitized evidence: [`spikes/evidence/g1t-scorecard.md`](../../spikes/evidence/g1t-scorecard.md).

**Feasibility gate G1-T (Codex text)** — must answer before Phase 4 marks Codex text mode available:

1. Installed CLI invocable programmatically under subscription login? 2. Reliable structured results (schema or validated JSON)? 3. Rate-limit/quota exhaustion detectable & distinguishable from auth failure? 4. Cancellation kills the run without orphan processes? 5. Behavior complies with current official product terms for programmatic local use?

**Alternatives**: OpenAI API with API key — **forbidden** by FR-100; Codex MCP server mode — viable alternate transport, evaluate at G1-T if `exec` proves awkward; screen automation of ChatGPT — non-compliant and fragile, rejected.

---

## R6 — Codex subscription image generation **[VERIFIED — G1-I FAIL 2026-07-14]**

**Decision**: Codex-mode image generation is **UNAVAILABLE**. Keep the provider image slot for a future compliant workflow, but ship the visible limitation required by FR-102. There is no secret API-key fallback; Gemini remains an explicitly selected image path.

**Verified result**: A single bounded synthetic `$imagegen` call ran under confirmed ChatGPT subscription auth in an isolated writable workspace. It exited successfully but emitted no image event and saved no image at the required predictable path (or anywhere else in the workspace). Questions 3, 4, 6, and 7 therefore failed; image-specific quota behavior remained inconclusive and was not forced. Current official docs describe built-in image generation in Codex/ChatGPT surfaces but direct **programmatic image generation** to the Image API, which is forbidden here by FR-100. Sanitized evidence: [`spikes/evidence/g1i-scorecard.md`](../../spikes/evidence/g1i-scorecard.md).

**Feasibility gate G1-I** — the seven questions from the product brief, answered against the installed environment:

1. Programmatic invocation under subscription? **Yes.** 2. Reliable structured results? **Yes for text (G1-T).** 3. Image generation invocable programmatically? **No verified result.** 4. Artifacts savable to a predictable local path? **No.** 5. Quota exhaustion reliably detectable? **Inconclusive for images.** 6. Resumable without duplicating completed work? **No verified contract.** 7. Compliant with current official product behavior? **No documented non-interactive subscription artifact workflow.**

**Gate result: FAIL.** All seven were required. Do not implement a Codex image pipeline on hope.

---

## R7 — Gemini structured output & image generation **[OFFICIAL IDS VERIFIED; ACCOUNT GATE FAILED — 2026-07-14]**

**Decision**: Use the official `@google/genai` JS SDK, pinned to a verified release and configured with exact model IDs. Text/structured output uses provider JSON-schema configuration and local revalidation (never trust provider-side validation alone). Image output uses explicit reference-image parts and local byte/MIME validation before the atomic asset path.

**Official-document result**: `gemini-3.5-flash` (text/structured), `gemini-3.1-flash-image` (default image), and `gemini-3.1-flash-lite-image` (economy image) are current stable exact IDs. The default image model documents up to 14 total references, including up to four character images; Lite documents up to 14 object references but no separate character-consistency allowance. No alias or preview ID is accepted. The probe pins `@google/genai` 2.11.0. See [`spikes/evidence/g4-scorecard.md`](../../spikes/evidence/g4-scorecard.md).

**G4 account result — FAIL (environment)**: neither `GEMINI_API_KEY` nor Keychain service `com.hekayati.gemini-api-key` was present. Consequently `models.list` and all three direct account probes were not run. Gemini modes remain unavailable until the operator configures a credential and the exact-ID connection test passes. IDs remain configuration rather than code constants (FR-107), and runtime re-checks availability before every batch (FR-098).

**Feasibility gate G2 (Gemini image references & consistency)**: using synthetic fictional illustrated characters only (never a real child/customer), with 2–3 reference views per character across 5 sequential scene prompts, does the configured default image model hold recognizable identity (human judgment, structured scorecard)? How many distinct characters per image before identity degradation (informs capability matrix + C-08 threshold)? Does the API accept enough reference images per request for 3 characters? Raw provider outputs and generated images remain ignored local evidence; only sanitized scores, versions, and hashes are committed.

**G2 result — FAIL / PENDING (environment)**: the deterministic four-character/eight-view fixture, 40-scene protocol, subtype-aware reference-limit procedure, and manual 4-of-5 rubric are committed, but no provider call was made without a credential. No empirical identity, reliable-character-count, or reference-boundary claim is promoted. Feature 007's real Gemini path remains blocked; mock-provider/local features may proceed. See [`spikes/evidence/g2-scorecard.md`](../../spikes/evidence/g2-scorecard.md).

**Alternatives**: Vertex AI (needs GCP project + service accounts — heavier auth for one operator; rejected), REST without SDK (more code, no benefit).

---

## R8 — macOS Keychain credential storage

**Decision — verified Phase 1**: Use the macOS `security` CLI with argument arrays and no shell. Reads/deletes use `execFile`; writes use `spawn` with `add-generic-password -U … -w`, with the trailing `-w` option requesting an interactive password and the secret supplied through the child's stdin pipe. Service name is `com.hekayati.gemini-api-key`; account is a validated key label. Key material lives only in Keychain, is held in memory only for the operation/provider call, and is registered with central redaction (FR-105/106).

**Phase 1 evidence (2026-07-14)**: Installed `/usr/bin/security add-generic-password -h` explicitly documents that placing `-w` last prompts instead of accepting a password argument. The wrapper uses `shell: false`, ends argv at `-w`, and writes the secret only to stdin. A fake-binary isolation suite proves the secret is absent from argv, present on stdin, absent from normalized errors, and protected by a timeout; the dependency/audit set contains no native keyring module. No live user-Keychain item was created during automated verification. This resolves RR-08 without accepting process-table exposure.

**Rationale**: This keeps zero native-module dependencies, works with the macOS-provided tool, and preserves Keychain ACL behavior while eliminating shell history, shell escaping, and argv secret exposure.

**Alternatives**: Password as `-w <secret>` (rejected after Phase 1 verification because argv is observable), `keytar` (unmaintained/deprecated — rejected), `@napi-rs/keyring` (maintained but unnecessary native dependency after stdin mode passed), plaintext dotfile (forbidden by constitution XIV).

---

## R9 — Arabic text shaping, RTL, font embedding & PDF generation **[VERIFIED — G3 PASS 2026-07-14]**

**Decision**: **HTML/CSS → headless Chromium print-to-PDF via Playwright** for all three outputs (preview, interior, cover). Chromium's text stack (HarfBuzz + BiDi) gives correct Arabic shaping, ligatures (lam-alef), diacritics, RTL ordering, and embeds subsetted fonts in the PDF. The renderer accepts an explicit geometry contract: feature 008's versioned A4 customer-composition profile owns approved normalized layout/cover regions; feature 009's compatible PrinterProfile adds bleed/crop/spread mechanics. No product path hardcodes the G3 probe geometry, and incompatible printer trim/aspect/safe-area input hard-blocks for explicit composition migration (C-27). Fonts: the two pinned licensed embeddable Arabic families are preloaded and verified embedded in preflight.

**Rationale**: Every JS PDF library (pdf-lib, PDFKit, jsPDF) lacks full Arabic shaping/BiDi without fragile manual HarfBuzz integration. The browser engine is the only battle-tested local Arabic typesetter available to this stack, and it doubles as the layout engine for text-placement presets (same CSS in UI preview and PDF → WYSIWYG parity). Playwright pins its Chromium → reproducible output.

**Alternatives**: pdf-lib/PDFKit + harfbuzzjs (high-risk hand-rolled shaping — rejected), WeasyPrint (Python sidecar; good shaping but adds a second runtime), Typst/LaTeX (template authoring burden, weaker HTML/CSS parity with UI), InDesign automation (nonstarter locally).

**Feasibility gate G3 result — PASS**: Playwright 1.61.1 / Chromium 149 rendered a two-page shaping-stress corpus at 216 × 303 mm as an explicit synthetic A4+bleed probe. Visual inspection passed connected forms, lam-alef variants, tashkeel, punctuation, mixed Arabic/Latin/numeric BiDi, boundaries, and missing-glyph checks. The probe requires exactly the expected two font identities with embedded, subsetted, and Unicode-map flags. DOM measurement proved a deterministic 1800 × 1200 image placement of 152.4 × 101.6 mm, and Poppler reported 300 × 300 PPI. The offline browser attempted zero HTTP(S) requests. This proves the parameterized engine; it is not a hidden default for preview or printer output.

Exact local fonts are `Lemonada-SemiBold.ttf` v4.005 (display) and `IBMPlexSansArabic-Regular.ttf` v1.005 from package 1.1.0 (body), both SIL OFL 1.1. Their immutable upstream pins, licenses, and SHA-256 hashes are committed in [`spikes/fixtures/fonts/SOURCES.md`](../../spikes/fixtures/fonts/SOURCES.md). Full result: [`spikes/evidence/g3-scorecard.md`](../../spikes/evidence/g3-scorecard.md).

---

## R10 — Print production: bleed, CMYK, ICC, crop marks, cover spread, spine **[G3 COVER PATH VERIFIED 2026-07-14]**

**Decision**:

- Interior: A4 portrait trim + 3 mm default bleed (printer-profile override), safe margin default 10 mm, effective-DPI preflight ≥300 (configurable), optional crop marks.
- Color: **RGB PDF by default** (C-12); when a printer profile demands CMYK, convert via **Ghostscript** with the profile's ICC (`-sColorConversionStrategy=CMYK -sOutputICCProfile=…`), then re-preflight; conversion failure blocks delivery (FR-123).
- Cover: single spread PDF = back + spine + front + wraparound bleed. Spine width is **never computed by guess**: it comes from the printer profile (explicit mm value) or an imported printer template (PDF/dimensions spec); absent both → production blocked (FR-122). Page-count changes re-flag spine confirmation.
- Preflight implemented as an explicit rule list over the produced PDF (parse via `pdf-lib`/`pdfinfo`-class tooling + our render metadata): dimensions, page count, image effective resolution, font embedding, bleed presence, safe-margin violations, watermark presence/absence, spread geometry, corrupt-file check.

**Rationale**: Matches printing-industry norms while honoring "defaults are not universal printer truth" — everything printer-variable lives in PrinterProfile. Ghostscript is the only dependable local CMYK/ICC converter with scriptable CLI.

**Alternatives**: pdfcpu (no color conversion), commercial preflight (cost/cloud), asking the printer to convert (kept as an allowed workflow — profile can mark "deliver RGB").

**Phase 0 cover result — PASS**: The synthetic printer fixture produced one 436 × 303 mm spread with measured back-left, 10 mm spine, and front-right regions within 0.08 mm tolerance. Ghostscript 10.07.1 converted it with the system Generic CMYK ICC (SHA-256 `0c8a584b288a306eac9e1d3f1e68bc1b64331c717ceb051420e6257f17b3509a`). qpdf 12.3.2 verified one output intent with an embedded four-channel profile whose byte hash exactly matched that selected ICC; every image was `/DeviceCMYK`, no `/DeviceRGB` resource or RGB page-content operator remained, CMYK operators were present, and `inkcov` reported all four channels non-zero. Geometry/font checks and RGB/CMYK visual comparison also passed. Every check runs against a temporary PDF before atomic replacement of the final path; a deliberately missing ICC failed without promotion, and supplying an RGB profile failed the color-space guard while preserving the prior valid final hash byte-for-byte. Under `-dSAFER`, conversion grants read access only to the selected ICC path. This proves the local mechanism, not any printer-specific profile or full PDF/X conformance: production remains blocked until the actual printer profile/template is selected and its converted proof approved.

---

## R11 — Project ZIP export/import & archive security

**Decision**: Use `yazl`/`yauzl` for deterministic streaming ZIP I/O; never use a shell extractor or an auto-extract helper. The strict current wire identity is `format: "HekayatiArchive"` plus `manifestVersion: 2` (`HekayatiArchive/v2`). The only supported older fixture is `format: "HekayatiArchive"` plus legacy `schemaVersion: 1`; one pure staging-only v1→v2 migration validates every legacy key and never modifies the source. `ArchivePolicy/v1` is a separate versioned resource/security policy, not an archive-format version: 8 GiB compressed upload, 20,000 entries, 240 UTF-8 bytes/name, 8 MiB manifest, 16 MiB canonical JSON document, 2 GiB media/PDF entry, 16 GiB aggregate expansion, and 200:1 per-entry/aggregate ratios. Archive/request input cannot raise a cap.

Export first acquires a durable hierarchical project scope lock with no time-based lease and drains the scheduler. After quiescence, one synchronous immediate SQLite transaction resolves the typed participant closure, freezes schema-validated canonical document bytes and an ordered media/original ID+metadata+checksum inventory into durable snapshot rows, acquires idempotent media holds, and records one snapshot hash. The transaction ends before any filesystem stream. Async staging reads only those rows and exact held managed content, with authoritative byte/checksum verification; live documents are never reread. Once every byte is privately staged, the lock/holds may release and deterministic ZIP assembly plus two independent secret scans consume only the staged snapshot. A secret/integrity failure destroys the candidate and never replaces a prior ready managed export.

Import treats the operator-selected ZIP as external, read-only input. It streams a copy into one opaque 0600 managed reservation, validates the lazy central directory, canonical names/types/limits, strict manifest/version and listed-entry equality, checksums/bytes, disk reserve, participant schemas/migrations/reference closure, media/PDF/ICC/template facts, and secrets before any product write. Validation creates an immutable bounded `ImportPlan` with hashed ledger pages, explicit field-aware ID maps, dependency-ordered derived-hash rebase, conflict/consent consequences, and prepared-media intent. Confirmation acquires the hierarchical customer/project/template target lock, rechecks source/plan/target revisions, prepares content-addressed files, then commits the complete graph/refcounts/audit in one SQLite transaction or none. Replace/deletion use the same transaction-safe retain/release and exact managed unlink ledgers; restart exposes the old graph or one complete new/deleted graph and resumes only recognized cleanup. Hekayati may delete only its managed reservation/export/unlink entries, never the operator's source or downloaded copies (FR-125–129).

FR-160's closed portability action ledger is the replay boundary for export pause/start, import upload/plan/commit/replace, and deletion confirm/cleanup retry. The canonical request hash includes exact scope and revisions; upload additionally declares checksum and byte count before the first accepted stream. The action plus exact bounded result/state persists in one transaction, so exact replay returns it and a key/hash collision changes nothing.

**Alternatives**: `adm-zip` (memory-bound, historical traversal issues — rejected), tar (weaker Windows interchange later; zip requested).

---

## R12 — Image-reference & character-consistency limitations across providers

**Findings (encoded in `provider-capability-matrix.md`)**:

- No current image model guarantees identity consistency; drift grows with participant count, unusual poses, and style distance from references. Product stance already set: "recognizable, consistent, approved likeness" + mandatory human review (FR-016, FR-117).
- Practical mitigations specified: character-sheet-first workflow (generate canonical illustrated views once, then use _sheet images_ as references for pages — anchors style + identity), ≤3 characters per image warning threshold (C-08, tunable per matrix), per-scene negative constraints against extra people (FR-041), consistency review view (FR-119).
- Economy-tier image consistency is not yet empirically measured in this account. The product retains the conservative persistent weaker-capability warning required by FR-108 until G2 supplies evidence; it does not present that warning as a measured score.
- Codex family: G1-I failed, so image generation is confirmed unavailable under the required workflow (R6).
- HEIC intake: macOS `sips` converts HEIC→PNG/JPEG natively (no patent-encumbered lib needed); `sharp` handles resize/crop/format thereafter. EXIF orientation applied before stripping metadata (FR-021).
- Photo-quality intake stays provider-free and explainable. `sharp` supplies deterministic decode, dimensions, luminance/contrast, blur proxy, orientation, metadata removal, normalized output, and subject-box crop operations. Every face-kind input receives an operator-drawn, keyboard-adjustable rectangle; its area drives the face-size metric and the crop is the only face asset eligible for providers. `PhotoQualityPolicy/v1` evaluates a 512 px normalized crop/working image and seeds three fixture-calibrated advisory thresholds: subject-box area ratio `<0.08` → `PHOTO_FACE_TOO_SMALL`, grayscale Laplacian variance `<80` → `PHOTO_BLURRY`, and fraction of pixels with luma `<32` greater than `0.35` → `PHOTO_EXTREME_SHADOWS`. The immutable policy version, metric, and threshold are stored with each warning so later calibration creates a new policy rather than rewriting history. Conditions that would otherwise require uncertain biometric/semantic inference—people count, obstruction/filter suspicion, apparent-age band, hair, and clothing—are explicit operator observations; comparisons over those fields produce advisory warnings (C-20). No face embedding, identity classifier, age estimator, auto-merge, or network model is introduced. Duplicate candidates are family-local and non-blocking (C-19).

**Alternatives for intake warnings**: provider-side photo analysis (rejected: US1 must work with no provider and would transmit child images before a generation need); bundled biometric/age models (rejected: opaque accuracy and privacy burden for advisory intake); manual checklist only (insufficient for deterministic decode/blur/exposure checks). The hybrid local-metrics + explicit-observation path is the smallest verifiable behavior that covers every FR-023 warning without overclaiming inference.

---

## R13 — Local HTTP browser trust boundary

**Decision**: Treat loopback binding as only the first network layer, not as browser authentication. The application derives exactly one canonical origin, `http://127.0.0.1:<verifiedBoundPort>`, from a listener configured with the literal host `127.0.0.1`. Startup validates that literal before opening a socket, binds with Fastify proxy trust disabled, independently checks the effective address after `listen`, and keeps application routes fail-closed until that check passes. An earliest `onRequest`-class guard, before body parsing and route dispatch, accepts exactly one canonical HTTP authority and ignores all forwarded-host metadata.

Every API request with an `Origin` header must match the canonical origin. Every unsafe method additionally requires either that exact `Origin`, or an exact-origin parsed `Referer` only when `Origin` is absent, plus a constant-time match on a cryptographically random per-process CSRF token sent in a custom header. The token is obtained from the same-origin bootstrap response, which is `Cache-Control: no-store`; it rotates on restart and never enters persistence, logs, exports, URLs, or error text. Safe methods are side-effect-free. Cross-origin CORS and Private Network Access preflights are rejected without opt-in headers. Tests use raw HTTP, not browser CORS behavior, and assert rejection before both a route-dispatch counter and a persisted mutation sentinel change (FR-147, FR-148, SC-014).

**Rationale**:

- A hostile public page can target a local HTTP service through DNS rebinding, form/navigation requests, permissive CORS, or Private Network Access. Binding only to loopback prevents LAN listeners but does not establish which browser origin initiated a request.
- Exact literal authority blocks attacker-controlled hostnames that resolve to loopback; exact source validation and a runtime custom-header token independently protect state-changing routes.
- A runtime-only token is sufficient for the one-process, one-operator model and naturally invalidates stale tabs without creating another stored credential.
- Fastify's pre-routing hook order permits the boundary to reject before parsing attacker-controlled bodies or invoking product handlers.

**Alternatives**:

- _Loopback binding alone_: rejects remote sockets but leaves browser-mediated attacks; insufficient.
- _Permissive or reflected CORS with an allow-list_: unnecessary for a same-origin application and expands the attack surface; rejected.
- _Random port or token in the URL_: ports are discoverable and URL tokens leak into history/referrers; neither replaces authority/source checks.
- _App login or locally trusted TLS certificate_: adds credential/certificate lifecycle complexity outside the single-operator v1 scope and still would not justify trusting forwarded authority; rejected for v1.

---

## Feasibility gates summary (Phase 0 exit criteria)

| Gate | Result | Evidence / consequence | Blocking for |
| ---- | ------ | ---------------------- | ------------ |
| G1-T | **PASS** | CLI 0.144.3 + ChatGPT auth; live schema result, error taxonomy, and cancellation verified | Codex text mode available subject to runtime health |
| G1-I | **FAIL (expected)** | No programmatic subscription image artifact/resume contract; visible unavailable reason required | Codex image mode only; product proceeds via explicit Gemini selection |
| G2 | **PENDING ENVIRONMENT** | Requires a configured Gemini credential and G4 account probe | Default image pipeline parameters, C-08 threshold, feature 007 |
| G3 | **PASS** | Arabic shaping/font/300-PPI interior plus cover geometry/ICC-bound CMYK/fail-closed path verified | PDF-dependent features may proceed |
| G4 | **PARTIAL / ENVIRONMENT FAIL** | Exact stable public IDs verified; account-level probe requires a configured Gemini credential | Gemini modes remain unavailable until connection test passes |

Gate outcomes are recorded by editing this file's gate table + risk register; a failed gate never silently downgrades — it changes visible product capability messaging (FR-102).

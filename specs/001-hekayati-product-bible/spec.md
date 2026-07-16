# Feature Specification: Hekayati (حكايتي) — Personalized Children's Picture Book Production System

**Feature Branch**: `001-hekayati`
**Created**: 2026-07-14
**Status**: Approved — full delivery authorized 2026-07-14; slice readiness gates apply
**Input**: User description: "Local desktop-operated web application for creating highly personalized, printed children's picture books where the child is the visual and narrative hero."

**Supporting artifacts** (same directory — normative parts of this specification):

| Artifact                              | Purpose                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `plan.md`                             | Technical plan, architecture decisions                                     |
| `research.md`                         | Technology research entries R1–R13, feasibility gates                      |
| `data-model.md`                       | Domain model, entities, versioning rules                                   |
| `contracts/provider-contract.md`      | Canonical AI provider capability model and operations                      |
| `contracts/structured-outputs.md`     | Canonical schemas for AI structured output                                 |
| `contracts/job-scheduler-contract.md` | Durable job scheduler semantics                                            |
| `state-machines.md`                   | Project, job, page, approval state machines                                |
| `invalidation-matrix.md`              | Upstream-change → downstream-invalidation rules                            |
| `provider-capability-matrix.md`       | Codex vs Gemini vs Mock capabilities                                       |
| `edge-case-catalog.md`                | Edge cases A–H mapped to requirements                                      |
| `risk-register.md`                    | Risks, mitigations, feasibility gates                                      |
| `test-strategy.md`                    | Test levels, failure injection, acceptance approach                        |
| `quickstart.md`                       | Operator setup and first-book walkthrough                                  |
| `checklists/`                         | Product acceptance, AI reliability, privacy/security, print production, UX |
| `tasks.md`                            | Phased, dependency-aware implementation tasks                              |

---

## 1. Product Vision & Scope

Hekayati turns a child into the hero of a professionally printed, personalized Arabic picture book. One employee operates the app locally on one Mac. The customer never touches the app; all customer interaction happens over WhatsApp, manually mediated by the employee.

The product is **a gift first**. It may carry a subtle developmental goal, but it must never read as a lecture, punishment, behavioral report, or attempt to shame the child.

**Value chain**: customer sends info + reference photos → employee enters data, builds character profiles → AI produces a character sheet → optional customer approval → AI generates story, scenes, prompts, illustrations → employee reviews/regenerates pages → watermarked preview PDF → customer approval recorded manually → print-ready interior + cover PDFs → files sent to printing company.

### In scope (v1)

- Customer, family, character, look, and pet management with consent tracking.
- Character sheets with manual approval workflow.
- Story configuration (occasion, dedication, type, template, tone, page count, style, hidden goal), templates library.
- @mention system binding prose to stable character identities.
- Provider-neutral AI orchestration over two provider families (Codex subscription mode, Gemini API mode) plus a mock provider for development/testing.
- Durable background job scheduling with restart recovery, quota pause, and manual continuation.
- Page-level review, versioning, locking, and single-page regeneration.
- Single Image Studio tab: generate one illustration (with optional character references) without creating or running a full book pipeline.
- Flow mode (external manual image provider): compile an ordered, copyable prompt pack for Google Labs Flow (or any external tool), then import the operator-generated images back into the normal sheet/page pipeline — cutting per-image API cost to zero.
- Programmatic Arabic text layout over text-free illustrations.
- Watermarked preview PDF; print-ready interior PDF; print-ready cover spread PDF (back + spine + front); preflight.
- Manual project export/import (versioned ZIP).
- Manual permanent deletion with dependent-media cleanup.
- Arabic RTL UI (simple Modern Standard Arabic); story text in natural Egyptian Arabic.

### Out of scope (v1) — MUST NOT be reintroduced without spec amendment

Customer accounts; customer self-service; public website; cloud hosting; multi-employee collaboration; role-based permissions; payments; invoices; shipping; WhatsApp API integration; automatic printing-company integration; automatic backups; mobile-first editing; freeform drag-and-drop page design; audio narration; video generation; automatic behavioral diagnosis; training custom AI models; OpenAI API-key billing inside Codex Subscription Mode; authentication screens; any automated Google Labs / Flow integration (no API calls, browser automation, scraping, or embedded webview — Flow mode is copy-out / file-in only).

---

## 2. User Scenarios & Testing _(mandatory)_

The single persona is **the Employee** (operator). "Customer" actions below are always performed by the employee on the customer's behalf.

### User Story 1 — Customer, Family & Character Library (Priority: P1)

The employee creates a customer with WhatsApp contact info and consent status, builds the family group (children, parents, siblings, grandparents, friends, teachers, pets, custom relations), and creates reusable character profiles from photos and/or descriptions, including multiple looks per character.

**Why this priority**: Every downstream artifact depends on characters. This story alone delivers a usable family/character library and is the foundation of data privacy guarantees.

**Independent Test**: With no AI provider configured, create a customer → family → 3 characters (one photo-based, one description-only, one pet) → 2 looks for one character → restart the app → all data intact; cross-family character selection is blocked.

**Acceptance Scenarios**:

1. **Given** an empty system, **When** the employee creates a customer with name + WhatsApp number and records photo consent, **Then** the customer exists with consent status, creation timestamp, and appears in the customer list after app restart.
2. **Given** a customer without recorded consent, **When** the employee attaches reference photos to a character, **Then** the system stores them but blocks any AI generation using them and shows the exact reason ("consent not recorded").
3. **Given** a character with a base look ("blue T-shirt"), **When** the employee adds a "Space Suit" look, **Then** both looks exist independently and the base profile is unchanged.
4. **Given** family A and family B, **When** the employee builds a project for family B, **Then** the character picker offers only family B's characters, and A's characters cannot be attached.
5. **Given** an uploaded HEIC photo with GPS EXIF data, **When** it is imported, **Then** it is converted to a supported working format, orientation is applied, and location metadata is stripped from the stored working copy.
6. **Given** a blurry photo or a photo with multiple faces, **When** it is attached as a face reference, **Then** the system shows a non-blocking quality warning describing the specific issue.

---

### User Story 2 — Character Sheet Generation & Approval (Priority: P1)

For a project, the employee generates an AI character sheet (illustrated face, front view, three-quarter view, full body, main outfit, name) per character, exports a small character sheet PDF for WhatsApp, and records the customer's approval or change requests.

**Why this priority**: Character approval is the gate protecting all expensive downstream generation. It also exercises the full provider pipeline end-to-end on a small artifact.

**Independent Test**: Using the mock provider, generate a character sheet, export its PDF, record "approved", then modify the character's face description and verify: new version created, old approval marked not-applicable-to-new-version, downstream staleness logic engaged.

**Acceptance Scenarios**:

1. **Given** a character with valid references and consent, **When** the employee requests a character sheet, **Then** a job runs in background, produces sheet images bound to the character version used, and records provider/model/prompt provenance.
2. **Given** a completed character sheet, **When** the employee exports the sheet PDF, **Then** a compact PDF is produced containing the sheet views and character name, suitable for WhatsApp sending.
3. **Given** a recorded character approval on version N, **When** the employee edits the character's permanent appearance, **Then** version N+1 is created, the approval remains bound to N and is marked "superseded — not valid for N+1", and any downstream illustrations generated from N are flagged potentially stale with a visible affected-items list. Nothing regenerates automatically.
4. **Given** a character sheet the customer rejected, **When** the employee records "changes requested" with notes, **Then** the notes persist, the sheet status is "revision needed", and regeneration reuses the notes in the operator-editable generation context.

---

### User Story 3 — Story Configuration, Templates & @Mentions (Priority: P1)

The employee configures a story (main child, additional characters with narrative roles, occasion, dedication, type, template, page count 16/24, tone, illustration style, optional hidden developmental goal, notes) and writes/edits scene text using @mentions that bind to stable character IDs.

**Why this priority**: This is the creative control surface; everything the AI generates is compiled from it.

**Independent Test**: With no AI provider, configure a full story from the "Space Adventure" template, add scene text with @mentions including two characters named أحمد, rename one character, and verify all mentions still resolve to the correct characters.

**Acceptance Scenarios**:

1. **Given** a project with characters, **When** the employee types `@` in a scene editor, **Then** a picker lists project characters with thumbnail, name, relationship, and narrative role; selection inserts a mention bound to the character ID.
2. **Given** two characters named أحمد (main child, friend), **When** the employee renames the friend to علي, **Then** existing mentions of the friend render the new name and still reference the same character ID.
3. **Given** the text `@أحمد و@علي بيلعبوا كورة`, **When** the scene is compiled for generation, **Then** the structured scene lists exactly Ahmed and Ali as participants with their per-mention properties (action, emotion), and no other family member may be injected by generation.
4. **Given** a group mention (e.g., `@الأصدقاء`) resolving to zero characters, **When** the employee attempts generation, **Then** the system blocks with a specific validation message identifying the empty group.
5. **Given** a character referenced by mentions, **When** the employee attempts to remove the character from the project, **Then** the system lists every affected scene and requires explicit resolution (replace, remove mentions, or cancel).
6. **Given** a saved template, **When** the employee edits the template, **Then** stories already generated from the older template version are untouched and continue referencing their original template version.
7. **Given** diacritics variance (أحمد vs أحمَد) or pasted mention text, **When** mentions are edited or partially deleted, **Then** the mention either remains a valid ID-bound token or degrades to plain text flagged as an unresolved reference — never a dangling half-token.

---

### User Story 4 — AI Story & Illustration Generation with Durable Jobs (Priority: P1)

The employee starts generation: story plan → story text (Egyptian Arabic) → scene decomposition → per-page image prompts → page illustrations. Work runs as observable background jobs; the employee can switch to another project meanwhile; everything survives restarts; quota exhaustion pauses (never auto-switches) with an explicit continue-on-other-provider choice.

**Why this priority**: This is the production engine and the highest-risk area (provider reliability, durability, idempotency).

**Independent Test**: With the mock provider configured for deterministic output and fault injection: run a 16-page generation, kill the app at 50%, restart, verify completed pages intact and remaining jobs resume without duplicates; inject quota exhaustion at page 14/20 and verify pause + explicit choice flow.

**Acceptance Scenarios**:

1. **Given** an approved character set and story configuration, **When** the employee starts generation, **Then** a dependency-ordered job graph is created (plan → story → scenes → prompts → per-page illustrations) and page illustration jobs run concurrently within the configured provider limit.
2. **Given** generation is running, **When** the app is killed and restarted, **Then** completed artifacts are intact, running jobs are recovered or safely re-queued via lease expiry, and no duplicate assets are produced (idempotency keys).
3. **Given** Codex quota exhaustion with 14/20 illustrations done, **When** the failure is detected, **Then** the 14 remain valid, remaining jobs pause with reason "Codex quota exhausted", and the employee is offered exactly: "wait for Codex availability" or "continue remaining tasks with Gemini" — no automatic switch; the choice applies only to remaining/explicitly regenerated work; provenance records each page's actual provider/model.
4. **Given** a provider returns malformed structured output, **When** validation fails, **Then** the job fails with normalized category `malformed_output`, only privacy-safe structural diagnostics (hash, byte count, top-level shape, bounded issue paths/codes) are retained, and retry policy per `contracts/job-scheduler-contract.md` governs what happens next; raw payload/rejected values never enter logs or persistence.
5. **Given** a safety refusal from a provider, **When** it occurs, **Then** the specific step and page are identified, completed safe work is preserved, and the system does NOT auto-retry with prompt variations; the employee resolves via edit or explicit retry.
6. **Given** any waiting job, **When** the employee opens the queue view, **Then** they can see state, progress, blocking reason, dependency chain, and can pause/resume project, cancel queued work, change priority, or retry failed tasks.

---

### User Story 5 — Page Review, Locking & Single-Page Regeneration (Priority: P1)

The employee reviews each page (illustration + text), edits scene descriptions, rewrites text only, regenerates a single page's illustration only, recalculates text placement only, reverts to older versions, locks approved pages, and approves pages.

**Why this priority**: Human quality control is a constitutional gate; page independence is the core versioning guarantee.

**Independent Test**: Generate a 16-page book with the mock provider; change page 7's per-page look and regenerate; verify pages 1–6, 8–16 byte-identical, page 7 has version history, book preview marked stale, prior approval (if recorded) invalidated.

**Acceptance Scenarios**:

1. **Given** page 7 shows Ali in the wrong shirt, **When** the employee sets a page-specific look for Ali and regenerates page 7, **Then** only page 7 gains a new version; all other pages are unchanged; previous page 7 versions remain in history; preview and any full-book approval become stale per the invalidation matrix.
2. **Given** a locked page, **When** any other page, character, or story element changes, **Then** the locked page's content does not change; if a dependency change makes it stale, it is flagged "locked + stale dependency" for explicit operator resolution.
3. **Given** a regeneration in flight, **When** the employee cancels and the provider still returns a result, **Then** the late result is discarded (not committed) and recorded as canceled in job history.
4. **Given** an older completed generation arriving after a newer version exists (stale worker/lease), **When** it attempts to commit, **Then** commit is rejected by version precondition and the newer version remains current.
5. **Given** an illustration whose composition leaves no safe text area, **When** automatic placement runs, **Then** the system tries approved presets, then readability aids (gradient/panel), then warns the employee — it never silently shrinks text below the readable minimum.

---

### User Story 6 — Preview PDF & Customer Approval Recording (Priority: P2)

The employee produces a watermarked preview PDF (downsampled), sends it via WhatsApp manually, and records the outcome: preview sent / approved / changes requested (+ notes, affected pages, timestamp, approved version).

**Why this priority**: Customer approval is required before print, but preview generation depends on Stories 1–5.

**Independent Test**: From a completed mock-generated book, produce the preview PDF; verify watermark on every page, downsampled images, correct page order/count; record approval against that exact immutable preview output and book snapshot; then edit page text and verify the preview and approval are invalidated and the old preview cannot be approved or used to authorize print.

**Acceptance Scenarios**:

1. **Given** a completed book and customer-view cover composition, **When** preview is generated, **Then** it contains watermarked front/back cover proof pages around the exact 16/24-page interior map, images are downsampled below print resolution, and the complete preview is WhatsApp-friendly (≤ 16 MB hard ready/send gate at the default policy).
2. **Given** a recorded full-book approval on book version V, **When** any customer-visible content changes (text, image, page order, cover), **Then** the approval is marked invalidated with the causing change listed, and print PDF generation is blocked until a new preview approval is recorded.
3. **Given** an internal-only change (e.g., job log fix, retention cleanup), **When** it occurs, **Then** approval is NOT invalidated (per invalidation matrix).
4. **Given** punctuation-only text corrections, **When** saved, **Then** preview approval is invalidated (visible text changed) but illustrations are NOT flagged for regeneration.
5. **Given** a preview is no longer the current ready output for its exact book snapshot, **When** the employee attempts to mark it sent or approved, **Then** the action is rejected with zero state change; approval records always identify the exact preview file the customer received.

---

### User Story 7 — Print Production: Interior & Cover PDFs with Preflight (Priority: P2)

The employee configures printer parameters (trim, bleed, DPI, color mode, ICC profile, crop marks, spine width or printer cover template) and produces the print-ready interior PDF and the cover spread PDF (back cover + spine + front cover), gated by preflight.

**Why this priority**: The physical book is the deliverable; depends on approved content.

**Independent Test**: From an approved mock book, produce interior + cover PDFs with a test printer profile; run preflight against seeded defect fixtures (low-res image, missing bleed, unknown spine width, unembedded font, watermark present) and verify each is detected and blocks output.

**Acceptance Scenarios**:

1. **Given** an approved 16-page book, **When** the interior PDF is produced, **Then** it is A4 portrait, correct page count and order, 3 mm bleed (or printer override), images ≥ configured effective DPI, all fonts embedded, Arabic correctly shaped and RTL-ordered, and contains no watermark.
2. **Given** spine width is not configured and no printer template is loaded, **When** the employee requests the final cover PDF, **Then** production is blocked with reason "spine width unknown — configure printer value or load printer template". No guessed value is ever used.
3. **Given** a printer-supplied cover template, **When** the cover is produced, **Then** back cover (character + short personalized synopsis + brand layout + optional logo area), spine, and front cover (child character, child name, story title, story environment) land in the template's geometry.
4. **Given** any preflight failure (wrong dimensions, wrong page count, missing image, low resolution, text overflow, missing font, missing bleed, unsafe margins, invalid spread, unknown spine, corrupt PDF, color conversion failure), **When** detected, **Then** the print file is not marked deliverable and the specific failures are listed.
5. **Given** CMYK is required by the printer, **When** conversion runs with the configured ICC profile, **Then** conversion success/failure is reported; failure blocks delivery.

---

### User Story 8 — Provider Settings, Credentials & Health (Priority: P2)

The employee selects the global text provider and image provider, enters/tests/replaces/deletes the Gemini API key (Keychain-stored, masked), sees Codex login state, model availability, and capability warnings (e.g., economy image model = weaker character consistency).

**Why this priority**: Required before real AI use, but the mock provider unblocks earlier stories.

**Independent Test**: Enter an invalid Gemini key → connection test fails with a clear message and the key is not persisted anywhere outside Keychain; enter a valid key → masked display; delete key → generation attempts fail with `invalid_credentials` normalized error; verify key never appears in DB dump, logs, or export archive.

**Acceptance Scenarios**:

1. **Given** the settings screen, **When** a Gemini key is saved, **Then** it is stored only in macOS Keychain, displayed masked, testable via a connection check, replaceable, and deletable.
2. **Given** configured model IDs (defaults: text `gemini-3.5-flash`; image `gemini-3.1-flash-image` "Nano Banana 2"; economy `gemini-3.1-flash-lite-image` "Nano Banana 2 Lite"), **When** the app checks availability, **Then** renamed/deprecated/unavailable models are surfaced and never silently substituted.
3. **Given** the economy image model is selected, **When** the employee confirms, **Then** a persistent capability warning explains weaker multi-reference/consistency behavior.
4. **Given** Codex is not installed or logged out, **When** the employee opens settings or starts Codex-mode generation, **Then** the exact state is shown ("Codex CLI not found" / "not authenticated") with remediation steps; nothing silently falls back to Gemini or to paid API billing.

---

### User Story 9 — Project Export, Import & Permanent Deletion (Priority: P3)

The employee exports a project as a versioned ZIP (manifest, data, characters, photos, assets, approvals, PDFs, checksums; never secrets), imports archives (new project / replace-with-confirmation / characters-only / templates-only), and permanently deletes customers/projects with dependent media cleanup.

**Why this priority**: Portability and deletion are required but not on the critical path to the first printed book.

**Independent Test**: Export a completed project; verify archive contents and checksums; verify zero secrets via automated scan; corrupt one file and verify import rejects with checksum mismatch; import into a fresh instance as new project and verify full fidelity; run permanent deletion and verify media removal.

**Acceptance Scenarios**:

1. **Given** running generation jobs, **When** export is requested, **Then** the system requires pausing generation first (chosen safest behavior — see Clarifications C-07), then exports a consistent snapshot.
2. **Given** an export archive, **When** scanned, **Then** it contains no Gemini key, no Codex auth material, no Keychain content, no unrelated customers' data; manifest + per-file checksums present.
3. **Given** a malicious ZIP (path traversal entries, symlinks, executables) or corrupt/truncated archive, **When** imported, **Then** import is rejected before any data is written, with the specific reason.
4. **Given** an import interrupted halfway, **When** it fails, **Then** no partial project is visible: import is atomic (staged then committed) or fully rolled back.
5. **Given** ID conflicts (project, character, asset) on import, **When** detected, **Then** the employee chooses per documented conflict rules (new IDs for "import as new"; explicit confirmation for "replace").
6. **Given** a customer requests deletion, **When** the employee runs permanent delete, **Then** the customer, family, characters, photos, generated assets, and exports listed as dependent are removed from disk and DB, and the operation reports what was deleted; reusable characters shared with other projects are surfaced for explicit decision first.

---

### User Story 10 — Template Library Management (Priority: P3)

The employee creates, edits, duplicates, archives, and disables story templates; creates a template from a completed story (stripping private customer data); duplicates a completed story into a new project.

**Why this priority**: Seed templates ship with the product; management UX can follow the first end-to-end book.

**Independent Test**: Save a completed story as a template; verify no customer names/photos are carried over; create a new story from it for another family; verify original story untouched.

**Acceptance Scenarios**:

1. **Given** the seed set (Space Adventure, Treasure Island, Dinosaur World, Saving an Imaginary City, Underwater Journey, An Unforgettable Birthday, Fully Custom), **When** the app first initializes, **Then** all seven templates exist with premise, structure, environments, role slots, variables, possible hidden goals, scene guidance, age adaptation rules, content boundaries, and ending patterns.
2. **Given** a completed story, **When** saved as a template, **Then** reusable structure is copied; private customer photos, names, and mentions are stripped/parameterized into role slots; the source story is not mutated.
3. **Given** a template used by existing stories, **When** archived or edited (creating a new template version), **Then** existing stories keep functioning against their original template version.

---

### User Story 11 — Single Image Studio (Priority: P2)

The employee opens a dedicated app tab («توليد صورة» / Single Image) and generates **one** illustration without creating a book project, story, scenes, or PDF pipeline. They may optionally attach customer/family characters (with looks) as references, write a scene prompt, pick an illustration style, run generation, review the result, regenerate, browse history, and download the image.

**Why this priority**: Operators often need a quick WhatsApp mockup, outfit test, or character likeness check before committing to a full book. Blocking that behind the entire book graph wastes time and quota.

**Independent Test**: With mock provider and no project open, open the Single Image tab → select one consented character + look → enter a short scene prompt → generate → image appears with provenance → regenerate once → both versions in history → download PNG → confirm no Project/Story/Page records were created → confirm a concurrent book project's pages are untouched.

**Acceptance Scenarios**:

1. **Given** the main navigation, **When** the employee opens the Single Image tab, **Then** they can generate without selecting or creating a book project.
2. **Given** a character with recorded consent and a selected look, **When** generation is started, **Then** one durable image job runs using the same provider contract, consent gate, payload minimization, and provenance rules as book illustrations.
3. **Given** no characters selected, **When** the employee generates from prompt + style only, **Then** the system still produces one image and records that zero character references were sent.
4. **Given** a customer without consent, **When** the employee tries to include that customer's character photos as references, **Then** generation is blocked with the same consent reason as FR-004.
5. **Given** a completed studio image, **When** the employee regenerates or downloads, **Then** prior versions remain in studio history; download exports the selected asset; no book approval, preview, or print artifact is created or invalidated.
6. **Given** a book project with running or completed pages, **When** a studio image is generated, **Then** no page, story, or book approval state changes (studio jobs are isolated from the book invalidation matrix).
7. **Given** participant count exceeds the selected image model's reliable reference capacity, **When** the employee confirms after the warning, **Then** generation may proceed under the same C-08 rules as book scenes; inventing unselected people remains forbidden via negative constraints.

---

### User Story 12 — Flow Mode: External Prompt Pack & Image Import (Priority: P2)

The employee selects **External — manual import** («استيراد خارجي») as the project's image provider. Text stages (plan, story, scenes, image prompts) run on the configured text provider as usual. Instead of calling an image API, the app compiles a **Prompt Pack**: a character-setup section (one copyable consistency block per participating character, built from approved character data — ready for Flow's character builder, with an optional consent-gated reference bundle of that character's privacy-clean photo working copies and sheet renders for upload) followed by every page's full image prompt in reading order, each individually copyable, plus the whole pack exportable as a Markdown file. The employee generates the images in Google Labs Flow using their own subscription, downloads them, then imports the files into the app and maps each one to its page (or character-sheet view). Imported images enter the exact same versioning, review, approval, layout, preview, and print pipeline as API-generated images.

**Why this priority**: Image generation is the dominant running cost. The operator already pays for Google Labs; routing images through it manually removes per-image API billing while keeping every safety, review, and print guarantee intact.

**Independent Test**: With the mock text provider and External image provider, generate a story through image prompts → export the prompt pack → verify the pack file contains character blocks + ordered page prompts and zero embedded image bytes/secrets → export one consented reference bundle (assert working copies + log entry, assert `originals/` bytes absent) and verify a no-consent character's bundle is blocked → import a fixture set of images mapped to all pages → verify each page gained a new illustration version with `external_manual` provenance → verify review, layout, preview watermark, and preflight behave identically to API-generated pages → verify one stale import (after editing a scene) is rejected with `stale_dependency`.

**Acceptance Scenarios**:

1. **Given** a project with External image provider and validated page prompts, **When** the employee opens the Prompt Pack view, **Then** they see the character-setup blocks and all page prompts in order, each with a copy action, and can export the pack as one file.
2. **Given** a compiled pack, **When** any upstream story, scene, prompt, character, or look version changes, **Then** the pack is marked stale with the specific reason and is only recompiled by explicit operator action.
3. **Given** page illustration jobs under External provider, **When** the pipeline reaches image generation, **Then** jobs enter `waiting_external_import` (no provider call, no retries, no timeout) and survive restarts.
4. **Given** downloaded Flow images, **When** the employee imports and maps them, **Then** each file is validated (decodable, sane dimensions, metadata stripped), committed atomically as a new page illustration version, and never overwrites an existing version.
5. **Given** an import whose pinned prompt version is older than the page's current head, or a target page that is locked/approved, **Then** the import is rejected with the exact reason and zero state change.
6. **Given** an imported image below the effective print DPI threshold or outside the aspect tolerance, **Then** the app shows a persistent per-page warning at import time (preview still allowed; print preflight remains the hard gate). Nothing is auto-cropped or auto-upscaled.
7. **Given** completed imports, **When** the employee proceeds, **Then** mandatory per-page human review (FR-118), safety rules, no-text-in-image rule, layout, watermarked preview, customer approval, and print production behave identically to API-generated illustrations.

---

### Cross-cutting Edge Cases

The normative edge-case catalog is `edge-case-catalog.md` (categories A–I, each mapped to requirement IDs and tasks). Representative cases:

- Character removed from a project while referenced by scenes → blocked with affected-scene resolution flow (FR-039); library archive remains non-destructive.
- More characters in one scene than the image model reliably supports → warning + guidance at compile time (FR-075).
- Egyptian Arabic drifting into formal Arabic mid-story → flagged at review + regeneration of affected text only (FR-047).
- Disk full mid-write → atomic temp-write+rename prevents half-written assets being treated as complete (FR-093).
- App accidentally started with non-loopback binding → refuses to start (FR-110).
- Hostile website targets the local API through DNS rebinding, CORS/PNA, or CSRF → rejected before any route handler; no state changes (FR-147, FR-148).
- Manual deletion of an asset file outside the app → integrity check flags missing file, offers regeneration (FR-097).

---

## 3. Requirements _(mandatory)_

Requirement IDs are stable and referenced by tasks, checklists, and the edge-case catalog. MUST/SHOULD per RFC 2119 intent.

### 3.1 Customers, Families & Consent

- **FR-001**: System MUST support customer create/read/update plus archive/restore with: name, WhatsApp number, notes, photo-consent status (unrecorded, or a recorded granted / not-granted decision with date and free-text note), created/modified timestamps. Archive is the routine non-destructive removal action; permanent deletion is exclusively the FR-005 flow.
- **FR-002**: System MUST support family groups containing members typed by relationship: main child, father, mother, brother, sister, grandfather, grandmother, friend, teacher, pet, custom.
- **FR-003**: System MUST scope character selection in a project to the project's customer/family; cross-family selection MUST be blocked with an explicit error.
- **FR-004**: A provider-neutral, fail-closed consent policy MUST check the current customer record both before job enqueue and again immediately before provider dispatch whenever a request would transmit photos or a transitively photo-derived character sheet. An absent record blocks with `PHOTO_CONSENT_NOT_RECORDED` (canonical reason "consent not recorded"); a recorded refusal blocks with `PHOTO_CONSENT_NOT_GRANTED`. Saving local data and description-only work with zero photo references remains allowed; a trusted sheet whose immutable lineage is wholly description-derived follows that same exception. Every generation producer (007/011, including 007 character-sheet work) MUST call 003's shared enqueue gate. The 006 scheduler alone re-reads current domain state, re-resolves references, and repeats the policy immediately before dispatch. Feature 005 adapters receive only resolved bytes/safe metadata and MUST NOT query domain state or treat enqueue success as lasting authorization. Revocation while work is queued prevents dispatch without deleting local or completed work.
- **FR-005**: System MUST support permanent deletion of a customer, cascading to families, characters, reference photos, generated assets, and project data, with a pre-deletion report of everything affected and explicit confirmation; deletion MUST remove media files from disk.

### 3.2 Characters, Looks & Pets

- **FR-010**: System MUST support character creation from photos, from description only, or both; pets are characters with relationship "pet".
- **FR-011**: Character profiles MUST support: name, nickname, age/age range, gender, face images, full-body images, skin tone, hair, eye color, relative height, body build, distinguishing features, glasses, hijab, accessories, interests, favorite objects, favorite color, personality traits, speaking style, free notes.
- **FR-012**: Characters MUST be reusable across multiple projects of the same customer/family; multiple characters MAY share the same relationship type (e.g., two brothers).
- **FR-013**: Each character MUST support multiple named looks (original clothes, everyday, story costume, custom, etc.); a look bundles clothing/appearance overrides.
- **FR-014**: Editing a character used in a project MUST offer exactly three modes: (a) change only for this project, (b) update base profile (creates new character version), (c) save as a new reusable look. Per-scene state (e.g., "surprised") MUST NOT modify base profiles or looks.
- **FR-015**: Character profiles and looks MUST be versioned; approvals and generated assets bind to specific versions.
- **FR-016**: The product goal for likeness MUST be defined as "recognizable, consistent, human-approved likeness" — never mathematically exact likeness; UI copy MUST NOT promise exactness.
- **FR-017**: Character relationship (to the family's named relationship anchor) and narrative role (in a specific story) MUST be separate attributes. Narrative role is per-project (main hero, co-hero, companion, guide, helper, person to rescue, beginning/ending-only, custom), so an eligible same-family sibling may be the project hero without rewriting family relationships.
- **FR-018**: System MUST support reversible archive and restore for customers, families, characters, and looks. Archived entities and descendants are hidden from new pickers, while existing version-bound references remain readable and visibly marked archived. Archive/restore MUST NOT revoke consent, delete media, cancel work, mutate content, or invalidate approvals. Permanent deletion is available only through FR-005.
- **FR-019**: Before character creation, the system MUST check only within the selected family for possible duplicates using privacy-preserving local signals: normalized display name + relationship and exact reuse of an existing reference-photo source checksum. It shows candidates and offers "open existing" or "create separate". The warning is non-blocking; duplicate names and relationships remain valid. The system MUST NOT perform biometric identity matching, merge automatically, or reveal candidates from another family.

### 3.3 Reference Photo Intake & Quality

- **FR-020**: System MUST accept common phone image formats including HEIC, JPEG, PNG; HEIC MUST be converted to a supported working format on import; unsupported/corrupt files MUST be rejected with a clear reason.
- **FR-021**: System MUST apply EXIF orientation, then strip GPS, EXIF, IPTC, XMP, device, and other non-essential metadata from working copies, crops, and thumbnails, retaining only color/decoding data required for correct rendering. Exact originals are retained in a separate local-only namespace, are never exposed by ordinary image/preview routes, converted to provider asset IDs, or sent to providers, and may leave that namespace only through the explicit validated export/deletion workflows.
- **FR-022**: System MUST enforce configurable compressed-byte and decoded-pixel limits (defaults 25 MB and 80 megapixels) and validate file type by content plus successful decode, never extension alone. Limits apply while streaming and before expensive transforms; decompression bombs, unsupported, truncated, and corrupt inputs fail with a clear reason and leave no visible state.
- **FR-023**: System MUST warn (non-blocking) on: blurry image, face too small, multiple faces, extreme shadows, obstructed face (sunglasses etc.), heavy filter suspicion, inconsistent apparent age across references, conflicting hair/clothing across references. Measurable image properties are checked locally; semantic conflicts may be derived from explicit operator observations as resolved by C-20. Hekayati MUST NOT present these warnings as biometric identity or age judgments. Warnings are advisory; the recommended-input checklist (clear front face, three-quarter, full body, clothing reference, good lighting) MUST be shown in the intake UI.
- **FR-024**: Every face-kind photo MUST collect a keyboard-operable subject rectangle so face-size evidence is explainable and the provider receives a privacy-minimized crop. A multi-face photo additionally requires the employee to explicitly mark the intended person before commit; it MUST NOT default to or transmit the full frame.
- **FR-025**: Every accepted reference upload MUST atomically create an immutable `ReferencePhoto` linking the exact local original, privacy-clean working copy, derived thumbnail, optional subject crop, warning codes/observations, and face-reference usability. Browser consumers may receive only the derived thumbnail; provider consumers may resolve only the explicit privacy-clean `providerAssetId`. Pre-commit intake reservations are runtime-only and are not accepted product records. New photo-only characters and their first usable reference MUST commit together. Failed, canceled, or interrupted intake MUST leave no visible record, dangling reference, or orphaned original/derived file.

### 3.4 Character Sheets & Character Approval

- **FR-030**: System MUST generate character sheets containing: reference thumbnails, illustrated face, front view, three-quarter view, full body view, main outfit, character name — bound to a specific character version and exact appearance selection. Base appearance carries no fabricated look ID; a shared-look appearance MUST also bind its exact look + look-version IDs.
- **FR-031**: System MUST export a compact character sheet PDF suitable for WhatsApp.
- **FR-032**: System MUST record manual character approval: approved / changes requested, customer notes, timestamp, approved character-sheet version.
- **FR-033**: When an approved character changes (base profile edit), system MUST: create a new version, mark the prior approval as superseded (not valid for the new version), flag downstream illustrations that used prior versions as potentially stale, present an affected-items view with per-item regeneration choices, and MUST NOT regenerate anything automatically.

### 3.5 @Mention System

- **FR-035**: Scene/story editors MUST support @mentions that store stable character IDs (never plain text names) rendered with current display names.
- **FR-036**: The @ picker MUST show thumbnail, name, relationship, and narrative role; duplicate names are disambiguated visually (e.g., أحمد — الطفل البطل vs أحمد — الصديق).
- **FR-037**: Mentions MUST support per-scene properties: action, emotion, position, framing, selected look, held object, gaze target, speaks (bool), dialogue text.
- **FR-038**: Group mentions (e.g., @البطل, @الأصدقاء, @العيلة) MUST resolve to concrete character IDs at compile time; a group resolving to zero members blocks generation with a specific error.
- **FR-039**: Renaming a character MUST preserve every ID-bound reference and re-render the current display name. Archiving a character MUST hide it from new pickers while existing pinned project and mention references remain readable and unchanged with an archived indicator. Only removing a character from a project MUST list every affected scene and require explicit replace, remove-mentions, or cancel resolution.
- **FR-040**: Mention editing edge behavior: partial deletion or paste MUST yield either a valid token or flagged plain text ("unresolved reference") — never a corrupt token; matching MUST tolerate Arabic diacritics and names containing spaces.
- **FR-041**: Compile-time validation MUST reconcile prose vs participants: a character mentioned in prose but not selected as participant, or selected but absent from prose, produces a visible warning requiring confirmation; generation payloads MUST enumerate exactly the confirmed participant set, and provider adapters MUST include negative constraints against inventing unselected people.

### 3.6 Story Configuration, Language & Hidden Goal

- **FR-045**: Projects MUST support configuration of: main child, additional characters + narrative roles, occasion, dedication, story type (connected adventure / related situations / saved template / fully custom), template, page count (16 or 24 interior), writing tone (light-funny, adventurous, warm-family, magical, educational-non-preachy, custom), illustration style, hidden developmental goal (optional), clothing choices, custom notes.
- **FR-046**: Narration/dialogue balance MUST be determined from child age, story type, reading level, page count, and scene complexity, exposed as an editable suggestion.
- **FR-047**: Story text MUST be natural Egyptian Arabic, age-appropriate; validation/review MUST flag: register drift into formal Arabic, excessive slang, internet-trend vocabulary, shaming or negative labeling of the child (lazy/bad/addicted/cowardly/difficult), direct moral lectures.
- **FR-048**: Hidden developmental goal (confidence, enjoying school, reducing phone use, sharing, courage, welcoming sibling, responsibility, cooperation, custom) MUST support presentation modes: fully indirect, or gently acknowledged at the ending; generated output presenting the goal as blame/lecture MUST be flagged at review.
- **FR-049**: Dedication page content MUST be operator-editable free text with layout preview.

### 3.7 Templates

- **FR-050**: Templates MUST contain: premise, story structure, possible environments, character-role slots, customizable variables, possible hidden goals, scene guidance, age adaptation rules, content boundaries, ending patterns. A template is parameterized structure, never a fixed story with name substitution.
- **FR-051**: Template operations: create, edit (creates new template version), duplicate, archive, disable, create-from-completed-story (stripping private data into role slots), duplicate-completed-story-into-new-project.
- **FR-052**: Template edits MUST NOT mutate stories generated from earlier template versions.
- **FR-053**: The seven seed templates (§US10) MUST ship with first-run initialization.

### 3.8 Book Structure & Pages

- **FR-055**: Book lengths: 16 interior pages (1 title, 1 dedication, 12 story, 2 ending) and 24 interior pages (1 title, 1 dedication, 20 story, 2 ending). Covers are outside the interior count.
- **FR-056**: Ending pages: ending page 1 = personalized closing scene/farewell ("about the hero" moment); ending page 2 = brand page (logo, "صُنع خصيصًا لـ {الطفل}" line, brand info). Both operator-editable. (Clarification C-03.)
- **FR-057**: Printer-required blank/technical pages MUST be added only at print-PDF assembly, flagged in preflight output, and MUST NOT change the customer-visible story flow or page numbering shown in preview.
- **FR-058**: Changing page count after story generation MUST invalidate the story structure with an explicit expansion/shortening flow (per invalidation matrix): the employee sees which scenes are added/merged/removed and confirms before any regeneration.
- **FR-059**: Each page MUST track: scene purpose, scene description, participants, character state, environment, time of day, composition, camera/framing, narrative text, dialogue, image prompt, negative constraints, selected illustration version, previous illustration versions, lock status, review status, provider provenance.
- **FR-060**: A page normally holds one large illustration; two related images are allowed only when two sequential moments are genuinely needed (operator choice). Comic-style onomatopoeia (BOOM/POW) MUST NOT be generated.

### 3.9 Page Operations, Versioning & Locks

- **FR-062**: Page operations MUST be independent: edit scene description; rewrite text only; regenerate illustration only; recalculate text placement only; revert to older version; lock; unlock; approve.
- **FR-063**: Regenerating one page MUST NOT modify any other page's content or versions.
- **FR-064**: Locked pages MUST never change as a side effect of any other edit; dependency staleness on a locked page is flagged "locked + stale" for explicit resolution.
- **FR-065**: Version commits MUST be guarded by preconditions: a job result may only commit if its input-version snapshot still matches the page's current lineage; late/stale/canceled results are discarded and logged.
- **FR-066**: All prior page versions remain recoverable until project permanent deletion.

### 3.10 Illustration Styles & Content Transformation

- **FR-070**: Ship three styles: (1) modern cartoon preserving distinctive features, (2) modern colorful 2D, (3) soft watercolor children's book. Styles are named configurations of the prompt compiler, extensible later.
- **FR-071**: The system MUST NOT emit prompts imitating a living artist, copyrighted franchise, or trademarked character. Requests for famous characters MUST be transformed into original concepts (e.g., "Spider-Man" → original agile city hero with unique costume); the transformation is shown to the employee for confirmation.
- **FR-072**: Illustrations MUST preserve the child's illustrated identity in the selected style — never paste photo-realistic faces onto illustrated bodies.
- **FR-073**: Generated artwork MUST NOT contain the story text; Arabic text is rendered programmatically afterwards (FR-080…).
- **FR-075**: At scene compile time, if participant count exceeds the selected image model's reliable reference capacity (per provider capability matrix), the system MUST warn and suggest scene restructuring; generation may proceed only with explicit confirmation.

### 3.11 Text & Dialogue Layout

- **FR-080**: Arabic story text MUST be rendered programmatically over text-free artwork with correct shaping, RTL ordering, Arabic punctuation, and embedded fonts.
- **FR-081**: Text placement modes: automatic (default), top, bottom, right, left. Automatic placement analyzes composition for quiet regions and contrast; no freeform drag-and-drop in v1.
- **FR-082**: Placement fallback chain: try approved presets → add readability gradient/panel → warn employee. Text MUST never be silently shrunk below the readable minimum (defined per age group in typography settings; default minimum 14 pt at A4 for ages 3–5, 12 pt for 6+).
- **FR-083**: Layout MUST handle: overflow, long names, dialogue bubbles (modern, minimal, pointing to the correct speaker where determinable), word-count-by-age differences, safe margins, bleed zones, and pages with no safe text area (FR-082 chain).

### 3.12 Approvals & Invalidation

- **FR-085**: Two manual approval types: character approval (FR-032) and full-book customer approval. Each ready full-book preview MUST atomically create one revision-0 `ready_to_send` cycle and one human gate targeting that exact immutable PreviewOutput. It binds `customerContentHash`, exact review/selection/layout/text/source evidence, watermark/derivative settings, strict page-or-cover feedback scopes, and timestamp. Preview actions MUST use an append-only key/request-hash ledger plus project/output/cycle/gate and optional prior-content-approval revision checks. Preview commit advances current-preview/current-cycle heads only; approved alone succeeds the gate and advances `currentContentApprovalId`. Changes requested cancels the gate and revokes any prior same-content authorization. Any action on a stale/non-current/gate/snapshot mismatch fails with zero state change.
- **FR-086**: Any customer-visible modification after full-book approval MUST invalidate both the affected preview output and approval, record the cause, and require a new preview cycle before print. Customer-visible = story text (including punctuation), illustrations, layout, page order/count, dedication, title, covers. The print guard starts from `currentContentApprovalId`, verifies its succeeded exact gate, matching `customerContentHash`, stable `contentAuthorizationHash`, and referenced asset integrity; feature 009 calls it at materialization, pre-execution, and commit. Sole IM-19 or a newer unapproved same-content preview preserves authorization and project approved/print-ready status while forbidding new actions on stale files. IM-20 blocks only while referenced exact checksums fail; byte-identical repair/reverification may restore the same authorization.
- **FR-087**: The normative invalidation rules are `invalidation-matrix.md`; internal-only changes (logs, job records, retention cleanup) do not invalidate content approvals. A printer-profile change is composition-compatible only when it remains portrait, both trim dimensions match the approved profile within its pinned tolerance without scaling, and the approved safe rectangle is wholly inside the printer safe rectangle; compatible printer mechanics re-trigger print production/preflight only. Any failed predicate MUST hard-block and require an explicit composition migration, new layout/cover versions, and a new preview approval; it MUST NOT be hidden inside IM-14.

### 3.13 AI Provider Orchestration (Provider-Neutral Core)

- **FR-090**: The system MUST define a canonical provider contract (see `contracts/provider-contract.md`) covering: capability discovery, text generation, structured generation (schema-validated), image generation with reference images, cancellation, quota/rate-limit signaling, health/auth checks, and provenance metadata.
- **FR-091**: Canonical structured output schemas (story plan, story, scene list, page prompt, review findings) are defined in `contracts/structured-outputs.md`; all provider output MUST validate against them before persistence.
- **FR-092**: Failures MUST normalize to the fixed category set in `contracts/job-scheduler-contract.md` §Failure Taxonomy (invalid_input, missing_reference_asset, provider_unavailable, invalid_credentials, quota_exhausted, rate_limited, timeout, network_failure, safety_refusal, malformed_output, output_validation_failed, media_decode_failure, disk_write_failure, insufficient_disk_space, database_unavailable, user_canceled, stale_dependency, unknown), each with defined retry semantics.
- **FR-093**: Asset writes MUST be atomic (temp file + fsync + rename); a partially written file MUST never be recorded as a completed asset; checksums stored per asset.
- **FR-094**: Every task and generated asset MUST record provenance: actual provider, actual model ID, timestamp, input versions, prompt version, reference assets used, attempt number, relevant settings snapshot.
- **FR-095**: Provider switching is manual and global (text provider + image provider selected independently in Settings); valid combinations include Codex+Codex, Codex+Gemini-NB2, Gemini+Gemini-NB2, Gemini+Gemini-NB2-Lite. Switches apply only to future/remaining/explicitly regenerated work.
- **FR-096**: On quota exhaustion of the active provider while another is configured: affected tasks pause; the employee is shown "wait" vs "continue remaining with <other provider>"; completed work preserved; no automatic switch; the decision is recorded.
- **FR-097**: A startup/periodic integrity check MUST detect missing/corrupt asset files (checksum mismatch, manual deletion) and offer per-asset regeneration; it MUST NOT auto-regenerate.
- **FR-098**: Model availability checks MUST run before generation batches; renamed/deprecated/unavailable models surface as `provider_unavailable`-class errors with remediation, never silent substitution.
- **FR-099**: A deterministic mock provider MUST exist implementing the full contract with configurable outputs and fault injection, used by tests and demos.

### 3.14 Codex Subscription Mode

- **FR-100**: Codex mode MUST use the employee's existing local Codex/ChatGPT subscription login; it MUST NOT request, store, or use an OpenAI API key, and MUST NOT silently incur paid API billing.
- **FR-101**: Codex mode covers: story planning, story writing, scene decomposition, prompt generation, content review — via supported local programmatic interfaces (research R5).
- **FR-102**: Codex image generation is gated by feasibility gate G1 (research R6). Until G1 passes: Codex image mode is marked unavailable in the UI with the recorded limitation; Codex text mode remains usable if the text gate (G1-T) passes; Gemini image generation remains available; the provider interface stays ready for a compliant future implementation.
- **FR-103**: Codex adapter MUST detect and normalize: CLI not installed, logged out, subscription exhausted, structured output invalid, image capability unavailable.

### 3.15 Gemini API Mode

- **FR-105**: Gemini settings MUST support: API key entry, storage exclusively in macOS Keychain (or equivalently safe native mechanism per research R8), masked display, connection test, replacement, deletion.
- **FR-106**: The Gemini key MUST NOT appear in: application database, logs, project exports, screenshots/UI (unmasked), or error messages. Redaction MUST be tested.
- **FR-107**: Default model configuration (configurable, never hardcoded): text/story/prompts `gemini-3.5-flash`; default image `gemini-3.1-flash-image` (Nano Banana 2); economy image `gemini-3.1-flash-lite-image` (Nano Banana 2 Lite). Planning MUST verify current official IDs (research R7) and record renames/deprecations; runtime MUST re-verify (FR-098).
- **FR-108**: Selecting the economy image model MUST display a persistent capability warning about weaker multi-reference/character-consistency behavior.

### 3.16 Background Jobs & Scheduling

- **FR-109**: The scheduler is deterministic and rule-based (no AI scheduling). Normative semantics: `contracts/job-scheduler-contract.md`. It MUST support: queued/running states, dependency graphs, priorities, progress events, waiting-for-review states, retryable vs permanent failures, quota-pause, cancellation, restart recovery via leases, duplicate prevention via idempotency keys.
- **FR-110**: All services MUST bind to 127.0.0.1 only; startup MUST verify the effective bind address and refuse to run otherwise.
- **FR-111**: Employee queue controls: pause project, resume project, cancel queued work, retry failed task, change project priority, regenerate one page, view blocking reason for any waiting job.
- **FR-112**: Independent page illustration jobs MUST run concurrently within a configurable per-provider concurrency limit (default 2).
- **FR-113**: All completed artifacts MUST remain intact after: app restart, worker crash, computer restart, network interruption, AI timeout, provider quota exhaustion.
- **FR-114**: The dependency chain MUST follow: character inputs → character sheet → character approval → story plan → story → scenes → image prompts → page illustrations → internal review → preview PDF → customer approval → print PDFs. Stages requiring human action enter "waiting for review", never auto-advance.

### 3.17 Content Safety

- **FR-115**: The system MUST prevent or flag before delivery: sexualized child depiction, graphic violence, dangerous instructions, humiliation/punishment framing, hate/discriminatory stereotypes, inappropriate adult themes, child blame, age-inappropriate frightening content, copyrighted characters presented as original, imitation of named living artists, personal contact details inside story text, accidental use of another customer's data.
- **FR-116**: Safety handling MUST preserve completed safe work and identify the specific failed step/page; safety refusals MUST NOT trigger automatic retries with prompt variations (manual resolution only).
- **FR-117**: Human review remains mandatory; automated checks (including any similarity scoring) are advisory aids, never the sole approval mechanism.

### 3.18 Image Quality & Review Workflow

- **FR-118**: The per-page review UI MUST present a review checklist covering: recognizable face, approximate age, skin tone, hair, glasses/hijab/accessories, outfit, correct participant count, no invented person, no identity swap, no duplicated character, no merged faces, no adult/child role reversal, safe and appropriate child depiction.
- **FR-119**: Face drift across pages MUST be reviewable via a side-by-side character consistency view (approved sheet vs page crops).

### 3.19 PDF Outputs

- **FR-120**: Three outputs: immutable watermarked preview PDF output (downsampled, hard ≤16 MB ready/send gate at default settings, bound to an exact book/page/layout/cover/settings snapshot and containing customer-view front/back cover proofs outside interior numbering), print-ready interior PDF, print-ready cover spread PDF (back + spine + front).
- **FR-121**: Print defaults (overridable per printer profile): A4 portrait, 300 DPI effective images, 3 mm bleed, safe margins, optional crop marks, RGB or CMYK output selection with ICC profile.
- **FR-122**: Printer profiles MUST be first-class settings objects; printer-supplied cover templates are importable; spine width MUST come from configuration or template — never guessed (block otherwise).
- **FR-123**: Preflight MUST detect: wrong dimensions, wrong page count, missing images, low effective resolution, text overflow, missing fonts, missing bleed, unsafe margins, invalid cover spread, unknown spine width, corrupt PDF, color conversion failure, watermark present in print file / missing in preview.
- **FR-124**: Preview PDFs MUST always carry the watermark; print PDFs MUST never contain it; both conditions are preflight checks (see FR-123).

### 3.20 Export / Import

- **FR-125**: Export: versioned ZIP with manifest (schema version, app version, created-at), project data, required customer/family references, character profiles + looks, reference photos, character sheets, story/scene versions, prompts, generated assets, approval records, preview/interior/cover PDFs, per-file checksums.
- **FR-126**: Export MUST exclude: Gemini key, Codex auth data, Keychain content, any secret, unrelated customers' data. An automated secret-scan runs on every produced archive.
- **FR-127**: Import modes: as-new-project (fresh IDs), replace-existing (explicit confirmation), characters-only, templates-only.
- **FR-128**: Import MUST validate before writing: archive integrity, manifest presence/version (older supported versions migrate; unsupported future versions rejected with message), checksums, path safety (no traversal, no symlinks, no executables), disk space. Import is staged-then-committed (atomic) or fully rolled back.
- **FR-129**: Export requires paused generation (C-07); the UI explains why and offers one-click pause.
- **FR-160**: Every mutating portability action MUST be restart-safe and exactly idempotent through the closed action set `export_pause | export_start | import_upload | import_plan | import_commit | replace_commit | deletion_confirm | deletion_cleanup_retry`. Each request carries an action-scoped idempotency key and canonical request hash; the action record and its exact bounded result/state boundary MUST persist atomically. The same operation scope/action/key with the same hash returns the stored result without repeating durable work; the same key with a different hash conflicts with zero mutation. Operation scope is exactly the project for export, the installation for upload before an import operation exists, the import operation for plan/commit/replace, and the typed deletion target or deletion operation for confirm/cleanup retry. Import upload's canonical request includes a declared archive checksum and byte count that the first accepted stream MUST verify. Retry/restart MUST NOT create a duplicate archive, import operation/plan/root graph, reference delta, managed unlink, or deletion report.

### 3.21 Privacy, Security & Operations

- **FR-130**: Local file permissions on data directories MUST restrict access to the operating user (0700 dirs / 0600 files).
- **FR-131**: Logs MUST redact secrets and MUST NOT contain raw image data; log redaction has automated tests.
- **FR-132**: No telemetry or external analytics of any kind.
- **FR-133**: The UI MUST display a clear warning that no automatic backup exists and export ≠ backup, at minimum on first run and in the export screen.
- **FR-134**: Provider payload minimization: each generation call sends only the reference images and profile fields required for that call, never whole-library uploads.
- **FR-135**: The spec does not assert legal compliance; a pre-launch legal review item exists in the risk register (consent wording, privacy policy, child-image handling).

### 3.22 Settings & Health

- **FR-137**: Settings MUST cover: provider selection (text/image), model IDs, concurrency limits, typography minimums, printer profiles, storage locations (read-only display), Gemini key management, Codex status, economy-mode warnings.
- **FR-138**: A health/diagnostics screen MUST show: DB status, disk free space (warn below configurable threshold, default 10 GB), asset store integrity summary, provider auth/availability, job queue depth, and bind-address confirmation.

### 3.23 Single Image Studio

- **FR-140**: The UI MUST provide a top-level Single Image Studio tab (Arabic label «توليد صورة») that is reachable without creating or opening a book project.
- **FR-141**: Studio generation MUST support: freeform scene prompt, illustration style (FR-070 set), optional customer/family scoping, optional character + look references (one or more), optional negative constraints, and the globally selected image provider/model (with economy-mode warning FR-108).
- **FR-142**: Starting studio generation MUST enqueue exactly one durable image job (type `studio_image`) through the normal scheduler; it MUST NOT create Project, Story, Scene, Page, preview, or print records.
- **FR-143**: Studio jobs MUST reuse FR-004 consent gating, FR-134 payload minimization, FR-071/072/073 content rules (no story text in the image, no franchise imitation, illustrated identity not photo paste), FR-075/C-08 reference-capacity warnings, FR-092 failure taxonomy, FR-094 provenance, and FR-096 quota-pause behavior.
- **FR-144**: Studio MUST keep an append-only history of generations (prompt, refs, style, asset, provenance, timestamps) with regenerate, delete-one, and download (PNG/JPEG) actions; history survives app restart until permanent deletion of the owning customer/characters or an explicit studio-history delete.
- **FR-145**: Studio generation MUST NOT invalidate book approvals, mutate pages, or write into a project's illustration lineage. Optional "attach to page" / "use in project" is out of scope for v1 (operator downloads and uses externally, or regenerates inside the book flow).
- **FR-146**: Cross-family character mixing in one studio request MUST be blocked (same scoping rule as FR-003). Description-only characters MAY be referenced without photo upload.

### 3.24 Local HTTP Trust Boundary

- **FR-147**: The local HTTP server MUST use one canonical origin, `http://127.0.0.1:<bound-port>`. Startup MUST reject any configured listener host other than the literal IPv4 address `127.0.0.1` before opening a socket, bind to that literal address, and then verify the effective post-listen address before marking the app ready. Wildcard, LAN, hostname-resolved, proxy-forwarded, IPv6, and alternate loopback addresses are forbidden. Before route dispatch, every request MUST have an HTTP authority (`Host`, or the protocol-equivalent authority) exactly equal to `127.0.0.1:<bound-port>`; missing, malformed, or alternate authority values (including attacker-controlled DNS names resolving to loopback) MUST receive a non-success response without application content or state access. Forwarded-host headers MUST NOT be trusted.
- **FR-148**: The browser API MUST be same-origin only and MUST fail closed against cross-origin and forged state-changing requests. An `Origin` header, when present on any API request, MUST exactly match the canonical origin. Every state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`, or any future unsafe method) MUST additionally carry (a) that exact `Origin`, or an exact-origin `Referer` only when `Origin` is absent, and (b) a per-process cryptographically random CSRF token obtained through the same-origin app bootstrap and returned in a custom request header. The bootstrap response containing the token MUST be served with `Cache-Control: no-store`. Missing, opaque (`null`), malformed, stale, or mismatched source headers/tokens MUST be rejected before body processing and route dispatch; safe methods MUST NOT mutate state. Hekayati MUST NOT enable cross-origin CORS, credentials, or Private Network Access: untrusted preflights are rejected and responses MUST NOT opt in with `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials`, or `Access-Control-Allow-Private-Network`. The CSRF token is runtime-only and MUST NOT be persisted, logged, exported, or treated as a user credential.

### 3.25 Flow Mode — External Manual Image Provider

- **FR-149**: The Settings image-provider list MUST include **External — manual import** («استيراد خارجي (Flow)»). Selecting it follows the FR-095 manual/global switch semantics and combines with any valid text provider. The app MUST NOT call, automate, embed, or scrape Google Labs / Flow and MUST NOT request or store Google credentials; the only boundary is copy-out (prompt pack) and file-in (import). A "فتح Flow" affordance MAY open the Flow URL in the operator's default browser (plain external navigation).
- **FR-150**: When a project's image provider is External and validated page prompts exist (FR-114 chain), the system MUST compile a versioned **Prompt Pack** containing: (a) a character-setup section — one consistency block per participating character built from that character's pinned versions (display name + transliteration, age band, appearance description, active look/outfit, illustration-style keywords, negative constraints — formatted for direct paste into Flow's character builder); (b) a per-page section in reading order — page number, scene summary, complete compiled image prompt, participant list, aspect-ratio/style line; (c) a global section — project illustration style, the no-story-text-in-image rule (FR-071), and the target aspect/trim. Every block MUST be individually copyable and the whole pack exportable as a single Markdown/text file.
- **FR-151**: The prompt pack file itself MUST NOT embed image bytes, customer contact data, consent notes, or secrets. Alongside the pack, a per-character **reference bundle** MAY be exported for Flow character-builder upload, gated by the same FR-004 consent check and an explicit per-export operator action: it contains the character's privacy-clean reference-photo working copies (metadata-stripped; the same provider-eligible assets the API path would send) and/or approved character-sheet renders — operator selects which — so external generation receives full identity references for maximum character consistency. `originals/` assets (exact uploaded bytes) remain NEVER exportable — they are never provider-eligible anywhere in the product. Every reference-bundle export is logged (character/photo IDs, timestamp), and the export UI MUST state that a child's photo is about to be uploaded to an external service by the operator («سيتم رفع صور الطفل إلى خدمة خارجية عبر المشغّل»).
- **FR-152**: Each pack MUST pin the exact story, scene, page-prompt, character, and look version IDs it was compiled from, plus a pack checksum. Any upstream change that invalidates an affected page (invalidation matrix) MUST mark the pack stale with the specific matrix reason; recompilation is manual and produces a new pack version (append-only).
- **FR-153**: Under the External provider, `character_sheet_view` and `page_illustration` jobs MUST enter a durable `waiting_external_import` state instead of dispatching to a provider: no retries, no timeout, restart-safe, visible in queue controls (FR-111) with the blocking reason "بانتظار استيراد خارجي".
- **FR-154**: Import MUST validate every file before commit: content sniffing (magic bytes, not extension) for PNG/JPEG/WebP, configurable size cap, decodable image, sane pixel dimensions; EXIF/GPS/XMP metadata MUST be stripped into a privacy-clean working copy; writes are atomic per FR-093 with content-address checksums. Failures normalize to `media_decode_failure`/`invalid_input` (FR-092) with zero partial commits.
- **FR-155**: Import mapping MUST show the target's prompt and existing thumbnail beside each candidate file, support partial imports (unmapped targets stay `waiting_external_import`), and commit through the same versioned commit protocol as generated illustrations: commits pinned to a superseded prompt version are rejected as `stale_dependency` with the exact reason; locked or approved pages reject import (FR-064); every successful import appends a new version and never overwrites.
- **FR-156**: At import time the system MUST compute effective DPI at the target trim size and aspect-ratio deviation. Below the print threshold → persistent per-page warning (preview permitted; FR-123 preflight remains the hard print gate). Beyond layout aspect tolerance → warning stating the crop/fit consequence. The system MUST NOT auto-crop, auto-upscale, or auto-enhance.
- **FR-157**: Imported-asset provenance (FR-094 fields where applicable) MUST record: provider `external_manual`, declared tool label (default "Google Flow", optional operator-declared model text), pack version + per-prompt checksum, original filename, file checksum, and import timestamp.
- **FR-158**: Everything downstream of import is unchanged and mandatory: FR-118 review checklist, FR-115–117 safety, FR-071 no-text-in-image, layout, watermarked preview, customer approval, invalidation matrix, and print preflight. Mixed-origin books (some pages API-generated, some imported) are permitted with a non-blocking style-consistency advisory. Single Image Studio (US11) is excluded from External mode in v1.
- **FR-159**: Switching a project away from External while jobs are `waiting_external_import` follows FR-095: already-imported versions are preserved; waiting jobs are re-dispatched to the new provider only after explicit per-project confirmation listing the affected pages — never automatically.

---

## 4. Key Entities _(summary — normative detail in `data-model.md`)_

- **Customer** — contact, consent, notes. Owns Families.
- **Family** — group of Members; scoping boundary for character selection.
- **Character** — versioned profile (identity, appearance, personality) + reference photos; may be a pet. Owns Looks (versioned).
- **Look** — named appearance/clothing bundle for a character.
- **ReferencePhoto** — immutable link between the exact local original, privacy-clean working copy, subject selection, and advisory quality report; originals are never provider-eligible.
- **OriginalAsset** — exact uploaded bytes in the private local-only `originals/` namespace; never an ordinary browser asset or provider input.
- **CharacterSheet** — generated views bound to character+look versions; approval target.
- **Project** — one book production for one family; owns story config, pages, jobs, approvals, outputs; has priority, paused flag.
- **StoryTemplate** — versioned parameterized structure (role slots, variables, guidance).
- **Story / Scene / Page** — versioned narrative artifacts; pages own illustration versions, layout results, locks, review states.
- **Mention** — ID-bound character reference with per-scene properties.
- **GenerationJob** — durable unit with type, dependencies, idempotency key, lease, attempts, normalized failure, provenance.
- **Asset** — content-addressed media file (checksum, type, dimensions, provenance); stored on filesystem, indexed in DB.
- **ApprovalRecord** — character or book approval bound to versions; invalidation state.
- **PreviewOutput** — immutable preview PDF asset plus exact book/composition/cover/page/layout/composition-input/source-asset snapshot and checksums, watermark/settings checksum, render job, cross-linked approval cycle/gate, validation report, and revisioned stale projection; full-book approval identifies one exact output.
- **PrinterProfile** — trim/bleed/DPI/color/ICC/crop-marks/spine or cover template.
- **ExportArchive** — manifest-versioned ZIP record.
- **SettingsProfile** — provider/model/concurrency/typography config (no secrets).
- **StudioGeneration** — standalone single-image request + result history; not part of a book project graph.
- **PromptPack** — append-only compiled export for Flow mode: character consistency blocks + ordered page prompts, pinned upstream version IDs, checksum, stale reason; never contains raw photos or secrets.

---

## 5. Success Criteria _(mandatory, technology-agnostic)_

- **SC-001**: The employee can go from new customer to print-ready interior + cover PDFs for a 16-page book in a single working day, with AI wait time visible and interruptible.
- **SC-002**: After a forced app kill and machine restart mid-generation, 100% of completed pages/assets are intact and generation resumes without duplicated artifacts (verified by failure-injection suite).
- **SC-003**: Regenerating any single page changes zero bytes of any other page's stored artifacts (verified by checksum comparison in tests).
- **SC-004**: 100% of provider outputs pass schema validation before persistence; malformed outputs never appear as product content.
- **SC-005**: Secret-scan of every export archive and full log corpus finds zero credentials (automated in CI and on every export).
- **SC-006**: Print preflight catches 100% of the seeded defect fixture set (each FR-123 category has at least one fixture).
- **SC-007**: Complete preview PDFs for 24-page books, including both cover-proof pages, are ≤16 MB at default settings and carry watermarks on every PDF page; print PDFs contain none. Feature 008 proves the preview half; feature 009 proves the print half before this criterion is globally complete.
- **SC-008**: Arabic text in generated PDFs is correctly shaped and RTL-ordered (golden-file visual regression on a shaping-sensitive corpus, including connected letters, lam-alef ligatures, diacritics, punctuation).
- **SC-009**: Every quota-exhaustion event results in paused (not failed, not switched) remaining work and an operator decision record; zero automatic provider switches in audit history.
- **SC-010**: An approved book version can never reach print output after a customer-visible change without a new exact-preview-bound approval (enforced via the invalidation matrix and the print-authorization check). Feature 008 proves the guard; feature 009 proves every print producer consumes it before this criterion is globally complete.
- **SC-011**: Full-book approval invalidation, character-approval superseding, and locked-page immutability each have dedicated automated tests that pass.
- **SC-012**: The complete operator journey is usable in Arabic RTL at 1440×900 and larger without horizontal scrolling or clipped controls.
- **SC-013**: From the Single Image tab, the employee can produce one downloadable illustration with character references in ≤3 operator actions after characters exist (select refs → prompt → generate), without creating any Project/Story/Page records (verified by DB assertions in the independent test).
- **SC-014**: The seeded local-HTTP negative suite rejects 100% of non-canonical bind/authority, DNS-rebinding, cross-origin CORS/PNA, and forged state-changing-request cases before route dispatch with zero persisted mutations; a valid same-origin journey still succeeds, and restart rotates the CSRF token without losing product state.
- **SC-015**: A complete 16-page book reaches print-ready PDFs with **zero image-provider API calls**: prompt pack exported once, all pages imported and mapped, every downstream gate (review, approval, watermark, preflight) produces byte-identical behavior to an API-generated book on the same fixtures; a seeded stale import, locked-page import, and corrupt-file import are all rejected with zero state change (verified by the US12 independent test).

---

## 6. Clarifications (resolved by documented conservative assumption)

| ID   | Question                                  | Decision                                                                                                                                                                                            | Rationale                                                                |
| ---- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| C-01 | "NoSQL" — does it mandate a NoSQL server? | It mandates a **flexible document data model**. Engine choice is a plan-level decision (research R2); an embedded document store satisfies the requirement if it preserves schema flexibility.      | One-person local ops; requirement's intent is flexibility, not a daemon. |
| C-02 | No auth screen — any access control?      | No app login in v1. The OS user account plus the loopback and browser trust boundary in FR-147 and FR-148 constrain access; residual local-machine compromise remains RR-12.                         | Explicit operating context without treating loopback as authentication.  |
| C-03 | What are the two ending pages?            | Ending 1 = personalized closing scene ("hero farewell"); Ending 2 = brand page ("صُنع خصيصًا لـ {الطفل}", logo area). Operator-editable.                                                            | Common picture-book convention; keeps story pages intact.                |
| C-04 | Blank/printer-required pages?             | Added only during print assembly, shown in preflight report, invisible to preview numbering.                                                                                                        | Keeps customer-visible story stable (FR-057).                            |
| C-05 | Page-count change after generation?       | Treated as story-structure invalidation with guided expand/shorten flow; nothing auto-regenerates.                                                                                                  | Constitution X.                                                          |
| C-06 | Preview resolution?                       | Downsampled to ~150 DPI + watermark; never print-resolution assets in preview.                                                                                                                      | WhatsApp size limits; asset protection.                                  |
| C-07 | Export while jobs run?                    | Require pause (one-click) then snapshot export. Chosen over concurrent snapshot for simplicity and correctness.                                                                                     | "Safest simple behavior" directive.                                      |
| C-08 | Max characters per scene?                 | Soft warning above the selected model's verified reliable-reference count from the capability matrix. Proceed requires confirmation. Three remains a planning example only: an unset count keeps that real model unavailable and is never used as a silent runtime default. | Known model limitation; avoids silent quality loss or invented capability. |
| C-09 | Concurrency default?                      | 2 concurrent image jobs per provider, configurable 1–4.                                                                                                                                             | Conservative vs rate limits.                                             |
| C-10 | Retention?                                | All versions retained until explicit permanent deletion; no auto-pruning in v1. Disk-space health warning instead.                                                                                  | Recoverability principle; simplicity.                                    |
| C-11 | Mention name matching with diacritics?    | Store IDs; match display names diacritic-insensitively (NFC normalize + strip tashkeel for search).                                                                                                 | FR-040.                                                                  |
| C-12 | Color mode default?                       | RGB PDF by default; CMYK conversion via configured ICC profile only when the printer profile requires it.                                                                                           | Most digital printers accept RGB; avoids uncalibrated conversion damage. |
| C-13 | Consent granularity?                      | Per-customer nullable record: absent = not recorded; a recorded granted/refused decision carries a boolean + date + note and covers submitted photos for book production. Per-photo consent is deferred and flagged in the legal-review risk item. | Minimal viable fail-closed consent record; avoids inventing legal claims. |
| C-14 | Watermark form?                           | Diagonal semi-transparent brand text on every preview page + "معاينة — غير مخصصة للطباعة" footer. Configurable text.                                                                                | Must survive screenshots; simple.                                        |
| C-15 | Single Image vs book page regen?          | Separate Studio tab for one-off images; book page regeneration stays inside the project review UI (US5). Studio does not write into page lineage in v1 (FR-145).                                    | Keeps quick tests off the book state machine.                            |
| C-16 | Brand / visual language?                  | **Citrus Playground (ملعب الليمون)** — kit `brand-kits/02-citrus-playground.html`; tokens and rules in root `DESIGN.md` / `PRODUCT.md`. Frontend work must use Impeccable + frontend-design skills. | Operator-chosen; gift energy with workshop clarity.                      |
| C-17 | Does loopback binding alone trust browser requests? | No. The canonical literal-IP origin, exact authority check, same-origin source validation, runtime CSRF token, and fail-closed CORS/PNA policy in FR-147 and FR-148 are all required defense layers. | A public or compromised website can target local HTTP services even when it cannot bind them. |
| C-18 | Does ordinary customer/character "delete" mean permanent deletion? | No. Library removal is archive/restore and preserves pinned history. The only permanent deletion is the FR-005 pre-report + explicit-confirmation cascade owned by feature 010. | Prevents an everyday CRUD action from bypassing the privacy-safe destructive workflow. |
| C-19 | How are possible duplicate people handled? | Family-local, non-blocking candidate warnings may use display name normalized by trim + collapsed whitespace + NFC + tashkeel removal + Latin case-fold, together with relationship, and exact-upload checksum reuse. There is no biometric matching, automatic merge, or cross-family candidate disclosure; the operator decides whether to keep both or reconcile them. | Avoids hidden identity inference and cross-customer disclosure while catching common duplicate entry mistakes. |
| C-20 | How can photo-quality warnings work offline without claiming biometric inference? | Deterministic local checks cover decodability, dimensions, blur/exposure, and the area of an operator-drawn normalized subject rectangle. Every face-kind upload requires that keyboard-operable rectangle; multi-person input requires explicit intended-person placement. A versioned local `PhotoQualityPolicy` records each metric, threshold, and warning source. The operator explicitly records people count, obstruction/filter suspicion, apparent-age band, hair, and clothing observations; comparisons over those observations create the remaining advisory warnings. | Meets the no-provider US1 journey with explainable local evidence and no face identity/age classifier. |
| C-21 | What anchors family-relative relationships? | A family is child-centered. It may be empty briefly, but its first active member must be `main_child` and atomically assigns the optional anchor exactly once; no other active member may use that relationship, and the anchor ID plus anchor relationship are immutable in v1. Before assignment, or while the anchor is archived, later member creation and new Project/Studio selection are blocked with an actionable restore/complete-anchor reason; existing pinned references remain readable and relationship meaning never changes. A project's `mainChildId` may still be any eligible same-family non-pet character, with narrative role identifying that book's hero. A person belongs to one family in v1; cross-family reuse/merge is out of scope. | Makes FR-017 deterministic without a relationship graph or silent reinterpretation while still allowing a later book to star a sibling. |
| C-22 | Why is Flow mode manual copy/import instead of an integration? | Google Labs Flow has no supported public API for this use; automating or scraping it would violate its terms and require storing Google credentials the constitution forbids. Manual copy-out/file-in keeps the operator's subscription as the cost carrier, keeps all credentials out of the app, and keeps every generated byte flowing through the same untrusted-input validation as provider output. Character identity in Flow comes from description blocks plus a consent-gated reference bundle (privacy-clean photo working copies and/or sheet renders — the same identity payload the API path would send); exact `originals/` bytes stay non-exportable and every bundle export is logged (FR-151). | Cost goal met without new credential surface or ToS exposure; photo boundary equals the API path's, with the operator as transport. |
| C-23 | What minimum makes a fully custom story actionable? | `fully_custom` requires a non-empty premise, a beginning/middle/ending beat (each non-empty), and at least one content boundary before the configuration can become generation-ready. The UI identifies each missing field; drafts may still be saved. | Prevents vague provider input while preserving incremental authoring and EC-B12's specific failure. |
| C-24 | How do built-in group mentions get their members? | `@البطل` resolves to the configured `mainChildId`; `@الأصدقاء` resolves to selected project participants whose family relationship is `friend`; `@العيلة` resolves to selected participants whose relationship is a family relation (`main_child`, parent, sibling, or grandparent), excluding friend, teacher, and pet. Expansion uses the project's pinned participant IDs, is deduplicated in project order, and a zero-member result blocks compile. | Deterministic, local, ID-bound behavior avoids hidden inference or mutable ad-hoc groups. |
| C-25 | What is copied when a completed story is duplicated into another family? | A same-family duplicate may retain version-pinned participants and looks. A different-family duplicate copies only non-identifying structure/configuration into a draft with role slots; it carries no source customer/family/character/version/photo/mention IDs, names, dedication, or notes and cannot become ready until every required role is explicitly remapped to the target family. | Fail-closed privacy boundary prevents cross-customer identity leakage while retaining the reusable-story workflow. |
| C-26 | What exactly does full-book customer approval bind to? | One immutable PreviewOutput/cycle/gate bundle: exact PDF asset, customerContentHash (composition/cover/order/page/layout/text/source bytes only), review/selection evidence, preview settings, and gate target. `contentAuthorizationHash` adds the immutable approved outcome while excluding mutable status/attention/operational revisions. Current preview cycle and current content authorization are separate heads, so a new watermark preview cannot borrow the action or erase unchanged approved content. | Closes same-bookVersion and multi-preview ambiguity while preserving auditable stale-file protection and the matrix's non-content exceptions. |
| C-27 | How can layout be approved before the printer profile without IM-14 silently changing composition? | Feature 008 uses one versioned 210 × 297 mm A4 portrait customer-composition profile with a pinned 0.5 mm tolerance and normalized safe/placement regions. Compatibility requires portrait orientation, both printer trim dimensions within tolerance without scaling, and full containment of the composition safe rectangle in the printer safe rectangle. Bleed/DPI/color/ICC/crop/spine/blanks are printer-only. Any failed term requires explicit composition migration, new layouts/cover composition, and re-approval. | Separates customer-visible composition from printer mechanics while preserving the matrix's print-only profile rule. |

No open clarification markers remain. No decision above changes fundamental product behavior or carries material privacy/legal/financial consequence beyond what the risk register records.

---

## 7. Assumptions

- The Mac has: current macOS, Codex CLI optionally installed and logged in by the employee, stable internet for provider calls (app itself is offline-capable for all non-AI work).
- One operator; no concurrent multi-user writes.
- The employee handles WhatsApp entirely outside the app.
- Printing company accepts PDF input and communicates spine width or a cover template per order.
- Egyptian Arabic quality is ultimately judged by the employee; automated checks are advisory.
- Gemini model IDs given in the request are treated as configurable defaults pending research R7 verification; they may be renamed/replaced at runtime configuration without spec change.
- Feasibility gate G1 (Codex subscription image generation) may fail; the product remains viable via Gemini image mode (FR-102).

---

## 8. Example Workflows (normative behavior examples)

### E1 — Ahmed & Ali play football

Input scene: `@أحمد و@علي بيلعبوا كورة في النادي. @أحمد فرحان ومتحمس، و@علي مركز وجاد.`
Compiled structured meaning: participants = {Ahmed(main child), Ali(brother)} only; Ahmed: action=playing football, emotion=happy/excited; Ali: action=playing football, emotion=focused/serious; no parent/pet present; negative constraints forbid extra people; generated image contains **no Arabic text**; text rendered later by layout (FR-073, FR-080).

### E2 — Reusable mother

Mother saved once in the family library. Book 1: relationship=mother, role=guide, look=everyday. Book 2: relationship=mother, role=space-station commander, look=space uniform. Editing the space uniform changes only that look; everyday look and base profile untouched (FR-013/FR-014).

### E3 — Hidden goal, no shaming

Goal: reduce excessive phone use. Output remains a fun space adventure where the child chooses to set the phone aside to finish a spaceship model and join friends. Never: "أحمد غلطان لأنه بيلعب بالموبايل طول الوقت". Review flags any blame/lecture phrasing (FR-047/FR-048).

### E4 — Regenerate page 7 only

Ali has wrong shirt on page 7. Employee sets page-specific look, regenerates page 7. Pages 1–6, 8–16 unchanged (checksum-verified); page 7 gets new version with history; preview stale; recorded book approval invalidated (FR-062…FR-066, invalidation matrix).

### E5 — Codex quota exhaustion at 14/20

14 completed illustrations stay valid; 6 jobs pause with exact reason; employee chooses wait vs continue-with-Gemini; no auto-switch; per-page provenance records the actual generator (FR-096, FR-094).

### E6 — Duplicate names

Main child أحمد and friend أحمد. Picker shows "أحمد — الطفل البطل — thumbnail A" and "أحمد — الصديق — thumbnail B". Renaming the friend later breaks nothing (IDs stable, FR-036/FR-039).

### E7 — Template from completed story

Completed treasure story → save as template: structure copied; customer photos/names stripped into role slots; original story immutable (FR-051/FR-052).

### E8 — Single Image Studio (no book)

Employee opens «توليد صورة», picks أحمد (main child) + "Space Suit" look, prompt: "أحمد واقف قدام مركبة فضاء، مبتسم، رسم كرتوني". One job runs; image has no Arabic text in pixels; provenance stored; download works; no Project created; an open book project elsewhere is unchanged (FR-140–146, SC-013).

### E9 — Flow-mode book (zero API image cost)

Project for أحمد, 16 pages, image provider = External. Text pipeline runs on Codex; prompts validate. Employee opens Prompt Pack: copies أحمد's consistency block into Flow's character builder and exports his consent-gated reference bundle (privacy-clean photo working copies + approved sheet render — export logged, upload warning shown) to upload there for maximum likeness, then copies page prompts 1–16 one by one, generating in Flow. Downloads 16 images, imports them, maps each to its page (prompt + thumbnail side-by-side). Page 7's file is 900px wide → persistent low-DPI warning; employee regenerates it in Flow at higher resolution and imports again (new version appended). Meanwhile she edits scene 3's action → pack marked stale for page 3; her earlier page-3 download now rejects with `stale_dependency`; she recompiles the pack, regenerates page 3 in Flow, imports. Review checklist, layout, watermarked preview, approval, and print preflight proceed exactly as with API images (FR-149–159, SC-015).

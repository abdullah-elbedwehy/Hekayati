# Feature Specification: Story Authoring and Templates

**Feature ID**: `004-story-authoring-and-templates`

**Status**: Ready for implementation

**Canonical bible**: [Hekayati product specification](../001-hekayati-product-bible/spec.md)

**Delivery tasks**: [Phase 3](../001-hekayati-product-bible/tasks.md#phase-3--templates-story-configuration-mentions-us3-us10)

This leaf owns delivery and acceptance; it does not restate or override canonical requirements. Precedence remains constitution → product bible → this slice → implementation.

## Outcome and boundary

Without configuring or contacting an AI provider, the operator can:

- create a family-scoped, immutable-versioned project configuration for a 16- or 24-page book;
- select characters, roles, looks, or project-only appearance overrides without mutating the reusable library;
- author every story-page scene with stable Arabic `@mention` tokens and structured per-character properties;
- compile the authored document into an exact, confirmed participant set;
- create, version, disable/archive, duplicate, and safely extract reusable templates; and
- start from seven complete Arabic seed templates whose installation is repeatable and non-destructive.

Primary ownership is **US3, US10; FR-035–041, FR-045–053, FR-055–060; IM-04, IM-16; C-11, C-23–25**. This slice also delivers the project-only destination consumed from FR-014(a), the capacity-warning input boundary consumed from FR-075/C-08, and the active-family-anchor policy consumed from C-21.

The slice does not call providers, schedule jobs, generate prose or images, render final page typography, record approvals, or assemble printer pages. Those remain in 005–009. Illustration style IDs are stable selections here; prompt behavior remains 005/007.

## Readiness decisions

These conservative decisions close gaps in the shared model and are binding for this slice:

1. **Immutable project configuration.** Project identity owns an expected-head pointer. Every configuration edit appends a `ProjectVersion`; participants pin character/look/override versions. A stale head performs zero writes.
2. **Project-only appearance.** `base`, `sharedLook`, and `projectOverride` are a strict union. Creating or editing an override atomically appends its version, advances the project pin, and emits IM-04. Shared character/look bytes never change.
3. **Identity-safe mentions.** Stored mention segments contain a character ID and properties, never an authoritative display name. Rendering resolves the current visible name; compilation resolves the project-pinned version. Partial tokens become explicit unresolved text.
4. **Deterministic groups.** C-24 defines `hero`, `friends`, and `family`; expansion is project-ordered, deduplicated, and never inferred from prose. An empty group blocks compile.
5. **Custom-story minimum.** C-23 permits incomplete drafts but requires premise, beginning/middle/ending beats, and at least one content boundary before `generation_ready`.
6. **Cross-family privacy.** C-25 copies only reusable structure into unbound role slots. Same-family duplication may retain pinned participants; cross-family copies never retain source identities or private free text.
7. **Capability input.** Compilation accepts an injected verified capacity. A real model with no verified capacity is unavailable; the planning example of three is never a runtime default. The mock may explicitly advertise unlimited capacity.
8. **Canonical page map.** A 16-page interior is title, dedication, 12 story slots, farewell, brand; a 24-page interior substitutes 20 story slots. Covers and printer-only pages do not enter this map.
9. **Page-count changes.** A deterministic preflight lists retained, added, merged, and explicitly removed source slots, plus a hash. Confirmation requires the unchanged project head and hash. Old versions survive; nothing changes before confirmation.
10. **Template lifecycle.** Disabled templates remain manageable but are excluded from new-project selection; archived templates are hidden from routine lists. Both remain readable by existing pins and are reversible. Seed installation never overwrites an existing stable seed key.

## Domain and interface contract

Canonical shapes live in [data-model.md](../001-hekayati-product-bible/data-model.md). Implementation schemas must preserve these additional interface guarantees:

- `ProjectVersion.storyConfig` is the sole mutable-story configuration snapshot. Customer and family ownership never change.
- `appearanceSelection` is exactly `base | sharedLook(version-pinned) | projectOverride(version-pinned)`.
- `documentSegments` is an ordered union of `text | mention | group | unresolved`; malformed unions are rejected at the repository boundary.
- `AuthoringCompileResult` contains the pinned project version, ordered concrete participants and mention properties, warnings/required acknowledgements, and no provider prompt or raw image data.
- The page-map projection uses customer-visible interior page numbers while scenes use `storyPageIndex` 1–12 or 1–20.
- Downstream-only FR-059 fields may be represented as empty lineage slots, but this slice must persist all author-owned scene/page fields and must not fabricate prompts, assets, provenance, reviews, or approvals.
- Every read/mutation accepts family/project scope at the domain boundary; direct-ID access cannot bypass family ownership.

### Stable failure codes

Arabic UI copy may be refined, but APIs and tests use these codes:

| Code | Meaning / zero-write condition |
|---|---|
| `FAMILY_ANCHOR_REQUIRED` / `FAMILY_ANCHOR_ARCHIVED` | New project selection is not eligible under C-21. Existing pinned projects remain readable. |
| `PROJECT_FAMILY_SCOPE_VIOLATION` | A customer, family, character, look, override, scene, or template-derived role crosses its allowed ownership boundary. |
| `PROJECT_VERSION_CONFLICT` / `TEMPLATE_VERSION_CONFLICT` | Expected head is stale; no version, pin, or outbox event is written. |
| `TEMPLATE_REQUIRED` / `TEMPLATE_NOT_SELECTABLE` | Saved-template configuration lacks an active template pin or attempts a new pin to disabled/archived content. |
| `CUSTOM_STORY_INCOMPLETE` | C-23 readiness fields are missing; response identifies every missing field while the draft remains saved. |
| `MENTION_UNRESOLVED` | At least one unresolved segment exists. |
| `MENTION_GROUP_EMPTY` | A C-24 group expands to zero selected project participants. |
| `MENTION_CHARACTER_NOT_IN_PROJECT` | A mention ID is not one of the pinned participants. |
| `MENTION_LOOK_NOT_OWNED` | A selected look/override does not belong to that pinned project character. |
| `PARTICIPANT_RECONCILIATION_REQUIRED` | Prose/mention membership differs from the selected participant set and lacks explicit acknowledgement. |
| `MODEL_CAPABILITY_UNAVAILABLE` | A real selected model has no verified reliable-reference capacity. |
| `PARTICIPANT_CAPACITY_CONFIRMATION_REQUIRED` | Participant count exceeds the injected verified capacity and lacks acknowledgement. |
| `CHARACTER_REMOVAL_RESOLUTION_REQUIRED` | Referenced character removal lacks replace/remove-mentions/cancel resolution; affected scene IDs are returned. |
| `PAGE_COUNT_PREFLIGHT_REQUIRED` / `PAGE_COUNT_PREFLIGHT_STALE` | Direct change is forbidden, or the confirmed hash/head no longer matches. |
| `STORY_STRUCTURE_INCOMPLETE` | A manual story lacks one valid scene per projected story slot. |
| `CROSS_FAMILY_ROLE_REMAP_REQUIRED` | A C-25 draft still has unbound required role slots. |

## Dependencies

### Inputs from implemented slices

- 002: `DocumentStore`, repository validation, schema migration, safe local API boundary, CSRF/origin protection, Arabic RTL shell, and first-run seed hook.
- 003: customers/families, active anchor eligibility, immutable characters/looks, safe thumbnail projection, closed edit intent, shared scope policy, change-event schema/repository, and version-head compare-and-swap conventions.

### Outputs consumed later

- 005 consumes validated configuration/compile DTOs and stable style IDs; it must not reinterpret membership or capacity acknowledgement.
- 006 consumes only later generation tasks; this slice creates no jobs.
- 007 consumes project/template/story/scene version pins and completes generated content, prompts, page lineage, review, and invalidation processing.
- 008 consumes the exact customer-visible page map and editable title/dedication/ending text.
- 009 may add printer-only blanks at assembly without changing this map.
- 010 consumes dependency inventory and immutable versions for export/deletion.

## Acceptance scenarios

| ID | Provider-free scenario | Required evidence |
|---|---|---|
| A-004-01 | Create a 16-page Space Adventure project for an active anchored family; select main child + participants, roles, look pins, tone/style/goal/notes, and edit the balance suggestion. | One `ProjectVersion`, exact 12 story slots, page 1/2/15/16 kinds, complete FR-045 snapshot, restart persistence. |
| A-004-02 | Attempt project creation for missing/archived anchor and direct cross-family character/look IDs. | Exact failure codes, zero project/version/outbox writes, prior pinned projects unchanged. |
| A-004-03 | Choose “change only for this project,” then edit it. | Shared character/look documents remain byte-identical; immutable override versions and project pins advance atomically; one IM-04 event per change. |
| A-004-04 | Type/search/select two characters named أحمد, add properties/dialogue, rename one to علي, restart, and render the scene. | Picker disambiguation, diacritic-insensitive keyboard search, stable IDs, current name rendering, ordered properties preserved. |
| A-004-05 | Paste and partially delete mention text; compile an unresolved token and each built-in group including a zero-member group. | Only valid tokens or flagged unresolved segments persist; exact block code; non-empty groups expand exactly per C-24. |
| A-004-06 | Compile prose/participants with mismatch, foreign look, capacity above/below/unset, and explicit acknowledgements. | Required warnings/blocks; exact confirmed participant DTO; unset real capacity never defaults to three; no network request. |
| A-004-07 | Remove a referenced character using cancel, replace, and remove-mentions resolutions. | Affected-scenes preflight; cancel is zero-write; successful options append versions and leave old versions readable. |
| A-004-08 | Edit/archive/disable/restore a template already pinned by a project. | New projects obey lifecycle visibility; old pin reads old bytes; IM-16 has no downstream mutation. |
| A-004-09 | Run first-start seed installation, restart repeatedly, then edit/disable a seed and restart. | Exactly seven stable keys; complete seed schema; no duplicate or overwrite. |
| A-004-10 | Extract a template from a completed story and duplicate it same-family and cross-family. | Source unchanged; secret/identity scan empty; same-family pins allowed; cross-family role slots block readiness until remapped. |
| A-004-11 | Preflight 16→24 and 24→16, alter the head before confirmation, then confirm a fresh plan. | Explicit mapping/hash, zero pre-confirm mutation, stale rejection, appended configuration/story structure, all prior scene versions retained. |
| A-004-12 | Complete a manual 16-page story, toggle a genuine sequential two-image moment, restart, and inspect every author-owned FR-059 field. | `complete` only with 12 valid scenes; operator choice persisted; no prompt/provenance/image fields fabricated. |
| A-004-13 | Exercise Arabic project/template/scene flows at 390×844, 1440×900, and 1920×1080 with keyboard and axe. | RTL, MSA copy, Western digits, focus, ≥44px targets, no clipped controls/horizontal scroll, no serious axe violations. |
| A-004-14 | Capture all browser/server requests during the full journey. | Zero non-loopback/external requests and zero provider calls. |

## Staged success and verification

| Stage | Exit signal |
|---|---|
| Domain | Schema, version/CAS, balance, page-map, mention, compile, override, template, extraction, and privacy unit tests pass. |
| Persistence/API | Restart, stale-head, transaction rollback, direct-ID scope, seed idempotence, and outbox assertions pass against the real local store. |
| UI | CHK006/009–011 and CHK406–409 pass in Arabic RTL with keyboard and accessibility checks. |
| E2E | US3 + US10 and A-004-01–14 pass with synthetic characters, zero provider configuration, and zero external requests. |
| Checkpoint | T-P3-01–09 are complete; build, lint/type/file-size guard, coverage target, dependency audit, and implementation notes are green. |

## Delivery mapping

| Task | Primary acceptance |
|---|---|
| T-P3-01 | A-004-08 |
| T-P3-02 | A-004-09 |
| T-P3-03 | A-004-01–03 |
| T-P3-04 | A-004-04–05 |
| T-P3-05 | A-004-04, A-004-13 |
| T-P3-06 | A-004-05–07 |
| T-P3-07 | A-004-10 |
| T-P3-08 | A-004-01–14 end-to-end |
| T-P3-09 | A-004-01, A-004-11–12 |

The canonical master checkpoint and DoD remain in [tasks.md](../001-hekayati-product-bible/tasks.md). [ANALYZE.md](ANALYZE.md) records the cross-artifact readiness verdict.

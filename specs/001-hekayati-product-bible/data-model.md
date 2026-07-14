# Data Model: Hekayati

**Feature**: `001-hekayati` | **Date**: 2026-07-14
Document-oriented model (C-01, research R2). Every document: `id` (ULID), `createdAt`, `updatedAt`, `schemaVersion`. Collections listed with key fields; free-form maps allowed where noted (NoSQL flexibility). Validation via zod at the repository boundary.

## Conventions

- **Versioned entity**: immutable version documents + a head pointer. `<Entity>Version` holds content; `<Entity>` holds identity + `currentVersionId` + lifecycle status. Nothing edits a version in place; edits append a version.
- **Reference**: by `id` (+ `versionId` where the spec requires version binding). Mentions, approvals, provenance, and job inputs always bind versions.
- **Soft states**: `archived` hides from pickers without breaking references; **permanent delete** is the only destructive operation (FR-005).

## Collections

### customers
`name`, `whatsapp`, `notes`, `consent: null | { granted: bool, date, note }`, `status: active|archived`. `null` is fail-closed "not recorded"; both recorded decisions carry their own date and note (C-13). Archive/restore is non-destructive; permanent deletion is FR-005 only (C-18).
Owns → families. Deletion cascades (FR-005) with pre-report.

### families
`customerId`, `name`, `anchorCharacterId?`, `status: active|archived`. Members are queried from `characters.familyId`; no duplicated member-ID array is stored. A family may be empty, but its first active member MUST have current `relationship.type=main_child`; that creation assigns the anchor only from null in the same transaction. The anchor is immutable until FR-005 deletion, no other active member may have `main_child`, and the anchor's relationship cannot change. A missing or archived anchor blocks later member creation and new Project/Studio selection with `FAMILY_ANCHOR_REQUIRED` or `FAMILY_ANCHOR_ARCHIVED`; it never reinterprets existing relationship versions. Relationship labels are relative to that anchor (C-21). Scoping boundary for project character selection (FR-003).

### characters *(versioned)*
Identity: `familyId`, `status: active|archived`, `currentVersionId`.
`CharacterVersion.profile`: `name`, `nickname`, `relationship { type: main_child|father|mother|brother|sister|grandfather|grandmother|friend|teacher|pet|custom, customLabel? }`, `appearanceDescription`, `ageOrRange`, `gender`, `skinTone`, `hair`, `eyeColor`, `relativeHeight`, `build`, `distinguishingFeatures[]`, `glasses`, `hijab`, `accessories[]`, `interests[]`, `favoriteObjects[]`, `favoriteColor`, `personalityTraits[]`, `speakingStyle`, `notes`, `sourceMode: photo|description|both`, `referencePhotoIds[]`, `traits: map` *(free-form)*. `customLabel` is required only for `custom`; description/both modes require `appearanceDescription`, and photo/both modes require at least one usable reference. Pet status is derived from `relationship.type`; it is not duplicated on identity. `familyId` is immutable in v1. Relationship is version-bound and family-level, while narrative role remains project-only (FR-010/015/017).
Looks are queried from `looks.characterId`; no duplicated look-ID array is stored. Version bump emits the classified change events below; approval superseding and downstream staleness are consumed later by feature 007 (FR-033).

### looks *(versioned)*
Identity: `characterId`, `status: active|archived`, `currentVersionId`. `LookVersion: { name, clothing, appearanceOverrides: map, referencePhotoIds[] }` (e.g., الملابس الأصلية / يومي / بدلة فضاء). Editing rules FR-014: project-only override lives on the project (below), not here. Look names are versioned because they are visible/pinned content; look references resolve through the same consent/privacy-safe `ReferencePhoto.providerAssetId` path as character references.

### referencePhotos *(immutable intake records)*
`customerId`, `familyId`, `owner: { type: character, characterId } | { type: look, characterId, lookId }`, `kind: face|full_body|clothing|other`, `originalAssetId` *(references the private `originalAssets` namespace)*, `workingAssetId`, `thumbnailAssetId`, `providerAssetId?`, `subjectSelection? { x, y, width, height }` *(normalized 0–1 coordinates on the oriented working copy; required for `face`)*, `quality { policyVersion, metrics { widthPx, heightPx, blurScore, exposureScore, shadowFraction, subjectBoxAreaRatio? }, warnings[] { code, source: local_check|operator, metric?, threshold?, details? }, observations { peopleCount?, obstruction?, filterSuspected?, apparentAgeBand?, hair?, clothing? } }`, `usableAsFaceReference: bool`, `supersedesPhotoId?`.

The exact upload remains local in the separate original namespace. `workingAssetId` is always a newly derived, orientation-corrected, metadata-stripped `reference_photo` asset, so it can never alias the original record. `providerAssetId` is the only field later provider code may accept: for `face`, it is always a newly derived sanitized subject crop; for a suitable `full_body`, `clothing`, or `other` reference, it may equal the privacy-clean working asset. Face intake cannot commit until a subject rectangle exists, and multi-person input requires an explicit intended-person selection (FR-021/024/134). Character-owned records must occur in the pinned `CharacterVersion.referencePhotoIds`; look-owned records must occur in the pinned `LookVersion.referencePhotoIds`, whose `characterId` must match. Originals are not `Asset` IDs and are structurally ineligible for provider payloads.

Photo intake uses a private pre-commit reservation, not a persisted product collection. A cryptographically random runtime-only token identifies generated `.hekayati-tmp-*` files and validated safe metadata; it is carried only in CSRF-protected request bodies/headers and is absent from URLs, logs, exports, and final records. The reservation targets an existing character/look or a preallocated new-character draft. It computes the family-local duplicate candidates after content hashing and returns only a derived thumbnail plus safe findings. Commit requires the operator's duplicate decision and every required face rectangle. For a new photo-only character, the character identity, first usable `CharacterVersion`, `ReferencePhoto`, original/derived asset records, head, and outbox events commit together. For an existing character/look, the same transaction appends the owning version and advances its expected head. Cancel/expiry compensates prepared files; restart loses the runtime token and startup GC removes only the recognized unindexed reservation files (FR-019/025).

### characterSheets
`characterId`, `characterVersionId`, `lookVersionId`, `views { face, front, threeQuarter, fullBody, mainOutfit } → assetIds`, `referenceLineage { source: description_only|photo_derived, referencePhotoIds[] }`, `status: generating|ready|revision_needed|approved_superseded`, `pdfAssetId`, provenance. `referenceLineage` is derived from the pinned input versions and generation provenance, never accepted from a caller: any transitive photo input makes the sheet `photo_derived`; only zero-photo lineage is `description_only`. Approval target (FR-030–033) and later FR-004 consent decision input.

### projects *(versioned configuration)*
Identity: `customerId`, `familyId`, `status` (see state-machines.md), `priority`, `paused: bool`, `currentVersionId`, `bookVersion` (monotonic; bumps on any customer-visible change — drives FR-086), `printerProfileId?`. Customer/family ownership is immutable.

`ProjectVersion.storyConfig`: `title`, `mainChildId`, `participants[] { characterId, characterVersionId, narrativeRole, appearanceSelection }`, `occasion`, `dedicationText`, `storyType: connected_adventure|related_situations|saved_template|fully_custom`, `templateId? + templateVersionId?`, `pageCount: 16|24`, `tone: light_funny|adventurous|warm_family|magical|educational_non_preachy|custom`, `customTone?`, `illustrationStyleId: modern_cartoon|colorful_2d|soft_watercolor`, `hiddenGoal { goal, customGoal?, presentation: indirect|acknowledged_ending } | null`, `clothingNotes`, `customNotes`, `audienceAgeBand: age_3_5|age_6_8|age_9_12`, `readingLevel: early|developing|independent`, `sceneComplexity: low|medium|high`, `narrationDialogueBalance { suggestedNarrationPercent, selectedNarrationPercent, operatorEdited, formulaVersion }`, `customStory? { premise, beginningBeat, middleBeat, endingBeat, contentBoundaries[] }`, and editable `endingPages { farewellText, brandLine }`.

Every participant is same-family and pins an immutable character version. `mainChildId` is one selected non-pet participant; the family's assign-once anchor must independently be active (C-21). `appearanceSelection` is the strict union `base | { sharedLook: { lookId, lookVersionId } } | { projectOverride: { overrideId, overrideVersionId } }`. The selected template version is pinned; a `saved_template` requires it, while `fully_custom` uses C-23. Configuration edits append under expected-head compare-and-swap; prior versions remain readable.

The canonical customer-visible page map is a deterministic projection of the pinned `ProjectVersion`: page 1 title, page 2 dedication, pages 3–14 or 3–22 story, then farewell and brand ending pages. Covers and printer-only blanks are absent. A page-count preflight returns an explicit add/merge/remove mapping plus a content hash; committing it requires that hash, the expected project head, and operator confirmation, then appends one project version. It never edits or drops authored scenes as a side effect (FR-055–058, C-05).

### projectCharacterOverrides *(versioned)*
Identity: `projectId`, `characterId`, `currentVersionId`, `status: active|archived`. `ProjectCharacterOverrideVersion: { baseCharacterVersionId, baseLookVersionId?, clothing, appearanceOverrides: map }`. It may reference only the project's pinned character and an owned pinned look; it introduces no new photo intake path. Create/edit appends the override version, advances its expected head, updates the project participant's pinned `appearanceSelection`, and emits one IM-04 `changeEvent` atomically. Shared `CharacterVersion` and `LookVersion` records remain byte-identical (FR-014(a)).

### storyTemplates *(versioned)*
Identity: `seedKey?`, `status: active|archived|disabled`, `currentVersionId`. `TemplateVersion: { name, premise, structure[], environments[], roleSlots[] { slot, requiredRelationship?, narrativeRole }, variables[] { key, type, required, default? }, possibleHiddenGoals[], sceneGuidance[], ageAdaptationRules[], contentBoundaries[], endingPatterns[] }`. Template edits append under expected-head compare-and-swap; projects pin `templateVersionId` forever (FR-050–052). `disabled` stays visible in management but is unavailable to new projects; `archived` is hidden from routine lists; either remains readable by pinned projects and is reversible. Seven stable-key seed templates install idempotently at first run; restart never overwrites an edited or disabled/archived seed (FR-053).

### stories *(versioned)*
Identity: `projectId`, `status: draft|complete`, `currentVersionId`. `StoryVersion: { previousVersionId?, source: manual|generated, planJson? (validated StoryPlan schema), sceneVersionIds[], pageCountChange? { from, to, planHash, operations[] }, completedAt? }`. Manual authoring in feature 004 and generated content in feature 007 use the same immutable lineage. `complete` requires one valid scene version for every story-page slot; provider generation is not required. Regenerating or editing appends a version; scenes/pages pin `storyVersionId`. A page-count confirmation appends a structure revision: source scene versions remain immutable, while added/merged targets are explicit incomplete drafts until authored.

### scenes *(versioned)*
Identity: `projectId`, `storyPageIndex`, `currentVersionId`. `SceneVersion: { previousVersionId?, sourceSceneVersionIds[], needsAuthoring, purpose, description, documentSegments[], environment, timeOfDay, composition, cameraFraming, narrativeText, dialogue[] { speakerCharacterId, text }, twoImageMoment: bool }`. `storyPageIndex` is 1–12 or 1–20 and maps to customer-visible page 3 onward; it is not a printer page number. `sourceSceneVersionIds` is empty for ordinary manual authoring and records only explicit page-count retain/merge provenance; it never grants mutable aliases.

`documentSegments` is an ordered strict union: `{ type: text, text } | { type: mention, characterId, props { action, emotion, position?, framing?, lookId?, heldObject?, gazeTarget?, speaks, dialogue? } } | { type: group, groupKey: hero|friends|family, props? } | { type: unresolved, text }`. Mention documents store no authoritative display name and no character version: the editor renders the character's current display name while compile resolves the project's pinned `characterVersionId`. A partial delete or paste can only produce a complete token or an explicit unresolved segment; unresolved segments block compile. Built-in group expansion follows C-24. Dialogue speaker IDs must occur in the confirmed scene participant set (FR-035–041).

### pages *(versioned lineage per FR-059)*
`projectId`, `pageNumber`, `kind: title|dedication|story|ending1|ending2`,
`locked: bool`, `reviewStatus: unreviewed|flagged|approved`, `staleReason?` (from invalidation),
`currentIllustrationVersionId?`, `currentLayoutVersionId?` (absent until their owning downstream stages create them).
`IllustrationVersion`: `assetId`, `promptCompiled`, `negativeConstraints[]`, `inputSnapshot { sceneVersionId, characterVersionIds[], lookVersionIds[], styleId, settingsHash }`, `provenance`, `supersededBy?`.
`LayoutVersion`: `placement: auto|top|bottom|right|left`, `resolvedRegion`, `readabilityAid: none|gradient|panel`, `fontSizePt`, `overflow: bool`, `bubbles[]`.
Commit precondition: job's `inputSnapshot` must match current lineage else reject (FR-065).

### jobs *(scheduler-owned — full semantics in contracts/job-scheduler-contract.md)*
Strict version-1 document with `type`, `projectId?`/standalone scope, `dependsOn[]`, `state` + bounded reason, `priority: 1..5`, `revision`, `intentId`, `idempotencyKey` (unique), independent canonical `requestHash`, immutable `target { provider, modelId, operation, settingsHash }`, canonical persisted request (`TextRequest`/`StructuredRequest`/`ImageRequestDraft` or human-gate descriptor), `inputSnapshot { entity IDs + version IDs }`, `lease? { workerId, bootId, claimToken, expiresAtMono }`, attempt/retry counters, progress/stall projection, normalized privacy-safe failure/structural diagnostics, provenance, `resultRefs[]`, and optional predecessor/successor job links. Runtime bytes/paths/`ResolvedImageRequest`, originals, secrets, raw provider output, rejected values, command output, and arbitrary provider payloads are invalid. Append-only `jobEvents` retain bounded transition/attempt/progress/failure/decision/rejection/recovery history. Provider quota incidents and the global storage pause are persisted; audit events record only explicit wait/continue decisions and successor links.

### originalAssets *(private intake namespace; never a provider input type)*
`sha256` (unique within this namespace), `sourceMime`, `extension`, `bytes`, `refCount`, `createdAt`. Exact upload bytes live at `originals/<sha256[0:2]>/<sha256>.<ext>` with the same atomic-write, checksum, private-permission, integrity-scan, and reserved-name-only GC rules as R4. This namespace deliberately has no provider provenance or provider-facing ID conversion. It exists only for FR-021 local retention, export, integrity, and FR-005 deletion.

### assets
`sha256` (unique), `mime`, `bytes`, `width/height/dpi?`, `role: reference_photo|sheet_view|illustration|pdf_preview|pdf_interior|pdf_cover|thumbnail|import_staging`, `origin: upload|generated|derived`, `provenance { provider, model, at, jobId, inputVersionRefs, promptVersion, referencedAssetIds[], attempt, settingsSnapshot }` (FR-094), `exifStripped: bool`, `refCount`.

`settingsSnapshot` is a strict, versioned, secret-free generation-settings record: a required SHA-256 `settingsHash` plus only explicitly modeled controls such as quality mode, style ID, reference budget, economy-tier state, and output dimensions. Provider response payloads, arbitrary nested values, credentials, prompt/image bytes, and runtime tokens are invalid. Generated assets require provenance. Every upload-derived `reference_photo` and `thumbnail` asset requires `exifStripped: true`; for this flag, “EXIF” means verification that GPS, EXIF, IPTC, XMP, device, and other non-essential metadata are absent. Because `sha256` is globally unique while role/origin/provenance are singular, a same-byte put may increment `refCount` only when canonical metadata is identical; conflicting metadata fails explicitly instead of discarding traceability. Exact uploads never collide with this rule because they live in the private original namespace, while every working/provider asset is a derived copy.
File at `assets/<sha256[0:2]>/<sha256>.<ext>`; write path per R4.

The data root itself is application-owned only after a valid `.hekayati-data-root.json` marker is created in an empty root. Reusing a non-empty unmarked root is invalid; managed child paths cannot be symlinks. Orphan collection recognizes only Hekayati temporary names and canonical content-addressed filenames.

### approvals
`kind: character|book`, `targetId`, `targetVersionId` (characterSheet version or project bookVersion), `state: preview_sent|approved|changes_requested|invalidated|superseded`, `notes`, `affectedPages[]`, `recordedAt`, `invalidatedBy? { changeType, refId, at }` (FR-085–087).

### printerProfiles
`name`, `trim { w,h }` (default A4), `bleedMm` (default 3), `safeMarginMm`, `dpiMin` (default 300), `colorMode: rgb|cmyk`, `iccProfilePath?`, `cropMarks: bool`, `spineWidthMm?`, `coverTemplate? { source, geometry }`, `requiredBlankPages?`. Spine unknown + no template ⇒ cover production blocked (FR-122).

### exports
`projectId`, `manifestVersion`, `filePath`, `checksum`, `createdAt`, `secretScan: passed|failed`, `pausedSnapshot: true` (C-07).

### settings (single doc)
`textProvider`, `imageProvider`, `models { codexText, geminiText, geminiImage, geminiImageEconomy }`, `concurrencyPerProvider`, `typography { minimumAge3To5Pt, minimumAge6PlusPt }`, `watermarkText`, `diskWarnGb`, `photoUploadMaxMb` *(default 25)*, `photoMaxMegapixels` *(default 80)*, `storagePathsReadonly`, `firstRunAcknowledged`, `deferredStatus { providerLifecycle, printerProfiles }`. **No secrets** (FR-137); Gemini key only in Keychain (FR-105). The repository's shared secret registry rejects known credential patterns and registered exact runtime secrets in every field before persistence, including otherwise-valid model and watermark strings. Feature 003 migrates the settings document from schema v1 to v2 to add both photo limits; upload streaming reads the current values before accepting bytes or decoding (FR-022).

Settings delivery is staged: Phase 1 owns this validated document and foundation-safe fields; provider credential/capability semantics are completed by feature 005, and `printerProfiles` management by feature 009. A field whose owning subsystem is not delivered reports `not_configured`/`not_available`; it is never fabricated as healthy (FR-137/138).

### runtime local-HTTP trust state *(not a collection)*

`canonicalOrigin = http://127.0.0.1:<verifiedBoundPort>` and a cryptographically random `csrfToken` exist only in process memory. The token rotates on every app start, is exposed only through a non-cacheable same-origin app bootstrap, and is compared on every unsafe request. Neither value is stored as a document, written to logs, included in exports, or accepted from forwarded-host headers (FR-147, FR-148). Health may expose the verified bind address and pass/fail state, never the token.

### studioGenerations
Standalone Single Image Studio records (FR-140–146). Not owned by a Project.
`id`, `customerId?`, `familyId?`, `prompt`, `negativeConstraints?`, `styleId`, `participants[] { characterId, characterVersionId, lookId?, lookVersionId? }`, `jobId`, `state`, `assetId?`, `priorAssetIds[]` (history), `provenance`, `createdAt`, `updatedAt`.
Constraints: all participants MUST share the same family when present (FR-146); `projectId` is always null; asset role `illustration` with provenance `origin: generated` and job type `studio_image`.

### auditEvents
Append-only operator-visible history: provider switches, quota decisions (FR-096), approvals/invalidations, deletions, imports/exports, studio generations. Supports SC-009/SC-010/SC-013 audits.

### changeEvents *(append-only invalidation outbox)*
`entity: character|look|project_override|library_visibility`, `entityId`, `fromVersionId?`, `toVersionId?`, `changeType: permanent_appearance|non_visual_profile|shared_look|project_look_override|rename|archive_restore`, `matrixRow: IM-01|IM-02|IM-03|IM-04|IM-05|IM-21`, `changedFields[]`, `correlationId`, `occurredAt`.

Appending immutable version(s), compare-and-swap of each head pointer, and every classified outbox event happen in one SQLite transaction. Duplicate version IDs and stale expected heads fail without partial writes. Slice 003 produces IM-01–03/05/21 events; slice 004 adds project-override IM-04 events; slice 007 consumes each event idempotently and writes a separate immutable `invalidationReceipt` keyed by event ID. Archive/restore emits visibility-only IM-21, not a content version bump.

### invalidationReceipts *(feature 007)*
`eventId` (unique), `consumedAt`, `consequenceHash`, `affectedIds[]`. Receipts are append-only and separate from immutable `changeEvents`; a repeated event is a no-op after verifying the recorded consequence hash.

## Relationship summary

```text
Customer 1─n Family 1─n Character 1─n Look
Character 1─n CharacterVersion ; Look 1─n LookVersion
Character 1─n ReferencePhoto ; ReferencePhoto → private OriginalAsset + working/provider Asset
Project n─1 Family ; Project 1─n Page 1─n IllustrationVersion/LayoutVersion
Project 1─1 Story 1─n StoryVersion 1─n Scene(Version)
Project 1─n Job (DAG via dependsOn) ; Job n─n Asset (via resultRefs/provenance)
StudioGeneration n─0..1 Family ; StudioGeneration 1─1 Job (type studio_image, no projectId)
Approval → target version ; Template 1─n TemplateVersion ← Project pins one
```

## Versioning & invalidation hooks

- Any write that bumps a version emits the `changeEvents` above. Character fields classify as: `rename` = `name`, `nickname` (IM-05); `permanent_appearance` = `appearanceDescription`, `sourceMode`, `ageOrRange`, `gender`, `skinTone`, `hair`, `eyeColor`, `relativeHeight`, `build`, `distinguishingFeatures`, `glasses`, `hijab`, `accessories`, `referencePhotoIds`, plus unclassified `notes`/`traits` because they may contain appearance guidance (IM-01); `non_visual_profile` = `ageOrRange`, `gender`, `relationship`, `interests`, `favoriteObjects`, `favoriteColor`, `personalityTraits`, `speakingStyle`, plus `notes`/`traits` (IM-02); any `LookVersion` name/clothing/override/reference change = `shared_look` (IM-03); project inline/look selection = `project_look_override` (IM-04). One edit may emit multiple events; the later engine deduplicates consequences rather than dropping a row. Slice 003 persists its character/look/visibility events; slice 004 persists project-override events; slice 007 consumes both when the shared invalidation engine exists. Archive/restore emits IM-21 only and never changes pinned versions. Locked pages receive flags only (FR-064).
- `bookVersion` increments on: page text/illustration/layout change, page order/count change, dedication/title/cover change — the customer-visible set of FR-086.

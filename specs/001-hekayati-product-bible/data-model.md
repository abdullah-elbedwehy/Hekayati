# Data Model: Hekayati

**Feature**: `001-hekayati` | **Date**: 2026-07-14
Document-oriented model (C-01, research R2). Every document: `id` (ULID), `createdAt`, `updatedAt`, `schemaVersion`. Collections listed with key fields; free-form maps allowed where noted (NoSQL flexibility). Validation via zod at the repository boundary.

## Conventions

- **Versioned entity**: immutable version documents + a head pointer. `<Entity>Version` holds content; `<Entity>` holds identity + `currentVersionId` + lifecycle status. Nothing edits a version in place; edits append a version.
- **Reference**: by `id` (+ `versionId` where the spec requires version binding). Mentions, approvals, provenance, and job inputs always bind versions.
- **Soft states**: `archived` hides from pickers without breaking references; **permanent delete** is the only destructive operation (FR-005).

## Collections

### customers
`name`, `whatsapp`, `notes`, `consent { granted: bool, date, note }`, `status: active|archived`.
Owns → families. Deletion cascades (FR-005) with pre-report.

### families
`customerId`, `name`, `memberCharacterIds[]`. Scoping boundary for project character selection (FR-003).

### characters *(versioned)*
Identity: `familyId`, `isPet`, `relationship` (enum + custom label) — relationship is family-level (FR-017).
`CharacterVersion.profile`: `name`, `nickname`, `ageOrRange`, `gender`, `skinTone`, `hair`, `eyeColor`, `relativeHeight`, `build`, `distinguishingFeatures[]`, `glasses`, `hijab`, `accessories[]`, `interests[]`, `favoriteObjects[]`, `favoriteColor`, `personalityTraits[]`, `speakingStyle`, `notes`, `descriptionOnly: bool`, `referencePhotoAssetIds[]`, `traits: map` *(free-form)*.
`looks[]` → look ids. Version bump triggers approval superseding + downstream staleness (FR-033, matrix IM-02).

### looks *(versioned)*
`characterId`, `name` (e.g., الملابس الأصلية / يومي / بدلة فضاء), `LookVersion: { clothing, appearanceOverrides: map, referenceAssetIds[] }`. Editing rules FR-014: project-only override lives on the project (below), not here.

### characterSheets
`characterId`, `characterVersionId`, `lookVersionId`, `views { face, front, threeQuarter, fullBody, mainOutfit } → assetIds`, `status: generating|ready|revision_needed|approved_superseded`, `pdfAssetId`, provenance. Approval target (FR-030–033).

### projects
`customerId`, `familyId`, `title`, `status` (see state-machines.md), `priority`, `paused: bool`,
`storyConfig`: `mainChildId`, `participants[] { characterId, narrativeRole, projectLookOverride? { lookId | inlineOverride } }`, `occasion`, `dedicationText`, `storyType`, `templateId + templateVersionId`, `pageCount: 16|24`, `tone`, `illustrationStyle`, `hiddenGoal { goal, presentation: indirect|acknowledged_ending } | null`, `clothingNotes`, `customNotes`, `readingLevel`, `narrationDialogueBalance` (suggested + operator-edited),
`bookVersion` (monotonic; bumps on any customer-visible change — drives FR-086),
`printerProfileId?`.
`projectLookOverride` implements FR-014(a) without mutating shared looks.

### storyTemplates *(versioned)*
`name`, `status: active|archived|disabled`, `TemplateVersion: { premise, structure[], environments[], roleSlots[] { slot, requiredRelationship?, narrativeRole }, variables[] { key, type, default }, possibleHiddenGoals[], sceneGuidance[], ageAdaptationRules[], contentBoundaries[], endingPatterns[] }`. Template edits append versions; stories pin `templateVersionId` (FR-050–052). Seven seed templates installed at first run (FR-053).

### stories *(versioned)*
`projectId`, `StoryVersion: { planJson (validated StoryPlan schema), fullText, sceneIds[] }`. Regenerating story appends version; scenes/pages pin `storyVersionId`.

### scenes *(versioned)*
`projectId`, `pageNumber`, `SceneVersion: { purpose, description, mentions[] (see below), environment, timeOfDay, composition, cameraFraming, narrativeText, dialogue[] { speakerCharacterId, text }, imagePromptDraft }`.
**Mention** (embedded): `{ characterId, characterVersionId (resolved at compile), displayName, props { action, emotion, position, framing, lookId?, heldObject?, gazeTarget?, speaks: bool, dialogue? } }`. Group mentions stored as `{ groupKey }` and expanded at compile (FR-038). Unresolved paste/partial tokens stored as `{ unresolvedText }` flagged in UI (FR-040).

### pages *(versioned lineage per FR-059)*
`projectId`, `pageNumber`, `kind: title|dedication|story|ending1|ending2`,
`locked: bool`, `reviewStatus: unreviewed|flagged|approved`, `staleReason?` (from invalidation),
`currentIllustrationVersionId`, `currentLayoutVersionId`.
`IllustrationVersion`: `assetId`, `promptCompiled`, `negativeConstraints[]`, `inputSnapshot { sceneVersionId, characterVersionIds[], lookVersionIds[], styleId, settingsHash }`, `provenance`, `supersededBy?`.
`LayoutVersion`: `placement: auto|top|bottom|right|left`, `resolvedRegion`, `readabilityAid: none|gradient|panel`, `fontSizePt`, `overflow: bool`, `bubbles[]`.
Commit precondition: job's `inputSnapshot` must match current lineage else reject (FR-065).

### jobs *(scheduler-owned — full semantics in contracts/job-scheduler-contract.md)*
`type`, `projectId`, `dependsOn[]`, `state`, `priority`, `idempotencyKey` (unique), `lease { workerId, expiresAtMono }`, `attempts`, `failure { category, message, providerRaw? (redacted) }`, `progress { pct, note }`, `pauseReason?`, `inputRefs { entity ids + versionIds }`, `provenance`, `resultRefs[]`.

### assets
`sha256` (unique), `mime`, `bytes`, `width/height/dpi?`, `role: reference_photo|sheet_view|illustration|pdf_preview|pdf_interior|pdf_cover|thumbnail|import_staging`, `origin: upload|generated|derived`, `provenance { provider, model, at, jobId, inputVersionRefs, promptVersion, referencedAssetIds[], attempt, settingsSnapshot }` (FR-094), `exifStripped: bool`, `refCount`.

`settingsSnapshot` is a strict, versioned, secret-free generation-settings record: a required SHA-256 `settingsHash` plus only explicitly modeled controls such as quality mode, style ID, reference budget, economy-tier state, and output dimensions. Provider response payloads, arbitrary nested values, credentials, prompt/image bytes, and runtime tokens are invalid. Generated assets require provenance; stored reference photos require `exifStripped: true`. Because `sha256` is globally unique while role/origin/provenance are singular, a same-byte put may increment `refCount` only when canonical metadata is identical; conflicting metadata fails explicitly instead of discarding traceability.
File at `assets/<sha256[0:2]>/<sha256>.<ext>`; write path per R4.

The data root itself is application-owned only after a valid `.hekayati-data-root.json` marker is created in an empty root. Reusing a non-empty unmarked root is invalid; managed child paths cannot be symlinks. Orphan collection recognizes only Hekayati temporary names and canonical content-addressed filenames.

### approvals
`kind: character|book`, `targetId`, `targetVersionId` (characterSheet version or project bookVersion), `state: preview_sent|approved|changes_requested|invalidated|superseded`, `notes`, `affectedPages[]`, `recordedAt`, `invalidatedBy? { changeType, refId, at }` (FR-085–087).

### printerProfiles
`name`, `trim { w,h }` (default A4), `bleedMm` (default 3), `safeMarginMm`, `dpiMin` (default 300), `colorMode: rgb|cmyk`, `iccProfilePath?`, `cropMarks: bool`, `spineWidthMm?`, `coverTemplate? { source, geometry }`, `requiredBlankPages?`. Spine unknown + no template ⇒ cover production blocked (FR-122).

### exports
`projectId`, `manifestVersion`, `filePath`, `checksum`, `createdAt`, `secretScan: passed|failed`, `pausedSnapshot: true` (C-07).

### settings (single doc)
`textProvider`, `imageProvider`, `models { codexText, geminiText, geminiImage, geminiImageEconomy }`, `concurrencyPerProvider`, `typography { minimumAge3To5Pt, minimumAge6PlusPt }`, `watermarkText`, `diskWarnGb`, `storagePathsReadonly`, `firstRunAcknowledged`, `deferredStatus { providerLifecycle, printerProfiles }`. **No secrets** (FR-137); Gemini key only in Keychain (FR-105). The repository's shared secret registry rejects known credential patterns and registered exact runtime secrets in every field before persistence, including otherwise-valid model and watermark strings.

Settings delivery is staged: Phase 1 owns this validated document and foundation-safe fields; provider credential/capability semantics are completed by feature 005, and `printerProfiles` management by feature 009. A field whose owning subsystem is not delivered reports `not_configured`/`not_available`; it is never fabricated as healthy (FR-137/138).

### runtime local-HTTP trust state *(not a collection)*

`canonicalOrigin = http://127.0.0.1:<verifiedBoundPort>` and a cryptographically random `csrfToken` exist only in process memory. The token rotates on every app start, is exposed only through a non-cacheable same-origin app bootstrap, and is compared on every unsafe request. Neither value is stored as a document, written to logs, included in exports, or accepted from forwarded-host headers (FR-147, FR-148). Health may expose the verified bind address and pass/fail state, never the token.

### studioGenerations
Standalone Single Image Studio records (FR-140–146). Not owned by a Project.
`id`, `customerId?`, `familyId?`, `prompt`, `negativeConstraints?`, `styleId`, `participants[] { characterId, characterVersionId, lookId?, lookVersionId? }`, `jobId`, `state`, `assetId?`, `priorAssetIds[]` (history), `provenance`, `createdAt`, `updatedAt`.
Constraints: all participants MUST share the same family when present (FR-146); `projectId` is always null; asset role `illustration` with provenance `origin: generated` and job type `studio_image`.

### auditEvents
Append-only operator-visible history: provider switches, quota decisions (FR-096), approvals/invalidations, deletions, imports/exports, studio generations. Supports SC-009/SC-010/SC-013 audits.

## Relationship summary

```text
Customer 1─n Family 1─n Character 1─n Look
Character 1─n CharacterVersion ; Look 1─n LookVersion
Project n─1 Family ; Project 1─n Page 1─n IllustrationVersion/LayoutVersion
Project 1─1 Story 1─n StoryVersion 1─n Scene(Version)
Project 1─n Job (DAG via dependsOn) ; Job n─n Asset (via resultRefs/provenance)
StudioGeneration n─0..1 Family ; StudioGeneration 1─1 Job (type studio_image, no projectId)
Approval → target version ; Template 1─n TemplateVersion ← Project pins one
```

## Versioning & invalidation hooks

- Any write that bumps a version emits a `ChangeEvent { entity, fromVersion, toVersion, changeType }` consumed by the invalidation engine, which applies `invalidation-matrix.md` rows and writes `staleReason` flags + approval invalidations. Locked pages receive flags only (FR-064).
- `bookVersion` increments on: page text/illustration/layout change, page order/count change, dedication/title/cover change — the customer-visible set of FR-086.

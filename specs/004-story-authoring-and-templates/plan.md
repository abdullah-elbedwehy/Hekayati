# Implementation Plan: Story Authoring and Templates

**Feature**: `004-story-authoring-and-templates`

**Spec**: [spec.md](spec.md)

**Canonical plan**: [integrated plan](../001-hekayati-product-bible/plan.md)

**Tasks**: T-P3-01–09

## Technical context

Use the implemented Node 22+ / TypeScript / Fastify / React / zod / SQLite-document stack. Keep the existing single-process, loopback-only runtime and `DocumentStore`; no new database, state framework, editor framework, provider SDK, or network endpoint is needed. All collections remain validated JSON documents. New source files stay focused (≤800 lines; functions ≤50 lines where practical).

Testing remains Vitest for domain/integration and Playwright for operator journeys. Automated fixtures use synthetic Arabic names and generated local thumbnails only. Every test run is provider-free.

## Source layout

```text
src/domain/authoring/
  balance.ts                 # formula v1 and operator override behavior
  book-structure.ts          # page map and guarded count-change plans
  compile.ts                 # provider-neutral participant resolution
  errors.ts                  # stable slice codes
  extraction.ts              # template/story privacy transforms
  mentions.ts                # normalization, segments, groups, removal plan
  project-service.ts         # project/version/story/scene transactions
  repositories.ts            # strict collection adapters
  schemas.ts                 # all persisted and command schemas
  seed-templates.ts          # validated seven-template data
  template-service.ts        # lifecycle, pin reads, extraction, seed install
  types.ts                   # command/DTO types inferred from schemas
src/server/routes/authoring-api.ts
src/server/startup/seed-templates.ts
src/ui/views/ProjectsView.tsx
src/ui/components/authoring/
  ProjectRail.tsx
  StoryConfigurationForm.tsx
  CharacterRolePicker.tsx
  AppearanceSelector.tsx
  SceneEditor.tsx
  MentionPicker.tsx
  MentionProperties.tsx
  PageMap.tsx
  PageCountDialog.tsx
  TemplateLibrary.tsx
src/ui/authoring.css
tests/unit/authoring-*.test.ts
tests/integration/authoring-*.test.ts
tests/e2e/authoring.spec.ts
```

If splitting a component or service keeps files/functions within the repository guard, preserve these domain boundaries rather than the exact filenames.

## Persistence model

Add strict repositories for:

- `projects`, `project_versions`;
- `project_character_overrides`, `project_character_override_versions`;
- `story_templates`, `story_template_versions`;
- `stories`, `story_versions`;
- `scenes`, `scene_versions`.

Each identity has `currentVersionId`; every version has `previousVersionId` where applicable. ULIDs and UTC ISO timestamps follow the library conventions. No update may replace a version document. Identity head updates use an explicit expected version checked inside the same SQLite transaction as version insertion and outbox insertion.

The project status schema mirrors the canonical state machine, though feature 004 creates and edits only `draft` projects. The later pipeline may advance status without migrating the identity shape.

## Invariants and transaction boundaries

### Project create/edit

1. Parse the command with strict zod schemas.
2. Resolve customer/family with the shared 003 family scope.
3. Require active customer/family and C-21 active anchor for a new project.
4. Resolve every participant and selected look/override through the same family; require active selection for new pins; pin current immutable version IDs server-side.
5. Require `mainChildId` to be one selected non-pet participant.
6. Validate template/custom-story discriminants and calculate balance formula v1.
7. In one transaction, insert identity + first version, or compare expected head + insert next version + advance head.

A stale head, cross-family reference, malformed union, or missing relation produces zero writes.

### Project-only override

In one transaction: resolve the project participant and optional owned look; compare project and override heads; append the override version; insert/update override identity; append a new project version whose participant points to that override version; insert exactly one `changeEvent` with `entity=project_override`, `changeType=project_look_override`, `matrixRow=IM-04`, and a shared correlation ID. Failures roll back all four effects. Character and look records are compared byte-for-byte in tests.

### Scene edit

Resolve the expected project/story/scene heads. Append one `SceneVersion`; advance the scene identity; append a `StoryVersion` containing the ordered current scene-version pins; advance story identity. Mark `complete` only when every page-map story slot has one valid, `needsAuthoring=false` scene. No provider data is synthesized.

### Template lifecycle

Create/edit/duplicate appends immutable content. Archive/restore/disable/enable updates only template identity lifecycle under expected head/status preconditions; pinned versions remain readable. Editing a template emits no story mutation (IM-16). Routine selectable list returns only active templates; management list returns all statuses.

### Seed install

The production installer replaces the deferred Phase-1 hook. For each stable seed key:

1. validate the complete static seed object;
2. query by `seedKey`;
3. if absent, create identity + version in one transaction;
4. if present in any status, do nothing.

The entire set installs in one outer transaction so first-start interruption yields either all seven or none. Stable keys and canonical Arabic copy are in [seed-templates.md](seed-templates.md).

## Deterministic algorithms

### Narration/dialogue suggestion, formula `hekayati.balance.v1`

Start with age-band narration percentage:

| Input | Delta/value |
|---|---:|
| age 3–5 | 75 |
| age 6–8 | 65 |
| age 9–12 | 55 |
| early reader | +10 |
| developing reader | 0 |
| independent reader | -10 |
| related situations | +5 |
| connected adventure | -5 |
| saved template / fully custom | 0 |
| 24 pages | -5 |
| 16 pages | 0 |
| low complexity | -5 |
| medium complexity | 0 |
| high complexity | +10 |

Clamp the integer result to 40–85. On initial creation, selected = suggested and `operatorEdited=false`. When driver inputs change, recompute suggested; update selected only while `operatorEdited=false`. A manual 0–100 selection sets `operatorEdited=true`; “restore suggestion” sets selected to current suggested and clears the flag. Store formula ID with both values.

### Arabic mention search

Search keys use `trim → collapse Unicode whitespace → NFC → remove Arabic tashkeel U+0610–061A/U+064B–065F/U+0670/U+06D6–06ED → locale-insensitive lowercase for Latin`. Storage retains original character names only in their CharacterVersion; mention segments retain IDs. Search never rewrites persisted names.

Keyboard picker order: current project participant order, then current display name for stable fallback. Duplicate visual labels add relationship + narrative role; no name is treated as identity.

### Group expansion

- `hero`: exactly the selected `mainChildId`.
- `friends`: selected participants whose pinned relationship is `friend`.
- `family`: selected participants whose pinned relationship is `main_child`, `father`, `mother`, `brother`, `sister`, `grandfather`, or `grandmother`.

Preserve project order and deduplicate by character ID. Teacher, pet, friend, and custom relations do not enter `family`. An empty result is a hard compile block.

### Compile and capacity

Compile walks ordered segments, validates mention membership/appearance ownership, expands groups, and builds the ordered unique participant set with per-occurrence properties. It returns reconciliation warnings when the selected set and concrete prose/mention set differ. Acknowledgements are explicit input and echoed in the result.

Capacity is `{ mode: mock_unlimited } | { mode: verified, modelId, reliableReferenceCount } | { mode: unavailable, modelId, reason }`. No numeric default exists. Exceeding a verified count requires an explicit acknowledgement; unavailable blocks. Compile never calls feature 005.

### Page map

| Interior count | Title | Dedication | Story pages / indexes | Farewell | Brand |
|---:|---:|---:|---|---:|---:|
| 16 | 1 | 2 | 3–14 / 1–12 | 15 | 16 |
| 24 | 1 | 2 | 3–22 / 1–20 | 23 | 24 |

Page-map hashing uses canonical JSON with sorted object keys and SHA-256. Covers and printer blanks are structurally excluded.

For a page-count preflight, let `S` be source story slots and `T` target story slots. Map each existing source index `i` to `1 + round((i - 1) * (T - 1) / (S - 1))`:

- expansion yields retained targets plus explicit empty `add` targets;
- shortening groups adjacent sources mapped to one target as `merge` candidates;
- the operator may change a source within a merge to explicit `remove`, but every source ID must appear exactly once and every target must be accounted for.

The plan records project/story heads, source scene-version IDs, operations, and hash. Confirmation re-resolves all inputs. Retained source versions are referenced, never edited. Add/merge targets become `needsAuthoring=true` draft scene versions carrying `sourceSceneVersionIds`; removed versions remain in prior story history. The new story cannot be complete until every draft is explicitly authored. No regeneration is scheduled.

## Template extraction and duplication

Extraction is allow-list based, not delete-list based. It may copy only premise/beat shape, environment categories, role slots, variable definitions, hidden-goal categories, scene guidance, age rules, content boundaries, and ending patterns. It cannot read/copy customer contact data, consent, reference photos/assets, character IDs/version IDs, display names/nicknames, mention segments, dedication, or custom notes.

After construction, recursively scan keys and string values against source IDs, source names/nicknames, WhatsApp, asset hashes/paths, and the shared secret registry. Any match fails closed and writes nothing.

Same-family story duplication may re-pin selected participants/looks after current scope validation. Cross-family duplication always creates a draft with role slots and no participant pins; required roles must be mapped through the target-family picker before readiness.

## API surface

Register under `/api/authoring` behind the existing local request boundary:

- project list/detail/create/version append;
- override create/version append;
- story/scene detail and scene append;
- mention picker/search/compile/removal preflight+resolution;
- page map and count-change preflight+confirm;
- template selectable/management list, CRUD-version/lifecycle, extraction, duplication;
- test-only inspection only under the existing `enableTestRoutes` guard.

Responses expose safe thumbnails through the existing projection route and never original/provider asset IDs. Mutation bodies include expected heads. Domain errors map to 409 for stale/resolution-required, 403 for scope, 422 for semantic validation, and 404 only when revealing existence is safe; foreign-scope IDs use the same non-disclosing scope response.

## Arabic RTL operator experience

Add `المشاريع والقصص` to the existing Citrus sidebar. Use the existing tokens, cards, status lines, focus rules, and logical CSS properties. The project workspace has four progressive panels: configuration, characters/looks, page map/scenes, templates. Incomplete states name the next action in simple MSA; story prose fields accept Egyptian Arabic.

The mention editor uses buttons/structured segments rather than relying on fragile `contenteditable` DOM mutation. `@` opens a keyboard listbox; tokens expose an adjacent properties action. Paste parsing recognizes valid selected-character labels only when unambiguous; everything else becomes visible unresolved text. No drag-only interaction is introduced.

The page-count dialog shows every add/retain/merge/remove row before enabling confirmation. Disabled/archived template status uses text + icon, not color alone.

## Test-first order

1. schemas/repository strictness and version conflict fixtures;
2. balance/page-map/hash/preflight unit tests;
3. mention normalization/edit/group/compile/removal unit tests;
4. project/override transaction rollback and family-scope integration tests;
5. template lifecycle/seed/extraction/privacy integration tests;
6. scene/story completion and restart integration tests;
7. API error/status and no-sensitive-projection tests;
8. UI behavior, keyboard/axe/responsive tests;
9. provider-free US3/US10 E2E with request capture and restart.

Coverage must retain the repository target (≥80% overall; no critical transaction branch untested). Add an isolated Node 22 clean-install/build smoke when native-module ABI differs in the active workspace.

## Verification commands

```bash
npm run check
npm run coverage
npm run build
npm run test:e2e
npm audit --audit-level=high
git diff --check
```

Record exact results, environment exceptions, screenshots, and remaining downstream deferrals in `IMPLEMENTATION_NOTES.md`.

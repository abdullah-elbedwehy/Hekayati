# Contract: Canonical Structured Output Schemas

**Feature**: `001-hekayati` | Normative for FR-091. All provider structured output MUST validate against these schemas (implemented as zod, mirrored to provider-side JSON Schema where supported) BEFORE persistence. Validation failure ⇒ `output_validation_failed`; unparseable ⇒ `malformed_output`. Nothing invalid is ever stored as product content (Constitution V).

Shared conventions: every top-level output carries `schemaVersion: 1`; all text fields are Egyptian Arabic unless marked; `characterRef` = `{ characterId, characterVersionId }` and MUST be one of the request's declared participants — any other value fails validation (FR-041: providers cannot invent people).

## 1. StoryPlan

Produced by: story planning task. Consumed by: story writing, scene decomposition.

```yaml
StoryPlan:
  schemaVersion: 1
  title: string (1..80)
  logline: string
  arc: [ { beat: string, purpose: string, pagesEstimate: int (1..4) } ]  # ordered
  settingSummary: string
  characterArcs: [ { characterRef, arcNote: string } ]
  hiddenGoalWeave: string | null        # how the goal shapes events WITHOUT preaching
  toneNotes: string
  pageBudget: { storyPages: int, mustEqual: config }   # validated == config story pages
constraints:
  - arc pagesEstimate sum == storyPages (hard fail otherwise)
  - every characterArcs.characterRef ∈ declared participants
  - no text implying blame/shaming labels (advisory flag → review, not hard fail)
```

## 2. StoryText

```yaml
StoryText:
  schemaVersion: 1
  pages: [ {
    pageNumber: int,
    narrative: string (word count within age-band budget ± 20%),
    dialogue: [ { speaker: characterRef, line: string } ]   # may be empty
  } ]
constraints:
  - pages.length == configured story pages (hard fail)
  - pageNumbers contiguous, unique
  - speakers ∈ participants
  - language: Egyptian Arabic; register/age flags produced as ReviewFindings, not schema failures
```

## 3. SceneList

```yaml
SceneList:
  schemaVersion: 1
  scenes: [ {
    pageNumber: int,
    purpose: string,
    description: string,                # visual, text-free description
    participants: [ characterRef ],     # subset of declared participants (hard fail otherwise)
    perCharacter: [ { characterRef, action, emotion, position?, framing?,
                      lookId?, heldObject?, gazeTarget?, speaks: bool } ],
    environment: string, timeOfDay: string,
    composition: string, cameraFraming: string,
    twoImageMoment: bool                # default false; true requires operator confirmation (FR-060)
  } ]
constraints:
  - one scene per story page; pageNumbers match StoryText
  - participants non-empty unless scene is explicitly characterless (allowed: establishing shots)
  - lookId ∈ character's available looks or project overrides
```

## 4. PagePrompt

Produced by prompt-generation task per page; consumed by image generation.

```yaml
PagePrompt:
  schemaVersion: 1
  pageNumber: int
  prompt: string                        # style-directed, identity-anchored, NO story text request
  negativeConstraints: [ string ]       # MUST include: extra-person ban, in-image-text ban,
                                        # onomatopoeia ban, photo-real-face ban (FR-041/060/072/073)
  referencePlan: [ { characterRef, useSheetViews: [face|front|threeQuarter|fullBody|mainOutfit] } ]
constraints:
  - referencePlan characters == scene participants (hard fail)
  - prompt MUST NOT contain: living-artist names, franchise/trademark names (deny-list check, FR-071)
  - prompt MUST NOT embed the narrative text
```

## 5. ReviewFindings

Produced by: AI content review pass (advisory — human review remains the gate, FR-117).

```yaml
ReviewFindings:
  schemaVersion: 1
  findings: [ {
    scope: story|page|character,
    refId: string, pageNumber?: int,
    category: register_drift | slang_excess | trend_vocab | shaming | lecture |
              age_inappropriate | fear_excess | safety | copyright_similarity |
              contact_details | inconsistency | other,
    severity: info|warn|block,
    excerpt: string, note: string
  } ]
constraints:
  - `block` findings prevent marking the internal-review job complete until operator acknowledges
  - findings are advisory annotations; they never mutate content
```

## Validation pipeline (all schemas)

1. Parse JSON (fail → `malformed_output`). Raw prompt/output bodies are not logged or persisted for diagnosis. Retain only a SHA-256 fingerprint, byte count, top-level JSON type/keys when parseable, and a bounded provider diagnostic after shared redaction.
2. zod schema validate (fail → `output_validation_failed`, first 10 path/code issues recorded without rejected field values).
3. Domain cross-checks (participant membership, page-count equality, look existence, deny-lists).
4. Persist as new version documents; emit ChangeEvents for invalidation engine.

Schema evolution: each schema carries `schemaVersion`; bumping requires a spec amendment and a migration note here. Adapters advertise which schemaVersion they compile prompts for.

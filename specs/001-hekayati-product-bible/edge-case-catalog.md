# Edge-Case Catalog

**Feature**: `001-hekayati` | Every material case maps to a requirement (FR/SC), a matrix row (IM), a contract section, and/or a task. Behavior column is normative. Tasks reference these IDs (e.g., EC-A07).

## A — Character & identity

| ID     | Case                                                       | Defined behavior                                                                             | Refs                          |
| ------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------- |
| EC-A01 | No photo                                                   | Description-only mode fully supported; sheet generated from description                      | FR-010                        |
| EC-A02 | One photo only                                             | Allowed; intake requires the face subject box where applicable and shows recommended-input checklist + "limited references" warning | FR-023/024 |
| EC-A03 | Conflicting photos (hair/clothes/age differ)               | Non-blocking warning listing the specific conflict; operator picks canonical refs            | FR-023                        |
| EC-A04 | Two people in one photo                                    | Runtime staging may preview a safe thumbnail, but commit is blocked until the intended person is explicitly marked; only the crop becomes provider-eligible | FR-024/025 |
| EC-A05 | Identical names                                            | Picker disambiguates by thumbnail + relationship; IDs distinct                               | FR-036, E6                    |
| EC-A06 | Character renamed                                          | Mentions re-render new name; references intact (ID-bound)                                    | FR-035, FR-039, IM-05         |
| EC-A07 | Character removed from a project while referenced          | Blocked; affected-scenes list; resolve = replace / remove mentions / cancel                  | FR-039                        |
| EC-A08 | Character archived but used by old project                 | Old project keeps pinned versions with archived indicator; character hidden from new pickers; no invalidation | FR-018, IM-21 |
| EC-A09 | More characters than image model supports                  | Compile-time warning at C-08 threshold; proceed needs confirmation; reference budgeting note | FR-075, capability matrix §4  |
| EC-A10 | Pet confused with another pet                              | Pets are full characters with own refs/sheet; review checklist covers duplication            | FR-010, FR-118                |
| EC-A11 | Wrong age/gender/skin tone/clothing/relationship in output | Review checklist items; regenerate page or fix profile (versioned paths differ)              | FR-118, IM-01/04              |
| EC-A12 | Character appears in scene where not selected              | Negative constraints at prompt level + review checklist "no invented person"                 | FR-041, FR-118                |
| EC-A13 | Character absent despite required                          | SceneList validation: participants must match; review checklist count check                  | structured-outputs §3, FR-118 |
| EC-A14 | Face drifts between pages                                  | Consistency view (sheet vs page crops); page-level regeneration                              | FR-119, FR-063                |
| EC-A15 | Two characters' faces swapped                              | Review checklist "no identity swap"; regenerate affected page                                | FR-118                        |
| EC-A16 | Mention props conflict with profile (e.g., look not owned) | SceneList validation fails: lookId must exist                                                | structured-outputs §3         |
| EC-A17 | Possible duplicate person in a family                      | Family-local advisory offers open-existing/create-separate; duplicate names remain valid; no biometric match, auto-merge, or cross-family disclosure | FR-019, C-19 |

## B — Story

| ID     | Case                                           | Defined behavior                                                                            | Refs                          |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------- |
| EC-B01 | Wrong page count from provider                 | StoryText schema hard-fails (pages.length mismatch) → retry policy                          | structured-outputs §2, FR-092 |
| EC-B02 | Story too long for layout                      | Per-page word budget ±20% in schema; overflow handled by layout chain, never silent shrink  | structured-outputs §2, FR-082 |
| EC-B03 | Story too short                                | Same budget floor; validation flags                                                         | structured-outputs §2         |
| EC-B04 | Repetitive scenes                              | ReviewFindings category `inconsistency`; operator regenerates plan/story scope              | structured-outputs §5         |
| EC-B05 | Contradictory character behavior               | ReviewFindings `inconsistency`                                                              | structured-outputs §5         |
| EC-B06 | Egyptian Arabic drifts to formal MSA mid-story | ReviewFindings `register_drift`; regenerate affected text only                              | FR-047                        |
| EC-B07 | Dialect too slang-heavy / trend vocab          | ReviewFindings `slang_excess` / `trend_vocab`                                               | FR-047                        |
| EC-B08 | Hidden goal becomes preachy                    | ReviewFindings `lecture`; blocked from completion until acknowledged                        | FR-048, structured-outputs §5 |
| EC-B09 | Unsafe scene                                   | `safety` finding severity block + safety refusal path; no auto prompt-variation retries     | FR-115/116                    |
| EC-B10 | Famous copyrighted character requested         | Transformed to original concept, shown for confirmation; deny-list in PagePrompt validation | FR-071, structured-outputs §4 |
| EC-B11 | Template changed after story generated         | Story pinned to old template version; no effect                                             | FR-052, IM-16                 |
| EC-B12 | Custom story with insufficient details         | Draft saves, but readiness/plan dispatch fails `CUSTOM_STORY_INCOMPLETE`/`invalid_input` with every missing C-23 field; no vague generation | FR-092, C-23 |
| EC-B13 | Partial/malformed structured output            | `malformed_output`/`output_validation_failed` + bounded retries, then pause with structural diagnostics only; raw body/rejected values never persist | FR-092, CHK108, scheduler §taxonomy |

## C — Pages & versions

| ID     | Case                                                   | Defined behavior                                                            | Refs                       |
| ------ | ------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------- |
| EC-C01 | Regeneration result arrives after newer version exists | Commit precondition rejects; logged `stale_commit_rejected`                 | FR-065, scheduler §commit  |
| EC-C02 | Upstream story edited after illustrations exist        | Matrix IM-08: affected pages stale-flagged; operator chooses scope          | IM-08                      |
| EC-C03 | Punctuation-only edit                                  | Layout ✖, approval ✖, illustrations untouched                               | IM-07, US6-AS4             |
| EC-C04 | Permanent appearance change                            | IM-01 cascade; nothing auto-regenerates                                     | FR-033                     |
| EC-C05 | Locked page has invalid dependency                     | `locked_stale` flag; content frozen until unlock                            | FR-064                     |
| EC-C06 | Cancel during regeneration, provider still returns     | Late result discarded via commit protocol                                   | US5-AS3, scheduler §cancel |
| EC-C07 | Image file deleted manually outside app                | Foundation scan reports asset ID + reason without mutation; a regeneration offer appears only when its owning artifact workflow exists; never auto-regenerates | FR-097, IM-20, T-P10-02 |
| EC-C08 | Text placement fails everywhere                        | Preset chain → gradient/panel → operator warning; min font floor respected  | FR-082                     |
| EC-C09 | Dialogue doesn't fit bubble                            | Layout overflow flag; operator shortens or repositions                      | FR-083                     |
| EC-C10 | No safe text area                                      | Same FR-082 chain terminal warning                                          | FR-082                     |
| EC-C11 | Studio generate while book jobs run                    | Both allowed; studio job has no `projectId`; book pages/approvals unchanged | FR-142/145, SC-013         |
| EC-C12 | Studio with cross-family characters                    | Blocked before enqueue (same as FR-003/146)                                 | FR-146, EC-H02             |
| EC-C13 | Studio without characters (prompt-only)                | Allowed; provenance records zero refs; safety/style rules still apply       | FR-141/143                 |
| EC-C14 | Old/stale preview approved from another tab            | Exact preview/bundle/revision CAS rejects with zero state change; current ready output remains unchanged | FR-085/086, C-26 |
| EC-C15 | Watermark changes after customer approval              | IM-19 marks that exact preview stale and cancels its gate only if still waiting; the separate prior content-approval head/hash and project approved/print-ready state survive. A replacement preview gets a new cycle and cannot borrow the action | IM-19, C-26 |
| EC-C16 | App dies during preview render or after file prepare    | Durable local job resumes; uncommitted temp/renamed orphan is compensated; exactly one validated PreviewOutput/asset may become current | FR-093/113/120 |
| EC-C17 | Dialogue speaker position is missing/ambiguous          | A speaker-labeled non-pointing RTL bubble/panel plus warning is used; no pointer is guessed | FR-083 |
| EC-C18 | Reviewed page is locked before first layout             | Initial layout derives into a separate downstream head without changing Page/creative heads; any replacement/recalculation requires explicit unlock | FR-064/080, Constitution X |
| EC-C19 | Printer trim conflicts with approved composition profile | Print production hard-blocks and offers explicit composition migration/new approval; it cannot apply IM-14 or silently reflow | FR-087/121, C-27 |
| EC-C20 | Untrusted text contains markup, remote URLs, or bidi controls | Text is escaped and bidi-isolated under the layout policy; renderer blocks HTTP(S)/file/CDN loads and scripts, records zero external requests, and exposes a safe warning for prohibited controls | FR-080/083/132 |

## D — AI providers

| ID     | Case                                             | Defined behavior                                                                               | Refs                     |
| ------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------ |
| EC-D01 | Codex not installed                              | Capabilities → unavailable("not installed") + remediation; no fallback                         | FR-103, US8-AS4          |
| EC-D02 | Codex logged out                                 | `invalid_credentials` pause + settings guidance                                                | FR-103                   |
| EC-D03 | Codex subscription exhausted                     | Provider-wide quota incident; per-scope wait vs explicit Gemini successor choice; no Settings mutation | FR-096, E5          |
| EC-D04 | Codex structured output invalid                  | Bounded retries then pause with privacy-safe structural diagnostics only                       | FR-092, CHK108           |
| EC-D05 | Codex image capability unavailable               | Permanent capability notice per gate G1-I record                                               | FR-102, R6               |
| EC-D06 | Gemini key missing/invalid                       | `invalid_credentials`; masked settings flow to fix                                             | FR-105/106               |
| EC-D07 | Gemini model deprecated/renamed                  | `provider_unavailable` with model detail; configurable ID update; never substitute             | FR-098, FR-107           |
| EC-D08 | Configured model not available to account        | Same as EC-D07 (probe fails)                                                                   | FR-098                   |
| EC-D09 | Rate limit                                       | At most three delayed retries honoring bounded Retry-After, else 15s/1m/5m; then explicit pause | scheduler §taxonomy      |
| EC-D10 | Safety refusal                                   | No auto-variation retries; step+page identified; work preserved                                | FR-116                   |
| EC-D11 | Network loss mid-batch                           | `network_failure` retries; completed commits durable                                           | FR-113                   |
| EC-D12 | Provider timeout                                 | `timeout` retry ×2 then pause                                                                  | scheduler §taxonomy      |
| EC-D13 | Text-but-no-image response                       | `malformed_output`                                                                             | provider-contract §image |
| EC-D14 | Image with incomplete metadata                   | Accept image; synthesize provenance from request side; flag providerMeta missing               | provider-contract        |
| EC-D15 | Multiple unexpected images                       | Default `malformed_output` unless adapter marks unambiguous-first                              | provider-contract §image |
| EC-D16 | Provider switch mid-project                      | Confirmed global Settings impact creates exact-target successors for unstarted remaining work; running/completed provenance stays | FR-095/096 |
| EC-D17 | New provider supports fewer reference characters | Capability re-check before batch; C-08 warning re-evaluated per new matrix values              | FR-075, FR-098           |
| EC-D18 | Economy mode visible quality drop                | Persistent FR-108 warning; review gate catches; regenerate on default model as explicit choice | FR-108                   |

## E — Queue & storage

| ID     | Case                                         | Defined behavior                                                                            | Refs                        |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------- |
| EC-E01 | App restart / worker crash / machine restart | Lease expiry by bootId; re-queue; completed work durable                                    | scheduler §recovery, SC-002 |
| EC-E02 | Database unavailable                         | Workers halt (`database_unavailable`); startup recovery                                     | scheduler §taxonomy         |
| EC-E03 | Duplicate job delivery                       | Idempotency-key unique index returns existing job                                           | scheduler §idempotency      |
| EC-E04 | Project deleted while jobs run               | Force-cancel first; commit preconditions guard stragglers                                   | scheduler §cancel           |
| EC-E05 | System clock changes                         | Monotonic (bootId, monotonicMs) lease arithmetic — wall clock irrelevant                    | scheduler §leases           |
| EC-E06 | Long job with no progress events             | "No progress" flag after stallThreshold; operator may cancel; never auto-kill               | scheduler §leases           |
| EC-E07 | Disk full                                    | `insufficient_disk_space` pauses ALL jobs + health alert; atomic writes prevent torn assets | FR-093, FR-138              |
| EC-E08 | Stale job lease + old worker completes       | Commit rejected (lease mismatch)                                                            | scheduler §commit           |
| EC-E09 | Partial file write                           | Temp+fsync+rename: partial files are invisible orphans, GC-swept                            | FR-093, R4                  |
| EC-E10 | Retry creates duplicate asset                | Content addressing dedups identical bytes; commit protocol dedups records                   | R4, FR-093                  |
| EC-E11 | Export while jobs run                        | Requires one-click pause first (C-07)                                                       | FR-129                      |
| EC-E12 | Multiple jobs write same page                | Idempotency scope + single-writer commit per page lineage                                   | scheduler §commit           |
| EC-E13 | File permissions failure                     | `disk_write_failure` pause-all + health surface                                             | scheduler §taxonomy, FR-130 |

## F — PDF & print

| ID     | Case                                        | Defined behavior                                                                                                         | Refs            |
| ------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------- |
| EC-F01 | Incorrect page dimensions                   | Preflight blocks with measured vs expected                                                                               | FR-123          |
| EC-F02 | Low-resolution image                        | Effective-DPI preflight rule blocks                                                                                      | FR-123          |
| EC-F03 | Missing bleed                               | Preflight blocks                                                                                                         | FR-123          |
| EC-F04 | Unknown spine width                         | Cover production blocked pre-render                                                                                      | FR-122, US7-AS2 |
| EC-F05 | Printer template changed                    | IM-15: cover re-produced + re-preflighted                                                                                | IM-15           |
| EC-F06 | Font not embedded                           | Preflight font-embedding check blocks                                                                                    | FR-123, SC-008  |
| EC-F07 | Arabic letters disconnected                 | Golden-file shaping tests (gate G3); preflight visual spot-check corpus                                                  | SC-008, R9      |
| EC-F08 | RTL order incorrect                         | Same G3 golden tests                                                                                                     | SC-008          |
| EC-F09 | CMYK conversion damages colors              | Conversion is explicit + re-preflighted; operator visually approves converted proof page                                 | FR-123, R10     |
| EC-F10 | Cover spread orientation reversed           | Preflight spread-geometry rule (back-left, spine-center, front-right for RTL-bound book — geometry from printer profile) | FR-123          |
| EC-F11 | Preview watermark missing                   | Preflight preview rule blocks send-marking                                                                               | FR-124          |
| EC-F12 | Preview uses print-res assets / huge file   | Preview pipeline downsamples (C-06); size budget check ≤16 MB                                                            | SC-007          |
| EC-F13 | Final PDF still contains watermark          | Preflight print rule blocks delivery                                                                                     | FR-124          |
| EC-F14 | A4 page count differs from approved preview | Preflight compares against approved bookVersion page map                                                                 | FR-123, SC-010  |

## G — Import/export

| ID     | Case                                          | Defined behavior                                                                                      | Refs            |
| ------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------- |
| EC-G01 | Corrupt archive                               | Rejected at validation, nothing written                                                               | FR-128          |
| EC-G02 | Missing manifest / missing files              | Rejected with specific missing entries                                                                | FR-128          |
| EC-G03 | Unsupported future manifest version           | Rejected with "created by newer version" message                                                      | FR-128          |
| EC-G04 | Older supported manifest version              | Migrated during staging                                                                               | FR-128          |
| EC-G05 | Checksum mismatch                             | Rejected naming the file                                                                              | FR-128          |
| EC-G06 | Duplicate project/character/asset IDs         | Conflict rules: as-new → remap IDs; replace → explicit confirmation                                   | FR-127/128      |
| EC-G07 | Conflicting customer                          | Operator maps to existing or creates new                                                              | FR-127          |
| EC-G08 | Partial import / interruption                 | Staged-then-committed; rollback deletes staging                                                       | FR-128, US9-AS4 |
| EC-G09 | Insufficient disk space                       | Pre-checked before staging                                                                            | FR-128          |
| EC-G10 | Malicious paths / symlinks / executables      | Entry-name validation + content sniff rejects pre-write                                               | FR-128, R11     |
| EC-G11 | Secret accidentally included                  | Export-time automated secret-scan fails the archive                                                   | FR-126, SC-005  |
| EC-G12 | Customer data duplicated on import            | Same as EC-G07 mapping flow                                                                           | FR-127          |
| EC-G13 | Template import references missing characters | Templates are parameterized (role slots) — no character refs to break; legacy refs stripped at export | FR-050/051      |

## H — Privacy & operations

| ID     | Case                                               | Defined behavior                                                                         | Refs           |
| ------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------- |
| EC-H01 | Consent missing                                    | Generation blocked with reason; data entry still allowed                                 | FR-004         |
| EC-H02 | Wrong family selected                              | Cross-family character selection structurally blocked                                    | FR-003         |
| EC-H03 | Customer asks for deletion                         | Permanent delete flow with pre-report + media removal                                    | FR-005         |
| EC-H04 | Deleting reusable character used in older projects | Pre-report lists projects; operator resolves per project (keep pinned copies vs cascade) | FR-005, EC-A08 |
| EC-H05 | Sensitive data in logs                             | Redaction layer + automated log-scan tests                                               | FR-131, SC-005 |
| EC-H06 | App exposed on LAN                                 | Startup bind verification refuses non-loopback                                           | FR-110         |
| EC-H07 | No backup + disk fails                             | Explicit no-backup warning (first run + export screen); accepted risk RR-06              | FR-133         |
| EC-H08 | Operator assumes export = backup                   | Export screen copy states "not a backup" explicitly                                      | FR-133         |
| EC-H09 | DNS-rebinding or alternate `Host` reaches loopback | Exact canonical `127.0.0.1:<port>` authority check rejects before routing; forwarded-host headers are ignored | FR-147, SC-014 |
| EC-H10 | Public page sends CORS/PNA preflight               | Preflight rejected; no CORS credentials/origin or Private Network Access opt-in headers are emitted | FR-148, SC-014 |
| EC-H11 | Cross-origin or opaque-origin API request          | Any present non-canonical/`null` `Origin` is rejected before route dispatch               | FR-148, SC-014 |
| EC-H12 | Forged state change lacks trusted source or token  | Missing/bad `Origin` (or exact `Referer` fallback) or CSRF token rejects with zero mutation | FR-148, SC-014 |
| EC-H13 | App restarts while an old browser tab remains open | Old CSRF token fails closed; reloading the canonical app obtains a new token; persisted product state is unchanged | FR-148, SC-014 |
| EC-H14 | Consent revoked after photo-bearing work is queued  | Immediate pre-dispatch current-consent check blocks direct-photo and photo-derived-sheet work without a network call; local records and completed artifacts remain intact; wholly description-derived work is unaffected | FR-004 |

# Verification Checklist: 007 Creative Generation and Review

**Status**: IMPLEMENTED — checkpoint evidence recorded in `IMPLEMENTATION_NOTES.md`

**Canonical checklists**: [AI reliability](../001-hekayati-product-bible/checklists/ai-reliability.md) · [product acceptance](../001-hekayati-product-bible/checklists/product-acceptance.md) · [privacy/security](../001-hekayati-product-bible/checklists/privacy-security.md) · [Arabic RTL UX](../001-hekayati-product-bible/checklists/ux-arabic-rtl.md)

## Model and persistence

- [x] 007-C01 Strict sheet/run/page/version/review/approval/audit schemas reject unknown keys, foreign scope IDs, mutable content replacement, raw provider payloads, bytes, paths, and secret-like values.
- [x] 007-C02 Base appearance uses no fabricated look ID; shared look requires exact owned look/version; project override remains page/project scoped.
- [x] 007-C03 Generated output appends immutable 004 story/scene versions and immutable creative versions; prior manual/generated content remains readable.
- [x] 007-C04 Page/sheet commits recheck exact current snapshots and reject stale, canceled, superseded, or locked targets before product/asset head changes.
- [x] 007-C05 Every generated asset has exact job/provider/model/time/input/prompt/reference/settings provenance; no raw response or credential persists.

## Character sheets and approvals

- [x] 007-C06 Five independent view jobs produce face/front/three-quarter/full-body/main-outfit assets bound to exact character/appearance inputs.
- [x] 007-C07 Local finalizer requires all five current results, includes derived thumbnails and Arabic name, prepares compact PDF, and commits one ready sheet atomically.
- [x] 007-C08 Sheet PDF passes mechanical page/media/text checks and rendered Arabic/visual inspection with synthetic assets.
- [x] 007-C09 Approval/change-request actions are owner-gated, version/revision checked, persist notes, and never expose an approval action in the queue.
- [x] 007-C10 Permanent appearance/look change supersedes only applicable sheet approvals, lists exact affected pages/artifacts, and starts no generation.
- [x] 007-C11 ApprovedSheetLineageReader proves identity/version/asset/lineage; photo-derived sheets require current consent and description-only sheets retain zero-photo exception.

## Pipeline and jobs

- [x] 007-C12 Complete CreativeRun manifest exists before first dispatch; materialized jobs and logical edges remain inspectable across restart.
- [x] 007-C13 Each successor canonical request is compiled only from validated predecessor product output and created atomically with predecessor commit.
- [x] 007-C14 Story plan → text → scenes → per-page prompts → independent illustrations → findings → review gate follows exact dependency order.
- [x] 007-C15 Strict StoryPlan/StoryText/SceneList/PagePrompt/ReviewFindings validation and domain cross-checks happen before persistence; rejected bodies are absent from DB/logs.
- [x] 007-C16 Mock 16-page book creates exactly 12 story-page prompt/image branches; one branch failure does not block successful siblings.
- [x] 007-C17 Real process kill/restart resumes unfinished work without duplicate provider intent, asset refcount, version, event, or successor job.
- [x] 007-C18 Safety refusal performs zero automatic retries, surfaces safe exact stage/page context, and requires an explicit edited successor intent.
- [x] 007-C19 Exact provider/model/capability/reference/participant limits block fail-closed; nullable G2 and unavailable Codex image never fall back.

## Page operations and review

- [x] 007-C20 Regenerating page 7 changes only page 7 asset/version/head; all sibling checksums, heads, and provenance remain identical (SC-003).
- [x] 007-C21 Text-only rewrite changes no illustration; illustration-only regeneration changes no text; layout-only request delegates to 008 without guessed placement.
- [x] 007-C22 Revert preserves history and uses explicit selected version; every prior version stays readable until feature-010 deletion.
- [x] 007-C23 Locked page rejects mutations; invalidation changes only its flag to `locked_stale`; unlock is explicit and revision checked.
- [x] 007-C24 Approve/lock require current text+illustration tuple and complete FR-118 checklist; stale checklist or version fails.
- [x] 007-C25 Identity/outfit/participant/pet/age/register/no-text/safety/consistency checklist and side-by-side sheet crop comparison are available per page.
- [x] 007-C26 AI findings never mutate content; unacknowledged `block` prevents internal-review gate, explicit acknowledgement is audited.

## Invalidation

- [x] 007-C27 Closed compile-time IM-01–IM-21 table exists; missing/duplicate/unknown row fails tests.
- [x] 007-C28 One automated test per row proves direct and transitive consequences, exact affected scope/actions, and no automatic regeneration.
- [x] 007-C29 Receipt keyed by event ID is idempotent; repeat verifies consequence hash, mismatch fails, and every first application appends audit evidence.
- [x] 007-C30 `bookVersion` bumps exactly for rows marked invalidating under Book approval; locked pages never evade downstream approval invalidation.
- [x] 007-C31 IM-21 changes picker visibility only and leaves every pinned artifact/version/head byte-identical.

## Privacy, prompt policy, UI, and release evidence

- [x] 007-C32 Enqueue and pre-dispatch consent tests prove zero capability/provider call for not-recorded/refused/revoked photo-bearing work; no original/full-frame face path is accepted.
- [x] 007-C33 Sheet-first reference budget and named-artist/franchise transformation use hash-bound explicit confirmation; no character/view/style/provider is silently removed or substituted.
- [x] 007-C34 Arabic creative UI passes keyboard, focus, bidi, target-size, reduced-motion, axe, and no-overflow checks at 390/1440/1920 widths.
- [x] 007-C35 Browser/PDF templates make zero external requests; staged scan finds no real child/customer data, secrets, home paths, DB/runtime files, or generated customer artifacts.
- [x] 007-C36 Check/build/format/audit/clean install pass; all tests pass; `src/domain/creative/**` and creative job/PDF code meet ≥80% statements/branches/functions/lines.
- [x] 007-C37 Opt-in synthetic live script reports exact provider/model PASS/FAIL/SKIP; missing Gemini credential/G2 stays SKIP and automated suites make zero real calls.
- [x] 007-C38 `IMPLEMENTATION_NOTES.md` records commands, counts, coverage, PDF/UI evidence, skipped live checks, and residual risks.

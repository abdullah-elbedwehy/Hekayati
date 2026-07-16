# Analyze Report: 010 Portability and Deletion

**Date**: 2026-07-16

**Verdict**: PASS — ready for implementation

**Master tasks**: T-P2-09 and T-P9-01–T-P9-06

**Feasibility**: R11 selects local streaming ZIP; no provider/account/external-service gate applies

## Scope and dependency result

Slices 003, 006 and 007 supply the customer/library inventory, durable scheduler/late-commit fences and generated project graph required by the canonical Phase 9 precondition. Slices 008/009 supply exact preview/approval/layout/print records and are real T-P9-01 participants plus T-P9-05 round-trip evidence. Slice 011 is deliberately staged: 010 proves the typed registration/omission behavior with a synthetic customer-owned participant; 011 owns its real Studio schema and must repeat round-trip/customer-deletion evidence before its own checkpoint and Phase 10.

The slice owns portability/destruction mechanics only: exact scoped graph selection, consistent paused export, versioned secret-free ZIP, hostile import validation/migration/modes/remap/atomic commit, and verified permanent deletion. It does not own customer/character/Studio/print behavior, silently rewrite their schemas, resurrect provider work, implement automatic backup, inspect credentials, or delete arbitrary operator files.

| Area             | Analyze result                                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope            | PASS — FR-005/125–129 and US9 owned; shared feature records consumed through typed participants                                                                                                |
| Dependency       | PASS — Phase 2/6 prerequisites exist; real 003–009 participants and a synthetic 011 seam close 010, while actual 011 evidence is assigned to 011/Phase 10                                      |
| Snapshot         | PASS — durable drain/snapshot admission, exact captured attempts, one synchronous canonical snapshot-row/media-hold transaction, then async staging close C-07 without an async DB transaction |
| Archive contract | PASS — current wire pair is exactly `{ format: "HekayatiArchive", manifestVersion: 2 }`; frozen v1 alone uses legacy `schemaVersion: 1`; ArchivePolicy/v1 is distinct                          |
| Privacy          | PASS — exact graph excludes unrelated customers/projects; originals export only explicitly; two-pass secret gate and no-backup/external-copy warnings are hard requirements                    |
| Hostile input    | PASS — envelope, canonical-name, symlink/executable/type, exact ArchivePolicy/v1 caps, disk, schema/reference/media and secret validation all precede product writes                           |
| Versioning       | PASS — manifest v1→v2 and participant document migrations are explicit; unknown/future versions fail before commit                                                                             |
| Conflict modes   | PASS — as-new typed remap/rehash and same-customer consent rules, exact replace scope, characters-only and templates-only have closed allow-lists and deterministic reports                    |
| Atomicity        | PASS — operation-owned hierarchical lock, bounded prepared/unlink ledgers and transaction-owned media ports expose old or one complete graph and resume cleanup                                |
| Replay safety    | PASS — action-scoped idempotency key plus canonical request hash is persisted atomically with each result; exact replay returns it and collisions change nothing                               |
| Job safety       | PASS — admission covers enqueue/claim/promote/resume/run/commit; only captured drain attempts may finish; replace/deletion cancel; imported executable work stays paused                       |
| Deletion         | PASS — paged immutable inventory/hash, stale-confirm rejection, customer/project lock hierarchy, reverse removal, exact managed unlinks and verified bounded report                            |
| Shared data      | PASS — positive refcounts preserve shared bytes honestly; project deletion preserves library/Studio; keep-pinned cancels customer permanent delete                                             |
| API/UI           | PASS — no-store scoped upload/plan/commit/download/delete routes and three-width Arabic destructive-flow acceptance are closed                                                                 |
| Release evidence | PASS — EC-G fixture matrix, real 003–009 + synthetic-011 round trip, secret sweep, kill matrix and post-delete scans have exact routes; real Studio repeats later                              |

## Traceability

| Requirement / criterion | Slice evidence route                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| FR-005                  | Clarified contract 1/19–24; A-010-11–13; 010-C32–C41/C51; T-P2-09                                  |
| FR-125                  | Clarified contract 2–7; A-010-01/02; 010-C01–C10/C51; T-P9-01/05                                   |
| FR-126 / SC-005         | Clarified contract 9–10; A-010-03/15; 010-C11–C14/C48–C50; T-P9-01/06                              |
| FR-127                  | Clarified contract 13–17; A-010-07–09; 010-C22–C28; T-P9-03                                        |
| FR-128                  | Clarified contract 8/11–18; A-010-04–10; 010-C15–C31/C43; T-P9-02/04                               |
| FR-129 / C-07           | Clarified contract 3–4; A-010-01; 010-C05/C06; T-P9-01                                             |
| FR-133 / RR-06          | Clarified contract 10/25; A-010-14; 010-C14/C45; T-P9-01/06                                        |
| FR-160 / CHK229         | Clarified contract 26; A-010-03/07/10–15; 010-C51; T-P9-01–06                                      |
| US9-AS1–6               | A-010-01–15; 010-C01–C51; acyclic Phase-9 DAG                                                      |
| EC-E04/E11              | Quiescence plus scope-lock cancellation/late-fence tests; 010-C05/C35                              |
| EC-G01–G13              | A-010-03–10; 010-C15–C31/C43; hostile fixture registry                                             |
| EC-H03/H04/H07/H08      | A-010-11–14; 010-C14/C32–C40/C45                                                                   |
| CHK024                  | Full registered graph deep-equality round trip, 010-C41/C42                                        |
| CHK209                  | Project/customer inventory-to-postcondition DB/FS verification, 010-C32–C40                        |
| CHK215/417/418          | Arabic warning, scope preview and exact destructive confirmation, 010-C14/C34/C45/C46              |
| CHK217–220              | Hostile matrix, atomic kill tests, seeded secret failures and security review, 010-C15–C31/C43/C49 |

Every master task now has one owner, predecessor and acceptance route: T-P9-01 kernel/export → parallel T-P2-09 deletion and T-P9-02 validation → T-P9-03 plan → joined T-P9-04 apply → T-P9-05 fidelity → T-P9-06 release. Every canonical EC-G case has a pre-write fixture. Exact evidence distinguishes archive integrity, domain round-trip, operational job normalization, shared-content preservation and physical deletion instead of treating one happy-path import as proof of all five.

## Blocking questions resolved during readiness

1. **Does pause alone freeze export?** No. One transaction writes the draining lock/project pause/queued pauses and exact captured running attempts. Only those attempts may finish; at quiescence the lock enters snapshot and all later commits fail admission.
2. **How is every feature included without a fragile monolith?** T-P9-01 owns the frozen participant and explicit collection/asset/job/direct-writer catalogs. Real 003–009 entries land now; a synthetic 011 entry proves the seam, and actual 011 lands in its owning slice.
3. **What archive version proves migration?** Current output is exactly `{ format: "HekayatiArchive", manifestVersion: 2 }`; the frozen v1 fixture alone uses `{ format: "HekayatiArchive", schemaVersion: 1 }`. `ArchivePolicy/v1` is not an archive version.
4. **Can import recursively replace ID-looking strings?** Never. Per-participant explicit field rewrite is exhaustive; dependency-ordered rebase recomputes every ID/request-derived hash, then the complete graph is schema/closure/hash checked again.
5. **How do fresh IDs coexist with content addressing?** Every domain/archive identity is remapped. Exact byte+canonical-metadata media may map to an existing canonical content record with a refcount; conflicting bytes/metadata never alias.
6. **What does replace overwrite?** Only the exact project-owned graph. Shared library, Studio, templates and printer profiles require explicit mapping/new IDs and remain unchanged.
7. **Can imported paused work call a provider?** No. Executable nonterminal jobs import as lease-free operator-paused and the project remains paused; normal current guards run only after explicit resume.
8. **When is import visible?** Only after every validation and prepared file succeeds and one DB transaction commits the complete graph. Cleanup after commit cannot create partial logical state.
9. **How can DB and file deletion survive a crash?** The confirmation transaction owns the hierarchical lock, removes records/refcounts and persists exact bounded managed-unlink pages. Startup resumes unlink/verification until zero failed checks, then releases the lock; completion is not inferred from DB absence alone.
10. **What if identical bytes are shared?** Target references are removed, positive out-of-scope refcounts preserve the canonical bytes, and the report says so without identifying the other customer. Deleting them would corrupt unrelated work.
11. **Can a customer be permanently deleted while an older project keeps pinned character photos?** No. Keep-pinned cancels permanent customer deletion and offers archive/export; successful customer deletion cascades every owned project/Studio record.
12. **Are operator-copied ZIP files deleted later?** Hekayati removes only its managed archive. UI explicitly says external copies are outside its control.
13. **Does 010 invent or wait for Studio behavior before 011?** Neither. It defines and tests a synthetic customer-owned participant plus omission failure. Slice 011 owns its real schema and repeats combined round-trip/deletion evidence before its checkpoint/Phase 10.
14. **What resource limits are implementation choices?** None remain open. ArchivePolicy/v1 fixes upload, entry count/name, manifest/document/entry/aggregate bytes and per-entry/aggregate ratio maxima; archives and requests cannot relax them.
15. **Can an archive be mapped onto a different customer or overwrite consent?** No. Existing mapping requires an exact-revision same-real-customer/family attestation; local contact/current consent remains authoritative. Approval stays current only when unchanged semantic content and the resolution are proven, otherwise it becomes historical and fresh approval is required.
16. **Can SQLite stay open while ZIP/media work awaits?** No. `transactionImmediate` rejects thenables. One synchronous transaction freezes canonical document bytes, ordered media metadata/checksums and idempotent holds into durable rows; async staging reads only those rows/held bytes.
17. **What conflicts with a portability lock?** Customer locks overlap every descendant project/customer-owned participant; project locks overlap only that project and their parent customer lock; template-catalog locks overlap template writes. Other scopes and immutable pinned globals continue.
18. **Where is admission enforced?** In every scoped repository/raw-SQL mutation transaction and scheduler enqueue, claim, promotion/resume/retry, running transition and owner commit. The exact operation token grants only phase-specific internal writes; there is no blanket bypass or TTL unlock.
19. **Can a plan/inventory become an unbounded JSON document?** No. At most 256 strict entries live in each immutable ledger page; operations retain counts and ordered page-root hashes. APIs paginate bounded projections.
20. **Who owns filesystem versus domain orchestration?** `src/domain/portability/*-service|plan|apply.ts` owns state, closure and transactions. `src/portability/export.ts|import.ts|deletion-cleanup.ts` owns managed filesystem/ZIP/stream execution. No duplicate `export.ts` claims both layers.
21. **Can Hekayati delete the selected import or downloaded copy?** No. It reads the external source into a generated managed reservation and may clean only that reservation plus indexed managed exports/unlinks. Downloaded copies remain outside its control, as the UI warns.
22. **Can a retry duplicate a portability side effect?** No. Each mutating action records its scoped idempotency key, canonical request hash and exact bounded result in the same transaction as the state/result boundary. Exact replay returns that result; a key/hash collision changes nothing.

## Alternatives rejected

- Copy whole DB/data root: leaks unrelated customers/runtime state and prevents modes/remap.
- Let jobs keep running during export: creates mixed snapshot races.
- Use archive IDs directly: collision and cross-scope mutation risk.
- Walk JSON recursively for IDs: corrupts prose/hashes and misses typed references; copying derived hashes after typed remap is also rejected because they bind stale IDs/requests.
- Auto-extract then inspect: writes hostile paths/resources before validation.
- Support only current format: leaves FR-128 migration unproved.
- Redact a detected secret and continue: changes evidence silently and may miss binary/ZIP-boundary occurrences.
- Replace shared customer/library records: mutates other projects.
- Restore imported jobs as active: risks immediate provider calls and stale commits.
- Best-effort import cleanup without one DB transaction: exposes partial graphs.
- Delete physical assets regardless of refcount: destroys unrelated work.
- Report deletion complete after DB removal: ignores residual child media and managed archives.
- Persist arbitrary export/import paths: expands deletion and disclosure beyond the managed root.

## Canonical amendment assessment

No constitution amendment or new product-behavior choice beyond the approved 010 contract was required. Its externally visible replay rule is now stable canonical FR-160 instead of a slice-only redefinition, with CHK229 and task ownership for all eight actions. The approved contract also required normative companion repair before implementation: `data-model.md` now replaces the path-bearing legacy export record with strict locks/snapshots/operations/bounded ledgers; `state-machines.md` now matches export/import/deletion, action replay and lock recovery; R11 now freezes one v2/v1 wire contract and the transaction-safe snapshot method; Phase-9 tasks and `test-strategy.md` now assign the acyclic owners/gates. The slice plan/checklist use the same identities, states, source boundary and deferred-real-011 checkpoint.

Two existing bible phrases also required conservative interpretation, now explicit without overriding product behavior:

- EC-H04's “keep pinned copies vs cascade” is a pre-deletion decision: keeping copies cancels permanent customer deletion; a successful permanent deletion never retains pinned customer data.
- FR-127's “fresh IDs” applies to imported domain identities; exact compatible media may reuse the canonical content-addressed record with an explicit ID map/refcount, preserving R4 without aliasing conflicting content.

If product intent instead requires a successful “permanent” customer deletion while project-local character/photo copies survive, or requires duplicate physical storage for byte-identical assets, that would conflict with the constitution/R4 and needs a canonical amendment. Neither behavior is required by the approved journey, so it is not an implementation blocker.

## Readiness decision

No constitution conflict, unresolved product choice, archive-limit choice, credential dependency, external service, async-transaction assumption, unowned source path, unbounded plan, unguarded scope hierarchy, replay ownership gap, conflict/consent mode or unverifiable deletion claim remains. Real 003–009 participation is current; the synthetic 011 seam closes 010 without a false Studio claim, and the real Studio repetition is an explicit 011/Phase-10 gate.

Slice 010 is ready for TDD implementation in this exact order: `T-P9-01 → {T-P2-09 || T-P9-02} → T-P9-03 → T-P9-04 → T-P9-05 → T-P9-06`. Product code remains limited to this dependency-ready slice and the exact master tasks above.

# Implementation Plan: Portability and Deletion

**Feature**: `010-portability-and-deletion`

**Spec**: [spec.md](spec.md)

**Canonical plan**: [integrated plan](../001-hekayati-product-bible/plan.md)

**Tasks**: T-P2-09 and T-P9-01–T-P9-06

**Execution DAG**: `T-P9-01 → {T-P2-09 || T-P9-02} → T-P9-03 → T-P9-04 → T-P9-05 → T-P9-06`

## Technical context

Extend the existing one-process TypeScript application with a provider-free portability domain. Reuse the SQLite `DocumentStore` transaction boundary, strict zod repositories/migrations, content-addressed `AssetStore` and private `OriginalAssetStore`, durable local scheduler and commit fences, shared secret registry/redactor, managed-root ownership/symlink protections, canonical HTTP/CSRF boundary, and Citrus Playground Arabic RTL shell. Add `DocumentStore.transactionImmediate()` and reject thenable-returning transaction callbacks so no SQLite transaction can commit early across asynchronous work. Add transaction-owned media retain/release/hold ports and durable prepared/unlink ledgers; no file is unlinked before exact cleanup intent commits. Use streaming `yazl`/`yauzl` as selected by R11; no shell archive command, cloud service, Keychain/Codex inspection, provider call, external telemetry, automatic backup, or raw filesystem-path API is introduced.

The current upstream graph is intentionally distributed across library, authoring, creative, layout, print, scheduler and asset repositories. Portability therefore uses an explicit typed participant registry instead of teaching one monolith private schema knowledge or recursively rewriting arbitrary strings. T-P9-01 owns the real 003–009 participant set and a synthetic 011 contract fixture. Feature 011 later adds its real Studio participant through the same closed interface and repeats the combined evidence; Slice 010 does not invent the not-yet-owned Studio schema.

Archive/staging/prepared/unlink bytes live only under generated managed private roots on the same volume as the data store. Operation/plan/inventory/report summaries and bounded hashed ledger pages live in SQLite; frozen canonical snapshot bytes live in private internal SQLite rows until staged. Unknown files are never swept. Product documents contain only strict IDs, hashes, versions, bounded facts and states; archive/media bytes remain outside JSON except for the exact private snapshot-row copy. The operator-selected source and downloaded copies are external/unmanaged and are never mutated or deleted by Hekayati. Automated fixtures use fictional synthetic records/images/PDFs and make zero network/provider call.

## Constitution and dependency check

- **Local-first/privacy**: PASS — managed 0700/0600 roots, no network, exact scoped graph, originals leave only through explicit export, zero path/secret leakage.
- **Permanent deletion**: PASS — deterministic pre-report, exact confirmation, forced job cancellation, refcount-aware media unlink, restart-safe verification report.
- **Untrusted input**: PASS — no product write before bounded ZIP, schema, reference, checksum, media, disk and secret validation completes.
- **Durability/atomicity**: PASS — prepared files plus one SQLite commit; scope locks, operation ledgers, restart cleanup/resume and late-worker fences.
- **No silent degradation**: PASS — no skipped entry, implicit conflict choice, hidden ID reuse, best-effort secret redaction, partial import, automatic resume, or false deletion success.
- **Versioning**: PASS — `HekayatiArchive/v2`, frozen v1 migrator, participant-owned document migrations, future-version refusal and deterministic ID mapping.
- **Dependencies**: PASS — 003 inventory, 006 scheduler, 007 generated graph and 008 contracts exist; 009 joins before full print round-trip evidence, 011 joins before final Studio completeness evidence.
- **Feasibility**: PASS — R11 selects local streaming ZIP libraries; no provider/account/tool gate applies.

## Canonical model decisions

### Scope admission, snapshot rows, and media lifecycle

`PortabilityScopeLock` is a durable database protocol, not an in-memory mutex or expiring lease:

```text
operationId, scope { kind: customer|project|template_catalog,
                     id, customerId?, projectId? },
mode: export_snapshot|import_commit|replace_import|permanent_delete,
phase: draining|snapshot|exclusive|releasing,
revision, capturedAttemptLedgerRoot/count, acquiredAt, updatedAt
```

Acquisition is one immediate transaction in canonical resource order `template_catalog → customer ID → project ID`; conflict returns bounded `SCOPE_BUSY`, never waits or deadlocks. A customer lock overlaps every descendant project and customer/family-owned Studio mutation. A project lock overlaps that project and its owning customer lock, not unrelated projects. The template-catalog lock serializes template mutation/import only. Fully new imports reserve fresh IDs; mapped customer/library imports acquire the customer lock; replace/project deletion acquire the project lock; customer deletion acquires the customer lock.

Initial export/replace/delete acquisition uses `draining`. The same transaction writes the lock, sets the project pause where applicable, pauses queued/blocked executable jobs, blocks new scope mutation and scheduler enqueue/claim/resume/promotion, and records the exact already-claimed/running `{jobId, attempt}` set in bounded ledger pages. Only captured attempts may commit while draining. At zero active attempts, export enters `snapshot`; replace/delete enter `exclusive`; no attempt may commit thereafter. Every scoped repository/raw-SQL write resolves ownership through the participant catalog and checks admission inside the same transaction. Scheduler enforcement repeats at enqueue, claim, promotion/resume/retry, running transition, and `commitWith` before the owner callback. The owning operation receives a narrow exact phase/write context, never a generic bypass.

After export quiescence, one synchronous immediate transaction rechecks lock/project/job revisions; selects and schema-validates the participant closure; canonicalizes each document; writes one bounded private snapshot row per document/media item; creates idempotent media holds; computes registry/document/media/snapshot hashes; and marks the snapshot frozen. No filesystem read or `await` occurs. Async staging resumes by ordinal, reads document bytes only from snapshot rows and media only by exact held managed ID, and verifies authoritative streamed byte count/checksum/metadata. After every byte is privately staged, one transaction releases holds with any resulting zero-ref cleanup intent, marks the snapshot staged, and releases the project lock. Packaging and both secret scans use only staged bytes. Crash recovery runs before workers claim, never expires a lock by time, and resumes or fails only the owning recognized rows/holds/ledgers.

`PortabilityLedgerPage` keeps every large set bounded: `operationId`, `ledgerKind`, `pageIndex`, at most 256 strict entries, `pageHash`, `createdAt`. A ledger root hash covers ordered page hashes and total count. Operations store only counts/root hashes for captured attempts, import mappings/conflicts/rebases/writes/releases/prepared media, deletion inventory/unlinks/shared preservation/verification, and report detail. API projections paginate these records.

`PortabilityAction` is the append-only FR-160 replay boundary: `id`, `operationScope { kind: installation|project|import_operation|deletion_target|deletion_operation, id }`, closed `action: export_pause|export_start|import_upload|import_plan|import_commit|replace_commit|deletion_confirm|deletion_cleanup_retry`, `idempotencyKey`, canonical request hash, exact input revisions/hashes, bounded result/result hash, and recordedAt; unique on the complete scope/action/key tuple. Export uses its project, upload uses the stable local installation ID before an import operation exists, planning/commit/replace use that import operation, and deletion uses the typed target or cleanup operation. The upload hash includes declared archive checksum/bytes, which the first accepted stream verifies. Each action persists atomically with its durable state/result boundary. Exact replay returns the stored result; a key/hash collision changes nothing and no durable side effect is duplicated.

### Participant registry and ownership graph

`PortabilityParticipant<T>` is a frozen startup registry entry:

```text
key, collection, currentSchemaVersion,
schema, migrations[], dependencies[],
exportModes[], selectForProject(root), selectForCustomer(root),
assetReferences(document), originalReferences(document),
rewriteIds(document, ExactIdMap), rebaseDerivedFields(document, graph),
verifyClosure(document, graph),
deleteOrder, verifyDeleted(id)
```

Every function is typed and bounded. A participant cannot inspect arbitrary filesystem paths or mutate storage. The registry topologically sorts dependencies and rejects cycles, duplicates, an unrecognized schema version, or anything missing from the explicit repository collection, asset/original role, scheduler-lineage and direct scoped-SQL-writer catalogs. Startup migrations are narrowly allow-listed; every other scoped writer must use admission. Explicit adapters cover:

- 003 library identities/versions/photos/events/receipts and originals;
- 004 project/template/story/scene records;
- 006 project jobs, required job events and terminal/gate lineage, excluding global incidents/controls;
- 007 sheets/approvals/runs/stages/pages/text/prompts/illustrations/reviews/findings/invalidation evidence;
- 008 composition/layout/cover/preview/cycle/action evidence;
- 009 project print runs/artifacts/preflight/proof evidence plus pinned profile/version inputs;
- managed exports and content-addressed derived/original records;
- a synthetic customer-owned 011 participant for seam/omission tests in 010; and
- real 011 customer-scoped Studio records/jobs/assets only when its owning slice registers them.

Selectors produce one graph of `(participant, document ID, reason/root edge)` and one media reference multiset. Closure validation proves every non-global reference resolves inside the graph or to an explicitly allowed built-in/global hash. It also proves no second customer/project root is reachable. A completeness test enumerates all current repository collection constants and asset roles; adding a customer/project-bearing collection without a participant breaks the suite.

### Export operation and manifest

`ExportOperation` is revisioned and project-owned:

```text
id, projectId/customerId/familyId, revision,
state: waiting_pause|waiting_quiescence|acquiring_lock|freezing_snapshot|
       staging|packaging|secret_scanning|ready|failed|stale,
requestHash, idempotencyKey, projectRevision,
snapshotHash?, manifestHash?, archiveChecksum?, archiveKey?,
documentCount/mediaCount/bytes, blockingReason?, createdAt/updatedAt
```

`archiveKey` is an app-generated managed relative key, never an operator path. A strict local `project_export` job persists only an operation ID/payload hash. The export service previews affected jobs, then uses the scope-admission draining transaction above. At quiescence it transitions to snapshot and performs the synchronous durable-row freeze; no SQLite transaction spans filesystem staging. Media holds prevent a concurrent valid release from unlinking frozen bytes. Missing/integrity-drifted media fails the candidate. Once private staging verifies every entry, live work may change while packaging and both scans continue from staged bytes. Export never resumes the project. Same scoped idempotency key + same request hash returns the stored operation/archive; same key + different hash conflicts; a failed candidate never replaces a prior ready export.

`manifest.json` v2 uses canonical JSON and has a closed shape:

```text
format: "HekayatiArchive"
manifestVersion: 2
appVersion, createdAt, exportId
scope { kind: project, projectId, customerId, familyId }
roots[] { kind, id }
documents[] { path, collection, id, schemaVersion, bytes, sha256 }
media[] { path, namespace, assetId, role, mime, extension, bytes, sha256 }
totalUncompressedBytes, snapshotHash, manifestHash
```

Paths are exporter-generated (`data/<collection>/<id>.json`, `media/assets/<sha>.<ext>`, `media/originals/<sha>.<ext>`), NFC, slash-only and lexically sorted. The manifest excludes itself from the entry list; `manifestHash` hashes its canonical hashless projection. The local operation stores the final archive SHA-256. Exact replay returns the same ready operation/archive; changed project/inventory creates a new operation.

`HekayatiArchive/v2` is exactly the pair above. `ArchivePolicy/v1` is the separately versioned resource/security policy. The one frozen `HekayatiArchive/v1` fixture uses `format: "HekayatiArchive"`, the old `schemaVersion: 1` key, and checksum map; its pure migrator constructs the v2 entry array, validates all legacy keys, and records a bounded migration report. The external source checksum never changes.

### Import operation, plan and ID map

`ImportOperation` is revisioned:

```text
id, reservationKey, revision,
state: uploaded|validating|plan_ready|committing|imported|rolled_back|failed|cleanup_required,
sourceArchiveHash/sourceArchiveBytes, manifestVersion, normalizedManifestHash,
actionRefs { uploadActionId, latestPlanActionId?, commitActionId? },
mode: as_new_project|replace_existing|characters_only|templates_only,
planId?, boundedResultRootIds/counts, failureCode?, cleanupState
```

`reservationKey` addresses only the opaque app-owned 0600 managed copy. The operator-selected source remains external, read-only and untouched; terminal cleanup recognizes only the reservation/staging root. `ImportPlan` is immutable and contains the normalized v2 manifest/snapshot hash, target owner/revisions, typed conflict choices, customer resolution/attestation, disk/migration/sanitization summaries, root hashes/counts for complete explicit ID-map, rebase, write, release, prepared-media and authorization ledger pages, and `confirmationHash`. IDs are allocated once at plan creation so retry/restart is deterministic. Replanning is required if source bytes, mappings, attestation or target revision change. No operation document contains an unbounded map/array.

The ID map has namespaces for every entity, job/event and asset/original ID. Each participant rewrites only declared ID fields. In topological dependency order it then rebases every field derived from IDs or rewritten canonical requests, including request/idempotency, authorization/approval, input/provenance, layout/preview, print-source and run hashes. No source derived value is trusted after remap. The complete rebased graph passes strict schemas, closure, canonical hash recomputation and participant invariants again before the plan can be confirmed. Content-store dedup is resolved after byte+metadata validation: an archive media ID may map to an existing canonical local ID only on exact checksum and canonical metadata equality; otherwise it receives a new local record/ID. No imported document retains an unmapped archive authority or stale pre-remap hash.

Mode policies:

- `as_new_project`: fresh project/domain/job identities. Customer resolution is exactly `create_from_archive` or `map_existing_same_customer`; mapping pins exact customer/family revisions and requires explicit operator attestation that the archive and target identify the same real customer/family. Different-customer mapping rejects. A mapped target's local customer/contact and active consent remain unchanged and authoritative; archive consent is historical evidence. Imported project is paused.
- `replace_existing`: exact existing owner/family/project and revision; shared records use explicit maps/fresh IDs; target project graph and jobs are replaced only after destructive confirmation.
- `characters_only`: only selected library identity/version/photo/media graph; no project/output/job/Studio data.
- `templates_only`: only parameterized template graph; the existing 004 extractor removes frozen legacy private refs into role slots before strict validation.

Imported approval evidence remains authorizing only when its participant proves the semantic approved content is unchanged by the administrative rebase and the resolved customer is valid. Otherwise the evidence remains historical, while current content authorization and print deliverability are cleared for fresh approval. Project job history needed by approvals/provenance is remapped, including recomputed canonical request hashes and idempotency keys. Terminal states remain terminal, human gates retain remapped targets, and other nonterminal jobs become lease-free `paused(operator)`; global scheduler incidents, credentials, settings and runtime state are absent. Explicit resume always reruns current capability, local-consent and reference guards.

### Hostile ZIP and resource policy

`ArchivePolicy/v1` is a versioned closed policy. It fixes 8 GiB maximum compressed upload, 20,000 entries, 240 UTF-8 bytes per entry name, 8 MiB manifest, 16 MiB canonical JSON document, 2 GiB single media/PDF entry, 16 GiB aggregate uncompressed bytes, and 200:1 per-entry and aggregate compression ratios. Archive/request input cannot raise a cap; a change requires a new policy version and spec decision. `yauzl` opens lazily without auto-extract. Validation order:

1. ZIP envelope: parse, single-disk, unencrypted, bounded central directory/count/name lengths;
2. canonical names: slash-only relative NFC segments, no empty/dot/dot-dot/NUL/drive/UNC/backslash, no case-fold collision or duplicate;
3. type: regular files only; reject symlink/device/executable mode, executable magic/content, nested archives and unlisted extension/MIME/content kinds;
4. manifest: exact v1/v2 schema, listed-entry equality, bounded arithmetic and version policy;
5. disk formula: declared bytes + new media bytes + `max(2 * documentBytes, 256 MiB)` while preserving configured disk reserve;
6. streaming extraction: per-entry/aggregate/compression-ratio counters and SHA-256; no trust in declared size;
7. strict participant document migrations/schemas, ID/reference closure, mode policy and media/PDF/ICC/template validation; and
8. shared secret scan and independent finalized/normalized graph scan.

Every rejection has a stable bounded code plus safe entry/category, never raw content, path outside the archive, stack, customer text or secret match. Staging uses generated names and `O_NOFOLLOW`/managed-root checks; cleanup recognizes only its reservation.

### Atomic import commit

Planning is lock-free and pins exact target revisions. Confirmation first acquires the required customer/project/template lock with its exact operation token and rechecks source/plan/target hashes. Validated media is then prepared asynchronously through `AssetStore.prepare`/`OriginalAssetStore.prepare` under a durable `PreparedMediaLedger { operationId, namespace, checksum, managedKey, state: reserved|written|committed|discarded, wasPreexisting }`; recovery never removes a deduplicated preexisting file. The final synchronous transaction:

1. rechecks the exact operation-owned target lock, source/plan hash and expected target revisions;
2. for replace, force-cancels exact target jobs/gates and freezes old graph/refcounts;
3. commits prepared media/refcount mappings through transaction-owned store ports;
4. inserts all remapped documents in participant dependency order;
5. for replace, removes only old project-owned documents and applies old media releases without unlinking;
6. writes imported roots, audit result and exact post-commit managed-unlink ledger pages; and
7. marks the import committed.

Failure rolls back every DB mutation and discards only ledger-proven new prepared files; existing dedup files are not deleted. Crash before DB commit leaves the old graph plus recognized prepared/reservation work. Crash after commit leaves one complete imported graph plus resumable zero-ref cleanup. The managed reservation/staging tree—not the operator's source—is deleted after terminal state or recovered on restart. Cleanup completion releases the lock; a failure remains `cleanup_required` and never rolls back a successfully committed graph.

### Deletion inventory and operation

`DeletionInventory` is immutable and short-lived:

```text
target { kind: customer|project, id, revision, displayNameHash }
document/job/media/export counts,
inventoryLedgerRoot, blockerLedgerRoot,
preservedSharedCounts, inventoryHash, createdAt
```

Bounded immutable inventory pages contain strict document/job/export IDs and media `{ namespace, id, checksum, inScopeRefs, totalRefs, disposition }` entries. They carry no raw customer text/path/foreign owner. Inventory hash covers ordered page roots, IDs, revisions, checksums, reference counts and dispositions. Confirmation compares a freshly recalculated inventory inside the transaction; stale inventory changes nothing.

`DeletionOperation` is durable system evidence:

```text
id, target kind/id/hash, inventoryHash, requestHash/idempotencyKey,
state: committing|unlinking|verifying|verified|cleanup_required,
canceledJob/deletedDocument counts,
unlinkLedgerRoot, sharedPreservedLedgerRoot, verificationLedgerRoot,
createdAt/updatedAt
```

Confirmation transaction acquires the hierarchical exclusive lock, rechecks target/inventory/job revisions, force-cancels all nonterminal owned jobs including owner gates, removes target documents in reverse dependency order, applies transaction-owned asset/original/export releases, removes zero-ref indexes, inserts exact unlink/shared/verification pages and audit evidence, and makes late worker commits fail target/state/admission guards. A customer lock conflicts with every descendant project/customer-owned Studio operation; a project lock conflicts with the same project and its parent customer lock. Project target preserves all library/Studio data and global profiles/templates. Customer target includes all same-customer projects and every registered customer/family participant. In 010 that includes the synthetic 011 seam; slice 011 repeats with the real Studio participant. No successful customer delete can retain pinned same-customer character copies; choosing keep cancels the delete and routes to archive/export.

After commit, `ManagedUnlink` pages carry `{ operationId, namespace: asset|original|export, mediaId, checksum, managedKey, state: pending|unlinked|preserved|blocked, attempts, boundedFailureCode? }`. Unlink rechecks no indexed ref/active hold, exact managed root/depth/name/checksum, removes idempotently with no symlink following, syncs parent directories and then verifies every DB/file/refcount/scope postcondition. Missing expected files count as absent only when the indexed checksum/record was already removed; unexpected checksum/path mismatches require cleanup review and are never blindly deleted. Restart resumes `unlinking|verifying|cleanup_required`. Only zero failed checks advances `verified` and releases the scope lock. Same idempotency key/request hash returns the stored inventory/operation/result; a different hash conflicts without duplicate deletion.

## API and UI contract

Every response is `Cache-Control: no-store`; unsafe requests use existing authority/origin/CSRF checks. Scope/revision/hash/idempotency mismatches fail before mutation. Every mutating route maps to the closed `PortabilityAction` vocabulary above. Same key + same canonical request hash returns the bounded stored result; same key + different hash returns a collision. Multipart import is streaming and bounded; before body processing its `import_upload` request declares canonical archive SHA-256 and byte count, exact replay may return the prior operation, and a first accepted stream must match both before its managed reservation, operation and action become durable. No request accepts a local path and no JSON returns one. Detail sets use cursor-bounded ledger-page projections.

```text
GET  /api/portability/projects/:projectId/export/preview
POST /api/portability/projects/:projectId/export/pause
POST /api/portability/projects/:projectId/export
GET  /api/portability/exports/:exportId
GET  /api/portability/exports/:exportId/download

POST /api/portability/imports
POST /api/portability/imports/:importId/plan
POST /api/portability/imports/:importId/commit
GET  /api/portability/imports/:importId

GET  /api/portability/deletions/:kind/:id/inventory
POST /api/portability/deletions/:kind/:id/confirm
GET  /api/portability/deletions/:operationId
POST /api/portability/deletions/:operationId/retry-cleanup
```

Downloads verify owner/scope, ready state, archive checksum and file integrity, with a fixed ZIP MIME and safe attachment name. A downloaded copy is external/unmanaged and cannot be tracked or deleted later. Import plans expose only bounded counts/IDs/conflicts/migrations and never entry content. Deletion reports expose paginated target-owned IDs/counts and anonymous shared counts, never foreign-owner identity.

Arabic RTL workspace sections: export pause/quiescence and content summary; import upload/validation/version/mode/conflict plan; deletion inventory/typed confirmation/progress/verification. It repeats «التصدير ليس نسخة احتياطية تلقائية», warns that archives contain child photos and outside copies cannot be deleted, names destructive replace/delete impact, and makes shared-preserved bytes explicit. Use logical CSS, Western digits, `<bdi>` for hashes/IDs/files, semantic progress/tables, text+icon states, focus-visible, programmatic errors/live regions, ≥44 px controls, reduced motion and responsive single-column collapse.

## Source layout

```text
src/domain/portability/
  schemas.ts                  # strict bounded operation/plan/report contracts
  repositories.ts             # revisioned operations + immutable ledger pages
  participants.ts            # frozen registry and completeness audit
  graph.ts                   # project/customer closure and reference accounting
  scope-locks.ts             # hierarchical admission + exact owner context
  snapshot-entries.ts        # synchronous canonical DB freeze + media holds
  operation-ledgers.ts       # bounded hashed pages + PortabilityAction replay boundary
  id-map.ts                  # typed allocation and field-aware rewrite orchestration
  export-service.ts          # pause/drain/snapshot operation orchestration
  import-plan.ts             # validation projection/modes/remap/rebase plan
  import-apply.ts            # target lock + one-transaction graph commit
  deletion-service.ts        # inventory/confirm/verify domain orchestration
  workspace.ts               # scoped UI projections/download guards
src/portability/
  export.ts                  # filesystem stage/ZIP/scan/download executor
  import.ts                  # external-source reservation + staging executor
  archive-policy.ts          # bounded ZIP envelope/name/type validation
  manifest.ts                # v2 schema/canonical hash + frozen v1 migrator
  zip-reader.ts              # lazy streaming staging/checksums
  zip-writer.ts              # deterministic streaming archive
  secret-scan.ts             # shared registry + archive/log/DB scan adapters
  disk-preflight.ts          # overflow-safe reservation formula
  managed-roots.ts           # exact owned keys/permissions/no-follow rules
  deletion-cleanup.ts        # exact unlink/fsync/verification recovery
  cleanup.ts                 # reservation/export/prepared recovery
src/jobs/portability-definitions.ts
src/server/routes/portability-api.ts
src/ui/views/PortabilityView.tsx
src/ui/components/portability/**
src/ui/portability.css
tests/unit/portability-*.test.ts
tests/integration/portability-*.test.ts
tests/failure-injection/portability-restart.test.ts
tests/e2e/portability.spec.ts
```

Keep production files ≤800 lines and functions ≤50 lines by extracting registry, policy, mapping, validation and projection helpers. Shared ports are explicit: `DocumentStore.transactionImmediate()` rejects thenables and supports bounded snapshot/batch work; `DocumentRepository` plus every specialized scoped SQL writer checks `ScopeAdmissionService`; scheduler supports atomic project pause + captured attempts, batch force-cancel, and admission at enqueue/claim/promote/resume/run/commit; `AssetStore`/`OriginalAssetStore` expose transaction-owned retain/hold/release-without-unlink plus prepared/unlink recovery. Portability never starts nested transactions or bypasses these invariants.

## Test-first order

1. **G1 / T-P9-01 / 010-C01–C14**: thenable rejection; hierarchy/phase conflict matrix; direct-writer and real 003–009 participant completeness plus synthetic 011 omission; graph/media multiset; scheduler admission; drain/captured attempt races; FR-160 action repository plus export pause/start; durable snapshot rows/holds; exact v2/v1 schemas/hashes; deterministic ZIP, double secret scan, managed download and warnings.
2. **G2a / T-P2-09 / 010-C32–C40** and **G2b / T-P9-02 / 010-C15–C21** in parallel: deletion inventories/confirmation/cancellation/refcounts/unlinks/recovery plus confirm/cleanup actions; declared-hash external-source reservation plus upload action; every ArchivePolicy boundary, EC-G hostile fixture, disk/version/schema/media/PDF/ICC/template/secret pre-write rule.
3. **G3 / T-P9-03 / 010-C22–C28**: immutable paged plan plus plan action/replay; all four modes; collision-heavy typed remap/rehash; same-customer attestation; local-consent authority; approval demotion/preservation and job normalization.
4. **G4 / T-P9-04 / 010-C29–C31**: prepared ledger + operation lock + import/replace action in the single-transaction graph commit, shared refcounts, cancellation, rollback, and old-or-complete-new graph proofs.
5. **G5 / T-P9-05 / 010-C41–C43**: full real 003–009 project round trip, synthetic 011 seam/omission, unrelated byte equality and complete EC-G registry.
6. **G6 / T-P9-06 / 010-C44–C51**: real child-process kill matrix across lock/drain/freeze/ZIP/staging/prepared rename/DB/unlink/verification; ENOSPC/EACCES/DB failures; exhaustive eight-action replay/collision/restart evidence for CHK229; scoped no-store API/download/multipart; Arabic three-width E2E; DB/log/archive sweep, coverage, build/audit/staged scan and notes.

## Alternatives rejected

- **Export the SQLite database wholesale**: includes unrelated customers, runtime state and future secrets; cannot support scoped modes or safe ID remap.
- **Generic JSON tree ID replacement**: rewrites user text/hashes accidentally and misses semantic references; every participant owns explicit fields.
- **Concurrent live export**: running jobs can commit mixed heads/assets; C-07 requires pause plus quiescence.
- **Trust ZIP extraction helpers**: path/symlink/resource behavior is too implicit; validate lazy central-directory entries and stream explicitly.
- **Manifest v1 with no older fixture**: cannot prove FR-128 migration; ship v2 plus one frozen v1 migration.
- **Best-effort secret redaction**: an archive with a secret must fail, not be silently modified.
- **Reuse archive IDs directly**: collisions and cross-scope aliases can mutate unrelated state; allocate/map every ID explicitly.
- **Replace shared customer/library records implicitly**: could alter other projects; replace only target project and map shared dependencies explicitly.
- **Import active jobs as runnable**: may trigger provider calls or stale work; normalize executable nonterminal jobs to operator pause.
- **Delete files before a durable ledger**: crash can leave unverifiable records or lost cleanup intent; commit scope/document/refcount intent first, then resume exact unlinks.
- **Delete every identical content-addressed file**: breaks valid out-of-scope references; remove target links, preserve positive shared refs and report honestly.
- **Claim external archive copies were deleted**: Hekayati controls only its managed root; warn explicitly.

## Checkpoint evidence

Slice 010 completes only when 010-C01–C51 and CHK229 pass; all EC-G01–G13 fixtures reject/migrate exactly; project and customer deletion verify every inventoried DB/media/export/job postcondition; export→fresh-instance import deep equality covers the complete real 003–009 graph plus the synthetic 011 registration seam; as-new/replace/selective collision cases preserve unrelated state; real restart/failure tests prove no mixed snapshot, partial visible import or falsely completed deletion; every FR-160 action replays exactly and collides fail-closed without duplicate durable work; archive/DB/log scans find zero credentials; Arabic UI/API security passes at three widths; `src/domain/portability/**` and `src/portability/**` each meet ≥80% statements/branches/functions/lines; clean install/check/build/audit/format/staged scans pass; and `IMPLEMENTATION_NOTES.md` records exact commands/counts/coverage/evidence and residual manual backup/legal boundaries. Slice 011 must add its real participant and repeat Studio round-trip/customer-deletion evidence before its checkpoint and Phase 10.

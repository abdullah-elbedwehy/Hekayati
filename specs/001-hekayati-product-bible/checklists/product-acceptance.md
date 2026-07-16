# Product Acceptance Checklist: Hekayati

**Purpose**: Final go/no-go verification that the product delivers the specified end-to-end value.
**Created**: 2026-07-14 | **Feature**: [spec.md](../spec.md)

## Foundation & Data

- [ ] CHK001 Customer/family/character/look/pet create/update/archive/restore and immutable version history work and survive app + machine restart; no routine action performs permanent deletion (FR-001/002/010–018, US1)
- [ ] CHK002 Cross-family character selection structurally impossible (FR-003, EC-H02)
- [ ] CHK003 Consent policy distinguishes not-recorded/refused with stable exact codes, stores date+note, and rechecks current state before enqueue and dispatch (FR-004, EC-H01/H14)
- [ ] CHK004 HEIC intake converts, applies orientation, strips GPS/EXIF/IPTC/XMP from every derivative, and retains a structurally provider-ineligible exact original (FR-020/021/025)
- [ ] CHK005 Versioned-policy photo warnings fire with metric/threshold or operator-observation evidence on every seeded fixture; every face photo has a keyboard-defined subject rectangle and multi-face input requires explicit intended-person marking (FR-023/024)
- [ ] CHK006 Character edit offers exactly: project-only / update-base / new-look; per-scene state never mutates profiles (FR-014)
- [ ] CHK027 Possible duplicate characters produce a family-local advisory open-existing/create-separate choice; duplicate names remain valid; no biometric match, auto-merge, or cross-family disclosure (FR-019, EC-A17)

## Creative Pipeline

- [ ] CHK007 Character sheet generates all views bound to versions; compact PDF exports (FR-030/031)
- [ ] CHK008 Character approval + supersede-on-edit flow matches US2-AS3 exactly (FR-032/033)
- [ ] CHK009 @mention picker (thumbnail/name/relationship/role), duplicate-name disambiguation, rename-safety (FR-035/036/039, E6)
- [ ] CHK010 Group mentions expand; zero-member groups block; prose/participant reconciliation warns (FR-038/041)
- [ ] CHK011 Story config covers all FR-045 fields; 7 seed templates present on first run (FR-053)
- [ ] CHK012 Generated story is Egyptian Arabic, page count exact, hidden goal non-preachy on E3 fixture (FR-047/048)
- [ ] CHK013 Single-page regeneration leaves all sibling pages checksum-identical (FR-063, SC-003, E4)
- [ ] CHK014 Locks: locked page immune to side effects; locked+stale flagged (FR-064)
- [ ] CHK015 Version history browsable; revert works; approvals bind to versions (FR-015/066/085)

## Jobs & Providers

- [ ] CHK016 Kill-and-restart mid-generation: completed intact, resume without duplicates (SC-002)
- [ ] CHK017 Quota exhaustion → pause + wait/switch decision + audit record; zero auto-switches (FR-096, SC-009, E5)
- [ ] CHK018 Provider/model provenance recorded on every task and asset (FR-094)
- [ ] CHK019 Mock provider supports full demo of US1–US7 without any AI account (FR-099)

## Outputs

- [ ] CHK020 Exact-snapshot preview PDF: A4/tolerance page boxes, customer-view cover proofs + canonical 16/24 interiors, watermark/footer every page, hash-pinned deterministic ~150-DPI derivatives, hard ≤16 MB @24pp ready/send gate, embedded Arabic fonts, zero egress/prohibited features (FR-120/124, SC-007)
- [ ] CHK021 Split preview-cycle/content-approval heads bind exact customerContentHash + PreviewOutput/cycle/gate evidence; stale action fails; visible change invalidates authorization. 009 guard failure at materialization creates zero job, while later failure commits no artifact/head; IM-19 continuity and IM-20 exact-repair semantics match the matrix (FR-085/086, C-26, SC-010)
- [ ] CHK022 Interior PDF passes preflight; Arabic golden corpus passes (SC-006/008)
- [ ] CHK023 Cover blocked without spine width/template; produced correctly with printer template (FR-122, US7-AS2/3)
- [ ] CHK024 Exact `HekayatiArchive/v2` export→fresh import preserves the complete real 003–009 graph after expected ID/hash/job normalization, excludes unrelated data/secrets/paths, and verified project/customer deletion removes every target link/zero-ref managed file while preserving shared refs; 010 proves a synthetic 011 seam and 011/Phase 10 repeats the real Studio delta (US9)
- [ ] CHK025 Complete Arabic RTL journey usable at 1440×900 (SC-012); quickstart walkthrough completes as written (SC-001)
- [ ] CHK026 Single Image Studio: one image without a book project; history + download; no Project/Story/Page created; book approvals untouched (FR-140–146, SC-013, US11, E8)

## Notes
- Every item must map to passing automated tests where feasible; manual items require recorded evidence (screenshots/proof prints).

# Product Acceptance Checklist: Hekayati

**Purpose**: Final go/no-go verification that the product delivers the specified end-to-end value.
**Created**: 2026-07-14 | **Feature**: [spec.md](../spec.md)

## Foundation & Data

- [ ] CHK001 Customer/family/character/look/pet CRUD works and survives app + machine restart (FR-001/002/010–015, US1)
- [ ] CHK002 Cross-family character selection structurally impossible (FR-003, EC-H02)
- [ ] CHK003 Consent gate blocks generation with exact reason; consent recording stores date + note (FR-004, EC-H01)
- [ ] CHK004 HEIC intake converts, applies orientation, strips GPS EXIF (FR-020/021)
- [ ] CHK005 Photo-quality warnings fire on seeded bad-photo fixtures; multi-face requires person marking (FR-023/024)
- [ ] CHK006 Character edit offers exactly: project-only / update-base / new-look; per-scene state never mutates profiles (FR-014)

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

- [ ] CHK020 Preview PDF: watermark every page, downsampled, ≤16 MB @24pp (SC-007)
- [ ] CHK021 Approval invalidation on any customer-visible change; print blocked until re-approval (FR-086, SC-010)
- [ ] CHK022 Interior PDF passes preflight; Arabic golden corpus passes (SC-006/008)
- [ ] CHK023 Cover blocked without spine width/template; produced correctly with printer template (FR-122, US7-AS2/3)
- [ ] CHK024 Export/import round-trip full fidelity; deletion removes media from disk (US9)
- [ ] CHK025 Complete Arabic RTL journey usable at 1440×900 (SC-012); quickstart walkthrough completes as written (SC-001)
- [ ] CHK026 Single Image Studio: one image without a book project; history + download; no Project/Story/Page created; book approvals untouched (FR-140–146, SC-013, US11, E8)

## Notes
- Every item must map to passing automated tests where feasible; manual items require recorded evidence (screenshots/proof prints).

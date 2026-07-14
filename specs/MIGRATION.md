# Mega-Spec Split Migration Map

## Preservation and authority

The original `specs/001-hekayati/` artifact set was renamed intact to `specs/001-hekayati-product-bible/`. All 20 original artifacts remain the canonical source of requirement wording and shared design. Stale path literals were updated; the concurrently added Single Image Studio changes were preserved and mapped to slice 011, while brand clarification C-16 was mapped to slice 002. No original artifact moved to a leaf spec and no stable ID was renumbered.

Feature slices are primary delivery and verification owners. A slice does not override its linked bible text. Any behavior change updates the bible first, then every affected slice.

## User stories and functional requirements

| Slice | User-story ownership | Primary FR ownership |
|---|---|---|
| 002 | Shared platform under all journeys | FR-093, FR-097, FR-110, FR-130–133, FR-135, FR-137–138, FR-147–148 |
| 003 | US1; data prerequisites for US2 | FR-001–004, FR-010–025 (defined IDs, including FR-018/019/025) |
| 004 | US3, US10 | FR-035–041, FR-045–053, FR-055–060 |
| 005 | US8; provider portion of US4 | FR-090–091, FR-094–095, FR-098–103, FR-105–108, FR-134 |
| 006 | Durable orchestration portion of US4 | FR-092, FR-096, FR-109, FR-111–114 |
| 007 | US2, creative portion of US4, US5 | FR-030–033, FR-062–066, FR-070–073, FR-075, FR-115–119 |
| 008 | US6 | FR-080–083, FR-085–087, FR-120, FR-124 |
| 009 | US7 | FR-121–123 |
| 010 | US9 | FR-005, FR-125–129 |
| 011 | US11 | FR-140–146 |

This partition owns all 120 current FR IDs exactly once. Numeric gaps remain intentional. Interface consumers still cite the primary requirement: for example, 002 consumes provider provenance FR-094; 004 implements the project-context FR-014(a)/IM-04 destination defined by 003; 009 consumes book-assembly FR-057 and watermark FR-124; 010 owns deletion FR-005 while 003 supplies the affected entities; 011 consumes consent, provider, scheduler, style, and safety rules from 003/005/006/007.

## Success criteria and clarifications

| Slice | Primary SC evidence | Primary clarification ownership |
|---|---|---|
| Bible/shared | SC-001 | — |
| 002 | SC-012, SC-014 | C-01, C-02, C-16–17 |
| 003 | — | C-13, C-18–21 |
| 004 | — | C-11, C-23–25 |
| 005 | SC-004 | — |
| 006 | SC-002, SC-009 | C-09 |
| 007 | SC-003, SC-011 | C-05, C-08, C-10 |
| 008 | SC-007, SC-010 | C-03, C-06, C-14 |
| 009 | SC-006, SC-008 | C-04, C-12 |
| 010 | SC-005 | C-07 |
| 011 | SC-013 | C-15 |

Cross-feature evidence remains required: SC-005 includes logs, credentials, and archives; SC-011 includes character approval and page locks; SC-012 is rechecked during the shared end-to-end gate.

## Shared matrices, risks, and edge cases

The canonical invalidation matrix remains one file because cascades cross feature boundaries. Primary trigger/evidence routing is:

| Slice | IM rows | RR rows | EC groups/cases |
|---|---|---|---|
| Bible/shared | — | RR-13, RR-15 | — |
| 002 | IM-18, IM-20 | RR-08, RR-12, RR-17 | EC-C07; EC-E07, E09–E10, E13; EC-H05–H06, H09–H13 |
| 003 | IM-01–03, IM-05, IM-21 | RR-18 | EC-A01–A04, A08, A17; EC-H01–H02, H14 |
| 004 | IM-04, IM-16 | — | EC-A05–A07, A16; EC-B11–B12 |
| 005 | IM-17 | RR-01, RR-02, RR-04 | EC-D01–D02, D04–D08, D13–D15, D17–D18 |
| 006 | — | RR-09, RR-16 | EC-D03, D09, D11–D12, D16; EC-E01–E06, E08, E12 |
| 007 | IM-06, IM-08–10, IM-13 | RR-03, RR-07, RR-10 | EC-A09–A15; EC-B01–B10, B13; EC-C01–C02, C04–C06; EC-D10 |
| 008 | IM-07, IM-11–12, IM-19 | RR-14 | EC-C03, C08–C10; EC-F11–F12 |
| 009 | IM-14–15 | RR-05, RR-11 | EC-F01–F10, F13–F14 |
| 010 | — | RR-06 | EC-E11; EC-G01–G13; EC-H03–H04, H07–H08 |
| 011 | Outside the matrix by FR-145 | No dedicated RR | EC-C11–C13 |

All IM-01–21, RR-01–18, and 115 current EC IDs are accounted for. Slice 007 owns implementation verification of the shared book invalidation engine across every row; slice 011 proves it emits none of those book events.

## Checklist evidence

| Checklist | Primary slice routing |
|---|---|
| Product CHK001–027 | 003: 001–006 and 027; 007: 007–008 and 012–015; 004: 009–011; 006: 016–017; 005: 018–019; 008: 020–021; 009: 022–023; 010: 024; 002/shared: 025; 011: 026 |
| AI CHK101–120 | 005: 101–105, 111–115, 119–120; 006: 106–110, 116–118 |
| Privacy CHK201–227 | 005: 201–203, 207 plus provider contribution to 220; 002: 204–205, 212–214, 222–226 plus foundation contribution to 220 and first-run portion of 215; 003: 206, 208, 210, 216, 227 plus upload contribution to 220; 010: 209, 217–219 plus export contribution to 220 and export-screen evidence for 215; 004: 211 |
| Print CHK301–318 | 009, with 008 supplying layout/preview inputs |
| UX CHK401–427 | 002: 401–405, 414, 416, 420–424, 426; 003: 427 plus slice rechecks of 401–405/420–424; 004: 406–409; 006: 410–412; 007: 413, 419; 005: 415; 010: 417–418; 011: 425 |

All 119 checklist IDs retain their canonical wording in the bible.

## Research, gates, and master tasks

| Slice | Research/gates | Master task routing |
|---|---|---|
| Bible/shared | Gate consolidation and integrated release | T-P0-08; T-P10-01–08 |
| 002 | R1, R2, R4, R8, R13 | T-P1-01–11 |
| 003 | Character/photo portions of data model and R4/R12 intake decision | T-P2-01–06, T-P2-10, T-P2-12 |
| 004 | Story/template portions of data model | T-P3-01–09 |
| 005 | R5–R7; G1-T, G1-I, G2, G4; provider side of R12 | T-P0-01–05; T-P4-01–10 |
| 006 | R3 | T-P5-01–09 |
| 007 | Creative side of R12 | T-P2-07–08, T-P2-11; T-P6-01–09 |
| 008 | R9 consumer; G3 consumer | T-P7-01–06 |
| 009 | R9, R10; G3 | T-P0-06–07; T-P8-01–07 |
| 010 | R11 | T-P2-09; T-P9-01–06 |
| 011 | Consumer of R12, provider capabilities, and scheduler contracts | T-P6-10–12 |

All 98 master task IDs remain in the bible. Phase preconditions, checkpoints, definitions of done, and the P0/P10 cross-feature gates remain authoritative there.

## Shared artifacts retained in the bible

- Product vision, gift-first rule, v1 scope/out-of-scope list, assumptions, examples E1–E8, all 11 user-story narratives, independent tests, and acceptance scenarios.
- Integrated plan, architecture decisions, technical constraints, and project structure.
- Research R1–R13, capability matrix, and feasibility gates G1-T, G1-I, G2, G3, G4.
- Complete data model, provider/structured-output/scheduler contracts, state machines, invalidation matrix, edge catalog, risk register, test strategy, quickstart, checklists, and master tasks. Readiness additions retain stable IDs: 003 added FR-018/019/025, C-18–21, IM-21, RR-18, EC-A17/H14, CHK027/227/427, and T-P2-11/12; 004 adds C-23–25 and T-P3-09 while tightening the shared project/template/story/scene model.

These stay shared to avoid divergent contracts, copied privacy rules, competing state machines, or inconsistent cross-feature invalidation behavior.

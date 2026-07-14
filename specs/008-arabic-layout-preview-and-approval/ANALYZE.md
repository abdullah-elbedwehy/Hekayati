# Analyze Report: 008 Arabic Layout, Preview, and Approval

**Date**: 2026-07-15
**Verdict**: PASS — ready for implementation
**Master tasks**: T-P7-01–T-P7-06
**Feasibility**: G3 PASS; no live provider, Gemini credential, or G2/G4 capability fact is required

## Scope and dependency result

Slice 007 is complete and supplies reviewed page/version lineage, locks, pending layout work, the durable scheduler, content-addressed assets, and the closed invalidation table. Slice 008 now owns the complete customer-composition → Arabic layout → protected preview → exact approval → immutable print-authorization handoff. Feature 009 remains the consumer for printer geometry, full-resolution print PDFs, watermark absence, and executed guard checks.

Pending feature 012 Flow work is outside this approved slice. Imported illustrations can later enter the same page-version and review ports without changing any 008 contract.

| Area | Analyze result |
|---|---|
| Scope | PASS — FR-080–083/085–087/120/124 and US6 are owned without absorbing printer production |
| Model | PASS — Project-v2 migration, operational/content hash separation, strict layout/cover/output/cycle/action/snapshot contracts, and revisioned heads are specified |
| Geometry | PASS — A4 profile and exact portrait/dimension/safe-containment predicate separate approved composition from printer mechanics |
| Cover | PASS — closed source/text policy, exact source refs, readiness, edit API and customer proofs precede approval; 009 performs printer-only mapping |
| Locks/review | PASS — story layout pins exact approved review; special pages require none; initial locked derivation preserves creative state and lock-only revisions change no content hash |
| Layout | PASS — deterministic presets, quietness/contrast tie-breaks, typography floors, aids, overflow, and speaker fallback are closed |
| Durability | PASS — canonical local-job union, automatic `layout_pending` → `pdf_pending`, fencing, rename-before-metadata commit, restart and fault behavior are specified |
| PDF/security | PASS — page-box checks, escaped offline rendering, bundled assets, hash-pinned ~150-PPI derivatives, hard ≤16 MB, zero egress and rendered evidence are required |
| Approval | PASS — split preview-cycle/content-approval heads, ready cycle/gate, strict scopes, action ledger, positive/negative gate semantics and multi-cycle behavior are closed |
| Invalidation | PASS — one original transaction/receipt, full pre-009 emitter audit (IM-06/08/09/11/12/13/19/20), waiting-gate cancellation and reason-specific IM-19/20 behavior are routed |
| 009 handoff | PASS — strict snapshot exposes customerContentHash/contentAuthorizationHash; initial block creates zero job and later block commits no artifact/head |
| Tests/UI | PASS — 16 acceptance scenarios and 40 checklist items cover unit, integration, fault, rendered PDF, three-width RTL accessibility, privacy, and staged scans |

## Traceability

| Requirement / criterion | Slice evidence route |
|---|---|
| FR-080–083 | A-008-01–06; 008-C07–C18; T-P7-01–03 |
| FR-085–087 | A-008-11–15; 008-C26–C34; T-P7-05 |
| FR-120 / FR-124 | A-008-07–10; 008-C19–C25; T-P7-04 |
| US6 / SC-008 | A-008-01–16; 008-C01–C40; T-P7-06 checkpoint |
| SC-007 | 008 proves complete-preview size and watermark coverage; 009 must prove print watermark absence |
| SC-010 | 008 proves the authorization guard and mismatch-zero-work contract; 009 must prove every print producer consumes it |
| IM-06/07/08/09/11/12/13/14/18/19/20 | A-008-12–15; 008-C30–C34; real producer/repository/participant/replay tests |
| RR-14 / RR-19 | 008-C20–C29, C37–C40; hostile-resource, stale-preview, fault, and redaction evidence |
| CHK020–021 / CHK228 / CHK309–314 / CHK428 | Mapped into 008-C20–C40 and implementation notes evidence |

Every owned requirement reaches a master task and acceptance/checklist evidence. Every T-P7 task cites its governing FR/SC/EC/checklist IDs. No owned requirement is dropped or privately reworded away from the bible.

## Blocking findings resolved during readiness

1. Numeric `bookVersion` alone could not distinguish multiple previews or a watermark-only rerender. Separate current-preview/current-cycle/current-content-approval heads plus exact output/cycle/gate evidence now prevent action borrowing or authorization loss.
2. Creating customer-visible cover content in 009 made approval circular. Versioned front/back cover composition and proof pages now precede approval; 009 performs printer-only mapping.
3. Printer geometry was unavailable when layout became approved. A versioned A4 customer CompositionProfile now owns visible geometry; compatible print mechanics remain IM-14, while incompatible input requires explicit migration and re-approval.
4. A locked page could precede its first layout. PageLayoutHead is now a separate downstream head, preserving the locked Page and creative versions byte-for-byte.
5. Layout/preview/approval lineage was insufficient. Story review, special source-policy/selection, text refs, source checksums, derivative policy, cycle/gate and action ledger are now explicit; operational revisions are separated from customer-visible hashes.
6. The 007 invalidation implementation could not safely post-process 008 artifacts. One assembled participant registry now applies all consequences in the original event transaction and replays the frozen receipt.
7. Several real upstream emitters were absent. The checkpoint now audits/completes every pre-009 producer affecting 008, explicitly IM-06/08/09/11/12/13/19/20, before claiming matrix coverage.
8. Preview readiness lacked geometry/security completeness and used ambiguous file/DB ordering. It now checks every page box, exact fonts/map/PPI/marks/features/size/egress and promotes the file before one fenced metadata transaction.
9. Local deterministic jobs existed in code but not the canonical scheduler contract. The request/target union, descriptor resolution, provider bypass and local retry/recovery semantics are now normative.
10. Approval actions had no durable idempotency record and negative gate completion could unblock print. BookApprovalAction is append-only; only approval succeeds, while changes requested cancels the gate and revokes same-content prior authorization.
11. Mutable preview/attention/project revisions would have broken IM-19. `customerContentHash` compares preview content; `contentAuthorizationHash` adds immutable approval evidence and excludes operational/status/attention fields.
12. IM-20 attention risked becoming permanent invalidation. The guard blocks referenced checksum failure and permits byte-identical repair/reverification without claiming different content was approved.
13. Guard timing was ambiguous. Materialization failure creates zero job; an existing job rechecks before execution/commit and can retain history while committing no artifact/current head.

## Alternatives rejected

- Bind approval only to `bookVersion`: cannot distinguish same-version previews or watermark changes.
- Create the cover during print production: introduces visible post-approval content and a circular invalidation cycle.
- Lay out directly against a guessed printer profile: violates parameterized printer truth and permits silent composition changes.
- Store layout on the locked Page record: makes initial downstream derivation mutate frozen creative state.
- Consume invalidation in a second 008 listener: produces partial receipt hashes and timing-dependent consequences.
- Retry with a lower-quality preview policy until the file fits: hides a failed hard gate and changes the approved render contract.
- Let 009 read current heads: permits stale approval to authorize different content.
- Use one approval pointer for both pending previews and print authorization: a watermark rerender would erase a still-valid approval.
- Hash mutable revisions/status/attention into authorization: lock-only and IM-19 changes would falsely invalidate unchanged content.
- Treat every IM-20 alert as permanent reapproval: contradicts the matrix's attention semantics when exact bytes are restored and verified.

## Readiness gates

- Specify: PASS — owned IDs, boundaries, exact delivery contract, and 16 acceptance scenarios are explicit.
- Clarify: PASS — C-26 and C-27 close exact-preview and geometry ambiguities; no open clarification marker remains.
- Plan: PASS — implementation boundaries, transactions, jobs, APIs, UI, security, failure recovery, and test-first order are specified.
- Checklist: PASS — 008-C01–C40 cover model through release evidence.
- Tasks: PASS — T-P7-01–T-P7-06 retain stable master IDs and trace to requirements/checkpoint evidence.
- Analyze: PASS — no unresolved contradiction, missing requirement route, feasibility blocker, or user decision blocks implementation.

Implementation is authorized by the approved full-delivery graph and may proceed in T-P7 order. This PASS does not claim SC-007 or SC-010 globally complete; their explicit print-side halves remain gated on feature 009.

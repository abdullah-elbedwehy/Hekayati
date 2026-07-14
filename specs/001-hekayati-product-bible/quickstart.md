# Quickstart: Hekayati (Operator Guide)

**Feature**: `001-hekayati` | Audience: the single employee-operator (and the developer validating phases). Final UI is Arabic; this guide is written in English for the spec set, with UI strings shown in Arabic.

## Prerequisites (one-time)

1. macOS (Apple Silicon or Intel), ≥20 GB free disk (health screen warns below 10 GB).
2. Node.js LTS (installer or `brew install node`).
3. Ghostscript (`brew install ghostscript`) — only needed for CMYK printer profiles.
4. Optional, for Codex text mode: a current compatible Codex CLI logged in with the ChatGPT subscription account (`codex login`). Phase 0 passed on CLI 0.144.3 with exact model `gpt-5.5`; the same CLI rejected configured `gpt-5.6-sol` despite listing it in the catalog. Hekayati never reads or copies this login and disables that exact model when its direct health probe fails.
5. Optional, for Gemini mode: a Gemini API key (entered later in Settings; stored in macOS Keychain).
6. **Strongly recommended**: FileVault ON; Time Machine or equivalent — Hekayati has **no automatic backup** (the app reminds you: «لا يوجد نسخ احتياطي تلقائي»).

## Install & run

```bash
git clone https://github.com/abdullah-elbedwehy/Hekayati.git && cd Hekayati
npm ci
npm run app     # builds if needed, starts server on 127.0.0.1, opens the browser UI
```

The app refuses to start unless its effective listener is the literal address `127.0.0.1`. Use the launcher-opened `http://127.0.0.1:<port>` URL; `localhost`, custom hostnames, proxies, and cross-origin access are intentionally rejected. An app restart rotates the browser-request token, so a tab left open across restart may require one reload. Data lives at `~/Library/Application Support/Hekayati/` (DB, derived/generated `assets/`, and private local-only photo `originals/`). To stop: Ctrl-C; all committed product state survives restarts.

## First-run

- Seven seed story templates are installed automatically.
- Open «الإعدادات» → choose text/image providers, run «اختبار الاتصال», confirm model availability. Economy image model shows a persistent consistency warning.
- Health screen («الحالة») must show: DB ok, disk ok, bind 127.0.0.1, provider status.

## First book (happy path)

1. «العملاء» → new customer: name, WhatsApp, **record the photo-consent decision** with its date and note. Not recorded and recorded refusal are distinct states; either blocks photo-bearing generation while description-only work remains available.
2. Create the family and choose its relationship anchor; add characters using photos (HEIC is accepted; intake shows the local quality checklist, warnings, and subject selection when needed) or description only; add looks and pets. Use «أرشفة» / «استعادة» for routine removal—permanent deletion is a separate confirmed workflow.
3. New project → pick main child + participants with narrative roles → occasion, dedication, template (e.g., «مغامرة الفضاء»), 16 pages, tone, illustration style, optional hidden goal.
4. Generate character sheets → export sheet PDF → send via WhatsApp yourself → record approval («موافقة» / «تعديلات مطلوبة» + notes).
5. Start generation. Watch the queue («قائمة المهام»): progress, blocking reasons, pause/resume/cancel/retry/priority. You can work on another project meanwhile. If quota runs out you'll be asked: wait, or continue remaining pages on the other provider — nothing switches by itself.
6. Review pages: checklist per page (face, age, outfit, participant count…), consistency view vs the approved sheet, edit scene text with @mentions (`@أحمد`…), regenerate single pages, lock approved pages.
7. After page review, Hekayati automatically lays out the exact reviewed snapshot, prepares customer-view cover proofs, persists `pdf_pending`, then validates one watermarked small preview. Download that exact file, send it via WhatsApp yourself, and record «تم إرسال المعاينة» then approval/changes against the shown preview version. A stale/non-current file cannot be approved; any visible change invalidates it and requires a new cycle.
8. Configure the printer profile (trim/bleed/DPI/color; **spine width or printer cover template is mandatory for the cover**) → produce interior + cover PDFs → preflight must pass → send files to the printer.
9. **Before your first real customer order**: print one physical proof and check Arabic shaping, colors, margins, spine (risk RR-05/RR-11).
10. After delivery: «تصدير» the project ZIP for archiving (pauses generation first; the export is **not** a backup).

## Phase-validation walkthroughs (developer)

Each implementation phase in `tasks.md` ends with a checkpoint runnable from this guide's corresponding step using the **mock provider** («مزوّد تجريبي») — no AI account needed until Phase 4 live validation.

## Troubleshooting quick table

| Symptom                                   | Where to look                                                |
| ----------------------------------------- | ------------------------------------------------------------ |
| Generation blocked `PHOTO_CONSENT_NOT_RECORDED` | Customer card → record a dated consent decision (FR-004) |
| Generation blocked `PHOTO_CONSENT_NOT_GRANTED` | Customer card → review the recorded refusal; never bypass it (FR-004) |
| Jobs paused "quota exhausted"             | Queue banner → wait or switch decision (FR-096)              |
| Cover blocked "spine width unknown"       | Printer profile → spine/template (FR-122)                    |
| Model unavailable error                   | Settings → model IDs + connection test (FR-098)              |
| Missing asset flagged                     | Health → integrity scan → per-asset regenerate (FR-097)      |
| App won't start "bind"                    | Another process on the port, or non-loopback config (FR-110) |
| App won't start `UNOWNED_DATA_ROOT`        | Choose an empty Hekayati data folder; never point the override at an existing unrelated directory |
| Local tab shows a stale-request error      | Reload the launcher-opened `127.0.0.1` URL (FR-148)          |
| Request rejected for host/origin           | Remove proxy/custom hostname; use the exact launcher URL (FR-147, FR-148) |

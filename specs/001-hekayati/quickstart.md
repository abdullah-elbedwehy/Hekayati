# Quickstart: Hekayati (Operator Guide)

**Feature**: `001-hekayati` | Audience: the single employee-operator (and the developer validating phases). Final UI is Arabic; this guide is written in English for the spec set, with UI strings shown in Arabic.

## Prerequisites (one-time)

1. macOS (Apple Silicon or Intel), ≥20 GB free disk (health screen warns below 10 GB).
2. Node.js LTS (installer or `brew install node`).
3. Ghostscript (`brew install ghostscript`) — only needed for CMYK printer profiles.
4. Optional, for Codex mode: Codex CLI installed and logged in with the ChatGPT subscription account (`codex login`). Hekayati never touches this login; it only invokes the CLI.
5. Optional, for Gemini mode: a Gemini API key (entered later in Settings; stored in macOS Keychain).
6. **Strongly recommended**: FileVault ON; Time Machine or equivalent — Hekayati has **no automatic backup** (the app reminds you: «لا يوجد نسخ احتياطي تلقائي»).

## Install & run

```bash
git clone <repo> && cd Hekayati
npm install
npm run app     # builds if needed, starts server on 127.0.0.1, opens the browser UI
```

The app refuses to start if it cannot bind to 127.0.0.1 exclusively. Data lives at `~/Library/Application Support/Hekayati/` (DB + assets). To stop: Ctrl-C; all state survives restarts.

## First-run

- Seven seed story templates are installed automatically.
- Open «الإعدادات» → choose text/image providers, run «اختبار الاتصال», confirm model availability. Economy image model shows a persistent consistency warning.
- Health screen («الحالة») must show: DB ok, disk ok, bind 127.0.0.1, provider status.

## First book (happy path)

1. «العملاء» → new customer: name, WhatsApp, **record photo consent** (generation is blocked without it).
2. Create the family; add characters: upload photos (HEIC fine; intake shows the photo-quality checklist and warnings) or description-only; add looks; add pets.
3. New project → pick main child + participants with narrative roles → occasion, dedication, template (e.g., «مغامرة الفضاء»), 16 pages, tone, illustration style, optional hidden goal.
4. Generate character sheets → export sheet PDF → send via WhatsApp yourself → record approval («موافقة» / «تعديلات مطلوبة» + notes).
5. Start generation. Watch the queue («قائمة المهام»): progress, blocking reasons, pause/resume/cancel/retry/priority. You can work on another project meanwhile. If quota runs out you'll be asked: wait, or continue remaining pages on the other provider — nothing switches by itself.
6. Review pages: checklist per page (face, age, outfit, participant count…), consistency view vs the approved sheet, edit scene text with @mentions (`@أحمد`…), regenerate single pages, lock approved pages.
7. «معاينة PDF» → watermarked, small file → send via WhatsApp → record customer approval. Any visible change afterwards invalidates the approval and requires a new preview.
8. Configure the printer profile (trim/bleed/DPI/color; **spine width or printer cover template is mandatory for the cover**) → produce interior + cover PDFs → preflight must pass → send files to the printer.
9. **Before your first real customer order**: print one physical proof and check Arabic shaping, colors, margins, spine (risk RR-05/RR-11).
10. After delivery: «تصدير» the project ZIP for archiving (pauses generation first; the export is **not** a backup).

## Phase-validation walkthroughs (developer)

Each implementation phase in `tasks.md` ends with a checkpoint runnable from this guide's corresponding step using the **mock provider** («مزوّد تجريبي») — no AI account needed until Phase 4 live validation.

## Troubleshooting quick table

| Symptom | Where to look |
|---|---|
| Generation blocked "consent not recorded" | Customer card → consent toggle (FR-004) |
| Jobs paused "quota exhausted" | Queue banner → wait or switch decision (FR-096) |
| Cover blocked "spine width unknown" | Printer profile → spine/template (FR-122) |
| Model unavailable error | Settings → model IDs + connection test (FR-098) |
| Missing asset flagged | Health → integrity scan → per-asset regenerate (FR-097) |
| App won't start "bind" | Another process on the port, or non-loopback config (FR-110) |

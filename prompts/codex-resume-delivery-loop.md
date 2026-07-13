# Codex — Resume Delivery Loop (continue as if nothing stopped)

Paste this when Codex stopped mid-run. It must resume seamlessly from repo state.

---

## RESUME NOW

You were running the Hekayati **full delivery loop** (`prompts/codex-full-delivery-loop.md`). You stopped mid-work. **Continue exactly where you left off. Do not restart from scratch. Do not re-ask completed questions. Do not redo finished slices.**

### Recovery steps (do these first, then continue the loop)

1. Read `LOOP_STATE.md` if it exists. That is the source of truth for Done / Current / Next / Blocked.
2. Read `git status`, `git branch -vv`, `git log --oneline -15`. Infer what was already committed/pushed.
3. Read the current slice folder under `specs/` (whatever `LOOP_STATE` says is Current, or the first incomplete in dependency order).
4. Check for partial work: uncommitted files, open `IMPLEMENTATION_NOTES.md`, `ANALYZE.md`, `BLOCKER.md`, failing tests, half-scaffolded `src/`.
5. Resume the **exact interrupted stage**:
   - If specs incomplete → continue Spec Pipeline (specify → clarify → plan → checklist → tasks → analyze)
   - If specs ready / analyze passed → continue Implement Pipeline
   - If impl mid-flight → finish remaining tasks, verify, commit, push
   - If commit done but not pushed → push
   - If slice done but Next not started → start Next slice
6. If `LOOP_STATE.md` is missing: reconstruct it from git + which slices have `IMPLEMENTATION_NOTES.md` / green checkpoints / code ownership, then continue.

### Rules while resuming

- Treat this message as the same authorization as the original full-delivery prompt (commit, push, implement, Spec Kit stages).
- Do **not** summarize the whole project history unless needed to pick the next action.
- Do **not** wait for confirmation to continue. Only stop for a true clarify blocker or failed hard gate.
- Preserve all existing user and agent changes. No destructive git.
- Keep Citrus Playground + Impeccable/frontend-design rules for UI.
- Update `LOOP_STATE.md` after every meaningful advance.

### First output (one short block, then work)

```text
RESUMED
Current: <slice or P0/P10>
Stage: <spec|clarify|plan|tasks|analyze|implement|verify|commit|next>
Last evidence: <commit hash or files>
Next action: <one sentence>
```

Then immediately perform that next action and keep the master loop running until Phase 10 complete or a true blocker.

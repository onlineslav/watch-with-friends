# Dev log

## 2026-11-02 — M1 Measured performance (workflow 70b2e5c)

- Run started. Codex is off in `workers.json`, so builds go to `workflow-builder` (Sonnet).
- Aya's uncommitted notes in `todo.md` and the untracked `AGENTS.md` (an old copy of CLAUDE.md from Sep 26) were left
  alone. New notes were filed as B1 in `docs/BUGS.md` and under **Later** in `docs/TODO.md`; notes already built
  (simultaneous shares, whiteboard, Ableton window audio, sending the log) were skipped.
- `docs/PLAN.md` doesn't exist; the milestone's Must work list stands in for it.
- M1.2 verified (69ca220, workflow-builder, 1 attempt after a usage-limit pause; ~260k tokens). Sample cost 1.39ms host / 0.98ms viewer, down from 4.2/4.0ms.
- M1.1 verified (3c8609d, 7c26f5e; workflow-builder, 2 attempts; audit 2 MEDIUM + 1 LOW, all fixed). Worker deployed (version 7a1a52ac), 0.8.0 uploads checked. ~410k tokens incl. pre-mortem and audit.
- M1.3 verified (74c20e0; workflow-builder, 1 attempt, ~180k tokens). Not yet tried on a real session.
- M1.4 verified (72b4e3f; workflow-builder, 1 attempt, ~320k; pre-mortem 3 HIGH merged; audit found the bench sound and traced the share's −650ms to app-audio timestamps from 0 and the viewer's mono to a one-sided SDP patch: both moved to M1.5/M1.6). Aya (2026-11-03): no more questions, build everything, full sweep at the end.
- M1.9 verified (56e0306, cf6aa73; workflow-builder, 2 attempts, ~490k; audit 2 MEDIUM + 3 LOW, 4 fixed). M1.5 built (3877b63, ~205k): film +42→+16.5ms, share fixed; whole-app worker on the page clock.
- M1.5 needs Aya (bench: film −2.7ms, share +20.4ms medians over 3 runs; wide per-run spread noted).
- M1.10 released 0.8.1 (tag → 20b3a54 after 3 CI fixes making the sample-cost check report-only on CI runners).
- M1.6 needs Aya (9a0d3aa, d60c6b4; 2 attempts; viewers now stereo; v0.8.0 compat 8/8). M1.11 built (05fa480): second/third file audible again (was silent since ≤0.8.0).
- M1.11 verified (3 attempts; attempt 3 by workflow-builder-strong, ~340k). Also fixed: SDP growth that dropped viewers at ~7 films (pre-existing).
- M1.7 parts 1–3 done (cadf4d8, da7c8f7, 8469cdb, 88de987, b411068; ~477k); smoothness left. M1.12 filed (Loop may go silent).

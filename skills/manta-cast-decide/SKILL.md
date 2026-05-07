---
name: manta-cast-decide
description: Pre-cast self-check for the main agent. Do I actually need clones? Do I have the budget and cooldown? Which mode?
audience: main
version: 0.0.1
related: []
---

# manta-cast-decide

## Purpose

You're the main agent. The user gave you a task. Before you `/manta cast`, run this skill: every cast costs charges, money, and your own context. Many "feels parallel" tasks are actually serial and a single agent will do them faster + cheaper.

## Allowed

- **Run the four-question gate**:
  1. Does the task read **>5 files in different layers** of the repo? → recon-swarm candidate.
  2. Are there **≥ 2 unobvious architectural alternatives**? → forking-realities (Phase 2+).
  3. Is the task a **same-pattern migration across N places**? → refactor-wave (Phase 2+).
  4. Is it a **multi-layer bug** with unknown root cause? → bug-hunt (Phase 2+).
  - If none match: do it solo. Skip the cast.
- **Cooldown** (50 s between casts per spec Sec 6.1) is **operator discipline** in Phase 0 — there is no automatic gate. Read `/manta status`; if the previous cast hasn't settled (any clone still WORKING), wait. Phase 3 ships enforcement via the charge ledger.
- **Cost gates** in Phase 0 are interim:
  - `--budget-per-clone-usd` (default $5) caps per-clone spend.
  - `--budget-per-cast-usd` (default $15) caps cumulative spend; the CLI rejects `cloneCount × per-clone > per-cast` before spawning.
  - These prevent the dumbest accidents but do **not** track actual spend (no token-counting yet) and do **not** enforce a daily cap. A daily-spend env gate (`MANTA_DAILY_BUDGET_USD`) lands in Phase 1; the full charge ledger lands in Phase 3.
- **Run dry-run** (Phase 1+ feature, deferred).

## Forbidden

- **Casting "to be safe".** A speculative cast is wasted charges. If you can't articulate why parallel beats serial, do it serial.
- **Skipping the four-question gate** because the task "feels big." Big ≠ parallelizable.
- **Recursive cast** from the main's own pre-cast check. The check itself is a solo decision.
- **Casting unsupported modes in Phase 0.** Only `recon-swarm` ships in Phase 0; the CLI rejects others. Don't try.

## Examples

Task: "Document every public API in this codebase."

- Q1: > 5 files? Yes (every file potentially). Q2: alternatives? No, just discovery. Q3: same pattern? Roughly. Q4: bug? No.
- Verdict: **recon-swarm**, 3 clones, each takes a top-level subdir, produces `docs/api-<subdir>.md`.

Task: "Why does the integration test flake on CI but not locally?"

- Q1: probably 5 files. Q2: alternatives? Yes — fix the test, fix the underlying race, mark flaky. **Phase 2+**: forking-realities. **Phase 0**: do it solo and revisit with FR once Phase 2 ships.

Task: "Rename `User.email` to `User.emailAddress` everywhere."

- Q3 hits cleanly: same-pattern migration. **Phase 2+ refactor-wave**. **Phase 0**: solo with `rg`+`sed` + tests.

Task: "Add a feature flag to the auth middleware."

- None of Q1-Q4 hit cleanly. Solo. Skip the cast.

---
name: manta-cast-decide
description: Pre-cast self-check for the main agent. Do I actually need clones? Am I within my subscription's usage/rate limit and cooldown? Which mode?
audience: main
version: 0.0.1
related: []
---

# manta-cast-decide

## Purpose

You're the main agent. The user gave you a task. Before you `/manta cast`, run this skill: every cast burns charges, eats into your Claude Code subscription's usage/rate limit, and costs your own context. Claude Code is a **subscription** (Pro/Max), not pay-per-token — so the constraint is never dollars; it's how much of your **usage/rate budget** you spend and how many clones you run **in parallel**. Many "feels parallel" tasks are actually serial and a single agent will do them faster with less usage.

## Allowed

- **Run the four-question gate**:
  1. Does the task read **>5 files in different layers** of the repo? → recon-swarm candidate.
  2. Are there **≥ 2 unobvious architectural alternatives**? → forking-realities (Phase 2+).
  3. Is the task a **same-pattern migration across N places**? → refactor-wave (Phase 2+).
  4. Is it a **multi-layer bug** with unknown root cause? → bug-hunt (Phase 2+).
  - If none match: do it solo. Skip the cast.
- **Cooldown** (50 s between casts per spec Sec 6.1) is **operator discipline** in Phase 0 — there is no automatic gate. Read `/manta status`; if the previous cast hasn't settled (any clone still WORKING), wait. Phase 3 ships enforcement via the charge ledger.
- **Usage/rate self-check** — the real question is "am I within my subscription's usage budget?", never "can I afford the dollars?" (there are none). Ask:
  - **Rate**: how many casts have I started this hour? `--max-casts-per-hour` (default 6) is a hard ceiling, and the charge ledger gates frequency on top of it. If you're near the cap or in cooldown, wait — exhausting your Claude Code usage limit blocks you for *hours*.
  - **Parallelism**: how many clones at once? `--max-parallel-clones` (default 5) caps it. More clones in parallel drains your rate limit faster; spawn the fewest that actually parallelize.
  - **Token estimate** (optional): `--max-tokens-estimate` sets a per-cast usage-estimate ceiling. It's a rough proxy for subscription usage, **not** a dollar figure.
  - Inspect current usage with `manta cost` (casts/clones/rate this window) and `manta charges` (charges + cooldown). Nothing here is denominated in dollars.
- **Run dry-run** (`--dry-run`) to preview usage without spawning.

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

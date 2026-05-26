---
name: manta-merge-review
description: Guide for the main agent to interpret merge-review output and promote a winner from forking-realities casts
audience: main
version: 0.0.1
related:
  - manta-cast-decide
  - manta-as-clone
---

# manta-merge-review

## Purpose

After a `forking-realities` cast completes and all clones are DEAD, the CLI automatically generates `docs/merge-reviews/<castId>.md` with a scored ranking of all candidates. This skill describes how the main agent reads the review, interprets scores, and promotes a winner.

## Allowed

- Read merge-review documents from `docs/merge-reviews/<castId>.md`.
- Override the scoring engine's recommendation when domain knowledge suggests the lower-scored candidate is better.
- Promote any clone in the roster, not just the top-ranked one.
- Inspect individual worktree branches before promoting to validate solution quality.
- Re-run merge-review if metrics look stale (e.g. after manual fixes in a worktree).

The merge-review document contains:

1. **Verdict** — `auto_merge_eligible` | `manual_review_required` | `no_candidates_passed_gate` | `dominance_inversion_flagged`.
2. **Score table** — per-candidate normalized scores on 6 axes (coverage, diff, complexity, typeCheck, lint, perf) plus composite score.
3. **Disqualified section** — candidates whose test suite failed.
4. **Tie-break explanation** — axis priority → Pareto dominance → self-certainty → defer to main.
5. **Weight adjustments** — agentic rubric pre-pass adjustments based on project config.
6. **Proposed merge command** — the exact `git merge` command.

Promote via `/manta promote <castId>/<cloneId>`. This merges the winner's branch (`--no-ff`), graveyards loser worktrees, removes the winner worktree, and emits a `promote` event.

## Forbidden

- Auto-promoting without reading the review.
- Ignoring `dominance_inversion_flagged` verdicts — they indicate weight mis-calibration.
- Promoting from a cast that has no merge-review event (the command will reject this).

## Examples

A typical merge-review flow:

1. Cast completes: `manta cast forking-realities --clones 3 --task "implement feature X"`.
2. All clones die. CLI auto-generates `docs/merge-reviews/cast-123456.md`.
3. Read the review: clone B scores 0.82, clone A scores 0.79, clone C disqualified (test failure).
4. Verify: `git diff main...manta/cast-123456/B` — confirm the diff is sane.
5. Promote: `/manta promote cast-123456/B`.
6. Result: B's branch merged, A's worktree moved to graveyard, C's worktree moved to graveyard.

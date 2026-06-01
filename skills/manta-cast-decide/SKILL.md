---
name: manta-cast-decide
description: Pre-cast self-check for the main agent. Do I actually need clones? Which of the 9 modes? Am I within my subscription's usage/rate limit? Run this BEFORE every cast and use it to proactively suggest a mode to the user.
audience: main
version: 0.1.0
related: [manta-orchestrate]
---

# manta-cast-decide

## Purpose

You're the main agent (the user's Claude Code orchestrator). A task arrived. Before you `manta cast`,
run this skill: every cast eats into your Claude Code subscription's usage/rate limit and costs your own
context. Claude Code is a **subscription** (Pro/Max), not pay-per-token — the constraint is never
dollars, and there are no charges or cooldowns; it's how much of your **subscription's usage** you spend
and how many clones you run **in parallel** (the one hard cap, `--max-parallel-clones`). Many "feels
parallel" tasks are actually serial and a single agent does them faster with less usage.

This skill does two jobs: (1) decide *whether* to cast, and (2) pick *which mode*. Use it reactively
(before a cast) **and** proactively — when you spot a task shape below mid-conversation, suggest the
mode to the user ("this looks like a refactor-wave across ~12 files — want me to cast it?").

## Allowed

Run this three-step gate. It's a solo decision — never a cast itself.

### Step 1 — Should this be a cast at all?

Cast only if at least one is true:

- The task reads/touches **> 5 files across different layers** of the repo.
- There are **≥ 2 unobvious approaches** worth building in parallel and comparing.
- It's a **same-pattern change repeated across N places**.
- It's a **multi-layer bug** with an unknown root cause.
- It's a **> 10-minute implementation** with a clear, self-contained contract.

Do it **solo** (skip the cast) if: the task is < 10 minutes, surgical, already in your context, or you
can't articulate why parallel beats serial. Big ≠ parallelizable.

### Step 2 — Which mode? (all 9 ship today)

Pick the mode whose shape matches the task. Each maps to a clone-side skill the clone auto-loads.

| Mode | Cast when… | Clones | Output shape |
|---|---|---|---|
| **recon-swarm** | mapping / discovery / "where does X live" across many files | 2–5, each takes a subtree | read-only findings → ZK notes, PARA facts, a map doc |
| **bug-hunt** | a bug (or a well-scoped implementation task) with a clear contract | 1–N | a fix/feature on a branch, committed |
| **refactor-wave** | same mechanical change across N **disjoint** locations | 2–5, partitioned | each clone owns a partition; no overlap, merges clean |
| **forking-realities** | ≥ 2 architectural alternatives — you want to *compare*, not guess | 2–N competing | rival branches + `docs/merge-reviews/cast-<id>.md`; **you** pick the winner, no auto-merge |
| **pair-programming** | one risky/subtle change worth a tight writer↔reviewer loop | 2 (writer + reviewer) | reviewed change on a branch |
| **test-storm** | build a feature **and** its test wall together | 3 (coder + tester + fuzzer) | implementation + unit + property/boundary tests |
| **documentation-chase** | turn existing code into docs | 1–N, each a doc area | markdown in `docs/` only, no source edits |
| **council** 🔒 | a hard *judgment* call — want N independent opinions (wisdom of crowds) | 3–5 independent proposers | N reasoned proposals; **you** aggregate by hand, no auto-merge |
| **decoy** 🔒 | you want a *draft* to react to, not a finished artifact | ≤ 2 | a DRAFT deliverable you review/edit/finalize |

🔒 **`council` and `decoy` are Aghs-locked** (higher-power modes). A cast is rejected unless the operator
opted in: `.manta/config/budget.json` → `aghs.unlocked: ["council","decoy"]`, or the
`MANTA_UNLOCK_AGHS` env var. If you want one and it's locked, tell the user how to unlock — don't retry blindly.

**`phantom-lance` (recursive self-cast) does NOT ship** — `manta cast phantom-lance` is rejected as "not
supported". Don't suggest it.

### Step 3 — Usage self-check (before you spawn)

The real question is "am I within my subscription's usage?", never "can I afford the dollars?" (there
are none — no charges, no cooldown, no dollar budget). Check:

- **Parallelism**: how many clones at once? `--max-parallel-clones` (default 5) is the one hard cap. More
  parallel clones drain your subscription's rate limit faster and load your machine harder — spawn the
  fewest that actually parallelize. Exhausting your Claude Code usage limit blocks you for *hours*.
- **Serial casts**: don't pile casts back-to-back. If the previous cast hasn't settled (`manta status`
  shows a clone still WORKING), wait for it before launching the next.
- Use **`--dry-run`** to preview the plan (modes, clone count, scope) without spawning.

### Long session? Force full inheritance.

The whole point of Manta is a **warm** clone — it boots from a fork of your live transcript, so it
already knows what you and the user worked out. There's a safe **default** auto-fork threshold (~2 MB,
tunable via `--distill-threshold-bytes`) so a cast doesn't blindly copy a huge transcript across every
clone; above it the clone boots cold **with a loud warning** (never silently). For a long, context-rich
session where inheritance is the point, pass **`--force-full-transcript`** — it forks the entire
transcript regardless of size (proven on an 18 MB session: the clone recalled the conversation). Use it
whenever the task depends on what was just discussed.

## Forbidden

- **Casting "to be safe".** A speculative cast is wasted usage. Can't articulate why parallel beats
  serial? Do it serial.
- **Skipping Step 1** because the task "feels big." Big ≠ parallelizable.
- **Recursive cast from this check.** The pre-cast decision is always a solo decision.
- **Blind-retrying a locked Aghs mode.** If `council`/`decoy` is rejected, surface the unlock path instead.

## Examples

**"Document every public API in this codebase."** → discovery + docs. Two good fits: `recon-swarm` (3
clones map subtrees → findings) or `documentation-chase` (clones write `docs/` directly). Pick
documentation-chase if you want finished markdown; recon-swarm if you first need the map. **Proactive:**
"That's a documentation-chase across ~4 areas — cast 4 clones?"

**"Why does the integration test flake on CI but not locally?"** → multi-layer bug, unknown root cause →
`bug-hunt`. If there are genuinely rival fixes (fix the test vs fix the race vs mark flaky) and you want
to compare them, `forking-realities` instead.

**"Rename `User.email` to `User.emailAddress` everywhere."** → same-pattern, disjoint locations →
`refactor-wave`, partition by directory. **Proactive:** "~15 call sites across 3 packages — refactor-wave
with 3 clones, one per package?"

**"Should we use Postgres or DynamoDB for the event store?"** → a hard judgment call with independent
viewpoints worth gathering → `council` (🔒 if locked, suggest unlocking). You aggregate the proposals.

**"Add a feature flag to the auth middleware."** → none of Step 1 hits cleanly, < 10 min. **Solo. Skip the cast.**

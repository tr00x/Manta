# Manta benchmarks

> **Status: harness only — no results yet.** This directory contains the
> methodology, task fixtures, and a runner skeleton. **It ships with ZERO
> measured numbers.** Every cell in [`RESULTS.md`](./RESULTS.md) is `— (run to
> fill)` until someone actually runs the harness. Do not cite a number from here
> that you did not produce yourself.

## The question

Manta's claim is that **Clone Driven Development** — cloning the agent that
already understands your problem — beats the alternatives on real work. This
harness exists to test that claim honestly, by measuring three methods on the
**same tasks**:

| Method | What it is |
|---|---|
| **manta** | `manta cast <mode>` — clones inherit the caster's transcript, work in parallel on real branches, you merge |
| **subagents** | Claude Code's built-in `Agent` tool — fresh, cold-context helpers spawned for the same task |
| **solo** | one Claude Code session doing the whole task itself, no delegation |

It is entirely possible that for some tasks Manta does **not** win (e.g. trivial
single-file changes — see `manta-cast-decide`). An honest benchmark must be able
to show that. If every cell said "Manta wins" it would be marketing, not data.

## Metrics

Per (task × method × repeat):

| Metric | How it's measured | Why |
|---|---|---|
| **wall-clock** | seconds from start to the method declaring done | speed |
| **tests pass** | the task's objective success check (a test or grep) returns 0 | did it actually work — the only metric that gates the rest |
| **diff size** | `git diff --shortstat` lines changed | smaller correct diff = better |
| **usage** | token-estimate consumed (`manta cost` for the manta arm; your own accounting for the others) | subscription cost, not dollars |

Only runs where **tests pass** count toward speed/diff/usage comparisons — a fast
wrong answer is not a win.

## Non-determinism — repeat, don't trust one run

Claude is non-deterministic: the same prompt can succeed once and fail the next
time, and timings vary. **Run ≥ 3 repeats per cell** and report the distribution
(median + pass-rate), never a single number. A method that passes 1/3 is not
comparable to one that passes 3/3 even if its one success was faster.

## How to run

```bash
# from the repo root, with `claude` authenticated and the manta-bus MCP registered
MANTA_BENCH=1 bash docs/benchmarks/run.sh            # all tasks, manta arm, 3 repeats
MANTA_BENCH=1 bash docs/benchmarks/run.sh recon-map  # one task only
```

The runner's **manta arm actually invokes `manta cast`**. The **subagents and
solo arms are documented stubs** — they print exactly what to run and where to
record the result, because driving the `Agent` tool / a solo session
programmatically is environment-specific (you wire it to your own harness). See
[`run.sh`](./run.sh) for the contract and [`tasks/`](./tasks/) for the fixtures.

Record outcomes in [`RESULTS.md`](./RESULTS.md). Keep raw logs out of git
(they're large and contain transcripts).

## Honesty rules (hard)

1. **No fabricated numbers.** A cell is either a number you measured or
   `— (run to fill)`.
2. **Report failures.** If Manta loses or ties, the table says so.
3. **State the environment** (machine, claude version, model, date) next to any
   results you publish — timings are meaningless without it.
4. **Pass-rate first.** Lead with how often each method produced a passing
   result; speed/usage are secondary and only counted on passing runs.

# Manta — worked examples

End-to-end walkthroughs for the modes you'll reach for most. Each one is a real,
copy-pasteable `manta cast …`, what you'll see while it runs, and how you harvest
the result. Commands use the **current** CLI flags (usage-aware, not dollars).

| Example | Mode | Shape of the work |
|---|---|---|
| [recon-swarm](./recon-swarm.md) | `recon-swarm` | Map an unfamiliar codebase, read-only — clones write audit docs |
| [bug-hunt](./bug-hunt.md) | `bug-hunt` | A multi-layer bug (or a scoped implementation task) → a committed fix |
| [refactor-wave](./refactor-wave.md) | `refactor-wave` | The same change across many disjoint files |
| [forking-realities](./forking-realities.md) | `forking-realities` | Two rival approaches, scored → you promote the winner |

## The flags every example uses

Claude Code is a **subscription**, so Manta's guardrails are usage / rate /
parallelism — never dollars:

| Flag | Meaning |
|---|---|
| `-n, --clones <n>` | how many clones (1..5) |
| `-t, --task "<…>"` | the task handed to every clone |
| `--allowed-paths <csv>` | paths clones may write (comma-separated) |
| `--forbidden-paths <csv>` | paths clones must not touch |
| `--max-files-changed <n>` | per-clone write cap (`0` = read-only) |
| `--max-parallel-clones <n>` | cap on clones running at once |
| `--max-casts-per-hour <n>` | rolling-hour cast-rate cap |
| `--max-tokens-estimate <n>` | per-cast usage ceiling (token-estimate proxy) |
| `--dry-run` | preview usage without spawning |
| `--force-full-transcript` | inherit the full parent transcript regardless of size |

> There is **no** `--budget-per-clone-usd` / `--budget-per-cast-usd` /
> `--daily-cap-usd` — those dollar flags were removed (Claude Code is a
> subscription). If a guide shows them, it's stale.

## What you see while a cast runs

`manta status` — DEAD clones are hidden by default (they're finished history):

```text
Clone | Mode         | State           | Heartbeat age | Locks                | Claims
------+--------------+-----------------+---------------+----------------------+----------------------
A     | recon-swarm  | WORKING         | 3s            | -                    | -
B     | recon-swarm  | WORKING         | 5s            | -                    | -

↑ "Clone" is the id. Stop one: `manta kill <id>` (e.g. `manta kill A`) · stop all: `manta abort` · details: `manta inspect <id>`  [live: A, B]
```

The compact statusline (in Claude Code's status bar) shows the `⧉` Manta marker
while a cast is live, nothing when idle:

```text
⧉ A▶WORKING B▶WINDING_DOWN · 1.2M/5M · 4m
```

`manta status --all` adds the settled (DEAD) clones back if you want the history.

## Precondition

`manta cast` runs from **inside a Manta-enabled git checkout** (it ships with the
plugin; the clones each load the `manta-as-clone` skill from disk and the cast
does `git worktree add`). Casting from an arbitrary empty directory isn't
supported.

Not sure a task is worth casting? Load the `manta-cast-decide` skill first — the
rule of thumb is **cast if it's > ~10 min, spans many files, has independent
parts, or has rival approaches; otherwise do it solo.**

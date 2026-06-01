# Example — `forking-realities`: rival approaches, scored

**When:** there are ≥ 2 plausible approaches and you want them **built** and
**compared**, not guessed. Each clone implements the task its own way on its own
branch; Manta scores the branches and writes a merge-review; **you** promote the
winner. No auto-merge.

## Cast it

```bash
manta cast forking-realities \
  --clones 2 \
  --task "Migrate the config loader to zod: parse + validate all config at startup, fail loud on bad config, keep the public getConfig() shape." \
  --allowed-paths "src/config,tests" \
  --max-files-changed 12
```

To make the clones explore *different* strategies, give them per-clone overlays
with `--tasks <file.yaml>` (each entry is a partial assignment; missing fields
fall back to the cast-level `--task`):

```yaml
# approaches.yaml
A:
  approach_hint: "one flat zod schema validated at startup"
B:
  approach_hint: "per-module schemas composed into one, lazy-validated on first read"
```

```bash
manta cast forking-realities --clones 2 \
  --task "Migrate the config loader to zod (see contract)" \
  --tasks approaches.yaml \
  --allowed-paths "src/config,tests" --max-files-changed 12
```

## What you see

```text
$ manta status
Clone | Mode             | State           | Heartbeat age | Locks                | Claims
------+------------------+-----------------+---------------+----------------------+----------------------
A     | forking-realities| WORKING         | 6s            | src/config/load.ts   | -
B     | forking-realities| WORKING         | 5s            | src/config/load.ts   | -

↑ "Clone" is the id. Stop one: `manta kill <id>` (e.g. `manta kill A`) · stop all: `manta abort` · details: `manta inspect <id>`  [live: A, B]
```

The clones work **independently** — they can't see each other's work-in-progress
(sibling messaging is denied in this mode), so you get genuinely independent
realities to compare.

## Harvest — read the merge-review FIRST

When all clones are DEAD, Manta auto-generates a scored merge-review. **Read it
before touching git:**

```bash
cat docs/merge-reviews/<castId>.md      # verdict + per-candidate score table
```

The review scores the rival branches against your real quality gate (typecheck +
lint + tests) plus diff size/complexity, and gives a verdict (e.g.
`manual_review_required`, `auto_merge_eligible`, `no_candidates_passed_gate`).
The `manta-merge-review` skill explains how to read it.

Then promote the winner — this merges its branch `--no-ff` and graveyards the
losers:

```bash
manta promote <castId> --clone A     # promote a specific clone, or
manta promote <castId>               # promote the merge-review's pick
```

You can promote any clone in the roster, not just the top-ranked one, when your
domain knowledge overrides the score. Cherry-pick the loser's good ideas
deliberately, then `manta recover`.

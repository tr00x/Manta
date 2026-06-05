# bug-hunt — parallel investigation mode

`bug-hunt` spawns 1–2 clones to investigate the same bug from different
layers of the codebase. Unlike `forking-realities`, clones are
**complementary, not competing** — each explores a different angle and
shares intermediate findings with its sibling.

## When to use

- Multi-layer bug where the root cause could live in API, DB, or infra.
- Flaky test that depends on timing or cross-module interaction.
- Production incident where you want parallel evidence gathering.
- Any bug where two investigation angles are better than one.

**Not suited for:** single-file typos (fix directly), pure performance
issues (use `recon-swarm` to map hotspots first), or bugs that need a
competing-solutions approach (use `forking-realities` instead).

## How it works

1. You describe the bug and assign investigation layers via `--tasks`.
2. Manta spawns 1–2 clones, each with its own worktree and layer
   assignment.
3. Clones investigate their layer: read source, trace data flow, check
   error handling.
4. Clones **share findings** via `manta.broadcast` — peer messaging is
   `allowed` by default.
5. Each clone reads sibling findings via `manta.read_broadcasts` to
   cross-reference.
6. Each clone writes an investigation report (markdown) committed to its
   branch.
7. After both clones finish, Manta reports the paths to their
   investigation reports. **No merge-review** is produced — the reports
   are complementary, not competing.

Claude Code is subscription-based, so there are no per-cast charges — the
only cast limit is `--max-parallel-clones` (how many clones run at once).

## CLI examples

Basic 2-clone bug hunt:

```bash
manta cast bug-hunt \
  --clones 2 \
  --task "Investigate auth timeout in src/auth.ts" \
  --tasks investigation-plan.yaml
```

Where `investigation-plan.yaml`:

```yaml
A:
  task: "Investigate the API layer: trace request lifecycle from route handler to auth middleware"
  approach_hint: "Focus on middleware chain, timeout config, and error propagation"
B:
  task: "Investigate the DB layer: check connection pool and query timeouts"
  approach_hint: "Focus on pool exhaustion, slow queries, and lock contention"
```

Single-clone investigation (simpler bugs):

```bash
manta cast bug-hunt \
  --clones 1 \
  --task "Investigate memory leak in the WebSocket handler"
```

Validate without spawning (`--dry-run` checks the mode, clone count, and
scope, then exits — no clones are launched):

```bash
manta cast bug-hunt --clones 2 --task "..." --dry-run
```

## Investigation report format

Each clone produces a freeform markdown report with these recommended
sections (guided via priming, not enforced):

| Section | Contents |
|---------|----------|
| **Symptom** | Observable behavior and reproduction steps |
| **Findings** | What the investigation uncovered — code paths, logs, data |
| **Root Cause Hypothesis** | Best theory based on evidence |
| **Proposed Fix** | Concrete code changes (if identified) |
| **Cross-Layer Dependencies** | Connections to sibling clone's layer |

Reports are committed to each clone's worktree branch. After the cast,
inspect them with:

```bash
git log --oneline main..manta/<cast-id>/A
git log --oneline main..manta/<cast-id>/B
```

## Tips

- **Layer assignment matters.** Give each clone a distinct scope — "API
  layer" vs "DB layer", "client code" vs "server code", "auth module"
  vs "session module".
- **Use approach_hint** to steer investigation direction without
  over-constraining.
- **Read the broadcast log.** Clones share intermediate findings; the
  cross-references often surface the root cause faster than either
  clone alone.
- **Max 2 clones.** The spec caps bug-hunt at 2 — more clones add
  coordination overhead without proportional investigation value.
- **No merge needed.** Reports are read-only deliverables. If a clone
  proposes a fix, cherry-pick it manually after review.

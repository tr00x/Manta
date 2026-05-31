# `recon-swarm` — How it works

The `recon-swarm` mode batch-spawns N independent clones, each given a slice of the codebase via `taskContract.scope`, and each producing a structured artifact (a markdown map, a list of files, a per-feature summary). The clones do not talk to each other beyond filtered broadcasts; they don't merge. The main agent (you) reads the post-mortems and ZK notes and stitches the picture together.

## When to use it

Use the `manta-cast-decide` skill before casting. Recon-swarm is the right call when:
- The task reads >5 files spread across different layers.
- The work decomposes cleanly by directory or feature (each clone gets a sub-tree).
- You want a *map*, not a *change* — recon-swarm clones are recommended to run with `max_files_changed: 0` (read-only).

It's the **wrong** call for:
- Architectural alternatives (use `forking-realities`).
- Same-pattern migrations (use `refactor-wave`).
- Tracking down a specific bug (use `bug-hunt`).

## Lifecycle of a clone in recon-swarm

1. **CLI spawn** — `manta cli` creates the worktree, builds a `Snapshot`, writes the `task_contract` to the bus, starts a `claude --print` subprocess pointing at the worktree.
2. **Register** — the spawner pre-registers the clone in the Bus *before* launching the `claude` process. This is verified by the behavioural fixture in `packages/manta-cli/tests/spawner/startup-sequence.test.ts`. On launch the clone reads its contract via `MANTA_SNAPSHOT_PATH`, acks via `manta.ack_contract`, and heartbeats — its registry record already exists.
3. **Work** — read files within `scope.allowed_paths`, never write outside `forbidden_paths`, heartbeat every ≤ 10 s.
4. **Broadcast** — `breakthrough` / `blocker` / `dependency` only; bus traffic is for actionable events.
5. **Knowledge dump** — atomic `manta.zk_write` notes and `manta.para_append` facts before exit.
6. **Graceful death** — `manta.suicide_intent` then `manta.report_death`; exit 0.
7. **Orchestrator post-mortem** — markdown report under `docs/post-mortems/`.

If the clone exits without `report_death`, the orchestrator detects the stale heartbeat and writes the post-mortem itself with reason `heartbeat … ms ago > …`.

## Usage & time budget

- **Usage per clone**: each clone carries an internal per-clone token-estimate budget automatically (Claude Code is a subscription, not pay-per-token — there are no per-clone dollar flags). Cast-wide usage is capped by `--max-parallel-clones` and `--max-casts-per-hour`.
- **Time per clone (TTL)**: hard ceiling 20 min via `taskContract.deadline_ms`; soft ceiling 25 min via the cast's `--tick-budget-ms`.
- **Charges / cooldowns**: see [docs/user/charge-system.md](./charge-system.md) for how casts are rate-limited. Watch your usage manually.

## Reading the output

Each clone leaves three artifact families:

| Artifact | Purpose | Where |
|---|---|---|
| Worktree branch | Optional file changes (recon clones are typically read-only) | `.manta/worktrees/clone-<id>/` |
| Post-mortem | Lifecycle record + event timeline | `docs/post-mortems/` |
| ZK notes | Atomic insights | `docs/zk/` |
| Cast manifest | Cast-level mode + roster + policy | `.manta/state/casts/<castId>.json` |

* A cast manifest at `.manta/state/casts/<castId>.json` — see
  [docs/user/cast-manifest.md](./cast-manifest.md). Same file is written for
  every cast mode; nothing recon-swarm-specific.

To stitch a unified map: read each post-mortem's "Event timeline" section to see what the clone explored, then read its ZK notes for distilled findings.

# `recon-swarm` — How it works

The `recon-swarm` mode batch-spawns N independent clones, each given a slice of the codebase via `taskContract.scope`, and each producing a structured artifact (a markdown map, a list of files, a per-feature summary). The clones do not talk to each other beyond filtered broadcasts; they don't merge. The main agent (you) reads the post-mortems and ZK notes and stitches the picture together.

## When to use it

Use the `manta-cast-decide` skill before casting. Recon-swarm is the right call when:
- The task reads >5 files spread across different layers.
- The work decomposes cleanly by directory or feature (each clone gets a sub-tree).
- You want a *map*, not a *change* — recon-swarm clones are recommended to run with `max_files_changed: 0` (read-only).

It's the **wrong** call for:
- Architectural alternatives (use `forking-realities` once Phase 2 ships).
- Same-pattern migrations (use `refactor-wave`).
- Tracking down a specific bug (use `bug-hunt`).

## Lifecycle of a clone in recon-swarm

1. **CLI spawn** — `manta cli` creates the worktree, builds a `Snapshot`, writes the `task_contract` to the bus, starts a `claude --print` subprocess pointing at the worktree.
2. **Register** — the spawner registered the clone *before* the process started, so on launch the clone reads its contract and acks via `manta.ack_contract`.
3. **Work** — read files within `scope.allowed_paths`, never write outside `forbidden_paths`, heartbeat every ≤ 10 s.
4. **Broadcast** — `breakthrough` / `blocker` / `dependency` only; bus traffic is for actionable events.
5. **Knowledge dump** — atomic `manta.zk_write` notes and `manta.para_append` facts before exit.
6. **Graceful death** — `manta.suicide_intent` then `manta.report_death`; exit 0.
7. **Orchestrator post-mortem** — markdown report under `docs/post-mortems/`.

If the clone exits without `report_death`, the orchestrator detects the stale heartbeat and writes the post-mortem itself with reason `heartbeat … ms ago > …`.

## Cost & time budget

- **Budget per clone**: default $5 in dollars (`--budget-per-clone-usd`).
- **Time per clone (TTL)**: hard ceiling 20 min via `taskContract.deadline_ms`; soft ceiling 25 min via the cast's `--tick-budget-ms`.
- **Charges / cooldowns**: not enforced in Phase 0. Watch your spend manually.

## Reading the output

Each clone leaves three artifact families:

| Artifact | Purpose | Where |
|---|---|---|
| Worktree branch | Optional file changes (Phase-0 typically read-only) | `.manta/worktrees/clone-<id>/` |
| Post-mortem | Lifecycle record + event timeline | `docs/post-mortems/` |
| ZK notes | Atomic insights | `docs/zk/` |

To stitch a unified map: read each post-mortem's "Event timeline" section to see what the clone explored, then read its ZK notes for distilled findings.

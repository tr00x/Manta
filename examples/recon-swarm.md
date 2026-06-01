# Example — `recon-swarm`: map an unfamiliar codebase

**When:** you need to understand code before changing it. Read-only — clones
explore and each writes an audit document; nothing merges. You get the map
without spending your own context window spelunking.

## Cast it

```bash
manta cast recon-swarm \
  --clones 2 \
  --task "Map the auth and billing subsystems: entry points, data flow, and where a new feature would hook in. Write findings to docs/audits/<area>.md" \
  --allowed-paths "docs/audits" \
  --max-files-changed 3
```

- `--clones 2` — one clone per subsystem.
- `--allowed-paths "docs/audits"` + `--max-files-changed 3` — clones may write
  only audit docs, nothing else. (A read-only-er variant uses
  `--max-files-changed 0`, but then clones report via ZK notes / post-mortems
  instead of files.)

## What you see

```text
$ manta status
Clone | Mode         | State           | Heartbeat age | Locks                | Claims
------+--------------+-----------------+---------------+----------------------+----------------------
A     | recon-swarm  | WORKING         | 4s            | -                    | -
B     | recon-swarm  | WORKING         | 6s            | -                    | -

↑ "Clone" is the id. Stop one: `manta kill <id>` (e.g. `manta kill A`) · stop all: `manta abort` · details: `manta inspect <id>`  [live: A, B]
```

Watch until both reach `DEAD` (the cast command also returns when the cast
completes). Don't poll in a tight loop — check `manta status` a few times, or
watch the statusline.

## Harvest

Nothing merges. Read what the clones produced:

- `docs/audits/<area>.md` — each clone's write-up (warm: it already knew from
  your conversation what you care about).
- `docs/zk/*.md` — atomic insights clones recorded before dying.
- `docs/post-mortems/<date>-<castId>-<id>.md` — what each clone did + why it died.

Then GC the finished worktrees/branches once you've read the deliverables:

```bash
manta recover    # reap any stale state
```

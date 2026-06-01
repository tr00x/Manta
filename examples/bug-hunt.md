# Example — `bug-hunt`: fix a multi-layer bug

**When:** a bug with an unknown root cause spanning more than one layer, or a
well-scoped implementation task. The clone investigates, fixes, and commits the
change to its branch.

## Cast it

```bash
manta cast bug-hunt \
  --clones 1 \
  --task "Users intermittently get logged out after ~5 min. Find the root cause across the session middleware, the token refresh path, and the cookie config, then fix it. Add a regression test." \
  --allowed-paths "src,tests" \
  --max-files-changed 10 \
  --max-tokens-estimate 400000
```

- `--clones 1` — a single bug usually wants one focused clone, not a swarm.
- `--allowed-paths "src,tests"` — the fix may touch source and tests, nothing else.
- `--max-tokens-estimate 400000` — a per-cast usage ceiling; the cast is rejected
  up front if the estimate exceeds it (a usage proxy, **not** dollars).

## What you see

```text
$ manta status
Clone | Mode         | State           | Heartbeat age | Locks                | Claims
------+--------------+-----------------+---------------+----------------------+----------------------
A     | bug-hunt     | WORKING         | 8s            | src/session.ts       | -

↑ "Clone" is the id. Stop one: `manta kill <id>` (e.g. `manta kill A`) · stop all: `manta abort` · details: `manta inspect <id>`  [live: A]
```

`manta inspect A` shows the clone's contract, the files it has locked, and its
recent events if you want a deeper look while it works.

## Harvest

When the clone reaches `DEAD`, its work is committed on its branch
`manta/<castId>/A`. Review the diff against the contract, then merge:

```bash
git log --oneline manta/<castId>/A ^main      # see the clone's commit(s)
git diff main..manta/<castId>/A               # review the fix
# run your own gate before trusting it — don't take the clone's word:
pnpm gate                                      # (or your project's test command)
git merge --no-ff manta/<castId>/A
```

Read `docs/post-mortems/<date>-<castId>-A.md` for the clone's account of the root
cause and what it changed. Then `manta recover` to clean up.

# Example — `refactor-wave`: the same change across many files

**When:** one mechanical change repeated across N **disjoint** locations — a
rename, an API migration, a lint-rule sweep. Clones partition the work so they
don't collide, each commits its slice.

## Cast it

```bash
manta cast refactor-wave \
  --clones 3 \
  --task "Migrate every call site from the deprecated `logger.log(level, msg)` to the new `logger[level](msg)` API. Keep behavior identical; update tests that assert on the old signature." \
  --allowed-paths "src,tests" \
  --max-files-changed 15 \
  --max-parallel-clones 3
```

- `--clones 3` — three clones split the call sites between them.
- `--max-parallel-clones 3` — allow all three to run at once (the parallelism cap
  protects your subscription's rate limit; raise/lower to taste).
- The clones coordinate through the bus (file locks + work claims) so two clones
  never edit the same file.

## What you see

```text
$ manta status
Clone | Mode         | State           | Heartbeat age | Locks                | Claims
------+--------------+-----------------+---------------+----------------------+----------------------
A     | refactor-wave| WORKING         | 5s            | src/api/users.ts     | users
B     | refactor-wave| WORKING         | 4s            | src/api/orders.ts    | orders
C     | refactor-wave| WORKING         | 7s            | src/jobs/mailer.ts   | jobs

↑ "Clone" is the id. Stop one: `manta kill <id>` (e.g. `manta kill A`) · stop all: `manta abort` · details: `manta inspect <id>`  [live: A, B, C]
```

The `Locks` and `Claims` columns show clones partitioning the work — each owns a
disjoint set, so the merges don't conflict.

## Harvest

Each clone commits its slice to `manta/<castId>/<id>`. Merge them in turn (they're
disjoint, so order doesn't matter), running your gate before trusting each:

```bash
for id in A B C; do git diff main..manta/<castId>/$id; done   # review each slice
pnpm gate                                                      # your own gate
for id in A B C; do git merge --no-ff manta/<castId>/$id; done
manta recover
```

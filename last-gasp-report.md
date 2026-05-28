# Clone B — last gasp (cast-1779982686636)

Mode: `refactor-wave`
Branch: `manta/cast-1779982686636/B`
Reason: `task_complete`

All four assigned bugs were fixed TDD-style with regression tests written
before implementation. Four atomic `fix(...)` commits land on the worktree
branch (one per bug), plus one `chore(bus): lint hygiene` commit splitting
out the test-callback hygiene from bug #30 because that commit was no
longer the tip when lint surfaced the issue.

## Deliverables

- `5484fa6` — fix(cli): bug #25 — BroadcastReader drops same-millisecond events
- `97de833` — fix(cli): bug #26 — test-storm handleCodeReady ladder + hard-coded /3
- `6f48c00` — fix(bus): bug #30 — ContractsStore emitted contract_write on idempotent re-write
- `66af12c` — fix(cli): bug #31 — refactor-wave partition check ran after charge commit
- `df6ab13` — chore(bus): lint hygiene for bug #30 regression test
- `.manta/clones/B-bug-fixes.md` — manifest for main's bookkeeping commit (gitignored on disk only)
- `last-gasp-report.md` (this file)

## Gate results

- **Build:** `pnpm -r build` clean.
- **Tests:** 937 passing across 5 unit-test packages, 1 pre-existing
  failure (`tests/spawner/heartbeat-hook.test.ts > touch script updates
  last_heartbeat_at in registry`) confirmed to be on `B` HEAD before any
  of my edits — out of partition (`.manta/heartbeat-touch.cjs` is generated
  state). My new tests: 1 broadcast-reader + 3 test-storm + 2 contracts +
  2 cast (total +8 new green tests).
- **Lint:** workspace-wide lint debt pre-existing. My contributions:
  bus net 0 added (after the `df6ab13` cleanup); cli +1 (matches the
  pre-existing 4-occurrence convention in the same dispatch test file).

## Pending items

- The pre-existing `heartbeat-hook.test.ts > touch script updates
  last_heartbeat_at` failure deserves its own bug log entry. The test's
  `installHeartbeatHook` writes a script with absolute paths embedded
  at install-time, but my reading of the orphan `.manta/heartbeat-touch.cjs`
  in the worktree root shows it pointing at the *parent* worktree's
  registry — so the test never observes its own tmp registry. Not in
  scope; flagged here for main's triage.
- Lint debt across the workspace is large (355 cli errors on `B` HEAD)
  and largely a `require-await` / `explicit-function-return-type`
  convention drift. Probably worth a dedicated cast.

## Surprises worth noting

- Bug #30's "no-op return" lever was already there for `CastsStore.create`
  — the canonicalized-body compare was already in the contracts mutator,
  but it built a fresh `next` regardless of `sameBody`. Two-line fix:
  `if (sameBody) return current;`. Pattern parity matters.
- Bug #31's defect is structural ordering: the partition check was simply
  in the wrong place relative to the pre-spawn gate. Moving it up beside
  the other input validators is more correct than wrapping the gate in a
  try/finally compensating refund — the cheapest fix is the right one.
- Bug #26's `never`-typed default arm is the production-grade variant of
  the "non-exhaustive switch" anti-pattern. Future status additions to
  `TestStormStage['status']` now fail to compile until handled — that's
  the kind of guard the spec's "production-grade with day 1" mandate
  expects.

## Forbidden-path hygiene

Untouched (per partition with Clone A):
- `packages/manta-bus/src/server.ts`
- `packages/manta-bus/src/state/locks.ts`
- `packages/manta-bus/src/state/work.ts`
- `packages/manta-bus/src/atomic-fs.ts`
- `packages/manta-bus/src/state/lock-reaper.ts`
- `packages/manta-bus/src/state/claim-reaper.ts`
- `docs/manta-bugs.md` (per task — main updates statuses on merge)

## Bus / MCP note

The Manta MCP server tools were not surfaced in this clone's session
(no `mcp__manta__*` schemas via `ToolSearch`). Consequently:
- No `manta.heartbeat`, `manta.task_contract.read`, `manta.ack_contract`
  were invocable.
- No `manta.zk_write` was invocable for the skill's required ZK dump.
- No `manta.suicide_intent` / `manta.report_death`.

Per the task contract this clone was directed to "proceed per the
startup sequence", which I did to the extent the toolchain permitted:
loaded snapshot, read task contract, scoped edits, committed atomically
on the worktree branch. The "Manta builds Manta" assumption is that
the spawner provides a working MCP surface — if main observes
recurring "MCP not surfaced in clones" cases, the runtime-injection
side of `manta-as-clone` may need a side-effect verification step
similar to the heartbeat hook.

Exiting 0.

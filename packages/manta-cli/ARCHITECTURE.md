# manta — Architecture

## Why this package exists

The CLI is the user-facing edge of Manta. Everything else (`@manta/bus`, `@manta/orchestrator`, `@manta/snapshot`) is library code; `manta cast recon-swarm` is the entry point. This package owns: argv parsing, runtime composition (`BusContext` + `Orchestrator`), worktree creation, clone subprocess spawning, the tick loop that drives the orchestrator, output rendering, and exit-code mapping.

## Boundaries

- **In scope:** five commands (`cast` / `status` / `kill` / `abort` / `recover`), runtime composer, worktree wrapper, snapshot builder, clone runner abstraction, tick loop, status table, structured reporter, MCP pre-flight.
- **Out of scope:**
  - Bus protocol — owned by `@manta/bus`
  - Lifecycle policy (death detection, reapers, post-mortems) — owned by `@manta/orchestrator`
  - Snapshot format — owned by `@manta/snapshot`
  - Skills + slash commands — owned by `manta` consumers (Phase 0e)
  - Plugin distribution — Phase 7

## Module map

| File                          | Responsibility                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `errors.ts`                   | `CliError` with typed `kind` + `exitCode`, `isCliError` type-guard                                      |
| `runtime.ts`                  | `createRuntime` — composes `BusContext` + `Orchestrator` from a repo root; validates repo is a git repo |
| `spawner/worktree.ts`         | `addWorktree` / `removeWorktree` / `listWorktrees` via `git worktree`                                   |
| `spawner/snapshot-builder.ts` | `buildCloneSnapshot` — pure builder over `@manta/snapshot.captureState`                                 |
| `spawner/clone-spawner.ts`    | `spawnClone` + `CloneRunner` interface; `runFakeCloneScript` (tests) and `runClaudeCli` (production)    |
| `tick-loop.ts`                | `runTickLoop` — polls `Orchestrator.runCycle` until `allDone` or `AbortSignal`                          |
| `output/status-table.ts`      | `renderStatusTable` — ASCII table from `OrchestratorStatus`                                             |
| `output/reporter.ts`          | Structured logger with `MemorySink` (tests) and `StderrSink` (production)                               |
| `commands/cast.ts`            | `runCastCommand` — composes everything: pre-flight → worktree → snapshot → contract → spawn → tick      |
| `commands/status.ts`          | Trivial wrap over `getStatus` + `renderStatusTable`                                                     |
| `commands/kill.ts`            | `runPostMortem` for one clone (markDead is folded into the post-mortem call for atomicity)              |
| `commands/abort.ts`           | `runPostMortem` for every live clone                                                                    |
| `commands/recover.ts`         | One-shot `runCycle`; wraps orchestrator failures as `recovery_failed`                                   |
| `commands/mcp-preflight.ts`   | `verifyMantaBusRegistered` — shells out `claude mcp list`, fails fast if `manta-bus` not registered     |
| `bin/manta.ts`                | commander wiring; argv → command dispatch; `CliError.kind` → `process.exitCode`                         |

## Design choices

- **One Runtime per command invocation.** Each command builds its own `Runtime` from `process.cwd()`. There is no shared global. This keeps the CLI re-entrant and makes the integration test trivial.
- **Repo-root validation up front.** `createRuntime` rejects with `invalid_input` if `repoRoot/.git` is missing. Catches the "ran `manta` outside a git checkout" foot-gun before scribbling state into a wrong directory.
- **CloneRunner is the test seam.** Production = `runClaudeCli` (spawns `claude --print`). Tests = `runFakeCloneScript` (spawns a Node fixture). Same code path through `spawnClone`, no `if env === 'prod' else mock` per CLAUDE.md / Sec 14.4.
- **Spawn failures are surfaced, not masked.** Execa's `reject: false` collapses ENOENT into a "successful" promise resolution with `failed: true, exitCode == null`. `spawnClone` re-throws those as `CliError(spawn_failed)` so the cast aborts at spawn time instead of waiting for a heartbeat that never lands.
- **Graceful kill with SIGKILL escalation.** `CloneHandle.terminate({ gracefulMs })` sends SIGTERM, then SIGKILL after `gracefulMs` (default 5 s). Used by the cast's failure-recovery path so a hung clone can't block CTRL-C.
- **MCP pre-flight is opt-out.** `runCastCommand` invokes `verifyMantaBusRegistered` by default (production safety). Tests pass `verifyMcp: false` so they don't depend on a real `claude` binary.
- **Cumulative cost gate.** Per-clone × cloneCount must not exceed the per-cast cap (default $15). Rejects 4+ clones at default per-clone $5. Phase-0 interim — Phase 3 charge ledger replaces.
- **Real subprocesses in tests.** `tests/fixtures/fake-clone.mjs` is a real Node script the test spawns via `execa`. This catches argv/env/cwd bugs that mocked execa would mask.
- **Snapshots on disk.** Each spawn writes `${castId}/${cloneId}.snapshot.json` so a debugger can inspect what the clone actually received. Atomic via `serializeSnapshot` (which uses temp+rename per `@manta/snapshot`).
- **Field-name translation at the bus boundary.** `@manta/snapshot.TaskContract` uses camelCase (`cloneId`, `siblingClones`, `deadlineSeconds`); `@manta/bus.TaskContract` uses snake_case (`clone_id`, `sibling_clones`, `deadline_ms`). Centralized in `cast.ts`'s `toBusContract` so a future schema drift surfaces as a single edit.
- **Worktrees stay after a cast.** Phase 0 keeps `clone-${id}` worktrees on disk so the operator can `cd` in and inspect post-mortem state. `manta abort` and Phase 7 `manta exhume` will manage retention.
- **Tick loop is single-shot.** It does not own the lifecycle of the Orchestrator's cycle scheduling — the caller's `allDone` predicate decides termination. This keeps the loop testable without ever spawning real clones.
- **Errors fan-in via `CliError`.** Every command's failure path produces a `CliError`; the bin's top-level catch maps `kind` to exit code. No raw `process.exit(1)` scattered through commands; the bin uses `process.exitCode` so the event loop drains naturally and `rt.dispose()` finishes.
- **Reporter is structured.** Stderr is human-readable but the `MemorySink` lets tests assert events by name. This avoids string-matching fragile log output.

## Test strategy

- **Unit per module** in Chunk 1 (errors, runtime, spawner, tick-loop, output).
- **One test per command** in Chunk 2 covering happy path + at least one error path.
- **End-to-end integration** (`integration.test.ts`) runs `runCastCommand` with the fake runner against a real fixture repo, asserts: clones spawn, exit, end up DEAD; snapshots on disk; bus contracts on disk; post-mortems written; reporter captures `cast.spawn` and `cast.done`.
- **Smoke** of `bin/manta.cjs status` to verify the executable starts cleanly on an empty git repo and on a non-git directory (the I-3 invalid_input path).
- **Coverage** ≥ 80 % on `src/**/*.ts` excluding `src/index.ts` and `src/bin/**`.

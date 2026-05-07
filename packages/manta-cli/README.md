# @manta/cli

Phase-0 CLI for Manta. Five commands: `cast`, `status`, `kill`, `abort`, `recover`. Mode support: `recon-swarm` only (other modes ship in later phases).

## Install

This package is part of the Manta monorepo. Once published as a Claude Code plugin (Phase 7), users run `npx manta@latest install`. Until then, run via `pnpm --filter @manta/cli exec manta <command>` from the monorepo root, or build once and execute the bin directly:

```
pnpm --filter @manta/cli build
node /path/to/manta/packages/manta-cli/dist/bin/manta.cjs <command>
```

## Commands

### `manta cast <mode>`

Spawn N clones of the given mode and run the orchestrator until they all exit.

```
manta cast recon-swarm --clones 3 --task "map the codebase"
```

Options:

- `--clones <n>` — number of clones (1..5; default 2)
- `--task <task>` — task description (passed into each clone's task contract)
- `--cycle-interval-ms <ms>` — orchestrator cycle interval (default 5000)
- `--tick-budget-ms <ms>` — overall budget; the cast aborts after this (default 1_500_000 = 25 min)
- `--budget-per-clone-usd <amt>` — dollar budget per clone (default 5)
- `--budget-per-cast-usd <amt>` — cumulative dollar cap for the whole cast (default 15); rejects with `invalid_input` if `cloneCount × per-clone > per-cast`

Phase-0 caveat: only `recon-swarm` is supported. Other modes throw `invalid_input`.

Pre-flight: before spawning, the cast verifies that `manta-bus` is registered as an MCP server with Claude Code (`claude mcp list`). Without that, `claude --print` clones cannot reach the bus and the cast would time out silently. The check is bypassed for tests via `verifyMcp: false` in the programmatic API.

### `manta status`

Print the orchestrator's snapshot — registered clones, held locks, active claims. Pure read; never mutates state.

### `manta kill <cloneId>`

Mark a single clone DEAD and write its post-mortem. Exits with `not_found` if the clone is unknown. Safe to call on already-DEAD clones (the post-mortem is idempotent and preserves the original `death_reason`).

### `manta abort`

Mark every live clone DEAD and write a post-mortem each. Already-DEAD clones are left untouched.

### `manta recover`

Run one orchestrator cycle. Detects stale heartbeats and orphan parents, reaps stale locks/claims, writes post-mortems for any newly-dead clones. Use after a crash or when cleaning up after a forced kill.

## Errors

Every command throws `CliError` on failure. The bin maps errors to exit codes:

| Kind                  | Exit code |
| --------------------- | --------- |
| `invalid_input`       | 1         |
| `not_found`           | 1         |
| `cast_failed`         | 1         |
| `spawn_failed`        | 1         |
| `orchestrator_failed` | 1         |
| `recovery_failed`     | 1         |
| Other (unwrapped)     | 99        |

Use `isCliError(err)` to type-narrow when calling commands programmatically.

## Programmatic use

Every command is exported as `runXCommand(runtime, options)` so a tester or daemon can call them without spawning the bin.

```typescript
import {
  createRuntime,
  runCastCommand,
  runFakeCloneScript,
  createReporter,
  StderrSink,
} from '@manta/cli';

const rt = await createRuntime({ repoRoot: '/path/to/repo' });
await runCastCommand(rt, {
  mode: 'recon-swarm',
  task: 'audit auth',
  cloneCount: 2,
  cycleIntervalMs: 5_000,
  tickBudgetMs: 1_500_000,
  castId: 'cast-1',
  budgetUsdPerClone: 5,
  budgetUsdPerCast: 15,
  verifyMcp: false, // tests with fake runners
  runner: runFakeCloneScript({ scriptPath: '/path/to/fake-clone.mjs' }),
  reporter: createReporter({ sink: new StderrSink() }),
});
```

## Non-goals (deferred)

- Modes beyond `recon-swarm` — Phase 2+
- Charge / cooldown / budget enforcement — Phase 3
- All other Sec 12 commands (`dry-run`, `inspect`, `tail`, `tell`, `pin`, `swap`, `pause`, `resume`, `recontract`, …) — Phase 1+
- Daemon mode — Phase 5
- npm distribution / `npx manta install` — Phase 7

# Manta — User MCP Tools (native orchestrator control)

The Manta Bus MCP server exposes a set of **user/orchestrator-facing tools** so a
Claude Code orchestrator can drive Manta with **native tool calls** instead of
shelling out to the `/manta:*` slash commands. They **complement** the slash
commands — they do not replace them — and they share the exact same code path:
each tool spawns the proven `manta` CLI binary as a child process and returns its
output. There is zero logic duplication, and `@manta/bus` never imports
`@manta/cli` (that would be a circular dependency — the binary is the seam).

These sit alongside the 25 clone-coordination tools (`manta_register`,
`manta_heartbeat`, …) that clones use to talk to the bus. The user tools are
registered as `manta.cast`, `manta.status`, … and surface to the orchestrator as
`manta_cast`, `manta_status`, … (the MCP tool-call surface namespaces dots to
underscores).

## The tools

| Tool | CLI it runs | Mutating? | Returns |
| --- | --- | --- | --- |
| `manta_cast` | `manta cast <mode> --task … [flags]` | yes (spawns clones) | cast id + output, **non-blocking** |
| `manta_status` | `manta status` | no | raw text (no `--json` mode) |
| `manta_cost` | `manta cost [period]` + `manta charges` | no | both as raw text |
| `manta_inspect` | `manta inspect <id> --json` | no | parsed JSON + raw + exit code |
| `manta_abort` | `manta abort [--reason …]` | yes | raw text |
| `manta_kill` | `manta kill <id> [--reason …]` | yes | raw text |

### `manta_cast`

Spawns a cast — the core verb. Inputs:

- `mode` (required) — one of the 9 castable modes (`recon-swarm`,
  `forking-realities`, `pair-programming`, `test-storm`, `bug-hunt`,
  `refactor-wave`, `documentation-chase`, `council`, `decoy`). `phantom-lance`
  is not castable.
- `task` (required) — the task description handed to every clone.
- `clones` — number of clones (mode-specific bounds apply; default 2).
- `maxParallelClones`, `maxCastsPerHour`, `maxTokensEstimate` — usage caps
  (token-estimate proxy, **not** dollars — Claude Code is subscription-based).
- `allowedPaths`, `forbiddenPaths` — string arrays (joined to CSV for the CLI).
- `maxFilesChanged` — per-clone file-write cap (0 = read-only).
- `dryRun` — preview usage without spawning.

**Non-blocking by design.** A real cast runs the orchestrator tick-loop for as
long as ~25 minutes; `manta_cast` does **not** wait for that. It returns promptly
once the cast has started spawning clones, with the **cast id** parsed from the
launch output (`launched: true`, `exited: false`), and leaves the orchestrator
running in the background. Watch it with `manta_status` and stop it with
`manta_abort`. A `dryRun` or a validation error returns its full output and exit
code instead (`exited: true`).

### `manta_status`, `manta_cost`, `manta_inspect`

Read-only snapshots. `manta_status` and `manta_cost` return raw text (those CLI
commands have no `--json` mode). `manta_inspect` runs `inspect <id> --json` and
returns the parsed JSON alongside the raw text and exit code.

### `manta_abort`, `manta_kill`

Mutating. `manta_abort` marks **every** live clone DEAD with a post-mortem;
`manta_kill` does it for a single clone id. Both accept an optional `reason`.

## Binary resolution

The server locates the `manta` binary in this order:

1. `MANTA_CLI_BIN` env var (explicit override + test seam).
2. The sibling `manta.cjs` next to the server binary (`dist/bin/` plugin layout).
3. Bare `manta` on `PATH` (npm global install).

This works for the plugin, npm, and from-source installs without configuration.

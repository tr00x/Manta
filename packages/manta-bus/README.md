# @manta/bus

Manta Bus — the MCP server that exposes coordination primitives to Manta clones (registration, heartbeats, task contracts, work claims, file locks, filtered broadcasts, direct messages, drift reports, atomic memory writes).

## Tools (MCP names)

| Name | Purpose |
|---|---|
| `manta.register` | Register a clone at spawn |
| `manta.heartbeat` | 10 s liveness signal + state |
| `manta.suicide_intent` | Clone announces self-termination |
| `manta.report_death` | Final last-gasp report path |
| `manta.task_contract.write` | Main writes task contract |
| `manta.task_contract.read` | Clone reads its contract |
| `manta.ack_contract` | Clone acks contract with interpretation |
| `manta.contract_refresh` | Main broadcasts anchor sync |
| `manta.claim_work` | Claim a work item |
| `manta.release_work` | Release the claim |
| `manta.lock` / `manta.unlock` / `manta.renew_lock` | Heartbeat-based file leases |
| `manta.broadcast` | Filtered event (breakthrough / blocker / dependency) |
| `manta.message` | Direct A→B message |
| `manta.drift_report` | Clone reports its own drift score |
| `manta.zk_write` | Atomic ZK note write |
| `manta.para_append` | Append fact to a PARA category |

> **Naming.** The contract tools are conceptually `task_contract read | write`. MCP tool names cannot contain spaces, so the bus encodes them with dots: `manta.task_contract.read` and `manta.task_contract.write`. Payloads are identical either way.
>
> **Caller.** `manta.contract_refresh` is a main-side broadcast for anchor sync. Clones never call it. Clone-side tools: `register`, `heartbeat`, `suicide_intent`, `report_death`, `task_contract.read`, `ack_contract`, `claim_work`, `release_work`, `lock`/`unlock`/`renew_lock`, `broadcast`, `message`, `drift_report`, `zk_write`, `para_append`. Main-side tools: `task_contract.write` and `contract_refresh`.

## Run

```
# From a workspace checkout
node packages/manta-bus/dist/bin/server.cjs
```

> This package is not published standalone. Its `server.cjs` bin is **bundled into the published `manta` npm package** (one self-contained artifact), and `npx manta@latest install` registers it as a user-scope MCP server from the installed path (`claude mcp add -s user manta-bus -- node <installed>/server.cjs`). The `$(pwd)` command above is the **from-source dev path**; npm-installed users never run it by hand.

Set `MANTA_REPO_ROOT` to override the working directory; defaults to `process.cwd()`. Misconfigured `MANTA_REPO_ROOT` (missing or not a directory) exits with code `2`; runtime crashes exit `1`; clean shutdown on `SIGTERM`/`SIGINT` exits `0`.

## State layout

All state lives under `<repo>/.manta/state/`:

- `registry.json` — clone records (heartbeat tracking)
- `locks.json` — heartbeat-based path leases
- `claims.json` — work-item claims with TTL
- `contracts/<clone-id>.json` — per-clone task contracts
- `casts/<cast-id>.json` — cast manifest: mode, roster, policy
- `events.jsonl` — append-only audit log

## Programmatic use

```typescript
import { createBusServer, FakeClock } from '@manta/bus';
const { server, context } = await createBusServer({ repoRoot: '/path/to/repo' });
```

## Errors

Tool errors come back as MCP `isError: true` with a JSON body:

```json
{ "error": "validation_error" | "not_found" | "conflict" | "locked" | "state_error" | "internal_error",
  "message": "...", "details": { ... } }
```

## Versioning

State files include `version: 1`. Forward-incompatible reads are not silently downgraded — they error.

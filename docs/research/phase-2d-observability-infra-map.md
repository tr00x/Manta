# Phase 2d Observability Infrastructure Map

> Recon output — maps what exists for Phase 2d CLI commands (inspect, tail, replay, audit).
> Does NOT design the commands themselves.

---

## Existing Data Sources

### 1. EventsLog (append-only JSONL)

**Location:** `.manta/state/events.jsonl`
**Class:** `packages/manta-bus/src/state/events.ts` → `EventsLog`

**Schema — `BusEvent`:**

| Field     | Type     | Description                           |
|-----------|----------|---------------------------------------|
| `id`      | string   | `<13-digit-ts>-<6-digit-seq>-<rand>` — lex-sortable within process, approximately monotonic cross-process |
| `ts`      | number   | Epoch ms from `Clock.now()`           |
| `type`    | string   | Event type (see taxonomy below)       |
| `clone_id`| string?  | Originating clone (absent for cast-level events) |
| `payload` | unknown  | Type-specific structured data         |

**Event type taxonomy (complete as of Phase 2c):**

| Type              | Source                     | clone_id? | Payload shape |
|-------------------|----------------------------|-----------|---------------|
| `register`        | lifecycle.ts handler       | yes       | full RegisterInput |
| `heartbeat`       | lifecycle.ts handler       | yes       | `{ state, progress }` |
| `suicide_intent`  | lifecycle.ts handler       | yes       | `{ reason }` |
| `death`           | lifecycle.ts handler       | yes       | `{ last_gasp_report_path }` |
| `broadcast`       | communication.ts handler   | yes       | `{ event_type, body, tags }` |
| `message`         | communication.ts handler   | yes (from)| `{ from, to, body }` |
| `drift_report`    | communication.ts handler   | yes       | `{ score, evidence }` |
| `contract_write`  | contract.ts handler        | yes       | full TaskContract |
| `contract_ack`    | contract.ts handler        | yes       | `{ interpretation }` |
| `contract_refresh`| contract.ts handler        | no        | refresh payload |
| `lock`            | locks.ts handler           | yes       | `{ path }` |
| `unlock`          | locks.ts handler           | yes       | `{ path }` |
| `renew_lock`      | locks.ts handler           | yes       | `{ path }` |
| `claim`           | work.ts handler            | yes       | `{ item, timeout_ms }` |
| `release`         | work.ts handler            | yes       | `{ item }` |
| `zk_write`        | memory.ts handler          | yes       | `{ path, title }` |
| `para_append`     | memory.ts handler          | yes       | `{ path, category }` |
| `lock_reap`       | lock-reaper.ts             | yes       | `{ path, owner, expired_at }` |
| `claim_reap`      | claim-reaper.ts            | yes       | `{ item, owner }` |
| `post_mortem`     | post-mortem.ts             | yes       | `{ path, reason }` |
| `merge_review`    | merge-review.ts            | no        | `{ cast_id, verdict, ... }` |
| `abort`           | abort.ts CLI command       | yes       | `{ reason }` |
| `kill`            | kill.ts CLI command        | yes       | `{ reason }` |
| `promote`         | promote.ts CLI command     | no        | `{ cast_id, clone_id, branch }` |

### 2. Registry (`registry.json`)

**Location:** `.manta/state/registry.json`
**Class:** `packages/manta-bus/src/state/registry.ts` → `Registry`

**CloneRecord fields:**

| Field               | Type                | inspect? | audit? |
|---------------------|---------------------|----------|--------|
| `clone_id`          | string              | yes      | yes    |
| `mode`              | Mode                | yes      | yes    |
| `parent_pid`        | number              | yes      |        |
| `worktree`          | string              | yes      |        |
| `metadata`          | Record<string,string> | yes    | yes    |
| `registered_at`     | number (epoch ms)   | yes      | yes    |
| `last_heartbeat_at` | number (epoch ms)   | yes      | yes    |
| `state`             | CloneState          | yes      | yes    |
| `progress?`         | string              | yes      |        |
| `death_reason?`     | string              |          | yes    |
| `died_at?`          | number              |          | yes    |

**CloneState enum values:** `STARTING`, `WORKING`, `BLOCKED`, `WINDING_DOWN`, `DEAD`

**API surface:**
- `get(cloneId)` → single record (throws BusNotFoundError)
- `list()` → all records
- `staleSince(thresholdMs)` → non-DEAD records whose heartbeat is stale

### 3. ContractsStore (per-clone JSON files)

**Location:** `.manta/state/contracts/<clone_id>.json`
**Class:** `packages/manta-bus/src/state/contracts.ts` → `ContractsStore`

**StoredContract fields:**

| Field         | Type          | Description |
|---------------|---------------|-------------|
| `contract`    | TaskContract  | The contract body |
| `written_at`  | number        | When the contract was written |
| `ack?`        | ContractAck   | Clone's interpretation + ack timestamp |

**TaskContract fields (snake_case wire format):**
- `clone_id`, `mode`, `task` (string, ≤8000 chars)
- `scope: { allowed_paths, forbidden_paths, max_files_changed }`
- `approach_hint?` (string)
- `sibling_clones` (string[])
- `deadline_ms` (number)

**API surface:**
- `read(cloneId)` → single contract
- `list()` → all contracts
- `write(contract)` → idempotent write
- `ack(cloneId, interpretation)` → record ack

### 4. CastsStore (per-cast JSON files)

**Location:** `.manta/state/casts/<cast_id>.json`
**Class:** `packages/manta-bus/src/state/casts.ts` → `CastsStore`

**CastManifest fields:**

| Field        | Type              | replay? | audit? |
|--------------|-------------------|---------|--------|
| `version`    | `1` (literal)     |         |        |
| `cast_id`    | string            | yes     | yes    |
| `mode`       | Mode              | yes     | yes    |
| `clones`     | CastClonesEntry[] | yes     | yes    |
| `policy`     | CastPolicy        | yes     | yes    |
| `created_at` | number (epoch ms) | yes     | yes    |

**CastClonesEntry:** `{ clone_id, assignment: CloneAssignment | null }`
**CloneAssignment:** `{ task?, approach_hint?, scope?, budget_usd?, deadline_seconds? }`
**CastPolicy:** `{ peer_messaging: 'allowed'|'denied', auto_merge_threshold: number|null }`

**API surface:**
- `read(castId)` → single manifest
- `list()` → all manifests
- `create(input)` → idempotent create

### 5. ClaimsStore (`claims.json`)

**Location:** `.manta/state/claims.json`
**Class:** `packages/manta-bus/src/state/claims.ts` → `ClaimsStore`

**WorkClaim fields:**

| Field             | Type   |
|-------------------|--------|
| `item`            | string |
| `owner_clone_id`  | string |
| `claimed_at`      | number |
| `expires_at`      | number |

**API surface:**
- `list()` → all claims
- `claim(input)` → acquire
- `release(input)` → release
- `reapExpired()` → reap and return expired claims

### 6. LocksStore (`locks.json`)

**Location:** `.manta/state/locks.json`
**API surface:** `acquire`, `renew`, `release`, `listOwned(cloneId)`

**Known gap:** No `listAll()` method — status uses `listOwned` per registered clone (see status.ts:30-40). Leases owned by zombie clones invisible to `getStatus()`.

### 7. MemoryWriters

**Location:** `docs/zk/` (ZK notes), `docs/para/` (PARA entries)
**Class:** `packages/manta-bus/src/memory-writers.ts` → `MemoryWriters`

ZK entries and PARA entries are written as markdown files. Events are emitted as `zk_write` and `para_append` types.

### 8. File system paths (`BusPaths`)

**Class:** `packages/manta-bus/src/state/paths.ts`

| Path property   | Resolved path                   |
|-----------------|----------------------------------|
| `stateDir`      | `<repo>/.manta/state`            |
| `registry`      | `<repo>/.manta/state/registry.json` |
| `locks`         | `<repo>/.manta/state/locks.json` |
| `claims`        | `<repo>/.manta/state/claims.json`|
| `eventsLog`     | `<repo>/.manta/state/events.jsonl`|
| `contractsDir`  | `<repo>/.manta/state/contracts/` |
| `castsDir`      | `<repo>/.manta/state/casts/`     |
| `lockfileDir`   | `<repo>/.manta/state/.locks/`    |

---

## Existing Consumers

### 1. `manta status` (Tier 1)

**File:** `packages/manta-cli/src/commands/status.ts`
**Data path:** `Runtime.orchestrator.getStatus()` → `buildStatus(ctx)`
**Reads:** `registry.list()`, `locks.listOwned(per clone)`, `claims.list()`
**Output:** `OrchestratorStatus { now, clones[], locks[], claims[], thresholds }`
**Renderer:** `renderStatusTable()` in `packages/manta-cli/src/output/status-table.ts`

**Pattern for new commands:**
1. Receives `Runtime` + `Reporter`
2. Calls orchestrator or ctx methods
3. Returns `CommandResult { exitCode, stdout }`
4. Pure read, no mutations

### 2. Post-mortem system

**Composer:** `packages/manta-orchestrator/src/post-mortem.ts` → `runPostMortem()`
**Writer interface:** `packages/manta-orchestrator/src/post-mortem-writer.ts` → `PostMortemWriter`
**Output dir:** `docs/post-mortems/` (configurable via `thresholds.postMortemDir`)
**Filename pattern:** `YYYY-MM-DD-<cast-id>-<clone-id>.md`

**Data consumed:**
- `ctx.registry.get(cloneId)` → full CloneRecord
- `ctx.events.readAll()` → filtered to `clone_id === target`
- Renders: metadata, thresholds, full event timeline for that clone

### 3. Merge-review system (Phase 2c)

**Orchestrator:** `packages/manta-orchestrator/src/merge-review.ts` → `runMergeReview()`
**Writer:** `packages/manta-orchestrator/src/merge-review-writer.ts` → `MergeReviewWriter`
**Output dir:** `docs/merge-reviews/` (configurable via `thresholds.mergeReviewDir`)

**Data consumed:**
- `ctx.events.readAll()` → scans for `broadcast` events with `self_certainty` payload
- `ctx.events.append()` → emits `merge_review` events
- Candidate metrics collected externally (git diff stats, test results, lint output)

### 4. Orchestrator runCycle

**File:** `packages/manta-orchestrator/src/orchestrator.ts`
**Reads:** registry (via death-detector), locks (via lock-reaper), claims (via claim-reaper)
**Writes:** events (post_mortem, lock_reap, claim_reap), registry (markDead)
**Output:** `CycleResult { ranAt, deadClones[], reapedLocks[], reapedClaims[], postMortems[], events[] }`

### 5. Cast command lifecycle

**File:** `packages/manta-cli/src/commands/cast.ts` → `runCastCommand()`
**Lifecycle:**
1. Validate mode + clone count + budget
2. MCP pre-flight
3. For each clone: `addWorktree` → `buildCloneSnapshot` → `contracts.write` → `spawnClone`
4. `runTickLoop` (orchestrator cycles until all DEAD or budget timeout)
5. If forking-realities: `runMergeReview`
6. Reporter emits `cast.spawn`, `cast.done`, `cast.budget_abort`, `cast.merge_review`

### 6. Runtime composer

**File:** `packages/manta-cli/src/runtime.ts` → `createRuntime()`
**Creates:** `BusContext` (all stores), `Orchestrator`, `MergeReviewWriter`
**Pattern:** All commands receive `Runtime` which gives access to `ctx` (bus stores) and `orchestrator`.

---

## Integration Points for Phase 2d

### `manta inspect <clone-id>` (Tier 2)

**Existing data that can be surfaced directly:**
- `ctx.registry.get(cloneId)` → full CloneRecord (state, heartbeat, metadata, worktree, mode, progress)
- `ctx.contracts.read(cloneId)` → task contract + ack interpretation
- `ctx.events.readAll().filter(e => e.clone_id === id)` → last N actions
- `ctx.locks.listOwned(cloneId)` → held locks
- `ctx.claims.list().filter(c => c.owner_clone_id === id)` → held claims

**Cast context enrichment:**
- `metadata.cast_id` on CloneRecord → `ctx.casts.read(castId)` → cast manifest (mode, policy, siblings)

**Hook point:** Same `Runtime` + `CommandResult` pattern as `status.ts`. New file `packages/manta-cli/src/commands/inspect.ts`.

### `manta tail <clone-id> [seconds]` (Tier 3)

**Existing data:**
- `EventsLog.readSince(tsExclusive)` — poll-based: read all events since last poll timestamp, filter by `clone_id`

**Hook point:** Needs a polling loop in the CLI. The tick loop pattern (`packages/manta-cli/src/tick-loop.ts`) provides the interval-based polling model. Tail would be a read-only variant: no orchestrator cycles, just `readSince` + render + sleep.

### `manta replay <cast-id>` (Tier 4)

**Existing data:**
- `ctx.casts.read(castId)` → manifest (mode, roster, policy, created_at)
- `ctx.events.readAll()` → filter by clone_ids from manifest roster → complete event timeline
- `ctx.contracts.list()` → filter by clone_ids → contracts + acks
- Post-mortem files on disk: `docs/post-mortems/<date>-<cast-id>-*.md`
- Merge-review files on disk: `docs/merge-reviews/<cast-id>-*.md`

**Reusable from post-mortem:**
- `renderMarkdown()` in `post-mortem.ts` already renders event timelines per clone
- `castIdOf()` helper extracts cast_id from metadata

### `manta audit <clone-id>` (Tier 4)

**Existing data:**
- Everything from inspect + full event timeline (not truncated to last N)
- Contract drift: compare `contract_write` event payload vs `contract_ack` interpretation
- Lock/claim lifecycle: pair `lock`/`unlock`, `claim`/`release` events for duration analysis
- Drift reports: filter `drift_report` events
- Budget tracking: events count as proxy (no direct token tracking in bus yet)

---

## Missing Infrastructure

### Must build new

| Gap | Description | Needed by |
|-----|-------------|-----------|
| **Event filtering by clone_id** | `readSince` filters only by `ts`. Every consumer that needs per-clone events does `readAll().filter(...)` — O(n) full scan each time. | inspect, tail, audit |
| **Event filtering by cast_id** | No native way to filter events by cast. Must: (1) read manifest for clone roster, (2) readAll, (3) filter by clone_ids in roster. | replay |
| **Event filtering by type** | No `readByType()` method. Every consumer manually filters. | audit (drift_report, contract events) |
| **Streaming / watch mode** | EventsLog is read-batch only (readAll/readSince). No file-watch or inotify-based streaming. `tail` needs a polling loop on top. | tail |
| **LocksStore.listAll()** | Only `listOwned(cloneId)` exists. Status already works around this; inspect inherits the workaround. | inspect, audit |
| **Output renderers** | `renderStatusTable` exists for status. Inspect, replay, audit each need their own renderer. | all Tier 2-4 commands |
| **CLI arg parsing for new commands** | `cast.ts` and `status.ts` establish the pattern. Each new command needs arg parsing + registration. | all |

### Can reuse directly

| Existing asset | Reuse in |
|----------------|----------|
| `Runtime` + `BusContext` pattern | All commands — same constructor |
| `CommandResult` interface | All commands — same return type |
| `Reporter` interface | All commands — structured logging |
| `EventsLog.readSince(ts)` | tail (polling loop) |
| `EventsLog.readAll()` | inspect (last N), replay (full), audit (full) |
| `Registry.get()` / `Registry.list()` | inspect, audit |
| `ContractsStore.read()` / `.list()` | inspect, replay, audit |
| `CastsStore.read()` / `.list()` | replay, audit |
| `ClaimsStore.list()` | inspect, audit |
| `post-mortem.ts` `renderMarkdown()` pattern | replay (timeline rendering) |
| `tick-loop.ts` interval pattern | tail (polling loop) |
| `Thresholds` config | inspect (show thresholds in effect), audit (evaluate against thresholds) |

---

## EventsLog.readSince API Analysis

### Current signature

```typescript
async readSince(tsExclusive: number): Promise<BusEvent[]>
```

### Implementation

Calls `readAll()` then `all.filter(e => e.ts > tsExclusive)` — full file read + linear scan every time.

### Filtering capabilities

| Filter dimension | Supported? | How? |
|-----------------|------------|------|
| By timestamp (after) | **Yes** — `readSince(ts)` | Native method |
| By timestamp (range) | **No** | Must post-filter `readSince` result |
| By clone_id | **No** | Must post-filter |
| By event type | **No** | Must post-filter |
| By cast_id | **No** | Must resolve roster first, then post-filter by clone_ids |
| By payload field | **No** | Must post-filter with type assertion |

### Performance characteristics

- **Read pattern:** Full file read (`fs.readFile`) + line-by-line JSON parse on every call
- **No indexing:** No secondary indices, no offset tracking, no seek optimization
- **Crash tolerance:** Truncated last line skipped with `console.warn`
- **Ordering guarantee:** File-append order is authoritative; IDs are secondary sort hint

### Gaps for Phase 2d

1. **No incremental read.** `tail` calling `readSince` every N seconds re-reads the entire file each time. For short-lived casts this is fine (hundreds of events); for long-running casts (Phase 3+ steady-state daemons), this becomes O(n²) over the session.

2. **No native clone_id filter.** Every consumer implements `events.filter(e => e.clone_id === id)` independently. A `readByClone(cloneId, sinceTs?)` convenience method would centralize this.

3. **No type filter.** Audit needs specific event types (drift_report, contract_write/ack). Currently requires full-scan + manual filter.

4. **No cursor / offset API.** For tail, an opaque cursor (e.g., byte offset or last-seen event id) would enable efficient incremental reads without re-parsing the entire file.

5. **No event count / size query.** Cannot ask "how many events exist" or "how large is the log" without reading the whole file. Useful for inspect summary line ("42 events recorded").

### Recommendation priority

For Phase 2d scope, the gaps are **acceptable** — the JSONL files are small enough in Phase 0-2 casts (typically <500 events per cast, <100KB file) that full-scan is sub-millisecond. Optimization (cursor, index) should be deferred to Phase 3+ when daemon-mode introduces long-running event streams.

The most impactful addition would be **convenience filter methods** (`readByClone`, `readByCast` via roster lookup) to eliminate repeated boilerplate across inspect/tail/replay/audit implementations.

---

## Appendix: Spec reference (Sec 11.0)

| Tier | Surface | Latency | Use case |
|------|---------|---------|----------|
| 0 — passive | statusline | always-on | "есть ли вообще активность" |
| 1 — on-demand | `manta status` | sync, секунда | "что сейчас делают" |
| 2 — deep dive | `manta inspect <id>` | sync, секунды | "почему этот клон тормозит" |
| 3 — real-time | `manta tail <id> [seconds]` | live | "хочу видеть каждый ход" |
| 4 — forensic | `manta replay <cast-id>` + `manta audit <clone-id>` | post-cast | "разбор после fact'а" |

Spec mandate (Sec 11.0): "Каждый tier — отдельный код-путь, не переизобретают друг друга. Единый источник истины — orchestrator's event log."

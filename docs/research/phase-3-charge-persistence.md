# Phase 3 — Charge System Persistence: Design Research

**Clone:** B (recon-swarm, cast-1779825540200)  
**Date:** 2026-05-26  
**Spec reference:** Sec 6.4 "Manta Charge — конкретные числа"  
**Deliverable:** Pros/cons of two persistence strategies + explicit recommendation

---

## 1. Requirements from Spec Sec 6.4

### State shape

```typescript
interface ChargeState {
  current: number;          // charges_initial=3, range [charges_min..charges_max]
  max: number;              // 5
  min: number;              // -1 (one overdraft allowed)
  lastIdleRecoveryAt: number; // epoch-ms — passive recovery tracking
  cooldownUntil: number | null; // epoch-ms — 24h hard cooldown (null = not in cooldown)
  totalSuccesses: number;   // lifetime stats
  totalFailures: number;
  totalCasts: number;
}
```

Estimated serialized size: **~200 bytes** JSON.

### Write patterns

| Event | Mutation | Frequency |
|---|---|---|
| Cast start | `current -= cost` (1–6 per combo) | 0–10/day |
| Cast success | `current += 1` | 0–10/day |
| Cast failure | `current -= 1`, possibly trigger cooldown | 0–5/day |
| Passive recovery | `current += 1` (capped at max) | 0–48/day |
| `/manta refresh` | Reset cooldown, set current=charges_initial | Rare |

**Peak write rate:** ~1 write/minute during heavy cast usage. Not a high-throughput workload.

### Read patterns

| Reader | When | Concurrency |
|---|---|---|
| Pre-cast gate (`manta-cast-decide`) | Before each cast | Sequential (main only) |
| Orchestrator cycle | Every 5s cycle for passive recovery check | Single process |
| `/manta status` | On-demand | Lock-free read is fine |
| Clone startup (informational) | During contract read | Lock-free read is fine |

**Key constraint:** Only the **orchestrator** (single process) and **main agent** (single process) write to charges. Clones never write charges — they only trigger charge deltas via cast outcome events that the orchestrator processes. This means **no multi-writer concurrency** in practice.

### Audit trail

Spec Sec 6.4: "каждое изменение — строка в `.manta/state/charges.log`". Must record:
- timestamp, event type, delta, previous value, new value, cast_id (if applicable), reason

### Edge cases from spec

1. **Overdraft:** charges can go to -1; next failure after overdraft → 24h cooldown
2. **Cooldown enforcement:** while in cooldown, all casts blocked except `/manta refresh` with double confirm
3. **Overdraft restriction:** while charges < 0, only Wave-1 (cost ≤ 1) modes allowed
4. **Passive recovery pauses:** no recovery while `active clones > 0`; needs registry check
5. **Crash recovery:** must reconstruct correct state from audit trail if charges.json corrupted

---

## 2. Option A — JSON + lockfile (atomicMutateJson)

### Schema

File: `.manta/state/charges.json`

```json
{
  "version": 1,
  "current": 3,
  "max": 5,
  "min": -1,
  "lastIdleRecoveryAt": 1779825540200,
  "cooldownUntil": null,
  "totalSuccesses": 12,
  "totalFailures": 2,
  "totalCasts": 14
}
```

Audit file: `.manta/state/charges.log` (JSONL, append-only)

```jsonl
{"ts":1779825540200,"type":"cast_start","castId":"cast-xxx","mode":"recon-swarm","cost":1,"prev":3,"next":2}
{"ts":1779825600000,"type":"cast_success","castId":"cast-xxx","prev":2,"next":3}
{"ts":1779826200000,"type":"passive_recovery","prev":3,"next":4,"reason":"30min idle"}
```

### Read path

```typescript
// Lock-free, atomic rename guarantees no torn reads
const state = await atomicReadJson<ChargeState>(paths.charges, defaultChargeState);
```

### Write path

```typescript
const next = await atomicMutateJson<ChargeState>(
  paths.charges,
  defaultChargeState,
  (current) => {
    // validate cost, check overdraft, apply delta
    return { ...current, current: current.current - cost };
  },
  async () => {
    await appendJsonLine(paths.chargesLog, {
      ts: clock.now(), type: 'cast_start', castId, mode, cost,
      prev: current.current, next: current.current - cost,
    });
  },
);
```

The `auditAppend` callback runs **inside the file mutex** before the state rename — identical to the audit-trail invariant already proven in registry/locks/claims/contracts.

### Concurrency model

- `proper-lockfile` with stale=30s, retries=50
- Single-writer in practice (orchestrator), but safe if main and orchestrator overlap
- Lock-free reads via `atomicReadJson` — readers always see pre- or post-write, never torn JSON
- Audit append + state commit in same mutex — audit-ahead-of-state on crash (existing reconciliation pattern)

### Failure modes

| Failure | Impact | Recovery |
|---|---|---|
| Crash between audit-append and state-rename | Audit log ahead of state by 1 entry | Replay last audit entry to reconstruct; identical to existing bus pattern |
| charges.json corrupted (disk error) | State lost | Reconstruct from charges.log: replay all deltas from initial state |
| charges.log corrupted (torn last line) | Last entry may be lost | `readAll` skips malformed tail (same as EventsLog); state file is authoritative |
| Lock stale (process died holding lock) | 30s stale timeout → next writer steals | proper-lockfile handles this; proven in production across all bus stores |
| Disk full | Write fails, mutex released | State unchanged (write was to tmp file); retry after space freed |

### Passive recovery implementation

```typescript
// In orchestrator runCycle (every 5s):
async function checkPassiveRecovery(charges: ChargeStore, registry: Registry, clock: Clock) {
  const state = await charges.read();
  if (state.cooldownUntil && clock.now() < state.cooldownUntil) return; // in cooldown
  const activeClones = (await registry.list()).filter(r => r.state !== 'DEAD');
  if (activeClones.length > 0) return; // paused while clones active
  const elapsed = clock.now() - state.lastIdleRecoveryAt;
  if (elapsed >= 30 * 60 * 1000 && state.current < state.max) {
    await charges.applyPassiveRecovery();
  }
}
```

The `lastIdleRecoveryAt` timestamp persists across process restarts. On crash, next cycle picks up from the stored timestamp — no drift accumulation.

### Lines of new code (estimate)

| Component | Lines |
|---|---|
| `ChargeStore` (read/deduct/credit/recover/refresh) | ~120 |
| `charges.log` integration (reuses `appendJsonLine`) | ~30 |
| Orchestrator integration (passive recovery in `runCycle`) | ~40 |
| CLI gate (`manta-cast-decide` pre-check) | ~30 |
| Tests | ~200 |
| **Total** | **~420** |

---

## 3. Option B — SQLite with WAL mode

### Schema

```sql
CREATE TABLE charges (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  current INTEGER NOT NULL DEFAULT 3,
  max INTEGER NOT NULL DEFAULT 5,
  min INTEGER NOT NULL DEFAULT -1,
  last_idle_recovery_at INTEGER NOT NULL,
  cooldown_until INTEGER,
  total_successes INTEGER NOT NULL DEFAULT 0,
  total_failures INTEGER NOT NULL DEFAULT 0,
  total_casts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE charge_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  cast_id TEXT,
  mode TEXT,
  cost INTEGER,
  prev_value INTEGER NOT NULL,
  next_value INTEGER NOT NULL,
  reason TEXT
);

CREATE INDEX idx_charge_audit_ts ON charge_audit(ts);
```

### Read path

```typescript
const db = new Database('.manta/state/charges.db', { readonly: true });
const row = db.prepare('SELECT * FROM charges WHERE id = 1').get();
```

WAL mode allows concurrent readers while a writer holds a transaction.

### Write path

```typescript
const db = new Database('.manta/state/charges.db');
db.pragma('journal_mode = WAL');

db.transaction(() => {
  const current = db.prepare('SELECT current FROM charges WHERE id = 1').get();
  const next = current.current - cost;
  db.prepare('UPDATE charges SET current = ? WHERE id = 1').run(next);
  db.prepare(
    'INSERT INTO charge_audit (ts, type, cast_id, mode, cost, prev_value, next_value) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(Date.now(), 'cast_start', castId, mode, cost, current.current, next);
})();
```

### Concurrency model

- WAL mode: multiple readers + one writer without blocking
- SQLite's built-in transaction serialization (file-level lock)
- No need for proper-lockfile — SQLite manages its own locking

### Failure modes

| Failure | Impact | Recovery |
|---|---|---|
| Crash mid-transaction | WAL replay on next open | SQLite handles automatically |
| Database corruption | State + audit lost together | No separate audit trail to recover from |
| WAL file grows (no checkpoint) | Disk usage creep | Must configure auto-checkpoint or explicit `PRAGMA wal_checkpoint` |
| Lock contention (busy timeout) | Writer blocks readers in extreme cases | `PRAGMA busy_timeout` mitigates; unlikely at our write rate |

### Dependency cost

- **New dependency:** `better-sqlite3` (~2.5 MB native addon, requires node-gyp/prebuildify)
- **Platform matrix:** macOS arm64/x64, Linux x64/arm64 — prebuilt binaries exist but add CI complexity
- **Version pinning:** Native addons are Node.js major-version sensitive; breaking on Node upgrades is common
- **Install impact:** Adds ~15s to `npm install` for compilation fallback

### Lines of new code (estimate)

| Component | Lines |
|---|---|
| `ChargeStore` with SQLite | ~180 (more boilerplate: migrations, pragmas, prepared statements) |
| Migration system (even minimal) | ~60 |
| Orchestrator integration | ~40 |
| CLI gate | ~30 |
| Tests (need SQLite setup/teardown) | ~280 |
| **Total** | **~590** |

---

## 4. Comparison Table

| Dimension | JSON + lockfile | SQLite WAL |
|---|---|---|
| **Consistency with codebase** | Identical to 5 existing stores (registry, locks, claims, contracts, events) | Foreign pattern; no SQLite anywhere in project |
| **New dependencies** | Zero (proper-lockfile already in use) | `better-sqlite3` native addon (~2.5 MB) |
| **Concurrency safety** | proven: 50-retry proper-lockfile with 30s stale | proven: SQLite WAL; overkill for single-writer |
| **Read performance** | ~0.1ms (200-byte JSON parse) | ~0.3ms (SQLite open + query + close, or connection pool) |
| **Write performance** | ~1ms (lock + read + write-tmp + rename) | ~2ms (WAL write + fsync) |
| **Audit trail** | Separate `.log` file; can replay to reconstruct state | Same DB; single-point-of-failure for state+audit |
| **Crash recovery** | Audit-ahead-of-state → replay last entry (proven pattern) | SQLite WAL auto-replay (also proven) |
| **State reconstruction** | Replay charges.log from initial → deterministic rebuild | Backup-based; no separate audit stream to replay |
| **Code volume** | ~420 lines | ~590 lines (+40%) |
| **Test complexity** | Uses existing tmp-dir pattern | Needs SQLite lifecycle management in tests |
| **CI/platform risk** | None | Native addon compilation; Node version sensitivity |
| **ForensicTimeline integration** | charge events go to events.jsonl → already consumed by replay/audit | Separate query path needed to feed charge events into timeline |
| **Operational simplicity** | `cat charges.json` / `tail charges.log` — plain text debugging | `sqlite3 .manta/state/charges.db` — requires SQLite CLI |
| **Data volume fitness** | Perfect for ~200 bytes state + ~100 entries/day audit | Designed for thousands+ rows; overhead not justified |
| **Passive recovery tracking** | `lastIdleRecoveryAt` in JSON, survives restart | Same field in SQLite row |
| **Cooldown persistence** | `cooldownUntil` epoch-ms in JSON | Same field in SQLite row |
| **Bus integration** | Native: uses same `atomicMutateJson` + `appendJsonLine` | Needs adapter layer to emit events into events.jsonl |

---

## 5. Recommendation: **JSON + lockfile (Option A)**

### Rationale

1. **Zero new dependencies.** The entire Manta bus is built on `atomicMutateJson` + `appendJsonLine` + `proper-lockfile`. Adding SQLite for a single 200-byte JSON object introduces dependency risk (native addon, platform matrix, Node version coupling) with zero compensating benefit.

2. **Proven patterns.** The audit-trail invariant (audit-append inside mutex, before state-rename) is battle-tested across 5 stores and ~20 mutating operations. ChargeStore is just store #6 with the same contract.

3. **Single-writer reality.** Only the orchestrator writes charges. The concurrency argument for SQLite WAL (concurrent readers during writes) is solved by `atomicReadJson`'s lock-free read-of-atomic-rename, which already handles the same pattern for registry reads during casts.

4. **Audit trail separation.** charges.log as a separate JSONL file means state corruption in charges.json is recoverable by replaying the log. SQLite bundles state and audit into one file — if the DB corrupts, both are lost.

5. **Operational debugging.** `cat charges.json | jq .current` and `tail -5 charges.log | jq .` are instant. SQLite requires a CLI tool and SQL knowledge to inspect state during incident response.

6. **ForensicTimeline integration.** Phase 2d's replay/audit system already consumes events.jsonl. Charge events emitted via `appendJsonLine` to charges.log (and optionally mirrored to events.jsonl) integrate with zero additional plumbing. SQLite would need an adapter layer to bridge into the event stream.

7. **Passive recovery is trivial.** `lastIdleRecoveryAt` persists in JSON; orchestrator's `runCycle` checks it every 5s. After crash, the stored timestamp prevents drift accumulation — same pattern as `last_heartbeat_at` in registry.

### When SQLite would be justified

- If charge history grew to thousands of entries needing indexed queries (it won't — ~100 entries/day, 7-day retention max)
- If multiple processes needed concurrent writes (they don't — only orchestrator writes)
- If the project already depended on SQLite (it doesn't)
- If we needed relational queries across charges and other state (we don't — charges is an independent singleton)

### Implementation sketch

```
packages/manta-orchestrator/src/charge-store.ts  — ChargeStore class
packages/manta-bus/src/state/paths.ts            — add charges + chargesLog paths
packages/manta-orchestrator/src/orchestrator.ts  — passive recovery in runCycle
packages/manta-cli/src/commands/cast.ts          — pre-cast charge check
packages/manta-cli/src/commands/refresh.ts       — /manta refresh (cooldown reset)
packages/manta-orchestrator/tests/charge-store.test.ts
```

ChargeStore lives in **orchestrator**, not bus — per ARCHITECTURE.md: "Charge accounting (Phase 3 — orchestrator owns the charge ledger; bus only logs deltas as events)". The bus provides the file primitives; the orchestrator owns the business logic.

---

## 6. Open Questions for Siblings

1. **Clone A (if researching charge business logic):** What's the exact sequence for combo mode cost calculation? Spec says "sum of constituent modes" — is that validated at cast-decide time or at spawn time?
2. **Clone C (if researching CLI integration):** Does `/manta status` need real-time charge display, or is it acceptable to show last-known from the JSON read? (Lock-free read means it could be 1 mutation behind during a concurrent write.)
3. **Cooldown double-confirm UX:** `/manta refresh` requires "двойной confirm" — is this two sequential AskUserQuestion calls, or a single call with a confirmation phrase the user must type?

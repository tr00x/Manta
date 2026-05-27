# Phase 5 — Daemon-Mode Runtime for Persistent Clones

**Spec reference:** Sec 2 (Wave 2 mode catalog), Sec 9.1 (headless spawn limitations), Sec 15.1 (Phase 5 scope)
**Research deliverables:** `docs/research/phase-5-{daemon-cli-capabilities,daemon-architecture,codebase-readiness}.md`
**Build by:** forking-realities casts with 2 clones per chunk (heavy dogfood)
**Estimated total:** ~1,300 LOC (production code + tests + docs)

---

## Architecture Summary

Phase 5 adds the **daemon-mode runtime** — the infrastructure layer that enables persistent long-running clones for Wave 2 modes (pair-programming, test-storm, documentation-chase). Currently all clones are batch one-shot: spawn, execute task contract, die. Daemon mode adds a **sequential resume loop** where the orchestrator re-invokes the same Claude session with new work items, preserving full conversation context across resumes.

**Primary approach (verified by research Clone A):** Sequential Resume Pattern — `claude --print --session-id <uuid>` for initial spawn, then `claude --print --resume <session-id>` for subsequent work items. Each resume is a separate OS process; the orchestrator drives the poll-resume cycle. Clone process exits after each item; orchestrator loops.

**What Phase 5 does NOT include:** The actual Wave 2 mode iteration logic (pair-programming review cycles, test-storm shared worktree choreography, documentation-chase background running). Those are Phase 6. Phase 5 builds the runtime that *enables* them.

### Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Work delivery | Orchestrator-side resume (not clone-side polling) | `--print` mode is one-shot; clone cannot self-loop. Research §4 proved clone-side MCP polling unviable. |
| Session continuity | `--session-id` + `--resume` | Verified: full conversation context preserved across resumes. `--append-system-prompt` can change between calls. |
| New clone states | IDLE, WAITING_FOR_TASK | Minimal extension to CloneStateSchema. DEAD remains terminal. |
| Death detector strategy | State-aware thresholds, not rename | Keep `death-detector.ts` name, add branching on IDLE/WAITING_FOR_TASK for extended timeouts. |
| Stream-JSON stdin | NOT used | Research Clone B proposed it, but Clone A verified it does NOT work for multi-turn in `--print` mode (process exits after first response). Sequential resume is the only verified path. |

---

## Chunk 1 — Bus + Orchestrator Daemon Foundation

**Cast mode:** `forking-realities` with 2 clones
**Estimated LOC:** ~620 (code + tests)

### Design Decisions

- **Schema expansion is additive** — all new fields have defaults, all new enum values are non-breaking. Zero migration needed.
- **New bus tools use existing patterns** — handler + parse + events.append + registry mutation, same as lifecycle.ts and communication.ts.
- **Work queue reuses ClaimsStore** — `enqueue_work` writes to a new `WorkQueueStore` (separate from claims, which are clone-initiated). The orchestrator reads it; no clone-side polling.
- **Health monitor stays in `death-detector.ts`** — renaming adds churn for zero value. Add IDLE/WAITING_FOR_TASK branches instead.

### Task 1.1 — CloneStateSchema expansion + new input schemas (bus)

**Package:** `@manta/bus`
**File:** `packages/manta-bus/src/schema.ts`
**Assigned to:** Clone A (owns all schema — shared prereq for every other task)

**Changes:**

1. **CloneStateSchema** (line 25): Expand enum:
```typescript
export const CloneStateSchema = z.enum([
  'STARTING', 'WORKING', 'BLOCKED', 'IDLE', 'WAITING_FOR_TASK',
  'WINDING_DOWN', 'DEAD',
]);
```

2. **New input schemas** (append after line 216, before CastPolicySchema):
```typescript
export const RetaskInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    new_task: z.string().min(1).max(8_000),
    new_scope: ScopeSchema.optional(),
    new_approach_hint: z.string().max(8_000).optional(),
    new_deadline_ms: z.number().int().positive().optional(),
  })
  .strict();

export const PauseInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    reason: z.string().min(1).max(2_000),
  })
  .strict();

export const ResumeInputSchema = z
  .object({
    clone_id: CloneIdSchema,
  })
  .strict();

export const FeedbackInputSchema = z
  .object({
    clone_id: CloneIdSchema,       // target clone
    from: z.string().min(1).max(64),  // sender (main or sibling clone_id)
    feedback: z.string().min(1).max(8_000),
    severity: z.enum(['info', 'correction', 'blocker']),
  })
  .strict();

export const RequestTaskInputSchema = z
  .object({
    clone_id: CloneIdSchema,
  })
  .strict();

export const EnqueueWorkInputSchema = z
  .object({
    cast_id: CastIdSchema,
    target_clone_id: CloneIdSchema,
    prompt: z.string().min(1).max(16_000),
    priority: z.enum(['normal', 'high']).default('normal'),
  })
  .strict();
```

3. **BroadcastEventTypeSchema** (line 151): Add `'task_complete'`, `'idle'`, `'feedback_received'`:
```typescript
export const BroadcastEventTypeSchema = z.enum([
  'breakthrough', 'blocker', 'dependency', 'self_certainty',
  'task_complete', 'idle', 'feedback_received',
]);
```

4. **CastPolicySchema** (line 218): Add `session_mode` field:
```typescript
export const CastPolicySchema = z
  .object({
    peer_messaging: z.enum(['allowed', 'denied']),
    auto_merge_threshold: z.number().min(0).max(1).nullable(),
    session_mode: z.enum(['batch', 'daemon']).default('batch'),
  })
  .strict();
```

5. **Inferred type exports** (after line 420): Add all new types:
```typescript
export type RetaskInput = z.infer<typeof RetaskInputSchema>;
export type PauseInput = z.infer<typeof PauseInputSchema>;
export type ResumeInput = z.infer<typeof ResumeInputSchema>;
export type FeedbackInput = z.infer<typeof FeedbackInputSchema>;
export type RequestTaskInput = z.infer<typeof RequestTaskInputSchema>;
export type EnqueueWorkInput = z.infer<typeof EnqueueWorkInputSchema>;
```

**IMPORTANT — `.strict()` propagation:** Adding `session_mode` to `CastPolicySchema` changes the inferred TypeScript type. Every existing construction site that builds a `CastPolicy` literal must add `session_mode: 'batch'`. Update these files:
- `packages/manta-cli/src/commands/cast.ts` (line ~232) — already handled in Task 2.5 by Clone B
- `packages/manta-bus/tests/integration/cast-manifest.test.ts` (lines 19, 39, 64, 73) — add `session_mode: 'batch'`
- `packages/manta-bus/tests/state/casts.test.ts` (lines 18, 26, 89) — add `session_mode: 'batch'`

**Tests:** `packages/manta-bus/tests/schema.test.ts` (extend existing):
- All new schemas parse valid input
- All new schemas reject invalid input (missing required fields, out-of-range, wrong types)
- CloneStateSchema accepts IDLE and WAITING_FOR_TASK
- BroadcastEventTypeSchema accepts new event types
- CastPolicySchema defaults session_mode to 'batch' when omitted
- CastPolicySchema accepts 'daemon' session_mode

~85 LOC production, ~60 LOC tests (plus ~10 LOC updates in existing bus tests for `.strict()` propagation).

### Task 1.2 — Registry daemon methods (bus)

**Package:** `@manta/bus`
**File:** `packages/manta-bus/src/state/registry.ts`
**Assigned to:** Clone A (depends on Task 1.1 schema)

**Changes:**

1. **CloneRecord interface** (line 7): Add optional daemon fields:
```typescript
export interface CloneRecord {
  // ... existing fields ...
  idle_since?: number;
  tasks_completed?: number;
  last_task_completed_at?: number;
  session_mode?: 'batch' | 'daemon';
}
```

2. **heartbeat()** (line 61): Extend state transition validation for new states:
```typescript
// After the existing DEAD rejection block:
// Validate IDLE-related transitions
if (input.state === 'IDLE') {
  // Valid: WORKING → IDLE (task complete), STARTING → IDLE (daemon cold start)
  // Invalid: BLOCKED → IDLE (must unblock to WORKING first)
  if (r.state === 'BLOCKED') {
    throw new BusConflictError(
      `cannot transition from BLOCKED to IDLE; unblock to WORKING first`,
    );
  }
  r.idle_since = this.clock.now();
  r.tasks_completed = (r.tasks_completed ?? 0) + 1;
  r.last_task_completed_at = this.clock.now();
}
if (r.state === 'IDLE' && input.state === 'WORKING') {
  // Re-task: clear idle_since
  r.idle_since = undefined;
}
```

3. **New method: `retask()`**:
```typescript
async retask(
  cloneId: string,
  taskSummary: string,
  auditAppend?: () => Promise<void>,
): Promise<CloneRecord> {
  return atomicMutateJson<RegistryFile>(
    this.paths.registry,
    empty,
    (current) => {
      const r = current.clones[cloneId];
      if (!r) throw new BusNotFoundError('clone', cloneId);
      if (r.state !== 'IDLE' && r.state !== 'WAITING_FOR_TASK') {
        throw new BusConflictError(
          `cannot retask clone ${cloneId} in state ${r.state}; must be IDLE or WAITING_FOR_TASK`,
        );
      }
      r.state = 'WORKING';
      r.idle_since = undefined;
      r.last_heartbeat_at = this.clock.now();
      r.progress = `retasked: ${taskSummary.slice(0, 200)}`;
      return current;
    },
    auditAppend,
  ).then((next) => next.clones[cloneId]!);
}
```

4. **staleSince()** (line 165): Add IDLE-awareness:
```typescript
async staleSince(thresholdMs: number, idleThresholdMs?: number): Promise<CloneRecord[]> {
  const now = this.clock.now();
  const file = await atomicReadJson<RegistryFile>(this.paths.registry, empty);
  return Object.values(file.clones).filter((r) => {
    if (r.state === 'DEAD') return false;
    // IDLE and WAITING_FOR_TASK use a longer threshold
    if (r.state === 'IDLE' || r.state === 'WAITING_FOR_TASK') {
      const effectiveThreshold = idleThresholdMs ?? thresholdMs;
      return now - r.last_heartbeat_at > effectiveThreshold;
    }
    return now - r.last_heartbeat_at > thresholdMs;
  });
}
```

5. **touch()** (line 118): No change needed — IDLE clones get touched like any other non-DEAD clone.

**Tests:** `packages/manta-bus/tests/state/registry.test.ts` (extend existing):
- `heartbeat to IDLE sets idle_since and increments tasks_completed`
- `heartbeat from IDLE to WORKING clears idle_since`
- `heartbeat from BLOCKED to IDLE is rejected`
- `retask transitions IDLE to WORKING`
- `retask transitions WAITING_FOR_TASK to WORKING`
- `retask rejects WORKING clone`
- `retask rejects DEAD clone`
- `retask rejects unknown clone`
- `staleSince excludes IDLE clones under idleThreshold`
- `staleSince includes IDLE clones over idleThreshold`
- `CloneRecord.session_mode is persisted through heartbeat`

~65 LOC production (new + modified), ~80 LOC tests.

### Task 1.3 — New bus tool handlers for daemon lifecycle (bus)

**Package:** `@manta/bus`
**File:** `packages/manta-bus/src/tools/lifecycle.ts`
**Assigned to:** Clone B

**Changes:**

1. Add imports for new schemas:
```typescript
import {
  HeartbeatInputSchema,
  RegisterInputSchema,
  ReportDeathInputSchema,
  SuicideIntentInputSchema,
  RetaskInputSchema,
  PauseInputSchema,
  ResumeInputSchema,
  RequestTaskInputSchema,
} from '../schema';
```

2. **Extend LifecycleHandlers interface**:
```typescript
export interface LifecycleHandlers {
  register(input: unknown): Promise<LifecycleResult>;
  heartbeat(input: unknown): Promise<LifecycleResult>;
  suicideIntent(input: unknown): Promise<LifecycleResult>;
  reportDeath(input: unknown): Promise<LifecycleResult>;
  retask(input: unknown): Promise<LifecycleResult>;
  pause(input: unknown): Promise<LifecycleResult>;
  resume(input: unknown): Promise<LifecycleResult>;
  requestTask(input: unknown): Promise<LifecycleResult>;
}
```

3. **New handler implementations** in `createLifecycleHandlers`:

```typescript
async retask(input) {
  const parsed = parse(RetaskInputSchema, input, 'retask');
  let event!: BusEvent;
  const clone = await ctx.registry.retask(
    parsed.clone_id,
    parsed.new_task.slice(0, 200),
    async () => {
      event = await ctx.events.append({
        type: 'retask',
        clone_id: parsed.clone_id,
        payload: {
          new_task: parsed.new_task,
          new_scope: parsed.new_scope ?? null,
          new_approach_hint: parsed.new_approach_hint ?? null,
          new_deadline_ms: parsed.new_deadline_ms ?? null,
        },
      });
    },
  );
  return { clone, event };
},

async pause(input) {
  const parsed = parse(PauseInputSchema, input, 'pause');
  let event!: BusEvent;
  const clone = await ctx.registry.heartbeat(
    { clone_id: parsed.clone_id, state: 'IDLE' },
    async () => {
      event = await ctx.events.append({
        type: 'pause',
        clone_id: parsed.clone_id,
        payload: { reason: parsed.reason },
      });
    },
  );
  return { clone, event };
},

async resume(input) {
  const parsed = parse(ResumeInputSchema, input, 'resume');
  let event!: BusEvent;
  const clone = await ctx.registry.heartbeat(
    { clone_id: parsed.clone_id, state: 'WORKING' },
    async () => {
      event = await ctx.events.append({
        type: 'resume',
        clone_id: parsed.clone_id,
        payload: {},
      });
    },
  );
  return { clone, event };
},

async requestTask(input) {
  const parsed = parse(RequestTaskInputSchema, input, 'request_task');
  let event!: BusEvent;
  const clone = await ctx.registry.heartbeat(
    { clone_id: parsed.clone_id, state: 'WAITING_FOR_TASK' },
    async () => {
      event = await ctx.events.append({
        type: 'request_task',
        clone_id: parsed.clone_id,
        payload: {},
      });
    },
  );
  return { clone, event };
},
```

**Note for Clone B:** The `retask` handler calls `ctx.registry.retask()` which is created by Clone A (Task 1.2). Write your code against the interface from this plan. In your worktree, mock `registry.retask` in tests. After merge, the real implementation resolves.

**Tests:** `packages/manta-bus/tests/tools/lifecycle.test.ts` (extend existing):
- `retask handler validates input and calls registry.retask`
- `retask handler rejects invalid clone state`
- `retask handler appends retask event`
- `pause handler transitions to IDLE and appends pause event`
- `resume handler transitions to WORKING and appends resume event`
- `requestTask handler transitions to WAITING_FOR_TASK and appends request_task event`
- Each handler returns both clone record and event

~80 LOC production, ~70 LOC tests.

### Task 1.4 — Feedback + enqueue_work handlers (bus)

**Package:** `@manta/bus`
**Files:**
- `packages/manta-bus/src/tools/communication.ts` — add feedback handler
- `packages/manta-bus/src/state/work-queue.ts` — **new file**: WorkQueueStore
- `packages/manta-bus/src/tools/work.ts` — add enqueue handler
**Assigned to:** Clone B

**Changes to communication.ts:**

1. Add `FeedbackInputSchema` import.
2. Extend `CommunicationHandlers` interface:
```typescript
export interface CommunicationHandlers {
  broadcast(input: unknown): Promise<{ event: BusEvent }>;
  message(input: unknown): Promise<{ event: BusEvent }>;
  driftReport(input: unknown): Promise<{ event: BusEvent }>;
  readBroadcasts(input: unknown): Promise<{ events: BusEvent[] }>;
  feedback(input: unknown): Promise<{ event: BusEvent }>;
}
```
3. New handler:
```typescript
async feedback(input) {
  const parsed = parse(FeedbackInputSchema, input, 'feedback');
  await ctx.registry.get(parsed.clone_id); // validate target exists
  const event = await ctx.events.append({
    type: 'feedback',
    clone_id: parsed.clone_id,
    payload: {
      from: parsed.from,
      feedback: parsed.feedback,
      severity: parsed.severity,
    },
  });
  return { event };
},
```

**New file `work-queue.ts`:**

A dedicated work queue for daemon orchestrator to enqueue items for clone resume cycles. Separate from `ClaimsStore` (which is clone-initiated). The work queue is orchestrator-initiated (main or tick-loop pushes items, orchestrator consumes them via `dequeue`).

```typescript
import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
import type { Clock } from '../clock';
import type { BusPaths } from './paths';

export interface WorkItem {
  id: string;
  cast_id: string;
  target_clone_id: string;
  prompt: string;
  priority: 'normal' | 'high';
  enqueued_at: number;
  claimed_at?: number;
  completed_at?: number;
}

interface WorkQueueFile {
  version: 1;
  items: WorkItem[];
}

const empty = (): WorkQueueFile => ({ version: 1, items: [] });

export class WorkQueueStore {
  constructor(private readonly paths: BusPaths, private readonly clock: Clock) {}

  async enqueue(input: {
    cast_id: string;
    target_clone_id: string;
    prompt: string;
    priority: 'normal' | 'high';
  }): Promise<WorkItem> {
    const now = this.clock.now();
    const id = `wq-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const item: WorkItem = {
      id,
      cast_id: input.cast_id,
      target_clone_id: input.target_clone_id,
      prompt: input.prompt,
      priority: input.priority,
      enqueued_at: now,
    };
    await atomicMutateJson<WorkQueueFile>(
      this.paths.workQueue,
      empty,
      (current) => {
        current.items.push(item);
        return current;
      },
    );
    return item;
  }

  async dequeue(targetCloneId: string): Promise<WorkItem | null> {
    let found: WorkItem | null = null;
    await atomicMutateJson<WorkQueueFile>(
      this.paths.workQueue,
      empty,
      (current) => {
        // High priority first, then FIFO
        const idx = current.items.findIndex(
          (i) => i.target_clone_id === targetCloneId && !i.claimed_at,
        );
        const highIdx = current.items.findIndex(
          (i) =>
            i.target_clone_id === targetCloneId &&
            !i.claimed_at &&
            i.priority === 'high',
        );
        const pick = highIdx !== -1 ? highIdx : idx;
        if (pick !== -1) {
          current.items[pick]!.claimed_at = this.clock.now();
          found = { ...current.items[pick]! };
        }
        return current;
      },
    );
    return found;
  }

  async complete(itemId: string): Promise<void> {
    await atomicMutateJson<WorkQueueFile>(
      this.paths.workQueue,
      empty,
      (current) => {
        const item = current.items.find((i) => i.id === itemId);
        if (item) item.completed_at = this.clock.now();
        return current;
      },
    );
  }

  async pending(targetCloneId: string): Promise<WorkItem[]> {
    const file = await atomicReadJson<WorkQueueFile>(this.paths.workQueue, empty);
    return file.items.filter(
      (i) => i.target_clone_id === targetCloneId && !i.claimed_at,
    );
  }
}
```

**Changes to `state/paths.ts`:** Add `workQueue` path:
```typescript
// In busPaths():
workQueue: join(root, 'work-queue.json'),
```

**Changes to `tools/index.ts` (BusContext):** Add `workQueue` as **optional** to BusContext so existing construction sites (`runtime.ts`, `server.ts`) don't break until Chunk 2 wires it up:
```typescript
export interface BusContext {
  // ... existing ...
  workQueue?: WorkQueueStore;
}
```
The `createWorkHandlers` Pick type must also widen to include `'workQueue'`:
```typescript
export function createWorkHandlers(
  ctx: Pick<BusContext, 'claims' | 'events' | 'registry' | 'workQueue'>,
): WorkHandlers
```
The `enqueue` handler must assert `ctx.workQueue` exists (throw if undefined — only possible if called before Chunk 2 wires it up in runtime/server).

**Changes to `tools/work.ts`:** Add `enqueue` handler:
```typescript
export interface WorkHandlers {
  claim(input: unknown): Promise<{ claim: WorkClaim; event: BusEvent }>;
  release(input: unknown): Promise<{ event: BusEvent }>;
  enqueue(input: unknown): Promise<{ item: WorkItem; event: BusEvent }>;
}

// In createWorkHandlers:
async enqueue(input) {
  const parsed = parse(EnqueueWorkInputSchema, input, 'enqueue_work');
  const item = await ctx.workQueue.enqueue({
    cast_id: parsed.cast_id,
    target_clone_id: parsed.target_clone_id,
    prompt: parsed.prompt,
    priority: parsed.priority,
  });
  const event = await ctx.events.append({
    type: 'enqueue_work',
    clone_id: parsed.target_clone_id,
    payload: { item_id: item.id, cast_id: parsed.cast_id, priority: parsed.priority },
  });
  return { item, event };
},
```

**Tests:**
- `packages/manta-bus/tests/tools/communication.test.ts` — feedback handler tests (~25 LOC)
- `packages/manta-bus/tests/state/work-queue.test.ts` — **new file**: enqueue, dequeue, complete, pending, priority ordering (~60 LOC)
- `packages/manta-bus/tests/tools/work.test.ts` — enqueue handler tests (~25 LOC)

~130 LOC production (new file + modifications), ~110 LOC tests.

### Task 1.5 — Server wiring for new MCP tools (bus)

**Package:** `@manta/bus`
**Files:**
- `packages/manta-bus/src/server.ts` — register 6 new tools
- `packages/manta-bus/src/index.ts` — re-export new types
**Assigned to:** Clone A

**Changes to server.ts:**

1. Import `WorkQueueStore` and instantiate in `createBusServer`:
```typescript
import { WorkQueueStore } from './state/work-queue';
// In createBusServer:
const workQueue = new WorkQueueStore(paths, clock);
// Add to context:
const context: BusContext = { /* ...existing... */, workQueue };
```

2. Add 6 new tool entries to the `tools` array (after the existing 19 entries):
```typescript
{
  name: 'manta.retask',
  description: 'Re-task an IDLE/WAITING daemon clone with new work',
  inputSchema: jsonSchema(),
  handle: (args) => lifecycle.retask(args),
},
{
  name: 'manta.pause',
  description: 'Pause a working daemon clone (transitions to IDLE)',
  inputSchema: jsonSchema(),
  handle: (args) => lifecycle.pause(args),
},
{
  name: 'manta.resume',
  description: 'Resume a paused daemon clone (transitions to WORKING)',
  inputSchema: jsonSchema(),
  handle: (args) => lifecycle.resume(args),
},
{
  name: 'manta.request_task',
  description: 'Clone signals it is idle and waiting for new work',
  inputSchema: jsonSchema(),
  handle: (args) => lifecycle.requestTask(args),
},
{
  name: 'manta.feedback',
  description: 'Send directed feedback to a working or idle clone',
  inputSchema: jsonSchema(),
  handle: (args) => comm.feedback(args),
},
{
  name: 'manta.enqueue_work',
  description: 'Enqueue a work item for a daemon clone',
  inputSchema: jsonSchema(),
  handle: (args) => work.enqueue(args),
},
```

**Changes to index.ts:** Re-export new types:
```typescript
// Add to existing re-exports from schema:
export type {
  RetaskInput, PauseInput, ResumeInput,
  FeedbackInput, RequestTaskInput, EnqueueWorkInput,
} from './schema';
export type { WorkItem } from './state/work-queue';
export { WorkQueueStore } from './state/work-queue';
```

**Tests:** `packages/manta-bus/tests/server.test.ts` (extend existing):
- `lists all 25 tools (19 existing + 6 new)`
- `dispatches manta.retask to lifecycle handler`
- `dispatches manta.pause to lifecycle handler`
- `dispatches manta.resume to lifecycle handler`
- `dispatches manta.request_task to lifecycle handler`
- `dispatches manta.feedback to communication handler`
- `dispatches manta.enqueue_work to work handler`
- `auto-touch fires for new tool calls (clone_id extraction works)`

~35 LOC production, ~40 LOC tests.

### Task 1.6 — Health monitor: IDLE-aware death detection (orchestrator)

**Package:** `@manta/orchestrator`
**Files:**
- `packages/manta-orchestrator/src/death-detector.ts` — IDLE-aware branches
- `packages/manta-orchestrator/src/thresholds.ts` — new daemon thresholds
- `packages/manta-orchestrator/src/orchestrator.ts` — daemon cycle awareness
**Assigned to:** Clone A

**Changes to thresholds.ts:**

1. Add 3 new fields to `ThresholdsSchema` **with `.default()` values** (prevents breaking existing construction sites in tests):
```typescript
export const ThresholdsSchema = z
  .object({
    // ... existing 8 fields ...
    idleHeartbeatTimeoutMs: z.number().int().positive().default(600_000),
    maxIdleTimeMs: z.number().int().positive().default(300_000),
    daemonMaxLifetimeMs: z.number().int().positive().default(3_600_000),
  })
  .strict();
```
**IMPORTANT:** `.default()` ensures existing test files constructing partial `Thresholds` objects continue to parse. Without defaults, every test building `{ heartbeatTimeoutMs: X, ... }` without the 3 new fields would fail TypeScript compilation against the inferred output type. Verify no test files in `packages/manta-orchestrator/tests/` hardcode `Thresholds` objects — if they do, they'll need the new fields OR rely on the defaults via `ThresholdsSchema.parse()`.

2. Add defaults:
```typescript
export const defaultThresholds: Thresholds = {
  // ... existing ...
  idleHeartbeatTimeoutMs: 600_000,   // 10 min — IDLE clones get longer grace
  maxIdleTimeMs: 300_000,            // 5 min — auto-terminate if no new work
  daemonMaxLifetimeMs: 3_600_000,    // 1 hr — hard ceiling on daemon sessions
};
```

**Changes to death-detector.ts:**

Replace the current state branching (lines 30-44) with IDLE-aware logic:

```typescript
export async function findDeadClones(
  ctx: Pick<BusContext, 'registry' | 'clock'>,
  options: FindDeadCloneOptions,
): Promise<DeadCloneFinding[]> {
  const all = await ctx.registry.list();
  const now = ctx.clock.now();
  const out: DeadCloneFinding[] = [];
  for (const r of all) {
    if (r.state === 'DEAD') continue;
    const reasons: string[] = [];

    if (r.state === 'STARTING') {
      const sinceRegistered = now - r.registered_at;
      if (sinceRegistered > options.thresholds.startupGraceMs) {
        reasons.push(
          `startup grace ${sinceRegistered}ms > ${options.thresholds.startupGraceMs}ms (no first heartbeat)`,
        );
      }
    } else if (r.state === 'IDLE' || r.state === 'WAITING_FOR_TASK') {
      // Daemon clones in IDLE/WAITING get an extended heartbeat timeout
      const sinceHeartbeat = now - r.last_heartbeat_at;
      if (sinceHeartbeat > options.thresholds.idleHeartbeatTimeoutMs) {
        reasons.push(
          `idle heartbeat ${sinceHeartbeat}ms ago > ${options.thresholds.idleHeartbeatTimeoutMs}ms`,
        );
      }
      // Also check idle duration for auto-termination
      if (r.idle_since != null) {
        const idleDuration = now - r.idle_since;
        if (idleDuration > options.thresholds.maxIdleTimeMs) {
          reasons.push(
            `idle for ${idleDuration}ms > maxIdleTimeMs ${options.thresholds.maxIdleTimeMs}ms`,
          );
        }
      }
    } else {
      const sinceHeartbeat = now - r.last_heartbeat_at;
      if (sinceHeartbeat > options.thresholds.heartbeatTimeoutMs) {
        reasons.push(
          `heartbeat ${sinceHeartbeat}ms ago > ${options.thresholds.heartbeatTimeoutMs}ms`,
        );
      }
    }

    // Daemon session lifetime check
    if (r.session_mode === 'daemon') {
      const sessionAge = now - r.registered_at;
      if (sessionAge > options.thresholds.daemonMaxLifetimeMs) {
        reasons.push(
          `daemon session ${sessionAge}ms > daemonMaxLifetimeMs ${options.thresholds.daemonMaxLifetimeMs}ms`,
        );
      }
    }

    if (options.thresholds.parentPidCheckEnabled && !options.probe.alive(r.parent_pid)) {
      reasons.push(`parent pid ${r.parent_pid} not alive`);
    }
    if (reasons.length > 0) {
      out.push({ clone_id: r.clone_id, record: r, reason: reasons.join('; ') });
    }
  }
  return out;
}
```

**Changes to orchestrator.ts:**

Add `idleClones` to `CycleResult`:
```typescript
export interface CycleResult {
  // ... existing ...
  idleClones: Array<{ clone_id: string; idle_since: number }>;
}
```

In `runCycle()`, after `findDeadClones`, collect idle clones:
```typescript
const allClones = await this.opts.ctx.registry.list();
const idleClones = allClones
  .filter((c) => c.state === 'IDLE' || c.state === 'WAITING_FOR_TASK')
  .map((c) => ({ clone_id: c.clone_id, idle_since: c.idle_since ?? c.last_heartbeat_at }));
```

**Tests:**
- `packages/manta-orchestrator/tests/death-detector.test.ts` (extend existing):
  - `IDLE clone NOT killed within idleHeartbeatTimeoutMs`
  - `IDLE clone killed when heartbeat exceeds idleHeartbeatTimeoutMs`
  - `IDLE clone killed when idle exceeds maxIdleTimeMs`
  - `WAITING_FOR_TASK clone uses extended timeout`
  - `daemon clone killed when session exceeds daemonMaxLifetimeMs`
  - `batch clone NOT affected by daemon thresholds`
- `packages/manta-orchestrator/tests/thresholds.test.ts` (extend existing):
  - `new daemon threshold fields parse correctly`
  - `new daemon threshold fields have correct defaults`
- `packages/manta-orchestrator/tests/orchestrator.test.ts` (extend existing):
  - `runCycle reports idle clones in CycleResult`
  - `runCycle does NOT post-mortem IDLE clones`

~70 LOC production (modified across 3 files), ~90 LOC tests.

### Clone Assignment Strategy (Chunk 1)

**Clone A** — Schema + Registry + Server wiring + Health monitor (tasks 1.1, 1.2, 1.5, 1.6):
- **Owns all shared prereqs:** CloneStateSchema expansion, new input schemas, Registry.retask(), BusContext.workQueue, thresholds expansion
- These are foundation types/methods that Clone B's handlers depend on
- Server wiring ensures tools are registered
- Health monitor consumes the new registry fields

**Clone B** — Tool handlers + Work queue (tasks 1.3, 1.4):
- Lifecycle handlers (retask, pause, resume, requestTask) — calls `registry.retask()` created by Clone A
- Communication handler (feedback)
- WorkQueueStore (new file, self-contained)
- Work handler (enqueue) — consumes WorkQueueStore

**Dependency note for Clone B:** Your lifecycle handlers call `registry.retask()` and your work handler uses `WorkQueueStore` — Clone A creates both. Write your handler code against the interfaces from this plan. In your worktree, the `registry.retask()` method won't exist until merge. Your unit tests should mock the registry (existing pattern in `lifecycle.test.ts`). For `WorkQueueStore`, you create it yourself (Task 1.4), so no cross-dependency.

**Dependency note for Clone A:** Your server wiring (Task 1.5) registers handlers from `lifecycle.retask()` and `work.enqueue()` which Clone B creates. In your worktree, add the tool entries pointing to `lifecycle.retask(args)` and `work.enqueue(args)` — these will resolve at merge time. Your server.test.ts should test tool dispatch via integration (full bus context), same pattern as existing server tests.

---

## Chunk 2 — CLI Daemon Spawn + Commands

**Cast mode:** `forking-realities` with 2 clones
**Estimated LOC:** ~680 (code + tests)
**Depends on:** Chunk 1 merged (new schemas, registry methods, bus tools, health monitor)

### Design Decisions

- **DaemonRunner** is a new `CloneRunner` implementation alongside `runClaudeCli` and `runFakeCloneScript` — same interface, different spawn args (`--session-id` instead of bare `--print`).
- **daemon-loop.ts** is the orchestrator-side resume polling loop — separate from `tick-loop.ts` which continues to handle the death-detector cycle. `tick-loop.ts` runs daemon-loop inside its cycle for daemon-mode casts.
- **New commands** (daemon, retask, feedback) follow existing patterns (commander subcommand, `runWithRuntime`, reporter).
- **Priming** adds daemon-specific blocks conditional on `snapshot.sessionMode`.
- **cast.ts** adds Wave 2 modes to `SUPPORTED_MODES` but does NOT implement iteration protocols (Phase 6).

### Task 2.1 — clone-spawner.ts: `--session-id` support + DaemonRunner (cli)

**Package:** `@manta/cli`
**File:** `packages/manta-cli/src/spawner/clone-spawner.ts`
**Assigned to:** Clone A (owns all spawner changes — shared prereq for daemon-loop)

**Changes:**

1. **CloneRunnerInput** (line 22): Add optional `sessionId`:
```typescript
export interface CloneRunnerInput {
  cwd: string;
  env: Record<string, string>;
  appendSystemPrompt: string;
  prompt: string;
  /** Session ID for daemon mode (enables --resume across invocations). */
  sessionId?: string;
}
```

2. **CloneHandle** (line 68): Add daemon fields:
```typescript
export interface CloneHandle {
  cloneId: string;
  pid: number | undefined;
  snapshotPath: string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: (signal: NodeJS.Signals) => void;
  terminate: (opts?: { gracefulMs?: number }) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Session ID for daemon resume. Only set when session_mode === 'daemon'. */
  sessionId?: string;
  /** Whether this handle is a daemon (supports resume). */
  isDaemon: boolean;
}
```

3. **`runClaudeCli()`** (line 265): Pass `--session-id` when provided:
```typescript
export function runClaudeCli(opts: RunClaudeCliOptions = {}): CloneRunner {
  const bin = opts.claudeBin ?? 'claude';
  return {
    run(input) {
      const sessionArgs: string[] = input.sessionId
        ? ['--session-id', input.sessionId]
        : [];
      return execa(
        bin,
        [
          '--print',
          ...sessionArgs,
          ...(opts.extraArgs ?? []),
          '--append-system-prompt',
          input.appendSystemPrompt,
          '--permission-mode',
          'bypassPermissions',
          input.prompt,
        ],
        { cwd: input.cwd, env: { ...process.env, ...input.env }, reject: false },
      );
    },
  };
}
```

4. **New function: `runClaudeResume()`** — Resumes an existing session with a new prompt:
```typescript
export interface ResumeOptions {
  claudeBin?: string;
  sessionId: string;
  extraArgs?: string[];
}

export function runClaudeResume(opts: ResumeOptions): CloneRunner {
  const bin = opts.claudeBin ?? 'claude';
  return {
    run(input) {
      return execa(
        bin,
        [
          '--print',
          '--resume', opts.sessionId,
          ...(opts.extraArgs ?? []),
          '--append-system-prompt',
          input.appendSystemPrompt,
          '--permission-mode',
          'bypassPermissions',
          input.prompt,
        ],
        { cwd: input.cwd, env: { ...process.env, ...input.env }, reject: false },
      );
    },
  };
}
```

5. **`spawnClone()`**: Propagate `sessionId` from snapshot to `CloneHandle`:
```typescript
// At end of spawnClone(), in the return:
return {
  cloneId,
  pid: proc.pid,
  snapshotPath,
  exit,
  kill: (signal) => { proc.kill(signal); },
  terminate,
  sessionId: opts.snapshot.sessionId,
  isDaemon: opts.snapshot.sessionMode === 'daemon',
};
```

6. **SpawnCloneOptions**: No change — `sessionId` flows through the snapshot.

**Tests:** `packages/manta-cli/tests/spawner/clone-spawner.test.ts` (extend existing):
- `runClaudeCli passes --session-id when provided`
- `runClaudeCli omits --session-id when not provided`
- `runClaudeResume passes --resume with session-id`
- `CloneHandle.sessionId is set for daemon snapshots`
- `CloneHandle.isDaemon is true for daemon snapshots, false for batch`

~60 LOC production, ~40 LOC tests.

### Task 2.2 — daemon-loop.ts: orchestrator-side resume polling (cli)

**Package:** `@manta/cli`
**File:** `packages/manta-cli/src/daemon-loop.ts` — **new file**
**Assigned to:** Clone A (depends on Task 2.1 spawner changes)

The daemon loop polls the work queue for pending items, then resumes the clone session with the item as prompt. Each resume is a separate `claude --print --resume` invocation.

```typescript
import type { WorkQueueStore, WorkItem } from '@manta/bus';
import type { CloneRunner, CloneHandle } from './spawner/clone-spawner.js';
import { runClaudeResume } from './spawner/clone-spawner.js';
import { sleep } from './util/sleep.js';

export interface DaemonLoopOptions {
  sessionId: string;
  cloneId: string;
  castId: string;
  worktree: string;
  repoRoot: string;
  workQueue: WorkQueueStore;
  appendSystemPrompt: string;
  env: Record<string, string>;
  pollIntervalMs: number;
  maxResumeFailures: number;
  /** Max consecutive empty polls before exiting with 'no_work'. Default 60 (~5 min at 5s interval). */
  maxEmptyPolls: number;
  signal?: AbortSignal;
  claudeBin?: string;
  /** Called after each successful resume cycle. */
  onCycleComplete?: (item: WorkItem) => Promise<void>;
}

export interface DaemonLoopResult {
  resumeCycles: number;
  itemsCompleted: string[];
  exitReason: 'no_work' | 'budget_exhausted' | 'aborted' | 'max_failures';
}

export async function runDaemonLoop(
  opts: DaemonLoopOptions,
): Promise<DaemonLoopResult> {
  let resumeCycles = 0;
  let consecutiveFailures = 0;
  let emptyPolls = 0;
  const itemsCompleted: string[] = [];

  for (;;) {
    if (opts.signal?.aborted) {
      return { resumeCycles, itemsCompleted, exitReason: 'aborted' };
    }

    const item = await opts.workQueue.dequeue(opts.cloneId);
    if (!item) {
      emptyPolls++;
      if (emptyPolls >= opts.maxEmptyPolls) {
        return { resumeCycles, itemsCompleted, exitReason: 'no_work' };
      }
      await sleep(opts.pollIntervalMs, opts.signal);
      continue;
    }
    emptyPolls = 0; // reset on successful dequeue

    // Resume the session with the work item as prompt
    const runner = runClaudeResume({
      sessionId: opts.sessionId,
      claudeBin: opts.claudeBin,
    });
    const proc = runner.run({
      cwd: opts.worktree,
      env: opts.env,
      appendSystemPrompt: opts.appendSystemPrompt,
      prompt: item.prompt,
    });

    let exitResult: { exitCode?: number | null; failed?: boolean };
    try {
      exitResult = await proc;
    } catch (err) {
      exitResult = err as { exitCode?: number | null; failed?: boolean };
    }

    if (exitResult.failed && exitResult.exitCode == null) {
      consecutiveFailures++;
      if (consecutiveFailures >= opts.maxResumeFailures) {
        return { resumeCycles, itemsCompleted, exitReason: 'max_failures' };
      }
      continue;
    }

    // Mark work item complete
    await opts.workQueue.complete(item.id);
    itemsCompleted.push(item.id);
    resumeCycles++;
    consecutiveFailures = 0;

    if (opts.onCycleComplete) {
      await opts.onCycleComplete(item);
    }
  }
}
```

**Note:** The `runDaemonLoop` is invoked by the tick-loop (Task 2.3) in a non-blocking fashion — it runs alongside the death-detector cycle. The tick-loop checks for pending work items and spawns resume processes.

**Tests:** `packages/manta-cli/tests/daemon-loop.test.ts` — **new file**:
- `resumes session with work item prompt`
- `polls work queue and sleeps when empty`
- `marks item complete after successful resume`
- `increments failure count on resume failure`
- `exits with max_failures after consecutive failures`
- `exits with aborted when signal fires`
- `calls onCycleComplete after each item`

~80 LOC production, ~70 LOC tests.

### Task 2.3 — tick-loop.ts: daemon mode branch (cli)

**Package:** `@manta/cli`
**File:** `packages/manta-cli/src/tick-loop.ts`
**Assigned to:** Clone B

**Changes:**

1. **RunTickLoopOptions**: Add daemon fields:
```typescript
export interface RunTickLoopOptions {
  orchestrator: Orchestrator;
  intervalMs: number;
  allDone: () => Promise<boolean>;
  signal?: AbortSignal;
  /** Daemon mode: loop continues while IDLE clones exist (batch: exits when all DEAD). */
  daemonMode?: boolean;
}
```

2. **TickLoopResult**: Add daemon field:
```typescript
export interface TickLoopResult {
  cycles: number;
  aborted: boolean;
  /** Daemon mode only: number of daemon resume cycles completed. */
  daemonResumeCycles?: number;
}
```

3. **Loop body**: In daemon mode, `allDone` semantics change — loop continues as long as at least one clone is not DEAD. IDLE clones keep the loop alive:
```typescript
export async function runTickLoop(opts: RunTickLoopOptions): Promise<TickLoopResult> {
  let cycles = 0;
  let aborted = false;
  for (;;) {
    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }
    try {
      await opts.orchestrator.runCycle();
    } catch (err) {
      throw new CliError('orchestrator cycle failed', {
        kind: 'orchestrator_failed',
        cause: err,
      });
    }
    cycles += 1;
    if (await opts.allDone()) break;
    await sleep(opts.intervalMs, opts.signal);
  }
  return { cycles, aborted };
}
```

**Note:** The `allDone` function is constructed differently in `cast.ts` for daemon mode (Task 2.5). The tick-loop itself does not need structural changes beyond the interface expansion — the daemon-awareness lives in the `allDone` callback.

~15 LOC production (interface changes), ~30 LOC tests in `packages/manta-cli/tests/tick-loop.test.ts` (extend existing):
- `daemon mode: loop survives when clones are IDLE`
- `daemon mode: loop exits when all clones are DEAD`

### Task 2.4 — Snapshot schema: sessionMode field (snapshot)

**Package:** `@manta/snapshot`
**File:** `packages/manta-snapshot/src/schema.ts`
**Assigned to:** Clone B

**Changes:**

1. **SnapshotSchema** (line 61): Add `sessionMode` field:
```typescript
export const SnapshotSchema = z
  .object({
    // ... existing fields ...
    sessionMode: z.enum(['batch', 'daemon']).default('batch'),
    sessionId: z.string().min(1).optional(),
  })
  .refine(/* existing refinement */);
```

2. **TaskContractSchema** (line 25): Add `sessionMode`:
```typescript
export const TaskContractSchema = z.object({
  // ... existing fields ...
  sessionMode: z.enum(['batch', 'daemon']).default('batch'),
});
```

3. **capture.ts** (`packages/manta-snapshot/src/capture.ts`): Update `CaptureInput` interface to include `sessionMode` and `sessionId`:
```typescript
export interface CaptureInput {
  // ... existing fields ...
  sessionMode?: 'batch' | 'daemon';
  sessionId?: string;
}
```
Update `captureState()` to propagate these to the returned Snapshot object.

4. **snapshot-builder.ts** (`packages/manta-cli/src/spawner/snapshot-builder.ts`): Add `sessionMode` and `sessionId` to `CloneSpawnRequest` and propagation:
```typescript
export interface CloneSpawnRequest {
  // ... existing ...
  sessionMode?: 'batch' | 'daemon';
  sessionId?: string;
}

export function buildCloneSnapshot(req: CloneSpawnRequest): Snapshot {
  // ... existing ...
  const sessionMode = req.sessionMode ?? 'batch';
  const sessionId = req.sessionId ?? undefined;
  return captureState({
    // ... existing fields ...
    sessionMode,
    sessionId,
    taskContract: {
      // ... existing ...
      sessionMode,
    },
  });
}
```

**Tests:** `packages/manta-snapshot/tests/schema.test.ts` (extend or create):
- `SnapshotSchema defaults sessionMode to 'batch'`
- `SnapshotSchema accepts 'daemon' sessionMode`
- `SnapshotSchema accepts optional sessionId`
- `TaskContractSchema defaults sessionMode to 'batch'`
- `Backward compat: existing snapshots without sessionMode parse as 'batch'`

~15 LOC production, ~25 LOC tests.

### Task 2.5 — cast.ts: Wave 2 mode dispatch (cli)

**Package:** `@manta/cli`
**File:** `packages/manta-cli/src/commands/cast.ts`
**Assigned to:** Clone B

**Changes:**

1. **SUPPORTED_MODES** (line 29): Add Wave 2 modes:
```typescript
const SUPPORTED_MODES: ReadonlySet<Mode> = new Set<Mode>([
  'recon-swarm',
  'forking-realities',
  'bug-hunt',
  'refactor-wave',
  'pair-programming',
  'test-storm',
  'documentation-chase',
]);
```

2. **DAEMON_MODES** constant:
```typescript
const DAEMON_MODES: ReadonlySet<Mode> = new Set<Mode>([
  'pair-programming',
  'test-storm',
  'documentation-chase',
]);
```

3. **Session mode detection**: In `runCastCommand`, after scope validation:
```typescript
const sessionMode = DAEMON_MODES.has(opts.mode) ? 'daemon' as const : 'batch' as const;
```

4. **castPolicy**: Include `session_mode`:
```typescript
const castPolicy: CastPolicy =
  (opts.mode === 'forking-realities' || opts.mode === 'refactor-wave')
    ? { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: sessionMode }
    : { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: sessionMode };
```

5. **Snapshot building**: Pass `sessionMode` and `sessionId`:
```typescript
const sessionId = sessionMode === 'daemon'
  ? `${opts.castId}-${cloneId}-${Date.now()}`
  : undefined;
const snap = buildCloneSnapshot({
  // ... existing fields ...
  sessionMode,
  sessionId,
});
```

6. **allDone() for daemon mode**: When `sessionMode === 'daemon'`, exit condition changes:
```typescript
allDone: async () => {
  const all = await rt.ctx.registry.list();
  const ours = all.filter((c) => cloneIds.includes(c.clone_id));
  if (ours.length < cloneIds.length) return false;
  if (sessionMode === 'batch') {
    return ours.every((c) => c.state === 'DEAD');
  }
  // Daemon mode: done when all clones are DEAD, OR all clones
  // are IDLE with no pending work items in the queue.
  const allDead = ours.every((c) => c.state === 'DEAD');
  if (allDead) return true;
  const allIdleOrDead = ours.every(
    (c) => c.state === 'DEAD' || c.state === 'IDLE',
  );
  if (!allIdleOrDead) return false; // still working
  // All idle — check if work queue is empty
  const pending = rt.ctx.workQueue
    ? await rt.ctx.workQueue.pending(cloneIds)
    : 0;
  return pending === 0;
},
```

**Note:** In Phase 5, daemon mode casts start and manage their lifecycle through the work queue + daemon-loop (Task 2.2). The actual iteration protocols (pair-programming review cycles, etc.) are Phase 6. Phase 5 daemon casts run a single initial task and then the daemon-loop polls for additional work items enqueued via `manta.enqueue_work` or the `manta retask` command.

7. **Mode-specific clone count validation**:
```typescript
if (opts.mode === 'pair-programming' && opts.cloneCount !== 2) {
  throw new CliError(
    'pair-programming mode requires exactly 2 clones (writer + reviewer)',
    { kind: 'invalid_input' },
  );
}
if (opts.mode === 'test-storm' && (opts.cloneCount < 2 || opts.cloneCount > 3)) {
  throw new CliError(
    'test-storm mode requires 2-3 clones (spec Sec 2)',
    { kind: 'invalid_input' },
  );
}
```

**Tests:** `packages/manta-cli/tests/commands/cast.test.ts` (extend existing):
- `accepts pair-programming as valid mode`
- `accepts test-storm as valid mode`
- `accepts documentation-chase as valid mode`
- `pair-programming requires exactly 2 clones`
- `test-storm requires 2-3 clones`
- `daemon modes set session_mode = daemon on castPolicy`
- `daemon modes generate sessionId in snapshot`
- `batch modes leave sessionMode = batch (regression)`

~50 LOC production, ~60 LOC tests.

### Task 2.6 — Priming: daemon mode blocks (cli)

**Package:** `@manta/cli`
**File:** `packages/manta-cli/src/spawner/priming.ts`
**Assigned to:** Clone A

**Changes:**

1. **New constant: DAEMON_MODE_BLOCK**:
```typescript
const DAEMON_MODE_BLOCK = `
## Daemon Mode (Persistent Clone)
You are a daemon clone. Your lifecycle differs from batch clones:

AFTER COMPLETING A TASK:
1. Write deliverables and commit to your branch (same as batch)
2. Call manta.heartbeat({ clone_id: "{CLONE_ID}", state: "IDLE" }) — do NOT call manta-graceful-death
3. Call manta.request_task({ clone_id: "{CLONE_ID}" }) to signal you are ready for new work
4. The orchestrator will resume your session with the next work item via manta.retask

SESSION END (only when explicitly told to stop or budget exhausted):
1. Follow the normal manta-graceful-death sequence (last-gasp report, commit, zk_write, suicide_intent, report_death)

CRITICAL DIFFERENCE FROM BATCH: Do NOT call manta-graceful-death after each task. Only at session end.

CHECK FOR FEEDBACK: Between tasks, read manta.read_broadcasts for feedback from main or sibling clones.
`;
```

2. **New constant: PAIR_PROTOCOL_BLOCK** (soft guidance — Phase 6 will add hard enforcement):
```typescript
const PAIR_PROTOCOL_BLOCK = `
## Pair-Programming Protocol
You are in a pair-programming cast with a sibling clone. One of you is the writer, the other the reviewer.
Your role is specified in your task contract.

WRITER: Implement the task, commit, then broadcast task_complete. Transition to IDLE and wait for reviewer feedback.
REVIEWER: Wait for writer broadcast, review the diff, broadcast feedback. Writer applies feedback and re-commits.
Iterate until convergence (reviewer approves) or iteration budget exhausted.
`;
```

3. **buildPrimingText()**: Add daemon mode detection:
```typescript
const daemonBlock =
  snapshot.sessionMode === 'daemon'
    ? `\n${DAEMON_MODE_BLOCK.replaceAll('{CLONE_ID}', snapshot.taskContract.cloneId)}`
    : '';
const pairBlock =
  snapshot.taskContract.mode === 'pair-programming'
    ? `\n${PAIR_PROTOCOL_BLOCK}`
    : '';
```

Insert `{DAEMON_BLOCK}{PAIR_BLOCK}` placeholders in template and replace.

**Tests:** `packages/manta-cli/tests/spawner/priming.test.ts` (extend existing):
- `includes DAEMON_MODE_BLOCK when sessionMode is daemon`
- `does not include DAEMON_MODE_BLOCK for batch mode`
- `includes PAIR_PROTOCOL_BLOCK for pair-programming mode`
- `daemon block contains correct clone_id substitution`

~35 LOC production, ~30 LOC tests.

### Task 2.7 — New CLI commands: daemon, retask, feedback (cli)

**Package:** `@manta/cli`
**Files:**
- `packages/manta-cli/src/commands/daemon.ts` — **new file**
- `packages/manta-cli/src/commands/retask.ts` — **new file**
- `packages/manta-cli/src/commands/feedback.ts` — **new file**
- `packages/manta-cli/src/errors.ts` — extend CliErrorKind
- `packages/manta-cli/src/bin/manta.ts` — register new commands
**Assigned to:** Clone B

**daemon.ts** (~40 LOC):
```typescript
import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';

export interface DaemonStatusOptions {
  reporter: Reporter;
}

export async function runDaemonStatusCommand(
  rt: Runtime,
  opts: DaemonStatusOptions,
): Promise<CommandResult> {
  const allClones = await rt.ctx.registry.list();
  const daemonClones = allClones.filter(
    (c) => c.session_mode === 'daemon' && c.state !== 'DEAD',
  );
  if (daemonClones.length === 0) {
    return { exitCode: 0, stdout: 'No active daemon clones.' };
  }
  const lines = daemonClones.map((c) =>
    `${c.clone_id}\t${c.state}\ttasks=${c.tasks_completed ?? 0}\tidle_since=${c.idle_since ? new Date(c.idle_since).toISOString() : 'n/a'}`,
  );
  return { exitCode: 0, stdout: `Active daemon clones:\n${lines.join('\n')}` };
}

export interface DaemonStopOptions {
  reporter: Reporter;
  reason?: string;
}

export async function runDaemonStopCommand(
  rt: Runtime,
  opts: DaemonStopOptions,
): Promise<CommandResult> {
  const allClones = await rt.ctx.registry.list();
  const daemonClones = allClones.filter(
    (c) => c.session_mode === 'daemon' && c.state !== 'DEAD',
  );
  for (const c of daemonClones) {
    await rt.ctx.registry.markDead(
      c.clone_id,
      opts.reason ?? 'daemon stop command',
    );
  }
  return {
    exitCode: 0,
    stdout: `Stopped ${daemonClones.length} daemon clone(s).`,
  };
}
```

**retask.ts** (~35 LOC):
```typescript
import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { CliError } from '../errors.js';

export interface RetaskOptions {
  cloneId: string;
  task: string;
  reporter: Reporter;
}

export async function runRetaskCommand(
  rt: Runtime,
  opts: RetaskOptions,
): Promise<CommandResult> {
  try {
    // Append audit event first (reviewer fix: CLI path must not bypass audit trail)
    await rt.ctx.events.append({
      type: 'retask',
      clone_id: opts.cloneId,
      payload: { new_task: opts.task, source: 'cli' },
    });
    const clone = await rt.ctx.registry.retask(opts.cloneId, opts.task);
    // Enqueue the task as a work item for the daemon loop to pick up
    if (rt.ctx.workQueue) {
      await rt.ctx.workQueue.enqueue({
        cast_id: clone.metadata?.cast_id ?? 'unknown',
        target_clone_id: opts.cloneId,
        prompt: opts.task,
        priority: 'normal',
      });
    }
    opts.reporter.info('retask', { cloneId: opts.cloneId });
    return { exitCode: 0, stdout: `Re-tasked clone ${opts.cloneId}.` };
  } catch (err) {
    throw new CliError(`retask failed for ${opts.cloneId}`, {
      kind: 'retask_failed',
      cause: err,
    });
  }
}
```

**feedback.ts** (~30 LOC):
```typescript
import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { CliError } from '../errors.js';

export interface FeedbackOptions {
  cloneId: string;
  message: string;
  severity: 'info' | 'correction' | 'blocker';
  reporter: Reporter;
}

export async function runFeedbackCommand(
  rt: Runtime,
  opts: FeedbackOptions,
): Promise<CommandResult> {
  try {
    await rt.ctx.events.append({
      type: 'feedback',
      clone_id: opts.cloneId,
      payload: {
        from: 'main',
        feedback: opts.message,
        severity: opts.severity,
      },
    });
    opts.reporter.info('feedback', { cloneId: opts.cloneId, severity: opts.severity });
    return { exitCode: 0, stdout: `Feedback sent to clone ${opts.cloneId}.` };
  } catch (err) {
    throw new CliError(`feedback failed for ${opts.cloneId}`, {
      kind: 'feedback_failed',
      cause: err,
    });
  }
}
```

**Changes to errors.ts:**
```typescript
export type CliErrorKind =
  | 'invalid_input'
  | 'cast_failed'
  | 'spawn_failed'
  | 'register_failed'
  | 'orchestrator_failed'
  | 'recovery_failed'
  | 'not_found'
  | 'budget_gate_failed'
  | 'daemon_failed'
  | 'retask_failed'
  | 'feedback_failed';
```

**Changes to bin/manta.ts:** Register new commands:
```typescript
import { runDaemonStatusCommand, runDaemonStopCommand } from '../commands/daemon.js';
import { runRetaskCommand } from '../commands/retask.js';
import { runFeedbackCommand } from '../commands/feedback.js';

// After existing commands:
const daemonCmd = program
  .command('daemon')
  .description('Manage daemon (persistent) clones');

daemonCmd
  .command('status')
  .description('Show active daemon clones')
  .action(async () => {
    await runWithRuntime((rt) => runDaemonStatusCommand(rt, { reporter }));
  });

daemonCmd
  .command('stop')
  .description('Stop all daemon clones')
  .option('-r, --reason <reason>', 'stop reason', 'manual stop')
  .action(async (options: { reason: string }) => {
    await runWithRuntime((rt) => runDaemonStopCommand(rt, { reason: options.reason, reporter }));
  });

program
  .command('retask <cloneId>')
  .description('Re-task an idle daemon clone with new work')
  .requiredOption('-t, --task <task>', 'new task description')
  .action(async (cloneId: string, options: { task: string }) => {
    await runWithRuntime((rt) =>
      runRetaskCommand(rt, { cloneId, task: options.task, reporter }),
    );
  });

program
  .command('feedback <cloneId>')
  .description('Send directed feedback to a clone')
  .requiredOption('-m, --message <msg>', 'feedback message')
  .option('-s, --severity <level>', 'info|correction|blocker', 'info')
  .action(async (cloneId: string, options: { message: string; severity: string }) => {
    const severity = (['info', 'correction', 'blocker'] as const).includes(
      options.severity as 'info' | 'correction' | 'blocker',
    )
      ? (options.severity as 'info' | 'correction' | 'blocker')
      : 'info';
    await runWithRuntime((rt) =>
      runFeedbackCommand(rt, { cloneId, message: options.message, severity, reporter }),
    );
  });
```

**Changes to runtime.ts:** Add `workQueue` to context:
```typescript
import { WorkQueueStore } from '@manta/bus';
// In createRuntime:
const workQueue = new WorkQueueStore(paths, clock);
const ctx: BusContext = { /* ...existing... */, workQueue };
```

**Tests:**
- `packages/manta-cli/tests/commands/daemon.test.ts` — **new file** (~40 LOC):
  - `daemon status shows daemon clones`
  - `daemon status shows empty message when none`
  - `daemon stop marks all daemon clones DEAD`
- `packages/manta-cli/tests/commands/retask.test.ts` — **new file** (~35 LOC):
  - `retask enqueues work item for clone`
  - `retask rejects non-IDLE clone`
  - `retask rejects unknown clone`
- `packages/manta-cli/tests/commands/feedback.test.ts` — **new file** (~25 LOC):
  - `feedback appends event for clone`
  - `feedback sets correct severity`

~145 LOC production (3 new files + modifications), ~100 LOC tests.

### Task 2.8 — Skills: manta-daemon-idle + manta-pair-protocol (skills)

**Package:** skills (not a TypeScript package — markdown files)
**Files:**
- `skills/manta-daemon-idle/SKILL.md` — **new file**
- `skills/manta-pair-protocol/SKILL.md` — **new file**
- `skills/manta-as-clone/SKILL.md` — append daemon section
- `skills/manta-graceful-death/SKILL.md` — append session-end vs task-end section
**Assigned to:** Clone A

**manta-daemon-idle/SKILL.md** (~30 lines):
```markdown
# manta-daemon-idle

## When IDLE Between Tasks (Daemon Mode)

You have completed your current task and are waiting for new work.

### Protocol
1. Call `manta.heartbeat({ clone_id: "<your-id>", state: "IDLE" })` if not already done
2. Call `manta.request_task({ clone_id: "<your-id>" })` to signal readiness
3. Check `manta.read_broadcasts` for any feedback or coordination messages
4. Do NOT start new work without an explicit re-task from the orchestrator
5. Do NOT call `manta-graceful-death` — session continues

### What You Can Do While Idle
- Review and organize notes from your previous task
- Check `manta.read_broadcasts` for sibling clone updates
- Monitor your session budget remaining

### Session End Signal
If the orchestrator sends a message containing "graceful shutdown" or "session end":
1. Follow the normal `manta-graceful-death` sequence
2. This is the only time you call `manta-graceful-death` in daemon mode
```

**manta-pair-protocol/SKILL.md** (~40 lines):
```markdown
# manta-pair-protocol

## Pair-Programming Mode Protocol

You are in a pair-programming cast. Two clones work together: one writes code, one reviews it.

### Writer Role
1. Read your task contract — it specifies what to implement
2. Write the code, run tests, commit to your branch
3. Broadcast completion: `manta.broadcast({ clone_id: "<your-id>", event_type: "task_complete", payload: { commit_ref: "<sha>", summary: "<one-line>" } })`
4. Transition to IDLE: `manta.heartbeat({ clone_id: "<your-id>", state: "IDLE" })`
5. Wait for reviewer feedback via the next resume cycle
6. Apply feedback, re-commit, broadcast again
7. Repeat until reviewer approves or iteration budget exhausted

### Reviewer Role
1. Wait for the writer's `task_complete` broadcast (delivered in your resume prompt)
2. Review the diff: `git diff main...<writer-branch>`
3. Broadcast review: `manta.broadcast({ clone_id: "<your-id>", event_type: "feedback_received", payload: { verdict: "approved" | "changes_requested", comments: [...] } })`
4. If changes_requested: transition to IDLE and wait for writer's next iteration
5. If approved: both clones proceed to graceful death

### Iteration Budget
Maximum 5 review iterations per task. After 5, escalate to main regardless of state.
```

**Modifications to manta-as-clone/SKILL.md:** Append a section:
```markdown
## Daemon Mode (Wave 2)
If your snapshot has `sessionMode: "daemon"`, your lifecycle differs:
- After completing a task, transition to IDLE (not graceful-death)
- Load `manta-daemon-idle` skill when entering IDLE state
- Session continues until explicit shutdown or budget exhaustion
- All other startup and working rules remain the same
```

**Modifications to manta-graceful-death/SKILL.md:** Append a section:
```markdown
## Daemon Mode: Task-End vs Session-End
- **Task-end (daemon):** Commit deliverables, broadcast task_complete, heartbeat IDLE. Do NOT call suicide_intent or report_death.
- **Session-end (daemon):** Full sequence: last-gasp-report, commit, zk_write, unlock/release, suicide_intent, report_death. Same as batch.
- **Batch mode:** Always full sequence (no change from current behavior).
```

~0 LOC TypeScript (skills are markdown), but important behavioral guidance.

### Task 2.9 — Modified commands: status, kill, abort (daemon-aware) (cli)

**Package:** `@manta/cli`
**Files:**
- `packages/manta-cli/src/commands/status.ts` — show IDLE/WAITING states
- `packages/manta-cli/src/commands/kill.ts` — daemon kill awareness
- `packages/manta-cli/src/commands/abort.ts` — daemon abort awareness
**Assigned to:** Clone B

**status.ts changes:**
- Add IDLE and WAITING_FOR_TASK to the state display
- Show `[daemon]` indicator for clones with `session_mode === 'daemon'`
- Show `tasks_completed` count for daemon clones

**kill.ts changes:**
- For daemon clones, kill transitions through WINDING_DOWN first (existing behavior works as-is via `markDead`). No structural change needed — verify in tests.

**abort.ts changes:**
- Abort should also mark daemon clones as DEAD (existing behavior covers this). Verify.

~15 LOC production (status.ts display), ~20 LOC tests (extend existing command tests).

### Task 2.10 — E2E test for daemon lifecycle (e2e)

**Package:** `@manta/e2e` (or `@manta/cli` integration tests)
**File:** `packages/manta-cli/tests/integration/daemon-lifecycle.test.ts` — **new file**
**Assigned to:** Clone A

Full lifecycle test with fake runner:
1. Spawn 2 daemon clones (pair-programming mode)
2. Both clones complete initial task, transition to IDLE
3. Enqueue new work item for clone A
4. Verify daemon-loop picks up the work item
5. Clone A resumes (simulated), completes, returns to IDLE
6. Send daemon stop command
7. Both clones transition to DEAD
8. Post-mortems generated
9. Charge system records correct cost

~100 LOC.

### Clone Assignment Strategy (Chunk 2)

**Clone A** — Spawner + daemon-loop + priming + skills + E2E test (tasks 2.1, 2.2, 2.6, 2.8, 2.10):
- **Owns all shared prereqs:** `CloneRunnerInput.sessionId`, `runClauseResume()`, `CloneHandle.sessionId`/`isDaemon`, `DaemonLoopOptions`/`runDaemonLoop()`, daemon priming blocks
- daemon-loop.ts (new file, self-contained after spawner prereqs)
- Skills (markdown, no code dependencies)
- E2E integration test (exercises full lifecycle)

**Clone B** — tick-loop + snapshot + cast.ts + commands + command tests (tasks 2.3, 2.4, 2.5, 2.7, 2.9):
- tick-loop daemon mode branch (interface extension, `allDone` callback)
- Snapshot schema `sessionMode` field (additive, self-contained)
- cast.ts Wave 2 dispatch (largest task — depends on snapshot schema from own task 2.4)
- New CLI commands (daemon, retask, feedback) + errors.ts + manta.ts registration
- Modified commands (status, kill, abort)

**Dependency note for Clone B:** Your `cast.ts` (Task 2.5) generates `sessionId` and sets `sessionMode` in the snapshot, which flows through to `spawnClone()`. Clone A's `clone-spawner.ts` changes (Task 2.1) add `--session-id` flag support — your snapshot populates the field that Clone A's spawner consumes. Write against the interface from this plan; after merge, the flow connects. Your `runtime.ts` change adds `WorkQueueStore` to context — Clone A's daemon-loop.ts consumes it via `opts.workQueue`.

**Dependency note for Clone A:** Your daemon-loop.ts (Task 2.2) uses `WorkQueueStore.dequeue()` which is created in Chunk 1 (Task 1.4, already merged). Your priming (Task 2.6) reads `snapshot.sessionMode` which Clone B adds (Task 2.4). Write against the interface from this plan.

---

## Execution Plan

1. **Commit this plan** + reviewer approval
2. **Chunk 1 cast:** `manta cast forking-realities --clones 2 --tasks docs/superpowers/plans/phase-5-chunk1-tasks.yaml`
3. **Post-cast ceremony:** merge-review → code-review subagent → merge → build+test → post-mortem
4. **Chunk 2 cast:** `manta cast forking-realities --clones 2 --tasks docs/superpowers/plans/phase-5-chunk2-tasks.yaml`
5. **Post-cast ceremony:** same as above
6. **Final sweep:** full workspace test, build, lint → commit docs + INDEX update

## Success Criteria

- CloneStateSchema contains IDLE and WAITING_FOR_TASK
- Bus exposes 6 new MCP tools: retask, pause, resume, request_task, feedback, enqueue_work
- WorkQueueStore provides enqueue/dequeue/complete/pending operations
- Death detector respects IDLE/WAITING extended timeouts and daemon session lifetime
- `clone-spawner.ts` supports `--session-id` and `--resume` flags
- `daemon-loop.ts` implements orchestrator-side poll-resume cycle
- Wave 2 modes accepted by `SUPPORTED_MODES` in cast.ts
- Daemon mode sets `session_mode: 'daemon'` on cast policy and snapshot
- New commands: `manta daemon status`, `manta daemon stop`, `manta retask`, `manta feedback`
- Priming includes daemon-specific blocks for persistent clones
- Skills: `manta-daemon-idle` and `manta-pair-protocol` created
- Snapshot schema includes `sessionMode` and `sessionId` fields
- All tests green, build+lint clean
- Test coverage >= 80% on new code
- No TODOs in merged code

## Risks

### R1: Sequential Resume Startup Latency (MEDIUM)
Each `--resume` invocation boots Claude CLI (~3-5s). For pair-programming with rapid feedback, this is 10-15% overhead per iteration.
**Mitigation:** Accept for Phase 5. If blocking for Phase 6 pair-programming UX, investigate session pre-warming or `--fork-session` in Phase 7.

### R2: Context Degradation Over Many Cycles (HIGH)
After 20+ resume cycles, compaction summarizes early work items. Clone may "forget" initial constraints.
**Mitigation:** Critical state in `--append-system-prompt` (permanent). Work results on disk. Periodic fresh-session reset (Phase 7 optimization). `--append-system-prompt` changes verified working between resume calls.

### R3: WorkQueueStore Contention (LOW)
Multiple daemon-loops polling the same work-queue.json could cause contention under `atomicMutateJson`.
**Mitigation:** Daemon-loop polls are per-clone (different `target_clone_id`), so reads are filtered. Write contention only on enqueue from main, which is low-frequency.

### R4: CastPolicy.session_mode Breaking Existing Manifests (LOW)
Adding `session_mode` to CastPolicySchema could break parsing of existing manifests.
**Mitigation:** `.default('batch')` — existing manifests without the field parse correctly. Verified by Zod default behavior on strict schemas with `.partial()` or `.default()`.

## Open Questions (Resolved)

1. **Clone-side polling vs orchestrator-side resume?** → Orchestrator-side resume. Research verified clone-side polling is unviable with `--print`.
2. **Stream-JSON stdin injection?** → NOT used. Only sequential resume is verified working.
3. **Session recovery fidelity with `--resume`?** → Verified: MCP servers re-initialize on each resume. CLAUDE.md re-read on each resume.
4. **Can `--append-system-prompt` change between resume calls?** → YES, verified by research.
5. **Shared worktree for test-storm?** → Deferred to Phase 6. Phase 5 uses separate worktrees (existing model).

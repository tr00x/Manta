# Phase 5 Codebase Readiness — Daemon-Mode Runtime

**Date:** 2026-05-27
**Author:** Clone C (recon-swarm, cast-1779894176321)
**Purpose:** Exhaustive change-list for every file affected by daemon-mode runtime. Feeds directly into Phase 5 plan writing.
**Cross-ref:** Spec Sec 2 (Wave 2 modes), Sec 9.1 (headless spawn limitations), Sec 15.1 (Phase 5 definition)

---

## Executive Summary

Daemon-mode replaces batch one-shot (`claude --print`) with persistent long-running clones that can be re-tasked, paused, resumed, and receive feedback mid-session. This unlocks Wave 2 modes: `pair-programming`, `test-storm`, `documentation-chase`.

**Current state:** Every clone is a single `execa('claude', ['--print', ...])` call (clone-spawner.ts:276-288). The tick-loop exits when all clones reach DEAD. The registry has 5 states: STARTING, WORKING, BLOCKED, WINDING_DOWN, DEAD — no concept of IDLE or re-tasking.

**Scale of change:** ~1,180 new LOC across packages, ~280 LOC modified in existing files, 6 new source files, 2 new skills, ~8 new test files. No existing public API breaks — daemon mode is additive.

---

## 1. @manta/bus (coordination layer)

### 1.1 schema.ts — State machine + new tool schemas

**Path:** `packages/manta-bus/src/schema.ts` (415 lines)
**Type:** Modification
**What changes:**

1. **CloneStateSchema** (line 25): Add `'IDLE'` and `'WAITING_FOR_TASK'` to the enum.
   - `IDLE` = clone process alive, previous task done, ready for re-task.
   - `WAITING_FOR_TASK` = clone explicitly requested a new task via `manta.request_task`.
   - State machine: `STARTING → WORKING → IDLE ⇄ WORKING → WINDING_DOWN → DEAD`. Also `WORKING → BLOCKED → WORKING`, `IDLE → WINDING_DOWN → DEAD`.
   - `DEAD` remains terminal — no resurrection.

2. **New input schemas** (append after line 210):
   ```
   RetaskInputSchema    — { clone_id, new_task, new_scope?, new_approach_hint?, new_deadline_ms? }
   PauseInputSchema     — { clone_id, reason }
   ResumeInputSchema    — { clone_id }
   FeedbackInputSchema  — { clone_id, feedback, severity: 'info' | 'correction' | 'blocker' }
   RequestTaskInputSchema — { clone_id }  (clone → main: "I'm idle, give me work")
   ```

3. **CastPolicySchema** (line 213): Add `session_mode: z.enum(['batch', 'daemon']).default('batch')`.

4. **BroadcastEventTypeSchema** (line 151): Add `'task_complete'`, `'idle'`, `'feedback_received'`.

5. **ChargeEventTypeSchema** (line 310): Add `'daemon_session_start'`, `'daemon_session_end'`.

**Estimated LOC delta:** +85 new lines
**Risk:** Medium — every tool handler and the orchestrator reads CloneStateSchema. Adding enum values is additive (Zod enum expansion is non-breaking for existing parsers), but all `switch` statements on CloneState must be audited for exhaustiveness.

### 1.2 state/registry.ts — IDLE/WAITING states + retask

**Path:** `packages/manta-bus/src/state/registry.ts` (172 lines)
**Type:** Modification
**What changes:**

1. **heartbeat()** (line 61): Currently rejects `DEAD` via heartbeat. Must also define valid transitions for new states:
   - Allow: `IDLE → WORKING` (re-task), `WORKING → IDLE` (task complete), `WORKING → WAITING_FOR_TASK`, `IDLE → WINDING_DOWN`.
   - Reject: `DEAD → anything` (already done), `IDLE → BLOCKED` (no task to be blocked on).

2. **New method: `retask(cloneId, newTaskSummary)`** — Validates clone is IDLE or WAITING_FOR_TASK, transitions to WORKING, records retask timestamp. Atomically via `atomicMutateJson`.

3. **New method: `pause(cloneId)`** — Transitions WORKING → IDLE with pause reason.

4. **CloneRecord interface** (line 7): Add fields:
   - `session_start_at?: number` — when daemon session began (vs `registered_at` which is per-registration)
   - `tasks_completed?: number` — counter of completed tasks in this session
   - `last_task_completed_at?: number` — timestamp
   - `idle_since?: number` — set when entering IDLE

5. **staleSince()** (line 165): Must exclude IDLE clones from stale check OR use different timeout for IDLE (`idleHeartbeatTimeoutMs`).

**Estimated LOC delta:** +65 new, ~25 modified
**Risk:** High — registry is the central state file. All orchestrator logic, tick-loop `allDone`, and death-detector depend on it. Integration tests are critical.

### 1.3 tools/lifecycle.ts — New daemon lifecycle handlers

**Path:** `packages/manta-bus/src/tools/lifecycle.ts` (97 lines)
**Type:** Modification
**What changes:**

1. **New handlers** in `LifecycleHandlers` interface:
   - `retask(input)` — parse RetaskInputSchema, call `registry.retask()`, append event
   - `pause(input)` — parse PauseInputSchema, call `registry.pause()`, append event
   - `resume(input)` — parse ResumeInputSchema, call `registry.heartbeat({state: WORKING})`, append event
   - `requestTask(input)` — parse RequestTaskInputSchema, transition to WAITING_FOR_TASK, append event

2. **Existing `heartbeat()`**: Validate new state transitions (IDLE-related).

**Estimated LOC delta:** +80 new, ~10 modified

### 1.4 tools/communication.ts — Feedback channel

**Path:** `packages/manta-bus/src/tools/communication.ts` (87 lines)
**Type:** Modification
**What changes:**

1. **New handler: `feedback(input)`** — Parse FeedbackInputSchema, validate target clone exists and is WORKING/IDLE, append `feedback` event. This is the main→clone directed communication channel (not broadcast, which is clone→main).

2. **readBroadcasts()** (line 72): May need to also return `feedback` events directed at the requesting clone (so clones can poll for feedback from main).

**Estimated LOC delta:** +35 new, ~5 modified

### 1.5 tools/index.ts — BusContext extension

**Path:** `packages/manta-bus/src/tools/index.ts` (32 lines)
**Type:** Modification (minimal)
**What changes:** No structural change — BusContext already covers all stores needed. The new handlers operate on existing `registry` and `events` stores.

**Estimated LOC delta:** 0

### 1.6 server.ts — Register new MCP tools

**Path:** `packages/manta-bus/src/server.ts` (367 lines)
**Type:** Modification
**What changes:**

1. **Tool table** (line 125): Add 5 new entries:
   - `manta.retask` → lifecycle.retask
   - `manta.pause` → lifecycle.pause
   - `manta.resume` → lifecycle.resume
   - `manta.request_task` → lifecycle.requestTask
   - `manta.feedback` → comm.feedback

2. **createBusServer** JSDoc (line 82) already has "Phase 5 daemon mode may need async setup" — this is the fulfillment.

**Estimated LOC delta:** +35 new

### 1.7 state/contracts.ts — Contract replacement for re-task

**Path:** `packages/manta-bus/src/state/contracts.ts`
**Type:** Modification
**What changes:**

1. **New method: `replace(cloneId, newContract)`** — Overwrites existing contract for a clone (used during re-task). Current `write()` is create-or-update, but re-task needs explicit semantic: archive old contract in event log, write new one.

**Estimated LOC delta:** +25 new

### 1.8 state/charge-store.ts — Daemon session charging

**Path:** `packages/manta-bus/src/state/charge-store.ts` (351 lines)
**Type:** Modification
**What changes:**

1. Daemon sessions have different charge model: charge on session start (not per-task), with per-task micro-credits optional.
2. New methods: `deductForDaemonSession(castId, mode)`, `endDaemonSession(castId)`.
3. MODE_CHARGE_COST may need daemon-specific costs or a multiplier.

**Estimated LOC delta:** +40 new

### 1.9 state/paths.ts — No change needed

Current paths are sufficient. Daemon state lives in the same registry/events/contracts files.

### 1.10 index.ts (barrel export)

**Path:** `packages/manta-bus/src/index.ts`
**Type:** Modification — export new types from schema.

**Estimated LOC delta:** +5

---

## 2. @manta/cli (spawn + lifecycle management)

### 2.1 spawner/clone-spawner.ts — Daemon spawn path

**Path:** `packages/manta-cli/src/spawner/clone-spawner.ts` (291 lines)
**Type:** Modification + new function
**What changes:**

1. **New function: `runClaudeDaemon(opts)`** — Alternative to `runClaudeCli` that launches `claude` in interactive mode (no `--print`). Uses stdin/stdout pipes for bidirectional communication. Returns a `DaemonCloneRunner` implementing `CloneRunner` interface extended with `sendPrompt(text)`.

2. **CloneRunner interface** (line 18): Extend with optional `sendPrompt?: (text: string) => void` for daemon mode. Batch runners return undefined (they don't support it). Or: new `DaemonCloneRunner extends CloneRunner` interface.

3. **CloneHandle** (line 68): Add:
   - `sendPrompt?: (text: string) => Promise<void>` — inject a new prompt into the running clone's stdin
   - `isDaemon: boolean` — flag to distinguish batch vs daemon handles

4. **spawnClone()** (line 85): Minimal change — the runner abstraction already handles the spawn difference. The key delta is that daemon processes don't resolve `exit` until explicitly terminated.

**Estimated LOC delta:** +95 new, ~20 modified
**Risk:** High — this is the core daemon infrastructure. `claude` CLI interactive mode behavior must be validated. The stdin protocol (how to inject a new prompt into a running claude session) is the #1 open question. Fallback: use `claude-peers` send_message as the re-task channel instead of stdin.

### 2.2 tick-loop.ts — Persistent mode

**Path:** `packages/manta-cli/src/tick-loop.ts` (42 lines)
**Type:** Modification
**What changes:**

1. **RunTickLoopOptions**: Add `daemonMode: boolean`. When true, `allDone()` semantics change: loop continues as long as at least one clone is not DEAD (IDLE clones keep the loop alive).

2. **Loop body**: In daemon mode, after `orchestrator.runCycle()`, check for IDLE clones that have been idle > `maxIdleTimeMs` and auto-terminate them.

3. **New exit condition**: Daemon loop exits when: (a) all clones DEAD, (b) explicit abort signal, (c) session budget exhausted. NOT when clones go IDLE.

**Estimated LOC delta:** +35 new, ~10 modified

### 2.3 commands/cast.ts — Daemon dispatch path

**Path:** `packages/manta-cli/src/commands/cast.ts` (677 lines)
**Type:** Modification
**What changes:**

1. **SUPPORTED_MODES** (line 29): Add Wave 2 modes: `'pair-programming'`, `'test-storm'`, `'documentation-chase'`.

2. **runCastCommand()**: Add `sessionMode` detection: if mode is Wave 2, force `sessionMode: 'daemon'`. Pass to castPolicy and tick-loop.

3. **castPolicy** (line 266): For daemon modes, set `session_mode: 'daemon'` in the policy.

4. **Tick-loop call** (line 364): Pass `daemonMode: true` for Wave 2 casts.

5. **allDone()** (line 368): In daemon mode, change from "all DEAD" to "all DEAD OR session budget exhausted OR explicit stop".

6. **Post-cast settlement**: Daemon casts may span multiple tasks — settlement happens at session end, not per-task.

7. **New: re-task injection point** — Main needs a way to push new tasks to running clones mid-loop. This could be a concurrent `retaskChannel` that the tick-loop checks each cycle.

**Estimated LOC delta:** +120 new, ~40 modified
**Risk:** High — cast.ts is already the largest and most complex file. Consider extracting daemon-specific logic into `daemon-cast.ts`.

### 2.4 commands/ — New daemon commands

**New files:**

| File | Description | Est. LOC |
|------|-------------|----------|
| `commands/daemon.ts` | `manta daemon status` — show running daemon clones. `manta daemon stop` — graceful shutdown of all daemon clones. | ~60 |
| `commands/retask.ts` | `manta retask <cloneId> --task "new task" [--scope ...]` — push new task to IDLE/WAITING clone via bus `manta.retask` | ~45 |
| `commands/feedback.ts` | `manta feedback <cloneId> "your approach is wrong, try X"` — directed feedback to working clone | ~35 |

**Total new command LOC:** ~140

### 2.5 commands/ — Existing commands needing modification

| File | Change | Est. LOC |
|------|--------|----------|
| `commands/status.ts` (33 lines) | Show IDLE/WAITING states with different icons. Show daemon vs batch indicator. Show tasks-completed count for daemon clones. | +15 |
| `commands/kill.ts` (58 lines) | Daemon kill: SIGTERM the persistent process after post-mortem. Current kill only marks DEAD in registry. | +10 |
| `commands/abort.ts` (47 lines) | Abort daemon clones: terminate persistent processes, not just mark registry. | +10 |
| `commands/inspect.ts` (66 lines) | Show daemon session info: session_start_at, tasks_completed, idle_since, current task. | +10 |

### 2.6 spawner/priming.ts — Daemon priming block

**Path:** `packages/manta-cli/src/spawner/priming.ts` (76 lines)
**Type:** Modification
**What changes:**

1. **New template block: `DAEMON_MODE_BLOCK`** — Instructions for persistent clones:
   - "You are a daemon clone. After completing your task, transition to IDLE by calling `manta.heartbeat` with `state: IDLE`. Do NOT call `manta-graceful-death` after each task — only at session end."
   - "When IDLE, call `manta.request_task` to signal readiness. The main will re-task you via `manta.retask` — read the new contract and proceed."
   - "Check for `manta.feedback` events from main during long operations."
   - "Session-end shutdown: only when explicitly told to stop or session budget exhausted."

2. **buildPrimingText()** (line 46): Add daemon mode detection based on snapshot.taskContract.mode being Wave 2. Insert `DAEMON_MODE_BLOCK` after mode-specific block.

3. **Pair-programming specific block**: Writer clone vs reviewer clone instructions.

4. **Test-storm specific block**: Code/test/chaos role instructions.

**Estimated LOC delta:** +45 new, ~10 modified

### 2.7 spawner/heartbeat-hook.ts — Richer state reporting

**Path:** `packages/manta-cli/src/spawner/heartbeat-hook.ts` (106 lines)
**Type:** Modification
**What changes:**

1. Touch script currently only updates `last_heartbeat_at`. For daemon mode, should also check for a state-signal file (e.g., `.manta/clone-state.json` in worktree) that the clone writes when it wants to transition to IDLE.

2. Alternatively: no change needed if IDLE transitions go through MCP `manta.heartbeat` directly. The hook's job is just liveness — state transitions are explicit MCP calls.

**Estimated LOC delta:** ~0-15 (likely no change — IDLE transitions via MCP, not hook)

### 2.8 spawner/snapshot-builder.ts — Daemon snapshot fields

**Path:** `packages/manta-cli/src/spawner/snapshot-builder.ts` (56 lines)
**Type:** Modification
**What changes:**

1. **CloneSpawnRequest**: Add `sessionMode: 'batch' | 'daemon'` field. Propagated to snapshot's `taskContract` and top-level flag.

2. `buildCloneSnapshot()`: For daemon mode, `ttlSeconds` should be session TTL (much longer than batch), not per-task TTL.

**Estimated LOC delta:** +8 modified

### 2.9 runtime.ts — Real dispose() for daemon mode

**Path:** `packages/manta-cli/src/runtime.ts` (107 lines)
**Type:** Modification
**What changes:**

1. **dispose()** (line 103): Currently placeholder. For daemon mode: terminate any running daemon processes, release IPC channels, flush pending events.

2. **Runtime interface**: Add `activeDaemonHandles?: CloneHandle[]` for tracking persistent processes that need cleanup.

**Estimated LOC delta:** +25 modified

### 2.10 bin/manta.ts — Register new commands

**Path:** `packages/manta-cli/src/bin/manta.ts` (357 lines)
**Type:** Modification
**What changes:**

1. Import and register new commands: `daemon`, `retask`, `feedback`.
2. Add daemon-specific flags to `cast` command: `--session-mode <mode>` (auto-detected for Wave 2, manual override for testing).

**Estimated LOC delta:** +50 new

### 2.11 output/status-table.ts — Daemon indicators

**Path:** `packages/manta-cli/src/output/status-table.ts`
**Type:** Modification
**What changes:**

1. Add IDLE and WAITING_FOR_TASK state icons/formatting.
2. Show session duration for daemon clones.
3. Show tasks-completed counter.

**Estimated LOC delta:** +15 modified

### 2.12 errors.ts — New error kinds

**Path:** `packages/manta-cli/src/errors.ts` (30 lines)
**Type:** Modification
**What changes:**

1. Add to `CliErrorKind`: `'daemon_failed'`, `'retask_failed'`, `'feedback_failed'`.

**Estimated LOC delta:** +3

### 2.13 budget/ — Daemon budget adjustments

**Path:** `packages/manta-cli/src/budget/cost-estimator.ts`
**Type:** Modification
**What changes:**

1. `estimateCost` needs daemon mode: cost per session (longer runtime) vs cost per one-shot.

**Estimated LOC delta:** +15 modified

---

## 3. @manta/orchestrator (lifecycle management)

### 3.1 death-detector.ts → health-monitor.ts

**Path:** `packages/manta-orchestrator/src/death-detector.ts` (53 lines)
**Type:** Rename + Major modification
**What changes:**

1. **Rename** to `health-monitor.ts` (or keep name and add daemon-aware logic).

2. **findDeadClones()**: Must differentiate IDLE clones from dead clones:
   - IDLE clone with `last_heartbeat_at` > `idleHeartbeatTimeoutMs` → not dead, but stale-idle
   - WORKING clone with `last_heartbeat_at` > `heartbeatTimeoutMs` → dead (existing behavior)
   - WAITING_FOR_TASK clone — never killed by heartbeat timeout, only by explicit session timeout
   - New config: `idleHeartbeatTimeoutMs` (longer than working timeout, e.g., 600s vs 300s)

3. **New function: `findIdleClones(ctx, opts)`** — Returns clones in IDLE state, with idle duration. Used by orchestrator to auto-terminate clones idle too long.

4. **New function: `checkDaemonHealth(ctx, opts)`** — Combines dead + idle + session-timeout checks for daemon clones.

**Estimated LOC delta:** +50 new, ~20 modified

### 3.2 orchestrator.ts — Daemon-aware cycle

**Path:** `packages/manta-orchestrator/src/orchestrator.ts` (87 lines)
**Type:** Modification
**What changes:**

1. **runCycle()**: Add after `findDeadClones`:
   - Check for daemon clones exceeding session lifetime (`daemonMaxLifetimeMs`)
   - Check for IDLE clones exceeding idle timeout → transition to WINDING_DOWN
   - Do NOT run post-mortem on IDLE clones (they're alive, just waiting)

2. **CycleResult**: Add `idleClones: CloneRecord[]`, `expiredDaemonSessions: string[]`.

**Estimated LOC delta:** +30 new, ~15 modified

### 3.3 thresholds.ts — Daemon thresholds

**Path:** `packages/manta-orchestrator/src/thresholds.ts` (46 lines)
**Type:** Modification
**What changes:**

1. **New fields in Thresholds**:
   - `idleHeartbeatTimeoutMs: number` — heartbeat timeout when clone is IDLE (default: 600_000 = 10 min)
   - `maxIdleTimeMs: number` — max time a clone can stay IDLE before auto-termination (default: 300_000 = 5 min)
   - `daemonMaxLifetimeMs: number` — hard ceiling on daemon session length (default: 3_600_000 = 1 hour)

2. **defaultThresholds**: Add defaults.

**Estimated LOC delta:** +12 new

### 3.4 post-mortem.ts — Daemon session post-mortem

**Path:** `packages/manta-orchestrator/src/post-mortem.ts` (106 lines)
**Type:** Modification
**What changes:**

1. **renderMarkdown()**: For daemon clones, include session summary:
   - Total session duration
   - Number of tasks completed (`tasks_completed` from registry)
   - Total idle time
   - Per-task breakdown from events

2. **Timing**: Post-mortem for daemon clones written at session end (when clone finally goes DEAD), not after each task.

**Estimated LOC delta:** +25 modified

### 3.5 status.ts — Daemon status fields

**Path:** `packages/manta-orchestrator/src/status.ts` (40 lines)
**Type:** Modification
**What changes:**

1. **OrchestratorStatus**: Add `daemonClones: CloneRecord[]` (filtered to daemon-mode clones), `idleClones: CloneRecord[]`.

**Estimated LOC delta:** +10 modified

### 3.6 forensic-timeline.ts — No change needed

Timeline is generic enough — daemon clone snapshots are just more frequent.

### 3.7 index.ts — Export new items

**Path:** `packages/manta-orchestrator/src/index.ts` (18 lines)
**Type:** Modification

**Estimated LOC delta:** +2

---

## 4. @manta/snapshot (state serialization)

### 4.1 schema.ts — Daemon mode fields

**Path:** `packages/manta-snapshot/src/schema.ts` (92 lines)
**Type:** Modification
**What changes:**

1. **TaskContractSchema** (line 25): Add `sessionMode: z.enum(['batch', 'daemon']).default('batch')`.

2. **SnapshotSchema** (line 61): Add `sessionMode: z.enum(['batch', 'daemon']).default('batch')` (denormalized from taskContract for quick access).

3. **BudgetSchema** (line 54): Add `sessionBudgetUsd: z.number().nonnegative().optional()` — total session budget for daemon mode (separate from per-task budget).

**Estimated LOC delta:** +10 new
**Risk:** Low — new fields have defaults, so existing snapshots parse without migration. Schema version bump NOT required (additive change with defaults).

### 4.2 capture.ts — Propagate daemon fields

**Path:** `packages/manta-snapshot/src/capture.ts` (44 lines)
**Type:** Modification
**What changes:**

1. **CaptureInput**: Add `sessionMode?: 'batch' | 'daemon'`. Default `'batch'`.
2. **captureState()**: Propagate `sessionMode` to snapshot.

**Estimated LOC delta:** +5 modified

### 4.3 distill.ts — No change needed

Context distillation is content-agnostic.

### 4.4 index.ts — Export new types

**Estimated LOC delta:** +2

---

## 5. Skills

### 5.1 manta-as-clone/SKILL.md — Daemon section

**Path:** `skills/manta-as-clone/SKILL.md`
**Type:** Modification (content, not code)
**What changes:**

1. New section: `## Daemon Mode (Wave 2)` — explaining persistent lifecycle, IDLE protocol, re-task acceptance, feedback checking.
2. Startup sequence: daemon clones have same startup, but after task completion they transition to IDLE instead of graceful-death.
3. Forbidden section: add "Do not call manta-graceful-death after each task in daemon mode — only at session end."

### 5.2 manta-graceful-death/SKILL.md — Session-end vs task-end

**Path:** `skills/manta-graceful-death/SKILL.md`
**Type:** Modification (content, not code)
**What changes:**

1. Distinguish "task-end" (daemon: transition to IDLE, do mini knowledge dump) from "session-end" (daemon: full graceful death sequence).
2. New section: task-end mini-checklist (commit deliverables, broadcast task_complete, heartbeat IDLE).

### 5.3 New skill: manta-daemon-idle

**Path:** `skills/manta-daemon-idle/SKILL.md`
**Type:** New file
**What it does:**

Instructions for what a clone does when IDLE between tasks:
- Call `manta.request_task` to signal readiness
- Optionally: run lightweight housekeeping (organize notes, review previous work)
- Check for `manta.feedback` events
- Do NOT start new work without an explicit re-task from main
- Monitor session budget remaining

### 5.4 New skill: manta-pair-protocol

**Path:** `skills/manta-pair-protocol/SKILL.md`
**Type:** New file
**What it does:**

Pair-programming mode protocol (Wave 2 mode #3):
- Writer clone: implement, commit, broadcast `task_complete`
- Reviewer clone: wait for writer broadcast, review diff, broadcast feedback
- Iteration loop: writer reads feedback, fixes, re-commits
- Convergence: both clones agree → session ends

---

## 6. Tests

### 6.1 Existing test files needing daemon variants

| Test file | What to add | Est. new LOC |
|-----------|-------------|--------------|
| `packages/manta-bus/tests/state/registry.test.ts` | IDLE/WAITING_FOR_TASK transitions, retask(), pause(), state machine validation, staleSince() with IDLE exclusion | +80 |
| `packages/manta-bus/tests/schema.test.ts` | RetaskInputSchema, PauseInputSchema, ResumeInputSchema, FeedbackInputSchema validation | +40 |
| `packages/manta-bus/tests/tools/lifecycle.test.ts` | retask, pause, resume, requestTask handlers | +60 |
| `packages/manta-bus/tests/tools/communication.test.ts` | feedback handler, feedback in readBroadcasts | +30 |
| `packages/manta-bus/tests/server.test.ts` | New tool registration, new tool dispatch | +25 |
| `packages/manta-cli/tests/tick-loop.test.ts` | daemonMode: loop survives IDLE, exits on all-DEAD, session budget | +40 |
| `packages/manta-cli/tests/spawner/clone-spawner.test.ts` | runClaudeDaemon, sendPrompt, daemon CloneHandle | +50 |
| `packages/manta-cli/tests/commands/cast.test.ts` | Wave 2 mode dispatch, daemon tick-loop integration, sessionMode | +60 |
| `packages/manta-cli/tests/spawner/priming.test.ts` | DAEMON_MODE_BLOCK in output, pair-programming block | +25 |
| `packages/manta-orchestrator/tests/death-detector.test.ts` | IDLE clone NOT detected as dead, daemon session timeout, idle auto-termination | +40 |
| `packages/manta-orchestrator/tests/orchestrator.test.ts` | Daemon cycle behavior, no post-mortem for IDLE, session expiry | +30 |
| `packages/manta-orchestrator/tests/thresholds.test.ts` | New threshold fields parse correctly | +10 |
| `packages/manta-snapshot/tests/schema.test.ts` (if exists) | sessionMode field, backward compat | +15 |

### 6.2 New test files

| Test file | What it covers | Est. LOC |
|-----------|---------------|----------|
| `packages/manta-cli/tests/commands/daemon.test.ts` | daemon status/stop commands | ~50 |
| `packages/manta-cli/tests/commands/retask.test.ts` | retask command validation + execution | ~45 |
| `packages/manta-cli/tests/commands/feedback.test.ts` | feedback command | ~35 |
| `packages/manta-cli/tests/integration/daemon-lifecycle.test.ts` | Full daemon spawn → work → idle → retask → work → death | ~100 |
| `packages/manta-cli/tests/integration/pair-programming.test.ts` | Writer/reviewer loop e2e | ~80 |
| `packages/manta-bus/tests/tools/daemon-lifecycle.test.ts` | retask + pause + resume + requestTask through bus | ~60 |
| `packages/manta-bus/tests/state/registry-daemon.test.ts` | IDLE/WAITING state machine exhaustive tests | ~50 |
| `packages/manta-e2e/tests/daemon-mode.e2e.test.ts` | True e2e: spawn daemon clone, retask, kill | ~80 |

---

## 7. Schema Changes Summary

| Schema | Location | Change type | Migration needed? |
|--------|----------|-------------|-------------------|
| `CloneStateSchema` | bus/schema.ts | Enum expansion (+2 values) | No — additive |
| `CastPolicySchema` | bus/schema.ts | New field `session_mode` with default | No — `.default('batch')` |
| `BroadcastEventTypeSchema` | bus/schema.ts | Enum expansion (+3 values) | No — additive |
| `ChargeEventTypeSchema` | bus/schema.ts | Enum expansion (+2 values) | No — additive |
| `TaskContractSchema` | snapshot/schema.ts | New field `sessionMode` with default | No — `.default('batch')` |
| `SnapshotSchema` | snapshot/schema.ts | New field `sessionMode` with default | No — `.default('batch')` |
| `BudgetSchema` | snapshot/schema.ts | New optional field `sessionBudgetUsd` | No — `.optional()` |
| `CloneRecord` (interface) | bus/registry.ts | New optional fields (+4) | No — optional fields |
| `RegistryFile` | bus/registry.ts | Version stays 1 (additive) | No |

**All schema changes are backward-compatible.** No migration scripts needed. Existing state files parse without error. Version bump on SnapshotSchema only if non-optional fields are added (currently not planned).

---

## 8. Dependency Order

Implementation must follow this order (each layer depends on the previous):

```
Phase 5a: Bus schema + registry state machine  (foundation)
  ├── 1. CloneStateSchema expansion (IDLE, WAITING_FOR_TASK)
  ├── 2. New Zod schemas (Retask/Pause/Resume/Feedback/RequestTask)
  └── 3. Registry methods (retask, pause, staleSince IDLE-awareness)

Phase 5b: Bus tools + server wiring  (API surface)
  ├── 4. lifecycle.ts daemon handlers
  ├── 5. communication.ts feedback handler
  ├── 6. contracts.ts replace method
  └── 7. server.ts new tool registration

Phase 5c: Orchestrator daemon awareness  (health monitoring)
  ├── 8. thresholds.ts new daemon thresholds
  ├── 9. death-detector.ts → IDLE-aware health checks
  ├── 10. orchestrator.ts daemon cycle logic
  └── 11. post-mortem.ts daemon session summaries

Phase 5d: Snapshot daemon schema  (serialization)
  ├── 12. snapshot/schema.ts sessionMode field
  └── 13. snapshot/capture.ts propagation

Phase 5e: CLI daemon spawn + commands  (user surface)
  ├── 14. clone-spawner.ts runClaudeDaemon
  ├── 15. priming.ts daemon mode blocks
  ├── 16. tick-loop.ts persistent mode
  ├── 17. cast.ts daemon dispatch path
  ├── 18. New commands (daemon, retask, feedback)
  ├── 19. Modified commands (status, kill, abort, inspect)
  └── 20. bin/manta.ts command registration

Phase 5f: Skills + documentation  (clone behavior)
  ├── 21. manta-as-clone update
  ├── 22. manta-graceful-death update
  ├── 23. New skill: manta-daemon-idle
  └── 24. New skill: manta-pair-protocol

Phase 5g: Test suite  (verification)
  └── 25-32. All test files from Section 6
```

**Critical path:** 5a → 5b → 5e (clone-spawner daemon implementation). Everything else can be parallelized around this chain.

---

## 9. Risk Assessment

### High Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| `claude` CLI interactive mode protocol unknown | Blocks entire daemon spawn | R&D spike first: test `claude` stdin/stdout in non-`--print` mode. Fallback: use `claude-peers` send_message as re-task channel |
| Registry state machine complexity | IDLE/WORKING/WAITING transitions create new race conditions | Exhaustive state-transition matrix tests. Consider FSM library or explicit transition table. |
| cast.ts is already 677 lines | Adding daemon dispatch makes it unmaintainable | Extract `daemon-cast.ts` as separate module, share helpers |

### Medium Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| Daemon clone memory pressure | Long-running claude sessions accumulate context | Monitor token usage per session. Add session-level compaction trigger. |
| Charge model for daemon sessions | Over/under-charging disrupts budget system | Conservative initial pricing: daemon session = 3× batch cost. Adjust from dogfood data. |
| Heartbeat timeout confusion (IDLE vs WORKING) | Orchestrator kills idle clones | Separate `idleHeartbeatTimeoutMs` threshold, tested independently |

### Low Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| Schema backward compatibility | Existing casts fail to parse | All changes are additive with defaults — tested by existing test suite |
| New skills not followed by clones | Daemon clones ignore idle protocol | Skill text is soft prior (CLAUDE.md rule). Enforce via MCP-level state validation: bus rejects invalid state transitions regardless of clone behavior |

---

## 10. LOC Summary

| Package | New LOC | Modified LOC | New files | Modified files |
|---------|---------|-------------|-----------|----------------|
| @manta/bus | 365 | 35 | 0 | 7 |
| @manta/cli | 555 | 130 | 3 | 12 |
| @manta/orchestrator | 130 | 50 | 0 | 6 |
| @manta/snapshot | 17 | 5 | 0 | 3 |
| Skills | — | — | 2 | 2 |
| Tests | 505 (new) + ~400 (added to existing) | — | 8 | 13 |
| **Total** | **~1,180 (source) + ~905 (tests)** | **~280** | **13** | **43** |

---

## 11. Open Questions for Plan Phase

1. **Claude CLI interactive mode protocol**: How does `claude` accept new prompts when not in `--print` mode? Is stdin viable? Or must we use `claude-peers` send_message? This is the #1 blocker to validate before writing the Phase 5 plan.

2. **Session budget model**: Charge per session (flat), per task (micro-credits), or per token (actual)? Spec says "daemon-mode runtime" but doesn't specify charging.

3. **Pair-programming turn protocol**: Who goes first? Fixed roles (writer always A, reviewer always B) or negotiated? How many iterations before convergence?

4. **Test-storm chaos role**: What does the chaos-fuzzing clone actually do? Property-based testing? Mutation testing? Random input generation? Needs spec clarification.

5. **IDLE auto-termination vs main-directed**: Should idle clones auto-terminate after `maxIdleTimeMs`, or should only the main terminate them? Auto-termination is simpler but loses control.

# Phase 5 — Daemon Architecture for Persistent Manta Clones

**Date:** 2026-05-27
**Author:** Clone B (recon-swarm, cast-1779894176321)
**Status:** Research deliverable — ready for plan phase
**Siblings:** Clone A (concurrent research), Clone C (concurrent research)

---

## Executive Summary

Current Manta clones are **batch one-shot**: `claude --print` spawns a process, it executes a task contract, dies, and the main merges the result. This works for Wave 1 modes (recon-swarm, forking-realities, bug-hunt, refactor-wave) where the task is self-contained.

Wave 2 modes (pair-programming, test-storm, documentation-chase) require **iterative dialogue** — a clone must receive new work mid-session, wait for feedback, and continue. This document designs the daemon architecture to support persistent clones.

**Key finding:** The `claude` CLI already supports two daemon-viable mechanisms that avoid hypothetical API extensions:
1. **`--input-format stream-json`** — bidirectional NDJSON streaming over stdin/stdout, enabling message injection into a running session
2. **`--remote-control`** — named control channel for external tools to inject messages into a live Claude session

**Recommended approach:** Stream-JSON stdin injection as the primary work delivery mechanism, with the existing MCP `claim_work` loop as the coordination layer. The clone runs `claude` (not `--print`) in stream-json mode; the orchestrator writes work items to stdin as NDJSON; the clone reads them via normal conversation flow. MCP bus calls (heartbeat, lock, broadcast) continue working exactly as today — the clone is still a `claude` process with the same MCP servers.

**Cost/complexity estimate:** ~800-1200 LOC across 3 packages, 2-3 weeks implementation with dogfooding.

---

## 1. Extended Clone Lifecycle — State Machine

### Current States (Phase 0-4)

```
CloneState = 'STARTING' | 'WORKING' | 'BLOCKED' | 'WINDING_DOWN' | 'DEAD'
```

Defined in `packages/manta-bus/src/schema.ts:25` (`CloneStateSchema`).

Transitions enforced by `registry.ts`:
- `register()` → STARTING
- `heartbeat()` → any except DEAD (rejected with BusConflictError)
- `suicideIntent()` → WINDING_DOWN (via heartbeat internally)
- `markDead()` → DEAD (terminal, no return)
- `touch()` → updates timestamp only, never changes state

### Proposed Extended States for Daemon Mode

```
CloneState = 'STARTING' | 'WORKING' | 'BLOCKED' | 'IDLE'
           | 'WAITING_FOR_FEEDBACK' | 'PAUSED'
           | 'WINDING_DOWN' | 'DEAD'
```

#### State Machine Diagram (ASCII)

```
                    ┌──────────────────────────────────────────────────────────────┐
                    │                                                              │
                    │                     DAEMON LIFECYCLE                         │
                    │                                                              │
   register()      │  heartbeat(WORKING)                                          │
  ┌─────────┐      │  ┌─────────┐    heartbeat(IDLE)    ┌──────┐                  │
  │ STARTING ├──────┼─►│ WORKING ├─────────────────────►│ IDLE  │                  │
  └─────────┘      │  └────┬────┘                       └──┬───┘                  │
       │           │       │                               │                      │
       │           │       │ heartbeat(BLOCKED)            │ new_work_arrived      │
       │           │       │ ┌─────────┐                   │ heartbeat(WORKING)    │
       │           │       └►│ BLOCKED ├───────────────────┼──────────────────┐    │
       │           │         └─────────┘ unblocked         │                  │    │
       │           │              │                        │                  │    │
       │           │              │                        │                  ▼    │
       │           │              │         heartbeat      │              ┌────────┤
       │           │              │    (WAITING_FOR_FEEDBACK)             │WORKING │
       │           │              │    ┌─────────────────┐ │             └────────┤
       │           │              │    │  WAITING_FOR_    │ │                  │    │
       │           │              │    │  FEEDBACK        ├─┘                  │    │
       │           │              │    └────────┬────────┘  feedback_received  │    │
       │           │              │             │           heartbeat(WORKING) │    │
       │           │              │             └──────────────────────────────┘    │
       │           │              │                                                │
       │           │   pause()    │    ┌────────┐   resume()                       │
       │           │   ┌──────────┼───►│ PAUSED ├────────────┐                     │
       │           │   │          │    └────────┘            │                     │
       │           │   │          │                          │                     │
       │           │   │  suicide_intent()                   │                     │
       │           │   │  ┌──────────────┐                   │                     │
       │           ├───┼─►│ WINDING_DOWN ├───────────────────┼─────────────────┐   │
       │           │   │  └──────────────┘                   │                 │   │
       │           │   │       │                             │                 │   │
       │           │   │       │ report_death()              │                 │   │
       │           │   │       │  ┌──────┐                   │                 │   │
       └───────────┼───┼───────┴─►│ DEAD │◄──────────────────┘                 │   │
                   │   │          └──────┘ (terminal)         timeout/crash     │   │
                   │   │              ▲                                         │   │
                   │   │              └─────────────────────────────────────────┘   │
                   │                                                               │
                   └───────────────────────────────────────────────────────────────┘

Legend:
  ───► = valid transition (via heartbeat or dedicated handler)
  All non-DEAD states can transition to WINDING_DOWN or DEAD
  DEAD is terminal (enforced by registry.ts BusConflictError)
```

#### New State Semantics

| State | Meaning | Who sets it | Heartbeat timeout applies? |
|---|---|---|---|
| `IDLE` | Task complete, clone alive, waiting for next work item | Clone via heartbeat | Yes (extended: 5min vs 5min for WORKING) |
| `WAITING_FOR_FEEDBACK` | Submitted deliverable, awaiting review/response from main or sibling | Clone via heartbeat | Yes (extended: 10min — reviewer may be slow) |
| `PAUSED` | Explicitly paused by main (`/manta pause`) | Main via new `pause` MCP tool | No — paused clones exempt from death-detector until resumed or TTL |

#### Backward Compatibility

The `CloneStateSchema` enum simply gains 3 new values. Existing code that switches on state handles the current 5 values; unhandled new states will fall through to default paths (which are already safe — death-detector only checks `!== 'DEAD'` for staleness, status renderer shows raw state string). Migration cost: zero — JSON state files are schemaless string enums.

#### Death Detector Changes (`death-detector.ts:16-53`)

Current logic:
- STARTING → apply `startupGraceMs` against `registered_at`
- Everything else → apply `heartbeatTimeoutMs` against `last_heartbeat_at`

Required changes:
```
IDLE               → heartbeatTimeoutMs × 2 (idleTimeoutMs, default 600s)
WAITING_FOR_FEEDBACK → heartbeatTimeoutMs × 3 (feedbackTimeoutMs, default 900s)
PAUSED             → skip death check entirely (honor TTL only)
```

New thresholds to add to `ThresholdsSchema` (`thresholds.ts`):
- `idleTimeoutMs: z.number().int().positive()` (default 600_000)
- `feedbackTimeoutMs: z.number().int().positive()` (default 900_000)
- `pausedTtlMs: z.number().int().positive()` (default 3_600_000 = 1hr max pause)

---

## 2. Work Delivery Mechanism — Comparison Matrix

### Mechanisms Evaluated

| # | Mechanism | How it works | Latency | Complexity | Claude CLI support | Daemon-viable? |
|---|---|---|---|---|---|---|
| 1 | **MCP polling (`claim_work` loop)** | Clone polls `manta.claim_work` in a loop; main pushes items to ClaimsStore | ~5s (poll interval) | Low (exists today) | Yes (MCP works in all modes) | **Partial** — works but clone must self-drive the loop; `--print` exits after response |
| 2 | **Stream-JSON stdin injection** | Clone runs `claude --input-format stream-json`; orchestrator writes `{"type":"user_message","content":"..."}` to stdin pipe | ~100ms | Medium | **Yes** — native flag | **Yes** |
| 3 | **Remote Control** | Clone runs `claude --remote-control <name>`; orchestrator sends messages via the control channel | ~100ms | Medium | **Yes** — native flag | **Yes** |
| 4 | **File-watch** (`.manta/inbox/<id>/`) | Orchestrator writes task file; clone's PreToolUse hook checks inbox | ~2-5s | Medium | Indirect (hook-based) | **Partial** — fragile, polling overhead |
| 5 | **Signal-based (SIGUSR1)** | Send OS signal to clone process; handler reads next task from known path | ~10ms | High | No — `claude` doesn't expose signal hooks | **No** — no mechanism to inject into LLM context from signal handler |
| 6 | **claude-peers `send_message`** | Main sends message to clone's peer ID | ~500ms | Low (exists today) | Yes | **Partial** — message arrives as `<channel>` tag, clone must be already waiting for it |

### Detailed Analysis

#### Option 1: MCP Polling (`claim_work` loop) — RECOMMENDED COORDINATION LAYER

**How it works today:** `packages/manta-bus/src/tools/work.ts` implements `claim_work` and `release_work`. A clone calls `manta.claim_work({ clone_id, item, timeout_ms })` to claim a named work item. The ClaimsStore (`claims.ts`) is an atomic JSON file with conflict detection.

**For daemon mode:** The clone's skill (or priming) instructs it to enter a `claim_work` polling loop after completing its current task (transition to IDLE). The main pushes work items by writing to the claims file, and the clone picks them up.

**Strengths:**
- Already implemented and tested (93 tests across bus)
- Atomic, conflict-safe (JSON mutex)
- Works with any Claude CLI mode (--print, interactive, stream-json)
- No new infrastructure needed for the coordination protocol

**Weaknesses:**
- Requires the clone to self-drive the loop (soft instruction — see pitfalls.md §1)
- Poll latency (~5s) adds delay between work available and work started
- `--print` mode exits after response — clone must be in interactive mode

**Verdict:** Use as the **coordination layer** (who does what), not the message delivery layer.

#### Option 2: Stream-JSON Stdin Injection — RECOMMENDED DELIVERY MECHANISM

**How it works:** `claude --input-format stream-json --output-format stream-json` accepts NDJSON on stdin. Each line is a message object:
```json
{"type": "user_message", "content": "Here is your next task: ..."}
```
The orchestrator holds the stdin pipe and writes new messages when work is ready. The clone processes each message as a normal conversation turn — all MCP tools, skills, and context persist across messages.

**Strengths:**
- Native `claude` CLI feature — no extensions needed
- Sub-second latency (pipe write → LLM sees it immediately)
- Session persists — context, MCP servers, skills, memory all survive between tasks
- Orchestrator has full control of message timing
- `--output-format stream-json` gives structured output back (tool calls, text, etc.)
- `--session-id <uuid>` enables deterministic session tracking
- `--resume` enables crash recovery (session persisted to disk)

**Weaknesses:**
- Orchestrator must manage stdin pipe lifecycle (Node.js child_process stdin is straightforward)
- If clone is mid-tool-call when new stdin arrives, message queues (Claude handles this internally)
- No `--print` — long-running process, not one-shot
- Costs are per-session, not per-task — idle time costs nothing (no API calls), but context grows

**Implementation sketch:**
```typescript
// In clone-spawner.ts, new DaemonRunner
export function runClaudeCliDaemon(opts: DaemonRunnerOptions): DaemonCloneRunner {
  return {
    start(input: CloneRunnerInput): DaemonHandle {
      const proc = execa('claude', [
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--append-system-prompt', input.appendSystemPrompt,
        '--permission-mode', 'bypassPermissions',
        '--session-id', input.sessionId,
        ...(opts.extraArgs ?? []),
      ], { cwd: input.cwd, env: { ...process.env, ...input.env } });

      return {
        sendMessage(content: string) {
          proc.stdin!.write(JSON.stringify({
            type: 'user_message',
            content,
          }) + '\n');
        },
        outputStream: proc.stdout!, // NDJSON stream of responses
        process: proc,
      };
    },
  };
}
```

**Verdict:** **Primary delivery mechanism.** The main writes to clone's stdin; the clone receives it as a normal user message. MCP claim_work coordinates *which* clone gets *which* work.

#### Option 3: Remote Control

**How it works:** `claude --remote-control [name]` starts a session with an external control channel. Other processes can send messages to the session by name.

**Strengths:**
- Decoupled from process stdin (multiple sources can send)
- Named channels enable orchestrator-to-clone addressing
- Native Claude CLI feature

**Weaknesses:**
- Less documented than stream-json for automation
- Name collision risk if multiple casts run simultaneously
- Additional IPC layer (possibly Unix sockets or HTTP) — more moving parts
- Harder to test in CI (depends on Claude daemon infrastructure)

**Verdict:** Strong alternative. Consider if stream-json stdin proves insufficient (e.g., if we need multiple senders). For Phase 5 MVP, stream-json is simpler.

#### Option 4: File-Watch

**Weaknesses dominate:** Requires polling (adds latency), fragile (partial writes, race conditions), no native support (must be implemented as PreToolUse hook — soft enforcement per pitfalls.md §1). **Rejected.**

#### Option 5: Signal-Based (SIGUSR1)

**Not viable:** `claude` CLI has no signal handler that injects messages into the LLM context. A signal can only trigger side effects outside the conversation (e.g., write to a file). **Rejected.**

#### Option 6: claude-peers `send_message`

**Partial fit:** Already used for `manta.message`. The peer message arrives as a `<channel source="claude-peers">` tag in the clone's next turn. However:
- The clone must already be in a conversation turn to see it (not sleeping/idle)
- Delivery is async — no guarantee of timing
- Payload is unstructured text in a tag, not a first-class user message

**Verdict:** Keep for peer-to-peer clone communication. Not suitable as primary work delivery from orchestrator.

### Recommended Architecture

```
┌─────────────────────────────────────────────────────┐
│                    ORCHESTRATOR                       │
│                                                       │
│  ┌─────────────┐    ┌──────────────┐                 │
│  │ Work Queue   │    │ Stdin Writer  │                 │
│  │ (ClaimsStore)│───►│ (per clone)   │                 │
│  └─────────────┘    └──────┬───────┘                 │
│                            │ JSON msg                 │
└────────────────────────────┼──────────────────────────┘
                             │ stdin pipe
                             ▼
┌─────────────────────────────────────────────────────┐
│            CLONE (claude --input-format stream-json)  │
│                                                       │
│  ┌──────────┐   ┌─────────┐   ┌───────────────────┐ │
│  │ MCP Bus   │   │ Skills  │   │ Session Context    │ │
│  │ (heartbeat│   │ (manta- │   │ (persists across   │ │
│  │  lock,    │   │  as-    │   │  work items)       │ │
│  │  claim,   │   │  clone) │   │                    │ │
│  │  broadcast│   │         │   │                    │ │
│  │  zk_write)│   │         │   │                    │ │
│  └──────────┘   └─────────┘   └───────────────────┘ │
│        │                                              │
│        │ stdout pipe (NDJSON)                         │
└────────┼──────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│              ORCHESTRATOR (output reader)              │
│                                                       │
│  Parse NDJSON → track progress, detect completion,    │
│  trigger merge review, update registry                │
└─────────────────────────────────────────────────────┘
```

---

## 3. Per-Mode Analysis: Iteration Protocols

### 3.1 Pair-Programming (Wave 2, charge cost 1)

**Spec (Sec 2 #3):** 2 clones — Writer writes code, Reviewer reviews each commit.

#### Message Flow

```
Main                Writer (clone A)              Reviewer (clone B)
 │                       │                              │
 │  stdin: task          │                              │
 ├──────────────────────►│                              │
 │                       │ writes code                  │
 │                       │ git commit                   │
 │                       │ manta.broadcast              │
 │                       │   (event: "commit_ready",    │
 │                       │    ref: "abc123")             │
 │                       │                              │
 │                       │ heartbeat(WAITING_FOR_        │
 │                       │   FEEDBACK)                   │
 │                       │                              │
 │  stdin: "Writer committed abc123, review it"         │
 │  ────────────────────────────────────────────────────►│
 │                       │                              │ reviews diff
 │                       │                              │ manta.broadcast
 │                       │                              │   (event: "review_done",
 │                       │                              │    verdict: "changes_requested",
 │                       │                              │    comments: [...])
 │                       │                              │
 │  stdin: "Review feedback: {comments}"                │
 │◄─────────────────────────────────────────────────────│
 ├──────────────────────►│                              │
 │                       │ heartbeat(WORKING)           │
 │                       │ applies feedback             │
 │                       │ git commit                   │
 │                       │ ...cycle repeats...          │
 │                       │                              │
 │  (after N iterations or approval)                    │
 │                       │                              │
 │  stdin: "Task complete, begin graceful death"        │
 ├──────────────────────►├─────────────────────────────►│
 │                       │ suicide_intent               │ suicide_intent
 │                       │ report_death                 │ report_death
```

**Key design decisions:**
1. **Orchestrator mediates** — Writer doesn't send directly to Reviewer (different from spec's "direct message"). Reason: orchestrator can enrich messages with diff context, enforce review quality gates, and track iteration count.
2. **Writer goes WAITING_FOR_FEEDBACK** after commit — extended timeout (10min), death detector backs off.
3. **Iteration budget** — max 5 review cycles per task. After 5, escalate to main.
4. **Reviewer can request context** — via `manta.claim_work("context:file/path")` → orchestrator sends file content in next stdin message.

### 3.2 Test-Storm (Wave 2, charge cost 2)

**Spec (Sec 2 #4):** 3 clones — Code writer, Test writer, Chaos fuzzer. File locks, shared worktree.

This is the **hardest mode** because it requires shared worktree coordination.

#### Architecture: Shared Worktree with Lock Choreography

```
                    ┌──────────────────────────────┐
                    │        SHARED WORKTREE         │
                    │     .manta/worktrees/storm/    │
                    │                                │
                    │  ┌─────────────────────────┐   │
                    │  │ src/feature.ts           │   │
                    │  │  locked by: code-writer  │   │
                    │  └─────────────────────────┘   │
                    │  ┌─────────────────────────┐   │
                    │  │ tests/feature.test.ts    │   │
                    │  │  locked by: test-writer  │   │
                    │  └─────────────────────────┘   │
                    │  ┌─────────────────────────┐   │
                    │  │ tests/feature.fuzz.ts    │   │
                    │  │  locked by: chaos-fuzzer │   │
                    │  └─────────────────────────┘   │
                    └──────────────────────────────┘
                       ▲         ▲         ▲
                       │         │         │
              ┌────────┘    ┌────┘    ┌────┘
              │             │         │
     ┌────────┴───┐ ┌──────┴────┐ ┌──┴──────────┐
     │ Code Writer│ │Test Writer│ │Chaos Fuzzer  │
     │  (clone A) │ │ (clone B) │ │  (clone C)   │
     │            │ │           │ │              │
     │ daemon     │ │ daemon    │ │ daemon       │
     │ process    │ │ process   │ │ process      │
     └────────────┘ └───────────┘ └──────────────┘
```

**Challenge: 3 clones, 1 worktree, concurrent git operations.**

#### Branch Strategy: Stacked Branches

```
main
 └── storm/<cast-id>/base       ← shared base (created by orchestrator)
      ├── storm/<cast-id>/code  ← Code Writer commits here
      ├── storm/<cast-id>/test  ← Test Writer commits here
      └── storm/<cast-id>/fuzz  ← Chaos Fuzzer commits here
```

Each clone works on its own branch but in the **same worktree directory**. Git operations are serialized via `manta.lock("git-operations")` — only one clone can `git add/commit/checkout` at a time.

**Conflict resolution protocol:**
1. Code Writer finishes a unit → broadcasts `code_ready` with commit ref
2. Test Writer pulls code branch, writes tests on test branch
3. Chaos Fuzzer pulls both, writes chaos tests on fuzz branch
4. Orchestrator periodically attempts `git merge --no-commit` of all 3 branches onto base — if conflicts, notifies the conflicting clones with diff context
5. Final merge: orchestrator merges in order (code → test → fuzz) with conflict resolution

**Alternative (simpler, recommended for Phase 5 MVP):** Each clone gets its own worktree (existing model), orchestrator runs `git merge` between them at checkpoints. Shared-worktree is a Phase 6+ optimization.

### 3.3 Documentation-Chase (Wave 2, charge cost 1)

**Spec (Sec 2 #7):** Clone writes docs in background while main codes.

**Simplest daemon mode:** Single clone, no inter-clone coordination. The clone receives a task ("document module X"), writes docs, goes IDLE. Main can send new documentation tasks via stdin. Clone keeps context of the codebase across tasks — major efficiency gain over one-shot.

**Protocol:**
1. Main → stdin: "Document `packages/manta-bus/src/state/`"
2. Clone reads files, writes `docs/arch/bus-state.md`, broadcasts `docs_ready`
3. Clone → heartbeat(IDLE)
4. Main → stdin: "Now document `packages/manta-orchestrator/src/`"
5. Clone already has bus context → writes richer cross-references
6. Repeat until TTL or main sends shutdown

---

## 4. Supervisor Pattern

### Problem

Long-running daemon clones can crash (OOM, Claude API error, MCP server restart, network timeout). Unlike batch clones that just die and get post-mortemed, daemon clones represent **ongoing work sessions** with accumulated context.

### Crash Detection

Already implemented: `death-detector.ts` checks `last_heartbeat_at` against thresholds. For daemon clones:
- `heartbeatTimeoutMs` = 300s (unchanged)
- MCP bus auto-touch (registry.ts:118 `touch()`) refreshes on every MCP call
- Process death: `parentPidCheckEnabled` detects dead parent; for clone crash, the stdin pipe breaks and orchestrator sees EPIPE/EOF on stdout

### Recovery Strategy

```
┌──────────────────────────────────────────────────────┐
│                  SUPERVISOR LOOP                      │
│                  (in tick-loop.ts)                    │
│                                                       │
│  for each daemon clone:                               │
│    if clone.state == DEAD && clone.restartable:       │
│      if restarts_count < max_restarts (default 3):    │
│        wait(backoff_ms)                               │
│        resume_session(clone.session_id)               │
│        restarts_count++                               │
│      else:                                            │
│        escalate_to_main("clone exhausted restarts")   │
│                                                       │
│  Backoff: exponential with jitter                     │
│    attempt 1: 5s + random(0-2s)                       │
│    attempt 2: 15s + random(0-5s)                      │
│    attempt 3: 45s + random(0-10s)                     │
│                                                       │
│  Budget guard:                                        │
│    if remaining_budget < restart_cost_estimate:        │
│      skip restart, escalate as budget-exhausted        │
└──────────────────────────────────────────────────────┘
```

### Session Recovery via `--resume`

Critical insight: `claude --resume <session-id>` restores a previous session with full context. If a daemon clone crashes:

1. Orchestrator detects death (heartbeat timeout or process exit)
2. Checks if clone was `restartable` (daemon modes = yes, batch modes = no)
3. Spawns new process: `claude --resume <session-id> --input-format stream-json --output-format stream-json`
4. Sends recovery message on stdin: `"You crashed. Your last known state was WORKING on task X. Pick up where you left off."`
5. Clone resumes with previous context intact

**Budget accounting:** Each restart costs ~0 additional input tokens (session cached on disk), but output tokens resume. The charge system credits/debits at cast level, not per-restart.

### Restartability Matrix

| Mode | Restartable? | Max restarts | Reason |
|---|---|---|---|
| recon-swarm | No | 0 | Batch — re-cast is cheaper |
| forking-realities | No | 0 | Batch — re-cast preserves isolation |
| bug-hunt | No | 0 | Batch — context loss defeats layered investigation |
| refactor-wave | No | 0 | Batch — re-cast is cleaner |
| pair-programming | **Yes** | 3 | Daemon — reviewer context is expensive to rebuild |
| test-storm | **Yes** | 2 | Daemon — but shared worktree state may be corrupted |
| documentation-chase | **Yes** | 3 | Daemon — codebase context accumulates across tasks |

---

## 5. Resource Management

### 5.1 Memory Pressure & Context Compaction

Daemon clones run longer than batch clones → context grows. Claude Code handles this internally via conversation compaction, but Manta should be aware of it.

**Signals of context pressure:**
- Clone's output latency increases (more input tokens = slower response)
- Clone starts forgetting earlier task context (compaction lossy — pitfalls.md §9)
- Token usage per turn increases (API billing)

**Graceful degradation strategy:**

| Pressure level | Signal | Action |
|---|---|---|
| Normal | Output latency < 30s | Continue normally |
| Elevated | Output latency 30-60s | Orchestrator: reduce work item complexity |
| High | Output latency > 60s or clone forgets prior tasks | Orchestrator: send `context_refresh` with essential state summary |
| Critical | 3 consecutive failed tool calls or clone asks for help | Orchestrator: graceful shutdown → restart with clean session |

**Context refresh message (stdin injection):**
```json
{
  "type": "user_message",
  "content": "CONTEXT REFRESH: You are clone B in a pair-programming cast. Your current task contract: [contract]. Files you've modified so far: [list]. Current git branch: [branch]. Your reviewer's last feedback: [summary]. Continue from where you left off."
}
```

### 5.2 Token Budget for Daemon Clones

Current budget model (cast.ts): `budgetUsdPerClone` × `cloneCount` ≤ `budgetUsdPerCast`.

For daemon clones, budget must account for **multiple work items per session**:

```
daemon_budget = base_budget + (work_items_expected × per_item_estimate)

Defaults:
  pair-programming: $5 base + $2/iteration × 5 iterations = $15/clone
  test-storm:       $5 base + $3/iteration × 3 iterations = $14/clone  
  documentation-chase: $3 base + $1/doc × 10 docs = $13/clone
```

**Budget exhaustion protocol:**
1. Orchestrator tracks cumulative token usage per clone (from stream-json output metadata)
2. At 80% budget: send warning in stdin, reduce remaining work scope
3. At 95% budget: send "finish current item, then graceful death"
4. At 100% budget: SIGTERM → SIGKILL ladder (existing `terminate()`)

### 5.3 TTL for Daemon Clones

Current TTL: 20 minutes (spec Sec 6.2).

Daemon clones need longer TTLs, but with an **activity-based** rather than wall-clock model:

```
daemon_ttl = max(
  base_ttl,                    // 20 min (unchanged)
  last_activity + idle_ttl     // reset on each work item completion
)

Defaults:
  base_ttl:    60 min (daemon) vs 20 min (batch)
  idle_ttl:    10 min (kill if idle for 10 min with no new work)
  hard_ttl:    120 min (absolute maximum, no exceptions)
```

---

## 6. Heartbeat Evolution: State + Progress Reporting

### Current Heartbeat

```typescript
// schema.ts
HeartbeatInputSchema = z.object({
  clone_id: CloneIdSchema,
  state: CloneStateSchema,
  progress: z.string().max(2_000).optional(),
});
```

Implicit heartbeat via `registry.touch()` on any MCP call (bug #9 fix).

### Proposed Heartbeat v2

```typescript
HeartbeatInputSchema = z.object({
  clone_id: CloneIdSchema,
  state: CloneStateSchema,
  progress: z.string().max(2_000).optional(),
  // New fields for daemon mode
  work_item: z.string().max(200).optional(),      // current work item ID
  iteration: z.number().int().nonneg().optional(), // iteration count (pair-prog)
  context_tokens: z.number().int().nonneg().optional(), // approximate context size
  files_changed: z.number().int().nonneg().optional(),  // cumulative files changed
});
```

**Why:** The orchestrator needs richer signals for daemon clones:
- `work_item` — which task is the clone on? Enables work queue tracking.
- `iteration` — pair-programming iteration count. Enforces max-iterations budget.
- `context_tokens` — early warning for context pressure. Clone can read this from stream-json metadata.
- `files_changed` — tracks scope compliance cumulatively, not per-commit.

### Status Display for Daemon Clones

Current `manta status` shows a snapshot table. For daemon clones:

```
╔══════╦═════════════════╦══════════╦════════╦═══════════╦════════════╗
║ ID   ║ Mode            ║ State    ║ Work   ║ Iteration ║ Context    ║
╠══════╬═════════════════╬══════════╬════════╬═══════════╬════════════╣
║ A    ║ pair-prog/write ║ WAITING  ║ task-3 ║ 2/5       ║ 45k tokens ║
║ B    ║ pair-prog/review║ WORKING  ║ task-3 ║ 2/5       ║ 38k tokens ║
╚══════╩═════════════════╩══════════╩════════╩═══════════╩════════════╝
```

---

## 7. Implementation Roadmap

### Phase 5a: Daemon Runtime Foundation (~400 LOC)

| Task | Package | LOC | Depends on |
|---|---|---|---|
| Add IDLE, WAITING_FOR_FEEDBACK, PAUSED to CloneStateSchema | @manta/bus | 10 | — |
| Update death-detector for new state timeouts | @manta/orchestrator | 50 | schema change |
| Add idleTimeoutMs, feedbackTimeoutMs, pausedTtlMs thresholds | @manta/orchestrator | 20 | — |
| New DaemonCloneRunner (stream-json stdin/stdout) | @manta/cli | 120 | — |
| Stdin message writer (work delivery to daemon clones) | @manta/cli | 80 | DaemonCloneRunner |
| Stdout NDJSON parser (response tracking) | @manta/cli | 60 | — |
| Update cast.ts for daemon-mode flag on Wave 2 modes | @manta/cli | 40 | DaemonCloneRunner |
| Tests for all above | all | ~150 | all |

### Phase 5b: Supervisor & Recovery (~300 LOC)

| Task | Package | LOC | Depends on |
|---|---|---|---|
| Supervisor restart logic in tick-loop | @manta/cli | 80 | Phase 5a |
| Session recovery via `--resume` | @manta/cli | 60 | Phase 5a |
| Budget tracking for daemon clones (cumulative) | @manta/cli | 50 | Phase 5a |
| Context refresh message builder | @manta/cli | 40 | Phase 5a |
| Heartbeat v2 schema extension | @manta/bus | 15 | — |
| Heartbeat v2 handler update | @manta/bus | 25 | schema |
| Tests | all | ~100 | all |

### Phase 5c: Documentation-Chase Mode (first daemon mode) (~200 LOC)

| Task | Package | LOC | Depends on |
|---|---|---|---|
| documentation-chase dispatch in cast.ts | @manta/cli | 40 | Phase 5a |
| Documentation task builder (file → doc prompt) | @manta/cli | 50 | Phase 5a |
| Priming block for documentation-chase clone | @manta/cli | 30 | Phase 5a |
| Docs + user guide | docs/ | 40 | Phase 5a |
| Tests | all | ~50 | all |

### Total Estimate

- **LOC:** ~900-1200 (excluding tests: ~600-800)
- **Timeline:** 2-3 weeks with dogfooding (use recon-swarm + forking-realities to build it)
- **Cost:** ~$100-150 in Claude API for development casts + validation casts
- **Risk:** Medium — stream-json stdin behavior under long sessions is untested at Manta scale. Mitigation: Phase 5c ships documentation-chase first (simplest daemon mode) as validation before pair-programming/test-storm.

---

## 8. Open Questions for Plan Phase

1. **Stream-JSON message format:** What exact JSON schema does `claude --input-format stream-json` expect? Need to verify with `claude --help` or Anthropic docs. If it differs from `{"type":"user_message","content":"..."}`, the DaemonCloneRunner needs adjustment.

2. **Remote Control vs Stream-JSON:** Should we support both? Remote Control could be useful for `manta tell` (operator sends ad-hoc message to a running clone), while stream-json handles orchestrator-driven work delivery.

3. **Shared worktree for test-storm:** Phase 5 MVP uses separate worktrees (existing model) with git merge at checkpoints. Shared worktree is a Phase 6+ optimization. Confirm this deferral.

4. **`--resume` session recovery fidelity:** Does `--resume` restore MCP server connections? If not, the recovered clone won't have bus access. Need to test.

5. **Idle cost:** A daemon clone in IDLE state has a live `claude` process but makes no API calls. Is there any cost (connection keepalive, memory)? If memory pressure is high, should IDLE clones be suspended (process paused with SIGSTOP) rather than killed?

6. **Pair-programming reviewer assignment:** Static (clone A always writes, B always reviews) or rotating? Spec says static. Confirm.

7. **TTL vs iteration budget:** For pair-programming, which takes precedence — hard_ttl (120min) or max_iterations (5)? Proposed: whichever hits first.

---

## 9. Appendix: Key Source References

| File | What it tells us |
|---|---|
| `packages/manta-bus/src/schema.ts:25` | Current CloneState enum (5 values) |
| `packages/manta-bus/src/state/registry.ts` | Clone record structure, heartbeat, touch, markDead |
| `packages/manta-bus/src/tools/lifecycle.ts` | Register, heartbeat, suicideIntent, reportDeath handlers |
| `packages/manta-bus/src/tools/work.ts` | claim_work, release_work (MCP polling mechanism) |
| `packages/manta-bus/src/tools/communication.ts` | broadcast, message, readBroadcasts (clone-to-clone) |
| `packages/manta-bus/src/state/claims.ts` | ClaimsStore — atomic work item claiming |
| `packages/manta-orchestrator/src/death-detector.ts` | Current death detection (heartbeat + startup grace + parent PID) |
| `packages/manta-orchestrator/src/orchestrator.ts` | Cycle loop: find dead → reap locks → reap claims → post-mortem |
| `packages/manta-orchestrator/src/thresholds.ts` | Current thresholds (heartbeat 300s, startup 300s, stale lock 15s) |
| `packages/manta-cli/src/spawner/clone-spawner.ts` | Current spawn flow: snapshot → pre-register → runner.run |
| `packages/manta-cli/src/commands/cast.ts` | Full cast lifecycle: validate → spawn → tick → settle |
| `packages/manta-cli/src/tick-loop.ts` | Orchestrator tick loop (5s interval, allDone check) |
| `packages/manta-cli/src/runtime.ts` | Runtime setup: BusContext, Orchestrator, dispose placeholder |
| `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` Sec 3-6 | Clone lifecycle, coordination, game mechanics |
| `docs/internals/claude-code-pitfalls.md` | Hard rules: enforcement via hooks/MCP, not skill text |

# Phase 6 Research: Pair-Programming Mode — Writer/Reviewer Iteration Protocol

**Date:** 2026-05-27
**Author:** Clone A (cast-1779903737920, recon-swarm)
**Status:** Research complete — ready for plan phase
**Scope:** pair-programming mode design for Phase 6 Wave-2

---

## Executive Summary

Pair-programming mode uses 2 daemon clones in **separate worktrees** with a **broadcast-based signaling protocol** mediated by the orchestrator's daemon-loop resume cycles. The writer commits code on its branch; the reviewer reads the writer's branch via `git diff` and delivers structured feedback through `manta.broadcast`. The orchestrator resumes each clone in turn based on state transitions (IDLE → WORKING), creating a natural turn-based iteration loop. Max 5 review cycles before escalation to main.

---

## 1. Current Daemon Infrastructure Map

### 1.1 daemon-loop.ts (packages/manta-cli/src/daemon-loop.ts)

**Purpose:** Long-running work-queue consumer for a single daemon clone.

**Key mechanics:**
- Polls `WorkQueueStore.dequeue(cloneId)` for pending items targeted at this clone
- Dequeues an item → spawns `runClaudeResume` (or injected runner) with the item's `prompt`
- On success: marks item complete via `workQueue.complete(item.id)`, increments `resumeCycles`
- On failure (spawn crash): increments `consecutiveFailures`, exits at `maxResumeFailures`
- Exits on `maxEmptyPolls` consecutive empty dequeues (no more work)
- Supports `AbortSignal` for external cancellation (budget timer from cast.ts)
- `onCycleComplete` callback for orchestrator notification

**Implications for pair-programming:**
- The daemon-loop is **per-clone** — each clone (writer, reviewer) gets its own loop
- The iteration protocol maps to **work-queue items**: orchestrator enqueues "review this commit" or "apply this feedback" as prompt text
- Resume cycles preserve session context (claude --resume), so the clone remembers its role and previous iterations

### 1.2 tick-loop.ts (packages/manta-cli/src/tick-loop.ts)

**Purpose:** Orchestrator heartbeat loop — runs `orchestrator.runCycle()` periodically.

**Key mechanics:**
- Calls `orchestrator.runCycle()` which: detects dead clones, reaps stale locks, reaps expired claims, runs post-mortems
- `allDone` predicate determines when to exit (all clones DEAD, or all IDLE with empty queues in daemon mode)
- `daemonMode` flag passed from cast.ts when mode is in `DAEMON_MODES` set

**Implications for pair-programming:**
- The tick-loop is the **mediator** between writer and reviewer
- When writer transitions to IDLE (done writing), the orchestrator's next cycle sees it as idle
- The orchestrator (or cast.ts dispatch logic — **new code needed**) then enqueues the appropriate next work item for the reviewer
- `allDone` in daemon mode already handles the "all IDLE + no pending work = done" condition

### 1.3 WorkQueueStore (packages/manta-bus/src/state/work-queue.ts)

**Purpose:** Per-clone work queue with priority support.

**Key fields on WorkItem:**
- `id`, `cast_id`, `target_clone_id`, `prompt`, `priority` (normal/high), `enqueued_at`, `claimed_at`, `completed_at`

**Key operations:**
- `enqueue(input)` — add item targeted at a specific clone
- `dequeue(targetCloneId)` — claim next unclaimed item (high priority first)
- `complete(itemId)` — mark done
- `pending(targetCloneId)` — list unclaimed items

**Implications for pair-programming:**
- Work items are the **iteration unit** — each review cycle is a work-queue item
- Priority 'high' could be used for urgent feedback (e.g., blocker-severity review comments)
- The `prompt` field carries the iteration context: "Review commit abc123" or "Apply feedback: [structured comments]"

### 1.4 Communication Tools (packages/manta-bus/src/tools/communication.ts)

**Broadcast:** `manta.broadcast({ clone_id, event_type, payload })` — cast-scoped events visible to siblings via `manta.read_broadcasts({ clone_id, cast_id, since_ts })`

**Message:** `manta.message({ from_clone_id, to_clone_id, payload })` — direct clone-to-clone (blocked in forking-realities, **allowed** in pair-programming)

**Feedback:** `manta.feedback({ clone_id, from, feedback, severity })` — structured feedback with severity levels (info/correction/blocker)

**Implications for pair-programming:**
- **Broadcast** is the primary signaling mechanism — writer broadcasts `task_complete`, reviewer broadcasts `feedback_received`
- **Message** could supplement broadcast for detailed review comments, but broadcast is simpler (no routing needed)
- **Feedback** tool is already built for exactly this use case — reviewer delivers structured feedback with severity

### 1.5 Lock System (packages/manta-bus/src/tools/locks.ts + state/locks.ts)

**Key mechanics:**
- Path-based file locks with lease semantics (owner, acquired_at, last_heartbeat_at)
- Stale lease GC (`staleAfterMs`) — auto-release if owner stops heartbeating
- Same-owner re-acquire is idempotent (continuation, not fresh take)
- `reapStale()` called by orchestrator's lock-reaper on each tick cycle

**Implications for pair-programming:**
- Locks are **not needed** if clones use separate worktrees (recommended approach)
- If shared worktree were used, locks would prevent concurrent writes but add complexity
- Decision: **separate worktrees** eliminates lock contention entirely

### 1.6 Lifecycle Tools (packages/manta-bus/src/tools/lifecycle.ts)

**Key state transitions:**
- `STARTING → WORKING` (heartbeat)
- `WORKING → IDLE` (task done; increments tasks_completed)
- `IDLE → WORKING` (retasked; clears idle_since)
- `WORKING → WINDING_DOWN` (suicide_intent)
- `WINDING_DOWN → DEAD` (report_death via markDead)
- `IDLE/WAITING_FOR_TASK → WORKING` (retask)
- `request_task` — clone signals readiness for new work (sets WAITING_FOR_TASK)

**Registry daemon fields:** `session_mode` (batch/daemon), `idle_since`, `tasks_completed`, `last_task_completed_at`

**Implications for pair-programming:**
- The IDLE ↔ WORKING cycle is the **natural iteration boundary**
- Writer completes → IDLE → orchestrator sees idle → enqueues review work for reviewer
- Reviewer completes → IDLE → orchestrator enqueues feedback for writer (or signals done)
- `tasks_completed` tracks iteration count per clone

### 1.7 Orchestrator (packages/manta-orchestrator/src/orchestrator.ts)

**CycleResult includes `idleClones`** — list of clones in IDLE/WAITING_FOR_TASK with their idle_since timestamp. This is the **trigger signal** for the pair-programming dispatch logic.

### 1.8 Cast Command (packages/manta-cli/src/commands/cast.ts)

**Already implemented:**
- `pair-programming` is in `SUPPORTED_MODES` and `DAEMON_MODES`
- Validates exactly 2 clones for pair-programming mode
- Sets `session_mode: 'daemon'`, generates `sessionId` per clone
- `allDone` handles daemon termination (all IDLE + empty queues)

**Missing (Phase 6 work):**
- **Dispatch logic** — no code currently maps idle clone states to work-queue enqueues for pair-programming
- **Role assignment** — no writer/reviewer role distinction in clone assignments
- **Iteration loop driver** — no code orchestrates the writer→reviewer→writer cycle

---

## 2. Design Recommendations

### 2.1 How does the writer signal 'commit ready for review'?

**Recommendation: Broadcast + IDLE state transition (dual signal)**

The writer uses a two-part signal:

```typescript
// Writer completes implementation:
manta.broadcast({
  clone_id: "A",
  event_type: "commit_ready",
  payload: {
    commit_ref: "<sha>",
    branch: "manta/<cast_id>/A",
    summary: "implement query builder cache",
    files_changed: ["src/query.ts", "src/cache.ts"],
    iteration: 1  // monotonically increasing
  }
})
manta.heartbeat({ clone_id: "A", state: "IDLE" })
```

**Why broadcast, not work-queue self-enqueue:**
- The **writer doesn't know** the reviewer's clone_id at skill level (though it's in siblingClones). Broadcast is clone-agnostic — the orchestrator reads it and routes.
- Broadcast carries structured metadata (commit_ref, summary, files_changed) that the orchestrator uses to build the reviewer's prompt.
- The work-queue item for the reviewer is **created by the orchestrator dispatch logic**, not by the writer. This keeps the iteration protocol centralized.

**Why not file-based signal:**
- File signals require polling and have no built-in ordering/dedup.
- The bus broadcast system already exists and is battle-tested from Phases 0-5.
- Broadcasts are filterable by `cast_id` and `since_ts` — natural for iteration tracking.

### 2.2 How does the reviewer deliver feedback?

**Recommendation: Broadcast with structured review object**

The reviewer reads the writer's branch via git (not shared worktree), performs the review, and signals via broadcast:

```typescript
manta.broadcast({
  clone_id: "B",
  event_type: "review_complete",
  payload: {
    iteration: 1,
    verdict: "changes_requested" | "approved" | "blocker",
    comments: [
      {
        file: "src/query.ts",
        line: 42,
        severity: "correction",  // info | correction | blocker
        comment: "Missing null check on cache miss path"
      },
      {
        file: "src/cache.ts",
        line: 15,
        severity: "info",
        comment: "Consider extracting TTL constant"
      }
    ],
    summary: "One correctness issue (null check), one style suggestion",
    tests_passed: true,  // reviewer ran tests on writer's branch
    build_passed: true
  }
})
manta.heartbeat({ clone_id: "B", state: "IDLE" })
```

**Why broadcast, not inline worktree edits:**
- Reviewer must NOT modify the writer's worktree — this is a fundamental separation of concerns
- Structured review data is machine-parseable by the orchestrator for iteration decisions
- The `verdict` field drives the protocol: `approved` = done, `changes_requested` = next iteration, `blocker` = escalate to main
- `manta.feedback` tool could supplement this for audit-trail purposes, but broadcast is the primary signal

**Why not the `manta.feedback` tool alone:**
- `feedback` has a flat string `feedback` field (max 8000 chars) — not structured enough for per-file comments
- `feedback` doesn't carry a verdict or iteration number
- However, the orchestrator SHOULD also call `manta.feedback` to create a permanent audit trail after reading the broadcast

### 2.3 Iteration loop design

**Recommendation: Orchestrator-driven turn-based loop with max 5 iterations**

```
┌─────────────────────────────────────────────────────┐
│                  CAST STARTS                        │
│  Writer (A): WORKING on initial implementation      │
│  Reviewer (B): IDLE, waiting for first commit       │
└──────────────────────┬──────────────────────────────┘
                       │
         ┌─────────────▼─────────────┐
         │  Writer broadcasts        │
         │  "commit_ready" → IDLE    │
         └─────────────┬─────────────┘
                       │
         ┌─────────────▼─────────────┐
         │  Orchestrator dispatch:   │
         │  1. Read broadcast        │
         │  2. Enqueue review work   │
         │     for Reviewer (B)      │
         │  3. Reviewer daemon-loop  │
         │     dequeues, resumes     │
         └─────────────┬─────────────┘
                       │
         ┌─────────────▼─────────────┐
         │  Reviewer reviews diff,   │
         │  broadcasts verdict       │
         │  → IDLE                   │
         └─────────────┬─────────────┘
                       │
              ┌────────▼────────┐
              │  verdict ==     │
              │  "approved"?    │
              ├── YES ──────────┼── NO ──────────────┐
              │                 │                     │
    ┌─────────▼────────┐  ┌────▼──────────────────┐  │
    │  Orchestrator:    │  │  iteration < 5?       │  │
    │  No more work.   │  ├── YES ────┬── NO ─────┤  │
    │  Both go IDLE,   │  │           │           │  │
    │  queues empty    │  │  Enqueue  │  Escalate │  │
    │  → allDone=true  │  │  fix work │  to main  │  │
    └──────────────────┘  │  for      │  (abort   │  │
                          │  Writer   │  cast or  │  │
                          │           │  force-   │  │
                          │           │  approve) │  │
                          └───────────┴───────────┘  │
                                                     │
                       ┌─────────────────────────────┘
                       │
         ┌─────────────▼─────────────┐
         │  Writer applies feedback, │
         │  re-commits, broadcasts   │
         │  "commit_ready" → IDLE    │
         └─────────────┬─────────────┘
                       │
                  (loop back to reviewer)
```

**Iteration cap: 5 cycles** (already in manta-pair-protocol SKILL.md)

- Iterations 1-3: normal review cycle
- Iteration 4: reviewer broadcast includes `"escalation_warning": true`
- Iteration 5: if still not approved, orchestrator stops the loop and leaves a `blocker` broadcast for main to read in the post-mortem

**Orchestrator dispatch logic (new code in cast.ts or separate pair-dispatch.ts):**

```typescript
// Pseudocode for the pair-programming dispatch handler
// Called from the tick-loop when idle clones are detected

interface PairState {
  iteration: number;
  writerCloneId: string;
  reviewerCloneId: string;
  lastBroadcastTs: number;
  phase: 'writer_working' | 'reviewer_working' | 'done' | 'escalated';
}

async function dispatchPairIteration(
  ctx: BusContext,
  state: PairState,
  castId: string,
): Promise<PairState> {
  const broadcasts = await ctx.events.readAll();
  const recent = broadcasts.filter(
    e => e.type === 'broadcast' &&
         (e.payload as any)?.cast_id === castId &&
         e.ts > state.lastBroadcastTs
  );

  // Find the most recent commit_ready or review_complete
  const commitReady = recent.find(
    e => (e.payload as any)?.event_type === 'commit_ready'
  );
  const reviewComplete = recent.find(
    e => (e.payload as any)?.event_type === 'review_complete'
  );

  if (commitReady && state.phase === 'writer_working') {
    // Writer done → enqueue review for reviewer
    const payload = (commitReady.payload as any)?.body;
    await ctx.workQueue!.enqueue({
      cast_id: castId,
      target_clone_id: state.reviewerCloneId,
      prompt: buildReviewPrompt(payload),
      priority: 'normal',
    });
    return { ...state, phase: 'reviewer_working', lastBroadcastTs: commitReady.ts };
  }

  if (reviewComplete && state.phase === 'reviewer_working') {
    const payload = (reviewComplete.payload as any)?.body;
    if (payload?.verdict === 'approved') {
      return { ...state, phase: 'done', lastBroadcastTs: reviewComplete.ts };
    }
    if (state.iteration >= 5) {
      return { ...state, phase: 'escalated', lastBroadcastTs: reviewComplete.ts };
    }
    // Enqueue fix work for writer
    await ctx.workQueue!.enqueue({
      cast_id: castId,
      target_clone_id: state.writerCloneId,
      prompt: buildFixPrompt(payload),
      priority: payload?.verdict === 'blocker' ? 'high' : 'normal',
    });
    return {
      ...state,
      phase: 'writer_working',
      iteration: state.iteration + 1,
      lastBroadcastTs: reviewComplete.ts,
    };
  }

  return state; // No new signals — wait
}
```

### 2.4 Worktree strategy

**Recommendation: Separate worktrees (one per clone)**

This is already the default in cast.ts — each clone gets its own worktree via `addWorktree()`:
- Writer: `.manta/worktrees/clone-A` on branch `manta/<castId>/A`
- Reviewer: `.manta/worktrees/clone-B` on branch `manta/<castId>/B`

**How the reviewer sees the writer's code:**

The reviewer reads the writer's branch via git operations in its own worktree:

```bash
# Reviewer's prompt includes instructions to:
git fetch origin  # or just read from the writer's worktree path directly
git diff main..manta/<castId>/A  # see all writer's changes vs main
git log manta/<castId>/A --oneline -5  # see recent commits
```

Since both worktrees share the same `.git` directory (git worktrees use a shared object store), the reviewer can reference the writer's branch **without any network fetch** — it's already in the local repo.

**Why not shared worktree:**
- Write conflicts between writer and reviewer are eliminated by design
- No lock contention on files
- Reviewer cannot accidentally modify writer's code
- Each clone has clean git state for commits
- This matches the existing cast.ts infrastructure — zero new code for worktree setup

**The reviewer does NOT commit to the writer's branch.** Reviewer's worktree is used only for:
1. Reading the writer's branch via cross-branch git commands
2. Optionally running the writer's code/tests locally (checkout writer's branch read-only)
3. Building the structured review broadcast

### 2.5 Interaction with existing daemon infrastructure

**daemon-loop.ts integration:**
- Each clone runs its own daemon-loop instance
- Writer's daemon-loop dequeues "implement X" and "apply feedback Y" items
- Reviewer's daemon-loop dequeues "review commit Z" items
- `onCycleComplete` callback updates PairState in cast.ts dispatch logic

**tick-loop.ts integration:**
- Tick-loop runs the orchestrator which detects idle clones via `idleClones` in CycleResult
- **New dispatch logic** hooks into the tick-loop's cycle callback (or a post-cycle hook in cast.ts)
- When both clones are IDLE and queues are empty → `allDone` returns true (already implemented)

**WorkQueueStore integration:**
- Items are enqueued by the **dispatch logic** (not by clones directly)
- Writer never enqueues for reviewer; reviewer never enqueues for writer
- The orchestrator is the sole enqueuer — keeps the protocol centralized and auditable

**New code needed:**

| Component | Location | Purpose |
|---|---|---|
| `PairDispatcher` | `packages/manta-cli/src/dispatch/pair-dispatch.ts` | State machine + enqueue logic |
| Writer role priming | `skills/manta-pair-writer/SKILL.md` | Writer-specific instructions |
| Reviewer role priming | `skills/manta-pair-reviewer/SKILL.md` | Reviewer-specific instructions |
| Dispatch hook in cast.ts | `packages/manta-cli/src/commands/cast.ts` | Wire PairDispatcher into tick-loop |
| Review prompt builder | `packages/manta-cli/src/dispatch/review-prompt.ts` | Build reviewer prompts from broadcast data |
| Fix prompt builder | `packages/manta-cli/src/dispatch/fix-prompt.ts` | Build writer fix prompts from review data |

### 2.6 Priming and skill text per role

**Writer clone priming (manta-pair-writer skill):**

```markdown
# manta-pair-writer

You are the WRITER in a pair-programming session. Your role:
1. Implement the task described in your task contract
2. Write clean, tested code. Run tests before signaling done.
3. When implementation is complete:
   - Commit all changes to your branch
   - Broadcast `commit_ready` with commit ref, summary, and files changed
   - Transition to IDLE and wait for reviewer feedback
4. When you receive fix feedback (via resume prompt):
   - Read the reviewer's comments carefully
   - Apply all corrections and blockers. Info-severity comments are optional.
   - Re-run tests after fixes
   - Re-commit and broadcast `commit_ready` again
5. Max 5 iterations. If you cannot resolve a blocker after 3 attempts,
   broadcast `writer_stuck` with details for main escalation.

You must NOT:
- Review your own code (that's the reviewer's job)
- Read or modify the reviewer's worktree
- Enqueue work items (the orchestrator handles dispatch)
```

**Reviewer clone priming (manta-pair-reviewer skill):**

```markdown
# manta-pair-reviewer

You are the REVIEWER in a pair-programming session. Your role:
1. Wait for review work items from the orchestrator
2. When you receive a review prompt:
   - Read the writer's branch diff: `git diff main..manta/<castId>/<writerCloneId>`
   - Check: correctness, edge cases, test coverage, spec compliance
   - Run the writer's tests in your worktree if needed
3. Deliver feedback via broadcast `review_complete` with:
   - verdict: "approved" | "changes_requested" | "blocker"
   - Per-file comments with severity (info/correction/blocker)
   - Whether tests passed
4. Transition to IDLE after each review
5. Approval threshold: all blockers resolved, no new correctness issues.
   Style/info items are optional — don't block on them after iteration 3.

You must NOT:
- Modify files in the writer's worktree or your own code files
- Commit code changes — you are review-only
- Self-approve or skip review steps
- Enqueue work items (the orchestrator handles dispatch)
```

**Key difference from existing manta-pair-protocol skill:**
- The existing `manta-pair-protocol` SKILL.md is a **combined** protocol doc — useful as reference but too generic for priming
- The Phase 6 implementation should split into **role-specific skills** loaded based on clone assignment
- The role is determined by `cloneAssignments` in the cast command: `{ "A": { task: "...", approach_hint: "writer" }, "B": { task: "...", approach_hint: "reviewer" } }`

---

## 3. Open Design Questions for Plan Phase

### 3.1 Dispatch location: cast.ts inline vs separate module?

**Recommendation:** Separate `PairDispatcher` class in `packages/manta-cli/src/dispatch/pair-dispatch.ts`.

Rationale: cast.ts is already 700+ lines. Each Wave-2 mode has distinct dispatch logic. A `dispatch/` directory with `pair-dispatch.ts`, `test-storm-dispatch.ts`, `doc-chase-dispatch.ts` keeps cast.ts as the entry point and delegates mode-specific orchestration.

### 3.2 How does the dispatch logic hook into the tick-loop?

**Option A: Post-cycle callback in tick-loop**
Add an `onCycleComplete?: (result: CycleResult) => Promise<void>` to `RunTickLoopOptions`. The dispatch logic runs after each orchestrator cycle, reads `idleClones`, and enqueues work as needed.

**Option B: Wrap allDone with dispatch side-effects**
The existing `allDone` callback already runs every tick. Extend it to also run dispatch logic before checking termination.

**Recommendation:** Option A — cleaner separation. `allDone` should remain a pure predicate; side-effects in a predicate are a bug magnet.

### 3.3 PairState persistence

The `PairState` (iteration count, current phase, last broadcast timestamp) must survive across tick-loop cycles but NOT across cast restarts.

**Recommendation:** In-memory state within the `PairDispatcher` instance, created at cast start, garbage-collected at cast end. No file persistence needed — if the cast crashes, the entire pair session is restarted.

### 3.4 Reviewer running writer's tests

The reviewer needs to run the writer's code to verify correctness. Options:

**Option A: Reviewer checks out writer's branch in its own worktree**
```bash
git checkout manta/<castId>/A  # in reviewer's worktree
npm test
git checkout manta/<castId>/B  # back to reviewer's branch
```

**Option B: Reviewer runs tests against writer's worktree path directly**
```bash
cd /path/to/writer-worktree && npm test
```

**Recommendation:** Option A — reviewer uses its own worktree to checkout the writer's branch for testing. This avoids cross-worktree file access and keeps each clone's process confined to its own directory. The reviewer's branch (`manta/<castId>/B`) is just a workspace — reviewer doesn't commit code, so branch switching is safe.

### 3.5 How does the writer receive feedback?

The writer's daemon-loop dequeues a work-queue item whose `prompt` contains the reviewer's feedback. The prompt is built by the dispatch logic:

```
The reviewer has completed review of your iteration 1. Verdict: changes_requested.

Feedback:
- [CORRECTION] src/query.ts:42 — Missing null check on cache miss path
- [INFO] src/cache.ts:15 — Consider extracting TTL constant

Apply the CORRECTION-level fixes, re-run tests, commit, and broadcast commit_ready.
```

This is a **resume prompt** — the writer's Claude session continues from where it left off, with full context of what it was building. The structured feedback in the prompt is the only mechanism needed — no shared files, no worktree reads.

---

## 4. Risk Analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Writer's broadcast lost (bus write failure) | High | Retry once; if still fails, writer broadcasts `writer_stuck` |
| Reviewer takes too long → heartbeat timeout | Medium | Daemon mode heartbeat is auto-touched by bus calls; reviewer should call `manta.heartbeat(WORKING)` before long reviews |
| Infinite iteration loop (reviewer never approves) | High | Hard cap at 5 iterations + escalation broadcast |
| Cross-branch git commands fail (branch doesn't exist yet) | Medium | Dispatch logic waits for `commit_ready` broadcast which confirms the branch exists |
| Writer and reviewer skills drift (one says broadcast X, other expects Y) | Medium | Single source of truth: `BroadcastEventTypeSchema` in schema.ts; add `commit_ready` and `review_complete` to the allowed enum |
| Resume prompt too long (many review comments) | Low | Truncate to 4000 chars in prompt builder; full review in broadcast payload for audit |
| Session ID collision between writer and reviewer daemon-loops | None | Already handled — cast.ts generates unique sessionId per clone with UUID |

---

## 5. Schema Changes Needed

### 5.1 BroadcastEventTypeSchema (packages/manta-bus/src/schema.ts)

Current enum likely needs new values:
```typescript
// Add to BroadcastEventTypeSchema:
'commit_ready'       // writer signals code is ready for review
'review_complete'    // reviewer delivers verdict
'writer_stuck'       // writer cannot resolve feedback, escalate
```

### 5.2 CloneAssignment enhancement

Add optional `role` field to `CloneAssignment`:
```typescript
// In CloneAssignmentSchema:
role: z.enum(['writer', 'reviewer']).optional()
```

This allows the dispatch logic to know which clone plays which role without parsing approach_hint strings.

### 5.3 New event types in EventsStore

Consider adding `pair_iteration` event type for audit trail:
```typescript
{
  type: 'pair_iteration',
  clone_id: '<dispatch>',
  payload: {
    cast_id: string,
    iteration: number,
    from_phase: 'writer_working' | 'reviewer_working',
    to_phase: 'reviewer_working' | 'writer_working' | 'done' | 'escalated',
    verdict?: string,
  }
}
```

---

## 6. Implementation Estimate

| Component | Size | Depends on |
|---|---|---|
| PairDispatcher state machine | ~150 LOC | WorkQueueStore, EventsStore |
| Review prompt builder | ~80 LOC | BroadcastInputSchema |
| Fix prompt builder | ~60 LOC | BroadcastInputSchema |
| cast.ts dispatch wiring | ~50 LOC | PairDispatcher |
| tick-loop onCycleComplete hook | ~20 LOC | - |
| Schema additions (broadcast types, role) | ~15 LOC | - |
| manta-pair-writer SKILL.md | ~40 lines | - |
| manta-pair-reviewer SKILL.md | ~40 lines | - |
| Tests (dispatch, prompt builders, integration) | ~300 LOC | All above |
| **Total** | **~755 LOC** | |

Estimated effort: 1 forking-realities cast (2 clones, ~45 min) or 1 sequential implementation session (~2 hours).

---

## 7. Comparison with Existing Skill

The existing `skills/manta-pair-protocol/SKILL.md` (v0.0.1) is a **placeholder** from Phase 5 Chunk 2. It correctly describes the broadcast-based signaling pattern and 5-iteration cap, but:

1. **Missing:** Role-specific skills (writer vs reviewer) — the combined doc is too generic for priming
2. **Missing:** Dispatch logic design — the skill assumes "orchestrator mediates" but doesn't specify how
3. **Missing:** Cross-branch review mechanism — doesn't explain how reviewer sees writer's code
4. **Missing:** Prompt construction — no detail on what the resume prompts contain
5. **Correct:** Broadcast event types (`task_complete`, `feedback_received`) are close to the recommended `commit_ready`, `review_complete` — rename for clarity

The Phase 6 plan should **replace** the placeholder skill with the two role-specific skills and update the protocol references.

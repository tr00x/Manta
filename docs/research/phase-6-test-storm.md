# Phase 6 Research: Test-Storm Mode — Tri-Clone Iteration Protocol

**Author:** Clone B (cast-1779903737920)  
**Date:** 2026-05-27  
**Status:** Research complete — ready for plan extraction

---

## 1. Executive Summary

Test-storm is the **hardest Wave-2 mode** because it requires 3 clones (code-writer, test-writer, chaos-fuzzer) coordinating in a shared worktree with file-level locking and pipeline-style signaling. This document maps the existing bus infrastructure against test-storm requirements and delivers concrete design recommendations for each coordination challenge.

**Key finding:** The existing bus infrastructure (locks, broadcasts, work queue, daemon loop) provides ~80% of what test-storm needs. The missing 20% is: (a) a git-operations meta-lock convention, (b) new broadcast event types for pipeline coordination, (c) orchestrator pipeline-stage awareness, and (d) chaos clone tooling strategy.

---

## 2. Infrastructure Map — Current State

### 2.1 File Locks (`LocksStore` — `packages/manta-bus/src/state/locks.ts`)

| Capability | Detail |
|---|---|
| Acquire | `manta.lock({ clone_id, path })` — path is `RepoRelativePathSchema` (no `..`) |
| Release | `manta.unlock({ clone_id, path })` |
| Renew | `manta.renew_lock({ clone_id, path })` — bumps `last_heartbeat_at` |
| Stale GC | `reapStale()` — leases older than `staleAfterMs` are reclaimed |
| Same-owner re-acquire | Idempotent — bumps heartbeat, preserves `acquired_at` |
| Different-owner acquire | Blocked until stale; throws `BusLockedError` |
| Granularity | **Per-path** — any repo-relative string. Directory-level locks possible via convention (e.g., `src/feature/`) |

**Advisory nature:** Locks are enforced at bus level, not filesystem level. A clone CAN write to a path it hasn't locked — compliance is via skill discipline or PreToolUse hooks.

**Sufficient for test-storm?** Yes, with conventions. File-level locks prevent two clones from editing the same source file. What's missing: a git-operations meta-lock (see §3.6).

### 2.2 Broadcast System (`communication.ts`)

| Tool | Schema |
|---|---|
| `manta.broadcast` | `{ clone_id, event_type, payload: Record<string,unknown> }` |
| `manta.read_broadcasts` | `{ clone_id, cast_id, since_ts? }` — returns sibling broadcasts only |

**Current event types:** `breakthrough`, `blocker`, `dependency`, `self_certainty`, `task_complete`, `idle`, `feedback_received`

**For test-storm, need new event types:** `code_ready`, `tests_ready`, `fuzz_complete`, `test_failures`, `fix_requested`. These require extending `BroadcastEventTypeSchema` in `schema.ts`.

**No forking isolation:** Test-storm clones are NOT in forking-realities mode — `manta.message` (point-to-point) is available. Broadcasts are filtered by `cast_id`, so only storm clones see each other.

### 2.3 Work Queue (`WorkQueueStore` — `packages/manta-bus/src/state/work-queue.ts`)

| Operation | Detail |
|---|---|
| `enqueue` | `{ cast_id, target_clone_id, prompt, priority }` — creates `WorkItem` |
| `dequeue` | By `target_clone_id`, unclaimed only, high-priority first |
| `complete` | Mark item done by `itemId` |
| `pending` | List unclaimed items for a clone |

**Key design:** Items are **targeted per-clone**. The orchestrator decides which clone gets which work. This maps perfectly to test-storm's pipeline: orchestrator enqueues stage-appropriate work for each role.

### 2.4 Daemon Loop (`packages/manta-cli/src/daemon-loop.ts`)

Polls `WorkQueueStore.dequeue()` → runs `claude --resume` with `item.prompt` → marks `complete()` on success. Exits on `no_work` (after `maxEmptyPolls`), `aborted` (signal), or `max_failures`.

**Fit for test-storm:** Each clone runs its own daemon loop, polling for role-specific work items. The orchestrator feeds the pipeline by enqueueing items as upstream stages complete.

### 2.5 Claims (`ClaimsStore` — `packages/manta-bus/src/state/claims.ts`)

Work-item-level claims with expiry. **Blocked for forking-realities** (isolation), but **allowed for test-storm**. Could be used for fine-grained task claiming but overlaps with work queue `dequeue` (which already "claims" by setting `claimed_at`). Not essential for test-storm pipeline.

### 2.6 Lifecycle States

Available: `WORKING`, `IDLE`, `WINDING_DOWN`, `DEAD`, `WAITING_FOR_TASK`.

**Test-storm state machine per clone:**
```
WORKING → (task done) → IDLE → (new item dequeued) → WORKING → ...
WORKING → (blocked on upstream) → IDLE/WAITING_FOR_TASK → (unblocked) → WORKING
```

---

## 3. Design Answers — Six Questions

### 3.1 Q1: How do file locks prevent conflicts in shared worktree?

**Recommendation: Directory-partition locks + git-operations meta-lock.**

Lock assignment by role convention:

| Clone | Locked paths | Description |
|---|---|---|
| Code Writer (A) | `src/<feature>/**` | Implementation files |
| Test Writer (B) | `tests/<feature>/**`, `__tests__/<feature>/**` | Test files |
| Chaos Fuzzer (C) | `tests/<feature>/*.fuzz.ts`, `tests/<feature>/*.prop.ts` | Fuzz/property test files |

**Convention enforcement:**
- **Skill text** (soft prior): each role's skill specifies "you own these paths; lock before writing"
- **PreToolUse hook** (hard enforcement, recommended): hook on `Edit`/`Write` tools checks `manta.lock` ownership. If clone writes to a path it hasn't locked → blocked with error message. This is the only reliable enforcement mechanism per `claude-code-pitfalls.md` §3-4.

**Why existing lock system is sufficient:**
- Path-based locking with stale GC handles the core case: two clones can't both write `src/feature.ts`
- `BusLockedError` gives a clear signal: "file locked by code-writer, wait"
- Same-owner re-acquire is idempotent — a clone re-locking its own path is safe
- `reapStale()` recovers from crashed clones (stale leases auto-expire)

**What's NOT handled:** Read-after-write visibility. Clone B can read `src/feature.ts` while Clone A is mid-edit (file not yet saved/committed). Mitigation: pipeline stages (B reads only after A's commit — see §3.2).

### 3.2 Q2: What signals coordinate the code → test → chaos pipeline?

**Recommendation: Orchestrator-mediated work queue with broadcast status signals.**

```
┌─────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR                              │
│  Watches broadcasts → enqueues work items → manages flow    │
└────────┬────────────────┬────────────────────┬──────────────┘
         │                │                    │
    enqueue(A)       enqueue(B)           enqueue(C)
    "implement X"    "write tests         "fuzz/mutate
         │            for commit abc"      against commit
         ▼                │                def+ghi"
   ┌──────────┐           ▼                    │
   │  CODE    │    ┌───────────┐               ▼
   │  WRITER  │    │   TEST    │        ┌────────────┐
   │ (clone A)│    │  WRITER   │        │   CHAOS    │
   │          │    │ (clone B) │        │  FUZZER    │
   │ writes   │    │ writes    │        │ (clone C)  │
   │ impl     │    │ tests     │        │ fuzz+prop  │
   │ commits  │    │ commits   │        │ commits    │
   │ →bcast   │    │ →bcast    │        │ →bcast     │
   │task_comp │    │task_comp  │        │task_comp   │
   └──────────┘    └───────────┘        └────────────┘
```

**Pipeline sequence (per feature unit):**

1. **Orchestrator** enqueues work item for Code Writer: `"Implement <feature description>"`
2. **Code Writer** implements, locks `src/<feature>/**`, commits, broadcasts `task_complete` with `{ commit_ref, files_changed: [...] }`
3. **Orchestrator** sees `task_complete` from Code Writer, enqueues for Test Writer: `"Write tests for commit <ref>. Changed files: [...]"`
4. **Test Writer** reads implementation (visible in shared worktree post-commit), writes tests, locks `tests/<feature>/**`, commits, broadcasts `task_complete` with `{ commit_ref, test_files: [...], pass: true/false }`
5. **Orchestrator** sees both complete, enqueues for Chaos Fuzzer: `"Run fuzz/property tests against <feature>. Impl: <ref>, Tests: <ref>"`
6. **Chaos Fuzzer** reads both, writes fuzz/property tests, commits, broadcasts `task_complete` with results

**Why orchestrator-mediated, not clone-to-clone:**
- Orchestrator maintains budget awareness — can skip chaos stage if budget tight
- Orchestrator can parallelize: while Test Writer works on feature N, Code Writer starts feature N+1
- Failure handling centralised: if Test Writer finds bugs, orchestrator routes fix-request back to Code Writer
- Prevents runaway cycles — orchestrator enforces max iterations

### 3.3 Q3: How does test clone know when new code is ready?

**Recommendation: Daemon loop polling work queue, fed by orchestrator.**

The test clone does NOT poll for broadcasts or watch for code changes directly. Instead:

1. Test clone runs `runDaemonLoop()` which polls `WorkQueueStore.dequeue("test-writer")`
2. When orchestrator sees code writer's `task_complete` broadcast, it calls `workQueue.enqueue({ target_clone_id: "test-writer", prompt: "Write tests for..." })`
3. Daemon loop picks up the item, resumes Claude session with the prompt
4. Test clone runs tests, completes item, goes idle waiting for next

**Why not direct broadcast polling:**
- Daemon loop already handles work item polling with `maxEmptyPolls` and `pollIntervalMs`
- Work queue items carry structured prompts — broadcasts carry metadata
- Orchestrator can batch: "here are 3 files that changed, write tests for all"
- Priority support: `high` priority items skip the queue (useful for fix-requests)

**Latency:** `pollIntervalMs` (configurable) determines how fast the test clone picks up work. Recommend 2-3 seconds for test-storm — tight enough for interactive feel, loose enough to avoid busy-wait.

### 3.4 Q4: Chaos/fuzzing clone — what does it do in TypeScript/Node?

**Recommendation: Three-tier approach, pragmatically scoped.**

#### Tier 1 — Property-Based Testing (primary, always run)

Use **fast-check** (`fast-check` npm package):
- Generate random inputs to exported functions
- Verify invariants hold across thousands of random inputs
- Example: `fc.assert(fc.property(fc.array(fc.integer()), (arr) => sort(arr).length === arr.length))`
- Pure JS, no external tooling, runs in Node
- Chaos clone reads function signatures, generates property tests automatically

**What the clone prompt looks like:**
```
Read the implementation in src/<feature>.ts. For each exported function:
1. Identify parameter types from TypeScript signatures
2. Write fast-check property tests that verify:
   - Return type correctness
   - Idempotency where applicable
   - Commutativity/associativity for mathematical operations
   - No thrown exceptions on valid inputs
   - Boundary behavior (empty arrays, zero, MAX_SAFE_INTEGER, null/undefined)
3. Write to tests/<feature>.prop.ts
```

#### Tier 2 — Boundary/Edge Case Generation (always run)

Systematic edge case matrix:
- Empty inputs: `[]`, `""`, `{}`, `0`, `null`, `undefined`
- Boundary values: `Number.MAX_SAFE_INTEGER`, `-Infinity`, `NaN`
- Unicode: emoji, RTL text, zero-width characters
- Concurrency: overlapping async calls to the same function
- Large inputs: arrays with 10K elements, deeply nested objects

This doesn't require any special tool — the chaos clone generates standard Vitest/Jest tests with these inputs.

#### Tier 3 — Mutation Testing (optional, budget-permitting)

Use **Stryker** (`@stryker-mutator/core`):
- Modifies source code (mutants: `+` → `-`, `true` → `false`, etc.)
- Runs test suite against each mutant
- Reports mutation score (% of mutants killed by tests)
- **Expensive:** runs full test suite per mutation. For a 100-test suite with 50 mutants = 5,000 test runs

**Recommendation for Phase 6:** Tier 1 + Tier 2 mandatory. Tier 3 gated behind a budget check — orchestrator only enqueues mutation testing if remaining budget > estimated cost.

#### What the chaos clone is NOT:

- Not a security fuzzer (AFL, libFuzzer) — those are C/C++ tools
- Not a random monkey-testing UI — there's no UI in Manta
- Not a load tester — test-storm is about correctness, not performance

### 3.5 Q5: How do test results flow back to code clone for fixes?

**Recommendation: Orchestrator-mediated feedback loop with max iterations.**

```
Code Writer          Orchestrator          Test Writer         Chaos Fuzzer
    │                     │                    │                    │
    │ ── task_complete ──→│                    │                    │
    │                     │── enqueue tests ──→│                    │
    │                     │                    │── run tests ──────→│
    │                     │                    │                    │
    │                     │←── task_complete ──│ (tests pass)       │
    │                     │                    │                    │
    │                     │── enqueue fuzz ───────────────────────→│
    │                     │                    │                    │
    │                     │←───────────────── task_complete ───────│
    │                     │                    │   (fuzz results)   │
    │                     │                    │                    │
    │ (if failures:)      │                    │                    │
    │←── enqueue fix ─────│                    │                    │
    │ "Fix: test X failed │                    │                    │
    │  with error Y.      │                    │                    │
    │  Fuzz found: Z"     │                    │                    │
    │                     │                    │                    │
    │── task_complete ───→│ (fix committed)    │                    │
    │                     │── enqueue retest ─→│                    │
    │                     │        ...cycle repeats...              │
```

**Flow details:**

1. Test Writer runs tests → if all pass, broadcasts `task_complete` with `{ pass: true, coverage: N% }`
2. If failures: broadcasts `blocker` with `{ failures: [{ test, error, file, line }] }`
3. Orchestrator captures failure, builds structured fix-request, enqueues for Code Writer with `priority: 'high'`
4. Code Writer picks up fix-request, applies fix, commits, broadcasts `task_complete`
5. Orchestrator re-enqueues test run for Test Writer
6. **Max iterations: 3 fix cycles** per feature unit. After 3 failures → escalate to main with full failure log

**Chaos Fuzzer results flow similarly:**
- Property test violations → structured failure report → enqueue fix for Code Writer
- Mutation testing results → mutation score report → informational (no fix cycle unless score < threshold)

**Why 3 max iterations (not 5 like pair-programming):**
- Test-storm has 3 clones, each iteration costs 3× the tokens
- After 3 fix cycles, the problem is likely architectural, not a simple bug
- Escalation to main preserves budget for other features

### 3.6 Q6: Shared worktree merge strategy

**Recommendation: Single shared branch with git-operations meta-lock.**

#### Branch Layout

```
main
 └── storm/<cast-id>/work    ← single shared branch, all 3 clones commit here
```

#### Git-Operations Lock

**Critical new convention:** Before any `git add`, `git commit`, `git checkout`, or `git stash`:

```
manta.lock({ clone_id: "A", path: "GIT_OPERATIONS" })
// ... git add + git commit ...
manta.unlock({ clone_id: "A", path: "GIT_OPERATIONS" })
```

`GIT_OPERATIONS` is a virtual path (not a real file) — the lock system doesn't validate path existence, just uniqueness. Only one clone can hold this lock at a time.

**Enforcement:** PreToolUse hook on `Bash` tool — if command contains `git add`, `git commit`, `git checkout`, check for `GIT_OPERATIONS` lock ownership. This is the only reliable enforcement (per `claude-code-pitfalls.md`).

#### Why single branch (not stacked per-role)

| Strategy | Pros | Cons |
|---|---|---|
| **Single shared branch** (recommended) | Clones see each other's changes immediately after commit; no merge ceremony; simple mental model | Must serialize git operations; one clone waits while another commits |
| Stacked per-role branches | No git contention; each clone has own branch | Test writer can't see code writer's changes without explicit merge; orchestrator must run periodic merges; merge conflicts accumulate |
| Separate worktrees | Zero contention; existing model works | Defeats the purpose of shared worktree; test clone must `git fetch` from code clone's worktree; stale-read problem returns |

**The serialization cost is acceptable** because:
- `git add + git commit` takes < 2 seconds
- With 3 clones and `GIT_OPERATIONS` lock, worst case wait is ~4 seconds
- Clones spend most time writing code (minutes), not committing (seconds)
- Lock contention is low: code writer commits, then works on next feature while test writer reads and writes tests

#### Fallback Plan

If shared-branch proves fragile in practice (e.g., clones overwriting each other's uncommitted changes despite locks):
- Degrade to **stacked branches** with orchestrator-managed merges at pipeline stage boundaries
- Each clone gets `storm/<cast-id>/code`, `storm/<cast-id>/test`, `storm/<cast-id>/fuzz`
- Orchestrator runs `git merge --no-commit` to combine at checkpoints

---

## 4. Orchestrator Pipeline Logic — New Component

Test-storm needs a **pipeline stage manager** in the orchestrator. This is the primary new code.

### 4.1 Stage Definition

```typescript
interface TestStormStage {
  featureId: string;          // unique per feature unit
  codeCommitRef?: string;     // set when code writer completes
  testCommitRef?: string;     // set when test writer completes
  fuzzCommitRef?: string;     // set when chaos fuzzer completes
  fixCycles: number;          // 0..3
  status: 'coding' | 'testing' | 'fuzzing' | 'fixing' | 'complete' | 'escalated';
}
```

### 4.2 Orchestrator Cycle Actions

Each `runCycle()` tick:
1. Read broadcasts since last tick
2. For each `task_complete` from code writer → create/advance stage, enqueue test work
3. For each `task_complete` from test writer (pass) → enqueue fuzz work
4. For each `blocker` from test/chaos → check fixCycles < 3, enqueue fix for code writer OR escalate
5. For each `task_complete` from chaos (pass) → mark stage complete
6. Check for stale locks, reap expired claims

### 4.3 Parallelism Within the Pipeline

While the pipeline is *sequential per feature*, the orchestrator can run **multiple features in parallel**:

```
Feature 1: [Code] → [Test] → [Fuzz] → ✓
Feature 2:          [Code] → [Test] → [Fuzz] → ✓
Feature 3:                   [Code] → [Test] → ...
```

Code Writer starts Feature 2 as soon as Feature 1 enters testing. This maximizes all 3 clones' utilization.

---

## 5. New Broadcast Event Types Required

Add to `BroadcastEventTypeSchema` in `packages/manta-bus/src/schema.ts`:

| Event type | Emitter | Payload | Purpose |
|---|---|---|---|
| `code_ready` | Code Writer | `{ commit_ref, feature_id, files_changed: string[] }` | Signal implementation complete |
| `tests_ready` | Test Writer | `{ commit_ref, feature_id, test_files: string[], pass: boolean, coverage?: number }` | Signal tests written and run |
| `fuzz_complete` | Chaos Fuzzer | `{ commit_ref, feature_id, fuzz_files: string[], mutation_score?: number, violations: object[] }` | Signal fuzz/property tests complete |
| `fix_requested` | Orchestrator (via broadcast) | `{ feature_id, failures: object[], cycle: number }` | Request code fix from writer |

Alternatively, reuse existing generic types: `task_complete` (with structured payload) + `blocker` (for failures). This avoids schema changes but loses type safety on payloads.

**Recommendation:** Reuse `task_complete` and `blocker` for Phase 6 MVP. Add typed event types in a follow-up if the generic approach proves error-prone.

---

## 6. Skill Text Per Role

### 6.1 Code Writer Skill (`manta-test-storm-coder`)

```
You are the Code Writer in a test-storm. Your job:
1. Implement features described in work items
2. Lock source files before editing: manta.lock({ path: "src/<feature>/..." })
3. Commit on the shared branch after implementation
4. Acquire GIT_OPERATIONS lock before any git command
5. Broadcast task_complete with commit ref and changed files list
6. Go IDLE and wait for next work item

You do NOT write tests. Test Writer handles that.
If you receive a fix-request: read the failure details, fix the code, commit, broadcast.
Max 3 fix cycles per feature — after that, escalate via blocker broadcast.
```

### 6.2 Test Writer Skill (`manta-test-storm-tester`)

```
You are the Test Writer in a test-storm. Your job:
1. Wait for work items describing committed code to test
2. Read the implementation files (do NOT modify source files)
3. Lock test files before writing: manta.lock({ path: "tests/<feature>/..." })
4. Write comprehensive tests (unit + integration)
5. Run tests via project test runner
6. Commit tests, acquire GIT_OPERATIONS lock for git operations
7. Broadcast task_complete with pass/fail status and coverage
8. If tests fail: broadcast blocker with structured failure details

You do NOT fix implementation bugs. Failures go back to Code Writer.
```

### 6.3 Chaos Fuzzer Skill (`manta-test-storm-chaos`)

```
You are the Chaos Fuzzer in a test-storm. Your job:
1. Wait for work items after both code and tests are committed
2. Read implementation AND test files
3. Write property-based tests (fast-check) for exported functions
4. Write boundary/edge-case tests for all parameter types
5. Lock fuzz test files: manta.lock({ path: "tests/<feature>/*.prop.ts" })
6. Run all tests (existing + your new ones)
7. Commit, broadcast task_complete with violations found
8. If mutation testing requested: run Stryker, report mutation score

Do NOT modify implementation or existing test files.
Focus: find what the test writer missed.
```

---

## 7. Interaction with Existing Daemon Infrastructure

| Component | Test-Storm Usage | Changes Needed |
|---|---|---|
| `daemon-loop.ts` | Each clone runs its own daemon loop, polling role-specific work items | None — works as-is |
| `tick-loop.ts` | Orchestrator tick drives pipeline stage transitions | Needs pipeline stage manager in orchestrator cycle |
| `WorkQueueStore` | Orchestrator enqueues targeted work per role; clones dequeue | None — works as-is |
| `LocksStore` | File-level locks per role + `GIT_OPERATIONS` meta-lock | None — convention only, existing API sufficient |
| `ClaimsStore` | Not needed for primary flow (work queue handles claiming) | None |
| Broadcast system | Status signals between clones, read by orchestrator | Need new event types OR reuse existing with structured payloads |
| Lifecycle handlers | Standard WORKING/IDLE transitions; WAITING_FOR_TASK when pipeline stalls | None |
| `manta-daemon-idle` skill | Loaded between work items | None — works as-is |
| Death detection | `heartbeatTimeoutMs` applies; `max_restarts: 2` per spec | None |

---

## 8. Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Uncommitted file overwrites in shared worktree | High | GIT_OPERATIONS lock + file locks + PreToolUse hook enforcement |
| Clone writes to wrong path (e.g., test writer edits source) | Medium | PreToolUse hook checks lock ownership before Edit/Write |
| Pipeline deadlock (code writer waiting for test results that never come) | Medium | Orchestrator timeout per stage; escalate after `stageTimeoutMs` |
| Git merge conflicts despite locks | Low | Single branch + serialized commits = no merge needed; conflicts only if clone writes outside locked paths |
| Budget exhaustion mid-pipeline | Medium | Orchestrator checks budget before enqueueing each stage; skip chaos tier if budget tight |
| Stryker mutation testing too slow | Low | Tier 3 is optional; budget-gated; can be skipped entirely in Phase 6 MVP |

---

## 9. Phase 6 Implementation Scope

### MVP (must-have)

1. Shared worktree creation for test-storm casts (new spawner logic)
2. `GIT_OPERATIONS` virtual lock convention + PreToolUse hook
3. Pipeline stage manager in orchestrator (TestStormPipelineStage)
4. 3 role-specific skills (coder, tester, chaos)
5. Orchestrator dispatch for test-storm mode in `cast.ts`
6. Reuse `task_complete` + `blocker` broadcasts with structured payloads

### Post-MVP (nice-to-have)

7. Typed broadcast event types (`code_ready`, `tests_ready`, `fuzz_complete`)
8. Stryker mutation testing integration (Tier 3)
9. Automatic coverage threshold enforcement
10. Feature parallelism (pipeline overlap for multiple features)
11. Shared worktree → stacked branches automatic fallback

---

## 10. Open Questions for Main

1. **Shared worktree creation:** Should `manta cast test-storm` create ONE worktree for all 3 clones, or should the orchestrator create it after cast setup? Current spawner creates per-clone worktrees.
2. **PreToolUse hook scope:** Should the git-operations lock check be a cast-level hook (injected into clone settings) or a global hook (always active, checks mode)?
3. **Chaos clone tooling:** Should `fast-check` be a project dependency or should the chaos clone install it as needed? Pre-installing avoids npm install mid-cast.
4. **Feature granularity:** Who decides what constitutes a "feature unit" for the pipeline? Main provides a list? Or code writer decomposes a large task into feature units autonomously?

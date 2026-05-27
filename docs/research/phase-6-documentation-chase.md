# Phase 6 Research: documentation-chase Mode

**Clone:** C  
**Cast:** cast-1779903737920  
**Date:** 2026-05-27  
**Status:** Research complete

## Executive Summary

`documentation-chase` is a daemon-mode (Wave 2) single-clone mode where a doc-clone generates documentation **concurrently** with main's normal work. Charge cost: 1. Spec Sec 2 #7: "Клон пишет доку для уже написанного кода в фоне, пока мейн кодит дальше."

This research answers 6 design questions and maps the combo-mode concept from spec, producing concrete recommendations grounded in the existing daemon infrastructure (daemon-loop.ts, tick-loop.ts, WorkQueueStore, lifecycle tools, lock/broadcast systems).

**Key finding:** documentation-chase is the simplest daemon mode because it has zero inter-clone write coordination — the doc-clone writes to `docs/` while main writes to `packages/`. The primary challenge is **stale reads** (main changes code while doc-clone is reading it) and **combo-mode orchestration** (running doc-chase alongside another cast).

---

## 1. How to Avoid Write Conflicts on Shared Repo Files

### Problem
Doc-clone runs CONCURRENTLY with main. Both operate on the same repository. If doc-clone writes JSDoc inline in source files while main edits those same files → merge conflict guaranteed.

### Recommendation: Separate Output Directory + Own Worktree

**Primary strategy: own worktree, docs-only output.**

```
main worktree:     /Users/timur/projectos/manta/          (main edits packages/)
doc-clone worktree: /Users/timur/projectos/manta/.manta/worktrees/clone-DOC/  (reads packages/, writes docs/)
```

**Why own worktree, not shared:**

1. **Existing infrastructure already creates per-clone worktrees** — `clone-spawner.ts` calls `addWorktree()` for every clone. No new code needed.
2. **Eliminates all write conflicts by construction.** Doc-clone's `allowedPaths` is `["docs/"]`, main's active work is in `packages/`. Even if main occasionally edits `docs/`, the paths won't overlap because doc-clone writes to a dedicated subdirectory (`docs/generated/` or `docs/arch/`).
3. **Bus file locks are unnecessary** for this mode. Lock system (locks.ts) is designed for shared-worktree modes like test-storm. Documentation-chase doesn't need it — path-level separation is sufficient.
4. **Merge is trivial.** When doc-clone commits to its worktree branch, main pulls with `git merge` — docs-only changes merge cleanly against source-only changes. The existing post-cast merge ceremony handles this.

**Scope contract for doc-clone task contract:**
```typescript
scope: {
  allowedPaths: ['docs/generated/', 'docs/arch/', 'docs/api/'],
  forbiddenPaths: ['.manta/state', 'secrets/', 'packages/'],  // read packages/, never write
  maxFilesChanged: 20  // generous for doc generation
}
```

**What about JSDoc inline?** Don't do it in documentation-chase mode. Inline JSDoc modifies source files → guaranteed conflict with main's active work. If JSDoc is desired, use a separate `jsdoc-sweep` task after main pauses (a refactor-wave variant), not concurrent documentation-chase.

### Alternative considered: shared worktree with file locks

Rejected. The lock system works at path granularity (locks.ts:15-20 `LockLease.path`), but doc-clone would need to lock entire directories it's documenting while reading. Main would be blocked from editing those files. This defeats the "background" nature of the mode.

---

## 2. Stale-Read Problem

### Problem
Doc-clone reads `packages/manta-bus/src/state/registry.ts` at T=0, spends 60s writing documentation, but main refactored that file at T=30. Doc-clone's output describes stale code.

### Assessment: Acceptable with Mitigations

**Why this is less severe than it sounds:**

1. **Documentation is inherently slightly stale.** Even human-written docs describe code "as of last review." A 2-5 minute staleness window is normal and acceptable.
2. **Doc-clone operates on committed code, not WIP.** In own-worktree mode, the doc-clone's worktree is branched from a specific commit. Main's uncommitted edits don't appear. Main's new commits don't automatically propagate.
3. **Staleness is bounded by task granularity.** Each work-queue item is "document module X." If the doc-clone finishes a module before main changes it, there's no stale-read.

### Mitigation strategy: commit-triggered refresh

```
┌─────────────┐     git merge main     ┌──────────────┐
│ Doc-clone   │ ←─────────────────────  │   Main       │
│ worktree    │   (between tasks only)  │   worktree   │
│             │                         │              │
│ reads packages/  writes docs/         │ writes packages/
└─────────────┘                         └──────────────┘
```

**Between work items (IDLE state), orchestrator can:**
1. `git merge main` into doc-clone's worktree branch (fast-forward if no doc changes pending)
2. This refreshes the doc-clone's view of source code before the next documentation task
3. If merge conflicts (unlikely with path separation), skip the merge and continue with stale view

**Implementation in daemon-loop.ts:**
```typescript
// In onCycleComplete callback:
onCycleComplete: async (item) => {
  // Refresh doc-clone's view of main's code before next task
  await execa('git', ['merge', 'main', '--ff-only'], { cwd: worktree });
  // If ff-only fails (divergent), fall through — stale is ok
}
```

**Alternative: git pull on each task start.** The doc-clone itself could `git pull origin main` before starting each documentation task. This is simpler but puts git operations inside the clone's context (more tokens, more failure modes). Better to keep it in the orchestrator.

### Hard stale-read scenario: main deletes a module

If main deletes `packages/manta-bus/src/state/locks.ts` while doc-clone is documenting it → doc-clone produces documentation for deleted code. **Mitigation:** This is caught at review time. Main reviews doc PRs and rejects stale ones. Cost: one wasted doc generation cycle (~$0.10-0.30). Acceptable for charge-cost-1 mode.

---

## 3. Topic Extraction — How Does the Clone Decide What to Document?

### Recommendation: Main provides explicit task list via work queue

**Primary approach: work-queue driven documentation tasks.**

The orchestrator (or main) enqueues specific documentation tasks:
```typescript
await workQueue.enqueue({
  cast_id: castId,
  target_clone_id: 'DOC',
  prompt: 'Document the public API of packages/manta-bus/src/state/registry.ts. Include: class purpose, method signatures, state machine transitions, error conditions.',
  priority: 'normal',
});
```

**Why explicit over auto-discovery:**

1. **Main knows what matters.** Auto-scanning for undocumented exports generates docs for internal helpers nobody cares about. Main prioritizes based on what users/developers actually need.
2. **Task granularity is controllable.** "Document the registry module" is a well-scoped task. "Find everything undocumented" is unbounded and burns tokens on low-value output.
3. **Existing work-queue infrastructure handles this perfectly.** `WorkQueueStore.enqueue()` + `daemon-loop.ts` polling = doc-clone picks up tasks in priority order, completes them, goes IDLE, picks up next.

### Secondary approach: auto-discovery mode (future enhancement)

For cases where main is too busy to curate a doc list, a future enhancement could add an auto-discovery task:

```typescript
prompt: 'Scan packages/ for exported functions/classes without JSDoc or corresponding docs/api/ entries. Enqueue documentation tasks for the top 10 most-imported undocumented exports.'
```

This makes the doc-clone self-feeding: it generates its own task backlog. But this requires the doc-clone to call `manta.enqueue_work` targeting itself — which the work.ts handler supports (no validation that target_clone_id != caller). **Defer to Phase 6 implementation; start with explicit task list.**

### Task templates for common documentation types

| Template | Prompt pattern | Output path |
|---|---|---|
| API reference | "Document public API of `<file>`. Include class purpose, method signatures, parameters, return types, errors." | `docs/api/<package>/<module>.md` |
| Architecture note | "Write architecture overview of `<package>`. Include data flow, key abstractions, extension points." | `docs/arch/<package>.md` |
| README section | "Update `<package>/README.md` with current API surface, usage examples, and gotchas." | `<package>/README.md` |
| Changelog entry | "Summarize changes in `<package>` since commit `<hash>`. Highlight breaking changes." | `docs/changelog/<package>.md` |

---

## 4. Output Format

### Recommendation: Separate markdown files, not inline JSDoc

**Rationale:**

1. **No source-file modification** — eliminates write conflict risk entirely (see Q1)
2. **Doc-clone's allowedPaths excludes packages/** — enforced by scope contract, not by discipline
3. **Markdown is reviewable** — main can read, approve, or reject doc PRs without touching code
4. **Scalable** — 20 markdown files per documentation-chase session is reasonable; 20 inline JSDoc modifications to source files is a merge nightmare

**Output structure:**
```
docs/
├── api/                    # Auto-generated API references
│   ├── manta-bus/
│   │   ├── registry.md
│   │   ├── events.md
│   │   └── locks.md
│   ├── manta-cli/
│   │   ├── cast.md
│   │   └── daemon-loop.md
│   └── manta-orchestrator/
│       └── merge-review.md
├── arch/                   # Architecture overviews
│   ├── bus-state-machine.md
│   └── daemon-lifecycle.md
├── generated/              # Machine-generated, may be overwritten
│   └── exports-index.md
└── research/               # Human-curated (existing)
    └── ...
```

**Format per file:**
```markdown
# <Module Name> — API Reference

> Auto-generated by documentation-chase clone. Cast: <cast-id>, Date: <date>.
> Source: <source-file-path> at commit <short-hash>.

## Overview
<1-2 paragraph module purpose>

## Public API

### `ClassName`
<class purpose>

#### `methodName(params): ReturnType`
<method description>
- **Parameters:** ...
- **Returns:** ...
- **Throws:** ...
- **Example:** ...
```

The `> Source: ... at commit <hash>` header lets reviewers check staleness. If the source file's HEAD is ahead of the documented commit, the doc is stale.

---

## 5. How Does Main Review/Approve Doc Output? (Combo Mode)

### Problem
In combo mode (`recon-swarm` + `documentation-chase`), main is actively running another cast while doc-clone works in background. Main can't review doc PRs in real-time.

### Recommendation: Async batch review at cast boundaries

**Protocol:**

```
┌─────────────┐                         ┌──────────────┐
│ Main        │   enqueue doc tasks      │  Doc-clone   │
│ (running    │ ──────────────────────► │  (daemon)    │
│  recon-     │                         │              │
│  swarm)     │   broadcast: docs_ready │              │
│             │ ◄────────────────────── │  writes docs │
│             │                         │  goes IDLE   │
│             │   (main ignores until   │              │
│             │    primary cast done)   │              │
└─────────────┘                         └──────────────┘

After primary cast completes:
  Main reads docs_ready broadcasts
  Main reviews doc commits on doc-clone branch
  Main merges or requests rework via manta.retask
```

**Interaction with existing broadcast system:**

Doc-clone uses `manta.broadcast()` with `event_type: 'docs_ready'`:
```typescript
await manta.broadcast({
  clone_id: 'DOC',
  event_type: 'breakthrough',  // uses existing event_type enum
  payload: {
    type: 'docs_ready',
    files: ['docs/api/manta-bus/registry.md', 'docs/arch/bus-state-machine.md'],
    commit: '<short-hash>',
    summary: 'Documented registry module: 3 classes, 12 methods'
  }
});
```

**Why `breakthrough` event_type:** The broadcast schema (communication.ts:21-33) uses `BroadcastInputSchema` which has an `event_type` field. Looking at existing usage patterns, `breakthrough` is the closest semantic match — doc completion is a deliverable signal, not a blocker or dependency.

### Combo mode orchestration

**Spec (Sec 2 Метарежимы):** `combo` = several modes simultaneously. Charge cost = sum.

**How combo works with documentation-chase:**

1. Main starts primary cast (e.g., `manta cast recon-swarm --task "research X"`)
2. Main also starts doc-chase: `manta cast documentation-chase --task "document modules A,B,C"`
3. Both casts run concurrently. Each has its own:
   - Clone(s) in separate worktree(s)
   - Cast manifest
   - Budget allocation
4. Doc-chase clone(s) are daemon-mode; recon-swarm clones are batch-mode
5. Orchestrator tick-loop manages both simultaneously (already supports multiple active clones in registry)
6. When recon-swarm finishes, main reviews those results first (higher priority)
7. Then reviews doc-chase output at leisure

**No new orchestrator code needed for combo** — the tick-loop already iterates over all registered clones regardless of cast. Two concurrent casts just mean more clones in the registry. Budget tracking is per-cast (CastsStore has cast-level budget). The only new code is in `cast.ts` to accept `combo` as a meta-mode that spawns multiple sub-casts.

### Review workflow detail

When main is ready to review doc output:

1. `manta.read_broadcasts({ clone_id: "main", cast_id: "<doc-cast-id>" })` — see all `docs_ready` events
2. `git log <doc-branch> --oneline` — see what the doc-clone committed
3. `git diff main..<doc-branch>` — review the actual doc changes
4. If acceptable: `git merge <doc-branch>` into main
5. If needs rework: `manta.retask({ clone_id: "DOC", new_task: "Rework docs/api/registry.md: add error handling section, fix stale method signature for markDead" })`

This uses the existing `retask` lifecycle handler (lifecycle.ts:102-123) which transitions the clone from IDLE → WORKING with a new task description.

---

## 6. Daemon Lifecycle for Documentation-Chase

### Recommended Lifecycle

```
                    ┌─────────────┐
                    │  STARTING   │  (spawner registers, clone boots)
                    └──────┬──────┘
                           │ heartbeat(WORKING)
                           ▼
                    ┌─────────────┐
          ┌────────│  WORKING    │◄───────────────┐
          │        └──────┬──────┘                │
          │               │ task complete          │ retask (new doc task)
          │               │ heartbeat(IDLE)        │ OR work-queue item
          │               ▼                       │
          │        ┌─────────────┐                │
          │        │    IDLE     │────────────────┘
          │        └──────┬──────┘
          │               │ no more tasks + idle_timeout
          │               │ OR main sends stop
          │               ▼
          │        ┌──────────────┐
          │        │ WINDING_DOWN │  (suicide_intent)
          │        └──────┬───────┘
          │               │ report_death
          │               ▼
          │        ┌─────────────┐
          └───────►│    DEAD     │  (crash → death_detector)
                   └─────────────┘
```

**This matches the existing DAEMON_MODE_BLOCK in priming.ts (lines 46-62):**
- After completing a task: `heartbeat(IDLE)` + `request_task()`
- Orchestrator resumes session with next work item via `retask`
- Only call `manta-graceful-death` at session end

### Task delivery mechanism: WorkQueueStore (primary) + retask (secondary)

**Two paths for delivering work to the doc-clone:**

**Path A — Work Queue (recommended for batch doc tasks):**
1. Main/orchestrator pre-populates work queue: `workQueue.enqueue({ target_clone_id: 'DOC', prompt: 'Document X', priority: 'normal' })`
2. `daemon-loop.ts` polls `workQueue.dequeue('DOC')` → finds item → runs `claude --resume` with the prompt
3. Doc-clone completes → `workQueue.complete(item.id)` → `onCycleComplete` fires → orchestrator can merge main
4. `daemon-loop.ts` polls again → next item or empty

This is **exactly how daemon-loop.ts already works** (lines 38-88). No new code needed for the polling mechanism.

**Path B — Retask (for ad-hoc doc requests mid-session):**
1. Main decides "I just wrote a new module, doc-clone should document it"
2. Main calls `manta.retask({ clone_id: 'DOC', new_task: 'Document the new module at packages/manta-cli/src/foo.ts' })`
3. Registry transitions DOC from IDLE → WORKING
4. Orchestrator's daemon-loop detects state change, resumes session with new prompt

**Path A vs Path B:** Use Path A for planned doc batches (the normal case). Use Path B for reactive "doc this new thing" requests. Both are supported by existing infrastructure.

### Idle timeout and graceful shutdown

**Configuration:**
```typescript
interface DocChaseConfig {
  maxIdleMs: 300_000;        // 5 min idle before auto-shutdown
  maxEmptyPolls: 10;         // daemon-loop.ts param: exit after 10 empty polls
  pollIntervalMs: 30_000;    // check for new work every 30s
  maxResumeFailures: 3;      // restartable (per phase-5-daemon-architecture.md)
  maxTasksPerSession: 20;    // hard cap to prevent runaway token usage
}
```

**Shutdown triggers:**
1. `maxEmptyPolls` reached → `daemon-loop.ts` returns `{ exitReason: 'no_work' }` → orchestrator marks clone DEAD
2. Main sends `manta daemon stop` → `daemon.ts:runDaemonStopCommand()` marks all daemon clones DEAD
3. Idle timeout (doc-clone in IDLE for > `maxIdleMs`) → orchestrator's `staleSince()` detects and kills
4. Budget exhausted → orchestrator checks per-cast budget, sends shutdown signal
5. Main explicitly retasks with "shutdown" → doc-clone follows `manta-graceful-death` sequence

### Priming text for documentation-chase clone

The existing `DAEMON_MODE_BLOCK` in priming.ts (lines 46-62) covers the generic daemon lifecycle. Documentation-chase needs an additional mode-specific block:

```typescript
const DOC_CHASE_BLOCK = `
## Documentation-Chase Protocol
You are a documentation clone. Your job: read source code and produce clear, accurate documentation.

OUTPUT RULES:
1. Write ONLY to docs/ subdirectories (docs/api/, docs/arch/, docs/generated/)
2. NEVER modify source files in packages/ — your scope forbids it
3. Each doc file starts with: "> Auto-generated by documentation-chase clone. Cast: <cast-id>, Date: <date>. Source: <file> at commit <hash>."
4. After completing each doc task, broadcast docs_ready with file list
5. Focus on accuracy over completeness — a correct partial doc beats a complete wrong doc

WHAT TO DOCUMENT:
- Public exports: classes, functions, types, interfaces
- State machines and lifecycle transitions
- Error conditions and edge cases
- Usage examples from test files (read tests to find realistic usage patterns)
- Cross-module dependencies and data flow

WHAT NOT TO DOCUMENT:
- Internal implementation details that change frequently
- Test helpers and fixtures
- Build configuration
`;
```

This block would be injected in `buildPrimingText()` alongside the existing `DAEMON_MODE_BLOCK` when `mode === 'documentation-chase'`.

---

## 7. Infrastructure Map: What Exists vs What's Needed

### Already built (Phase 5 infrastructure, ready to use)

| Component | File | Role for doc-chase |
|---|---|---|
| `daemon-loop.ts` | `manta-cli/src/daemon-loop.ts` | Core poll-dequeue-resume loop. No changes needed. |
| `tick-loop.ts` | `manta-cli/src/tick-loop.ts` | Orchestrator cycle runner. No changes needed. |
| `WorkQueueStore` | `manta-bus/src/state/work-queue.ts` | Task delivery. Enqueue doc tasks, clone dequeues. No changes. |
| `work.ts` handlers | `manta-bus/src/tools/work.ts` | MCP handlers for enqueue/claim/release. No changes. |
| `lifecycle.ts` handlers | `manta-bus/src/tools/lifecycle.ts` | heartbeat, retask, requestTask, suicideIntent, reportDeath. No changes. |
| `communication.ts` | `manta-bus/src/tools/communication.ts` | broadcast(docs_ready), readBroadcasts, feedback. No changes. |
| `LocksStore` | `manta-bus/src/state/locks.ts` | NOT needed for doc-chase (path separation). |
| `ClaimsStore` | `manta-bus/src/state/claims.ts` | NOT needed (no shared work items). |
| `Registry` | `manta-bus/src/state/registry.ts` | Clone lifecycle tracking. IDLE/retask support already built (lines 92-206). |
| `priming.ts` | `manta-cli/src/spawner/priming.ts` | DAEMON_MODE_BLOCK exists. Needs DOC_CHASE_BLOCK addition. |
| `cast.ts` | `manta-cli/src/commands/cast.ts` | `documentation-chase` already in SUPPORTED_MODES and DAEMON_MODES. |
| `daemon.ts` | `manta-cli/src/commands/daemon.ts` | `daemon status` and `daemon stop` commands. Work as-is. |
| `clone-spawner.ts` | `manta-cli/src/spawner/clone-spawner.ts` | Worktree creation, snapshot, spawn. No changes. |

### New code needed (Phase 6 implementation)

| Component | Estimated LOC | Description |
|---|---|---|
| `DOC_CHASE_BLOCK` in priming.ts | ~20 | Mode-specific priming text |
| Doc-chase dispatch in cast.ts | ~30 | Work-queue pre-population logic: parse task into individual doc items |
| `docs/` output path conventions | ~10 | Config/constants for doc output directory structure |
| Doc task builder | ~40 | Parse "document modules A,B,C" into individual work-queue items |
| Between-task git merge (optional) | ~15 | `onCycleComplete` hook to refresh doc-clone's view of main |
| Combo mode meta-dispatch | ~50 | `cast.ts` handling for `combo` mode that spawns multiple sub-casts |
| Tests | ~100 | daemon-loop integration, priming block, task builder |
| **Total** | **~265** | |

---

## 8. Combo Mode Design

### Spec reference
Sec 2 Метарежимы: `combo` — несколько режимов одновременно (`recon-swarm` + `documentation-chase` параллельно). Charge cost = sum.

### How combo mode works architecturally

```
manta cast combo \
  --modes "recon-swarm,documentation-chase" \
  --task-recon "Research X" \
  --task-doc "Document modules A,B,C" \
  --clones 3  # 2 for recon + 1 for doc
```

**Under the hood:**

1. `cast.ts` parses `combo` mode, splits into constituent modes
2. Creates **separate cast manifests** for each sub-mode (separate cast_ids)
3. Spawns clones per sub-mode:
   - Clones A, B: recon-swarm (batch mode, own worktrees)
   - Clone DOC: documentation-chase (daemon mode, own worktree)
4. Each sub-cast has its own budget allocation (sum of individual costs)
5. Tick-loop manages all clones uniformly — no special combo logic needed
6. Sub-casts finish independently. Recon finishes first (batch), doc continues (daemon)
7. Main reviews recon results, then doc results when doc-clone goes IDLE or finishes

**Key insight: combo mode is NOT a new orchestration pattern.** It's just "run two casts simultaneously." The existing infrastructure already supports this — nothing prevents main from calling `runCastCommand()` twice with different modes. Combo mode is syntactic sugar + budget tracking.

### Budget for combo
```
combo cost = sum(constituent mode costs)
           = recon-swarm(1) + documentation-chase(1) = 2 charges
```

---

## 9. Open Questions for Implementation

1. **Auto-git-merge frequency.** Should the orchestrator merge main into doc-clone's worktree on every task completion, or only at the start of each new task? Recommendation: on task start (avoids mid-task disruption).

2. **Doc review UX.** How does `manta status` surface pending doc reviews? Suggested: add a `pending_doc_reviews` field to status output when doc-chase cast has `docs_ready` broadcasts.

3. **Doc staleness threshold.** If doc-clone's worktree is >N commits behind main, should it auto-refresh? Suggested: yes, if >10 commits behind, force merge before next task.

4. **Combo mode CLI syntax.** Should `combo` be a first-class mode or composed from multiple `manta cast` calls? Recommended: start with manual composition (two separate `manta cast` calls), add `combo` sugar later.

5. **Doc-clone tool restrictions.** Per phase-5-daemon-cli-capabilities.md:361, documentation-chase could restrict tools to `Read, Write, Grep, Glob + MCP tools` (no Edit, no Bash). This prevents accidental source modifications. But `--allowedTools` must be passed on every resume invocation.

---

## 10. Recommendations Summary

| Decision | Recommendation | Rationale |
|---|---|---|
| Worktree model | Own worktree (not shared) | Eliminates write conflicts by construction |
| Output format | Separate markdown in docs/ | No source modification, reviewable, merge-safe |
| Inline JSDoc | No (separate mode/task) | Source modification = conflict with main |
| Task delivery | WorkQueueStore (primary) | Existing daemon-loop already polls it |
| Topic selection | Main provides explicit list | Higher quality, controllable scope |
| Stale-read mitigation | Git merge between tasks | Bounded staleness, minimal overhead |
| Review workflow | Async at cast boundaries | Main reviews when primary cast finishes |
| Daemon lifecycle | Standard DAEMON_MODE_BLOCK + DOC_CHASE_BLOCK | Matches existing priming infrastructure |
| Combo mode | Syntactic sugar over two casts | No new orchestration needed |
| File locks | Not needed | Path separation is sufficient |
| Max restarts | 3 (per phase-5-daemon-architecture) | Context accumulates, restart is cheap |

### Implementation priority for Phase 6

1. **DOC_CHASE_BLOCK** in priming.ts — smallest change, highest impact
2. **Doc task builder** — parses "document A,B,C" into work-queue items
3. **onCycleComplete git merge** — stale-read mitigation
4. **Combo mode dispatch** — enables running alongside other casts
5. **Tests** — daemon integration, priming, task builder

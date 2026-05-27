# Phase 6 — Wave-2 Modes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all three Wave-2 daemon modes: `pair-programming`, `test-storm`, and `documentation-chase` — each with mode-specific dispatch logic, role-specific skills, and priming text.

**Architecture:** Each Wave-2 mode reuses the Phase 5 daemon infrastructure (daemon-loop.ts, tick-loop.ts, WorkQueueStore, lifecycle tools). New code is primarily **dispatch logic** — per-mode state machines that read broadcasts/idle states from the orchestrator cycle and enqueue targeted work items for each clone role. A shared `dispatch/` directory in `@manta/cli` holds one dispatcher per mode. tick-loop.ts gains an `onCycleComplete` callback hook for dispatchers.

**Tech Stack:** TypeScript, Zod schemas, Vitest, `@manta/bus` MCP tools, `@manta/cli` commands, `@manta/orchestrator` CycleResult

**Research:** `docs/research/phase-6-pair-programming.md`, `docs/research/phase-6-test-storm.md`, `docs/research/phase-6-documentation-chase.md`

---

## Chunk 1: Shared Dispatch Infra + pair-programming + documentation-chase

These two modes are simpler (separate worktrees, no shared-worktree lock complexity) and share the dispatch infra. ~900 LOC estimated.

**Build dependency chain:** Task 1.2 (schema) + Task 1.3 (schema) → `pnpm -r build` → Task 1.4+ (code consuming new types). Schema-first per CLAUDE.md hard rule.

### Task 1.1: tick-loop `onCycleComplete` callback

**Files:**
- Modify: `packages/manta-cli/src/tick-loop.ts`
- Modify: `packages/manta-cli/tests/tick-loop.test.ts`

The tick-loop needs a hook so dispatchers can react to each orchestrator cycle.

- [ ] **Step 1: Write failing test for onCycleComplete**

Add to `tick-loop.test.ts`:

```typescript
it('calls onCycleComplete after each orchestrator cycle', async () => {
  let cycleCount = 0;
  const onCycleComplete = vi.fn();
  const orch = fakeOrchestrator({ cycleResults: [baseCycleResult, baseCycleResult] });
  await runTickLoop({
    orchestrator: orch,
    intervalMs: 10,
    allDone: async () => { cycleCount++; return cycleCount >= 2; },
    onCycleComplete,
  });
  expect(onCycleComplete).toHaveBeenCalledTimes(2);
  expect(onCycleComplete).toHaveBeenCalledWith(expect.objectContaining({ ranAt: expect.any(Number) }));
});
```

- [ ] **Step 2: Run test — verify FAIL** (onCycleComplete not in interface)

Run: `cd packages/manta-cli && pnpm vitest run tests/tick-loop.test.ts`

- [ ] **Step 3: Add `onCycleComplete` to `RunTickLoopOptions`**

In `tick-loop.ts`:

```typescript
export interface RunTickLoopOptions {
  orchestrator: Orchestrator;
  intervalMs: number;
  allDone: () => Promise<boolean>;
  signal?: AbortSignal;
  daemonMode?: boolean;
  onCycleComplete?: (result: CycleResult) => Promise<void>;
}
```

Import `CycleResult` from `@manta/orchestrator`. Call it after `runCycle()`:

```typescript
const result = await opts.orchestrator.runCycle();
if (opts.onCycleComplete) {
  await opts.onCycleComplete(result);
}
cycles += 1;
```

- [ ] **Step 4: Run test — verify PASS**

Run: `cd packages/manta-cli && pnpm vitest run tests/tick-loop.test.ts`

- [ ] **Step 5: Commit**

```
feat(cli): add onCycleComplete callback to tick-loop for Wave-2 dispatch
```

---

### Task 1.2: BroadcastEventTypeSchema — add Wave-2 event types

**Files:**
- Modify: `packages/manta-bus/src/schema.ts`
- Modify: `packages/manta-bus/tests/schema.test.ts` (or wherever broadcast schema is tested)

- [ ] **Step 1: Write failing test**

```typescript
it('accepts Wave-2 broadcast event types', () => {
  for (const t of ['commit_ready', 'review_complete', 'writer_stuck', 'code_ready', 'tests_ready', 'fuzz_complete', 'docs_ready']) {
    expect(BroadcastEventTypeSchema.parse(t)).toBe(t);
  }
});
```

- [ ] **Step 2: Run test — verify FAIL**

- [ ] **Step 3: Widen `BroadcastEventTypeSchema`**

In `schema.ts` line 154:

```typescript
export const BroadcastEventTypeSchema = z.enum([
  'breakthrough', 'blocker', 'dependency', 'self_certainty',
  'task_complete', 'idle', 'feedback_received',
  // Wave-2: pair-programming
  'commit_ready', 'review_complete', 'writer_stuck',
  // Wave-2: test-storm
  'code_ready', 'tests_ready', 'fuzz_complete',
  // Wave-2: documentation-chase
  'docs_ready',
]);
```

- [ ] **Step 4: Run test — verify PASS**

- [ ] **Step 5: Build workspace** — `pnpm -r build` to ensure downstream packages pick up new types.

- [ ] **Step 6: Commit**

```
feat(bus): add Wave-2 broadcast event types for pair/storm/doc modes
```

---

### Task 1.3: CloneAssignment `role` field

**Files:**
- Modify: `packages/manta-bus/src/schema.ts` — `CloneAssignmentSchema`
- Modify: `packages/manta-bus/tests/` — relevant schema tests

The dispatch logic needs to know which clone plays which role without parsing `approach_hint` strings.

- [ ] **Step 1: Write failing test**

```typescript
it('accepts optional role field on CloneAssignment', () => {
  const result = CloneAssignmentSchema.parse({
    task: 'implement feature X',
    approach_hint: 'writer',
    role: 'writer',
  });
  expect(result.role).toBe('writer');
});

it('accepts CloneAssignment without role', () => {
  const result = CloneAssignmentSchema.parse({
    task: 'implement feature X',
  });
  expect(result.role).toBeUndefined();
});
```

- [ ] **Step 2: Run test — verify FAIL**

- [ ] **Step 3: Add `role` to `CloneAssignmentSchema`**

Find `CloneAssignmentSchema` in `schema.ts` and add:

```typescript
role: z.enum([
  'writer', 'reviewer',                     // pair-programming
  'coder', 'tester', 'fuzzer',              // test-storm
  'documenter',                             // documentation-chase
]).optional(),
```

- [ ] **Step 4: Run tests — verify PASS** and `pnpm -r build`

- [ ] **Step 5: Commit**

```
feat(bus): add optional role field to CloneAssignmentSchema for Wave-2 dispatch
```

---

### Task 1.3b: Shared dispatch types

**Files:**
- Create: `packages/manta-cli/src/dispatch/types.ts`

Shared interfaces used by all Wave-2 dispatchers. Extract once, import everywhere.

- [ ] **Step 1: Create shared types file**

```typescript
// packages/manta-cli/src/dispatch/types.ts

export interface DispatchCycleInput {
  idleClones: Array<{ clone_id: string; idle_since: number }>;
  broadcasts: Array<{ clone_id: string; event_type: string; payload: Record<string, unknown> }>;
}

export interface DispatchEnqueuer {
  enqueue: (targetCloneId: string, prompt: string, priority?: 'normal' | 'high') => Promise<void>;
}
```

- [ ] **Step 2: Commit**

```
feat(cli): shared dispatch types for Wave-2 mode dispatchers
```

---

### Task 1.3c: `readRecentBroadcasts` helper with sinceTs tracking

**Files:**
- Create: `packages/manta-cli/src/dispatch/broadcast-reader.ts`
- Create: `packages/manta-cli/tests/dispatch/broadcast-reader.test.ts`

The dispatch loop must avoid re-processing old broadcasts on every tick cycle. Track `lastProcessedTs` and filter events newer than that.

- [ ] **Step 1: Write failing test**

```typescript
import { BroadcastReader } from '../../src/dispatch/broadcast-reader.js';

describe('BroadcastReader', () => {
  it('returns only broadcasts newer than lastProcessedTs', async () => {
    const events = [
      { ts: 100, type: 'broadcast', payload: { cast_id: 'c1', clone_id: 'A', event_type: 'commit_ready', body: {} } },
      { ts: 200, type: 'broadcast', payload: { cast_id: 'c1', clone_id: 'B', event_type: 'review_complete', body: {} } },
    ];
    const reader = new BroadcastReader('c1', { readAll: async () => events });
    const first = await reader.readNew();
    expect(first).toHaveLength(2);
    const second = await reader.readNew();
    expect(second).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Implement BroadcastReader**

```typescript
export class BroadcastReader {
  private lastProcessedTs = 0;

  constructor(
    private readonly castId: string,
    private readonly events: { readAll: () => Promise<Array<{ ts: number; type: string; payload: unknown }>> },
  ) {}

  async readNew(): Promise<Array<{ clone_id: string; event_type: string; payload: Record<string, unknown> }>> {
    const all = await this.events.readAll();
    const fresh = all.filter(
      (e) => e.type === 'broadcast' && e.ts > this.lastProcessedTs &&
        (e.payload as Record<string, unknown>)?.cast_id === this.castId,
    );
    if (fresh.length > 0) {
      this.lastProcessedTs = Math.max(...fresh.map((e) => e.ts));
    }
    return fresh.map((e) => {
      const p = e.payload as Record<string, unknown>;
      return {
        clone_id: String(p.clone_id ?? ''),
        event_type: String(p.event_type ?? ''),
        payload: (p.body as Record<string, unknown>) ?? {},
      };
    });
  }
}
```

- [ ] **Step 3: Run test — verify PASS**

- [ ] **Step 4: Commit**

```
feat(cli): BroadcastReader with sinceTs tracking for dispatch loop
```

---

### Task 1.4: PairDispatcher state machine

**Files:**
- Create: `packages/manta-cli/src/dispatch/pair-dispatch.ts`
- Create: `packages/manta-cli/tests/dispatch/pair-dispatch.test.ts`

Import `DispatchCycleInput` and `DispatchEnqueuer` from `./types.js`.

The core state machine for pair-programming iteration.

- [ ] **Step 1: Write failing tests**

```typescript
import { PairDispatcher, type PairState } from '../../src/dispatch/pair-dispatch.js';

describe('PairDispatcher', () => {
  it('initializes with writer_working phase', () => {
    const d = new PairDispatcher({ writerCloneId: 'A', reviewerCloneId: 'B', castId: 'cast-1', maxIterations: 5 });
    expect(d.state.phase).toBe('writer_working');
    expect(d.state.iteration).toBe(1);
  });

  it('transitions to reviewer_working on commit_ready broadcast', async () => {
    const d = new PairDispatcher({ writerCloneId: 'A', reviewerCloneId: 'B', castId: 'cast-1', maxIterations: 5 });
    const enqueued: Array<{ target: string; prompt: string }> = [];
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'A', idle_since: 100 }],
      broadcasts: [{ clone_id: 'A', event_type: 'commit_ready', payload: { commit_ref: 'abc123', summary: 'impl cache', files_changed: ['src/cache.ts'] } }],
    }, {
      enqueue: async (target, prompt, priority) => { enqueued.push({ target, prompt }); },
    });
    expect(d.state.phase).toBe('reviewer_working');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.target).toBe('B');
    expect(enqueued[0]!.prompt).toContain('abc123');
  });

  it('transitions to done on review_complete with approved verdict', async () => {
    const d = new PairDispatcher({ writerCloneId: 'A', reviewerCloneId: 'B', castId: 'cast-1', maxIterations: 5 });
    d.state.phase = 'reviewer_working';
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{ clone_id: 'B', event_type: 'review_complete', payload: { verdict: 'approved', iteration: 1 } }],
    }, { enqueue: async () => {} });
    expect(d.state.phase).toBe('done');
  });

  it('loops back to writer on changes_requested', async () => {
    const d = new PairDispatcher({ writerCloneId: 'A', reviewerCloneId: 'B', castId: 'cast-1', maxIterations: 5 });
    d.state.phase = 'reviewer_working';
    d.state.iteration = 1;
    const enqueued: Array<{ target: string }> = [];
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{ clone_id: 'B', event_type: 'review_complete', payload: {
        verdict: 'changes_requested', iteration: 1,
        comments: [{ file: 'src/cache.ts', line: 42, severity: 'correction', comment: 'null check' }],
      } }],
    }, { enqueue: async (target) => { enqueued.push({ target }); } });
    expect(d.state.phase).toBe('writer_working');
    expect(d.state.iteration).toBe(2);
    expect(enqueued[0]!.target).toBe('A');
  });

  it('escalates after max iterations', async () => {
    const d = new PairDispatcher({ writerCloneId: 'A', reviewerCloneId: 'B', castId: 'cast-1', maxIterations: 5 });
    d.state.phase = 'reviewer_working';
    d.state.iteration = 5;
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{ clone_id: 'B', event_type: 'review_complete', payload: { verdict: 'changes_requested', iteration: 5 } }],
    }, { enqueue: async () => {} });
    expect(d.state.phase).toBe('escalated');
  });
});
```

- [ ] **Step 2: Run tests — verify FAIL**

- [ ] **Step 3: Implement PairDispatcher**

```typescript
// packages/manta-cli/src/dispatch/pair-dispatch.ts

export interface PairDispatcherConfig {
  writerCloneId: string;
  reviewerCloneId: string;
  castId: string;
  maxIterations: number;
}

export interface PairState {
  phase: 'writer_working' | 'reviewer_working' | 'done' | 'escalated';
  iteration: number;
  lastBroadcastTs: number;
}

export interface DispatchCycleInput {
  idleClones: Array<{ clone_id: string; idle_since: number }>;
  broadcasts: Array<{ clone_id: string; event_type: string; payload: Record<string, unknown> }>;
}

export interface DispatchEnqueuer {
  enqueue: (targetCloneId: string, prompt: string, priority?: 'normal' | 'high') => Promise<void>;
}

export class PairDispatcher {
  state: PairState;

  constructor(private readonly config: PairDispatcherConfig) {
    this.state = { phase: 'writer_working', iteration: 1, lastBroadcastTs: 0 };
  }

  async onCycleComplete(input: DispatchCycleInput, enqueuer: DispatchEnqueuer): Promise<void> {
    if (this.state.phase === 'done' || this.state.phase === 'escalated') return;

    const commitReady = input.broadcasts.find(
      (b) => b.event_type === 'commit_ready' && b.clone_id === this.config.writerCloneId,
    );
    const reviewComplete = input.broadcasts.find(
      (b) => b.event_type === 'review_complete' && b.clone_id === this.config.reviewerCloneId,
    );

    if (this.state.phase === 'writer_working' && commitReady) {
      const p = commitReady.payload as Record<string, unknown>;
      const prompt = buildReviewPrompt({
        commitRef: String(p.commit_ref ?? ''),
        summary: String(p.summary ?? ''),
        filesChanged: (p.files_changed as string[]) ?? [],
        iteration: this.state.iteration,
        castId: this.config.castId,
        writerCloneId: this.config.writerCloneId,
      });
      await enqueuer.enqueue(this.config.reviewerCloneId, prompt);
      this.state.phase = 'reviewer_working';
      return;
    }

    if (this.state.phase === 'reviewer_working' && reviewComplete) {
      const p = reviewComplete.payload as Record<string, unknown>;
      const verdict = String(p.verdict ?? '');

      if (verdict === 'approved') {
        this.state.phase = 'done';
        return;
      }

      if (this.state.iteration >= this.config.maxIterations) {
        this.state.phase = 'escalated';
        return;
      }

      const prompt = buildFixPrompt({
        comments: (p.comments as Array<Record<string, unknown>>) ?? [],
        verdict,
        iteration: this.state.iteration,
      });
      const priority = verdict === 'blocker' ? 'high' as const : 'normal' as const;
      await enqueuer.enqueue(this.config.writerCloneId, prompt, priority);
      this.state.iteration += 1;
      this.state.phase = 'writer_working';
      return;
    }
  }

  get isDone(): boolean {
    return this.state.phase === 'done' || this.state.phase === 'escalated';
  }
}

function buildReviewPrompt(ctx: {
  commitRef: string; summary: string; filesChanged: string[];
  iteration: number; castId: string; writerCloneId: string;
}): string {
  return [
    `Review iteration ${ctx.iteration} from the writer clone (${ctx.writerCloneId}).`,
    `Commit: ${ctx.commitRef}`,
    `Summary: ${ctx.summary}`,
    `Files changed: ${ctx.filesChanged.join(', ')}`,
    '',
    'To review, run:',
    `  git diff main..manta/${ctx.castId}/${ctx.writerCloneId}`,
    '',
    'Check: correctness, edge cases, test coverage, spec compliance.',
    'Run tests if needed. Then broadcast review_complete with your verdict.',
  ].join('\n');
}

function buildFixPrompt(ctx: {
  comments: Array<Record<string, unknown>>; verdict: string; iteration: number;
}): string {
  const lines = [
    `The reviewer returned verdict: ${ctx.verdict} (iteration ${ctx.iteration}).`,
    '',
    'Feedback:',
  ];
  for (const c of ctx.comments) {
    const sev = String(c.severity ?? 'info').toUpperCase();
    lines.push(`- [${sev}] ${c.file ?? '?'}:${c.line ?? '?'} — ${c.comment ?? ''}`);
  }
  lines.push('', 'Apply CORRECTION and BLOCKER fixes. Re-run tests, commit, broadcast commit_ready.');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests — verify PASS**

- [ ] **Step 5: Commit**

```
feat(cli): PairDispatcher state machine for pair-programming mode
```

---

### Task 1.5: DocChaseDispatcher + priming block

**Files:**
- Create: `packages/manta-cli/src/dispatch/doc-chase-dispatch.ts`
- Create: `packages/manta-cli/tests/dispatch/doc-chase-dispatch.test.ts`
- Modify: `packages/manta-cli/src/spawner/priming.ts` — add `DOC_CHASE_BLOCK`

- [ ] **Step 1: Write failing tests for DocChaseDispatcher**

```typescript
import { DocChaseDispatcher } from '../../src/dispatch/doc-chase-dispatch.js';

describe('DocChaseDispatcher', () => {
  it('parses a multi-topic task into individual work items', () => {
    const items = DocChaseDispatcher.parseTaskIntoItems(
      'Document modules: packages/manta-bus/src/state/registry.ts, packages/manta-cli/src/commands/cast.ts',
      'DOC',
      'cast-1',
    );
    expect(items).toHaveLength(2);
    expect(items[0]!.target_clone_id).toBe('DOC');
    expect(items[0]!.prompt).toContain('registry.ts');
    expect(items[1]!.prompt).toContain('cast.ts');
  });

  it('is always done (no iteration logic)', () => {
    const d = new DocChaseDispatcher({ cloneId: 'DOC', castId: 'cast-1' });
    // Doc-chase has no dispatch cycle — work queue pre-populated at cast start
    expect(d.isDone).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — verify FAIL**

- [ ] **Step 3: Implement DocChaseDispatcher**

```typescript
// packages/manta-cli/src/dispatch/doc-chase-dispatch.ts

export interface DocChaseConfig {
  cloneId: string;
  castId: string;
}

export interface DocWorkItem {
  target_clone_id: string;
  cast_id: string;
  prompt: string;
  priority: 'normal' | 'high';
}

export class DocChaseDispatcher {
  constructor(private readonly config: DocChaseConfig) {}

  static parseTaskIntoItems(
    task: string,
    cloneId: string,
    castId: string,
  ): DocWorkItem[] {
    // Extract file paths or module names from the task description.
    // Supports: comma-separated paths, "Document X, Y, Z" patterns.
    const pathRegex = /(?:packages\/[^\s,]+|src\/[^\s,]+)/g;
    const paths = task.match(pathRegex) ?? [];

    if (paths.length === 0) {
      // Single task — treat entire task as one work item
      return [{
        target_clone_id: cloneId,
        cast_id: castId,
        prompt: buildDocPrompt(task),
        priority: 'normal',
      }];
    }

    return paths.map((p) => ({
      target_clone_id: cloneId,
      cast_id: castId,
      prompt: buildDocPrompt(p),
      priority: 'normal' as const,
    }));
  }

  get isDone(): boolean {
    return false; // daemon-loop handles termination via maxEmptyPolls
  }
}

function buildDocPrompt(target: string): string {
  return [
    `Document the public API of \`${target}\`.`,
    '',
    'Include: module purpose, class/function signatures, parameters, return types,',
    'error conditions, state machine transitions (if any), usage examples from tests.',
    '',
    'Output: write to docs/api/ or docs/arch/ as a markdown file.',
    'Start with: "> Auto-generated by documentation-chase clone."',
    'After completing, broadcast docs_ready with the file list.',
  ].join('\n');
}
```

- [ ] **Step 4: Write failing test for DOC_CHASE_BLOCK in priming**

```typescript
it('includes DOC_CHASE_BLOCK for documentation-chase mode', () => {
  const text = buildPrimingText({
    // ... standard params with mode: 'documentation-chase'
  });
  expect(text).toContain('Documentation-Chase Protocol');
  expect(text).toContain('NEVER modify source files');
});
```

- [ ] **Step 5: Add DOC_CHASE_BLOCK to priming.ts**

Find the existing `DAEMON_MODE_BLOCK` in `priming.ts` and add below it:

```typescript
const DOC_CHASE_BLOCK = `
## Documentation-Chase Protocol
You are a documentation clone. Read source code, produce clear markdown docs.

OUTPUT RULES:
1. Write ONLY to docs/ subdirectories (docs/api/, docs/arch/, docs/generated/)
2. NEVER modify source files in packages/ — your scope forbids it
3. Each doc file starts with: "> Auto-generated by documentation-chase clone."
4. After completing each doc task, broadcast docs_ready with file list
5. Focus on accuracy over completeness — correct partial doc beats complete wrong doc

DOCUMENT: public exports, state machines, error conditions, usage examples from tests
SKIP: internal implementation details, test helpers, build config
`;
```

Wire into `buildPrimingText` when `mode === 'documentation-chase'`.

- [ ] **Step 6: Run all tests — verify PASS**

Run: `cd packages/manta-cli && pnpm vitest run`

- [ ] **Step 7: Commit**

```
feat(cli): DocChaseDispatcher + documentation-chase priming block
```

---

### Task 1.6: Wire pair-programming dispatch into cast.ts

**Files:**
- Modify: `packages/manta-cli/src/commands/cast.ts`
- Modify: `packages/manta-cli/tests/commands/cast.test.ts` (or integration tests)

- [ ] **Step 1: Write failing integration test**

```typescript
it('pair-programming cast wires PairDispatcher into tick-loop', async () => {
  // Use fake runner. Cast with mode='pair-programming', 2 clones.
  // Verify onCycleComplete is wired and PairDispatcher created.
  const result = await runCastCommand(runtime, {
    mode: 'pair-programming',
    cloneCount: 2,
    castId: 'test-pair-cast',
    // ... standard test opts with fake runner
  });
  // Pair-programming casts should assign roles
  // Verify via cast manifest or snapshot
});
```

- [ ] **Step 2: Implement dispatch wiring in cast.ts**

In the `cast.ts` function body, after the tick-loop setup and before `runTickLoop()`:

```typescript
// Wave-2 dispatch: create mode-specific dispatcher
let dispatcher: PairDispatcher | null = null;

if (opts.mode === 'pair-programming') {
  const writerClone = cloneIds[0]!;
  const reviewerClone = cloneIds[1]!;
  dispatcher = new PairDispatcher({
    writerCloneId: writerClone,
    reviewerCloneId: reviewerClone,
    castId: opts.castId,
    maxIterations: 5,
  });
}
```

Add role to clone assignments for pair-programming:

```typescript
if (opts.mode === 'pair-programming') {
  // Auto-assign roles if not explicitly set
  if (!assignments[cloneIds[0]!]?.role) {
    effective[cloneIds[0]!]!.role = 'writer';
  }
  if (!assignments[cloneIds[1]!]?.role) {
    effective[cloneIds[1]!]!.role = 'reviewer';
  }
}
```

Create a `BroadcastReader` instance (from Task 1.3c) before the tick-loop, then wire `onCycleComplete`:

```typescript
const broadcastReader = new BroadcastReader(opts.castId, rt.ctx.events);
const enqueuer: DispatchEnqueuer = {
  enqueue: async (target, prompt, priority) => {
    await rt.ctx.workQueue!.enqueue({
      cast_id: opts.castId,
      target_clone_id: target,
      prompt,
      priority: priority ?? 'normal',
    });
  },
};

loopResult = await runTickLoop({
  orchestrator: castOrchestrator,
  intervalMs: opts.cycleIntervalMs,
  signal: ctrl.signal,
  daemonMode: sessionMode === 'daemon',
  onCycleComplete: dispatcher ? async (result) => {
    const broadcasts = await broadcastReader.readNew();
    await dispatcher!.onCycleComplete(
      { idleClones: result.idleClones, broadcasts },
      enqueuer,
    );
  } : undefined,
  allDone: async () => {
    // existing allDone logic...
    // For pair-programming, also check dispatcher.isDone
    if (dispatcher?.isDone) return true;
    // ... rest of existing allDone
  },
});
```

- [ ] **Step 3: Run tests — verify PASS**

Run: `cd packages/manta-cli && pnpm vitest run`

- [ ] **Step 4: Build workspace** — `pnpm -r build` clean

- [ ] **Step 5: Commit**

```
feat(cli): wire PairDispatcher into cast.ts for pair-programming mode
```

---

### Task 1.7: Wire documentation-chase dispatch into cast.ts

**Files:**
- Modify: `packages/manta-cli/src/commands/cast.ts`

- [ ] **Step 1: Add doc-chase work-queue pre-population**

For `documentation-chase` mode, the orchestrator pre-populates the work queue at cast start (before tick-loop):

```typescript
if (opts.mode === 'documentation-chase') {
  const docCloneId = cloneIds[0]!;
  const items = DocChaseDispatcher.parseTaskIntoItems(
    opts.task,
    docCloneId,
    opts.castId,
  );
  for (const item of items) {
    await rt.ctx.workQueue!.enqueue(item);
  }
  opts.reporter.info('cast.doc_chase_enqueued', { items: items.length });
}
```

Assign `documenter` role:

```typescript
if (opts.mode === 'documentation-chase') {
  effective[cloneIds[0]!]!.role = 'documenter';
}
```

- [ ] **Step 2: Write test for doc-chase pre-population**

```typescript
it('documentation-chase pre-populates work queue with parsed doc items', async () => {
  // ... test with fake runner, mode='documentation-chase', clones=1
  // Verify workQueue.enqueue was called with parsed items
});
```

- [ ] **Step 3: Run tests — verify PASS**

- [ ] **Step 4: Commit**

```
feat(cli): wire documentation-chase work-queue pre-population in cast.ts
```

---

### Task 1.8: pair-programming role-specific skills

**Files:**
- Create: `skills/manta-pair-writer/SKILL.md`
- Create: `skills/manta-pair-reviewer/SKILL.md`
- Modify: `skills/manta-pair-protocol/SKILL.md` — update to reference the role-specific skills, replace `task_complete` with `commit_ready`/`review_complete` event types
- Modify: `packages/manta-cli/src/spawner/priming.ts` — update `PAIR_PROTOCOL_BLOCK` to use `commit_ready`/`review_complete` instead of `task_complete` (existing priming text is out of sync with new broadcast types)

**CRITICAL:** The existing `manta-pair-protocol` skill and `PAIR_PROTOCOL_BLOCK` in priming.ts both reference `task_complete` as the broadcast event. The dispatcher (Task 1.4) expects `commit_ready`. If not updated, clones will broadcast `task_complete` and the dispatcher will never trigger. Update BOTH the skill AND the priming block to use the new event types.

- [ ] **Step 1: Write manta-pair-writer skill**

```markdown
---
name: manta-pair-writer
description: Writer role instructions for pair-programming mode — implement code, respond to reviewer feedback
audience: clone
version: 0.0.1
related:
  - manta-pair-reviewer
  - manta-pair-protocol
  - manta-as-clone
---

## Purpose
You are the WRITER in a pair-programming session. You implement the task, the reviewer checks your work.

## Allowed
- Read any file in the repository for context
- Write implementation code in your worktree
- Run tests before signaling done
- Commit all changes to your worktree branch
- Broadcast `commit_ready` with `{ commit_ref, summary, files_changed, iteration }`
- Transition to IDLE after broadcasting commit_ready
- Apply reviewer feedback received via resume prompt

## Forbidden
- Reviewing your own code (that is the reviewer's job)
- Reading or modifying the reviewer's worktree
- Enqueuing work items directly (the orchestrator handles dispatch)
- Skipping tests before signaling commit_ready
- Ignoring CORRECTION or BLOCKER severity feedback from reviewer

## Examples
### Signaling commit ready
```
manta.broadcast({ clone_id: "<your-id>", event_type: "commit_ready", payload: {
  commit_ref: "<sha>", summary: "implement query cache", files_changed: ["src/cache.ts"], iteration: 1
}})
manta.heartbeat({ clone_id: "<your-id>", state: "IDLE" })
```

### After receiving fix feedback
Read the feedback in your resume prompt. Fix CORRECTION and BLOCKER items. Re-run tests. Commit. Broadcast commit_ready again with incremented iteration.
```

- [ ] **Step 2: Write manta-pair-reviewer skill**

```markdown
---
name: manta-pair-reviewer
description: Reviewer role instructions for pair-programming mode — review writer's commits, deliver structured feedback
audience: clone
version: 0.0.1
related:
  - manta-pair-writer
  - manta-pair-protocol
  - manta-as-clone
---

## Purpose
You are the REVIEWER in a pair-programming session. You review the writer's code and deliver structured feedback.

## Allowed
- Read the writer's branch via `git diff main..manta/<castId>/<writerCloneId>`
- Run the writer's tests by checking out their branch in your worktree
- Deliver feedback via broadcast `review_complete` with verdict and per-file comments
- Transition to IDLE after each review

## Forbidden
- Modifying files in the writer's worktree or committing code changes
- Self-approving or skipping review steps
- Enqueuing work items (the orchestrator handles dispatch)
- Blocking on style-only issues after iteration 3

## Examples
### Delivering review feedback
```
manta.broadcast({ clone_id: "<your-id>", event_type: "review_complete", payload: {
  iteration: 1, verdict: "changes_requested",
  comments: [
    { file: "src/cache.ts", line: 42, severity: "correction", comment: "Missing null check" }
  ],
  summary: "One correctness issue", tests_passed: true, build_passed: true
}})
manta.heartbeat({ clone_id: "<your-id>", state: "IDLE" })
```

### Approval threshold
All blockers resolved, no new correctness issues. After iteration 3, only block on BLOCKER severity.
```

- [ ] **Step 3: Run skill validator**

```bash
node packages/manta-skill-validator/dist/bin/manta-validate-skills.cjs --root .
```

- [ ] **Step 4: Update skill-validator integration test** — expected skill count

- [ ] **Step 5: Update e2e preflight test** — expected skill count

- [ ] **Step 6: Commit**

```
feat(skills): add manta-pair-writer and manta-pair-reviewer role-specific skills
```

---

### Task 1.9: documentation-chase skill

**Files:**
- Create: `skills/manta-doc-chase/SKILL.md`

- [ ] **Step 1: Write skill**

```markdown
---
name: manta-doc-chase
description: Documentation clone instructions — read code, produce markdown docs in docs/ only
audience: clone
version: 0.0.1
related:
  - manta-daemon-idle
  - manta-as-clone
---

## Purpose
You are a documentation clone. Read source code and produce clear, accurate documentation in markdown.

## Allowed
- Read any source file in the repository for context
- Write documentation to docs/api/, docs/arch/, docs/generated/
- Read test files to find usage examples
- Broadcast docs_ready with file list after completing each task
- Transition to IDLE between documentation tasks

## Forbidden
- Modifying source files in packages/ — your scope contract forbids it
- Writing inline JSDoc to source files
- Documenting internal implementation details that change frequently
- Skipping the docs_ready broadcast after completing a task
- Documenting test helpers, fixtures, or build configuration

## Examples
### Documentation output header
Start every doc file with:
```
> Auto-generated by documentation-chase clone. Cast: <cast-id>, Date: <date>.
> Source: <source-file-path> at commit <short-hash>.
```

### Broadcasting completion
```
manta.broadcast({ clone_id: "<your-id>", event_type: "docs_ready", payload: {
  files: ["docs/api/manta-bus/registry.md"], commit: "<hash>",
  summary: "Documented registry module: 3 classes, 12 methods"
}})
```
```

- [ ] **Step 2: Run skill validator**

- [ ] **Step 3: Update skill-validator integration test + e2e preflight** — expected skill count

- [ ] **Step 4: Commit**

```
feat(skills): add manta-doc-chase skill for documentation-chase mode
```

---

### Task 1.10: Integration test + docs

**Files:**
- Create: `packages/manta-cli/tests/integration/pair-programming.test.ts`
- Modify: `docs/user/` — add pair-programming and documentation-chase user docs
- Modify: `packages/manta-cli/src/commands/cast.ts` — any remaining wiring

- [ ] **Step 1: Write integration test for pair-programming dispatch**

Test the full flow: spawn 2 fake clones, writer broadcasts commit_ready, dispatcher enqueues review, reviewer broadcasts approved, cast ends.

- [ ] **Step 2: Write integration test for documentation-chase pre-population**

Test: spawn 1 fake clone, work queue pre-populated with doc items, daemon loop processes them.

- [ ] **Step 3: Write user docs**

Create `docs/user/pair-programming.md` and `docs/user/documentation-chase.md`.

- [ ] **Step 4: Run full workspace test suite**

```bash
pnpm -r build && pnpm -r test
```

- [ ] **Step 5: Commit**

```
feat(cli): pair-programming + documentation-chase integration tests and user docs
```

---

## Chunk 2: test-storm mode

The hardest Wave-2 mode. 3 clones, shared worktree, GIT_OPERATIONS lock, pipeline stage manager. ~900 LOC estimated (including lock enforcement hook).

### Task 2.1: Shared worktree spawner support

**Files:**
- Modify: `packages/manta-cli/src/spawner/clone-spawner.ts` — guard `installHeartbeatHook` against repeated calls on same worktree
- Modify: `packages/manta-cli/src/commands/cast.ts`
- Modify: `packages/manta-cli/tests/spawner/clone-spawner.test.ts`

Currently each clone gets its own worktree. Test-storm needs all 3 clones in ONE worktree.

**CRITICAL:** `installHeartbeatHook(worktree, ...)` is called per-clone in `spawnClone`. With 3 clones sharing one worktree, it runs 3x on the same directory. Guard with idempotency check (e.g., track installed worktrees in a Set, or check if `.claude/settings.local.json` already has the hook).

- [ ] **Step 1: Write failing test for idempotent heartbeat hook install**

```typescript
it('installHeartbeatHook is idempotent on repeated calls', async () => {
  // Call installHeartbeatHook twice with same worktree path
  // Verify .claude/settings.local.json has exactly ONE hook entry, not duplicated
});
```

- [ ] **Step 2: Guard installHeartbeatHook against double-install**

In `clone-spawner.ts`, before calling `installHeartbeatHook`, check if already installed:

```typescript
const installedWorktrees = new Set<string>();
// ... in spawnClone:
if (!installedWorktrees.has(opts.worktree)) {
  await installHeartbeatHook(opts.worktree, ...);
  installedWorktrees.add(opts.worktree);
}
```

- [ ] **Step 3: Add shared worktree creation for test-storm in cast.ts**

In `cast.ts` for `test-storm` mode: create ONE worktree before the clone loop, then pass the same worktree path to all 3 clones:

```typescript
if (opts.mode === 'test-storm') {
  const sharedWt = await addWorktree({
    repoRoot: rt.repoRoot,
    name: `storm-${opts.castId}`,
    branch: `storm/${opts.castId}/work`,
  });
  worktrees.push(sharedWt);
  // All clones spawned with cwd = sharedWt.path
}
```

- [ ] **Step 4: Run tests — verify PASS**

- [ ] **Step 5: Commit**

```
feat(cli): shared worktree support for test-storm mode with idempotent hook install
```

---

### Task 2.1b: GIT_OPERATIONS virtual lock + PreToolUse enforcement hook

**Files:**
- Create: `packages/manta-cli/src/hooks/git-lock-hook.ts`
- Create: `packages/manta-cli/tests/hooks/git-lock-hook.test.ts`
- Modify: `packages/manta-cli/src/spawner/clone-spawner.ts` — install PreToolUse hook for test-storm clones

**CRITICAL (from research):** Skill text saying "acquire GIT_OPERATIONS lock before git commands" is a **soft prior** that clones will ignore under task pressure. Per `claude-code-pitfalls.md` §3-4, the ONLY reliable enforcement is a **PreToolUse hook** in `settings.local.json` that the harness executes, not the model.

- [ ] **Step 1: Write failing test for git-lock-hook**

```typescript
describe('gitLockHook', () => {
  it('blocks Bash calls containing git commit when GIT_OPERATIONS lock not held', async () => {
    const result = await checkGitLock({
      tool: 'Bash',
      input: { command: 'git add . && git commit -m "test"' },
      cloneId: 'A',
      busStatePath: '/tmp/test-bus',
    });
    expect(result.blocked).toBe(true);
    expect(result.message).toContain('GIT_OPERATIONS');
  });

  it('allows Bash git commands when GIT_OPERATIONS lock is held by this clone', async () => {
    // Pre-acquire GIT_OPERATIONS lock for clone A
    const result = await checkGitLock({
      tool: 'Bash',
      input: { command: 'git commit -m "test"' },
      cloneId: 'A',
      busStatePath: '/tmp/test-bus',
    });
    expect(result.blocked).toBe(false);
  });

  it('allows non-git Bash commands without lock', async () => {
    const result = await checkGitLock({
      tool: 'Bash',
      input: { command: 'pnpm test' },
      cloneId: 'A',
      busStatePath: '/tmp/test-bus',
    });
    expect(result.blocked).toBe(false);
  });
});
```

- [ ] **Step 2: Implement git-lock-hook**

```typescript
// packages/manta-cli/src/hooks/git-lock-hook.ts

const GIT_MUTATING_PATTERNS = [/\bgit\s+(add|commit|checkout|stash|merge|rebase|reset)\b/];

export async function checkGitLock(ctx: {
  tool: string;
  input: { command?: string };
  cloneId: string;
  busStatePath: string;
}): Promise<{ blocked: boolean; message?: string }> {
  if (ctx.tool !== 'Bash') return { blocked: false };
  const cmd = ctx.input.command ?? '';
  const isGitMutating = GIT_MUTATING_PATTERNS.some((p) => p.test(cmd));
  if (!isGitMutating) return { blocked: false };

  // Read locks.json, check if GIT_OPERATIONS owned by this clone
  const locksPath = join(ctx.busStatePath, 'locks.json');
  try {
    const data = JSON.parse(await readFile(locksPath, 'utf8'));
    const gitLock = data.leases?.['GIT_OPERATIONS'];
    if (gitLock?.owner === ctx.cloneId) return { blocked: false };
  } catch { /* no locks file = no lock held */ }

  return {
    blocked: true,
    message: `GIT_OPERATIONS lock not held by ${ctx.cloneId}. Acquire via manta.lock({ clone_id: "${ctx.cloneId}", path: "GIT_OPERATIONS" }) before git commands.`,
  };
}
```

- [ ] **Step 3: Wire hook into clone settings for test-storm mode**

In `clone-spawner.ts`, when `castMode === 'test-storm'`, write a PreToolUse hook to the clone's `.claude/settings.local.json`:

```typescript
if (opts.castMode === 'test-storm') {
  await writeTestStormHooks(opts.worktree, opts.cloneId, busPaths.stateDir);
}
```

- [ ] **Step 4: Run tests — verify PASS**

- [ ] **Step 5: Commit**

```
feat(cli): PreToolUse hook for GIT_OPERATIONS lock enforcement in test-storm
```

---

### Task 2.2: TestStormDispatcher pipeline stage manager

**Files:**
- Create: `packages/manta-cli/src/dispatch/test-storm-dispatch.ts`
- Create: `packages/manta-cli/tests/dispatch/test-storm-dispatch.test.ts`

Import `DispatchCycleInput` and `DispatchEnqueuer` from `../dispatch/types.js` (created in Task 1.3b, Chunk 1).

- [ ] **Step 1: Write failing tests**

```typescript
describe('TestStormDispatcher', () => {
  it('enqueues test work for tester when coder broadcasts task_complete', async () => {
    const d = new TestStormDispatcher({
      coderCloneId: 'A', testerCloneId: 'B', fuzzerCloneId: 'C',
      castId: 'cast-1', maxFixCycles: 3,
    });
    const enqueued: Array<{ target: string }> = [];
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'A', idle_since: 100 }],
      broadcasts: [{ clone_id: 'A', event_type: 'code_ready', payload: {
        commit_ref: 'abc', feature_id: 'feat-1', files_changed: ['src/x.ts'],
      } }],
    }, { enqueue: async (target) => { enqueued.push({ target }); } });
    expect(enqueued[0]!.target).toBe('B');
  });

  it('enqueues fuzz work for fuzzer when tester passes', async () => {
    const d = new TestStormDispatcher({ /* ... */ });
    d.stages.set('feat-1', { featureId: 'feat-1', status: 'testing', fixCycles: 0 });
    const enqueued: Array<{ target: string }> = [];
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{ clone_id: 'B', event_type: 'tests_ready', payload: {
        feature_id: 'feat-1', pass: true, commit_ref: 'def',
      } }],
    }, { enqueue: async (target) => { enqueued.push({ target }); } });
    expect(enqueued[0]!.target).toBe('C');
  });

  it('routes fix-request back to coder on test failure', async () => {
    const d = new TestStormDispatcher({ /* ... */ });
    d.stages.set('feat-1', { featureId: 'feat-1', status: 'testing', fixCycles: 0 });
    const enqueued: Array<{ target: string }> = [];
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{ clone_id: 'B', event_type: 'blocker', payload: {
        feature_id: 'feat-1', failures: [{ test: 'test_x', error: 'null ref' }],
      } }],
    }, { enqueue: async (target) => { enqueued.push({ target }); } });
    expect(enqueued[0]!.target).toBe('A');
  });

  it('escalates after max fix cycles', async () => {
    const d = new TestStormDispatcher({ /* ... */ });
    d.stages.set('feat-1', { featureId: 'feat-1', status: 'fixing', fixCycles: 3 });
    await d.onCycleComplete({
      idleClones: [{ clone_id: 'B', idle_since: 200 }],
      broadcasts: [{ clone_id: 'B', event_type: 'blocker', payload: { feature_id: 'feat-1' } }],
    }, { enqueue: async () => {} });
    expect(d.stages.get('feat-1')!.status).toBe('escalated');
  });
});
```

- [ ] **Step 2: Implement TestStormDispatcher**

Pipeline stage state machine with `coding → testing → fuzzing → complete` progression, plus `fixing → coding` loop with max 3 cycles.

```typescript
export interface TestStormStage {
  featureId: string;
  codeCommitRef?: string;
  testCommitRef?: string;
  fuzzCommitRef?: string;
  fixCycles: number;
  status: 'coding' | 'testing' | 'fuzzing' | 'fixing' | 'complete' | 'escalated';
}

export class TestStormDispatcher {
  stages = new Map<string, TestStormStage>();

  constructor(private readonly config: {
    coderCloneId: string;
    testerCloneId: string;
    fuzzerCloneId: string;
    castId: string;
    maxFixCycles: number;
  }) {}

  async onCycleComplete(input: DispatchCycleInput, enqueuer: DispatchEnqueuer): Promise<void> {
    // Read broadcasts, advance pipeline stages, enqueue work
    // ... (full implementation ~120 LOC)
  }

  get isDone(): boolean {
    if (this.stages.size === 0) return false;
    return [...this.stages.values()].every(
      (s) => s.status === 'complete' || s.status === 'escalated',
    );
  }
}
```

- [ ] **Step 3: Run tests — verify PASS**

- [ ] **Step 4: Commit**

```
feat(cli): TestStormDispatcher pipeline stage manager
```

---

### Task 2.3: test-storm role-specific skills

**Files:**
- Create: `skills/manta-storm-coder/SKILL.md`
- Create: `skills/manta-storm-tester/SKILL.md`
- Create: `skills/manta-storm-fuzzer/SKILL.md`

Three role-specific skills following the same pattern as pair-programming skills. Each skill has Purpose, Allowed, Forbidden, Examples sections per Phase-0 validation requirements.

Key points per role:
- **coder:** lock source files before editing, acquire GIT_OPERATIONS lock before git commands, broadcast code_ready
- **tester:** read source (no modify), lock test files, broadcast tests_ready with pass/fail
- **fuzzer:** read source+tests (no modify), write property/boundary tests, broadcast fuzz_complete

- [ ] **Step 1: Write all 3 skills**

- [ ] **Step 2: Run skill validator**

- [ ] **Step 3: Update skill-validator integration test + e2e preflight skill counts**

- [ ] **Step 4: Commit**

```
feat(skills): add test-storm role-specific skills (coder, tester, fuzzer)
```

---

### Task 2.4: Wire test-storm dispatch into cast.ts

**Files:**
- Modify: `packages/manta-cli/src/commands/cast.ts`

- [ ] **Step 1: Add test-storm dispatch wiring**

Similar to pair-programming wiring but with TestStormDispatcher and 3 clone roles:

```typescript
if (opts.mode === 'test-storm') {
  const coderClone = cloneIds[0]!;
  const testerClone = cloneIds[1]!;
  const fuzzerClone = cloneIds.length > 2 ? cloneIds[2]! : undefined;

  stormDispatcher = new TestStormDispatcher({
    coderCloneId: coderClone,
    testerCloneId: testerClone,
    fuzzerCloneId: fuzzerClone ?? testerClone,
    castId: opts.castId,
    maxFixCycles: 3,
  });

  // Auto-assign roles
  effective[coderClone]!.role = 'coder';
  effective[testerClone]!.role = 'tester';
  if (fuzzerClone) effective[fuzzerClone]!.role = 'fuzzer';
}
```

Wire into `onCycleComplete` and `allDone` (same pattern as Task 1.6).

- [ ] **Step 2: Run tests**

- [ ] **Step 3: Commit**

```
feat(cli): wire TestStormDispatcher into cast.ts for test-storm mode
```

---

### Task 2.5: test-storm integration test + docs

**Files:**
- Create: `packages/manta-cli/tests/integration/test-storm.test.ts`
- Create: `docs/user/test-storm.md`

- [ ] **Step 1: Write integration test — happy path**

Test full pipeline: coder broadcasts code_ready → dispatcher enqueues for tester → tester broadcasts tests_ready (pass) → dispatcher enqueues for fuzzer → fuzzer broadcasts fuzz_complete → pipeline done.

- [ ] **Step 1b: Write integration test — fix cycle loop**

Test: coder broadcasts code_ready → tester broadcasts blocker → dispatcher routes fix back to coder → coder fixes → tester re-tests → pass. Verify `fixCycles` increments.

- [ ] **Step 1c: Write integration test — escalation**

Test: coder and tester loop 3 times without resolution → stage status becomes `escalated`. Verify no further work enqueued.

- [ ] **Step 2: Write user docs**

- [ ] **Step 3: Run full workspace test suite**

```bash
pnpm -r build && pnpm -r test
```

- [ ] **Step 4: Commit**

```
feat(cli): test-storm integration tests and user docs
```

---

### Task 2.6: Skill count updates + full workspace validation + INDEX update

**Files:**
- Modify: `packages/manta-skill-validator/tests/integration.test.ts` — update expected skill count (7 → 13: +3 from Chunk 1, +3 from Chunk 2)
- Modify: `packages/manta-e2e/tests/preflight.test.ts` — update expected skill count
- Modify: `docs/superpowers/plans/INDEX.md`

**NOTE:** Skill count assertions should be updated ONCE here at the end, not per-chunk, to avoid merge conflicts if chunks execute in parallel.

- [ ] **Step 1: Update skill-validator integration test expected count**

Grep for the hardcoded count and update to 13 (7 existing + 6 new: pair-writer, pair-reviewer, doc-chase, storm-coder, storm-tester, storm-fuzzer).

- [ ] **Step 2: Update e2e preflight test expected count**

- [ ] **Step 3: Run full workspace build + test + lint**

```bash
pnpm -r build && pnpm -r test && pnpm -r lint
```

- [ ] **Step 4: Update INDEX.md** with Phase 6 entry

- [ ] **Step 5: Commit**

```
chore: Phase 6 Wave-2 modes — skill counts + INDEX update
```

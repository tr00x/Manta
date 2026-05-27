# Phase 4 Research: Mode Infrastructure Map & Bug-Hunt Design

**Clone:** A | **Cast:** cast-1779890518943 | **Mode:** recon-swarm  
**Date:** 2026-05-27

---

## Part 1 — Mode Infrastructure Map

### 1.1 Mode Dispatch in cast.ts

**File:** `packages/manta-cli/src/commands/cast.ts`

**SUPPORTED_MODES allowlist** (line 29–32):
```typescript
const SUPPORTED_MODES: ReadonlySet<Mode> = new Set<Mode>([
  'recon-swarm',
  'forking-realities',
]);
```
Only two modes pass the runtime gate at line 115–119. All other modes (including `bug-hunt`, `refactor-wave`) are defined in the Zod enum (`ModeSchema` in `packages/manta-bus/src/schema.ts:12–23` and `packages/manta-snapshot/src/schema.ts:4–16`) but **rejected at cast time**. Phase 4 adds `bug-hunt` and `refactor-wave` to this set.

**Mode-specific branching in cast.ts:**

| Line(s) | Behavior | Mode-specific? |
|---------|----------|----------------|
| 248–251 | `castPolicy.peer_messaging` — `'denied'` for forking-realities, `'allowed'` otherwise | Yes — hardcoded ternary |
| 427–468 | Merge-review pipeline — only runs when `mode === 'forking-realities'` and not aborted | Yes — explicit guard |
| 151 | `castScope` defaults — `DEFAULT_SCOPE` (read-only, `maxFilesChanged: 0`) | No — mode-agnostic |
| 206–228 | Pre-spawn gate (charge + budget) — dispatches to `runPreSpawnGate` | No — mode passed through, charges read from `MODE_CHARGE_COST` |
| 399–419 | Post-cast settlement — `classifyCastOutcome` + charge credit | No — mode-agnostic; mode passed to `creditSuccess/Fail/Neutral` for logging |
| 262–318 | Clone spawn loop — worktree creation, snapshot build, contract write, runner launch | No — mode-agnostic |

**Key insight:** `cast.ts` has exactly **2 mode-specific branches**: peer_messaging policy and merge-review triggering. Everything else is mode-agnostic infrastructure. Adding a new mode requires:
1. Adding it to `SUPPORTED_MODES` (line 29)
2. Deciding the `castPolicy.peer_messaging` value (line 248–251)
3. Deciding whether to run merge-review (line 427) or a different post-cast pipeline

### 1.2 Clone Spawner & Priming

**File:** `packages/manta-cli/src/spawner/clone-spawner.ts`

**Mode-specific behavior** (line 147–160):
- `MANTA_BUS_PEER_SCOPE` env var: `'parent-only'` for forking-realities, `'siblings-allowed'` otherwise (line 153–155)
- All other spawning logic (snapshot write, pre-registration, manifest creation, heartbeat hook install) is mode-agnostic

**File:** `packages/manta-cli/src/spawner/priming.ts`

**Mode-specific priming blocks:**
1. **Approach hint block** (line 28–29): Injected when `approachHint` is non-null — mode-agnostic but typically used in forking-realities (per-clone different approach_hint)
2. **Self-certainty block** (line 31–33): Only for `mode === 'forking-realities'` — instructs clone to broadcast confidence score before final commit

The core priming template (lines 3–19) is **identical for all modes**. It covers:
- Identity (clone_id, cast_id, mode)
- Startup sequence (skill load → snapshot read → heartbeat → contract ack → work)
- Heartbeat implicit rule (bug #9 fix)
- Shutdown sequence (graceful-death skill)
- Forbidden actions

**To add bug-hunt priming:** Insert a mode-specific block (similar to self-certainty) that instructs clones to broadcast intermediate findings via `manta.broadcast`.

### 1.3 Orchestrator Mode-Specific Logic

**File:** `packages/manta-orchestrator/src/orchestrator.ts`

The orchestrator's `runCycle()` method (line 33–87) is **entirely mode-agnostic**:
- `findDeadClones` — checks heartbeat timeout, startup grace, parent PID (no mode filter)
- `reapLocks` / `reapClaims` — mode-agnostic cleanup
- `runPostMortem` — writes markdown post-mortem with clone metadata (mode is logged but not branched on)
- `ForensicTimelineWriter.appendSnapshot` — mode passed as metadata in constructor, not in per-cycle logic

**Merge-review** (`packages/manta-orchestrator/src/merge-review.ts`):
- `findFinalisedCasts` (line 65–97): filters by mode via `opts?.mode` — caller can select mode, but internal logic is mode-agnostic
- `runMergeReview` (line 99–185): pure scoring pipeline — normalize → rank → tie-break → write markdown + event
- The entire scoring pipeline (`packages/manta-orchestrator/src/scoring.ts`) is mode-agnostic — it computes composite scores from raw metrics regardless of mode

**Post-mortem** (`packages/manta-orchestrator/src/post-mortem.ts`):
- `renderMarkdown` uses `input.record.mode` purely for display (line 72)
- No mode-specific branches

**Key insight:** The orchestrator has **zero mode-specific logic**. Mode semantics live entirely in:
1. `cast.ts` (policy + post-cast pipeline selection)
2. `priming.ts` (mode-specific priming blocks)
3. `clone-spawner.ts` (PEER_SCOPE env var)

### 1.4 Forking Isolation in Bus

**File:** `packages/manta-bus/src/tools/forking-isolation.ts`

Two functions:

1. **`siblingsInSameForkingCast`** (line 9–21): Returns `{ same: true, castId }` iff both clones are in the same forking-realities cast. Used by `communication.ts` message handler (line 40–52) to **block** peer messages between forking-realities siblings.

2. **`crossCloneRead`** (line 25–37): Returns `{ blocked: true }` if caller is a forking-realities clone trying to read another clone's data. Not currently wired into any handler — **reserved for Phase 2b** per spec (worktree read isolation).

**Communication handlers** (`packages/manta-bus/src/tools/communication.ts`):
- `broadcast()` (line 18–32): Mode-agnostic — any clone can broadcast. Broadcasts are **not filtered** by mode; they land in `events.jsonl` for all to read.
- `message()` (line 34–59): **Blocked** for forking-realities siblings via `siblingsInSameForkingCast`. Throws `BusForkingIsolationError`.
- `driftReport()` (line 61–69): Mode-agnostic.

**CastPolicy schema** (`packages/manta-bus/src/schema.ts:206–215`):
```typescript
peer_messaging: z.enum(['allowed', 'denied']),
auto_merge_threshold: z.number().min(0).max(1).nullable(),
```
`peer_messaging` is stored on the cast manifest but **enforcement is per-handler** (message() checks registry metadata, not manifest policy). The `MANTA_BUS_PEER_SCOPE` env var set by clone-spawner is not read by the bus — isolation is enforced server-side via `siblingsInSameForkingCast`.

**For bug-hunt:** Peer messaging should be `'allowed'` (clones share findings). Broadcast is already unrestricted. No new isolation logic needed.

### 1.5 E2E Tests Per Mode

**3 e2e test files** in `packages/manta-e2e/tests/`:

| File | Mode | Clones | Key assertions |
|------|------|--------|----------------|
| `recon-swarm.e2e.test.ts` (244 lines) | recon-swarm | 2 | exitCode=0, both DEAD, ≥2 post-mortems (A.md, B.md), ≥2 ZK notes, snapshots persisted, worktrees retained |
| `forking-realities.e2e.test.ts` (285 lines) | forking-realities | 2 | Same as above + merge-review event in events.jsonl, merge-review markdown written, forensic timeline sealed, each clone branch has ≥1 commit |
| `charge-system.e2e.test.ts` | charge system | — | Charge lifecycle (not mode-specific) |

**Shared test infrastructure:**
- `probeClaudeBin()` — checks if `claude` binary is available; skips if not
- `makeSampleRepo()` — creates tmp git repo with `src/` files
- Timeline recorder: polls registry every 5s, asserts positive-timeline (all clones leave STARTING within tickBudget/4)
- `afterAll` preserve-on-failure: keeps tmp repo for forensics

**For bug-hunt e2e test:** Clone the recon-swarm pattern (read-only investigation). Additional assertions: each clone broadcasts investigation findings via events.jsonl.

### 1.6 Summary: Extension Points for New Modes

Adding a new mode to Manta requires touching these files:

| # | File | Change | Scope |
|---|------|--------|-------|
| 1 | `packages/manta-cli/src/commands/cast.ts:29` | Add to `SUPPORTED_MODES` | 1 line |
| 2 | `packages/manta-cli/src/commands/cast.ts:248–251` | Set `castPolicy.peer_messaging` | 1–3 lines |
| 3 | `packages/manta-cli/src/commands/cast.ts:427` | Add post-cast pipeline (or skip merge-review) | 5–20 lines |
| 4 | `packages/manta-cli/src/spawner/clone-spawner.ts:153` | Set `MANTA_BUS_PEER_SCOPE` env var | 1 line |
| 5 | `packages/manta-cli/src/spawner/priming.ts` | Add mode-specific priming block | 5–15 lines |
| 6 | `packages/manta-cli/src/budget/auto-downgrade.ts:19–27` | Already has `'bug-hunt': 'recon-swarm'` | 0 lines |
| 7 | `packages/manta-bus/src/schema.ts:274–285` | Already has `'bug-hunt': 2` in MODE_CHARGE_COST | 0 lines |
| 8 | `packages/manta-cli/src/config/budget-config.ts:35` | Already has `'bug-hunt': 3.00` cost estimate | 0 lines |
| 9 | E2E test file | New test following recon-swarm pattern | ~200 lines |

**Already done for bug-hunt** (no code changes needed):
- `ModeSchema` includes `'bug-hunt'` in both `@manta/bus` and `@manta/snapshot`
- `MODE_CHARGE_COST['bug-hunt'] = 2`
- `CHEAPER_MODE_MAP['bug-hunt'] = 'recon-swarm'`
- Budget config has `'bug-hunt': 3.00` (estimated cost per clone)

---

## Part 2 — Bug-Hunt Mode Design

### 2.0 Spec Requirements (Sec 2, line 59)

> `bug-hunt` | Wave 1 | Charge cost 2 | Клоны разбирают проблему по слоям (frontend / network / backend / db / infra). Мейн собирает root cause.

Key characteristics from spec:
- 1–2 clones (small team, not N-way parallel)
- Investigation by layers — each clone explores a different layer
- Main assembles root cause from clone findings
- Charge cost = 2 (same as forking-realities)

### 2.1 Worktree Model

**Recommendation: Isolated worktrees (same as recon-swarm)**

| Option | Pros | Cons |
|--------|------|------|
| Shared worktree | Clones see each other's file edits in real-time | File contention; git state corruption; one clone's fix attempt could break another's investigation |
| Isolated worktrees (recommended) | Clean investigation per layer; clones can propose fixes without interference; existing infra works unchanged | No real-time file sharing — use bus broadcasts instead |

**Rationale:** Bug-hunt is primarily read-heavy investigation. Each clone investigates a different layer (frontend vs backend vs db). They don't need shared filesystem — they need shared **findings**. Bus broadcasts handle this.

If a clone proposes a fix, it commits to its own worktree branch. Main cherry-picks the winning fix after reviewing all investigation reports.

**Implementation:** No changes to `worktree.ts`. Use existing `addWorktree` with standard `clone-${id}` naming.

### 2.2 Task Contract Structure

The task contract for bug-hunt needs two additions to the standard contract:

```typescript
// In cloneAssignments (tasks.yaml):
A:
  task: "Investigate the authentication failure at the frontend/network layer"
  approach_hint: |
    Layer: frontend + network
    Bug: Users report intermittent 401 errors on dashboard load
    Reproduction: Login → navigate to /dashboard → observe console
    Focus: Check auth token handling, request headers, CORS config, network timing
  scope:
    allowed_paths: ["src/frontend", "src/shared", "docs"]
    forbidden_paths: [".manta/state", "secrets/"]
    max_files_changed: 5  # Allow fix proposals

B:
  task: "Investigate the authentication failure at the backend/db layer"  
  approach_hint: |
    Layer: backend + database
    Bug: Users report intermittent 401 errors on dashboard load
    Reproduction: Login → navigate to /dashboard → observe console
    Focus: Check session store, token validation, DB query timing, connection pool
  scope:
    allowed_paths: ["src/backend", "src/db", "src/shared", "docs"]
    forbidden_paths: [".manta/state", "secrets/"]
    max_files_changed: 5
```

**Key design decisions:**
- **Layer assignment via `approach_hint`**: Structured hint with `Layer:`, `Bug:`, `Reproduction:`, `Focus:` fields. The priming text instructs the clone to parse these.
- **Bug description in `task`**: One-sentence symptom description, same for all clones.
- **Reproduction steps in `approach_hint`**: How to reproduce the bug, shared across clones so each knows the full picture.
- **`max_files_changed > 0`**: Clones may propose fixes. Set to a small number (3–5) to prevent scope creep.
- **Per-clone scope restriction**: Each clone's `allowed_paths` matches its assigned layer. Prevents one clone from accidentally modifying files in another's layer.

### 2.3 Deliverable Format

Each clone produces two deliverables:

**1. Investigation report** (required): `docs/investigation/cast-<castId>-<cloneId>.md`

```markdown
# Bug Investigation — Clone A (frontend/network layer)

## Symptom
<Original bug description from task contract>

## Findings
### Finding 1: <title>
- **File:** src/frontend/auth/token-refresh.ts:42
- **Evidence:** <what was observed>
- **Confidence:** high/medium/low
- **Root cause likely?** yes/no

### Finding 2: ...

## Root Cause Hypothesis
<Clone's best guess at root cause, based on layer evidence>

## Proposed Fix
<If max_files_changed > 0 and clone has a fix>
- File: src/frontend/auth/token-refresh.ts
- Change: <description>
- Committed on branch: manta/<castId>/A

## Cross-Layer Dependencies
<What other layers should investigate>
- "Backend team should check if session.refresh() is called with stale token"
```

**2. Fix commits** (optional): If `max_files_changed > 0`, clone can commit proposed fixes to its worktree branch.

### 2.4 Merge Strategy

**Recommendation: No merge-review scoring. Main reads reports and cherry-picks.**

Bug-hunt is fundamentally different from forking-realities:
- **Forking-realities:** Competing solutions to the same problem → score and pick winner
- **Bug-hunt:** Complementary investigations of different layers → combine findings

The merge-review scoring pipeline (coverage delta, diff lines, complexity, lint) is meaningless for bug-hunt because:
1. Clones investigate different layers — their diffs aren't comparable
2. The "best" investigation might have 0 code changes (pure analysis)
3. Root cause assembly happens in the main agent, not in scoring

**Post-cast pipeline for bug-hunt:**

```
1. All clones reach DEAD
2. Main reads each clone's investigation report
3. Main assembles root cause from combined findings
4. If clones proposed fixes:
   a. Main evaluates which fix (if any) is correct
   b. Cherry-pick the winning fix branch
   c. Or write a new fix informed by all findings
5. Post-mortem as usual
```

**Implementation in cast.ts:**
```typescript
// Line 427: replace the forking-realities guard with mode-aware dispatch
if (opts.mode === 'forking-realities' && !loopResult.aborted) {
  // existing merge-review pipeline
} else if (opts.mode === 'bug-hunt' && !loopResult.aborted) {
  // bug-hunt: no merge-review. Log where investigation reports are.
  opts.reporter.info('cast.bug_hunt_complete', {
    cast: opts.castId,
    cloneIds,
    message: 'Review investigation reports in docs/investigation/',
  });
}
```

### 2.5 Mode-Specific Priming Text

Add a new block in `priming.ts` for bug-hunt mode:

```typescript
const bugHuntBlock = snapshot.taskContract.mode === 'bug-hunt'
  ? `\nBug-hunt investigation protocol:
1. Read the layer assignment, bug description, and reproduction steps from your approach_hint.
2. Investigate systematically: grep for relevant code paths, read logs, trace data flow.
3. After each significant finding, broadcast it immediately so sibling clones can cross-reference:
   manta.broadcast({ clone_id: "${snapshot.taskContract.cloneId}", event_type: "finding", payload: { layer: "<your-layer>", title: "<finding-title>", confidence: "high|medium|low", detail: "<1-2 sentences>" } })
4. Write your investigation report to docs/investigation/cast-${snapshot.castId}-${snapshot.taskContract.cloneId}.md before shutdown.
5. If you identify a fix, commit it to your branch. Describe the fix in your investigation report.
6. If your findings point to another layer, note it in the "Cross-Layer Dependencies" section.
`
  : '';
```

**Key additions vs recon-swarm priming:**
- Instructs clones to broadcast findings in real-time (not just at shutdown)
- Specifies the investigation report format and output path
- Encourages cross-layer dependency noting

### 2.6 Bus Coordination: Sharing Findings Between Clones

**Mechanism: `manta.broadcast` with event_type `"finding"`**

Bug-hunt clones should share intermediate findings via broadcasts. This is already supported by the bus infrastructure — broadcasts are mode-agnostic (see §1.4).

**How it works:**
1. Clone A discovers a finding → calls `manta.broadcast({ clone_id: "A", event_type: "finding", payload: { layer: "frontend", title: "stale token in refresh", confidence: "high", detail: "..." } })`
2. The broadcast lands in `events.jsonl`
3. Clone B can read `events.jsonl` via `manta.events.readAll()` (or the bus exposes it through the events tool) to see Clone A's findings and adjust its own investigation
4. Main reads all findings at the end to assemble root cause

**Does Clone B actually read events?** Currently, clones **cannot** proactively read `events.jsonl` via MCP — there's no `manta.events.read` tool exposed. Clones would need to:
- Read the raw `events.jsonl` file from `.manta/state/events.jsonl` (forbidden by scope: `.manta/state` is in `forbiddenPaths`)
- Or have a new MCP tool: `manta.events.read` (recommended addition)

**Recommendation: Add `manta.events.read_broadcasts` MCP tool:**

```typescript
// New tool in packages/manta-bus/src/tools/
async readBroadcasts(input: { clone_id: string; event_type?: string }): Promise<{ events: BusEvent[] }> {
  const all = await ctx.events.readAll();
  return {
    events: all.filter(e =>
      e.type === 'broadcast' &&
      e.clone_id !== input.clone_id && // exclude own broadcasts
      (!input.event_type || (e.payload as any)?.event_type === input.event_type)
    ),
  };
}
```

This lets clones read sibling findings without accessing `.manta/state` directly. The filter by `event_type` allows clones to specifically query for `"finding"` broadcasts.

**Alternative (simpler, no new tool):** Relax `forbiddenPaths` for bug-hunt to allow read-only access to `.manta/state/events.jsonl`. Downside: breaks the principle that `.manta/state` is always forbidden.

**Recommended approach:** New MCP tool. It's 15–20 lines and stays within the existing bus tool pattern.

### 2.7 Cast Policy for Bug-Hunt

| Policy field | Value | Rationale |
|--------------|-------|-----------|
| `peer_messaging` | `'allowed'` | Clones should share findings via both broadcasts and direct messages |
| `auto_merge_threshold` | `null` | No auto-merge — main reviews investigation reports manually |

**MANTA_BUS_PEER_SCOPE env var:** `'siblings-allowed'` (same as recon-swarm)

### 2.8 Clone Count and Layer Assignment

Per spec: 1–2 clones. Recommended UX:

```bash
# 2-clone bug-hunt with explicit layer assignment
manta cast bug-hunt \
  --task "Users report intermittent 401 errors on dashboard load" \
  --tasks bug-hunt-layers.yaml \
  --clones 2

# 1-clone bug-hunt (single deep investigation)
manta cast bug-hunt \
  --task "Memory leak in worker process after 24h uptime" \
  --clones 1
```

**Layer assignment via tasks.yaml** (same format as forking-realities):
```yaml
A:
  approach_hint: |
    Layer: frontend + network
    Focus: auth token handling, CORS, request timing
B:
  approach_hint: |
    Layer: backend + database
    Focus: session store, token validation, connection pool
```

No new CLI flags needed — the existing `--tasks` flag handles per-clone assignment.

### 2.9 Charge System Integration

Already complete:
- `MODE_CHARGE_COST['bug-hunt'] = 2` (`packages/manta-bus/src/schema.ts:281`)
- `CHEAPER_MODE_MAP['bug-hunt'] = 'recon-swarm'` (`packages/manta-cli/src/budget/auto-downgrade.ts:23`)
- Budget config estimate: `'bug-hunt': 3.00` (`packages/manta-cli/src/config/budget-config.ts:35`)
- `CastOutcomeClassifier` is mode-agnostic — works for bug-hunt without changes
- `PreSpawnGate` dispatches via `MODE_CHARGE_COST[mode]` — works for bug-hunt without changes

### 2.10 Implementation Checklist

| # | Task | File(s) | Est. lines | Depends on |
|---|------|---------|------------|------------|
| 1 | Add `'bug-hunt'` to `SUPPORTED_MODES` | `cast.ts:29` | 1 | — |
| 2 | Set `peer_messaging: 'allowed'` for bug-hunt | `cast.ts:248–251` | 2 | 1 |
| 3 | Set `MANTA_BUS_PEER_SCOPE: 'siblings-allowed'` | `clone-spawner.ts:153` | 1 | 1 |
| 4 | Add bug-hunt priming block | `priming.ts` | 15 | 1 |
| 5 | Add `readBroadcasts` MCP tool | `bus/src/tools/communication.ts` + schema | 25 | — |
| 6 | Add post-cast bug-hunt pipeline (reporter log) | `cast.ts:427+` | 10 | 1 |
| 7 | Unit tests for bug-hunt cast dispatch | `cast.test.ts` | 30 | 1–6 |
| 8 | Unit tests for bug-hunt priming | `priming.test.ts` | 15 | 4 |
| 9 | Unit test for readBroadcasts | `communication.test.ts` | 20 | 5 |
| 10 | Integration test for bug-hunt lifecycle | `tests/integration/` | 50 | 1–6 |
| 11 | E2E test for bug-hunt | `manta-e2e/tests/bug-hunt.e2e.test.ts` | 200 | all |

**Total estimated:** ~370 lines of production code + tests.

### 2.11 Open Questions

1. **Should investigation reports be structured (YAML/JSON) or freeform markdown?** Recommendation: freeform markdown with required sections (Symptom, Findings, Root Cause Hypothesis, Proposed Fix, Cross-Layer Dependencies). The priming text specifies the template; enforcement is soft (clone may deviate).

2. **Should the `readBroadcasts` tool filter by cast_id?** Yes — a clone should only see broadcasts from its own cast, not from concurrent casts. The filter should use `(e.payload as any)?.cast_id === callerCastId`.

3. **Should bug-hunt support >2 clones?** Spec says 1–2, but the infrastructure supports up to 5 (`CLONE_NAMES` ceiling). Recommendation: enforce 1–2 in the `cast.ts` mode-specific validation, with an override flag `--force-clones` for power users.

4. **ForensicTimelineWriter event types:** No new event types needed for bug-hunt. The existing `broadcast`, `heartbeat`, `post_mortem` events are sufficient. If Clone B reads Clone A's findings, that's a read operation (no event emitted). The investigation report is a file commit, not a bus event.

---

## Appendix: File Reference Index

| File | Package | Lines | Role |
|------|---------|-------|------|
| `packages/manta-cli/src/commands/cast.ts` | manta-cli | 550 | Mode dispatch, spawn loop, post-cast pipeline |
| `packages/manta-cli/src/spawner/clone-spawner.ts` | manta-cli | 292 | Pre-registration, snapshot write, runner launch |
| `packages/manta-cli/src/spawner/priming.ts` | manta-cli | 45 | Mode-specific priming text generation |
| `packages/manta-cli/src/spawner/worktree.ts` | manta-cli | 82 | Git worktree add/remove/list |
| `packages/manta-bus/src/tools/forking-isolation.ts` | manta-bus | 37 | Forking-realities peer isolation checks |
| `packages/manta-bus/src/tools/communication.ts` | manta-bus | 72 | Broadcast/message/driftReport handlers |
| `packages/manta-bus/src/schema.ts` | manta-bus | 377 | ModeSchema, MODE_CHARGE_COST, all Zod schemas |
| `packages/manta-bus/src/state/paths.ts` | manta-bus | 59 | BusPaths — all state file locations |
| `packages/manta-orchestrator/src/orchestrator.ts` | manta-orchestrator | 88 | runCycle — death detection, reaping, post-mortem |
| `packages/manta-orchestrator/src/merge-review.ts` | manta-orchestrator | 269 | Merge-review pipeline (forking only) |
| `packages/manta-orchestrator/src/scoring.ts` | manta-orchestrator | 262 | Normalize → rank → tie-break scoring |
| `packages/manta-orchestrator/src/post-mortem.ts` | manta-orchestrator | 107 | Post-mortem markdown generation |
| `packages/manta-orchestrator/src/forensic-timeline.ts` | manta-orchestrator | 105 | NDJSON timeline writer/reader |
| `packages/manta-cli/src/budget/cast-outcome.ts` | manta-cli | 39 | CastOutcomeClassifier |
| `packages/manta-cli/src/budget/auto-downgrade.ts` | manta-cli | 70 | AutoDowngradeAdvisor |
| `packages/manta-cli/src/budget/pre-spawn-gate.ts` | manta-cli | ~80 | Pre-spawn charge + budget gate |
| `packages/manta-e2e/tests/recon-swarm.e2e.test.ts` | manta-e2e | 244 | E2E: recon-swarm 2-clone lifecycle |
| `packages/manta-e2e/tests/forking-realities.e2e.test.ts` | manta-e2e | 285 | E2E: forking-realities + merge-review |

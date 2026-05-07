# Phase 2 Codepath Map — `forking-realities` Hooks

**Author:** clone-A of cast `cast-1778187665150` (recon-swarm research-prep)
**Scope:** identify every codepath that needs to bend or extend so
`forking-realities` mode (spec Sec 2 #2 + Sec 7 best-of-N + Sec 5.8
plagiarism prevention) can ship production-grade on top of the Phase-0/1
foundation.
**Method:** read-only audit of `packages/manta-cli`, `packages/manta-bus`,
`packages/manta-orchestrator`, `packages/manta-snapshot`, plus the spec.
No code mutations.
**Reference commit:** `9ed5609` (heartbeat-90s fix shipped).

---

## 0. TL;DR — what changes vs Phase 0/1

| Area | Phase 0/1 reality | Phase 2 ask | Edit shape |
|---|---|---|---|
| Per-clone task differentiation | All clones get the **same** `--task` string; the spawner clones one snapshot per `cloneId` (cast.ts:140-141, snapshot-builder.ts:36) | Each clone needs a **distinct** approach + optional per-clone `forbidden_paths` to enforce divergence | Extend `RunCastOptions.task` to accept either `string` or `Record<CloneId, CloneTaskFragment>`; thread per-clone `approachHint` through `buildCloneSnapshot` (already a no-op-supporting field, snapshot/schema.ts:30) |
| Worktree isolation | Already per-clone — `manta/${castId}/${cloneId}` (cast.ts:135) | Already correct | None — verified below §3 |
| Bus visibility between siblings | `manta.message` is wide open (communication.ts:26-40); `manta.broadcast` writes to events.log but no MCP **read-events** tool exists, so siblings can't see each other's broadcasts today | Block sibling-to-sibling `manta.message` for any `forking-realities` cast; preserve main↔clone | Cast-aware filter inside `createCommunicationHandlers` (communication.ts:12) using `Registry.get(from).metadata.cast_id` |
| Best-of-N merge | No code path exists — orchestrator only writes a per-clone post-mortem and exits (post-mortem.ts:32, orchestrator.ts:41-49) | Need a cast-level finalisation step after **all** clones in the cast are DEAD that runs scoring + presents diffs to main | New `runMergeReview` invoked from `Orchestrator.runCycle` once `deadClones` covers a full cast; new `manta-merge-review` skill on the main side |
| Graveyard / worktree retention | Successful casts keep worktrees (cast.ts:282-285); failure path tears them down (cast.ts:266-278). No graveyard concept. | Need `keep winner / archive losers` after merge-review picks a winner | New worktree mover (`packages/manta-cli/src/spawner/graveyard.ts`); orchestrator-or-cli decides on policy after merge-review |
| Tier 3-4 observability | Events log on disk (events.ts:7-99), post-mortems on disk (post-mortem-writer.ts:37) — both present. No CLI surface. | `/manta tail`, `/manta replay`, `/manta audit` commands | Add `EventsLog.tail(since)` style streaming + 3 new commands wired into `bin/manta.ts` |

---

## 1. Spawn path — what's hard-coded around "all clones do the same thing"

### 1.1 The clone-naming + count gate

`packages/manta-cli/src/commands/cast.ts:14-15`

```ts
const SUPPORTED_MODES: ReadonlySet<Mode> = new Set<Mode>(['recon-swarm']);
const CLONE_NAMES: readonly string[] = ['A', 'B', 'C', 'D', 'E']; // Phase 0 ceiling = 5
```

`SUPPORTED_MODES` rejects every mode but `recon-swarm` (cast.ts:73-78). For
Phase 2 this becomes either `new Set(['recon-swarm', 'forking-realities'])`
or — better — a per-mode capability table (modes whose siblings collaborate
vs modes whose siblings compete). The 1..5 ceiling at cast.ts:80-88 is
fine for Phase 2 (forking-realities is N ∈ {2, 3} per the research-prep
plan).

### 1.2 The spawn loop — same task, same scope, only `cloneId` varies

`packages/manta-cli/src/commands/cast.ts:130-181`

```ts
const cloneIds = CLONE_NAMES.slice(0, opts.cloneCount);
…
for (const cloneId of cloneIds) {
  const wt = await addWorktree({ … branch: `manta/${opts.castId}/${cloneId}` });
  worktrees.push(wt);
  const snap = buildCloneSnapshot({
    cloneId,
    mode: opts.mode,
    task: opts.task,                 // ← SHARED — single string, all clones see the same
    scope: { …opts.scope ?? DEFAULT_SCOPE },  // ← SHARED — same allowedPaths/forbiddenPaths
    siblingClones: cloneIds.filter((id) => id !== cloneId),
    deadlineMs: DEFAULT_DEADLINE_MS,  // ← SHARED — 20 min for everyone (cast.ts:16)
    …
    budgetUsd: opts.budgetUsdPerClone, // ← SHARED — uniform
  });
  …
  const handle = await spawnClone({ …, snapshot: snap, … });
  …
}
```

**Hard-coded assumptions of "everyone does the same":**

1. **Task string is shared** (cast.ts:141). The research-prep plan already
   warns: *"the v1 CLI does not yet take a per-clone task array — only a
   single `--task` string"* (research-prep §"Note", line 50). Phase 2
   needs `task: string | { [cloneId: string]: { task: string; approachHint?: string } }`.
2. **Scope is shared** (cast.ts:145-149). `forking-realities` will commonly
   want different `forbiddenPaths` per clone (clone A "must not touch sql/"
   to force algorithmic approach; clone B free to rewrite sql/). Today
   `RunCastOptions.scope` is a single object, applied uniformly.
3. **`approachHint` is never set** (snapshot-builder.ts:38: `approachHint: req.approachHint ?? null`).
   The schema accepts it (snapshot/schema.ts:30 `approachHint: z.string().nullable()`)
   and the bus accepts it (bus/schema.ts:73 `approach_hint: z.string().max(8_000).optional()`),
   and `cast.ts:310-313` already round-trips it across the snapshot ⇄ bus
   boundary. **The plumbing is ready; the spawn surface just doesn't accept it.**
4. **`siblingClones` is auto-derived from `cloneIds`** (cast.ts:150) which
   is fine for Phase 2 — but note the spec's plagiarism prevention
   (Sec 5.8) wants siblings *not visible* via the Bus during the cast.
   `siblingClones` is purely a label in the contract — clones don't use
   it to *contact* each other, only to know they exist. Safe.
5. **Mode is shared per cast** (cast.ts:140) — that's correct; mixing modes
   in one cast is `combo` (Sec 2 metarodes) and out of Phase 2 scope.
6. **Budget is uniform per clone** (cast.ts:160). For best-of-N this is
   acceptable — symmetric judging requires symmetric resources.

### 1.3 The pre-registration call — already cast-aware

`packages/manta-cli/src/spawner/clone-spawner.ts:80-93`

```ts
await opts.registry.register({
  clone_id: cloneId,
  mode: opts.snapshot.taskContract.mode,
  parent_pid: process.pid,
  worktree: opts.worktree,
  metadata: { cast_id: castId },     // ← key insight: cast_id is on Registry
});
```

**This is a load-bearing detail for §4.** `Registry.metadata.cast_id` is
already populated for every clone, so any handler that wants to ask
"are A and B in the same cast?" can do `(await registry.get('A')).metadata.cast_id === (await registry.get('B')).metadata.cast_id`.
No schema change needed.

What the registry **doesn't** know yet: the cast's *mode*. It knows the
clone's mode (registry.ts:32-58 stores `input.mode`), but for Phase 2 the
filter in §4 needs to know "this is a forking-realities cast" without a
round-trip through every sibling. Fix is mechanical: add `cast_mode` to
`metadata` (already a `Record<string, string>` per bus/schema.ts:33), or
walk the sibling — both work.

### 1.4 The priming preamble — text-substituted per clone

`packages/manta-cli/src/spawner/priming.ts:18-22`

```ts
return PRIMING_TEMPLATE.replaceAll('{CLONE_ID}', snapshot.taskContract.cloneId)
  .replaceAll('{CAST_ID}', snapshot.castId)
  .replaceAll('{MODE}', snapshot.taskContract.mode);
```

Already per-clone substituted, so a Phase-2 clone can see its own
`cloneId` and `mode` from the very first system-prompt line. Adding a
new placeholder for `approach_hint` is a one-line edit (priming.ts:3-16
template body + a fourth `.replaceAll` call).

### 1.5 The CLI flag surface

`packages/manta-cli/src/bin/manta.ts:46-117`

Today the CLI takes a single scalar `--task <string>`. Phase 2 needs one of:

- `--task-A "…" --task-B "…" --task-C "…"` (clean, but explodes the
  flag count and is awkward beyond N=3),
- `--tasks <jsonOrYamlPath>` (file with `[{cloneId, task, approachHint, forbiddenPaths}]`),
  or
- a new top-level `manta cast forking-realities <plan-file>` subcommand
  whose argument is a YAML matching spec Sec 5.1's contract literally.

Recommendation **(scope: not a code change for this clone — captured for
Phase 2 plan)**: option 3. The spec already defines a YAML shape for the
contract; reusing it removes "how is this configured?" from the design
surface.

---

## 2. Snapshot path — TaskContract extension surface

### 2.1 What's already there

`packages/manta-snapshot/src/schema.ts:25-33`

```ts
export const TaskContractSchema = z.object({
  cloneId: z.string().min(1),
  mode: ModeSchema,
  task: z.string().min(1),
  scope: ScopeSchema,
  approachHint: z.string().nullable(),    // ← present, never set today
  siblingClones: z.array(z.string().min(1)),
  deadlineSeconds: z.number().int().positive(),
});
```

`packages/manta-bus/src/schema.ts:67-77` (the on-disk wire format)

```ts
export const TaskContractSchema = z.object({
  clone_id: CloneIdSchema,
  mode: ModeSchema,
  task: z.string().min(1).max(8_000),
  scope: ScopeSchema,
  approach_hint: z.string().max(8_000).optional(),  // optional in bus, nullable in snapshot — drift, see §2.3
  sibling_clones: z.array(CloneIdSchema).default([]),
  deadline_ms: z.number().int().positive(),
}).strict();
```

Translation between the two lives in `cast.ts:295-314` (`toBusContract`).

### 2.2 Per-clone `forbiddenPaths` — already supported

`packages/manta-snapshot/src/schema.ts:19-23`

```ts
export const ScopeSchema = z.object({
  allowedPaths: z.array(z.string().min(1)).min(1),
  forbiddenPaths: z.array(z.string().min(1)),
  maxFilesChanged: z.number().int().nonnegative(),
});
```

The schema is per-clone-capable; only the spawn surface is not (see §1.2
point 2). `Scope` is per-`Snapshot.taskContract`, never global — so when
the cast spawn loop builds the snapshot it can pass a different `Scope`
per `cloneId`. **Zero schema changes required.**

### 2.3 What needs extension

1. **Per-clone hint plumbing.** `RunCastOptions.scope` (cast.ts:36-46) and
   `--task` (bin/manta.ts:49) both need a fan-out. Suggest a new typed
   field `RunCastOptions.cloneAssignments?: Record<CloneId, CloneAssignment>`
   where `CloneAssignment = { task?: string; approachHint?: string; scope?: CastScopeOptions; budgetUsd?: number; deadlineSeconds?: number }`,
   merged on top of the cast-level defaults at the spawn loop. Strictly
   additive — `recon-swarm` callers ignore it.
2. **`approach_hint` nullable-vs-optional drift** between snapshot and bus
   schemas. The translation at cast.ts:310-313 already handles it
   (omits the field when `null`), but a Phase 2 reviewer should confirm
   this stays correct when `approachHint` is set to an empty string vs
   `null` — current contract is "non-null wins, null elides", which is
   fine but worth a unit test in `cast.ts` against the bus-side parse.
3. **Cast-level metadata.** Today `Snapshot` has `castId` (snapshot/schema.ts:64)
   and the registry record has `metadata.cast_id` (clone-spawner.ts:86),
   but **there is no per-cast manifest** — no place to record "this cast
   is forking-realities, the contestants are A/B/C, the merge policy is
   composite-weighted." Phase 2 needs one. Recommended location:
   `.manta/state/casts/<castId>.json` (matches `BusPaths` shape in
   `packages/manta-bus/src/state/paths.ts`). Owner: bus, not orchestrator —
   it's state, not policy.

### 2.4 What does **not** need extension

- `Snapshot.recentMessages`, `activeTodos`, `openFiles` — irrelevant to
  forking-realities, can stay empty as today (snapshot-builder.ts:42-44).
- `Snapshot.parentPid`, `parentSessionId`, `parentWorktree` — same
  semantics across modes.
- `Snapshot.budget` — same shape, just per-clone-different values.

---

## 3. Worktree path — verified per-clone-ready

`packages/manta-cli/src/spawner/worktree.ts:23-32`

```ts
export async function addWorktree(opts: AddWorktreeOptions): Promise<WorktreeRecord> {
  if (!SAFE_NAME.test(opts.name)) {
    throw new Error(`unsafe worktree name: ${opts.name}`);
  }
  const wtPath = path.join(opts.repoRoot, '.manta', 'worktrees', opts.name);
  await execa('git', ['worktree', 'add', '-b', opts.branch, wtPath, 'HEAD'], { cwd: opts.repoRoot });
  return { path: wtPath, branch: opts.branch };
}
```

Caller, `cast.ts:132-137`:

```ts
const wt = await addWorktree({
  repoRoot: rt.repoRoot,
  name: `clone-${cloneId}`,
  branch: `manta/${opts.castId}/${cloneId}`,
});
```

**Already correct for Phase 2.**

- Each clone gets its own worktree path: `.manta/worktrees/clone-<id>` —
  confirmed isolated per clone, branch namespaced with castId so two
  concurrent casts can't collide.
- Branch naming is `manta/<castId>/<cloneId>` — matches spec Sec 4
  "Worktree isolation" guarantee.
- `removeWorktree` (worktree.ts:34-44) already does `git worktree remove --force`
  + best-effort `git branch -D`, suitable for graveyard / drop / abort.
- `listWorktrees` (worktree.ts:46-64) parses `git worktree list --porcelain`,
  gives Phase 2's graveyard cleanup what it needs to find the survivors.

**Only thing missing for Phase 2:** a `moveWorktreeToGraveyard(repoRoot, src, dst)`
helper. Not present today (grep `graveyard|exhume` matches only doc
strings: `cast.ts:284`, `ARCHITECTURE.md:49`). Cleanest cut: new
function in `worktree.ts` using `git worktree move <src> <dst>` plus a
metadata sidecar at `.manta/graveyard/<cloneId>/info.json`. Spec Sec 7
asks for 3-day retention — an orchestrator timer or a `manta exhume`
scheduled job, not part of the live cast cycle.

---

## 4. Bus filter point — smallest cut for plagiarism prevention (Sec 5.8)

### 4.1 The current API surface

The 18 MCP tools wired in `packages/manta-bus/src/server.ts:115-224`
fall into 6 families. The only ones that move information **between
clones in the same process-tree** are:

1. `manta.broadcast` (server.ts:194-199 → communication.ts:16-24) —
   appends to events.log only.
2. `manta.message` (server.ts:200-205 → communication.ts:26-40) —
   appends to events.log only, with a registry liveness check on both
   `from_clone_id` and `to_clone_id`.

There is **no MCP tool that lets a clone read events.log**. Confirmed:
the tool table at server.ts:115-224 has zero "read events" or "list
broadcasts" entries; `EventsLog.readAll` (events.ts:63-93) is only
called by `runPostMortem` (post-mortem.ts:44) and tests. Sibling clones
**cannot today read each other's broadcasts** through any official path.

This means the Sec 5.8 risk surface is narrower than the spec implies:

- `manta.broadcast`: today **already plagiarism-safe** (write-only from
  clone perspective; orchestrator + post-mortem are the only readers).
  Risk reappears the moment Phase 2 adds `/manta tail` (Tier 3) or
  `/manta replay` (Tier 4) — both of which need a Bus reader. **Filter
  point goes there**, not in the broadcast handler.
- `manta.message`: **the real plagiarism vector today.** A clone in a
  `forking-realities` cast could DM its sibling and exfiltrate a draft.
- `manta.zk_write` / `manta.para_append`: write to `MemoryWriters` (a
  filesystem layer at the project root, see `packages/manta-bus/src/memory-writers.ts`).
  Siblings could in principle read each other's ZK notes if they grep
  the filesystem. The skill + scope-enforcement keep them out, but for
  Phase 2 a defensive option is to **prefix ZK note filenames with the
  cast_id** during a `forking-realities` cast and visibly tag them so
  graceful-death readers can join them up later. Not strictly required
  for plagiarism prevention since the disk view is non-MCP — but worth
  noting.

### 4.2 The smallest cut

**Single-file edit, communication.ts:**

`packages/manta-bus/src/tools/communication.ts:26-40` (the `message`
handler) — add a pre-flight that:

1. Reads `from = ctx.registry.get(parsed.from_clone_id)` and
   `to = ctx.registry.get(parsed.to_clone_id)` (already done at lines 32-33).
2. If both have a `metadata.cast_id` and they match, **and** either
   clone's `mode` is `forking-realities`, throw
   `BusConflictError('forking-realities cast: sibling-to-sibling messaging is forbidden during the cast (Sec 5.8)')`.
3. Main → clone messages survive because the main is **not** in the
   registry; the message handler hits `not_found` only if the *named
   from/to* is unknown, and the main currently has no `clone_id`. (Spec
   Sec 5.7 anchor sync uses `manta.contract_refresh`, which has no
   `from_clone_id` — see contract.ts:61-71. That path is unaffected.)

That's a ≤10-line change inside `createCommunicationHandlers`'s
`message` closure plus the matching unit test in
`packages/manta-bus/tests/communication.test.ts` (file exists per the
test sweep numbers in INDEX.md — Phase 0b coverage is 99 %).

### 4.3 What's needed in `Registry.metadata` for this to work

**Nothing new.** `cast_id` is already there (clone-spawner.ts:86). To
let the filter check the cast's *mode* without a sibling round-trip,
Phase 2 should add `cast_mode` alongside `cast_id` in the metadata
record. `metadata` is `Record<string, string>` (bus/schema.ts:33), so
the additive change is:

```diff
  await opts.registry.register({
    clone_id: cloneId,
    mode: opts.snapshot.taskContract.mode,
    parent_pid: process.pid,
    worktree: opts.worktree,
-   metadata: { cast_id: castId },
+   metadata: { cast_id: castId, cast_mode: opts.snapshot.taskContract.mode },
  });
```

(Yes, `cast_mode === clone.mode` for any single-mode cast — the
duplication is intentional so the filter can branch on cast policy
without joining `siblingClones` against the registry, which would be a
hot path under heavy `manta.message` traffic.)

### 4.4 The *forward-compatible* cut

For Phase 2 plus future modes that also want partial-isolation
(`council`, `decoy`), bake the policy into the cast manifest (see §2.3
point 3) instead of branching on `mode === 'forking-realities'`:

```ts
// Pseudocode for the manifest-driven filter:
const cast = await ctx.casts.get(from.metadata.cast_id);
if (cast.policy.peerMessaging === 'denied' && from.metadata.cast_id === to.metadata.cast_id) {
  throw new BusConflictError(`cast ${cast.id} policy "peerMessaging=denied"`);
}
```

This is the form I'd recommend in the Phase 2 plan. Pinning on
`mode === 'forking-realities'` is fine for Phase 2 day 1; the manifest
is the durable cut.

---

## 5. Orchestrator merge-review hook

### 5.1 Where post-mortem fires today

`packages/manta-orchestrator/src/orchestrator.ts:31-66`

```ts
async runCycle(): Promise<CycleResult> {
  …
  const deadClones = await findDeadClones(this.opts.ctx, { thresholds, probe });
  const lockResult = await reapLocks(this.opts.ctx);
  const claimResult = await reapClaims(this.opts.ctx);
  const postMortems: RunPostMortemResult[] = [];
  for (const dead of deadClones) {
    const pm = await runPostMortem(this.opts.ctx, {
      cloneId: dead.clone_id,
      reason: dead.reason,
      writer: this.opts.writer,
      thresholds: this.opts.thresholds,
    });
    postMortems.push(pm);
  }
  …
}
```

`runPostMortem` (post-mortem.ts:32-60) does three things:
1. `markDead` if not already (post-mortem.ts:39-42).
2. Render a per-clone markdown file via the injected writer
   (`fsPostMortemWriter` resolves to `docs/post-mortems/<day>-<castId>-<cloneId>.md`,
   post-mortem.ts:47-49 + post-mortem-writer.ts:43-50).
3. Append a `post_mortem` event to the events log
   (post-mortem.ts:54-58).

### 5.2 Where merge-review needs to plug in

A `forking-realities` cast finalisation requires **all clones in the
cast to be DEAD** before merge-review fires — otherwise we're scoring an
incomplete tournament. The orchestrator currently has no notion of
"cast" at this layer; it iterates `deadClones` flat. The Phase 2 hook
shape:

```ts
// orchestrator.ts:41-49 becomes (sketch):
for (const dead of deadClones) {
  const pm = await runPostMortem(…);
  postMortems.push(pm);
}
// NEW: cast-level finalisation pass.
const finalisedCasts = await findFinalisedCasts(this.opts.ctx, { allDeadCloneIds });
for (const cast of finalisedCasts) {
  const review = await runMergeReview(this.opts.ctx, {
    castId: cast.id,
    policy: cast.policy,         // from the manifest §2.3
    writer: this.opts.mergeReviewWriter,
  });
  mergeReviews.push(review);
}
```

`findFinalisedCasts` reads the cast manifest (§2.3) plus
`Registry.list()` and emits each cast whose every clone is now DEAD and
which has no `merge_review` event recorded against it yet (idempotency:
must be safe under cycle re-runs). `runMergeReview` is a new module
parallel to `post-mortem.ts`; it's where Sec 7's "composite scoring"
lives and where clone-B's research output (`docs/research/phase-2-best-of-n-patterns.md`)
becomes load-bearing.

### 5.3 What the events log already gives merge-review for free

Every clone's complete event timeline is already in events.log
(events.ts:7-99) and per-clone-filterable (post-mortem.ts:45). For a
Phase-2 merge-review:

- Grade test pass-rate? Read `broadcast` events of type `breakthrough`
  with payload `{ kind: "test-pass" }` (clones can opt into emitting
  these without any new MCP tool — `manta.broadcast` already exists).
- Grade diff size? Read the worktree (worktree.ts:46-64 gives the path),
  shell out to `git diff --stat manta/<castId>/<cloneId> main`. No bus
  changes.
- Grade coverage delta? Same — read the worktree, run the project's
  coverage tool, compare.
- Grade complexity? Static analysis on the changed files in the
  worktree. No bus changes.

**The orchestrator does not need to invent a new data plane for
merge-review — it already has events.log + worktrees + post-mortems.**
Merge-review is pure orchestration over those three sources.

### 5.4 Where the winner-pick lands

Spec Sec 7 says "мейн выбирает один". Today the main agent **is** the
calling Claude Code session — the orchestrator runs in its process tree
(via the runtime composer, runtime.ts:39-90). So the merge-review write
target is a markdown file (e.g. `docs/merge-reviews/<castId>.md`) that
the main session reads at the next turn boundary. Same pattern as
post-mortems. No daemon needed; this stays Wave-1 compatible.

---

## 6. Observability gaps — Tier 3 (`tail`) and Tier 4 (`replay` / `audit`)

### 6.1 What exists

| Tier | Surface today | Code path |
|---|---|---|
| 0 (passive) | `manta status` returns clones+locks+claims (status.ts:12-28); no statusline yet | `bin/manta.ts:120-124` → `runStatusCommand` (commands/status.ts) |
| 1 (on-demand) | Same `manta status` is also Tier 1 — terminal output via `output/status-table.ts` | same |
| 2 (deep dive) | **Missing** — no `/manta inspect <id>` command. CLI has `cast/status/kill/abort/recover` only (bin/manta.ts:45-152) | absent |
| 3 (real-time) | **Missing** — no streaming / no `/manta tail <id>` | absent |
| 4 (forensic) | **Partial** — post-mortems written to `docs/post-mortems/` (post-mortem-writer.ts:37-53); events.log on disk; no `/manta replay` or `/manta audit` CLI | partial — readers exist on disk, no CLI |

### 6.2 What `events.log` already gives for Tier 3-4

`packages/manta-bus/src/state/events.ts:7-99`

- Append-only JSONL, ordered, crash-tolerant (truncated last line is
  skipped with one warn — events.ts:79-91).
- Every state-changing tool call appends an event (lifecycle.ts,
  contract.ts, communication.ts all `events.append`). The post-mortem
  itself appends a `post_mortem` event (post-mortem.ts:54-58). So
  events.log is the **single source of truth** for cast forensics.
- `readAll` (events.ts:63-93) and `readSince(tsExclusive)` (events.ts:95-98)
  cover both `replay` (full) and `tail` (delta).

What's missing is the **streaming reader** for `tail` — `readSince` is
synchronous-snapshot, not a watcher. Two viable approaches:

1. **Polling** — `tail` polls `readSince(lastTs)` every N ms; trivial,
   no new code in the bus. Wastes some IO at idle. Fine for Phase 2.
2. **Filesystem watcher** — wrap `events.log` in `fs.watch` and emit
   diffs on change. Cleaner UX, but `fs.watch` semantics differ across
   macOS/Linux and are a known footgun. **Defer.**

Recommendation: ship `tail` as a polling reader in Phase 2 (`fs.read` +
seek-from-last-ts), note "watcher upgrade Phase 5+" in the plan.

### 6.3 What needs to be built

| Feature | Code shape | New files | Existing primitives |
|---|---|---|---|
| `/manta tail <cloneId>` | New command in `packages/manta-cli/src/commands/tail.ts`; wraps `EventsLog.readSince` in a polling loop with optional `--clone-id` filter | tail.ts, bin/manta.ts wiring | EventsLog.readSince (events.ts:95-98) |
| `/manta inspect <cloneId>` | New command; reads `Registry.get(cloneId)` + `Contracts.read(cloneId)` + last 20 events for that clone via `EventsLog.readAll().filter` | inspect.ts | Registry.get (registry.ts:116-121), ContractsStore.read (already exposed via contract.ts:38-42), EventsLog.readAll |
| `/manta replay <castId>` | New command; reads events.log, filters by `payload.cast_id` or by joining clones via `Registry`, prints in time-order | replay.ts | Same — pure consumer of events.log |
| `/manta audit <cloneId>` | New command; reads events.log + post-mortem markdown for the clone; emits a single audit-grade markdown | audit.ts | events.log + fs read of `docs/post-mortems/` |
| Statusline (Tier 0 polish) | Hook into Claude Code statusline-setup; reads `manta status` JSON; emits 1-line glyph string per spec Sec 3 Phase-2 | docs in `commands/`, no package change | `runStatusCommand` |

**Critical absent surface:** there is no MCP tool that lets a peer (the
caller's Claude Code session) read the events log without going through
the CLI. For `/manta tail` to work as a slash command inside the main
Claude session, the easiest path is to **shell out to `manta tail`**
rather than add a `manta.events_read` MCP tool — keeps the Bus's tool
table tight (still 18 entries) and matches the existing pattern (the
main reads post-mortems from disk too).

If the Phase 2 plan reverses that and prefers a `manta.events_read` MCP
tool, the safest shape is *cast-scoped* by default: `manta.events_read({ cast_id, since })`
returns only events whose payload's clone(s) belong to that cast. That
also reuses the §4 plagiarism filter pattern — same join key
(`metadata.cast_id`).

---

## 7. Cross-cut summary — files Phase 2 will touch

For the plan-writer's convenience. Each line is the smallest cut to
land the listed change; nothing here implies "rewrite this file".

| File | Phase 2 change |
|---|---|
| `packages/manta-cli/src/commands/cast.ts:14` | Allow `forking-realities` in `SUPPORTED_MODES` |
| `packages/manta-cli/src/commands/cast.ts:27-46` | Add `RunCastOptions.cloneAssignments?: Record<CloneId, CloneAssignment>`; thread through the spawn loop at lines 130-181 |
| `packages/manta-cli/src/commands/cast.ts:138-161` | Per-clone `task` / `scope` / `approachHint` overlay onto cast-level defaults |
| `packages/manta-cli/src/spawner/clone-spawner.ts:86` | Add `cast_mode` to registered metadata |
| `packages/manta-cli/src/spawner/priming.ts:3-22` | Add `{APPROACH_HINT}` substitution slot |
| `packages/manta-cli/src/spawner/worktree.ts` | Add `moveWorktreeToGraveyard` helper |
| `packages/manta-cli/src/bin/manta.ts:45-117` | Either add `--tasks <file>` or new `forking-realities` subcommand |
| `packages/manta-cli/src/bin/manta.ts:119-152` | Wire `inspect` / `tail` / `replay` / `audit` commands |
| `packages/manta-cli/src/commands/{inspect,tail,replay,audit}.ts` | New (Tier 2-4 observability) |
| `packages/manta-cli/src/runtime.ts:39-90` | Inject merge-review writer alongside post-mortem writer |
| `packages/manta-bus/src/tools/communication.ts:26-40` | Sibling-message filter for `forking-realities` casts |
| `packages/manta-bus/src/state/casts.ts` (new) | Cast manifest + `findFinalisedCasts` query |
| `packages/manta-bus/src/server.ts:115-224` | Optionally add `manta.events_read` (cast-scoped) — only if the slash-command path goes via MCP rather than shelling out |
| `packages/manta-orchestrator/src/merge-review.ts` (new) | Composite scoring + side-by-side renderer (depends on clone-B's deliverable) |
| `packages/manta-orchestrator/src/orchestrator.ts:41-49` | Add cast-finalisation pass after the dead-clone loop |
| `packages/manta-orchestrator/src/index.ts` | Re-export the new merge-review module |
| `skills/manta-merge-review/SKILL.md` (new) | Main-side skill matching the orchestrator's merge-review output (depends on clone-B's pattern recommendations) |
| `commands/manta-tail.md`, `manta-replay.md`, `manta-audit.md`, `manta-inspect.md` (new) | Slash commands for Tier 2-4 |

**No file in `@manta/snapshot` requires a schema bump.** The only
schema-side work is the cast manifest (new file) and one optional
metadata key (`cast_mode`).

---

## 8. Risks the plan should explicitly hedge

1. **The 1..5 ceiling** (cast.ts:80-88) is fine for the {2, 3} we need,
   but the cumulative budget gate at cast.ts:93-101 is uniform: `clones
   × per-clone cap`. For asymmetric clone budgets (allowed by §1.2
   point 6 if we add it), the gate must be `Σ(per-clone caps)`, not
   `N × cap`. Easy edit; flag it.
2. **`approach_hint` size limit** at bus/schema.ts:73 is 8 KB. For a
   `forking-realities` "explain your strategy in one paragraph" hint
   that's plenty, but for "here's a long worked example" it's not.
   Decide before plan freeze.
3. **Plagiarism prevention via filesystem.** Even with the §4 message
   filter, sibling clones share the parent repo's filesystem (only
   their own `.manta/worktrees/clone-X` is exclusive). A clone could
   `cd ../clone-B && cat …` if it wanted to. Spec Sec 5.5 (anti-gossip)
   + Sec 5.8 are skill-level enforcements. Phase 5+ PreToolUse hooks
   could add a filesystem-level guard; for Phase 2 this stays a
   skill-discipline matter, and the Phase-1 lockdown post-mortem (the
   ZK-adherence regression family, bug #5) is a sober reminder that
   skill discipline is **not 100 %**. Acknowledge this risk in the
   plan; do not pretend the §4 filter solves it.
4. **Cycle-time blow-up.** Today `runCycle` is O(N_active_clones) per
   cycle (orchestrator.ts:34-49). Adding cast-finalisation makes it
   O(N + M_finalised_casts). For Phase 2 N, M ≤ 5 — irrelevant. Worth a
   note for Phase 4+ when refactor-wave casts run with N=20.
5. **Worktree retention storms.** Phase 0 already keeps worktrees on
   success (cast.ts:282-285). With merge-review picking 1 winner and
   archiving the losers, every cast leaves N-1 graveyard entries. A
   3-day retention timer (spec Sec 7) needs an actual implementation;
   absent it, `git worktree list` clutter is real. Cheap fix: the
   orchestrator's `runCycle` also reaps `.manta/graveyard/*` whose
   sidecar timestamp > retention. New ≈30-line module.

---

## 9. What this clone did *not* check (out of scope)

- I did not read sibling clones' deliverables (Sec 5.8 plagiarism
  prevention applies here too — research-prep §"Anti-pattern guard").
- I did not test best-of-N scoring math — that is clone-B's
  deliverable (`docs/research/phase-2-best-of-n-patterns.md`).
- I did not propose Bus-isolation strategies beyond the §4 minimum
  cut — that is clone-C's deliverable (`docs/research/phase-2-bus-isolation.md`).
- I did not write any code — research-prep specifies "No code changes.
  Output is one markdown file with file:line citations."
- I did not investigate Wave-2 prerequisites (daemon mode, Phase 5);
  those are out of Phase 2's bootstrap-by-Manta scope per spec Sec 15.1.

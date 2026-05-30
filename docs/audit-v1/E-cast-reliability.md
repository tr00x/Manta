# Audit E — Cast Reliability

**Scope:** spawn/orchestration path — why the headline feature (spawning self-clones) keeps failing.
**Date:** 2026-05-30. **Mode:** audit only, no code changes.
**Files audited:** `packages/manta-cli/src/spawner/{clone-spawner,worktree,heartbeat-hook,session-fork}.ts`, `packages/manta-cli/src/commands/{cast,abort}.ts`, `packages/manta-cli/src/{tick-loop,bin/manta}.ts`, `packages/manta-orchestrator/src/{orchestrator,death-detector,post-mortem,parent-pid,thresholds}.ts`, `packages/manta-bus/src/state/registry.ts`.

Bottom line up front: the spawn/orchestration spine is well-built for the *single-cast happy path* (lots of bug-#37/#38/#40 hardening is real and correct). But it has **three structural reliability holes** that bite exactly the way the bugs describe, and one of them (#66) makes bootstrap-by-Manta unreliable in precisely the long-session scenario the product is sold for. The common thread: the startup-grace clock starts before the child is even launched, OS-process lifetime is owned only by the in-memory `cast.ts` handle array (so any path that doesn't hold that array can't kill children), and the worktree path is letter-scoped not cast-scoped.

---

## 1. #66 — clone startup grace exceeded with large parent transcript

### The boot path, traced

Per-clone, inside `runCastCommand`'s spawn loop (`commands/cast.ts:577-686`):

1. `addWorktree(...)` — `git worktree add` (cast.ts:584).
2. **`forkParentSession(...)`** — copies the parent transcript JSONL into the clone's project dir (cast.ts:605).
3. `buildCloneSnapshot(...)` + `serializeSnapshot` (cast.ts:634, clone-spawner.ts:104).
4. **`spawnClone(...)`** which, *before launching the child*:
   - `registry.register(...)` — **pre-registers the clone in state `STARTING` with `registered_at = now`** (clone-spawner.ts:117-125; registry.ts:48-57).
   - `casts.create(...)` (clone-spawner.ts:139).
   - `installHeartbeatHook(...)` (clone-spawner.ts:152).
   - `runner.run(...)` — **only now does the `claude --print` child actually start** (clone-spawner.ts:159).

The grace gate (`death-detector.ts:27-33`):

```ts
if (r.state === 'STARTING') {
  const sinceRegistered = now - r.registered_at;
  if (sinceRegistered > options.thresholds.startupGraceMs) {
    reasons.push(`startup grace ${sinceRegistered}ms > ${options.thresholds.startupGraceMs}ms (no first heartbeat)`);
  }
}
```

The clone leaves `STARTING` only when its **first `manta.*` MCP call** lands. There is no explicit transition from the spawner — `register()` sets `STARTING` (registry.ts:56), and the *clone itself* is supposed to call `manta.heartbeat({state:"WORKING"})` as step 3 of its priming sequence (priming.ts:9). Every successful bus call also `touch()`es `last_heartbeat_at` (registry.ts:135), but `touch` **never changes state** (registry.ts:143 only updates `last_heartbeat_at`). So the gate that actually fires is the STARTING/`registered_at` one, measured from pre-registration, **not** from child launch and **not** against `last_heartbeat_at`.

### Is the size check O(1) or O(size)?

The size check itself is **O(1)** — `fs.stat(srcPath).size` (session-fork.ts:103). Good. The fork copy is `fs.copyFile` (session-fork.ts:121), a single kernel-side copy, O(size) but only on the under-threshold path. The over-threshold fallback (`size > thresholdBytes → return {skipped:'over_threshold'}`, session-fork.ts:110-113) **correctly skips the copy** — it does NOT read/copy before deciding. So the bug log's candidate (b) ("`--distill-threshold-bytes` path still reads/copies before deciding") is **disproven by the code**: the threshold path is genuinely cheap.

### So where does the cold-start time actually go?

The transcript-fork mechanics are *not* the gate. The gate is the **5-minute window between pre-register and the clone's first bus call**, and what eats it is downstream of Manta:

- **`registered_at` is stamped before the child launches** (clone-spawner.ts:117 runs before clone-spawner.ts:159). For N clones spawned in a serial `for` loop (cast.ts:577), clone B/C/D/E are registered *after* A/B/C have already started, but each one's grace clock still starts at its own pre-register. The real cost is **what `claude --print` does on cold start**: load the (large) `--append-system-prompt` priming text, MCP handshake with `manta-bus` (a fresh `node dist/bin/server.cjs` per clone), Skill-tool discovery, and — when `--resume <fork>` is in play — **`claude` re-ingesting the forked transcript**. A multi-MB forked JSONL means the resumed session has a huge context to load before the model emits its first tool call.
- **Crucial interaction the bug log half-spotted:** even at exactly the 2 MB default `--distill-threshold-bytes`, a transcript at 1.9 MB is *under* threshold → it gets forked and `--resume`d. So the clone boots by replaying a ~2 MB conversation through `claude` before it can reach priming-step-3 (`manta.heartbeat`). On a loaded machine (15 node/claude procs, the bug's "~15 procs") that replay + MCP handshake can plausibly exceed 300s. **The gate is `claude` cold-start + transcript replay + MCP handshake, not any Manta O(size) loop.**
- There is **no early "booting" heartbeat**. The clone is silent from `register()` until its own first bus call. Nothing in the spawner touches `last_heartbeat_at` or transitions state after `register()`. So "slow but alive boot" is indistinguishable from "dead" — exactly the bug's framing.

### Severity: High (for the headline use case)

This is the #1 late-session cast killer and it scales with transcript size = session length = exactly when dogfooding is most active. The `--startup-grace-ms` workaround exists (manta.ts:191-195, wired to `thresholdOverrides.startupGraceMs` at manta.ts:250) and works, but it requires the operator to *know* their transcript is large and pre-set it — not reliable by default.

### Fix direction (do not implement)

1. **Emit an early "booting" heartbeat from the spawner the instant `runner.run` returns a live pid.** After clone-spawner.ts:159, the spawner knows `proc.pid` and the child is launched; it could `registry.touch(cloneId)` on a short timer (or transition STARTING→STARTING with a refreshed `last_heartbeat_at`) so a slow-but-alive boot keeps the grace clock fresh. Better: gate STARTING on `now - last_heartbeat_at` (refreshable) rather than `now - registered_at` (frozen at pre-register), so any liveness signal — including a spawner-side touch — defers the reap.
2. **Move `registered_at`/grace-start to child-launch, not pre-register.** Today ~all of `forkParentSession` + `serializeSnapshot` + `installHeartbeatHook` + the register/casts.create round-trips burn against the grace window before `claude` even starts. Stamping the grace clock at `runner.run` time would reclaim that.
3. **Raise the default `startupGraceMs`** (currently 300_000, thresholds.ts:38) OR make it transcript-size-aware: if a fork was `--resume`d, the clone has more to load → larger default grace. The threshold comment (thresholds.ts:29-31) already acknowledges cold-start can exceed 90s but assumed 300s was safe — the resume path invalidated that assumption.
4. **Test gap:** add a test with a large synthetic parent transcript asserting the clone still registers/heartbeats within grace (bug log already requests this). The current e2e (`transcript-inheritance.e2e.test.ts`) uses a small sentinel transcript, so it never exercises the slow-resume path.

---

## 2. #64 — concurrent-cast worktree collision

### Does allocate + register prevent collision?

**Partially — for the live-clone case, yes.** Two layers:

- `allocateCloneIds` (cast.ts:85-102) lists the registry and excludes any letter held by a non-DEAD clone: `taken = all.filter(r => r.state !== 'DEAD')` (cast.ts:90). Throws `concurrent_cast_limit_reached` if not enough free letters. So a *live* letter is never re-handed.
- `Registry.register` (registry.ts:43-46) rejects re-registration of a non-DEAD clone via atomic CAS inside the file mutex: `if (existing && existing.state !== 'DEAD') throw BusConflictError`. So even on a race, two casts can't both own a live letter.

The bug log's #64 entry already corrected the original "stole a LIVE clone" framing to: the real residual harm is **dir reuse on a *freed* letter**, not registry corruption.

### Is the worktree path cast-scoped or letter-scoped?

**Letter-scoped.** `addWorktree` builds `path.join(repoRoot, '.manta', 'worktrees', opts.name)` where `opts.name = clone-${cloneId}` (worktree.ts:43; cast.ts:587). This is confirmed letter-only across **every** call site:
- `cast.ts:587` spawn, `cast.ts:936`/`cast.ts:1055` merge-review/merge-all fallback paths,
- `commands/promote.ts:76,94`, `commands/share.ts:139`.

None include `castId` in the dir name. So **letter reuse is always dir reuse** — the structural aliasing the bug calls out. The branch name IS cast-scoped (`manta/${castId}/${cloneId}`, cast.ts:587) but the *directory* is not.

### addWorktree force-rm behavior + data-loss guard

`addWorktree` (worktree.ts:39-80):

```ts
if (fs.existsSync(wtPath)) {
  if (await worktreeHasUncommittedChanges(wtPath)) {   // git status --porcelain
    throw new Error(`refusing to reuse worktree ${wtPath}: it has uncommitted changes ...`);
  }
  try {
    await execa('git', ['worktree', 'remove', '--force', wtPath], ...);
  } catch {
    await fs.promises.rm(wtPath, { recursive: true, force: true });
  }
  await execa('git', ['worktree', 'prune'], ...);
}
```

The bug-#64 data-loss guard (worktree.ts:55-61) is **real and works**: a pre-existing dir with uncommitted changes throws instead of clobbering. A clean orphan (graceful-death clone committed → clean tree) is reclaimed. This is the "PARTIAL — data-loss guard FIXED" the bug log notes.

### Is there still a race window?

**Yes — two residual windows, both structural, both out of the guard's reach:**

1. **The aliasing itself remains** (bug log "Structural follow-up, Open"). Two concurrent casts that get *disjoint* letters are safe. But the guard only protects against *clobbering dirty work* — it does nothing about the fact that a letter freed mid-session (clone A of cast-1 dies → letter A free → cast-2 allocates A → reuses `.manta/worktrees/clone-A`). If cast-1's clone A is DEAD-in-registry but its **OS process is still alive** (see #65 / #40), the orphan process is still writing into `clone-A` while cast-2's `addWorktree` runs `git status --porcelain` — a TOCTOU: the dir could be clean at the check and dirty a millisecond later when cast-2 checks out into it. `worktreeHasUncommittedChanges` is a point-in-time read with no lock.
2. **`worktreeHasUncommittedChanges` fails open.** `catch { return false }` (worktree.ts:34) — *any* git error (corrupt index, lock contention, a `git` invocation that itself races a concurrent git op in the shared repo) is treated as "not dirty → safe to rm -rf". A safety guard that fails open on error is the exact anti-pattern bug #39 fixed for the git-lock hook. If the orphan clone holds a `.git/index.lock`, the status check errors → guard returns false → `rm -rf` proceeds.

There is **no lock spanning "allocate letter + claim worktree + register"** — the three are separate awaits (cast.ts:405 allocate, cast.ts:584 addWorktree, clone-spawner.ts:117 register) with no enclosing mutex. The bug log's own root-cause line ("no lock spanning allocate+claim+register across concurrent cast processes") stands.

### Severity: High (structural), Medium (with guard, common case)

Fix direction: cast-scoped worktree paths (`clone-${castId}-${L}`) eliminate aliasing entirely — the bug log's tracked structural fix. Until then: (a) make `worktreeHasUncommittedChanges` **fail closed** (any git error → treat as dirty → throw, don't rm); (b) hold a registry-level lock across allocate→addWorktree→register so two cast processes serialize. Note the structural fix spans cast.ts:587/936/1055, promote.ts:76/94, share.ts:139 — all must move to cast-scoped naming together or the merge-review/promote/share lookups break.

---

## 3. #65 — budget_abort orphans live clones

### Traced: does abort/settle SIGTERM the clone children?

**The in-cast budget-abort path DOES terminate children. The standalone `manta abort` command does NOT.** Two distinct paths:

**Path A — in-cast budget abort (cast.ts:822-835):** when `loopResult.aborted` (the `tickBudgetMs` `setTimeout(() => ctrl.abort())` at cast.ts:766 fired), the code does:
```ts
await Promise.all(handles.map(async (h) => {
  try { await h.terminate({ gracefulMs: 1_000 }); } catch {}
}));
```
`h.terminate` is the SIGTERM→SIGKILL ladder (clone-spawner.ts:209-238). So **within the live cast process**, budget abort *does* kill the children. This contradicts the bug-log's "does not SIGTERM the spawned clone child PIDs" — for the in-process path, it's wired.

**So why did #65 happen?** The bug observed clone A still running *after* `cast.done`. Two real mechanisms:

1. **`terminate({gracefulMs: 1_000})` SIGTERMs, waits 1s, SIGKILLs — but `claude --print` may not die on SIGTERM cleanly, and the `Promise.race` in terminate (clone-spawner.ts:235) resolves on *either* `settled` OR the escalation-then-settled. If the child ignores SIGTERM and the SIGKILL is sent but the process is mid-syscall (writing its worktree), the `exit` promise the race awaits may resolve from the `escalation.then(() => settled)` branch returning the *settled* promise — but `settled` only resolves when `proc` actually exits. Here's the subtle hole:** `terminate` returns once `Promise.race([settled, escalation.then(()=>settled)])` resolves. `escalation` resolves after `gracefulMs` (the timer fires, sends SIGKILL, resolves the `escalation` void promise), then `.then(() => settled)` returns the `settled` promise which the race then awaits. So the race resolves only when `settled` resolves = when `proc` truly exits. That's correct **if** SIGKILL reliably reaps the child. For a normal child it does. **But `claude` spawns its own child processes (MCP servers, the model API client). `proc.kill('SIGKILL')` kills only the direct child, not its process group / descendants.** The MCP server `node server.cjs` and any grandchildren are NOT in the kill set — `execa` is not invoked with `detached`/process-group kill. So the *direct* `claude` dies but its tree can orphan.

2. **The `manta abort` command (commands/abort.ts:19-47) has NO process handle at all.** It lists the registry, calls `runPostMortem` (→ `markDead`, post-mortem.ts:58) and appends an `abort` event — **purely state-level**. It cannot SIGTERM anything because the `CloneHandle` objects (which hold `proc`) live only in `cast.ts`'s in-memory `handles[]` array (cast.ts:525), which is gone once the cast process exits. So if a clone is orphaned (its cast process already exited via `cast.done`), `manta abort` marks it DEAD in the registry but **leaves the OS process running** — registry says DEAD, process keeps burning tokens. This is the exact #65 stranded-clone state.

### The actual root cause of #65

`cast.budget_abort` → terminate-children (cast.ts:827) → **but this only covers clones whose `claude` child is the *direct* execa child of THIS cast process.** The asymmetric-finish scenario the bug describes (clone B committed a huge `node_modules` tree, ate the budget clone A needed) means: the cast hits `tickBudgetMs`, aborts, terminates handles. If clone A's `terminate` SIGKILLs the direct `claude` but its MCP/model-client subtree survives, OR if the cast process itself died unexpectedly before the terminate ran, the clone subtree orphans with no orchestrator. And critically — **once `cast.done` is emitted and the cast process exits, the only recovery is `manta recover`**, which relies on `parentPidCheckEnabled` (thresholds.ts:41): the orphan's `parent_pid` (= the now-dead cast process pid, clone-spawner.ts:120) is dead → `findDeadClones` flags `parent pid not alive` (death-detector.ts:67) → marks DEAD. **But that still never kills the OS process** — `findDeadClones`/`runPostMortem` only mutate registry state; there is no `process.kill(parent_pid_tree)` anywhere in the orchestrator. Confirmed: `parent-pid.ts` only *probes* liveness (`process.kill(pid, 0)`, line 8), never terminates.

### Severity: Medium-High

Wasted spend + misleading `WORKING` registry + stranded uncommitted work. Bug log severity is right.

### Fix direction (do not implement)

1. **`manta abort` must enumerate live clones' `parent_pid` and SIGTERM→SIGKILL the process *tree/group*, not just markDead.** It has `record.parent_pid` from the registry; it needs a "kill this pid's descendant tree" primitive (the orchestrator has none today).
2. **Spawn `claude` children in their own process group** (`execa(..., { detached: true })` + `process.kill(-pgid, sig)`) so `terminate` reaps the whole subtree, not just the direct child. This closes the orphan-MCP-grandchild hole in path A too.
3. **"Cast complete" must mean "no clone of this cast is still running."** Add a final verification after `cast.done` that no `parent_pid==self` descendant survives; the `finally` block (cast.ts:1021) already re-terminates handles but only the in-memory ones — it can't see a detached subtree.
4. **Couple state-death to OS-kill on the reaper path** (bug #40 did this for the in-cast happy path at cast.ts:847-865, but the standalone-abort and orphan-recover paths have no handle to kill). The structural fix is a registry-driven kill (kill by `parent_pid`/recorded child pid) that doesn't need the in-memory handle.

---

## 4. General cast fragility

### Heartbeat timeout logic
Three-armed gate in `findDeadClones` (death-detector.ts:23-69): STARTING→`startupGraceMs`, IDLE/WAITING_FOR_TASK→`idleHeartbeatTimeoutMs`+`maxIdleTimeMs`, else→`heartbeatTimeoutMs`. Plus daemon-lifetime and parent-pid arms. Solid. **Known gap (#52, fixed via flags):** heartbeats are event-driven (PostToolUse hook fires only on tool-call completion, heartbeat-hook.ts:80-81); a long pure-generation phase (>5min thinking, no tool call) → no heartbeat → reaped mid-work. The `--heartbeat-timeout-ms` flag (manta.ts:187) is the operator workaround; the structural fix (clone-side keepalive sidecar) is deferred (bug #52 "Deferred Phase 8+"). **This is the same class as #66** — both are "silence ≠ death but the gate can't tell."

### Reaping / zombie detection
The reaper (`Orchestrator.runCycle`, orchestrator.ts:34-98) is **state-only**: it marks DEAD + reaps locks/claims + writes post-mortem. **It never kills an OS process.** Bug #40 patched this *only* at the cast.ts boundary (cast.ts:847-865 happy path, cast.ts:978-986 catch, cast.ts:1021 finally) using the in-memory `handles[]`. Any reap that happens *outside* a live cast process (standalone `manta recover`, `manta abort`) cannot kill the OS process — the handle is gone. So zombie detection exists in state, zombie *termination* exists only inside a live cast.

### Clone crash mid-work
If `claude --print` crashes (non-zero exit) the `exit` promise resolves with `{code, signal}` (clone-spawner.ts:199-202); `allDone` (cast.ts:786) waits for registry state DEAD, not OS exit. A crashed clone that never reached `manta.report_death` stays non-DEAD in the registry until the heartbeat timeout reaps it (up to 5 min), then post-mortem marks DEAD. Its worktree is left intact (good for harvest). **Spawn-failure** is handled well: `reject:false` + the `failed && exitCode==null && signal==null` check (clone-spawner.ts:193) surfaces ENOENT/missing-binary as `spawn_failed` instead of a silent clean-exit — this is correct.

### Transcript-fork failures
`forkParentSession` returns `{skipped:'not_found'}` (session-fork.ts:107) or `{skipped:'over_threshold'}` (session-fork.ts:112); cast.ts:618-631 catches both, sets `cloneResumeEnabled=false`, and **warns loudly** — graceful degrade, never silent. The `mangle()` realpath+full-char-sanitize fix (#61, session-fork.ts:41-49) is in. **One latent risk:** `mangle` catch-fallback to the literal path (session-fork.ts:45) "must never be hit in production" per the comment, but if `realpathSync(cloneCwd)` ever throws in prod (worktree dir deleted between create and fork — see the #64 TOCTOU), the fork lands in the wrong project dir → silent empty inheritance, the exact #61 failure mode. Low probability, but the fail-path is silent.

### Distill-threshold fallback
Confirmed cheap and correct (see §1). Over-threshold = skip-without-copy. The `--force-full-transcript` bypass (cast.ts:612, sets `thresholdBytes=Infinity`) will copy an 11.7 MB transcript × N clones — operator footgun but explicit/documented.

### Places a cast can silently fail or hang
- **`mangle` catch-fallback** (above) — silent wrong-dir fork.
- **`worktreeHasUncommittedChanges` fail-open** (§2) — silent clobber of dirty orphan on any git error.
- **merge-review / merge-all wrapped in `try/catch` that only `reporter.info`s the error** (cast.ts:918-923, 959-964) — a forking cast whose merge-review throws still emits `cast.done` with no merge-review file; the curator's ceremony step 1 (`cat docs/merge-reviews/cast-<id>.md`) then finds nothing. Not a hang, but a silent degrade of the headline forking output.
- **`allDone` polls registry only** (cast.ts:786-811) — if a clone's heartbeat hook keeps touching `last_heartbeat_at` (registry.ts:135) but the model is actually wedged in a loop, the cast runs to full `tickBudgetMs` then budget-aborts. Not silent, but slow.

---

## 5. Is bootstrap-by-Manta viable right now?

**Honest assessment: partially, and #66 is the binding constraint.**

- For **short, fresh-session casts** (small parent transcript): yes. Every RB/recon cast this session that ran early (small transcript) succeeded — the spine is sound, the #37/#38/#40 hardening works, transcript inheritance is real (#56 e2e green).
- For **the actual dogfood scenario** — the curator deep in a long session, large multi-MB transcript, casting clones to build the next chunk — **no, not reliably.** #66 means clones get reaped at the 300s startup grace before their first heartbeat, *exactly when the project is most active*. The curator already hit this twice in a row this session and had to defer RB#4b to a fresh session. That is the bootstrap-by-Manta premise breaking under its own success: the longer/more productive the session, the larger the transcript, the more likely the cast dies on boot.
- **Compounding:** #65 (orphaned live clones after budget_abort) and the #64 letter-aliasing TOCTOU both get *worse* under concurrency, and the curator's instinct under "добивай весь проект с разных сторон" is to run multiple casts in parallel — which the bug log explicitly marks UNSAFE on this version (run serially).

So bootstrap-by-Manta works as a *deliberate, serial, fresh-session* workflow (cast → harvest → new session → cast), which is not the frictionless parallel dogfood the product promises. The headline ("huge impact on large projects") is the precise case that's currently fragile.

**Mitigations available today:** `--startup-grace-ms 600000` on every large-session cast (works, but requires the operator to know); cast from fresh sessions; run casts serially. None are reliable-by-default.

---

## Ranked: what must be fixed for casts to be reliable

1. **[#66, HIGH — top blocker for the headline use case] Make the startup-grace survive a slow-but-alive boot.** Either (a) gate STARTING on `last_heartbeat_at` (refreshable) instead of frozen `registered_at`, and have the spawner emit an early "booting" touch the instant `runner.run` returns a pid; or (b) move the grace-clock start to child-launch and raise/size-scale the default. This is the difference between "casts work in a long session" and "casts only work fresh." Add a large-synthetic-transcript boot test.

2. **[#65 + #40 residual, MEDIUM-HIGH] Decouple OS-process termination from the in-memory handle.** Spawn `claude` in its own process group (`detached` + `kill(-pgid)`) so the whole subtree (MCP server, model client) dies; and make `manta abort` + `manta recover` kill live clones by `parent_pid` tree, not just markDead. "Cast complete" must guarantee no surviving child. Today only the live in-cast path kills processes.

3. **[#64 structural, HIGH] Cast-scope the worktree path (`clone-${castId}-${L}`)** to eliminate letter→dir aliasing, and serialize allocate→addWorktree→register under one lock. Spans cast.ts:587/936/1055, promote.ts:76/94, share.ts:139 — must move together.

4. **[#64 guard hardening, MEDIUM] Make `worktreeHasUncommittedChanges` fail CLOSED** (worktree.ts:34 `catch { return false }` → treat git error as dirty/throw). A data-loss guard that fails open on a `.git/index.lock` race is not a guard (same lesson as bug #39).

5. **[#52 structural, MEDIUM] Clone-side keepalive** so generation-heavy casts don't need the operator to pre-tune `--heartbeat-timeout-ms`. Same root as #66: event-driven heartbeats are blind to between-event silence.

6. **[silent-degrade, LOW-MEDIUM] Surface merge-review/merge-all failures as a non-zero outcome**, not a swallowed `reporter.info` (cast.ts:918-923, 959-964), so a forking cast that produced no merge-review file fails loudly instead of emitting a clean `cast.done`.

7. **[#61 residual, LOW] Close the `mangle` catch-fallback silent path** (session-fork.ts:45) — if `realpathSync` throws in prod, fail loud rather than fork to the wrong dir.

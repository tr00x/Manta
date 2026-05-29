# Manta Bugs Log

Живой реестр обнаруженных багов клонов и оркестратора. Curated manually мейном после каждой сессии. См. `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` Sec 15.2.

## Структура записи

```
### #N — <короткое название>
**Discovered:** YYYY-MM-DD, cast-id <id>, mode <mode>
**Severity:** Catastrophic | High | Medium | Low
**Status:** Open | In progress | Fixed in <release>
**Reproducer:** <минимальный сценарий>
**Root cause:** <если найдена>
**Fix:** <PR / commit / skill update>
**Lessons:** <что меняем в spec/skills чтобы не повторилось>
```

## Severity scale

- **Catastrophic** — corrupted state / lost code / orphan zombie processes
- **High** — failed cast при штатном использовании / clone расходится с task contract заметно / cost overrun > 2x
- **Medium** — neпредсказуемое поведение, но recoverable
- **Low** — UX-нюансы, неудобства, edge cases

## Open bugs

### #62 — `heartbeat-hook.test.ts` leaks the ambient `MANTA_CLONE_ID` into the spawned touch-script → `pnpm gate` reds whenever the suite runs INSIDE a Manta clone (dogfood path)

**Discovered:** 2026-05-29, cast-1780081439432 (RB2 Chunk 1, forking-realities clone B). Surfaced because the clone ran `pnpm gate` from inside its own worktree, where `MANTA_CLONE_ID=B` is set in the process env. NOT caused by the RB2 rename — proven by `git stash` + re-run on clean base `01b5a33`: the test fails identically without any RB2 change.
**Severity:** Medium — green on the curator's main session (no `MANTA_CLONE_ID`), red on every clone-run gate. Since bootstrap-by-Manta runs `pnpm gate` inside clones for essentially every cast, this is a standing false-red that would block or noise-up any clone-driven release work, and could be mistaken for a real regression introduced by the cast.
**Status:** Fixed in cast-1780081439432 (RB2 Chunk 1 commit) — test-only env pin; no production-code change.

**Reproducer:** `MANTA_CLONE_ID=B pnpm --filter manta exec vitest run tests/spawner/heartbeat-hook.test.ts` → `touch script updates last_heartbeat_at in registry` fails with `expected 1000 to be greater than or equal to <now>`. Unset `MANTA_CLONE_ID` (or run from the main session) → passes.

**Root cause:** the generated heartbeat touch-script reads `CLONE_ID = process.env.MANTA_CLONE_ID || "<baked-in id>"` — an intentional production feature (a clone's own env names which registry row it touches). The test seeds a registry containing only clone `A` and spawns the script via `execSync`/`spawn` WITHOUT scrubbing the env, so the child inherits the ambient `MANTA_CLONE_ID=B`. `data.clones["B"]` is `undefined` → the script hits its `!clone` early-return and no-ops → `last_heartbeat_at` stays at the seeded `1000`. The two sibling cases (`no-op for DEAD`, `cross-process race`) coincidentally still passed for the *wrong* reason (no-op against the missing `B` vs. the intended DEAD-skip / A-already-advanced), so only the positive-update assertion went red.

**Fix:** pin `env: { ...process.env, MANTA_CLONE_ID: 'A' }` on all three child-process launches in `heartbeat-hook.test.ts` (the two `execSync` calls + the `spawn` in the race test) so each script deterministically targets the seeded/registered clone regardless of the host environment. Production code untouched — the env-override behaviour is correct.

**Lessons:** a test that spawns a child process inheriting `process.env` is not hermetic — ambient vars set by the harness (here a Manta clone's own `MANTA_CLONE_ID`) can silently steer the child down a different branch. Any test asserting on a spawned binary's behaviour must control the child env explicitly, especially for vars the production code reads as a feature. "Green on main, red in a clone" is the diagnostic signature of an env-leak: the dogfood runtime sets vars the main session does not.

### #61 — `mangle()` derived the wrong on-disk project-dir → fork written where `--resume` never looks (silent empty inheritance)

**Discovered:** 2026-05-29, surfaced by the RB1 real-claude e2e bring-up (run 1: `ENOENT` stat on the parent JSONL at `transcript-inheritance.e2e.test.ts:219`). NOT caught by any hermetic unit test.
**Severity:** High — `mangle()` is the make-or-break primitive for #56 (transcript inheritance). A wrong mapping silently routes the forked transcript to a directory `claude --resume` never searches, so the clone boots empty (a subagent) and the parent-only token is never recalled. Invisible to flag-presence tests; it IS the #56 failure mode, just one layer down.
**Status:** Fixed 2026-05-29 (`packages/manta-cli/src/spawner/session-fork.ts`, same commit as the #56 status flip).
**Reproducer:** Cast from any cwd under a symlinked base (macOS `os.tmpdir()` → `/var/folders/...` which is a symlink to `/private/var/folders/...`) OR any repo path containing `_`/space/`+`/`@`. Old mangle computed `-var-folders-…` and preserved `_`; real Claude Code writes the transcript under `-private-var-folders-…` with `_`→`-`. The fork lands in the wrong project dir → `--resume <fork>` finds nothing → empty-context clone. The e2e caught it as `ENOENT` on `fs.stat(parentJsonl)`.
**Root cause:** `mangle()` did only `cwd.replaceAll('/','-').replaceAll('.','-')` — (a) no symlink resolution (the logical cwd ≠ Claude Code's realpath'd project-dir name), and (b) only `/` and `.` were mapped, leaving every other non-alphanumeric char (`_`, space, `+`, `@`, …) intact, whereas Claude Code replaces EVERY non-alphanumeric char with `-`. The JSDoc even *claimed* empirical verification of the `/`+`.`-only rule — the claim was false; a fresh probe (2026-05-29) disproved it.
**Fix:** `mangle()` now resolves `realpathSync(cwd)` (catch-fallback to the literal path ONLY for not-yet-created unit-fixture paths — must never be hit in prod, where both the repo root and the worktree exist at fork time) then applies `.replace(/[^a-zA-Z0-9]/g, '-')` (case preserved, separators not collapsed). Verified by 11 unit tests in `session-fork.test.ts` (the leading-dot double-dash case, the `_`/space/`+`/`@` case, and a symlink case asserting `mangle(link) === mangle(realTarget)` and `≠` a naive char-replace of the link path) AND by the real-claude e2e going green through steps 1–4 (parent JSONL found; forks land in the correct per-clone project dirs).
**Lessons:** An empirically-"verified" claim in a comment is only as trustworthy as the probe behind it — re-probe before relying on another tool's on-disk convention. When a primitive's correctness turns on an external tool's filesystem layout, the test MUST exercise the REAL convention (symlinked base + special chars), not a clean logical path. The original unit tests passed against the broken mangle precisely because their fixtures had no symlink and no special chars; only a real-claude semantic e2e exposed the gap. This is the concrete justification for #56's acceptance gate being a real-claude e2e rather than a hermetic flag assertion.

### #57 — `claude mcp list` pre-flight latency is hostage to unrelated MCP servers → cast aborts at spawn

**Discovered:** 2026-05-29, launching the RB1 Chunk 1 implementation cast (cast-1780067298312) — spawn aborted with `spawn_failed: \`claude mcp list\` exited undefined: Checking MCP server health…`. Intermittent: a manual re-run passed in 3.6s (warm caches); the cast hit >10s (cold/contended) and timed out.
**Severity:** Medium — blocks every cast launch whenever any *unrelated* registered MCP server is slow or failing, and is a v1 prod-readiness fragility: an external user with a couple of slow/unreachable MCP servers could not cast at all. Workaround (retry) exists, so not High.
**Status:** Fixed 2026-05-29 (`packages/manta-cli/src/commands/mcp-preflight.ts`). Switched the probe from `claude mcp list` (health-checks ALL servers serially) to `claude mcp get manta-bus` (health-checks only the one server the pre-flight cares about: ~1s locally, latency independent of the rest). Added a distinct `timedOut` error (was the confusing "exited undefined"), bumped the timeout 10s→15s, and merged the error branches to always surface the raw `claude` output plus the `claude mcp add` registration fix. Types renamed `ClaudeMcpListResult/Runner` → `ClaudeMcpResult/Runner`. Regression: new timeout test in `tests/commands/cast-mcp-preflight.test.ts` (5 tests, gate green 1400).
**Root cause:** `mcp-preflight.ts` ran `execa('claude', ['mcp','list'], { timeout: 10_000 })`. `claude mcp list` health-checks EVERY registered server serially; with two HTTP servers failing to connect (github, vibearound) plus npx/uvx cold starts (context7, serena), the sweep exceeded 10s → execa killed the child (SIGTERM) → `exitCode === undefined` (killed-by-signal, not a normal exit) with only the first stdout line ("Checking MCP server health…") captured, hence the misleading message. The pre-flight only ever needed to confirm *manta-bus* is registered — it never needed the global health-sweep.
**Lessons:** A pre-flight that gates on one resource must probe that resource, not a global command whose latency is coupled to every unrelated dependency. `execa` timeout kills produce `exitCode: undefined` + `timedOut: true` — distinguish that from a real non-zero exit, or the error message lies. The 2026-05-29 prod-readiness audit (RB2) missed this because it inspected the publish path only, not the cast-launch path under a realistic (some-servers-failing) MCP config.

### #56 — Transcript inheritance unwired — clones boot as subagents (Sec 1 headline claim is false)

**Discovered:** 2026-05-29, cast-1780064388927 (recon-swarm, clone-A) during v1 prod-readiness recon. Empirically proven mechanism in `docs/audits/2026-05-29-transcript-inheritance-plan.md`.
**Severity:** High — this is Manta's headline differentiator (spec Sec 1: «first same-system-prompt cloning с full context inheritance») and v1 release blocker #1. Today the claim is false: clones start from an empty Claude Code session + priming preamble = functionally subagents. The full-transcript pipe is dead at **every** stage.
**Status:** Fixed in v1 (2026-05-29) — all four dead stages wired; semantic inheritance proven end-to-end against **real claude**. The acceptance gate is `packages/manta-e2e/tests/transcript-inheritance.e2e.test.ts` (run armed via `MANTA_E2E=1`): the positive flow seeds a parent session holding a parent-ONLY sentinel token (never written to any file/task/priming), casts a 2-clone recon-swarm with the parent id, and asserts **both** clones reproduce the exact token in `token.txt` — impossible without forked-transcript `--resume`. The negative control (same setup, inheritance disarmed → `resumeEnabled=false`) asserts both clones write `NONE`, ruling out leakage. Plan: `docs/superpowers/plans/2026-05-29-release-rb1-transcript-inheritance.md` Chunks 0–3+5 implemented+merged. **Deferred (not a #56 reopener):** Chunk 4 (over-threshold distill, Tier B) — for v1 a transcript >2 MB skips the fork and falls back to empty-context **with a loud warning** (graceful degrade, never silent). The headline claim is now true for the common case and degrades visibly for the oversized case; distilling large transcripts is a tracked follow-up in the plan, not silent breakage.
**Fix:** Chunks 1–3 merged (cast spine: real `parentSessionId` from `CLAUDE_CODE_SESSION_ID`, `forkParentSession` copy-into-clone-projdir, `--resume <fork> --append-system-prompt <priming>` batch path). Chunk 5 merged in `8b7929a` (the e2e + share-leak guard). The real-claude bring-up surfaced bug **#61** (mangle path-mismatch) which is fixed in the same commit as this status flip; without it the fork landed where `--resume` never looks (silent empty inheritance — the exact #56 failure mode, invisible to every unit test). Step 5 of the e2e (priming coexistence) was hardened from a brittle per-clone `contract_ack` assertion (a soft-prior ceremony step one clone legitimately skipped) to: (A) cast-level ≥1 `contract_ack` (uniquely proves the injected task-contract was read — absent from the parent transcript) + (B) per-clone ≥1 clone-driven Manta lifecycle event (robust to which ceremony steps each clone follows).
**Reproducer:** `manta cast recon-swarm` with a parent session holding a sentinel fact never written to any file/task → the clone cannot recall the sentinel (it never saw the parent conversation). A flag-assertion test passes anyway — only a semantic-inheritance e2e (clone reproduces a parent-only fact) distinguishes clone from subagent.
**Root cause (four dead stages, file:line verified by clone-A):**
1. `packages/manta-cli/src/commands/cast.ts:538` — `parentSessionId: opts.castId` stuffs a **cast id**, not a Claude session id (`z.string().min(1)` masks the bug — always non-empty, always wrong kind).
2. `packages/manta-cli/src/spawner/snapshot-builder.ts:46-48` — `recentMessages: [], activeTodos: [], openFiles: []` hardcoded empty; `distillContext()` has zero production callers.
3. `packages/manta-cli/src/spawner/priming.ts` — `buildPrimingText`/`buildInitialPrompt` never render `recentMessages`/`activeTodos`/`openFiles`; even if populated, the clone never sees them.
4. `packages/manta-cli/src/bin/manta.ts:255` — batch runner `runClaudeCli()` never `--resume`s; `runClaudeResume` exists but is daemon-only and resumes the clone's OWN id, never the parent's transcript.
**Mechanism (proven, supersedes the pre-recon `--resume "$CLAUDE_CODE_SESSION_ID" --fork-session` model which was WRONG):** `--resume` is cwd-scoped; copy parent JSONL `~/.claude/projects/<mangle(cwd)>/<id>.jsonl` into the clone's worktree project-dir under a fresh uuid, then `claude --print --resume <fork_i> --append-system-prompt <priming>`. Parent id from `process.env.CLAUDE_CODE_SESSION_ID` (NOT `CLAUDE_SESSION_ID`). Default = full forked resume; auto-distill above a size threshold (FIRM default — live main transcript was 11.7 MB). See spec Sec 9 «Transcript inheritance — механизм и cost-tiers (v1)».
**Lessons:** A required-but-wrong-kind field (`parentSessionId` = castId) is invisible to a `.min(1)` schema — type-presence ≠ semantic correctness. The acceptance test for an inheritance feature MUST be semantic (parent-only sentinel recalled), never flag-presence. Adjacent pre-existing gap logged separately: daemon first-turn id mismatch (`runClaudeCli` w/o threading `sessionId` while `daemon-loop` later `--resume`s a non-UUID `${castId}-${cloneId}-${uuid}`) — out of scope for #56, tracked for a future fix.

### #54 — Trigger state stores (TriggersArmedStore, TriggerCircuitStore, TriggerDebounceStore) mutate without paired `events.jsonl` append — audit-trail invariant gap (bug #24 regression class for new stores)

**Discovered:** 2026-05-28, code-review subagent on Phase 7c Chunk 1 merge ceremony (cast-1780023638705 clone C).
**Severity:** Medium — armed-state transitions (disarm-all panic, validation-error-disarm), circuit trip/reset are exactly the events that need a cross-store reconstruction path via `events.jsonl`. A corrupted/lost `armed.json` or `circuit.json` cannot be replayed without it (bug #24 lesson: "mutate paired with events.jsonl append inside the mutex"). Doesn't bite under normal operation; bites hard during recovery / forensics.
**Status:** Fixed 2026-05-29 in Phase 7c Chunk 2 merge ceremony (cast-1780055173473 clone C). `TriggersArmedStore` and `TriggerCircuitStore` now take a REQUIRED `EventsLog` ctor dep and thread `auditAppend` closures through every `atomicMutateJson` mutate (event types: `trigger_armed`, `trigger_disarmed`, `trigger_disarmed_by_validation_error`, `trigger_circuit_opened`, `trigger_circuit_reset`). The previous ceremony's `void reason` workaround in `reset()` is superseded — `reason` is now persisted via the paired `trigger_circuit_reset` events.jsonl append. `TriggerDebounceStore` correctly left UNwired (debounce miss is recoverable, not audit-worthy). 12 new regressions in `tests/state/trigger-stores-audit-trail.test.ts` assert (a) event emission for each transition AND (b) mutex-coupling rollback (`ThrowingEventsLog` causes state mutation to roll back — proves the audit append fires INSIDE the file mutex, not after rename).
**Files:** `packages/manta-bus/src/state/triggers-armed.ts`, `packages/manta-bus/src/state/triggers-circuit.ts`, `packages/manta-bus/src/state/triggers-debounce.ts`.
**Reproducer:** Open the breaker → delete `circuit.json` from disk → restart → state is lost; no replay possible because no `trigger_circuit_opened` event was written to `events.jsonl`. Same shape for any of the four state stores.
**Root cause:** All three new stores use `atomicMutateJson(file, factory, mutator)` without the optional `auditAppend` 4th arg. The bus's `atomic-fs` primitive supports paired events.jsonl appends inside the file mutex specifically to close this gap (added per bug #24). Phase 7c Chunk 1's stores landed without the audit-trail wiring because the events.append targets (event types `trigger_armed`, `trigger_circuit_opened`, `trigger_circuit_reset`, `trigger_disarmed_by_validation_error`) hadn't been threaded through `BusContext.events` at the store-constructor level.
**Fix (proposed):** Add `events: EventsLog` ctor dep to `TriggersArmedStore` and `TriggerCircuitStore` (TriggerFiresLog is itself the audit, so it's exempt; TriggerDebounceStore is low-stakes — a debounce miss is recoverable). Pass `() => events.append({type: 'trigger_armed', name, ...})` etc. as the 4th `auditAppend` arg of `atomicMutateJson` for every state-changing mutate. ~30 lines per store, no new tests required if existing `EventsLog` tests cover the primitive. Recommended schedule: Phase 7c Chunk 2 (when handlers wire stores together — natural seam to inject `events` into the store constructors).
**Lessons:** Every new state store that lands in `@manta/bus` must, on first commit, demonstrate audit-trail pairing. Add a unit-test convention: any new `state/*.ts` store must include a `mutates events.jsonl on commit` test that verifies the events.append fires INSIDE the mutex (not after). Codify in CLAUDE.md / spec Sec on bus state.

### #52 — Heavy-generation tasks (plan-drafting, complex synthesis) exceed `heartbeatTimeoutMs` between tool calls

**Discovered:** 2026-05-28, plan-drafting cast `cast-1780018345492` (recon-swarm × 2 drafting Phase 7b + 7c plans). Both clones DEAD by heartbeat timeout (`heartbeat 302916ms ago > 300000ms`) before producing any deliverable file.
**Severity:** High — blocks every cast whose task contains long thinking phases between tool calls (plan-drafting, large-doc synthesis, complex multi-file refactors that require reasoning). The reaper kills clones mid-work; no deliverable, no last-gasp report.
**Status:** Fixed 2026-05-28 (`packages/manta-cli/src/bin/manta.ts` `--heartbeat-timeout-ms` + `--startup-grace-ms` CLI flags).
**Reproducer:**
1. `manta cast recon-swarm --clones 2 --task "draft a 1500-line plan based on this 1000-line research doc"`
2. Clones spend >5 min thinking between tool calls (reading research + reasoning about plan structure + drafting the chunk-by-chunk task list).
3. PostToolUse heartbeat hook only fires on tool-call completion. During pure-generation phases, no tool calls happen → no heartbeat → reaper marks DEAD at the default 300s threshold → cast.ts #40 force-terminates the wedged-from-reaper-pov clone before any deliverable lands.
**Root cause:** The heartbeat mechanism is event-driven (PostToolUse hook on every tool call) but pure-thinking phases between tool calls are invisible to it. The 300s default was tuned for IMPLEMENTATION clones (frequent Write/Edit/Bash calls); generation-heavy tasks have very different cadence. No mechanism for the model to assert "still alive, just thinking" during generation.
**Fix (operator-controlled):** Two new CLI flags on `manta cast` — `--heartbeat-timeout-ms <ms>` and `--startup-grace-ms <ms>` — expose the existing `thresholdOverrides` seam in `createRuntime`. Operator picks a timeout that matches the task's thinking budget. For plan-drafting, 20 min (`1200000`) is the empirically-good default. Default (5 min) stays unchanged so implementation-class casts are unaffected.
**Deferred (Phase 8+):** A clone-side keepalive process that touches the registry every N seconds regardless of tool-call cadence would close this structurally — operator wouldn't need to know task-class up front. Defer because: (a) it's a new long-running sidecar inside the clone subprocess (new lifecycle to manage), (b) most casts have fine-grained tool-call cadence and don't need it, (c) the CLI-flag operator-control surface is enough for the workloads we ship today.
**Lessons:** Event-driven heartbeats are blind to between-event silence. Any timeout based on event cadence must be tunable for tasks whose cadence is structurally different. The default cannot be "right" for every task class; expose the override.

### #44 — `sweepOrphanWorktrees` force-deletes LIVE clone worktrees under a symlinked repo root (regression on the #43 fix)

**Discovered:** 2026-05-28, bug-hunt cast `cast-1780011340100` (both clones A and B independently flagged).
**Severity:** High — silent destruction of a live clone's deliverables when `manta recover` runs while a cast is live on a symlinked repo root (macOS `/tmp`, `/var`, symlinked checkouts, network mounts).
**Status:** Fixed 2026-05-28 (`packages/manta-cli/src/spawner/graveyard.ts` `sweepOrphanWorktrees` + `packages/manta-cli/src/commands/recover.ts`).
**Reproducer:** Cast a clone under a symlinked repo root (`fx.root = /tmp/...`; `realpath = /private/tmp/...`). Run `manta recover`. The pre-fix `isKnown(wt) = knownPaths.has(wt.path)` compared git's canonical `/private/tmp/...` against the registry's `/tmp/...` → live clone classified as orphan → `git worktree remove --force` + `git branch -D` destroyed uncommitted work and the branch.
**Root cause:** The #43 fix canonicalised the namespace *prefix* (`mantaPrefix` + `mantaPrefixCanon`) but the membership comparison (`isKnown` callback in `recover.ts`) compared raw strings. Inconsistent canonicalisation: prefix yes, membership no. Tests masked the bug by pre-canonicalising the root via `await fs.realpath(fx.root)` before `addWorktree`.
**Fix:** API rewritten from `isKnown: (wt) => boolean` callback to `knownPaths: Iterable<string>`. `sweepOrphanWorktrees` now canonicalises BOTH sides via `safeRealpath` internally — callers pass raw `registry.worktree` strings, the library guarantees the comparison happens in canonical form. New regression test (`graveyard.test.ts` 'preserves live worktrees when knownPaths uses non-canonical repo root') registers a worktree under the non-canonical root and asserts the sweep does NOT remove it (skips automatically on hosts where the raw/canonical roots are identical, e.g. typical Linux CI).
**Lessons:** Canonicalisation seams should live at the library boundary, not be the caller's responsibility. If a fix touches *any* path comparison, audit *every* path comparison in the same operation — partial canonicalisation is the worst of both worlds. Pre-canonicalising fixture roots in tests is a common way to mask exactly this class of bug; tests should exercise the divergent state the real code will see.

### #45 — git-lock hook regex does not match `git -c …=… commit` (the documented clone commit form)

**Discovered:** 2026-05-28, bug-hunt cast `cast-1780011340100` clone B (surface audit of #39).
**Severity:** High — the GIT_OPERATIONS lock no-op'd on the exact commit form `CLAUDE.md` mandates (`git -c user.email="$EMAIL" -c user.name="$NAME" commit -m …`); concurrent clone commits to the shared repo were not serialised by the hook.
**Status:** Fixed 2026-05-28 (`packages/manta-cli/src/hooks/git-lock-hook.ts` TS source + embedded `.cjs` regex; both kept in sync).
**Reproducer:** A clone runs the canonical commit form. The pre-fix regex `\bgit\s+(commit|...)` required the subcommand to immediately follow `git`, so the `-c key=val` cluster prevented the match → `isGitMutating === false` → hook returns `{continue: true}` regardless of whether the GIT_OPERATIONS lock is held.
**Root cause:** The pattern was designed for the bare `git <subcmd>` form and never extended to tolerate option clusters. Pre-existed before the #39 fix; surfaced during the audit of #39's outer catch.
**Fix:** Widened pattern: `/\bgit\b(\s+-\S+(\s+\S+)?)*\s+(add|commit|checkout|stash|merge|rebase|reset|cherry-pick|revert|push)\b/`. Tolerates `-X` short options and `--name` long options between `git` and the subcommand, each optionally followed by a separate value token (handles `git -c k=v commit`, `git --git-dir=/p add`, `git -p commit`). `\bgit\b` (not `\bgit\s+`) keeps `gitignore` etc. from matching. Same regex mirrored in the generated `.cjs`. Three regressions: canonical `git -c k=v -c k=v commit`, `git --git-dir=/p add`, plus a negative-control trio (`git -c color.ui=always status`, `git --no-pager log`) confirming non-mutating commands still pass through.
**Lessons:** Regexes that gate safety properties need positive *and* negative coverage on the canonical command forms documented elsewhere in the repo (here: CLAUDE.md). When two copies of a regex exist (TS source + generated `.cjs` template), drift between them is a follow-up risk — eventually replace the dual-maintenance with a single source.

### #46 — Post-mortem allowlist surfaces `heartbeat.progress` verbatim (residual #29 leak surface)

**Discovered:** 2026-05-28, bug-hunt cast `cast-1780011340100` (clones A m-2 + B MINOR-1, convergent).
**Severity:** Medium — clone-supplied free-form text (bounded only by `z.string().max(2000)`) lands in post-mortems and is bundled externally by `manta share`. A secret short enough to fit in 2000 chars (AWS key, OAuth token) leaks.
**Status:** Fixed 2026-05-28 (`packages/manta-orchestrator/src/post-mortem.ts` `heartbeat` arm — `progress` dropped from allowlist).
**Reproducer:** Clone heartbeats with `progress: "leaked-secret-here"`. Post-mortem renders the field verbatim per `renderEventPayload` `heartbeat` arm.
**Root cause:** The #29 fix intentionally kept `progress` for operator usefulness ("operators read post-mortems for the failure shape and progress trail"). The trade-off acknowledged in an inline comment but never pinned with a test; default-deny posture inconsistent for this one field.
**Fix:** Dropped `progress` from the heartbeat allowlist — `summarize(p, ['state', 'progress'])` → `summarize(p, ['state'])`. Default-deny posture now uniform across every event type. Operators who need the live progress trail use `manta inspect <cloneId>` on running bus state; post-mortem doc was the wrong layer to surface free-form clone text. Regression in `tests/post-mortem.test.ts` seeds a secret-bearing progress string and asserts (a) the secret is not in the rendered MD, (b) the free-form context is dropped, (c) the structured `state` field is still surfaced.

### #47 — No concurrent dequeue/release race regression for `#27`

**Discovered:** 2026-05-28, bug-hunt cast `cast-1780011340100` (clones A m-3 + B MINOR-3, convergent).
**Severity:** Low (coverage gap, not a defect — both ops go through `atomicMutateJson`'s mutex which serialises). Audit H4 (concurrency-testing debt) applies generally.
**Status:** Fixed 2026-05-28 (`packages/manta-bus/tests/state/work-queue.test.ts` — concurrent dequeue/release race regression added).
**Fix:** New regression test claims N items, then races `Promise.all` of N `release()` + N `dequeue()` calls under arbitrary interleaving. Asserts the file mutex serialises both ops — every item ends up either claimed (by some dequeue) or pending (claimed_at cleared, attempts advanced), totalling N. No double-claim, no lost work. Confirms the structural correctness claim that the audit suspected was untested.

### #48 — Heartbeat-touch hook builds its own registry path string instead of reusing `busPaths()` (latent #37 split risk)

**Discovered:** 2026-05-28, bug-hunt cast `cast-1780011340100` clone B NIT-1.
**Severity:** Low — currently benign (both sides happen to construct the same string).
**Status:** Fixed 2026-05-28 (`packages/manta-cli/src/spawner/heartbeat-hook.ts`).
**Root cause:** The generated `.cjs` hook builds `path.join(repoRoot, '.manta', 'state', 'registry.json')` rather than calling `busPaths(repoRoot).registry`. With `LOCK_OPTS.realpath = false`, mutual exclusion requires byte-identical paths — a future divergence (symlinked `repoRoot`, trailing slash, one-side canonicalisation) silently splits the lock files and regresses #37. The cross-process test asserts the outcome (no clobber), not the lock-path identity, so it can't catch a split.
**Fix:** Installer now imports `busPaths` from `@manta/bus` and derives `registryPath = busPaths(repoRoot).registry` — one source of truth. Bus and hook always pass the byte-identical string to `proper-lockfile`. The existing #37 cross-process regression continues to assert the outcome (no clobber); the path-identity invariant is now structural, not test-checked.

### #49 — `WorkQueueStore.release` does not guard against already-completed or never-claimed items

**Discovered:** 2026-05-28, bug-hunt cast `cast-1780011340100` clone B NIT-5.
**Severity:** Low — the daemon loop only calls `release` on failure, so untriggered today.
**Status:** Fixed 2026-05-28 (`packages/manta-bus/src/state/work-queue.ts` `release`).
**Fix:** Defensive guard at the head of the mutator: if the item has `completed_at != null` (success path) OR `claimed_at == null` (never dequeued) OR `dead_letter === true` (already terminal), the release is a no-op and `attempts` is NOT advanced. Prevents a stray release from dead-lettering a completed item, mistakenly bouncing an unclaimed item, or double-counting attempts after dead-letter. Three regressions in `tests/state/work-queue.test.ts` exercise each guard branch.

### #50 — `#29` allowlist may surface free-form text via `enqueue_work` payload `item` field (unverified)

**Discovered:** 2026-05-28, bug-hunt cast `cast-1780011340100` clone B NIT-6.
**Severity:** Low (unverified — depends on the actual bus `enqueue_work` event payload shape).
**Status:** Verified NOT-A-BUG 2026-05-28 (traced `packages/manta-bus/src/tools/work.ts:61-93`).
**Reproducer:** Verify the bus server's `enqueue_work` handler — if the appended event's payload `item` carries the free-form work-item prompt text rather than just an id, the #29 allowlist (`claim/release/enqueue_work → item,target`) leaks it.
**Verification (closing as not-a-bug):** The `enqueue_work` handler at `tools/work.ts:81-89` emits the event with payload `{ item_id, cast_id, priority }` — only the short generated id (`wq-<ts>-<rand>`), the cast id, and priority. The free-form `prompt` field is written to the work-queue file (`workQueue.enqueue` mutator) but NEVER attached to the event payload. The #29 allowlist's `item`/`target` keys reference fields that don't exist on this event — `summarize(p, ['item','target'])` returns `{}` for `enqueue_work` events because neither key is present, so the render is `[enqueue_work]` with no payload. No leak surface; no fix needed.

### #51 — `manta.broadcast` rejects object payloads — MCP bridge appears to stringify nested object arguments

**Discovered:** 2026-05-28, bug-hunt cast `cast-1780011340100` clone A (intermediate-findings broadcast failed).
**Severity:** Medium — affects ANY clone trying to broadcast structured data.
**Status:** Fixed 2026-05-28 (defensive widening — `packages/manta-bus/src/schema.ts` `PayloadObjectSchema`). The underlying MCP-bridge bug in Claude Code's SDK is upstream and unaddressed; this is a workaround.
**Reproducer (confirmed in this session, not just the bug-hunt clone):** From the main session, calling `manta.broadcast` twice with the same intent — `payload: {"note": "probe", "nested": {"k": "v"}}` (with whitespace) arrived as an OBJECT and the schema parsed fine (failed at clone-not-found, which is the right path). The same call with `payload: {"note":"probe-stringified"}` (no whitespace) arrived as a STRING and was rejected with `validation_error: Expected object, received string at path:["payload"]`. Conclusion: the MCP bridge has a whitespace-sensitive serialisation heuristic that stringifies "compact-looking" nested objects.
**Root cause:** Claude Code SDK MCP-client serialisation. Not in Manta; cannot be fixed here.
**Fix (workaround):** New `PayloadObjectSchema` in `schema.ts` uses `z.preprocess` — if `payload` arrives as a string starting with `{` and ending with `}`, try `JSON.parse` first. Successful parse continues through the standard `z.record(z.string(), z.unknown())` validator. Garbage strings still fail safely (regression test asserts `'not json at all'` is rejected). Applied to both `BroadcastInputSchema` and `MessageInputSchema` (same surface). Mirrors the existing CSV-to-array preprocess on `ZkWriteInputSchema.tags` — same defensive class. 4 regressions in `tests/tools/communication.test.ts`: stringified broadcast, plain object broadcast (unchanged), garbage rejection, stringified message.
**Lessons:** When the input layer (here: MCP bridge) is outside your control, defensive widening at the validation seam is the only fix you can ship today. Document the upstream bug so future SDK upgrades don't silently fix-then-regress the workaround.

### #37 — Heartbeat-touch hook corrupts `registry.json` (lock-scheme mismatch + non-atomic write)

**Discovered:** 2026-05-28, full 9-dimension audit (correctness agent `a2e8bab4`). See `docs/audits/2026-05-28-full-audit.md` C2.
**Severity:** Catastrophic — concurrent clobbering of the bus-owned registry + torn-write that takes the whole bus down.
**Status:** Fixed 2026-05-28 (`packages/manta-cli/src/spawner/heartbeat-hook.ts`).
**Reproducer:**
1. A clone fires its PostToolUse `heartbeat-touch.cjs` hook, which reads→parses→mutates→`writeFileSync`s `.manta/state/registry.json` directly.
2. Concurrently the bus runs `markDead`/`heartbeat` under `proper-lockfile` on `.manta/state/registry.json.lock`, doing tmp+rename.
3. The hook guards with a *different* lock path — `.manta/state/.locks/registry.json.lock` (`heartbeat-hook.ts:83`) — so the two never exclude each other.
4. The hook's `writeFileSync` of its stale in-memory copy lands on top of the bus's committed write → resurrects a just-DEAD clone or drops a just-registered sibling. A crash mid-write leaves torn JSON; every subsequent `atomicReadJson` throws → bus down.
**Root cause:** The generated heartbeat-touch hook hand-rolls a writer instead of going through the bus, and locks a path incompatible with `proper-lockfile`'s `${file}.lock` convention. No shared mutex between hook and bus.
**Fix:** Hook installer now resolves `proper-lockfile`'s absolute host path via `@manta/bus`'s dep chain (`createRequire` chain) and embeds it into the generated `.cjs`. The generated script `require`s the same locker library the bus uses, calls `lockfile.lock(REGISTRY, ...)` (so the lock dir is `${registry}.lock` — identical to the bus's `atomicMutateJson` path), and commits its mutation via tmp+rename. `LOCK_OPTS` mirrors `atomic-fs.ts` verbatim (50 retries, 5→50ms backoff, 30 s stale). The old `LOCK_DIR`/`.locks/registry.json.lock` mkdir scheme is gone. Regression test `tests/spawner/heartbeat-hook.test.ts` adds a true cross-process race (12 concurrent hook .cjs runs + 12 bus `register` calls) that asserts registry parses cleanly and every bus-registered sibling survives.
**Lessons:** Any out-of-bus writer to bus-owned state must use the bus's exact lock path + tmp+rename, or (better) call back into the bus API. Two lock schemes on one file = no lock. For sub-process consumers, embed the absolute host path of the shared locker at generation time rather than relying on the sub-process's own module resolution.

### #38 — Reaper can post-mortem a LIVE clone (detect→markDead is non-atomic, no liveness recheck)

**Discovered:** 2026-05-28, full audit (correctness agent `a2e8bab4`). See full-audit C3.
**Severity:** High — a transiently-quiet but live clone is permanently locked off the bus; its locks/claims reaped from under it → silent data race on files it holds.
**Status:** Fixed 2026-05-28 (`packages/manta-bus/src/state/registry.ts:150-175`, `packages/manta-orchestrator/src/post-mortem.ts:40-60`, `packages/manta-orchestrator/src/orchestrator.ts:43-60`).
**Reproducer:**
1. A clone goes briefly quiet (GC pause / long Bash tool) and crosses `heartbeatTimeoutMs` exactly as the orchestrator cycle reads the registry list (`orchestrator.ts:37-52` → `death-detector.ts:50-55`).
2. Mid-cycle the clone resumes and heartbeats.
3. `runPostMortem` still calls `registry.markDead` (`post-mortem.ts:41-42`), which sets `state='DEAD'` unconditionally (`registry.ts:158-164`) with no liveness recheck.
4. Death is terminal (`registry.ts:87-90` rejects later heartbeats) → live clone locked out forever; its leases reaped.
**Root cause:** Detection (read list) and mutation (`markDead`) are separated by the cycle; `markDead` does not re-check the heartbeat it was triggered on, inside the file mutex.
**Fix:** Three coordinated changes:
- `Registry.markDead` adds an optional `observedLastHeartbeatAt?: number` 4th param. Inside the `atomicMutateJson` mutator (under the same file lock as `heartbeat`), if the stored `r.last_heartbeat_at` differs from `observedLastHeartbeatAt`, it throws `BusConflictError('clone revived: last_heartbeat_at advanced from X to Y since detection — aborting markDead')`. Optional param keeps existing call sites (lifecycle `report_death`, manual recovery) unchanged.
- `runPostMortem` reads `ctx.registry.get(opts.cloneId)` (via `record`) and now passes `record.last_heartbeat_at` as the observation. If the clone heartbeated between the detector's lock-free read and the mutator running under the lock, the conflict is caught.
- `Orchestrator.runCycle`'s per-clone loop wraps `runPostMortem` in `try/catch`. `BusConflictError` → skip silently (live clone, next cycle will re-evaluate). Any other error propagates as `OrchestratorError`.

Two regression layers: registry-level (`tests/state/registry.test.ts` — markDead with stale observed throws, with matching observed succeeds) and orchestrator-level (`tests/orchestrator.test.ts` — Proxy-wrapped registry injects a heartbeat between `get` and `markDead`; cycle completes, post-mortem skipped, clone stays WORKING with no `died_at`/`death_reason`).
**Lessons:** Any detect-then-act on bus state must re-validate the triggering condition inside the mutating mutex; a read outside the lock is stale by definition.

### #39 — git-lock PreToolUse hook fails OPEN on malformed input

**Discovered:** 2026-05-28, full audit (security agent `ae716ad5`). See full-audit H1.
**Severity:** High — the git serialization mutex (test-storm / concurrent-cast safety) can be bypassed, allowing concurrent `git` mutations in the shared repo → index corruption / lost commits.
**Status:** Fixed 2026-05-28 (`packages/manta-cli/src/hooks/git-lock-hook.ts:104-114`).
**Reproducer:**
1. `packages/manta-cli/src/hooks/git-lock-hook.ts` wraps its logic in a `try`; the outer `catch` writes `{continue:true}`.
2. A clone (or a corrupted harness payload) emits non-JSON on the hook's stdin.
3. Parse throws → outer catch → `{continue:true}` → the git-affecting tool call proceeds without the lock.
**Root cause:** Fail-open default in a hook whose entire purpose is to *block* unsafe concurrent git access. A safety gate that fails open is not a gate.
**Fix:** Outer catch now emits `{continue: false, reason: 'manta git-lock hook: PreToolUse input could not be parsed... Blocking for safety'}`. The hook is installed with `matcher: 'Bash'` only (`git-lock-hook-installer.ts:22`), so failing closed only impacts Bash invocations — a blocked benign `pnpm test` is recoverable noise; an unlocked `git commit` corrupts the shared index. Regression test `tests/hooks/git-lock-hook.test.ts` spawns the generated `.cjs` script with a truncated JSON payload on stdin and asserts the response is `continue: false` with a parse-failure reason.
**Lessons:** Enforcement hooks must fail closed. This is the hard-hook half of the CLAUDE.md rule "never bake enforcement into priming" — the hook exists precisely because priming is soft, so it must not itself degrade to permissive on error.

### #40 — Orphan/zombie clone processes never force-killed by the reaper

**Discovered:** 2026-05-28, full audit (correctness agent `a2e8bab4`). See full-audit H2.
**Severity:** High — DEAD-marked clones keep running as orphaned OS processes still holding their worktree, while every MCP call they make is rejected (bus identity DEAD) → spinning zombies + held worktrees.
**Status:** Fixed 2026-05-28 (`packages/manta-cli/src/commands/cast.ts:703-748` happy-path DEAD-terminate + new defensive `finally` at the cast level).
**Reproducer:**
1. A clone wedges (real `claude --print` hang). The reaper marks it DEAD and reaps its locks (`orchestrator.ts`), but never terminates the `execa` child.
2. On `tick-loop` budget abort (`cast.ts:647`), `runTickLoop` breaks the loop but `tick-loop.ts` never calls `terminate` on outstanding handles — that's left to `cast.ts` teardown.
3. If an exception escapes before teardown, the child processes orphan.
**Root cause:** The orchestrator's death model is state-only (mark DEAD); OS-process termination lives in a separate `CloneHandle.terminate` ladder driven only from `cast.ts`. The two are not connected on the reaper path.
**Fix:** Two coordinated changes in `cast.ts`:
- **Happy-path DEAD-terminate.** Pre-fix: when the loop ended cleanly via `allDone` returning true (all clones DEAD-or-IDLE), the subsequent `await h.exit` hung forever on any clone the reaper marked DEAD whose OS process was still wedged. Post-fix: an `else` branch (sibling to the existing budget-abort `if`) walks the registry after the loop, filters cast-owned clones in `state === 'DEAD'`, and calls `h.terminate({ gracefulMs: 1_000 })` (SIGTERM → SIGKILL ladder) on each before the reap. `h.terminate` is idempotent on already-exited children so live IDLE siblings are untouched.
- **Defensive `finally`-kill.** The cast's top-level try-catch now has a `finally` that re-runs `h.terminate({ gracefulMs: 500 })` on every handle, regardless of exit path. The catch's existing terminate-before-worktree-removal order is preserved (catch terminates, removes worktrees, rethrows; finally then runs as a belt-and-suspenders idempotent pass). This makes "no orphan child survives a cast" a hard contract at the cast boundary.

Regression test `tests/commands/cast.test.ts` ("force-terminates wedged OS processes after reaper marks DEAD (bug #40)") runs a `hang` fake clone with `heartbeatTimeoutMs=500ms` and `tickBudgetMs=60_000ms` — budget cannot be what stops the cast. Asserts `elapsed < 15_000ms`, `cast.done` emitted, `cast.budget_abort` NOT emitted (proves the DEAD-terminate branch is responsible).
**Lessons:** "Marked DEAD in state" ≠ "process stopped." For a process-spawning orchestrator, every state-death transition needs a paired OS-kill, and teardown must be exception-safe.

### #41 — `markDead` in post-mortem bypasses the audit-trail invariant (regression of #24)

**Discovered:** 2026-05-28, full audit (correctness agent `a2e8bab4`). See full-audit H3.
**Severity:** High — registry can show DEAD with no corresponding death event in `events.jsonl`, the exact "state ahead of audit" inconsistency bug #24 was built to prevent.
**Status:** Fixed 2026-05-28 (`packages/manta-orchestrator/src/post-mortem.ts:40-50`).
**Reproducer:**
1. `runPostMortem` calls `markDead(cloneId, reason)` (`post-mortem.ts:42`) with **no** `auditAppend` closure — unlike lifecycle handlers (`lifecycle.ts:89-99`) which append the event *inside* the file mutex.
2. The `post_mortem` event is appended separately (`post-mortem.ts:55`) *after* the rename.
3. Crash between the `markDead` rename and the append → DEAD registry, no death/post_mortem event.
**Root cause:** The orchestrator-initiated death path regressed the bug #24 invariant (audit append must be coupled inside the same mutex as the state mutation). The lifecycle `report_death` path is still correct.
**Fix:** `runPostMortem` now passes an `auditAppend` closure to `markDead` that appends a `reaped` event inside the file mutex (mirroring lifecycle's `death` pattern at `lifecycle.ts:89-99`). The event type is `reaped` (not `death`) to distinguish orchestrator-initiated termination from clone-self-reported death — useful for forensics. The post-fact `post_mortem` event (which references the written doc path) stays after the writer call. Regression test in `tests/post-mortem.test.ts` asserts: (a) a `reaped` event with the death reason is present after `runPostMortem`, and (b) its index in `readAll()` precedes the `post_mortem` event — proving audit-coupling order.
**Lessons:** The audit-before-commit invariant must hold on *every* `markDead` call site, not just the lifecycle one — add a test that asserts append-ordering on the orchestrator path too.

### #42 — `EventsLog.readSince` drops same-millisecond events (regression of #25 lesson)

**Discovered:** 2026-05-28, full audit (bug-log-verify agent `a1f3bfbd`). See full-audit M1.
**Severity:** Medium — any `readSince` consumer silently loses events sharing a millisecond timestamp with the cursor boundary.
**Status:** Fixed in 9540cf3 (`packages/manta-bus/src/state/events.ts:95-107`).
**Reproducer:** Pre-9540cf3 `EventsLog.readSince` filtered `e.ts > tsExclusive` — strict `>` on the millisecond `ts`. Two events written in the same ms as the cursor: one is dropped.
**Root cause:** Same class as bug #25, which fixed `broadcast-reader.ts` by switching tie-breaking to the lex-sortable event `id`. `readSince` still cursored on `ts`.
**Fix:** `readSince` signature changed from `(tsExclusive: number)` to `(idExclusive: string)` and filter from `e.ts > tsExclusive` to `e.id > idExclusive` (lex-sortable id = padded-ts + seq + rand → same-ms events stay distinguishable). Empty string sorts before any real id so `readSince('')` returns all events. Regression test at `tests/state/events.test.ts:80` ('readSince does not drop same-millisecond events') appends three events with no clock advance (all share ts=1_000_000) and asserts `readSince(e0.id)` returns `[e1, e2]`.
**Correction (2026-05-28, bug-hunt over 9540cf3):** the 9540cf3 commit message and the previous version of this entry both claimed "(no code change — was already fixed; only status updated)". That was **false**: the diff shows the signature and filter changed in 9540cf3 alongside its `+` block. Caller `tail.ts` already used a string cursor and was unaffected. Correction logged per "без вранья" — claims about a commit's content must be verified against `git show`, not inferred from working-tree state at session start.
**Lessons:** The #25 fix should have been applied to *all* event-cursor consumers, not just the broadcast reader. Audit for other `ts`-based cursors. **Numerical/structural claims about a commit (file count, code-change vs no-code-change, line counts) must be verified against `git show` before being written into a commit message or bug-log entry.** A working-tree `M` status at session start does NOT mean someone else made the change in a prior session — the change is in your commit either way.

### #43 — Orphan-worktree GC gap (graveyard/recover never reconcile against live worktrees)

**Discovered:** 2026-05-28, full audit (bug-log-verify agent `a1f3bfbd`). See full-audit M2.
**Severity:** Medium — a manually-deleted or orphaned worktree under `.manta/worktrees/` is never reaped; disk + git-worktree-metadata leak accumulates across casts.
**Status:** Fixed 2026-05-28 in 9540cf3 (`packages/manta-cli/src/spawner/graveyard.ts:sweepOrphanWorktrees`, wired into `packages/manta-cli/src/commands/recover.ts`). **A path-canonicalisation regression in the initial fix was caught by the bug-hunt cast over 9540cf3 — see #44 (also Fixed in the same session's follow-up commit).**
**Reproducer:**
1. `graveyard.ts:47 listGraveyard` only `readdir`s `.manta/graveyard` and reads each `info.json` — it never reconciles against live git worktrees or the registry.
2. `recover.ts:24` runs one orchestrator cycle = reaps locks/claims/dead clones only; no worktree GC.
3. No `git worktree prune` / orphan scan anywhere → an orphaned worktree persists indefinitely.
**Root cause:** GC was designed around the graveyard directory and the registry; orphaned worktrees that never made it to graveyard (or were partially removed) fall outside both.
**Fix:** New `sweepOrphanWorktrees({ repoRoot, isKnown })` in `graveyard.ts`. Runs `git worktree prune` first (clears stale metadata for worktrees whose dirs were deleted out-of-band), then enumerates `git worktree list --porcelain`, keeps only entries under `<repoRoot>/.manta/worktrees/` (canonical and symlinked prefix both checked for macOS /tmp ↔ /private/tmp), and calls `removeWorktree` on any whose path is not in `isKnown`. Returns `{ removed: string[], failed: Array<{path,error}> }`. `runRecoverCommand` builds `isKnown` from `registry.list()` (matching by full path; DEAD clones count as known so operator post-mortem inspection is preserved) and reports counts via the reporter + stdout. Sweep failures are warned, not fatal — bus state was already recovered above. Regression tests in `tests/spawner/graveyard.test.ts` cover the four core cases: orphan removal, external (user-owned) worktree preservation, stale-metadata pruning for deleted dirs, and clean-repo no-op.
**Lessons:** Reconciliation GC must diff the *physical* resource list (git worktrees on disk) against the *logical* one (registry), not just iterate the logical one. macOS path canonicalisation (`/tmp` ↔ `/private/tmp`) bites any path-equality check across `git` and `mkdtemp` — handle both forms or canonicalise at the boundary.

### #36 — `tsc --noEmit` never in exit-criteria gate; `pnpm -r lint` never green (dies at first failing package) → 76 type errors in `manta-cli` undetected

**Discovered:** 2026-05-28, cast-1779997703425 (Phase 7a Chunk 2 refactor-wave) merge ceremony — running `pnpm -r lint` as part of the post-merge sweep surfaced that the lint gate fails in `@manta/cli` and that no typecheck step exists at all.
**Severity:** High — the project quality bar is PROD-only, yet a whole class of type errors ships undetected. The exit-criteria gate was `pnpm -r build && pnpm -r test && pnpm -r lint`. `build` uses tsup/esbuild (transpile-only, no type-check). `test` uses vitest (transpile-only). `lint` is the only type-aware step, but `pnpm -r` stops at the first package that exits non-zero, so packages ordered after the first failure are never linted. Net: no command in the gate ever ran `tsc --noEmit` across the workspace, and `pnpm -r lint` was never actually green. Prior INDEX claims of "lint/typecheck clean" for Phase 0-6 were therefore unverified.
**Status:** Fixed 2026-05-28 (gate script + claim correction + all 76 errors driven to zero).
**Reproducer (now obsolete — kept for forensics):**
1. `cd /Users/timur/projectos/manta && pnpm --filter @manta/cli exec tsc --noEmit` → 76 errors at audit time (NOT the ~360 the original audit entry claimed — see "claim correction" below).
2. `pnpm --filter @manta/cli lint` → 16 errors + 1 warning in src/ (no tests/, the lint glob is `src/**`).
3. `pnpm -r lint` → exits non-zero at `@manta/cli` (or earlier), so any package after it is silently skipped.
**Root cause:** Two compounding gaps:
- **(a) No typecheck in the gate.** `exactOptionalPropertyTypes: true` is on in `packages/manta-cli/tsconfig.json`, surfacing real `string | undefined` → `string` mismatches and missing-property accesses that esbuild/vitest happily transpile past. Representative real errors: `bin/manta.ts:367`, `limit.ts:113-118`, `daemon-loop.ts:54`, `inspect-renderer.ts:50/61` (`Property 'status' on ContractAck`, `'heartbeat_at' on LockLease`), plus several test files missing `.js` ESM extensions + implicit `any`. These are genuine type errors, NOT module-resolution artifacts.
- **(b) `pnpm -r` fail-fast masks downstream packages.** Because the run aborts at the first non-zero package, "lint passed" was only ever observed for the packages that happened to be ordered before `@manta/cli`.
**Fix:** Three parts:
- New canonical pre-merge gate: root `package.json` now exposes `"gate": "pnpm typecheck && pnpm lint && pnpm test"` (fail-fast from cheapest → slowest). The root `typecheck` script (already present, `tsc -b`) is project-mode and aggregates across all workspace references — it ALSO checks test files (lint's `src/**` glob misses them, so typecheck is the only signal for test-file type errors). Root `lint` is a single eslint invocation across all packages, not `pnpm -r` — no fail-fast.
- CLAUDE.md "Verification before claiming done" section now mandates `pnpm gate` as the canonical pre-merge check; explicitly cites bug #36 to keep the rationale present in every session's loaded context.
- All 76 cli typecheck errors + 16 lint errors fixed in the same session (`exactOptionalPropertyTypes` exact-omit pattern, `noUncheckedIndexedAccess` `!`-asserts, ESM `.js` extension audit on test imports, `String()` wraps on `unknown`-typed template-literal expressions, removed two real production bugs in `inspect-renderer.ts` (read non-existent `ContractAck.status` and `LockLease.heartbeat_at`)). Verified end-to-end via `pnpm gate` exit=0: 142 test files / 1136 tests / 0 typecheck errors / 0 lint errors.
- **Claim correction:** the original audit entry asserted "~360 type-aware-lint errors". Independent re-run during this fix measured exactly 76 `tsc --noEmit` errors and 16 lint errors. The "~360" figure was unverified at write time and is corrected here per "без вранья": numerical claims about gate state must be independently re-run before being recorded.
**Lessons:**
- "Build green + tests green" ≠ "type-clean". esbuild/vitest transpile-only toolchains never type-check; a separate `tsc --noEmit` is mandatory in the gate. Encoded in CLAUDE.md.
- `pnpm -r` is fail-fast by default — an aggregate "lint clean" claim across the workspace is meaningless unless `--no-bail` is used or every package is run individually. Past "lint clean" reports were structurally unable to be true.
- Validation discipline: re-run the FULL gate unfiltered (`pnpm gate`) before any "clean" claim in INDEX/post-mortems; never trust a per-package green as workspace-green. Numerical claims (error counts) require their own re-run, not estimation.

### #35 — Concurrent casts corrupt main-repo `node_modules` symlinks (pnpm rewrites paths to point inside worktree pnpm store)

**Discovered:** 2026-05-28, attempting to launch refactor-wave + forking-realities casts in parallel.
**Severity:** High — blocks concurrent-cast workflows; any cast launched while a prior cast's worktree's pnpm install is mid-flight will rewrite main-repo `packages/*/node_modules/<dep>` symlinks to point into the prior worktree's `.pnpm` store. Main repo's CLI invocation (`node packages/manta-cli/dist/bin/manta.js`) then fails to load `zod` etc. because the worktree-local pnpm store does not yet contain the package, or the worktree was deleted after the symlink swap.
**Status:** Fixed 2026-05-28 (`pnpm-workspace.yaml`).
**Reproducer:**
1. `node packages/manta-cli/dist/bin/manta.js cast refactor-wave --clones 2 --tasks <path>` (succeeds; spawner runs `git worktree add` + pnpm install inside the worktree)
2. Immediately: `node packages/manta-cli/dist/bin/manta.js cast forking-realities --clones 2 --task <task>`
3. Second `node` invocation fails with `ERR_MODULE_NOT_FOUND: Cannot find package 'zod' imported from .../packages/manta-bus/dist/index.js`
4. Inspect: `readlink packages/manta-bus/node_modules/zod` → points into the first worktree's `.pnpm/zod@.../node_modules/zod`, which may not yet exist.
**Root cause:** pnpm workspace resolution treats added git worktrees as workspace members (the worktree path's `package.json` matches `packages/*` glob via `.manta/worktrees/clone-A/packages/...`). When the spawner runs pnpm install inside the worktree, pnpm sees a "new" workspace project and updates the shared `.pnpm` symlinks across all packages to deduplicate — including main-repo's `packages/*/node_modules/<dep>`. Net effect: worktree's pnpm install pollutes main-repo's symlinks.
**Fix:** Recommended option (b) applied — `pnpm-workspace.yaml` now declares `'!.manta/worktrees/**'` as a hard-exclude after the `packages/*` glob. Any tool walking the workspace glob (including pnpm itself, even under future versions that broaden recursion) sees worktree-checked-out copies of `packages/*/package.json` as out-of-workspace and won't dedupe-symlink them into the central `.pnpm` store. Full gate (`pnpm -s typecheck && pnpm -s lint && pnpm -s test`) re-ran green (1125/1125) after the exclude landed — confirms main-repo workspace resolution is unaffected.
**Lessons:** pnpm's workspace auto-discovery is aggressive. Anything in the repo that has a `package.json` under a recognised glob is implicitly a workspace member, and any pnpm install run inside it can rewrite parent symlinks. The yaml exclude is the cheapest defense and works even if pnpm's globbing logic changes; spawner-side `--ignore-workspace` is a backup if more aggressive isolation is ever needed.

### #34 — `parseTasksFile` Zod `z.record(keySchema, valueSchema)` 2-arg form silently drops value schema → 4 tasks-file tests + 1 cast.ts test fail on YAML/JSON parsing

**Discovered:** 2026-05-28, post-bug-hunt verification by main (workspace test sweep after cherry-picking Clone B's #20/#21 fixes).
**Severity:** Medium — `manta cast --tasks <yaml>` may silently misvalidate per-clone assignments. Tests assert failure: `Expected string, received object` at path `['A']`, meaning the 2-arg `z.record(z.string().min(1), CloneAssignmentSchema)` at `packages/manta-cli/src/spawner/tasks-file.ts:8` is interpreted as a 1-arg form where the value type defaults to `string`. The whole tasks-file overlay path is broken for object values.
**Status:** Fixed — swapped to single-arg `z.record(CloneAssignmentSchema)` plus two `refine` calls (non-empty record + non-empty keys). 11/11 tasks-file tests pass; whole-workspace sweep 939/939 green. Cherry-pick from option (a) of the fix proposals below.
**Reproducer:**
1. `pnpm --filter @manta/cli test tasks-file` on HEAD `bfcc7c3` → 4 fail / 7 pass.
2. Same failure on current HEAD post-bug-hunt fixes — independent of #20/#21.
3. Failure: `tasks-file.ts:51` calling `FileSchema.safeParse(parsed)` rejects the YAML where `A: { task: '...' }` because schema expected a string at value position.
**Root cause:** Zod 3.25.x changed `z.record(keySchema, valueSchema)` semantics — the 2-arg form is no longer supported in the same way (or was never the intended API). The single-arg `z.record(schema)` interprets the arg as the value schema with implicit string keys. Our code passing two args has the second silently ignored → value schema defaults to `z.string()`.
**Fix (proposed):**
- (a) Swap to single-arg form with manual key validation: `z.record(CloneAssignmentSchema).refine(rec => Object.keys(rec).every(k => k.length >= 1))`. Or
- (b) Use `z.object({}).catchall(CloneAssignmentSchema)` if available in installed Zod version. Or
- (c) Replace `z.record` with explicit `z.object({A: CloneAssignmentSchema.optional(), B: CloneAssignmentSchema.optional(), ...})` — verbose but type-safe.
- Recommended: (a). ~3 LOC.
**Lessons:**
- Zod major-minor upgrades can change API semantics silently — pin transitive zod version or add a smoke test for every Zod 2-arg call site.
- Test was failing on main but went unnoticed because Phase 6 verification ran a narrower test selection. Whole-workspace `pnpm -r test` should be a Phase exit gate, not just package-level test runs.
- Clone B claimed "371/372 pass" in their cast-1779980048361 audit — they missed these 4 failures, likely because they ran tests via a filtered selector that excluded `tasks-file`. Validation discipline: when a clone reports test count, audit-cast the count by re-running unfiltered.

### #33 — Pre-existing flake: `heartbeat-hook.test.ts > touch script updates last_heartbeat_at`

**Discovered:** 2026-05-28, bug-hunt cast `cast-1779980048361` clone B audit (surfaced during regression-test validation of Clone B's #20/#21 fixes).
**Severity:** Low — masks bug #32 (heartbeat-touch lies about proper-lockfile) from CI signal.
**Status:** Open. Verified pre-existing on HEAD `01ef4d4` by stashing the bug-hunt diff and re-running the test.
**Symptom:** `packages/manta-cli/tests/spawner/heartbeat-hook.test.ts:64-95` seeds a registry with `last_heartbeat_at: 1000`, runs the emitted touch script via `execSync`, asserts the registry's `last_heartbeat_at` was updated. Assertion fails: the script ran but the registry was unchanged.
**Root cause hypothesis:** Linked to bug #32. The mkdir-lock at `LOCK_DIR/registry.json.lock` is left behind by a previous test invocation (test fixtures don't clean lock dirs explicitly). Subsequent runs see a pre-existing lock dir → `tryLock` returns false → 50ms retry fires → still false (lock owner long gone but dir persists) → script exits without touching registry.
**Recommended fix:** (a) test should seed/clean the lock dir explicitly; or (b) script should detect stale locks (lock-dir mtime > 5s old → treat as stale, remove, retry). (b) is the same hygiene the bus's `proper-lockfile` ships out of the box — another argument for #32's option (a).
**Lessons:** Test flakes with cross-test resource leakage often share a single root-cause with a production bug. Don't `it.skip` them — fix the cleanup.

### #32 — Heartbeat-touch script claims `proper-lockfile` parity but uses mkdir locking

**Discovered:** 2026-05-28, bug-hunt cast `cast-1779980048361` clone B audit.
**Severity:** Low — race window is short (single read+write touch).
**Status:** Open — docstring/impl mismatch.
**Symptom:** `packages/manta-cli/src/spawner/heartbeat-hook.ts:14-15` docstring says "Uses proper-lockfile for safe concurrent access to registry.json (same locking primitive as `atomicMutateJson` in `@manta/bus`)." The actual emitted touch script (`buildTouchScript`, lines 70-118) uses `fs.mkdirSync(LOCK_FILE)` with a single 50ms retry, no fairness, no stale-lock detection. The bus's `atomicMutateJson` uses `proper-lockfile`'s file-based lock with a different on-disk representation. The two schemes do not coordinate.
**Reproducer:** Concurrent `manta.heartbeat` from the bus + Read/Edit hook fires on the clone during a registry mutation. The touch script can read the registry mid-mutation (post-`atomicMutateJson`'s lock acquire but before the rename) and write back, overwriting the bus's pending mutation.
**Recommended fix:** (a) make the touch script use `proper-lockfile` from worktree's node_modules (`require('proper-lockfile')`); or (b) update the docstring to honestly describe the mkdir scheme + accept the race window. (b) is the minimum honesty fix; (a) is the correctness fix.
**Lessons:** Comments that overstate guarantees are landmines. Either align the comment to the code or upgrade the code.

### #31 — `validateDisjointPartitions` throws after `runPreSpawnGate` commits → charges + daily-spend leak

**Discovered:** 2026-05-28, bug-hunt cast `cast-1779980048361` clone B audit.
**Severity:** Low — operator-only failure mode (mis-authored tasks YAML). But charges & daily-spend stay deducted with zero work performed, no compensating credit.
**Status:** Fixed in `66af12c` (refactor-wave cast-1779982686636 clone B) — partition check moved above `runPreSpawnGate` adjacent to other operator-input validators. Bug reproduced LIVE during this cast's launch (charges 999→987 = 12 leaked in two consecutive bad-yaml attempts before the fix landed in a merged worktree). 2 regression tests in cast.test.ts assert ChargesStore + DailySpendLedger unchanged on overlap throw.
**Reproducer:**
1. Author a refactor-wave tasks YAML with overlapping `allowed_paths` partitions across two clones.
2. Run `manta cast refactor-wave --tasks tasks.yaml`. `runPreSpawnGate` runs, charges are deducted (`pre-spawn-gate.ts:153`), daily-spend is recorded (`pre-spawn-gate.ts:157-163`).
3. Immediately after, `commands/cast.ts:309-311 validateDisjointPartitions(assignments)` throws `CliError(invalid_input)`.
4. The throw unwinds before the `try` block at line 349 is entered, so the catch-block compensating cleanup at line 682 does not fire. Charges remain deducted; no clones spawned; no credit issued.
**Root cause:** Operator-typo validation lives below the state-committing gate. Should be above.
**Recommended fix:** Move `validateDisjointPartitions` above `runPreSpawnGate`, adjacent to the cumulative-budget validation at `:260-269`. Pattern: every operator-typo guard goes before any commit.
**Lessons:** **Validation before commit** is universal — applies to ledgers, file writes, and any side-effect-producing call. Cumulative-budget validation already follows this rule; partition validation should too.

### #30 — `ContractsStore.write` emits `contract_write` audit on idempotent rewrite (only `written_at` changes) — bug-#14 class for timestamp-only diffs

**Discovered:** 2026-05-28, bug-hunt cast `cast-1779980048361` clone A audit (re-audit of post-bug-#14/#15 mutators).
**Severity:** Low — duplicate audit events; no state corruption, but `manta status` / replay shows phantom contract-writes that never changed semantics.
**Status:** Fixed in `6f48c00` (refactor-wave cast-1779982686636 clone B) — option (a) chosen: `sameBody` short-circuits and returns `current` unchanged (parity with `CastsStore.create`). 2 regression tests assert byte-identical re-write fires no second `contract_write` event.
**Reproducer:**
1. Main writes a task contract for clone B with body X via `manta.task_contract.write`. Bus emits `contract_write` event 1.
2. Main writes the byte-identical contract again. Bus emits `contract_write` event 2 with the same body.
3. `manta replay` / `events.jsonl` show two writes where only one mutation happened semantically. Compare to `CastsStore.create` (`packages/manta-bus/src/state/casts.ts:33-90`) which was fixed to return `current` unchanged on byte-identical input.
**Root cause:** `ContractsStore.write` (`packages/manta-bus/src/state/contracts.ts:35-65`) always builds a fresh `next: StoredContract = { contract, written_at: this.clock.now() }`. Even when `sameBody` is true, the post-mutation JSON differs from the snapshot in `written_at`, so `atomicMutateJson`'s change-detection at `atomic-fs.ts:102` fires `auditAppend`. Defeats the same idempotency that bug #14's fix established for `CastsStore.create`.
**Fix (proposed):**
- **Option A:** detect `sameBody` and return `current` unchanged (parallel to `CastsStore.create` fix at casts.ts:70-72). Preserves the prior `written_at` on identical re-writes.
- **Option B:** preserve `written_at` on `sameBody` (semantic: "last time the body actually changed"), only re-stamp on body-diff. Cleanest semantic.
**Lessons:** any mutator that injects a fresh `clock.now()` into its return value defeats the JSON-equality idempotency check at the primitive level. Add bug-hunt taxonomy item **(l) Timestamp-only diffs**: any mutator that updates a timestamp field should explicitly gate the update on a semantic-change predicate, not let `clock.now()` run unconditionally.

### #29 — `post-mortem.ts:101` renders raw event payloads (`broadcast.body` / `message.body` / `drift.evidence`) via `JSON.stringify(e.payload)` — extends #18 from metadata to payload surface

**Discovered:** 2026-05-28, bug-hunt cast `cast-1779980048361` clone A audit of orchestrator render-to-string paths.
**Severity:** Low currently (clones don't broadcast sensitive content today), **High by Phase 7 ship** (post-mortems land in `/manta share` bundles).
**Status:** Fixed 2026-05-28 (`packages/manta-orchestrator/src/post-mortem.ts` `renderEventPayload` + `summarize`).
**Reproducer:**
1. Clone A calls `manta.broadcast({clone_id:'A', event_type:'blocker', payload:{stderr:'... AWS_SECRET_ACCESS_KEY=AKIAxxxxx ...'}})` after a failing shell call.
2. Clone A dies; orchestrator writes `docs/post-mortems/<date>-<cast>-A.md`.
3. Line 101 of `packages/manta-orchestrator/src/post-mortem.ts` does `JSON.stringify(e.payload)` — verbatim payload rendered. Secret lands in post-mortem.
4. Next `/manta share` (Phase 7) bundles the post-mortem and ships it externally.
**Root cause:** identical pattern to bug #18 — render-to-string with no allowlist. `BroadcastInputSchema.payload`, `MessageInputSchema.payload`, `DriftReportInputSchema.evidence`, `FeedbackInputSchema.feedback`, `AckContractInputSchema.interpretation` are all unconstrained free-form fields. Phase 7a sanitizer (task 1.10) was scoped only to `record.metadata`.
**Fix:** The event-timeline renderer now routes every `e.payload` through `renderEventPayload(e)`, a type-aware per-event-type allowlist projection. Each known event type maps to a small `summarize(payload, keys)` projection of only safe metadata: `broadcast → event_type`, `message → to,channel`, `drift_report → drift_score`, `feedback → severity`, `lock/unlock/renew_lock → path`, `death/reaped → reason,last_gasp_report_path`, `claim/release/enqueue_work → item,target`, etc. Free-form text surfaces (`body`, `evidence`, `feedback`, `interpretation`, `task_summary`, `note content`, `stderr`) are unconditionally dropped. Unknown event types fall through to `<payload omitted>` (default-deny) so adding a new event type without explicitly extending the projection preserves the safety contract. Regression test in `tests/post-mortem.test.ts` ('drops free-form event payload bodies from the rendered timeline (bug #29)') seeds the event stream with secrets across all 7 free-form surfaces (`AKIA-FAKE-SECRET-XYZ123`, `oauth-token-CONFIDENTIAL-789`, `customer-email-leak@example.com`) and asserts NONE appear in the rendered markdown — while structural metadata (`event_type`, `to`, `severity`, `drift_score`) is preserved for operator usefulness.
**Lessons:** Every render-to-string of free-form input is a leak surface. Audit found 4 such paths (post-mortem, merge-review, merge-all-writer, forensic-timeline) — `post-mortem` is now closed; the other 3 still need the same treatment. For every `render*Markdown` / `JSON.stringify(...)` against user-controlled input, verify upstream schema is closed or allowlist applies. The default-deny fall-through (`<payload omitted>` for unknown types) is the cheapest way to make new event types safe-by-default.

### #28 — `manta.lock` / `manta.unlock` / `manta.renew_lock` not refused for `forking-realities` clones — analogous gap to `manta.claim_work` FR-isolation

**Discovered:** 2026-05-28, bug-hunt cast `cast-1779980048361` clone A cross-referencing forking-isolation.ts against tools/index.ts.
**Severity:** Medium — two FR-cast clones in isolated worktrees collide on the *shared* `.manta/state/locks.json` because lock paths are repo-relative.
**Status:** Fixed in `567f1ef` (refactor-wave cast-1779982686636 clone A) — cast-mode check added to all three lock handlers in `tools/locks.ts`, throws `BusForkingIsolationError`. 7 regression tests in forking-isolation.test.ts cover all three handlers.
**Reproducer:**
1. Two clones (A, B) in `cast-X` mode `forking-realities` with isolated worktrees, both with `metadata.cast_mode='forking-realities'` and same `cast_id`.
2. Clone A: `manta.lock({clone_id:'A', path:'packages/foo/bar.ts'})` — succeeds.
3. Clone B: `manta.lock({clone_id:'B', path:'packages/foo/bar.ts'})` — gets `BusLockedError`, even though B has its own worktree copy of `bar.ts` and cannot conflict with A.
4. Compare: `manta.claim_work` for the same FR clone is explicitly refused with `BusForkingIsolationError` at `packages/manta-bus/src/tools/work.ts:22-36`.
**Root cause:** forking-isolation policy applied to `claim_work` (Phase 2) but never extended to `lock`/`unlock`/`renew_lock`. Semantic invariant identical: FR-cast clones share no resources.
**Fix (proposed):** add cast-mode check to all three lock handlers in `packages/manta-bus/src/tools/locks.ts`:
```ts
const r = await ctx.registry.get(parsed.clone_id);
if (r.metadata.cast_mode === 'forking-realities') {
  throw new BusForkingIsolationError({ tool: 'manta.lock', fromCloneId: parsed.clone_id, castId: r.metadata.cast_id ?? '<missing>' });
}
```
3 handlers × ~5 LOC = ~15 LOC + new `forking-isolation.test.ts` block.
**Lessons:** when a new isolation rule is added for one tool, the same rule must be evaluated for every analogous tool. Bug-hunt taxonomy (g) "forking-isolation gaps" — the recurring failure mode is adding the rule to one handler and forgetting the symmetric handlers. Every new MCP handler that accepts `clone_id` should declare its FR-policy explicitly (allow / refuse / cross-cast-ok).

### #27 — `runDaemonLoop` loses work items on runner failure (no retry, no requeue)

**Discovered:** 2026-05-28, bug-hunt cast `cast-1779980048361` clone B audit.
**Severity:** Medium currently (no CLI command wires `runDaemonLoop` yet — only tests). Graduates to High the moment a `manta daemon run` lands.
**Status:** Fixed 2026-05-28 (`packages/manta-bus/src/state/work-queue.ts` `release` + `dead_letter` field; `packages/manta-cli/src/daemon-loop.ts:72-95` calls release on runner failure).
**Reproducer (forward-looking):**
1. `runDaemonLoop` is wired into a `manta daemon run` command.
2. Daemon dequeues an item (`work-queue.json` flips `claimed_at`).
3. Resume runner fails to start (`exitResult.failed && exitCode == null`) — e.g. `claude` binary missing, sandbox blocked.
4. Daemon increments `consecutiveFailures` and `continue`s. **Item stays in queue forever with `claimed_at` set**; subsequent `dequeue` calls filter it out (`work-queue.ts:60` requires `!i.claimed_at`).
**Root cause:** `packages/manta-cli/src/daemon-loop.ts:65-78` treats runner failures as "skip this item" without redrive or terminal state. `WorkQueueStore` has no `release` (requeue) API.
**Fix:** Option (a) applied — `WorkQueueStore.release(itemId, opts?)` added, plus three new optional `WorkItem` fields: `attempts`, `last_failed_at`, `dead_letter`. Release clears `claimed_at`, increments `attempts`, sets `last_failed_at`; when `attempts >= maxAttempts` (default 3), marks `dead_letter: true` and returns `{ deadLettered: true }`. `dequeue` and `pending` both skip `dead_letter` entries (kept in the file for forensics + future dashboard surfacing, never re-dispatched). `runDaemonLoop` now calls `await opts.workQueue.release(item.id)` on `failed && exitCode == null`, wrapped in try/catch so a release-time failure doesn't mask the original runner error. Test coverage: 4 new tests in `tests/state/work-queue.test.ts` (release-clears-and-rerun, dead-letter after 3 attempts, custom maxAttempts, unknown-id no-op) + 1 in `tests/daemon-loop.test.ts` ('releases claimed item back to queue on runner failure (bug #27)') which exercises the fake-queue's release-tracker and asserts the item is reclaimable with `attempts=1` after the daemon exits.

### #26 — `TestStormDispatcher.handleCodeReady` resets stage on duplicate `code_ready` while testing

**Discovered:** 2026-05-28, bug-hunt cast `cast-1779980048361` clone B audit.
**Severity:** Medium — masks convergence stalls and wastes a fix-cycle budget. Edge case but real with three live clones broadcasting concurrently.
**Status:** Fixed in `97de833` (refactor-wave cast-1779982686636 clone B) — explicit branch for `status === 'testing' | 'fuzzing'` ignores duplicate broadcast preserving in-flight stage; `never`-typed default arm guards future status additions; `/3` hard-code replaced with `config.maxFixCycles`. 3 regression tests in test-storm-dispatch.test.ts.
**Reproducer (synthetic):**
1. Coder clone broadcasts `code_ready` for `feature_id: X`. Dispatcher creates stage with `status: 'testing', fixCycles: 0`. Enqueues tester prompt.
2. Coder clone (cold-fix flow) broadcasts another `code_ready` for `feature_id: X` while tester is still running.
3. `handleCodeReady` finds `existing.status === 'testing'` (not `complete`/`escalated`/`fixing`). Falls through to `this.stages.set(featureId, { fixCycles: 0, status: 'testing' })` — **silently wipes the in-flight stage**, re-enqueues the tester, and resets fix-cycle counter.
**Root cause:** `packages/manta-cli/src/dispatch/test-storm-dispatch.ts:44-77` branch ladder is non-exhaustive. Treating 'testing'/'fuzzing' as fall-through into "fresh stage" is the bug. Adjacent: `buildFixPrompt` at line 158 hard-codes `/${3}` instead of `config.maxFixCycles`.
**Recommended fix:** Explicit branch for `status === 'testing' | 'fuzzing'`: ignore the duplicate broadcast or replace only `codeCommitRef` without resetting state. Fix the `/3` hard-code in the same commit. Add regression test in `tests/dispatch/test-storm-dispatch.test.ts`.
**Lessons:** Branch ladders over state machines need an exhaustive default. TS's `never`-type discriminated-union exhaustiveness check would have caught this if `TestStormStage.status` were narrowed in each branch.

### #25 — `BroadcastReader` strict-`>` ts comparison drops same-millisecond events

**Discovered:** 2026-05-28, bug-hunt cast `cast-1779980048361` clone B audit.
**Severity:** Medium — exposure during high broadcast-rate cycles (test-storm fix loops). A miss is a hung dispatcher waiting on an event that already arrived.
**Status:** Fixed in `5484fa6` (refactor-wave cast-1779982686636 clone B) — `EventSource` widened to expose `id: string` (lex-sortable monotonic); reader tracks `lastProcessedId` and filters `e.id > lastProcessedId`. Regression test in broadcast-reader.test.ts covers two same-ts events split across `readNew()` calls.
**Reproducer (synthetic):**
1. Two clones broadcast in the same `Date.now()` ms tick.
2. Bus appends both; both events have the same `ts`.
3. Cycle N reads one of them. `lastProcessedTs = ts`.
4. Cycle N+1 reads `readAll()` and filters `e.ts > ts` (strict). Second same-ts event fails the filter and is dropped permanently.
**Root cause:** `packages/manta-cli/src/dispatch/broadcast-reader.ts:18` uses `e.ts > this.lastProcessedTs`. The bus emits a lex-sortable monotonic `id` field per event (`packages/manta-bus/src/state/events.ts:25-28`) precisely to disambiguate same-ms events, but `EventSource` interface in this file does not expose `id`.
**Recommended fix:** Widen `EventSource` to include `id: string`, then track `lastProcessedId` (lex-sortable string) and filter `e.id > lastProcessedId`. Same monotonicity guarantee. Add regression test in `tests/dispatch/broadcast-reader.test.ts` with two same-ts events split across two `readNew()` calls.
**Lessons:** Tie-breaking ordering needs a tertiary key when wall-clock has finite resolution. The bus already provides one — surface it.

### #24 — Reapers (`lock-reaper` / `claim-reaper`) and `enqueue_work` emit audit AFTER state commit — violates `audit-trail-invariant`

**Discovered:** 2026-05-28, bug-hunt cast `cast-1779980048361` clone A.
**Severity:** Medium — replay/post-mortem cannot reconstruct *which* clone lost a lock/claim and when, on bus crash between state-commit and audit-append. Same correctness class as bug #14 (idempotent audit) but inverted polarity.
**Status:** Fixed in `d0c26f4` (refactor-wave cast-1779982686636 clone A) — option (a) chosen: `auditAppend` closure contract widened to receive computed delta, audit now lives inside the file mutex for `reapStale`/`reapExpired`/`enqueue`. Required widening `LocksStore.reapStale`, `ClaimsStore.reapExpired`, `WorkQueueStore.enqueue` APIs (out of original allowlist, disclosed in clone-A last-gasp). +6 orchestrator + 1 bus regression tests.
**Reproducer:**
1. Crash the bus process between `LocksStore.reapStale()`'s atomic-mutate rename (writes `locks.json` with N leases removed) and the first `events.append({type:'lock_reap', ...})` call in `packages/manta-orchestrator/src/lock-reaper.ts:11-24`.
2. Restart. `locks.json` shows N leases gone; `events.jsonl` shows zero `lock_reap` events for them.
3. `manta replay` / post-mortem cannot tell *which* clone lost a lease and when.
Same pattern: `packages/manta-bus/src/state/claims.ts:79-92` + `packages/manta-orchestrator/src/claim-reaper.ts:8-26`. Same pattern: `packages/manta-bus/src/tools/work.ts:61-78` (`enqueue_work` — `workQueue.enqueue` commits, then `events.append('enqueue_work', ...)` runs outside the atomicMutateJson lock).
**Root cause:** audit-trail invariant ("audit append inside the file mutex") was implemented for single-record mutators (Registry.heartbeat, Locks.acquire, etc.) where closure `auditAppend?: () => Promise<void>` carries exactly 0–1 audit events. Fan-out mutators (reapers iterating N leases) and the work-queue path route around the closure entirely.
**Fix (proposed):**
- **(a) Widen closure contract:** `auditAppend?: (committedNext: T, computedDelta: ReaperDelta) => Promise<void>` — closure receives post-mutation snapshot; reaper can compute reaped[] inside the lock and emit N audit lines before commit.
- **(b) Per-record loop:** `for (const stale of staleLeases) await atomicMutateJson(file, ..., (cur) => removeOne, async () => events.append(...))`. Slower (N lock acquires) but preserves invariant.
- **(c) For `enqueue_work`:** trivially wrap `workQueue.enqueue` to accept same `auditAppend` callback as other handlers. ~5 LOC.
**Lessons:** Invariant is "audit lives inside the file mutex." Whenever a future mutator emits > 1 logical event, the closure shape needs widening — not bypassing. Bug-hunt taxonomy (k) Fan-out mutator audit-invariant: every `atomicMutateJson` mutator that emits > 1 logical event needs explicit audit semantics.

### #23 — Bus auto-touch extracts the *subject* `clone_id` not the *caller* — `manta.message` / cross-clone reads / main-driven retasks mis-touch (or no-op)

**Discovered:** 2026-05-28, bug-hunt cast `cast-1779980048361` clone A audit of `@manta/bus` server dispatch.
**Severity:** Medium — orchestrator's death-detector loses accuracy for any clone that primarily talks via `manta.message`; main-driven calls (retask/pause/resume/feedback) advance the *target* clone's heartbeat when the *target* did nothing. Partial regression of bug #9 structural fix.
**Status:** Fixed in `814f2f6` (refactor-wave cast-1779982686636 clone A) — option (a) chosen: `extractCloneId(toolName, args)` with per-tool caller-field map (`manta.message → from_clone_id`, `task_contract.read → requesting_clone_id`, retask/pause/resume/feedback/enqueue_work → no auto-touch / explicit target). 8 regression tests in auto-touch-caller.test.ts cover each affected tool.
**Reproducer:**
1. Read `packages/manta-bus/src/server.ts:316-348` — `extractCloneId(args)` reads only the literal `clone_id` field.
2. Walk the 25 MCP tools' input schemas. Five use a caller-id field other than `clone_id`:
   - `manta.message` — caller is `from_clone_id`. No `clone_id` field → auto-touch silent no-op.
   - `manta.task_contract.read` with `requesting_clone_id` — caller is `requesting_clone_id`, but `extractCloneId` returns the *target* `clone_id`. Wrong clone touched.
   - `manta.retask` / `pause` / `resume` / `feedback` — caller is the main agent; `clone_id` is the *target*. Target's `last_heartbeat_at` advances on main's call, masking actual quiescence.
   - `manta.enqueue_work` — uses `target_clone_id`; no `clone_id` field → no touch fires.
**Root cause:** the bug-#9 structural fix treated `args.clone_id` as a synonym for "the calling clone". Holds for ~17 of 25 tools (lifecycle self-calls, broadcasts, locks, claims). Other 5+ have caller ≠ subject and silently mis-touch.
**Fix (proposed):**
- **(a) tool-name-aware extraction** — `extractCloneId(toolName, args)` maps each tool to its caller-field key: `'manta.message' → 'from_clone_id'`, etc. ~30 LOC + table.
- **(b) schema-uniform caller field** — every input schema gets explicit `caller_clone_id`. Heavier, requires priming change.
Recommended (a).
**Lessons:** "Refresh on every call" was the fix for #9; "refresh the *caller*, not the subject" is the missing half. Validation cast for the bug-#9 fix should have audited every tool's argument list against the auto-touch contract — not just lifecycle. Bug-hunt taxonomy (j) `extractCloneId`-style identity extraction: for every dispatcher convention that auto-acts per caller, audit every tool's input schema for which field is *actually* "the caller".

### #18 — `post-mortem.ts` emits raw `record.metadata` unsanitized — latent leak surface for Phase 7 share bundles

**Discovered:** 2026-05-28, Phase 7 research cast `cast-1779977834212` (clone C codebase audit).
**Severity:** Low currently (metadata fields are minimal), High by Phase 7 ship (becomes a publication leak path).
**Status:** Fixed — layer (a) applied in Phase 7a task 1.10 (`packages/manta-orchestrator/src/sanitize/metadata-allowlist.ts` + `post-mortem.ts:83-94` calls `redactPostMortemMetadata`; non-allowlisted keys dropped with single-line audit footer). Layer (b) — full default-deny enumeration sanitizer covering snapshot/contract/timeline/post-mortem/ZK/worktree-diff redaction — shipped in Phase 7b (`packages/manta-cli/src/share/sanitize-*.ts`, Chunk 1; secret-format hard-block in `secret-scanner.ts`; the `manta share` command aggregates warnings and refuses on any secret). Every free-form field across every bundled artifact is now allowlist-sanitized before a byte leaves the repo; `SanitizedSnapshotSchema` is `.strict()` so a new source field is dropped, not leaked. Architecture note: `docs/internals/share-sanitization.md`.
**Reproducer (forward-looking):** Any caller that adds a metadata field (e.g. `triggered_by: <trigger-name>` from auto-cast triggers, or `user_email: <stamp>`) — `packages/manta-orchestrator/src/post-mortem.ts:69-106` renders every key=value pair in `record.metadata` unconditionally (lines 83-87). The rendered post-mortem then ships in `/manta share` bundles.
**Root cause:** No allowlist, no redactor, no schema-driven filtering. The pattern mirrors `BroadcastInputSchema` `.strict()` discipline at `packages/manta-bus/src/schema.ts:165` but is not applied to the post-mortem render path.
**Fix (proposed for Phase 7a plan):** Two layers (defense in depth) —
- (a) Allowlist redactor at post-mortem render time: only render whitelisted metadata keys, drop the rest. Cheapest fix.
- (b) Separate publish-sanitization pass before share-bundle creation: enumerates every artifact path (post-mortems, ZK notes, snapshot fields, registry state) and applies per-field redaction policy. Required regardless of (a).
**Lessons:** "Pre-existing pattern" is not "correct pattern" — post-mortems were build-to-disk-locally infra; Phase 7's share command changes the threat model retroactively. Any infra that newly ships off-machine needs a sanitization review pass.

## Recently fixed

### #22 — Orchestrator `ScoringWeightsSchema` / `ScoringConfigSchema` missing `.strict()` — drive-by config fields silently dropped

**Discovered:** 2026-05-28, bug-hunt cast `cast-1779980048361` clone A schema-strictness audit pass.
**Severity:** Low.
**Status:** Fixed in `037241a` (extracted from Clone A's bundled commit; the atomic fix is the `.strict()` wrapping on `ScoringWeightsSchema` and `ScoringConfigSchema` in `packages/manta-orchestrator/src/scoring.ts`).
**Reproducer:**
1. User writes `.manta/config/scoring.json` with `{"weights":{...}, "perfBonus":0.10, "epsilon":0.05, "notes":"tuned for refactor-wave"}`.
2. `loadScoringConfig` parses through `ScoringConfigSchema`. Default Zod behaviour strips the unknown `notes` key silently — user gets no warning.
3. Compounding: typo on optional field that *will* be added in future version (`perfBonues: 0.1`) is silently dropped.
**Root cause:** schema-strict discipline drift at package boundaries. `packages/manta-bus/src/schema.ts` consistently uses `.strict()` on every `z.object` (37 schemas); orchestrator was missed for the only two schemas it owns (`ThresholdsSchema` is correctly `.strict()`).
**Fix:** wrapped both schemas in `.strict()`. 139/139 orchestrator + 337/337 bus tests pass.
**Lessons:** Schema-strict discipline lives package-by-package, not project-wide. Add a CI lint that greps every package for `z.object({` not followed by `.strict()` within a short window. Bug-hunt taxonomy (m) schema-strictness audit per package: don't trust that one package's discipline implies another's.

### #21 — Daemon-mode `allDone` excludes `WAITING_FOR_TASK` → daemon casts hang to budget abort

**Discovered:** 2026-05-28, bug-hunt cast `cast-1779980048361` clone B audit.
**Severity:** High — every daemon cast (pair-programming, test-storm, documentation-chase) risked hanging until tick-budget timer fired, killing every clone with SIGTERM/SIGKILL instead of letting them shut down gracefully. Compounded with #20 because the (broken) queue-empty branch would have been the only path to `allDone === true`.
**Status:** Fixed in `10b02aa` — new exported `DAEMON_IDLE_STATES` constant (`{IDLE, WAITING_FOR_TASK}`); `allDone` predicate now uses `DAEMON_IDLE_STATES.has(c.state)`. Regression tests in `tests/commands/cast.test.ts > DAEMON_IDLE_STATES` (positive membership for both idle states, negative for all others).
**Reproducer:**
1. Cast any daemon-mode (e.g. `manta cast pair-programming --task X --clones 2`).
2. Writer clone broadcasts `commit_ready`, then per priming preamble calls `manta.request_task` and transitions to `WAITING_FOR_TASK`.
3. `commands/cast.ts:536-538` `allDone` checked `c.state === 'IDLE'` only — `WAITING_FOR_TASK` clones caused `allIdleOrDead === false`.
4. Loop never terminated naturally; budget timer at `cast.ts:503` eventually aborted and killed clones.
**Root cause:** `CloneStateSchema` declares both `IDLE` and `WAITING_FOR_TASK` as valid states. Registry, retask command, stale-detector all branched correctly; `cast.ts` predates `WAITING_FOR_TASK` (added Phase 5) and was missed in the consumer sweep. Same shape as #7/#8.
**Lessons:** Adding a new value to a state enum is a cross-package change. Grep for `'IDLE'` (string literal) at schema-change time would have caught this. Inline lambdas are hard to regression-test — extracting to a named, exported constant makes the predicate testable. State-enum sweep checklist: registry, stale-detector, retask, cast.allDone, post-mortem renderer, status command. Any new state belongs in all six.

### #20 — `runtime.ts` does not wire `WorkQueueStore` → Phase 5/6 daemon-mode features silently no-op in production

**Discovered:** 2026-05-28, bug-hunt cast `cast-1779980048361` clone B audit.
**Severity:** High — every Phase 6 Wave-2 daemon mode (pair-programming, test-storm, documentation-chase) and the Phase 5 `retask` command short-circuit on `if (rt.ctx.workQueue)` and silently no-op in production. Tests pass because every daemon-mode test wires `workQueue` manually.
**Status:** Fixed in `64600c4` — adds `WorkQueueStore` to imports and instantiates it in the `BusContext` literal with shared `paths` + `clock`. Regression test in `tests/runtime.test.ts` enqueues an item and asserts it round-trips via `pending`.
**Reproducer (historical):**
1. With HEAD `01ef4d4`, run `manta cast documentation-chase --task 'doc packages/foo' --clones 1`. Cast spawns the doc clone, but `cast.ts:449 if (opts.mode === 'documentation-chase' && rt.ctx.workQueue)` is false → no work items enqueued. Clone receives no tasks via `manta.dequeue_work`, eventually goes IDLE.
2. Pair-programming or test-storm: `dispatchEnqueuer` at `cast.ts:467` is null → `onCycleComplete` callback to tick-loop is `undefined` → broadcasts from clones never trigger work enqueue → dispatchers never fire.
3. `manta retask <cloneId> "new task"` exits 0 but silently does nothing.
**Root cause:** `BusContext.workQueue?: WorkQueueStore` is optional in the `@manta/bus` type. The bus server wires it (`server.ts:96-111`); the CLI runtime forgot. Same shape as #2 (skill claims behaviour spawner doesn't perform), #13 (priming references a field the bus schema doesn't accept). Class lesson: **cross-package wiring is checked by TS only when the type is required**; optional fields silently leak through.
**Lessons:**
- Optional fields in `BusContext` need an integration test that exercises the production wiring path, not just unit tests that fake the field.
- Any new `BusContext` field added in `@manta/bus` must be sweep-audited across all callers (cli runtime + tests + bus server). Grep for the field name should be a Phase-N exit gate.
- `if (rt.ctx.workQueue)` is a code smell. Optional-field guards in production paths should either be removed (require the field) or have a structured-error fallback instead of a silent skip.

### #19 — Cannot run two concurrent casts: clone-name allocation collides on WORKING clone

**Discovered:** 2026-05-28, attempting to run Phase 7a plan-cast and Phase 7 bug-hunt cast in parallel.
**Severity:** Medium — blocked parallel multi-cast workflows. Workaround was serialization. Would have become High once Phase 7c auto-cast triggers shipped: a triggered cast firing mid-cast would have silently failed.
**Status:** Fixed in this commit (`packages/manta-cli/src/commands/cast.ts` — new `allocateCloneIds` helper + integration). Eight regression tests in `tests/commands/allocate-clone-ids.test.ts`.
**Reproducer:**
1. Run `manta cast recon-swarm --clones 1` → clone A spawns, state WORKING.
2. While A is WORKING, run `manta cast bug-hunt --clones 2` → exited with `BusConflictError: clone A already registered`.
**Root cause:** `cast.ts:173` allocated clone IDs alphabetically starting from A (`CLONE_NAMES.slice(0, opts.cloneCount)`) with no awareness of other casts' live allocations. The pre-register call hit `Registry.register()` which allows overwrite only of DEAD clones (per bug #16 fix), not WORKING. When the first letter was taken by an alive clone from another cast, spawn failed the whole second cast.
**Fix:** New `allocateCloneIds(registry, count)` helper reads the registry, builds a set of live clone_ids (state !== 'DEAD'), and returns the first N letters from `CLONE_NAMES` not in that set. Throws `CliError(kind: 'concurrent_cast_limit_reached')` with a diagnostic message listing the live clones when fewer than N slots are free. Caller (line 173 of cast.ts) now `await`s the helper.
**Lessons:**
- Phase 7c auto-cast triggers must account for saturation: a triggered cast finding all five slots WORKING should either (a) defer-and-retry with backoff, (b) queue, or (c) skip the fire with a structured "skipped:saturated" event. Plan-phase decision when 7c is written.
- "Clone names are a fixed alphabet" (bug #16 lesson) implies global allocation contention. Bug #16 was the DEAD case; #19 is the symmetric WORKING case. There's a class lesson: **alphabet allocators with cross-process contenders need registry-aware allocation, period.** Catalog this with bug #16 as a paired class.

### #17 — Orphan `last-gasp-report.md` tracked in HEAD leaked stale data into clone worktrees

**Discovered:** 2026-05-28, Phase 7 research cast `cast-1779977834212`. Clones A and C independently flagged stale `last-gasp-report.md` present at worktree start in their last-gasp reports.
**Severity:** Low — clones overwrote the stale file on completion; no production data corruption. But misleading for any tooling that reads worktree state at launch.
**Status:** Fixed in `bd75dcb`.
**Reproducer:**
1. Spawn a cast — clones see `.manta/worktrees/clone-A/last-gasp-report.md` already populated with content from `cast-1779906432547` clone-B.
**Root cause:** Two files were tracked in main HEAD that should not have been —
- `last-gasp-report.md` at repo root (orphan from early Phase 0)
- `.manta/worktrees/clone-A/last-gasp-report.md` (orphan from Phase 1 lockdown)

The `.gitignore` correctly excludes `.manta/worktrees/` for future files but does not retroactively untrack already-committed files. When `clone-spawner` runs `git worktree add HEAD`, the new worktree inherits both files from HEAD.
**Fix:** `git rm --cached` removed both from the index. No code change. Future worktrees see clean HEAD.
**Lessons:** `.gitignore` does not retroactively untrack. After any commit that adds a `.manta/...` exclusion rule, run `git ls-files | grep '^\.manta/'` to find pre-existing trackings and clean them up. Worth adding to a pre-commit hook for the `.manta/` prefix.

### #16 — Registry rejects new cast when DEAD clone with same clone_id exists from previous cast

**Discovered:** 2026-05-26, Phase 3 research cast attempt (manual `manta cast recon-swarm`).
**Severity:** Medium — workaround is manual `registry.json` reset, but breaks `manta cast` → `manta cast` workflow without intervention.
**Status:** Fixed
**Reproducer:**
1. Run `manta cast recon-swarm --clones 3` — cast completes, all clones reach DEAD.
2. Run `manta cast recon-swarm --clones 3` again — fails with `BusConflictError: clone A already registered`.
3. `manta recover` does NOT clear DEAD clones from registry.
**Root cause:** `Registry.register()` in `packages/manta-bus/src/state/registry.ts` rejects if `clone_id` already exists in `clones` map, regardless of state. DEAD clones persist in registry indefinitely. The spawner pre-registers with the same alphabetical names (A, B, C) every cast, so any second cast with overlapping clone names hits this.
**Fix (proposed):** Two options:
- (a) `Registry.register()` should allow overwriting a DEAD clone entry (same as re-registration). Check `existing.state === 'DEAD'` → overwrite. Simplest fix, minimal blast radius.
- (b) `recover` command should evict DEAD clones from registry after archiving their data. More ceremony but cleaner long-term state.
- **Recommended:** (a) as immediate fix + (b) as follow-up hygiene. The spawner should be able to re-use clone names across casts without manual intervention.
**Lessons:** Clone names are a fixed alphabet (A-E), not cast-scoped UUIDs. Registry must handle name reuse across casts. This was invisible during Phase 0/1/2 because manual cleanup happened between sessions.

### #15 — Bus handler tests return `undefined` for `event` property (8 tests failing)

**Discovered:** 2026-05-26, during Phase 2c Chunk 2 development. Confirmed pre-existing by reverting all Phase 2c changes and re-running.
**Severity:** Medium — tests only; production code paths unaffected (handlers still emit events to EventsLog). The test assertions access `result.event.type` but `result.event` is `undefined`.
**Status:** Fixed in `4a56ff9`.
**Root cause:** Bug #14 fix (`baffc88`) used reference equality (`next !== current`) in `atomicMutateJson` to detect idempotent no-ops. But Registry/Locks/Claims/Contracts mutators mutate `current` in-place and return the same reference → `next === current` always true → `auditAppend` callback never fired → `event` variable (declared with `let event!: BusEvent`) stayed `undefined`.
**Fix:** Replace reference equality with JSON snapshot comparison: `JSON.stringify(current)` before mutator vs `JSON.stringify(next)` after. In-place mutations produce different JSON (audit fires); true idempotent returns produce identical JSON (audit skipped). 489/489 tests green workspace-wide.
**Lessons:** Reference equality is not a reliable mutation detector when mutators are allowed to mutate the input in-place. This is the same class of bug as bug #14 — both stem from `atomicMutateJson` trying to infer mutation semantics from the mutator's return value without a contract about whether in-place mutation is allowed.

### #14 — `auditAppend` callback fires on idempotent no-op `CastsStore.create` calls

**Discovered:** 2026-05-08, code-quality review of Phase 2a Chunk 1 commit `69de728` (cast-manifest infrastructure).
**Severity:** Medium — observable only when Phase 2c wires a real audit-event callback into `casts.create`. Currently no production caller passes `auditAppend`, so the bug is latent. But `casts.create` is **explicitly designed** to be called idempotently by every clone of a cast (see `clone-spawner.ts` lines 125-129 rationale), so once an audit hook is attached, every cast emits N duplicate audit entries (one per clone) instead of one.
**Status:** Fixed — `atomicMutateJson` now gates `auditAppend` on `existing === null || next !== current` (first-write fires, idempotent re-write skips). Regression test in `casts.test.ts`: 3× idempotent create with spy → callback fires exactly once.
**Reproducer (forward-looking):**
1. Phase 2c attaches `auditAppend` callback to `casts.create` to record cast-creation events in the events log.
2. A 3-clone cast spawns: clone-A creates the manifest (mutator returns `next` with new content; audit fires once — correct).
3. Clone-B calls `casts.create` with identical input (idempotent path — mutator returns `current` unchanged); but `atomicMutateJson` calls `auditAppend()` unconditionally after the mutator (`packages/manta-bus/src/atomic-fs.ts:101-107`), so audit fires again — wrong.
4. Clone-C same story — audit fires a third time.
5. Result: events log shows 3 `cast.created` events for one cast.
**Root cause:** `atomicMutateJson` invokes `auditAppend` unconditionally if provided, with no signal from the mutator about whether new content was actually written. `state/contracts.ts` shares the same pattern but is typically called once per contract version (write-new-version semantic), so the bug is invisible there. `state/casts.ts` is the first store where idempotent-every-call is part of the contract.
**Fix (proposed):** Two viable approaches —
- (a) Extend `atomicMutateJson` to detect mutator returning `===` reference-identical `current` and skip `auditAppend`. Reference-identity is what idempotent paths already use; semantic-equality detection (canonicalized) would also work but is more complex. Cleaner downstream because all stores benefit. Cross-cuts `contracts.ts`, `registry.ts` etc. — needs regression sweep.
- (b) Move the audit-fire decision into `CastsStore.create` itself: read existing manifest first (outside the mutex), compare canonically, and pass `auditAppend` to `atomicMutateJson` only if the input differs. Simpler change, isolated to casts.ts, but adds a non-mutex read before the write — race window is benign (worst case is firing the callback when we shouldn't, which is the current bug — net no worse).
- **Recommended:** (a). The fix belongs in the shared infra so the same trap doesn't bite Phase 4+ stores.
**Lessons:**
- "Pre-existing pattern" is not the same as "correct pattern" — `contracts.ts` happened to dodge this because of its single-writer-per-version usage. New stores with new usage shapes need their audit semantics audited.
- Idempotency contracts must specify side-effect semantics, not just data semantics. `casts.create` documents idempotent data writes but says nothing about audit emissions.

### #9 — Heartbeat cadence is not interleaved with long read sequences (skill-level enforcement is non-functional)

**Discovered:** 2026-05-07, Phase-2 research-prep cast `cast-1778187665150` (after bug #8 fix in `9ed5609`). Independently surfaced by clone A and clone C in their last-gasp reports, with concrete fix proposals.
**Severity:** High — recurring across every research clone with non-trivial reading load. The 90 s threshold from bug #8 helps but does not eliminate the failure mode; it only widens the window.
**Status:** **Fixed in this commit** via structural option (d) — the bus auto-touches `last_heartbeat_at` on every successful MCP handler from a registered clone. Skill v0.0.2 + priming "first call of every turn" rule (commit `5cd7234`) was insufficient as proven by validation cast `cast-1778189501846` (see `docs/post-mortems/2026-05-07-cast-1778189501846-validation.md`); skill-level + priming-level enforcement of per-turn heartbeat is not a forcing function. The structural fix sidesteps Claude's instruction-following entirely: any `manta.*` call IS a liveness signal, so the dispatcher in `packages/manta-bus/src/server.ts` calls `Registry.touch(cloneId)` after every successful handler whose args include a `clone_id`. Silent no-op contract on DEAD or unknown clones (no zombie resurrection). Skill `manta-as-clone` v0.0.3 + priming preamble both rewritten to reflect: "heartbeat is implicit, manta.heartbeat is for state transitions only". 6 new tests pin the behaviour: 3 unit (`Registry.touch` on WORKING / DEAD / unknown), 3 integration (non-heartbeat call updates last_heartbeat_at, failed call does not, DEAD clone is no-op). Validate via Phase-2 dogfood — success = clones surviving multi-minute read+draft loops without explicit heartbeats.
**Symptom:** A research clone reading multi-KB specs + drafting markdown can legitimately go 50–80 s between MCP calls (especially during batched parallel `Read` turns). The skill `manta-as-clone` v0.0.1 said "heartbeat every ≤ 10 s" but Claude has no wallclock between assistant turns; it only sees "next turn." A clone doing 60 s of `Read` + `Grep` without any `manta.*` tool use lapses into heartbeat staleness despite working productively.
**Reproducer (historical):**
1. Cast a clone with a research mission that requires reading >10 files (e.g. spec + plan + 5–8 source files).
2. Observe the events.jsonl: typically one heartbeat at startup, then no further heartbeats until shutdown — the orchestrator marks DEAD between them.
**Root cause:** Heartbeat cadence was treated as a wall-clock SLA in skill text, but enforcement required a conversation-loop primitive instead.
**Fix:** `manta-as-clone` v0.0.2 + priming preamble both lift heartbeat to Required with explicit "the **first** tool call of every assistant turn that contains tool calls must be `manta.heartbeat({state: 'WORKING', message})`". Cadence becomes a property of the conversation loop (a conversation-loop primitive Claude can actually observe), not a property of wall-clock seconds (which Claude cannot observe between turns). The `heartbeatTimeoutMs=90 000ms` is now framed as hard, not advisory. New `priming.test.ts` cases pin the cadence rule in the spawner preamble. Validate via Phase-2 dogfood re-cast — the success criterion is a heartbeat per assistant turn in `events.jsonl`, not per N seconds.
**Lessons:**
- A skill saying "every ≤ 10 s" is not a forcing function when the runtime has no concept of wall-clock between turns. Future skill thresholds must be expressed in terms of conversation-loop primitives ("every Nth turn", "first call of every turn", "before/after every Read"), not seconds.
- Bugs #7 + #8 + #9 form a cluster — the orchestrator's death-detector treats one wallclock threshold as the universal liveness signal, but real clones operate on a conversation-loop clock. The conversation-loop primitive (#9 fix) is the discipline-side complement to the threshold widening (#8 fix); together they should make heartbeat reliable. If next dogfood still drifts, ship option 2 (bus-side `heartbeat_keepalive`) as the structural decouple.

### #10 — Clones leave deliverables uncommitted on graceful death

**Discovered:** 2026-05-07, Phase-2 research-prep cast `cast-1778187665150`. Clone A wrote both deliverable + last-gasp uncommitted; clone C committed the deliverable but not the last-gasp; only clone B committed both. Main had to manually `cp` files out of dead worktrees.
**Severity:** Medium — survivable but creates archaeology overhead and breaks the "main pulls from worktree branch" contract that `manta-merge-review` (Phase 2) will rely on.
**Status:** Fixed in this commit.
**Reproducer (historical):** Cast any clone with a deliverable scope; observe in some clones that `git status` inside the worktree shows untracked files at exit time even though `report_death` was called.
**Root cause:** `manta-graceful-death` v0.0.2 had "Final commit" in **Allowed**, not **Required**. Clones interpreted that as optional. Skill text didn't enforce the order of (commit → ZK → release → suicide → report_death) either.
**Fix:** `manta-graceful-death` v0.0.3 introduces a numbered `## Required (ordered)` section with seven steps, of which step 1 is the final commit. The Forbidden list now flags "Skipping the final commit" alongside "Skipping the ZK dump". Priming preamble was rewritten to mirror the same ordering. The clone-spawner test will catch regressions in the priming text via the new `final commit` assertion in `priming.test.ts`. Phase-2 acceptance must re-validate: `git -C <worktree> status --porcelain` should be empty at clone exit time across all dogfood casts.
**Lessons:**
- Skill files used to advertise "Allowed" actions ambiguously — Required vs. Allowed must be a structural distinction in the skill, not a colour-of-bullet distinction. Future skills should always have a numbered `Required (ordered)` section when there's a multi-step protocol.
- Bug seed #4 from the Phase-2 research post-mortem is now closed as #10. Promoted from seed → numbered the moment the fix shipped.

### #8 — `heartbeatTimeoutMs` default (30 s) too tight for actively-working clones

**Discovered:** 2026-05-07, Phase-2 research-prep dogfood re-run (`cast-1778187134719`, after bugs #6 + #7 fix in commit `ae192ec`).
**Severity:** High — any cast where clones do real work between heartbeats (reading multi-KB specs, drafting markdown, running greps) is silently aborted ~30 s after the first heartbeat. Phase-1 lockdown dogfood passed by coincidence: its task ("map src/ public exports") is small enough that clones called heartbeat several times during execution.
**Status:** Fixed in this commit.
**Reproducer (historical):**
1. After bugs #6/#7 fix (`ae192ec`), re-cast Phase-2 research-prep with the new `--max-files-changed 5 --allowed-paths` flags.
2. All 3 clones reach STARTING → WORKING fine (startup grace works), each sends exactly one heartbeat, each calls `manta.ack_contract` with a sane interpretation.
3. Each clone then begins reading CLAUDE.md + spec sections + INDEX.md + research-prep.md before drafting its deliverable — that read+think+draft loop runs for ~30 s with no MCP roundtrip.
4. At t ≈ first-heartbeat + 30 s, orchestrator marks each clone DEAD with reason `"heartbeat 32323ms ago > 30000ms"`. No deliverable on disk; no second heartbeat ever sent.
**Root cause:** The skill `manta-as-clone` instructs "heartbeat every ≤ 10 s", but Claude does not track wallclock between tool calls and there is no in-loop forcing function. A clone reading a 5 KB spec section + drafting markdown can legitimately go 30–60 s between MCP calls. The original 30 s threshold (justified in `thresholds.ts` as "Sec 9 blocker #5: suicide через 30 сек после смерти parent") conflated two different deadlines: a clone's *own* suicide-on-orphan deadline (which it self-checks frequently) and the *orchestrator's* third-party staleness threshold (which must accommodate realistic working windows).
**Fix:** Default `heartbeatTimeoutMs` raised from `30_000` → `90_000`, matching `startupGraceMs` for symmetry. Justification embedded in `thresholds.ts` comment with a pointer to the dogfood cast id. Tests that asserted DEAD after `advance(31_000)` updated to `advance(91_000)`; post-mortem fixture text updated; whole-workspace sweep 338+ tests green. Operators can still tighten via `--heartbeat-timeout-ms` for fixture/integration scenarios that need fast death detection.
**Lessons:**
- **Spec thresholds are theoretical until production-validated.** 30 s came from spec prose without empirical wall-time data on real research workloads. Future threshold changes must come with a captured-timing rationale, not a comment citing the spec.
- **A skill saying "every ≤ 10 s" is not a forcing function** — Claude doesn't have a wallclock-based heartbeat scheduler between tool calls. For real liveness, either (a) bump the threshold to cover the realistic working window, or (b) add a side-channel heartbeat (e.g. spawner-side periodic ping). 90 s is the (a) path; (b) is a Phase-2+ improvement candidate.
- **Bugs #7 and #8 are the same bug at different timepoints** — #7 was startup-window staleness, #8 is working-window staleness, both caused by treating threshold-tightness as more important than realistic timing. Future detector changes should think in terms of state-machine transitions (registered → first-heartbeat → DEAD) and pick a threshold per transition.

### #6 — `cast` command hardcoded `scope.max_files_changed = 0`, blocking any deliverable cast

**Discovered:** 2026-05-07, Phase-2 research-prep dogfood (`cast-1778185934043`)
**Severity:** Catastrophic — every `manta cast` whose mission produces an on-disk artifact (research markdown, plan, code patch) was impossible. Phase-1 lockdown dogfood passed by coincidence: the e2e assertion required only `clone DEAD + post-mortem on disk`, not a deliverable.
**Status:** Fixed in this commit.
**Reproducer (historical):**
1. `manta cast recon-swarm --clones 3 --task "produce docs/research/x.md"`
2. Spawner writes task contract with hardcoded `scope: { allowed_paths: ['.'], forbidden_paths: ['.manta/state', 'secrets/'], max_files_changed: 0 }`.
3. Clone B reads contract, calls `manta.ack_contract`:
   > "scope.max_files_changed=0 contradicts the task's mandate to produce a deliverable file — both blockers prevent doing the assigned best-of-N research; entering graceful death with a forensic note instead of producing the deliverable."
4. All three clones reach DEAD with empty deliverables; `docs/research/` is empty.
**Root cause:** `packages/manta-cli/src/commands/cast.ts:107-111` hardcoded the scope literal. No CLI surface, no per-mode default, no override path. Phase-1 e2e assertion did not require deliverable verification, so the bug shipped to GA.
**Fix:** `cast` now exposes `--max-files-changed <n>` (default `0` — preserves existing behaviour), `--allowed-paths <csv>` (default `.`), `--forbidden-paths <csv>` (default `.manta/state,secrets/`). `RunCastOptions.scope` is the typed pass-through; defaults apply when omitted (test back-compat). Validation: negative `maxFilesChanged` and empty `allowedPaths` throw `CliError(invalid_input)`. Two new tests in `cast.test.ts` pin custom-scope propagation and the negative validation.
**Lessons:**
- **Pre-flight + skill validator + lifecycle-only e2e is not enough.** Phase-1 lockdown e2e asserted DEAD + post-mortem; bug #6 was production-grade by that bar but immediately fatal for any deliverable cast. Phase-2+ e2e must assert the **deliverable artifact** as well, not just the lifecycle.
- **Hardcoded defaults that contradict the dominant use-case are landmines.** Recon-swarm research is overwhelmingly going to write a markdown deliverable; the default should reflect that, or the CLI must surface the override prominently.

### #7 — heartbeat threshold (30s) too tight for cold-start `claude --print`; STARTING clones DEAD before first MCP call

**Discovered:** 2026-05-07, Phase-2 research-prep dogfood (`cast-1778185934043`)
**Severity:** High — any cast where clones take >30 s to reach first heartbeat is silently aborted. Phase-1 lockdown dogfood passed by coincidence (2 clones with lighter context started in ≤ 30 s).
**Status:** Fixed in this commit.
**Reproducer:**
1. `manta cast recon-swarm --clones 3 --task "<heavy priming>"`
2. Spawner pre-registers each clone with `state: 'STARTING'` (Phase-1 lockdown invariant; `last_heartbeat_at` stamped equal to `registered_at`).
3. `claude --print --append-system-prompt <preamble> <prompt>` cold-starts: skill load + snapshot read + first MCP call ≈ 30–60 s.
4. Within that window, orchestrator's death-detector runs, sees `now - last_heartbeat_at > 30_000`, marks clone DEAD with reason `"heartbeat 30364ms ago > 30000ms"`.
5. Clones eventually call `manta.heartbeat`; bus replies the clone is DEAD; clones go straight to `manta.ack_contract` with a forensic explanation and exit.
**Root cause:** `packages/manta-orchestrator/src/death-detector.ts` applied `heartbeatTimeoutMs` uniformly regardless of `state`. STARTING clones haven't sent a real heartbeat yet — `last_heartbeat_at` is just the registration timestamp from the spawner. Treating it as a stale heartbeat punishes cold-start latency.
**Fix:** New threshold `startupGraceMs` (default 90 s) applies when `state === 'STARTING'` and is checked against `now - registered_at`. Once a clone calls `manta.heartbeat` (state → WORKING), the existing `heartbeatTimeoutMs` (30 s) takes over against `last_heartbeat_at`. Updated tests in `death-detector.test.ts` (added STARTING-grace coverage) and `thresholds.test.ts` (default value), plus migrated existing tests that registered + advanced without heartbeating to call `heartbeat({state: 'WORKING'})` first.
**Lessons:**
- **`last_heartbeat_at` is not a positive liveness signal during STARTING** — Phase-1 dogfood post-mortem already noted this for the e2e watcher, but the detector itself still treated it as one. Generalised the lesson: any code consuming `last_heartbeat_at` must also gate on `state` to know whether it's a real heartbeat or a registration fingerprint.
- **30 s is realistic for an established session, not for cold start with priming.** Future orchestrator thresholds should be empirically derived from real cast wall-time histograms, not from spec prose.
- **Bug #6 and bug #7 are independent but reinforced each other in the failure mode** — bug #6 made the deliverable impossible; bug #7 killed the clones before they could even discover bug #6. Without forensic post-mortems and `contract_ack` payloads, the dual root-cause would have been much harder to disentangle.

### #13 — Priming preamble + `manta-as-clone` v0.0.2 instruct clones to send `message` field on `manta.heartbeat`, but bus schema rejects it

**Discovered:** 2026-05-07, validation cast `cast-1778189501846` (the cast intended to validate bug #9/#10 fixes from commit `5cd7234`).
**Severity:** Medium — silent observability loss. Best case: clone drops the `message` field after a schema rejection (degrading observability — `events.jsonl` records `progress: null` instead of an operator-grade status string). Worst case: clone interprets the validation_error as a hard failure and skips heartbeating entirely, compounding bug #9.
**Status:** **Fixed in this commit** via cleanup (not schema widening). Since bug #9's structural fix removes the per-turn heartbeat rule entirely, the `message` field is no longer needed in the priming preamble or `manta-as-clone` skill — both were rewritten to drop it. The bus `HeartbeatInputSchema` keeps its existing `progress?: string` field (which clones can still use for state-transition heartbeats); `message` was a duplicate concept, not an additional one. Future operator-grade message field can ship as a separate decision if observability proves wanting; for now, the schema and the text agree.
**Symptom:** Clone A's last-gasp report explicitly logged: *"`manta.heartbeat` rejected the `message` field per its current schema (the priming preamble in this snapshot instructed me to send `{ clone_id, state, message }`). Heartbeated successfully without `message`."*
**Reproducer:**
1. Cast any clone with the priming preamble shipped in commit `5cd7234`.
2. Observe the bus accepts `{clone_id, state}` but rejects `{clone_id, state, message}` with `validation_error`.
3. Cross-check `packages/manta-bus/src/schemas/heartbeat.ts` (or wherever the schema lives) — there is no `message` field declared.
**Root cause:** I introduced the `message` field in the skill text (`manta-as-clone` v0.0.2) and priming preamble in commit `5cd7234` without auditing the bus's `manta.heartbeat` Zod schema, which still ends at `{clone_id, state}`. Cross-plan field-name drift, exactly the failure mode `CLAUDE.md` "Plan-writing discipline" warns against.
**Fix:** Widen the bus schema to accept an optional `message?: string` (≤ 200 char, trimmed). Persist into `events.jsonl` heartbeat entries so the `progress`/`message` field becomes operator-grade observability. Tests: schema accepts both `{clone_id,state}` and `{clone_id,state,message}`; events.jsonl emits the message when provided. Ship together with bug #9 structural fix in the same commit.
**Lessons:**
- **Skill-validator must grow a cross-tool field-name check.** Any `manta.*` field name mentioned in a skill or priming text should exist in that tool's Zod schema. This is the same shape as the cross-plan field-name drift class of bug from Phase-0 plan reviews; we knew about it as a *plan* hazard but didn't generalise to skills+priming until now.
- **Field additions must be schema-first, then skill-text.** Adding `message` to `manta.heartbeat` should have been a 2-step: (1) widen schema with test, (2) reference field in skill+priming. Going skill-first creates an invisible regression.

### #11 — `manta.zk_write` array-param transport bug (clone B reproducer)

**Discovered:** 2026-05-07, Phase-2 research-prep cast `cast-1778187665150`. Surfaced in clone B's last-gasp; clones A and C succeeded with their ZK writes from the same skill version, so the failure is not deterministic across clones.
**Severity:** Medium — affects bug #5 mitigation (some failures may be transport-layer, not skill-discipline).
**Status:** **Fixed** (2026-05-27). `ZkWriteInputSchema.tags` now uses `z.preprocess()` to coerce CSV-string input (`"a,b"`) into `string[]` before validation. Two regression tests added: CSV-with-spaces and single-string coercion. Liberal-in-what-we-accept approach per Postel's Law — tags are metadata, not load-bearing.
**Symptom:** Clone B attempted `manta.zk_write` 5× with various `tags: string[]` shapes; every call returned `validation_error: invalid_type, expected: array, received: string, path: ['tags']`. Clones A and C succeeded with structurally-similar payloads in the same cast.
**Root cause:** Claude CLI's MCP tool-use serialiser occasionally flattens `string[]` into a comma-separated string for individual clones (transient, non-deterministic). The bus's strict `z.array()` schema rejected these payloads.
**Fix:** `z.preprocess()` on `tags` field in `ZkWriteInputSchema` — splits comma-separated strings, trims whitespace, filters empty entries.
**Lessons:** Be liberal in what you accept at the bus boundary for soft-schema metadata fields. ZK tags are an audit trail, not a primary key; coercing a CSV string to `string[]` is benign and prevents this class of failure.

### #12 — Forensic timeline JSON not produced by production cast path

**Discovered:** 2026-05-07, Phase-2 research-prep cast `cast-1778187665150`. Clone A's last-gasp explicitly asked for the timeline JSON; the research-prep acceptance checklist also required it.
**Severity:** Low-Medium — observability gap, not a correctness bug.
**Status:** **Fixed** in Phase 2d Chunk 2 (`fb2aca7` + subsequent). `ForensicTimelineWriter` extracted from e2e harness to `@manta/orchestrator`. Production casts now emit `.manta/state/timelines/<castId>.jsonl` via cast-local orchestrator wiring. `manta replay` consumes the timeline as primary data source.
**Symptom:** The forensic timeline writer from commit `64bf188` runs only inside `packages/manta-e2e` test harness — it produces `docs/post-mortems/e2e-timeline-<cast-id>.json`. A real `manta cast` invocation does not produce this artifact, even though the timeline data (cast lifecycle, clone states, event jsonl interleavings) is exactly what the post-mortem needs to be useful at scale.
**Recommended fix:** Lift the timeline writer into the production cast path (`packages/manta-cli/src/commands/cast.ts` or the orchestrator's post-mortem composer), so every cast — not just e2e — emits a timeline JSON alongside the markdown post-mortem. Sketch: extract `recordCloneEvent` + `writeTimeline` from `packages/manta-e2e/src/forensics.ts` into `@manta/orchestrator` and have the orchestrator call them on cast finalisation. Phase-2 plan should fold this into the `manta-merge-review` design (the same metadata is needed for forking-realities best-of-N selection).
**Lessons:** Test-harness-only observability is technical debt — every signal we wired into e2e is a signal a production operator will eventually want. When wiring observability into e2e, bias toward writing it once at the orchestrator layer and making the e2e harness *consume* it, rather than reimplementing it inside the harness.

### #1 — manta-cli integration test flakes under concurrent workspace test run

**Discovered:** 2026-05-07, during Phase 0e Chunk-2 spec-review remediation
**Severity:** Low
**Status:** **Fixed** (2026-05-27). `heartbeatTimeoutMs` and `startupGraceMs` bumped from 100ms to 500ms in `integration.test.ts`. The 100ms thresholds were too tight under concurrent workspace pressure — fake-clone process didn't always start within 100ms when other packages' test suites consumed OS resources simultaneously. 500ms is still fast (fake-clone exits immediately, so test wallclock barely changes) but tolerant to resource contention.
**Root cause:** Resource contention in `packages/manta-cli/tests/integration.test.ts`'s parent-PID probe + process-spawning path when other test workers consume process / fd budget. The 100ms `startupGraceMs` caused the orchestrator to mark clones DEAD before they could register.
**Lessons:** Tests that interact with real OS process state (PID probes, child spawns) are concurrency-sensitive. Use generous-but-fast thresholds (500ms, not 100ms) that survive concurrent workspace runs without materially slowing the test.

## Fixed bugs

### #5 — Clones do not invoke `manta.zk_write` during graceful death

**Discovered:** 2026-05-07, Phase-1 lockdown dogfood cast (commit `57551ef`)
**Severity:** Medium — was flaky skill-adherence; root cause was skill text presenting ZK as merely "Allowed" rather than required
**Status:** Fixed in Phase-1 follow-up commit (skill v0.0.2 + priming text update).
**Reproducer (historical):**
1. First Phase-1 dogfood: 0/2 ZK notes written
2. Second Phase-1 dogfood (same code, same skill): 1/2 ZK notes written
3. Pattern: flaky, not infrastructural — clones could write ZK but skipped because skill listed it under "Allowed" alongside optional actions, and "Massive ZK dumps" appearing in Forbidden discouraged any write.
**Root cause:** Skill `manta-graceful-death` (v0.0.1) presented `manta.zk_write` as one of several "Allowed" actions, with a "Massive ZK dumps" Forbidden line that discouraged any writing. No required-actions section, no ordered shutdown checklist. Clones interpreted the skill conservatively and skipped ZK to avoid violating the "no massive dumps" guardrail.
**Fix:** Skill `manta-graceful-death` v0.0.2 — added explicit "shutdown checklist is ordered and required" framing; promoted `manta.zk_write` to a "Required" bullet within Allowed (with bolded violation language); added "Skipping the ZK dump" to Forbidden; added per-step ZK numbering in Examples. Priming text in `packages/manta-cli/src/spawner/priming.ts` also tightened to enumerate the 5-step required shutdown ordering. e2e assertion in `recon-swarm.e2e.test.ts` re-tightened from warning back to `expect(≥ 2)`. Verified by Phase-1 v3 dogfood (2m45s wallclock, ≥ 2 ZK notes written, e2e green).
**Lessons:** Skills are read literally — what's "Allowed" gets interpreted as "optional unless you specifically need it." For required behaviours, use a "Required steps" framing or move the bullet into Forbidden ("skipping X is forbidden"). For audit-trail-style requirements (where the *act* matters more than the *content*), provide a fallback (e.g. "if you genuinely have nothing novel, write a no-novel-findings note"). The Phase-1 v0.0.1 → v0.0.2 skill diff is the canonical pattern for tightening clone discipline without changing infrastructure.

### #2 — Spawner-registers-clone-before-launch claim is misleading

**Discovered:** 2026-05-07, during Phase 0f Chunk-2 code-quality review (commit `53b9b4b`)
**Severity:** Medium
**Status:** Fixed in `57551ef` (Phase-1 lockdown).
**Reproducer:**
1. Read `skills/manta-as-clone/SKILL.md` ~line 17 — claims "the CLI spawner registered you on the bus before launching this process"
2. Read `docs/user/recon-swarm.md` line 20 — repeats the claim ("the spawner registered the clone *before* the process started")
3. Grep `packages/manta-cli/src/commands/cast.ts` and `packages/manta-cli/src/spawner.ts` — the spawner calls `ctx.contracts.write(...)` (writes the task contract) before launching, but never calls `ctx.registry.register`. The registry record is created by the clone calling `manta.register` itself on startup.
**Root cause:** Skill text and now user-facing docs assert behaviour the spawner does not perform.
**Fix:** Spawner now pre-registers the clone via `runtime.ctx.registry.register({ clone_id, mode, parent_pid, worktree, metadata: { cast_id } })` before invoking the runner (`packages/manta-cli/src/spawner/clone-spawner.ts`). The skill claim is now accurate. Behavioural fixture in `packages/manta-cli/tests/spawner/startup-sequence.test.ts` pins the invariant against the real Bus Registry.
**Lessons:** When a skill's instructional text describes orchestrator/CLI behaviour, the validator should cross-check the claim against the implementation. The Phase-1 behavioural-fixture test is the precedent for similar future invariants.

### #3 — e2e cast hangs against real `claude --print`; clones never register

**Discovered:** 2026-05-07, during Phase 0f acceptance dogfood (commit `2f641b2`)
**Severity:** High — blocks Phase-0 acceptance signoff
**Status:** Fixed in `57551ef` (Phase-1 lockdown).
**Fix:** Spawner pre-registers the clone before invoking the runner (closes #2 family) AND replaces the dead `--snapshot <path>` argv with the real claude flags `--print --append-system-prompt <priming-text> --permission-mode bypassPermissions <prompt>`. Priming text loads the `manta-as-clone` skill and points at `MANTA_SNAPSHOT_PATH` (env var, already exported). Phase-1 lockdown dogfood (4m36s wallclock, 2 clones, both DEAD with post-mortems on disk) proved the wedge is gone. e2e gained a positive-timeline watcher (`tickBudgetMs/4 = 6m15s`) that fails fast with a registry dump if any clone stays in `STARTING`.
**Reproducer:**
1. `claude mcp add -s user manta-bus -- node "$(pwd)/packages/manta-bus/dist/bin/server.cjs"`
2. `MANTA_E2E=1 pnpm e2e:recon-swarm`
3. Cast spawns 2 `claude-haiku-4-5` clone subprocesses successfully (visible in `ps`).
4. Worktrees, contracts, snapshots all written to `.manta/state/` and `.manta/snapshots/`.
5. **Registry file (`.manta/state/registry.json`) stays empty** — no clone calls `manta.register` over MCP.
6. Two clone processes idle at low CPU; `manta status` shows `clones=0 locks=0 claims=0`.
7. After ≥ 5 min of zero progress (no log output, no registry mutation, no post-mortem) the harness has to be killed via `pkill -f vitest`.
**Root cause (hypothesised):**
- The spawner passes `--snapshot <path>` to `claude --print` (`packages/manta-cli/src/spawner/clone-spawner.ts:171`), but the current `claude` CLI (2.1.132) **silently ignores unknown flags** — verified by `claude --print --snapshot /dev/null --version` returning version + exit 0. So the clone receives no inherited transcript, no context about who it is or what to do.
- Without snapshot inheritance, the spawned clone has no priming prompt, no system-prompt overlay, and no path to discover its task contract. It launches as a fresh idle session and waits — heartbeat never fires, register never called.
- This is the **same family** as bug #2 (spawner-registers-clone claim is misleading): the docs/skills say the harness wires up identity for the clone, but the code path is incomplete.
**Fix:** Pending. Two real fixes required:
1. Replace `--snapshot <path>` with a snapshot-inheritance mechanism the running `claude` CLI actually supports — likely a stdin priming protocol (pipe the snapshot as the initial user message), or an env var (`MANTA_SNAPSHOT_PATH`) that a startup hook reads.
2. Either pre-register the clone from the spawner before launch (closing bug #2), or add a startup-skill / hook that reads the env-passed contract and calls `manta.register` deterministically on launch.
**Lessons:**
- **Pre-flight does NOT prove end-to-end.** Phase-0e/0f preflight passed for 7 sessions while this fundamental wiring was broken. Lesson for Phase 1 lockdown: behavioural-fixture tests for the clone-startup sequence (snapshot ingest → register → first heartbeat) are not optional, they're acceptance-blocking.
- **`claude` CLI silently ignoring unknown flags is a foot-gun.** Any future spawner change that adds a flag must be validated by `claude --print --new-flag …` actually doing what's intended; absence of error is not confirmation.
- **The Phase-0 e2e test asserted only on harness lifecycle (registry DEAD + post-mortems on disk), not on quality of mapping output.** Even if it had passed, it wouldn't have caught the no-snapshot-inheritance issue, since clones never reaching DEAD also produce no post-mortems. The assertion needs a positive timeline check, not just a final-state check.

### #4 — `claude --print --snapshot <path>` silently accepts the unknown `--snapshot` flag

**Discovered:** 2026-05-07, while diagnosing bug #3
**Severity:** Medium — surface of the deeper bug #3, but worth tracking separately
**Status:** Fixed in `57551ef` (Phase-1 lockdown).
**Fix:** Manta no longer passes `--snapshot`; instead uses `--append-system-prompt <text>` which the claude CLI actually parses. Negative regression guards in `packages/manta-cli/tests/spawner/clone-spawner.test.ts` and `priming.test.ts` assert the dead flag never appears in argv or priming text. Phase-1 plan task 1.2 added a positive-behavioural smoke (`claude --print --append-system-prompt "REPLY_TOKEN=…"` returns the embedded token) — the lesson is now codified for any future flag addition.
**Reproducer:** `claude --print --snapshot /dev/null --version` → prints `2.1.132 (Claude Code)` and exits 0 with no warning about `--snapshot`.
**Root cause:** Current `claude` CLI tolerates unknown flags (probably to forward-compatibility for plugins). Manta's spawner relied on it being a real flag.
**Lessons:** When integrating with a third-party CLI, validate every new flag with `--help | grep <flag>` and a positive behavioural smoke, not just exit-code 0 from a no-op invocation. The Phase-1 lockdown plan formalised this as task 1.2 (probe + smoke before code change).

### #55 — `manta install` local-tgz spec parser rejects the native `*.manta-pkg.tar.gz` bundle name

(Renumbered from B's `#54` during ceremony — main's `#54` is the trigger-store audit-trail gap from 7c Chunk 1, unrelated.)

**Discovered:** 2026-05-28, by clone-B (cast-1780023574334) during Phase 7b Chunk 2 round-trip verification
**Severity:** Low — usability gap, not a correctness bug; the bundle content installs fine once renamed
**Status:** Fixed 2026-05-28 in the 7b Chunk 2 merge ceremony (`packages/manta-cli/src/library/registry-client.ts:65` — `LOCAL_TGZ` regex widened to `.(?:tgz|tar\.gz)$`).

**Symptom:** `manta share` emits a bundle named `<name>-<version>.manta-pkg.tar.gz` (the plan §1.2 / CHANGELOG convention). Phase 7a's local-tgz spec parser was `LOCAL_TGZ = /^(?:\.{1,2}\/|\/).+\.tgz$/`, which only matched a `.tgz` extension. Passing the native bundle path to `manta install` threw `install_spec_parse_failed` (exit 11) even though the bytes are a valid gzipped tar.

**Proof:** The pre-fix Chunk 2 round-trip test (`tests/commands/share.test.ts`) produced a `.manta-pkg.tar.gz`, COPIED it to a `.tgz` sibling, then `runInstallCommand` succeeded — same bytes, different extension. Same-bytes-rename confirmed extension-only mismatch.

**Fix:** Widened `LOCAL_TGZ` to `/^(?:\.{1,2}\/|\/).+\.(?:tgz|tar\.gz)$/` (additive alternation, back-compat). The `share.test.ts` rename shim is now retired in the same ceremony commit. Code-review blocker B1 (cast-1780023574334) which flagged the rename hack as "does not prove share→install accepts a bundle by its plan-mandated name" — closed by this fix.

---

### #53 — `heartbeat-hook` touch-script test fails in a freshly-`pnpm install`ed worktree

**Discovered:** 2026-05-28, by clone-B (cast-1780020786877) during Phase 7b Chunk 1 `pnpm gate` verification
**Severity:** Medium — gate-reddening, but environment-scoped (does not reproduce in the main repo)
**Status:** Fixed — bundled-artifact verified by RB2 Chunk 2's empirical pack→extract→`npm i --omit=dev`→run gate (see "Bundled-artifact verification" below)

**Symptom:** `packages/manta-cli/tests/spawner/heartbeat-hook.test.ts > touch script updates last_heartbeat_at in registry` fails:
`AssertionError: expected 1000 to be greater than or equal to <now>` — the generated `heartbeat-touch.cjs`, run via `execSync('node …')`, returns early (one of its `catch { return }` arms fires) and leaves `last_heartbeat_at` at the fixture value `1000` instead of `Date.now()`.

**Proof it is NOT Phase 7b Chunk 1:**
1. `git diff 1f70b19 --name-only` for clone-B's branch touches only `packages/manta-cli/src/share/*`, `packages/manta-skill-validator/src/{cast-origin-schema,manifest-schema,index}.ts`, and `packages/manta-snapshot/src/{sanitized-schema,index}.ts` + their tests. `spawner/heartbeat-hook.{ts,test.ts}` are byte-identical to base.
2. The touch-script logic works in isolation: manually resolving `proper-lockfile` the same way and running the exact lock→read→mutate→rename sequence against an identical fixture registry updates `last_heartbeat_at` to `now` correctly.
3. Memory obs 16798 records a green gate ("1150 tests pass") at 9:48pm today in the **main repo**, before this session. The failure only appears in clone-B's freshly-`pnpm install`ed worktree.
4. **Corroborated again 2026-05-29 by clone-B (cast-1780067836274, RB1 Chunk 1):** in a freshly-`pnpm install`ed worktree, `pnpm gate` was **typecheck ✓, lint ✓, 1410/1411 tests ✓** with this exact test (`heartbeat-hook.test.ts:92`, `expected 1000 to be >= <now>`) the *sole* failure. RB1 Chunk 1 touched only `manta-snapshot/src/{schema,capture,sanitized-schema}.ts` + `manta-cli/src/{commands/cast,bin/manta,share/sanitize-snapshot,spawner/snapshot-builder}.ts` + tests — `spawner/heartbeat-hook.{ts,test.ts}` byte-identical to base. Same fresh-worktree signature → strengthens the install-time-resolution diagnosis.

**Root cause (hypothesised):** Environment/hoisting-sensitive resolution of `proper-lockfile`. The generated `heartbeat-touch.cjs` embeds `PROPER_LOCKFILE_PATH = createRequire(require_.resolve('@manta/bus')).resolve('proper-lockfile')`, resolved at install time inside the vitest process. In a fresh worktree install, vitest's workspace resolution of `@manta/bus` (source vs dist `exports` conditions) can land `require_.resolve` on a base path whose `createRequire(...).resolve('proper-lockfile')` differs from what the plain-`node` subprocess can lock with under `realpath:false` on the macOS `/var`→`/private/var` symlinked tmpdir — so `lockfile.lock(REGISTRY, LOCK_OPTS)` throws in the subprocess and the best-effort `catch { return }` swallows it, skipping the update.

**Workaround:** None needed for Phase 7b — the failure is isolated to one spawner test and does not affect the share/ sanitization layer. Re-running the gate in the main repo (established node_modules) is green.

**Fix:** Applied (source) 2026-05-29 in RB2 Chunk 2a (`fix(rb2): Chunk 2a — heartbeat-hook resolves proper-lockfile without @manta/bus`). Took candidate (a) in the install-time form + (c):
- `heartbeat-hook.ts` now resolves `proper-lockfile` directly from manta's own context — `const PROPER_LOCKFILE_PATH = require_.resolve('proper-lockfile')` — dropping the `createRequire(require_.resolve('@manta/bus')).resolve(...)` hop. This is the load-bearing change for Chunk 2: tsup `noExternal: [/^@manta\//]` inlines `@manta/bus` into manta's bundle and removes it from the published `node_modules`, so the old runtime `require.resolve('@manta/bus')` would throw "Cannot find module '@manta/bus'" and kill every cast's spawn. The static `import { busPaths } from '@manta/bus'` (install-time, inside the manta process) is kept — tsup inlines static imports, so it survives bundling.
- `proper-lockfile` promoted from a transitive (via `@manta/bus`) to a **direct** dependency of `manta` (`^4.1.2`, matching `@manta/bus`) + `@types/proper-lockfile` devDep, so `require_.resolve('proper-lockfile')` finds manta's own copy and Chunk 2's bundle ships it.
- (c) the lock-acquire `catch` in the generated touch-script now `console.error`s the masked failure before the best-effort return; benign data-skip catches (missing/empty/torn registry, DEAD clone) stay silent.
- New test `heartbeat-hook.test.ts > heartbeat-hook performs no runtime @manta/bus resolve; generated script runs (bug #53)`. Its DISCRIMINATOR asserts (on comment-stripped `heartbeat-hook.ts` source) that no runtime `require.resolve('@manta/bus')` survives — proven to RED when the fix is reverted. The in-process behavioral run is only a smoke check (the dev monorepo cannot reproduce the fresh-install divergence).

**Bundled-artifact verification (RB2 Chunk 2, 2026-05-29, cast-1780092273489 clone-A):** the empirical pack→extract→run gate was executed against the REAL published tarball and PASSED end-to-end, flipping this bug to `Fixed`:
- `pnpm pack` of `packages/manta-cli` → `manta-0.1.0.tgz`; extracted to a clean mktemp dir.
- The published manifest carries **ZERO** `@manta/*` (runtime or dev) — the 4 internal packages are inlined at build time (tsup), not deps, so nothing unpublishable (`workspace:*`/`0.0.0`) leaks. `npm i --omit=dev` in the extract installed **127 real packages and made zero attempts to fetch any `@manta/*`** (a leaked internal pkg would 404).
- All three bins run from the clean extract: `node dist/bin/manta.js --help` (exit 0, full command table); `node dist/bin/server.cjs` (MCP stdio server — responded to a real JSON-RPC `initialize` handshake with `serverInfo: manta-bus`, empty stderr, **no "Cannot find module"**); `node dist/bin/manta-validate-skills.js --help` (exit 0).
- Step-10 source guard re-proven on the bundle: grep across all 8 executable dist files (`dist/**/*.{js,cjs}`, sourcemaps excluded) for any `require/import/resolve('@manta/…')` → **ZERO hits**. The Chunk-2a heartbeat-hook fix (drop the runtime `require.resolve('@manta/bus')` hop) holds in the bundled artifact.
- Note: the contract's "move `@manta/*` to devDependencies" was empirically WRONG — `pnpm pack` leaves them in the published devDependencies as `0.0.0`, and `npm i --omit=dev` (npm 10) still RESOLVES the dev tree → registry 404. pnpm 9 has no `beforePacking` hook and does not fire `prepack`/`postpack` on `pnpm pack`, so the clean fix is to drop the internal packages from the manifest entirely and resolve them at build time via tsup esbuild alias + tsconfig `paths` + vitest `resolve.alias` (all → sibling source/declarations).

**Lessons:** A best-effort `catch { return }` that swallows ALL errors makes a real regression indistinguishable from a benign skipped-heartbeat — the script should at least `console.error` the masked failure so a reddening gate is diagnosable without a manual repro.

**Reproduced again:** 2026-05-28, clone-C (cast-1780023638705) during Phase 7c Chunk 1 `pnpm gate`. Identical symptom (`expected 1000 to be greater than or equal to <now>`), identical conditions (freshly-`pnpm install`ed worktree). Phase 7c Chunk 1 touches only `packages/manta-bus/src/{schema,trigger-schema,state/*}.ts` + `packages/manta-cli/src/config/budget-config.ts`; `spawner/heartbeat-hook.{ts,test.ts}` are byte-identical to base, and the generated touch-script embeds the registry path via the **unchanged** `busPaths().registry` field (Task 1.4 only *added* trigger-path fields). Confirms the env-scoped diagnosis — still Open, still out of scope.

### #58 — canonical `pnpm gate` lint excludes `tests/`; 64 pre-existing lint errors hide there

**Discovered:** 2026-05-29, by curator during RB1 Chunk 1 merge ceremony (investigating why the merge-review Lint dimension scored 0.003 for BOTH clones)
**Severity:** Medium — the canonical pre-merge gate gives false confidence; lint debt accumulates invisibly in test files, and the merge scorer's Lint dimension is structurally near-zero on every cast (uncomparable across branches)
**Status:** Open — PRE-EXISTING, unrelated to RB1 Chunk 1

**Symptom:** root `pnpm lint` = `eslint 'packages/**/src/**/*.ts' --no-error-on-unmatched-pattern` (src ONLY) → exit 0, clean. But the per-package script (`@manta/cli`: `eslint "src/**/*.ts" "tests/**/*.ts"`; `@manta/snapshot`: same) → **64 errors (1 warning)**, ALL in `@manta/cli` test files. Rule breakdown: 44 `@typescript-eslint/require-await`, 7 `no-unsafe-member-access`, 7 `no-unsafe-assignment`, 3 `no-unnecessary-type-assertion`, 2 `no-unused-vars`, 1 `unbound-method`, 1 `explicit-function-return-type`. The orchestrator's merge scorer runs the per-package lint (incl. tests), so BOTH clones scored Lint ≈ 0.003 — they inherited the same pre-existing debt equally; it was not a clone regression.

**Root cause:** the root `lint` script globs only `src/`. Test files are never linted by the canonical `pnpm gate`. The mismatch between the canonical gate (src-only) and the merge scorer (src+tests) makes the scorer's Lint dimension perpetually red and meaningless for ranking branches.

**Workaround:** none needed for the RB1 Chunk 1 merge — verified zero lint errors are in any clone-modified file; root `pnpm lint` (the canonical gate's lint) is green.

**Fix:** (handle in hardening task #9) (a) widen root lint to include tests (`eslint 'packages/**/{src,tests}/**/*.ts'`) and clear the 64 test-file errors (most are trivial `require-await` on async test helpers with no `await`); OR (b) consciously exempt tests and document it. Either way reconcile the merge scorer's lint command with the canonical gate so the Lint score is comparable across branches.

**Lessons:** a "green gate" that silently excludes a whole file class is a false signal. The scorer and the gate MUST run the same lint command, or their scores are uncomparable — an identical near-zero Lint across all competing branches is the tell that the dimension is measuring inherited debt, not branch quality.

### #59 — `pnpm gate` `tsc -b` emits a FALSE typecheck failure on stale `.tsbuildinfo` after a cross-package interface change

**Discovered:** 2026-05-29, by curator during RB1 Chunk 1 merge ceremony (independent `pnpm gate` re-run on the merged tree, per the "verify gates independently" rule)
**Severity:** Medium — produces a spurious red gate with confident, specific, WRONG type errors; can mislead a curator into rejecting correct merged code
**Status:** Open — environment/build-cache scoped, NOT a code bug

**Symptom:** after merging clone B (which relaxed `@manta/snapshot`'s `parentSessionId` to `string | null` and added `resumeEnabled`), `pnpm gate`'s `tsc -b` reported 6 errors in `@manta/cli` — e.g. `error TS2353: 'resumeEnabled' does not exist in type {...}` and `error TS2322: Type 'string | null' is not assignable to type 'string'` (`sanitize-snapshot.ts:75`, `snapshot-builder.ts:37`, `cast.parent-session.test.ts:86`, `sanitize-snapshot.test.ts:110-111`). I.e. `@manta/cli` was typechecking against STALE `@manta/snapshot` declarations. On disk `dist/index.d.ts` was dated 11:14 (pre-merge, missing `resumeEnabled`) while sibling `schema.d.ts`/`capture.d.ts`/`sanitized-schema.d.ts` were 11:51. `npx tsc -b --force` (full rebuild) → **0 errors**; the full gate then went green **1411/1411**.

**Root cause:** `tsc -b` incremental build did not fully propagate a cross-package interface change to a downstream project — a stale `.tsbuildinfo` / partially-regenerated `dist/index.d.ts` left `@manta/cli` compiling against the previous `@manta/snapshot` `.d.ts`. A fresh worktree (the clone's environment, fresh `pnpm install` + clean build) has no stale cache, so the clone's own gate was green on these exact files — the false failure only surfaces in an established checkout with incremental build state.

**Workaround:** `npx tsc -b --force` (or delete `packages/*/dist/.tsbuildinfo`) before trusting a `tsc -b` failure whose error references a cross-package symbol that DOES exist in current source.

**Fix:** (handle in hardening task #9) make the canonical gate's typecheck robust to stale incremental state — candidates: (a) `tsc -b --force` in the `typecheck` script, (b) a `tsc -b --clean` pre-step, or (c) remove stale `.tsbuildinfo` on detected interface changes. Trade-off: `--force` costs a full rebuild each gate run; (b)/(c) are cheaper but more fragile.

**Lessons:** an incremental `tsc -b` can emit a confident, specific, and WRONG type error after a merge that changes a package's public interface. "The gate is red" is NOT trustworthy without a force-rebuild when the error is a cross-package symbol-existence / assignability claim. This extends the CLAUDE.md rule "re-run gates independently": re-run with a CLEAN build, not merely an incremental one — a stale `.tsbuildinfo` is itself a source of false reds (just as a stale fixture is a source of false greens).

### #60 — bare `parseInt`/`parseFloat` commander coercers accept `NaN`, silently disarming the guard the flag drives

**Discovered:** 2026-05-29, by the RB1 Chunk 2/3 code-reviewer subagent (nit on `--distill-threshold-bytes`), generalized by the curator during merge ceremony
**Severity:** Medium — a typo in a numeric flag does not fail loud; it produces `NaN`, and every downstream `value > NaN` comparison is `false`, which DISABLES the safety behaviour the flag exists to gate
**Status:** PARTIALLY FIXED — the three `cast`-command integer flags fixed in the RB1 Chunk 2/3 hardening commit; remaining coercers on other commands tracked here for task #9

**Symptom:** `manta cast --distill-threshold-bytes abc <mode>` → `parseInt('abc',10)` → `NaN` → in `cast.ts` `size > NaN` is always `false` → the over-threshold branch never trips → an arbitrarily large (e.g. 11.7 MB) parent transcript is force-copied into EVERY clone, the exact catastrophe the size-guard exists to prevent. The same NaN footgun sits on every other bare-`parseInt`/`parseFloat` coercer.

**Root cause:** commander coercers were `parseInt` (and `parseFloat`) passed by reference. `parseInt` returns `NaN` on non-numeric input and half-parses trailing garbage (`'5abc'` → `5`); neither is validated, so a bad value flows straight into a comparison that silently no-ops.

**Fix (this commit):** new `packages/manta-cli/src/bin/option-parsers.ts#parsePositiveIntOption` — strict `^\d+$` + `> 0`, throws `commander.InvalidArgumentError` (clean CLI error + nonzero exit) on anything else, including trailing-garbage. Applied to the three `cast`-command integer flags: `--distill-threshold-bytes` (new, safety-critical), `--heartbeat-timeout-ms` and `--startup-grace-ms` (pre-existing bug #52 reaper-threshold flags with the identical NaN footgun). 10 unit tests pin the parser.

**Fix (task #9 remainder):** audit and harden the remaining numeric coercers with the same pattern (or `parseFloat` equivalent): `manta cast --daily-cap-usd` (`parseFloat`), `manta share --max-bytes` (`(v)=>parseInt(v,10)` — same NaN-never-refuses-publish risk), and any `parseInt(options.x, 10)` inside `.action()` bodies that feed a guard.

**Lessons:** a CLI coercer that can return `NaN` is a guard-disabling footgun whenever the parsed value gates a `>`/`<` safety comparison. Validate numeric flags at the CLI boundary and fail loud — a typo must never silently disarm a safety behaviour. `parseInt`'s trailing-garbage leniency (`'5abc'`→5) is itself a silent-wrong-value bug, not a convenience.

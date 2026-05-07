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

### #1 — manta-cli integration test flakes under concurrent workspace test run

**Discovered:** 2026-05-07, during Phase 0e Chunk-2 spec-review remediation
**Severity:** Low
**Status:** Open
**Reproducer:**
1. `git checkout 1ddabb0`
2. `pnpm -r test` (default workspace concurrency)
3. Sometimes `@manta/cli` integration test fails with "orchestrator cycle failed"
4. Re-running `pnpm --filter @manta/cli test` or `pnpm -r --workspace-concurrency=1 test` → green
**Root cause:** Likely resource contention in `packages/manta-cli/tests/integration.test.ts`'s parent-PID probe + process-spawning path when other test workers consume process / fd budget. Not yet investigated.
**Fix:** Pending. Workaround: run whole-repo sweep with `--workspace-concurrency=1` until rooted.
**Lessons:** Tests that interact with real OS process state (PID probes, child spawns) are concurrency-sensitive. Consider isolating them into a serialized vitest pool or marking them with `test.serial` once we encounter another such case.

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

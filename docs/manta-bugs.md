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

### #2 — Spawner-registers-clone-before-launch claim is misleading

**Discovered:** 2026-05-07, during Phase 0f Chunk-2 code-quality review (commit `53b9b4b`)
**Severity:** Medium
**Status:** Open
**Reproducer:**
1. Read `skills/manta-as-clone/SKILL.md` ~line 17 — claims "the CLI spawner registered you on the bus before launching this process"
2. Read `docs/user/recon-swarm.md` line 20 — repeats the claim ("the spawner registered the clone *before* the process started")
3. Grep `packages/manta-cli/src/commands/cast.ts` and `packages/manta-cli/src/spawner.ts` — the spawner calls `ctx.contracts.write(...)` (writes the task contract) before launching, but never calls `ctx.registry.register`. The registry record is created by the clone calling `manta.register` itself on startup.
**Root cause:** Skill text and now user-facing docs assert behaviour the spawner does not perform. Either the spawner should pre-register the clone (so the registry sees it before the process starts) and the docs are correct, or the spawner only writes the contract and the docs need to read "the spawner *wrote your task contract* before launching; you call `manta.register` immediately on startup."
**Fix:** Pending — design choice belongs to Phase 1 (recon-swarm production-grade lockdown). Both fixes are valid; pre-registration removes a heartbeat-deadline race window when a clone is slow to start.
**Lessons:** When a skill's instructional text describes orchestrator/CLI behaviour, the validator should cross-check the claim against the implementation. Consider a behavioural-fixture test that exercises spawn → register sequence end-to-end (Phase 1 deferred-from-Phase-0e item).

### #3 — e2e cast hangs against real `claude --print`; clones never register

**Discovered:** 2026-05-07, during Phase 0f acceptance dogfood (commit `2f641b2`)
**Severity:** High — blocks Phase-0 acceptance signoff
**Status:** Open
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
**Status:** Open
**Reproducer:** `claude --print --snapshot /dev/null --version` → prints `2.1.132 (Claude Code)` and exits 0 with no warning about `--snapshot`.
**Root cause:** Current `claude` CLI tolerates unknown flags (probably to forward-compatibility for plugins). Manta's spawner relied on it being a real flag.
**Fix:** Either upstream Claude Code adds a `--strict-flags` mode, or Manta switches to a snapshot-passing mechanism the CLI actually parses (env var, stdin priming). Track alongside bug #3.
**Lessons:** When integrating with a third-party CLI, validate every new flag with `--help | grep <flag>` and a positive behavioural smoke, not just exit-code 0 from a no-op invocation.

## Fixed bugs

_Пусто._

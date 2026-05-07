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

## Fixed bugs

_Пусто._

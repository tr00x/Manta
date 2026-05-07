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

## Fixed bugs

_Пусто._

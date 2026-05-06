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

_Пусто. Phase 0 ещё не начата._

## Fixed bugs

_Пусто._

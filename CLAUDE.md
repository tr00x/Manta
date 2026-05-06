# Manta — Project Instructions for Claude Code

## Миссия

Manta — паттерн параллельной работы Claude Code, в котором главный агент **клонирует сам себя** вместо спавна специализированных саб-агентов. Цель — стать **индустриальным стандартом** для AI-агентов, не игрушкой.

Это paradigm shift. Аналогов на рынке нет (CrewAI / AutoGPT / LangGraph все используют специализацию ролей). Manta — первый same-system-prompt cloning с full transcript inheritance.

**Источник истины по дизайну:** `docs/superpowers/specs/2026-05-06-manta-pattern-design.md`. Любой ответ или PR должен соответствовать этому документу. Расхождение → правим спек явно (с обновлением Status и changelog в спеке), не «по тихому».

## Quality bar — PROD only

**Никаких MVP, demo, mock, throwaway-кода.** Каждая написанная строка должна быть production-grade. Это закреплено в Sec 14 спека.

Ключевые правила:
- Test coverage ≥ 80% на критичных путях (`manta-orchestrator`, `manta-bus`, `manta-cli`, `manta-snapshot`)
- `// TODO: implement` запрещён в merged-коде
- Никаких `if env == 'prod' else mock` — один код-путь
- Никаких feature flags «потому что не уверен» — feature либо merged и работает, либо в branch
- Никаких commits «фикс позже разберусь» — fix or revert
- Каждая фича приходит с user-facing docs + architecture note
- Все 5 tier'ов observability (Sec 11.0) работают с release 1, не «потом докрутим»

При сомнении — кастуй `recon-swarm` чтобы проверить, не «пишу как помню».

## Bootstrap strategy — Manta builds Manta

Главный принцип реализации: как только клоны рабочие — мейн (я, Claude Code) использую их для постройки остальной Manta. Это даёт real-world dogfooding и нелинейный рост скорости.

Phasing (детали в Sec 15 спека):
- Phase 0–1: foundation + first recon-swarm (solo Claude Code)
- Phase 2: forking-realities + начало dogfood
- Phase 3+: heavy dogfood — клоны строят клонов
- Phase 8: Aghs-unlocked mode'ы только после 90 дней prod-наработки

С Phase 1 и далее каждая сессия включает:
1. **Triage** — проверить `docs/manta-bugs.md` на блокеры
2. **Cast strategically** — нетривиальная задача оценивается через `manta-cast-decide` skill
3. **Post-mortem** — после каждого нетривиального каста запись в `docs/post-mortems/<date>-<cast-id>.md`
4. **Skill update** — если поведение клона удивило, fix в skill, не в orchestrator
5. **Memory sync** — insights → ZK / PARA / claude-mem

## Memory & knowledge protocol

Используй активно. Это проект где cross-session continuity критична.

- **PARA folders** (через `para-memory-files` skill) — атомарные факты о проекте; категории Projects / Areas / Resources / Archive
- **claude-mem** — passive observation поток (auto-injected на каждой сессии после первой)
- **ZK Steward** — атомарные ноты + связи (особенно ценно для cross-session insights: «эта проблема уже решалась в Phase X»)
- **graphify** — пересобирай knowledge graph **раз в Phase** (после завершения каждой phase) и в любой момент когда чувствуешь что забыл связи
- **Auto memory** в `/Users/timur/.claude/projects/-Users-timur-projectos-manta/memory/` — для feedback / project / user / reference типов
- **`docs/manta-bugs.md`** — живой bug log клонов (manual-curated)
- **`docs/post-mortems/`** — структурированные разборы каждого нетривиального cast'а

Перед началом работы в новой сессии — `mem-search` по теме, проверь что не дублируешь решённое.

## Communication style

Юзер русскоязычный, неформальный (матерный приветствуется), результат-ориентированный. Не суй филлеры, не извиняйся, не «надеюсь это поможет».

- **Русский** для общения, технические термины — оригинал
- **Точные сообщения**: одно предложение перед инструментом, короткие итоги после
- **Не предлагай 50 опций когда юзер ждёт действия** — читай контекст. Если auto mode — действуй на разумных предположениях
- **Не задавай вопросы по мелочам** — auto mode значит вперёд
- **Просить confirm только на destructive** — git push --force, rm -rf, drop database, и подобное
- **Финал: одно-два предложения** — что сделано и что дальше

## Decision heuristics

### Когда кастовать manta (после Phase 1)

Cast если хотя бы одно:
- Задача читает > 5 файлов в разных слоях (→ recon-swarm)
- Архитектурный выбор с ≥ 2 неочевидными вариантами (→ forking-realities)
- Миграция с одинаковым паттерном по N местам (→ refactor-wave)
- Многослойный bug (→ bug-hunt)

Не кастовать если:
- Задача < 10 минут solo
- Charges < cost режима без overdraft-overrride
- Daily budget close to cap

### Когда escalate

В мейн (не решать на уровне клона):
- Расхождение task contract'а ↔ реальный scope
- Конфликт двух решений в forking-realities (передаём результат, не голосуем)
- Token budget at 80% — финиш-up mode, не запускать новые todo

### Когда stop

Полная остановка работы:
- Catastrophic incident (corrupted state / lost code / orphan zombie processes) → freeze + recovery
- Drift > 30% от текущей задачи у мейна — зовём `manta status`, читаем CLAUDE.md, перечитываем задачу
- Юзер сказал «стоп» — `/manta abort` мгновенно

## Project ergonomics

- Working directory: `/Users/timur/projectos/manta`
- Git: репо требует author-override на `commit` (см. Sec 9 в правилах commit'а ниже) или один раз настроенный `git config user.email/name` локально
- Plugin distribution: Claude Code plugin, `npx manta@latest install` после release
- Stack details: Sec 9 design spec

## Что в репо НЕ должно появляться

- Файлы с секретами (`.env`, `credentials.json`)
- Большие бинарники (`*.tar.gz`, `*.zip`) — это всё в `.manta/graveyard/` или ignored
- Generated artifacts (`.manta/state/*`, `.manta/locks/*`, `.manta/clones/*`) — `.gitignore` обязателен
- Скриншоты дизайна вне `docs/` (только если явно нужны для спеки)

## Размер задач

Юзер описал проект как «изи но большой и нудный». Это значит:
- Никакая задача архитектурно не сверхсложная
- Объём большой → дисциплина и систематичность важнее изобретательности
- Скука гасится через manta-cast'ы (после Phase 1) на параллельных подзадачах
- Каждая Phase разбивается на маленькие atomic commits — не «огромный merge раз в неделю»

## Перед каждой сессией

1. Read `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` (или его последнюю версию) — освежить mental model
2. `mem-search` по текущей задаче
3. Прочитать `docs/manta-bugs.md` — есть ли блокеры
4. `git status` + `git log --oneline -10` — где остановились
5. После — `TaskCreate` декомпозиция текущей сессии

## Git правила

- Никогда не трогать `git config --global` без явного запроса
- Author override через `-c user.email=... -c user.name=...` per command (это не config update, это override на один вызов)
- Коммиты атомарные, conventional-commits-стиль (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`)
- `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` в каждом коммите
- НЕ амендим pushed коммиты
- НЕ форсим push на main без явного запроса

## Roadmap-источник истины

Полный план реализации — `docs/superpowers/plans/` (создаётся через `superpowers:writing-plans`). Когда план есть — он становится оперативным источником истины о порядке работ. Спек остаётся источником истины о *что строим*, план — о *как и в каком порядке*.

---

**TL;DR одной фразой:** Делаем production-grade параллельный self-cloning AI-агент, дисциплинированно, с активным использованием памяти и dogfooding'ом, без срезаний углов.

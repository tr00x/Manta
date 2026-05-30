# Manta — Project Instructions for Claude Code

## Миссия

Manta — паттерн параллельной работы Claude Code, в котором главный агент **клонирует сам себя** вместо спавна специализированных саб-агентов. Цель — стать **индустриальным стандартом** для AI-агентов, не игрушкой.

Это paradigm shift. Аналогов на рынке нет (CrewAI / AutoGPT / LangGraph все используют специализацию ролей). Manta — первый same-system-prompt cloning с full transcript inheritance.

**Вертикаль:** Phase 0..N → **код** (worktrees, file locks, tests, commits, Claude Code как раннер). Другие вертикали (research / writing / design / ops) — отдельный roadmap **после** того, как код-вертикаль доказана в продакшене. Не пихать non-code примитивы в Phase 0-плэйн до этого момента — рискуем абстракцией ради абстракции.

**Источник истины по дизайну:** `docs/superpowers/specs/2026-05-06-manta-pattern-design.md`. Любой ответ или PR должен соответствовать этому документу. Расхождение → правим спек явно (с обновлением Status и changelog в спеке), не «по тихому».

## Quality bar — PROD only

**Никаких MVP, demo, mock, throwaway-кода. Никаких костылей. Никаких "потом починим".** Каждая написанная строка должна быть production-grade с дня 1. Это закреплено в Sec 14 спека.

### Запрещено в merged-коде

- `// TODO`, `// TODO: implement`, `// FIXME`, `// HACK`, `// XXX` — любые маркеры отложенной работы. Если что-то не доделано — план в branch, не commit в main.
- `it.skip`, `test.skip`, `describe.skip`, `it.todo`, `test.todo`, `xit`, `xdescribe`. Тест либо работает и проверяет реальное поведение, либо удалён.
- `eslint-disable` / `@ts-ignore` / `@ts-nocheck` без `// Reason: <конкретное обоснование>` рядом. Молчаливое подавление ругани = тех-долг.
- `if env == 'prod' else mock` / две ветки кода под "test" и "prod" — один код-путь. DI seam'ы (CloneRunner, MCP runner) — да; env-switch — нет.
- Mock'и production-сервисов в production-коде. Mock только в тестах через явный seam, не через `if NODE_ENV`.
- Feature flags "потому что не уверен" — feature либо merged и работает, либо живёт в branch до готовности.
- Commits "фикс позже разберусь" / "знаю что баг, дойду" — **fix or revert**, третьего не дано.
- Half-finished implementations — функция либо делает что обещает в имени, либо не существует.
- Lint warnings, не только errors. Warnings → fix или явный обоснованный suppress, не "пусть висит".

### Бэг найден — что делать

1. Если bug блокирует текущую задачу → fix immediately, root-cause а не симптом.
2. Если bug pre-existing и unrelated → запись в `docs/manta-bugs.md` (#N, Severity, Reproducer, Root cause if known, workaround). Никогда не молча оставляем.
3. Если bug surfaced субагентом во время review → applied до коммита (defer-nothing).
4. Если test упал и "не воспроизводится у меня" → flaky test, запись в `docs/manta-bugs.md`, но **не** `it.skip` чтобы зелёный CI.

### Test / coverage / docs

- Test coverage ≥ 80% на всех 5 пакетах: `@manta/snapshot`, `@manta/bus`, `@manta/orchestrator`, `@manta/cli`, `@manta/skill-validator`. Для каждого нового критичного пакета — то же.
- Каждая фича приходит с user-facing docs + architecture note в том же коммите что и код.
- Все 5 tier'ов observability (Sec 11.0) работают с release 1, не «потом докрутим».

### Verification before claiming done

- "Тесты прошли" / "build green" — verify прогоном гейта **самостоятельно** перед коммитом, не на слово subagent'а. Имплементаторы уже врали про test pass (см. `feedback-impl-self-reports.md` в memory).
- Spec-reviewer subagent должен независимо перепрогнать гейты, не доверять numerical claims.
- **Канонический pre-merge гейт — `pnpm gate`** (= `pnpm typecheck && pnpm lint && pnpm test`, fail-fast по дешевизне). Bug #36 fix: до этого «гейт» был `pnpm -r build && pnpm -r test && pnpm -r lint` без typecheck'а — esbuild/vitest транспилируют без проверки типов, а `pnpm -r` падает на первом сломанном пакете и не доходит до остальных. Никогда не утверждать «гейт зелёный» без явного прогона `pnpm gate` (или ре-рана трёх скриптов поодиночке).

При сомнении — кастуй `recon-swarm` чтобы проверить, не «пишу как помню».

### Plan-writing discipline (non-negotiable)

Каждый sub-plan (≤ ~3-4k строк, 1-2 чанка) проходит **reviewer-per-chunk loop**:
1. Написать план полностью на диск (не в чате — disk дешевле context'а)
2. Dispatch `general-purpose` subagent в фоне с `plan-document-reviewer-prompt.md` template + явным critical-checks списком
3. Применить **все** must-fix + дешёвые advisory **до** коммита (defer-nothing)
4. Один атомарный коммит с длинным телом, перечисляющим каждый reviewer-fix

Класс блокеров #1 в Phase 0 был **cross-plan field-name drift** (план A вызывает API плана B с не теми именами полей). Лекарство: перед написанием вызова в чужой пакет — `grep -n` сигнатуры в плане-предшественнике. 30 секунд страховки.

## Bootstrap strategy — Manta builds Manta

Главный принцип реализации: как только клоны рабочие — мейн (я, Claude Code) использую их для постройки остальной Manta. Это даёт real-world dogfooding и нелинейный рост скорости.

Phasing (детали в Sec 15 спека):
- Phase 0–1: foundation + first recon-swarm (solo Claude Code)
- Phase 2: forking-realities + начало dogfood
- Phase 3+: heavy dogfood — клоны строят клонов
- Phase 8: Aghs-unlocked mode'ы только после 90 дней prod-наработки

**Phase 1-8 plan-файлы НЕ пишем заранее** — это by-design. Bootstrap-by-Manta значит: следующая фаза планируется *с помощью* предыдущей. Pre-планирование Phase 1+ сейчас:
1. Сжигает dogfood-сигнал (планируем против воображаемой системы)
2. Закрепляет ассумпции до того, как Phase 0f e2e-cast скажет работает ли это
3. Теряет нелинейный рост скорости (Phase N+1 строится с участием Phase N клонов)

После подписи `docs/acceptance/phase-0.md` юзером — открывается Phase 1 milestone, и его plan-файл пишется первым; кастуем `recon-swarm` для помощи если полезно.

С Phase 1 и далее каждая сессия включает:
1. **Triage** — проверить `docs/manta-bugs.md` на блокеры
2. **Cast strategically** — нетривиальная задача оценивается через `manta-cast-decide` skill
3. **Post-mortem** — после каждого нетривиального каста запись в `docs/post-mortems/<date>-<cast-id>.md`
4. **Skill update** — если поведение клона удивило, fix в skill, не в orchestrator
5. **Memory sync** — insights → ZK / PARA / claude-mem

## Operating mode (Phase 1+) — Main = curator, не имплементер

С момента когда клоны работают (Phase 0e shipped + Phase 0f e2e green), главный агент **меняет роль**: больше не основной имплементер, а оркестратор / ревьюер / наставник клонов. Это by-design для bootstrap-by-Manta — Phase N+1 строится **с участием** клонов Phase N, иначе теряем нелинейный рост скорости.

**HARD RULE: клоны — default, не исключение** (закреплено юзером 2026-05-26).
- Любая задача > 10 минут → `manta cast`. Не "подумать о cast'е", а cast по дефолту.
- Субагенты (`Agent` tool) — **не замена клонам**. Субагент не получает CLAUDE.md, не работает в worktree, не координируется через bus. Клон получает всё это. Для имплементации — только клоны.
- Субагенты допустимы для: plan review, quick research, code review — одноразовые read-only задачи без deliverables в репо.
- Если ловлю себя пишущим код больше чем на 10 минут — стоп, это работа клона, не мейна.

**Default instinct на нетривиальную задачу:**
1. Сначала прогон через `manta-cast-decide` — оправдан ли cast?
2. Да → `manta cast <mode>`, наблюдай за post-mortem, ревьюй output, фикси skill'ы или orchestrator если поведение клона разошлось с контрактом
3. Нет (< 10 минут / surgical / уже в контексте) → делай сам быстро, без ceremony

**Что делает мейн (Claude Code в этой сессии):**
- **Курирует** — выбор режима, scope task contract'а, capabilities, бюджеты, deadline'ы
- **Наблюдает** — читает post-mortems, ZK ноты, `manta status`, broadcasts; не лезет внутрь worktree клона если тот не зашился
- **Оценивает** — output клона против task contract; merge-решения для forking-realities; bug-trail в `docs/manta-bugs.md`
- **Чинит** — root-cause фикс в skill / orchestrator / infra если клон систематически ошибается. Патчи паттерн, не симптом в одном касте.
- **Улучшает** — post-mortem → skill update → следующий cast лучше; cross-cast insights в ZK; план Phase N+1 обновляется по dogfood Phase N
- **Решает** — escalations от клонов, конфликты двух решений в forking, budget breach

**Что делают клоны:**
- Имплементация (новые фичи, рефакторинг, баг-хант, маппинг кодбейса, написание планов с предшествующего recon-swarm)
- Cross-package изменения шириной > 1 файла
- Анализ кодбейса для пред-планирования следующих фаз
- Любая задача с чётким task contract'ом и понятным success criterion

**Когда мейн коды сам (исключения):**
- Surgical review-fix < 10 минут поверх работы имплементера-клона (Phase 0f Chunk-1/2 review-fixes — типичный пример)
- Тривиальный typo / config tweak / single-line skill-update
- Когда `manta-cast-decide` явно вернул «не оправдано»
- Urgent freeze / catastrophic incident (см. «Когда stop» в Decision heuristics)

**Антипаттерны (не делать):**
- Решать «сам быстрее напишу» на cast-justified задаче — теряешь dogfood-сигнал, обучение клонов, нелинейный рост скорости
- Делать масштабный review-fix от себя — лучше re-cast с обновлённым контрактом, чтобы клон тоже учился
- Skip post-mortem после нетривиального cast'а — это единственная систематическая обратная связь по поведению клонов; без неё skills не эволюционируют
- Тащить контекст всего клона в свой transcript «чтобы помочь» — это убивает преимущество свежего контекста, ради которого клонов и спавним

**Self-check каждые ~30 минут активной работы:**
- Я курирую или сам в коде по локоть? Если второе — это оправданное исключение или дрейф?
- Bug log актуален, skills apply'ятся, post-mortems пишутся?
- Не делаю ли я работу, которую должен был делать клон?

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
- Юзер сказал «стоп» — `manta abort` мгновенно (терминальный CLI; slash-команды `/manta` в v1 НЕ существует — см. RB#3 plugin-дистрибуция)

## Post-cast merge ceremony (HARD RULE — нарушал 2026-05-26, Phase 3 Chunk 2)

Каждый forking-realities cast генерирует `docs/merge-reviews/cast-<id>.md`. Это **первый** артефакт который надо прочитать после завершения каста. Не мёржить обе ветки «потому что обе полезные» — следовать verdict'у.

**Обязательный чеклист (пропуск шага = баг в процессе):**
1. `cat docs/merge-reviews/cast-<id>.md` — прочитать verdict и scores
2. Следовать verdict'у: если "merge A" — merge A. Код из B — cherry-pick отдельных коммитов если нужно, не blind merge
3. Code review субагентом (`Agent` type=`code-reviewer`) на diff winning branch перед merge
4. Merge + resolve conflicts + build+test sweep
5. Post-mortem в `docs/post-mortems/`
6. Commit artifacts (merge-review, tasks yaml, post-mortem)

**Task YAML — shared prereqs:**
- Shared prerequisite module (создаваемый файл от которого зависят оба клона) → назначить ОДНОМУ клону
- Второму клону в описании: "Этот файл создаёт Clone X. Пиши против интерфейса из плана, твой код будет тестироваться после merge с реализацией Clone X."
- НЕ использовать self-help pattern "создай если не существует" — в forking-realities worktrees изолированы, оба создадут, гарантированный add/add конфликт (нарушал 2026-05-26)

**Monitor casts:**
- Для cast'ов < 20 минут: не ставить monitor вообще — дождаться background task completion
- Если monitor нужен: эмитить ТОЛЬКО state transitions (STARTING→WORKING→WINDING_DOWN→DEAD), не heartbeat ages
- Не поллить registry вручную (см. feedback-no-heartbeat-polling)

## Project ergonomics

- Working directory: `/Users/timur/projectos/manta`
- Git: автор берётся из `git log -1 --format='%ae %an'` через `-c` override (детали — секция «Git правила» ниже). Локального `git config user.email/name` нет; `--global` не трогать.
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
2. **Read `docs/internals/claude-code-pitfalls.md`** — шпаргалка по реальному поведению Claude / Claude Code, написана из боли (см. секцию ниже про skill/priming enforcement). **Обязательно перед любой архитектурной правкой касающейся skills, priming text, MCP tools или enforcement.**
3. `mem-search` по текущей задаче
4. Прочитать `docs/manta-bugs.md` — есть ли блокеры
5. `git status` + `git log --oneline -10` — где остановились
6. После — `TaskCreate` декомпозиция текущей сессии

## Skill/priming/enforcement HARD RULES (нарушал 2026-05-07, bug #9 fix wasted cast)

**Никогда не закладывать enforcement в skill-text или priming preamble. Эти инструкции — soft prior, не hard rule.** Полная шпаргалка с evidence — `docs/internals/claude-code-pitfalls.md`. Распространённые формулировки которые НЕ работают:

- ❌ "First tool call of every turn must be X" — Claude не контролирует tool ordering детерминированно
- ❌ "Heartbeat every ≤ N seconds" — нет wallclock между turns
- ❌ "Always do A before B" — soft, ignored под task pressure
- ❌ "В skill markdown написал — клон послушает" — компактируется при overflow

**Что вместо:**

- ✅ Hard invariant → **PreToolUse hook** (settings.json, выполняется harness'ом, не моделью) ИЛИ **MCP server side-effect** (на handler level)
- ✅ Identity / permanent context → **priming preamble** (`--append-system-prompt`), не skill (skill компактируется)
- ✅ Soft guidance / examples / explainability → skill text, но не ожидать compliance
- ✅ Schema-first, then text — поле `message` в priming/skill только после widening Zod schema (нарушал 2026-05-07, bug #13)
- ✅ Validation cast перед "Status: Fixed" в bug log — local tests прошли ≠ реальный Claude следует правилам (нарушал 2026-05-07, bug #9 fix `5cd7234`)

**Если ловлю себя на мысли "напишу в skill, клон послушает" — стоп, это уже ошибка.** Идти в `claude-code-pitfalls.md` §3-§4 (MCP side-effect / PreToolUse hook).

## Git правила

- Никогда не трогать `git config --global` без явного запроса
- Author override через `-c user.email=... -c user.name=...` per command (это не config update, это override на один вызов)
- **Откуда брать author email/name** (HARD RULE — нарушал 2026-05-07, повтор 2026-05-08):
  - **Две отдельные команды**: `EMAIL="$(git log -1 --format='%ae')"` и `NAME="$(git log -1 --format='%an')"`. Подставить дословно в `-c user.email="$EMAIL" -c user.name="$NAME"`.
  - **НЕ использовать** `git log -1 --format='%ae %an'` с последующим shell-парсингом через `${VAR% *}` / `${VAR#* }` — `% *` strips shortest match from end и ломается на именах с пробелами ("Tim Hunt" → EMAIL="...Tim", NAME="Tim Hunt"). Нарушал 2026-05-08 в плане 2b.
  - Если `git log` пустой (новый репо / первый коммит) — **остановиться и спросить юзера**. Не подставлять.
  - **НИКОГДА** не использовать `<userEmail>` / `<userInfo>` из системного промпта как git author. Это identifier юзера для чата, не git identity.
  - **НИКОГДА** не выдумывать имя «по контексту» (типа Timur из директории `/Users/timur/...`). Reading directory ≠ identity.
  - Если хук заблокировал коммит из-за identity — это hard stop. **Не пробовать второй раз с другим guess'ом.** Спросить юзера.
- Коммиты атомарные, conventional-commits-стиль (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`)
- `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` в каждом коммите
- НЕ амендим pushed коммиты
- НЕ форсим push на main без явного запроса
- В auto mode коммиты OK без отдельного confirm'а — **кроме** когда впервые в сессии нужен новый author / эта identity ещё не использовалась. Тогда сначала спросить.

## Self-editing this CLAUDE.md

Когда юзер ловит меня на повторяющейся ошибке — **редактирую этот файл сразу, inline, hard rule'ом**, не закапываю в `memory/`. CLAUDE.md загружается в контекст каждой сессии целиком; memory/ загружается через MEMORY.md (тоже в контексте, но это индекс и индирекция). Для класса «не делать никогда» — место здесь, не в memory.

Pattern: один-два предложения сути + `(нарушал YYYY-MM-DD)` + 2-3 пункта «как именно применять». Без многословных эссе.

## Roadmap-источник истины

Полный план реализации — `docs/superpowers/plans/` (создаётся через `superpowers:writing-plans`). Карта планов — `docs/superpowers/plans/INDEX.md` (статус каждого sub-плана: TODO / Under review / Approved). Когда план есть — он становится оперативным источником истины о порядке работ. Спек остаётся источником истины о *что строим*, план — о *как и в каком порядке*, INDEX — о *что распланировано и что нет*.

---

**TL;DR одной фразой:** Делаем production-grade параллельный self-cloning AI-агент, дисциплинированно, с активным использованием памяти и dogfooding'ом, без срезаний углов.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"` to keep the graph current

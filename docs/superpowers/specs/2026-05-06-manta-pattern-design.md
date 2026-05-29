# Manta Pattern — Design Spec

**Date:** 2026-05-06
**Status:** Reviewed (spec-document-reviewer: Approved, 1 iteration). Ready for plan phase. **Amended 2026-05-29:** Sec 9 reconcile — transcript inheritance механизм + cost-tiers (v1 release blocker #1; разрешает противоречие Sec 1↔Sec 9 по `/goal`).
**Author:** Tim Hunt + Claude Code (Opus 4.7)
**Quality bar:** Production-grade from day 1. No MVP, no demo, no mocks.

---

## 1. Концепция

**Manta Pattern** — модель параллельной работы Claude Code, в которой главный агент **клонирует сам себя** вместо спавна специализированных саб-агентов.

Метафора: способность героя в Dota 2 *Manta Style* — герой кастует, появляются 2 иллюзии (та же модель, тот же стат-снимок, ограниченное время жизни), потом исчезают. Иллюзии — *не другие герои*, они *я*.

### Ключевое отличие от subagents

| Свойство | Subagent | Manta-clone |
|---|---|---|
| Системный промпт | Свой (специалист) | Идентичен мейну |
| Контекст разговора | Свежий, через брифинг | Полный transcript (native session-fork; distillable для cost) |
| Память о юзере | Нет | Полная |
| Tooling | Подмножество | Идентично мейну |
| Возврат | Summary | Diff / merge / live в общую память |
| Идентичность | Чужая | Я |

### Почему это решает реальную боль

1. **Контекст** — саб-агентов надо брифить токенами, и они всё равно теряют нюансы. Клон уже знает всё.
2. **Параллелизм без специализации** — N копий *меня* работают над разными ветками одной задачи.
3. **Сохранённая личность** — действия клона = действия мейна, нет потерь на summary.

### Аналогов на рынке нет

CrewAI / AutoGPT / LangGraph / Claude Code subagents — все используют **специализацию ролей** (разные промпты, разные tools). Manta — это первый паттерн **same-system-prompt cloning** с full context inheritance.

---

## 2. Арсенал режимов (10 пресетов)

Mode выбирается мейном при касте: `/manta cast <mode> [args]`. Доступен `auto` для авто-выбора.

### Release waves

Все режимы — production-grade при выходе. Разбиение на «волны» обусловлено зависимостями реализации, а не качеством.

- **Wave 1** — режимы, совместимые с batch-spawn (one-shot per клон через `claude --print`). Готовы к выпуску в первой prod-волне.
- **Wave 2** — режимы, требующие итеративного диалога между клонами и мейном. Зависят от daemon-mode runtime (см. Sec 9.1).
- **Aghs-locked** — режимы за explicit unlock в config; высокая стоимость или повышенный риск.

### Каталог режимов

| # | Mode | Wave | Charge cost | Описание |
|---|---|---|---|---|
| 1 | `recon-swarm` | 1 | 1 | N клонов читают разные части кодбейза параллельно (frontend/, backend/, db/, ...). Возвращают unified map. Read-only. |
| 2 | `forking-realities` | 1 | 2 | 3 клона в 3 worktrees пробуют **3 разных подхода** к одной задаче. Best-of-N выбор. A/B/C тест решений. |
| 3 | `pair-programming` | 2 | 1 | 2 клона на одну задачу: один пишет, второй ревьюит каждый коммит. |
| 4 | `test-storm` | 2 | 2 | 3 клона: код / тесты / chaos-fuzzing. Файл-локи, общий worktree. |
| 5 | `bug-hunt` | 1 | 2 | Клоны разбирают проблему по слоям (frontend / network / backend / db / infra). Мейн собирает root cause. |
| 6 | `refactor-wave` | 1 | 2 | После миграции N клонов одновременно правят разные модули. Параллельный sweep. |
| 7 | `documentation-chase` | 2 | 1 | Клон пишет доку для уже написанного кода в фоне, пока мейн кодит дальше. |
| 8 | `phantom-lance` | Aghs | 3 | Рекурсивный спавн (клон сам кастует manta). Decay сил, hard depth = 2. |
| 9 | `council` | Aghs | 3 | 5 клонов независимо предлагают решение → мейн агрегирует. Wisdom of crowds. |
| 10 | `decoy` | Aghs | 2 | Клоны делают черновую работу (drafts, наброски), мейн только аппрувит/правит. |

### Метарежимы

- **`auto`** — мейн выбирает по типу задачи (через `manta-mode-selector` skill). Charge cost = max(matched mode).
- **`combo`** — несколько режимов одновременно (`recon-swarm` + `documentation-chase` параллельно). Charge cost = sum.

---

## 3. Lifecycle клона

### Phase 1 — CAST

```
/manta cast forking-realities --clones=3 --task="оптимизировать query orders.sql"
```

Под капотом:

1. **Snapshot мейна** — текущий transcript + cwd state + open files + active todos → `manta-cast-<id>.json`
2. **Worktree spawn** — `git worktree add .manta/clones/<id>`
3. **Process spawn** — headless Claude Code запускается в каждом worktree с initial context = snapshot + task contract
4. **Bus join** — клон регистрируется в Manta Bus (MCP-server поверх `claude-peers`)
5. **Cooldown** — мейн получает 50-секундный cooldown

### Phase 2 — LIVE

- Мейн **не блокируется** — продолжает разговор с юзером
- `/manta status` показывает компактный снимок всех клонов
- Statusline показывает: `🟢🟡🟡 3/3 clones · 12m left · 2 locks` (status icons: 🟢 idle, 🟡 working, 🔴 alarm/blocked, 💀 dead/removed-from-count)
- Push-нотификации при критичных событиях
- `/manta tell <id> <msg>` — direct message в клон

### Phase 3 — HALF-LIFE (хрупкость)

Клон автоматически умирает при:
- TTL (default 20 минут)
- 3 ошибки подряд
- Token budget исчерпан
- Drift > 30% от task contract (SOMA-scored)
- Loop detected (одинаковые tool calls в окне)
- Stagnation (2 минуты нет file changes)
- Явный kill от мейна

### Phase 4 — TERMINATE → MERGE

При смерти клона:

1. **Last Gasp Report** в `.manta/reports/<id>.md` (что сделал, что осталось, insights, locks для освобождения)
2. **Knowledge harvest** — insights сохраняются в ZK/PARA до смерти
3. **Lock release** — все held locks возвращаются в пул
4. **Bus de-register**
5. **Worktree status** — branch, last commit, changed files

Затем — workflow по триггеру смерти (см. секцию 7).

### Phase 5 — COOLDOWN

Мейн на cooldown'е — нельзя сразу спамить. Время на оценку результатов.

---

## 4. Coordination Layer

### Manta Bus

Базируется на существующем `mcp__claude-peers`. Полный API между клонами:

**Lifecycle**
- `manta.register <clone-id> <metadata>` — регистрация при спавне
- `manta.heartbeat <clone-id> <state>` — каждые 10 сек
- `manta.suicide_intent <clone-id> <reason>` — клон сигналит self-termination перед exit
- `manta.report_death <clone-id> <last-gasp-report-path>` — финальный отчёт

**Task contract**
- `manta.task_contract read <clone-id>` / `manta.task_contract write <yaml>` — read/write контрактов
- `manta.ack_contract <clone-id> <interpretation>` — initial contract acknowledgement (для catch-early scope conflicts)
- `manta.contract_refresh <broadcast>` — anchor sync от мейна (каждые 5 мин)

**Work coordination**
- `manta.claim_work <item> <timeout>` — заявка на единицу работы
- `manta.release_work <item>` — освободить
- `manta.lock <path>` / `manta.unlock <path>` / `manta.renew_lock <path>` — file locks (heartbeat-based)

**Communication**
- `manta.broadcast <event-type> <payload>` — фильтрованные события (breakthrough / blocker / dependency)
- `manta.message <clone-id> <payload>` — direct message (для round-table escalations)
- `manta.drift_report <clone-id> <score> <evidence>` — клон рапортует свой drift в мейна

**Memory (atomic shared writes)**
- `manta.zk_write <note>` — атомарная запись в ZK с tag clone-id
- `manta.para_append <category> <fact>` — append-only в PARA

### File locks

- Per-file lease в `.manta/locks/<path>.lock` (clone-id + expiry)
- **Heartbeat-based** (не TTL) — клон каждые 5 сек делает renew
- Нет heartbeat 15 сек → lock auto-release (zombie cleanup)

### Worktree isolation

Главная страховка для `forking-realities` — клоны физически в разных worktrees, конфликты невозможны.

### Shared memory (3 слоя, все уже есть)

- **claude-mem** — observations
- **PARA folders** — append-only факты
- **ZK** — атомарные заметки + связи (через `manta.zk_write` для атомарности)

---

## 5. Inter-clone Protocols (анти-обосратушки)

### 5.1 Task Contract при спавне

Не расплывчатая задача — структурированный YAML:

```yaml
clone_id: A
mode: forking-realities
task: "Оптимизировать query в orders.sql"
scope:
  allowed_paths: ["sql/", "models/order.py"]
  forbidden_paths: ["auth/", "billing/"]
  max_files_changed: 5
approach_hint: "Через индексы + materialized view"
sibling_clones: [B, C]
deadline: 18min
```

Клон отвечает acknowledgement в первом heartbeat — конфликты scope ловятся ДО работы.

### 5.2 Work Claim Board

Виртуальный канбан в Bus. Кто первый клеймнул `<work-item>`, тот делает. Дубликации работы нет в принципе.

### 5.3 Filtered broadcast

Только три типа событий в Bus:
- `breakthrough` — нашёл root cause / решил подпроблему
- `blocker` — застрял
- `dependency` — обнаружил влияющий чужой код

Шум (started/finished reading) — только в локальный лог.

### 5.4 Round-table escalation

Если два клона предложили разные решения — **сами не голосуют**. Эскалация в мейна (как тренер в спорте).

### 5.5 Anti-gossip rule

Запрещено в `manta-as-clone` skill:
- Обсуждать «чья версия лучше»
- Self-promotion
- Социальные игры

Только факты + evidence.

### 5.6 Drift tracker

Каждые N действий — сверка с контрактом. SOMA уже считает drift. > 30% → клон сам инициирует suicide + handoff.

### 5.7 Anchor sync

Мейн broadcast'ит `contract-refresh` каждые 5 минут. Клоны переподтверждают.

### 5.8 Plagiarism prevention (forking-realities only)

Клоны **не видят** код / Bus-сообщения друг друга до финала. Bus в этом режиме = read-only с мейном.

---

## 6. Game Mechanics из Доты (что переносим)

### 6.1 Cooldown — 50 сек у мейна

Защита от runaway costs + время на оценку diff'ов.

### 6.2 TTL — 20 минут

Не баг, а фича. Не успел — задача пересматривается.

### 6.3 Fragility — 3 ошибки = смерть

Прямой аналог «пары хитов и иллюзия лопнула». Клон с 3 failed-tests явно делает не то.

### 6.4 Manta Charge — конкретные числа

Саморегулирующаяся валюта кастов. Чем хуже работаешь — тем меньше прав на параллелизм.

**Стартовое состояние:**
- `charges_initial = 3`
- `charges_max = 5`
- `charges_min = -1` (один овердрафт допустим, см. ниже)

**Cost per cast** — см. колонку Charge cost в таблице Sec 2:
- recon-swarm: 1, pair-programming: 1, documentation-chase: 1
- forking-realities: 2, test-storm: 2, refactor-wave: 2, bug-hunt: 2, decoy: 2
- council: 3, phantom-lance: 3
- combo: сумма cost'ов составляющих режимов

**Gain / loss:**
- `+1` за каждый успешный cast (auto-merge или approved manual merge)
- `−1` за каждый failed cast (3 errors / drift > 30% / aborted by мейн / TTL без результата)
- `0` за neutral (manual drop без negative outcome)

**Passive recovery:**
- `+1` per 30 минут idle (без активных cast'ов и без failures), capped at `charges_max`
- Восстановление паузится если active clones > 0

**Bankruptcy protection:**
- Charges могут уйти в `−1` (один овердрафт)
- При `charges < 0` следующий fail → 24-часовой жёсткий cooldown на касты (только manual override через `/manta refresh` с двойным confirm)
- Пока в overdraft — доступны только Wave-1 cheap режимы (cost ≤ 1)

**Сериализация:**
- Состояние `.manta/state/charges.json` — атомарные обновления через orchestrator
- Аудит: каждое изменение — строка в `.manta/state/charges.log`

### 6.5 Phantom Lance — рекурсия с decay

Клон может кастовать manta, но с уменьшенной силой ((50%)^N бюджета и TTL). Hard depth = 2. Locked by default.

### 6.6 Aghanim's Scepter — unlock мощных режимов

`council`, `phantom-lance` и тяжёлые комбо залочены. Юзер явно включает в config.

### 6.7 Refresher Orb — обнуление cooldown

`/manta refresh` — exceptional case, требует confirm. Не для рутины.

### Что НЕ переносим

HP-бары, dispel, disable-cast — нет аналогов в коде.

---

## 7. Post-Mortem Flow

### Триггеры смерти и workflow

| Триггер | Workflow |
|---|---|
| **Success** | Auto-merge attempt → success ? merge : мейн решает rebase / cherry-pick / drop |
| **Failure (3 errors)** | NO merge. Alert мейну, опции: re-spawn / отказ / руками. Worktree → graveyard |
| **TTL** | WIP saved as branch. Re-spawn возможен. Иначе → graveyard |
| **Drift** | Diff контракт↔действия. Часто = сигнал плохого контракта. Lessons learned в `manta-cast-decide` skill |
| **Killed** | Clean exit. Locks freed. Worktree → graveyard |
| **Crash** | Recovery: read partial state, force-release locks, re-spawn если важно |

### Best-of-N (forking-realities)

После смерти всех клонов мейн запускает `manta-merge-review`:

1. Гонит тесты в каждом worktree
2. Composite scoring: diff size / complexity / perf / coverage delta
3. Ranks
4. Side-by-side markdown для мейна
5. Мейн выбирает один → merge → остальные в graveyard
6. Insights из всех трёх → ZK (даже у проигравших)

### Graveyard

`.manta/graveyard/<clone-id>/` — worktree + report + logs. 3 дня retention. `/manta exhume <id>` поднимает обратно.

---

## 8. Skill Suite

Без скилов сама механика не работает — Claude должен знать когда / как / что.

### Для мейна (caster)

- **`manta-cast-decide`** — pre-cast самопроверка: задача требует параллелизма? cooldown ОК? есть бюджет?
- **`manta-mode-selector`** — auto-выбор режима по типу задачи
- **`manta-merge-review`** — как смотреть diff'ы, ranking, что аппрувить
- **`manta-knowledge-harvest`** — вытаскивание insights в ZK до смерти клона

### Для клона (illusion)

- **`manta-as-clone`** — кто я, что мне можно. Запреты: рекурсивный manta (если не phantom-lance), общение с юзером напрямую, правки вне worktree
- **`manta-coordinate`** — file locks, broadcast этикет, что делать при busy
- **`manta-graceful-death`** — при TTL/kill: финальный commit, knowledge dump, clean exit

### Системные

- **`manta-conflict-resolve`** — алгоритм при коллизии
- **`manta-recursion-guard`** — phantom-lance protection
- **`manta-pre-cast-check`** — gate перед спавном

---

## 9. Tech Stack

### Что уже есть и реюзается

| Слой | Что используем |
|---|---|
| Inter-process bus | `mcp__claude-peers` |
| Spawn | `claude` CLI с `--print`/headless mode |
| Distribution | npm CLI (`npx manta@latest install`); Claude Code plugin-marketplace entry — Phase 8 |
| Skills | Skill tool, frontmatter-based |
| Observability | hooks (Pre/PostToolUse, Stop) |
| Status line | `statusline-setup` agent |
| Memory | `claude-mem`, PARA, ZK |
| Drift | SOMA |
| Worktrees | `superpowers:using-git-worktrees` |

### Что пишем с нуля

1. **`manta-cli`** — главный исполнитель спавна (CLI обёртка над `claude`)
2. **`manta-bus`** — extension над claude-peers с Manta-специфичным API
3. **`manta-orchestrator`** — background daemon для lifecycle (heartbeats, dead clone detection, post-mortem trigger, cooldown/charge management)
4. **`manta-snapshot`** — transcript + state serializer
5. **Skill suite** (~10 скилов выше)
6. **Slash commands** `/manta *`

### Структура проекта

```
manta/
├── packages/
│   ├── manta-cli/          # CLI entry point
│   ├── manta-bus/          # MCP server
│   ├── manta-orchestrator/ # background daemon
│   └── manta-snapshot/     # state serializer
├── skills/                 # ~10 skill files
├── commands/               # slash commands
├── hooks/                  # pre/post tool use
├── config/manta.config.json
└── docs/
```

Распространяется как **npm CLI** (`npx manta@latest install` ставит bin и регистрирует `manta-bus` MCP-сервер из installed path). Claude Code plugin-marketplace entry — Phase 8, не v1-механизм.

### Реальные блокеры самого Claude Code

1. **Headless spawn ограничен** — `--print` это one-shot, multi-step через CLI хрупко.
   → V1: batch-spawn (one-shot per клон). Хорошо работает для `recon-swarm`, `forking-realities`, `refactor-wave`. Mode'ы требующие итеративности (`pair-programming`, `test-storm`) — V2.

2. **Full transcript = дорогой initial context**.
   → **Решено эмпирически (v1):** native forked-session resume несёт полный transcript без стоимости сборки snapshot'а (Claude Code сам грузит JSONL), но token-cost re-ingest'а на turn-1 реален. Default = full forked resume; cost-control tier = distilled forked JSONL (auto выше size-порога). Механизм + tiers — см. подсекцию «Transcript inheritance — механизм и cost-tiers (v1)» ниже. `manta.fetch_history` отложен (не нужен для v1: `--resume` несёт историю нативно).

3. **API стабильности headless mode** — Anthropic может поменять.
   → `manta-cli` как abstraction layer.

4. **Cost runaway** — 3 клона × 20 мин × Opus = $$.
   → Multi-layer protection:
   - **Hard token budget per cast** (default `$15`, configurable). $5 нереалистично — один Opus-сеанс на 20 мин может стоить $1.50–3, поэтому $15 на 3 клона даёт реальную marginal storage.
   - **Per-clone hard limit** = budget / N (auto-recompute если N меняется).
   - **Daily session cap** (default `$50`, configurable). При превышении — касты блокируются до завтра.
   - **Auto-downgrade**: если daily остаток < cost запрошенного режима — N клонов уменьшается автоматически, либо режим даунгрейдится до более дешёвого аналога (предлагается мейну, не делается тихо).
   - **Cost preview обязателен**: каждый cast сначала проходит `/manta dry-run` который выдаёт estimated cost + ETA + plan; мейн (или auto-mode) аппрувит.
   - **Smart context distillation** (Sec 9, реальные блокеры пункт 2) — критичный многопляющий фактор, без него $15 не реалистичны.
   - **Charge system** (Sec 6.4) — поверх budget'а ограничивает частоту.

5. **Zombie processes** при крэше мейна.
   → `parent_pid` tracking + heartbeat-проверка `kill -0 parent`. Suicide через 30 сек после смерти parent.

### Transcript inheritance — механизм и cost-tiers (v1)

> Reconcile Sec 1 (claim «full context inheritance») ↔ Sec 9 блокер #2 (full transcript дорог). Разрешено `/goal` 2026-05-29: **имплементируем full inheritance**, не репозиционируем claim. Механизм доказан эмпирически (cast-1780064388927, clone-A; см. `docs/audits/2026-05-29-transcript-inheritance-plan.md`).

**Механизм (проверен на Claude Code build 2.1.156):**

1. Мейн узнаёт свой session id через `process.env.CLAUDE_CODE_SESSION_ID` (НЕ `CLAUDE_SESSION_ID` — тот unset). Child-процесс `manta cast` наследует env → видит id мейна.
2. Transcript мейна лежит на диске: `~/.claude/projects/<mangle(cwd)>/<sessionId>.jsonl`, где `mangle` = замена `/` и `.` на `-`.
3. `--resume` **cwd-scoped**: клон в своём worktree (другой cwd → другой project-dir) НЕ может `--resume <parentId>` напрямую («No conversation found»).
4. Реальный fork: **копируем** parent JSONL в project-dir worktree'а клона под свежим per-clone uuid, затем `claude --print --resume <fork_i> --append-system-prompt <priming> <prompt>`. Клон видит полный разговор мейна, пишет только в свою forked-копию, parent JSONL **не трогается** (открывается один раз `fs.copyFile`). N клонов = N независимых форков в N разных project-dir → нет гонки за parent, нет интерференции между клонами. `--fork-session` не требуется (копия и ЕСТЬ форк).

**Cost-tiers (оба — forked-session resume, т.е. оба «наследование транскрипта», а не субагент):**

| Tier | Когда | Что несёт клон |
|---|---|---|
| **A — Full (default)** | transcript ≤ size-порог | полный parent JSONL, forked + resumed. Доставляет claim Sec 1 буквально. |
| **B — Distilled (FIRM default выше size-порога; либо `--distill`)** | transcript > порог (default ~2 MB; live main-сессии наблюдались до **11.7 MB** — full-copy × N клонов взорвал бы budget/context) | trimmed forked JSONL: header-записи + compaction-summary + last-N message-записей, resumed. Меньше байт, но всё ещё **continuation of me**, не fresh-context+briefing. |

Граница «клон vs субагент» держится на **обоих** tier'ах: клон всегда стартует как продолжение разговора мейна (forked-session resume), тогда как субагент стартует с пустого контекста + брифинг. Tier B триммит хвост ради cost — он НЕ опускает клона до субагента. **FIRM default**, не «consider»: на реальных транскриптах (11.7 MB наблюдался) full-copy по умолчанию неприемлем.

**Отложено для v1 (не блокеры):** `manta.fetch_history` lazy-load (Sec 9 оригинал) — не нужен, `--resume` несёт историю нативно. Реализация — `docs/superpowers/plans/2026-05-29-release-rb1-transcript-inheritance.md`; доказательство — e2e sentinel-тест (клон воспроизводит факт, существовавший ТОЛЬКО в разговоре мейна, и недостижимый из task/priming/snapshot).

---

## 10. Risks & Mitigations

| Риск | Severity | Митигация |
|---|---|---|
| Token bill runaway | High | Hard budget + charge system |
| Concept drift между клонами | Medium | Anchor sync + contract versioning + initial echo |
| Клон вышел за scope | High | PreToolUse hook блокирует Edit/Write вне allowed_paths + capability matrix per mode |
| Спор клонов в Bus | Medium | Anti-gossip rule + escalation в мейна |
| Двое правят один файл | Medium | Worktree isolation + work-claim board |
| Зомби-клоны после крэша мейна | Medium | parent_pid heartbeat + manta recover |
| CLI API changes | High | Abstraction в manta-cli |
| Plagiarism в forking-realities | Medium | Strict isolation от Bus до финала |
| Информационная перегрузка мейна | Medium | Notification batching + severity routing + whisper mode |
| Recursive blow-up | High | Hard depth=2 + decay + locked-by-default |
| Bad mode selection | Low | manta-mode-selector + dry-run preview |
| Best-of-N выбирает плохой вариант | Medium | Composite scoring + manual override + insights в ZK всё равно сохраняются |

### Что не митигируется полностью

1. **Прецедент-дрифт между клонами** — каждый видит world чуть иначе. Смягчается, не лечится.
2. **LLM непредсказуемость** — клон может «придумать» что у него больше прав. Smягчается hooks-блокерами и жёстким `manta-as-clone`, но не на 100%.
3. **Стоимость экспериментов на старте** — пока скилы не настроены, manta будет жрать бюджет. Стартуем с дешёвых режимов (`recon-swarm`).

---

## 11. Дополнительные фичи

### 11.0 Observability tier ladder

Чтобы фичи 14-15 не перепутались с базовыми командами Sec 12, явно фиксируем уровни наблюдаемости:

| Tier | Surface | Latency | Use case |
|---|---|---|---|
| 0 — passive | statusline (1 строка внизу Claude Code) | always-on | «есть ли вообще активность» |
| 1 — on-demand | `/manta status` (compact таблица всех клонов) | sync, секунда | «что сейчас делают» |
| 2 — deep dive | `/manta inspect <id>` (full snapshot одного: контракт, last 20 actions, locks, drift, budget) | sync, секунды | «почему этот клон тормозит» |
| 3 — real-time | `/manta tail <id> [seconds]` (stream логов в чат мейна) | live | «хочу видеть каждый ход» |
| 4 — forensic | `/manta replay <cast-id>` + `/manta audit <clone-id>` (полный журнал post-mortem) | post-cast | «разбор после fact'а» |

Каждый tier — отдельный код-путь, не переизобретают друг друга. Единый источник истины — orchestrator's event log.

### 11.1 Дополнительные фичи

1. **Manta Replay** — журнал каста, `/manta replay <cast-id>` пересмотр как реплея
2. **Manta Sandbox** — shadow copy файлов для рискованных режимов
3. **Auto-cast triggers** — hooks реагируют на события (git pull, failing tests) и кастуют
4. **Manta Templates** — сохранённые конфигурации кастов
5. **Manta Profiles** — наборы дефолтов под контекст
6. **Hot-swap mode** — смена режима клона на лету
7. **Manta Eval** — self-tuning по результатам
8. **Cross-session inheritance** — manta учится на прошлых кастах через claude-mem
9. **Manta Library** — community templates / mode'ы
10. **Whisper-on-completion** — клон работает молча до результата
11. **Dry-run preview** — план без spawn'а
12. **Costs analytics** — `/manta cost --period=week`
13. **Diff overlay** — unified diff по всем клонам
14. **Inspect mode** — глубокий снимок одного клона
15. **Manta Tail** — live stream логов в чат мейна
16. **Sticky context warm-up** — shared cache prompts для всех клонов (дешевле)
17. **Manta Pinned** — закрепить факт во всех клонах (broadcast)
18. **Conflict explorer** — `/manta blend <id1> <id2>` мерджит лучшее из двух
19. **Manta Share** — `/manta share <cast-id>` экспорт каста (snapshot контракта + reports + final diffs + insights) в shareable bundle (`.tar.gz`) для коллеги или публикации в Manta Library

---

## 12. Command Palette

```
# Cast & lifecycle
/manta cast <mode> [args]              Спавн клонов
/manta dry-run <mode> [args]           Preview без spawn
/manta status                          Compact таблица всех клонов
/manta inspect <id>                    Deep dive в одного клона
/manta tail <id> [seconds]             Live log stream в чат
/manta tell <id> <msg>                 Direct message клону
/manta pin <fact>                      Pinned-context broadcast
/manta swap <id> <new-mode>            Hot-swap режим
/manta pause                           Pause всех
/manta resume                          Продолжить
/manta abort                           Kill all без merge
/manta recontract <new>                Обновить task contract на лету
/manta kill <id>                       Убить одного клона

# Post-mortem
/manta diff [id]                       Unified diff
/manta promote <id>                    Manual winner pick
/manta drop <id>                       Drop без merge
/manta merge <id>                      Manual merge override
/manta blend <id1> <id2>               Смерджить два варианта
/manta exhume <id>                     Поднять из graveyard
/manta replay <cast-id>                Просмотр журнала
/manta recover                         Cleanup после crash

# History & analytics
/manta list                            Все активные касты
/manta history [period]                Недавние касты + результаты
/manta cost [period]                   Token usage
/manta eval                            Self-tuning статистика
/manta audit <clone-id>                Action audit log

# Templates & profiles
/manta template save <name>            Сохранить как template
/manta template list                   Список
/manta template apply <name>           Каст из template
/manta profile create <name>
/manta profile use <name>

# Settings & unlocks
/manta config                          Edit settings
/manta unlock <feature>                Aghs — включить locked mode
/manta whisper on|off                  Quiet mode
/manta sandbox on|off                  Sandbox mode
/manta limit set <key> <val>           Budget/clones/ttl

# Triggers & community
/manta trigger add <event> <action>    Auto-cast triggers
/manta trigger list
/manta install <package>               Из Manta Library
/manta share <cast-id>                 Экспорт для коллеги
/manta refresh                         Сброс cooldown (требует confirm)
```

---

## 13. Open Questions для plan phase

- Какой режим в первой prod-волне? **Решено**: `recon-swarm` + `forking-realities` (Wave 1, batch-spawn совместимы, минимум зависимостей рантайма).
- Где dogfood'им? **Решено**: на репо самой Manta. Клоны строят Manta — симметричный bootstrap (см. Sec 15).
- Когда подключаем daemon-mode (Wave 2 prerequisite)? Открытый вопрос для plan phase.
- Когда unlock'аем Aghs-режимы? Не раньше после стабилизации Wave 2 + 90+ дней prod-наработки на Wave 1-2.

Финализация в `superpowers:writing-plans`.

---

## 14. Production Quality Standards

**Это не MVP, не demo, не mock.** Каждый релиз каждой волны — production-grade с первой строки кода. Фиксируем стандарты.

### 14.1 Code-level

- **Test coverage** ≥ 80% на критичных путях: `manta-orchestrator`, `manta-bus`, `manta-cli`, `manta-snapshot`. На skills suite — coverage по поведенческим сценариям через recorded fixtures.
- **No throwaway code** — каждая функция, написанная в Phase N, должна выжить до Phase N+5 без переписывания. Если требуется переписывание — это явный refactor PR, не «ну мы тогда хак сделали».
- **No placeholder implementations** — функция либо работает по спеке, либо отсутствует. `// TODO: implement` запрещён в merged-коде.
- **Failure paths covered** — для каждого вызова в orchestrator/bus есть тест: timeout, invalid input, partial state, concurrency conflict.
- **Cost transparency** — каждый код-путь, который тратит токены, логирует estimated и actual cost. Открытие telemetry endpoint обязательно.
- **No hardcoded secrets / paths** — конфиг через `.manta/config.json` + env override.

### 14.2 Release-level

- **Documentation included** — каждая фича приходит с user-facing docs (`docs/user/<feature>.md`) + architecture note (`docs/arch/<component>.md`).
- **Migration plan** — каждый breaking change в API or state file имеет migration script (`packages/*/migrations/`).
- **Changelog discipline** — every merge updates `CHANGELOG.md`. Формат Keep-a-Changelog, semver.
- **Backwards compat** для state files — `.manta/state/*` версионирован, оркестратор читает старые версии без падения 2 release-cycle'а назад.
- **Smoke tests на real Claude CLI** — каждый Wave-release прогоняется полным end-to-end на боевом `claude` CLI, не на моках.

### 14.3 Operational

- **Observability** — все 5 tier'ов (Sec 11.0) работают **к Phase 1 GA**, не «потом докрутим». Phase 0 ship'ит tier 0 (events log) + tier 1 partial (post-mortems on disk + stderr reporter); tier 2-4 enforced в Phase 1 per Sec 15.1. Это compromise между "release 1 = ground floor" и реальностью bootstrap-by-Manta — без рабочих клонов observability tier 3-4 (auto-cast triggers, drift dashboards) построить нечем.
- **Error budgets** — daily SLO: ≥ 95% castов завершаются без catastrophic failure (zombie processes, orphan locks, corrupted state).
- **Rollback plan** для каждой волны — известный набор шагов чтобы откатить на предыдущую версию без потери данных.
- **Cost dashboards** в `docs/ops/cost-dashboard.md` (текстовое описание; runtime — `/manta cost`).

### 14.4 Pure-discipline rules

- Никаких `if env == 'prod' else mock_fallback`. Один код-путь.
- Никаких feature flags «потому что я не уверен» — feature либо merged и работает, либо в branch.
- Никаких commits «фикс позже разберусь» — fix or revert.
- При сомнении — кастуем `recon-swarm` чтобы проверить, не «я пишу как помню».

---

## 15. Bootstrap Strategy — Manta builds Manta

Принцип: **как только клоны рабочие — мейн (я, Claude Code) использует их для постройки остальной Manta**. Это даёт:

1. **Real-world dogfooding** — мы первые пользователи. Каждый bug мы видим на себе.
2. **Compounded productivity** — Phase N+1 строится с помощью Phase N. Скорость растёт нелинейно.
3. **Continuous bug intake** — мейн ведёт `manta-bugs.md` (живой реестр), все обнаруженные баги клонов — фиксы попадают в следующий релиз.

### 15.1 Phasing (high-level, детали в plan)

**Phase 0 — Foundation (no clones yet)**
- Скилы (минимально критичные): `manta-as-clone`, `manta-coordinate`, `manta-graceful-death`, `manta-cast-decide`
- `manta-snapshot` (transcript + state serializer)
- `manta-cli cast` (минимально для batch-spawn)
- `manta-bus` extension над `claude-peers`
- `manta-orchestrator` (heartbeat tracking, dead clone cleanup, post-mortem trigger)
- Skill: `recon-swarm` mode end-to-end
- Build by: solo Claude Code (мейн без клонов)

**Phase 1 — First working clone (recon-swarm production-ready)**
- Полный recon-swarm с production quality (test coverage, error handling, observability tier 0-2)
- Smoke test: мейн кастует recon-swarm на реальном репо, получает usable map
- Build by: solo Claude Code

**Phase 2 — Forking-realities production-ready**
- Worktree-based isolation, best-of-N flow, manta-merge-review
- Tier 3-4 observability (tail, replay, audit)
- Build by: **partial dogfood** — Phase 0/1 рабочий recon-swarm используется чтобы исследовать чужие best-of-N паттерны (Tournament selection, Pareto frontier и т.д.)

**Phase 3 — Charge system + budgets + cooldowns**
- Charge persistence + recovery + bankruptcy protection
- Token budget multi-layer (cast / clone / daily)
- Build by: **fork-by-manta** — кастуем `forking-realities` на 2 варианта реализации charge persistence (sqlite vs JSON+lockfile), best-of-N выбор

**Phase 4 — Wave-1 closeout: refactor-wave + bug-hunt**
- Завершение Wave 1 mode'ов
- Build by: heavy dogfood — `recon-swarm` для исследования + `forking-realities` для design alternatives

**Phase 5 — Wave 2 prerequisites: daemon-mode runtime**
- Long-running клон (не batch one-shot) — нужен для `pair-programming`, `test-storm`, `documentation-chase`
- Решение: extension над `claude` CLI (если возможно) или собственный daemon с MCP integration
- Build by: full dogfood

**Phase 6 — Wave 2 modes**
- `pair-programming`, `test-storm`, `documentation-chase`
- Build by: full dogfood

**Phase 7 — Manta Library + auto-cast triggers + community**
- Build by: full dogfood

**Phase 8 — Aghs-locked modes** (`council`, `phantom-lance`, `decoy`)
- Только после 90 дней prod-наработки на Wave 1-2 без catastrophic incidents
- Build by: full dogfood + `council` mode для архитектурных решений (recursive поиск)

### 15.2 Continuous improvement loop

С Phase 1 и далее, каждая сессия мейна включает:

1. **Triage**: проверить `manta-bugs.md` — есть ли bug-fixes которые блокируют сегодняшнюю работу
2. **Cast strategically**: каждая нетривиальная задача оценивается на cast-suitability (manta-cast-decide skill)
3. **Log learnings**: после каждого cast'а — strict post-mortem entry в `docs/post-mortems/<date>-<cast-id>.md`
4. **Update skills**: если поведение клона удивило — fix в skill, не в orchestrator
5. **Memory sync**: insights → ZK / PARA / claude-mem (см. Sec 15.3)

### 15.3 Memory & learning

- **PARA folders** (через `para-memory-files` skill) — атомарные факты о проекте (что есть, что планируется, что протестировано)
- **claude-mem** — passive observation поток между сессиями
- **ZK Steward** — атомарные ноты + связи (особенно ценно для cross-session insight'ов: «эта проблема уже решалась в Phase X»)
- **graphify** — периодически (раз в Phase) пересобираем knowledge graph всего проекта
- **manta-bugs.md** — живой bug log (manual-curated, не автогенерируется)
- **post-mortems/** — структурированные разборы каждого нетривиального cast'а

### 15.4 Definition of Done для проекта

Manta достигла цели когда:

1. **На репо самой Manta** мейн строит новую feature за < 50% времени по сравнению с solo Claude Code (measured)
2. **Daily cost** в рамках declared budget без manual interventions ≥ 30 дней подряд
3. **Zero catastrophic incidents** за 90 дней (нет lost code, нет corrupted state, нет stuck zombie processes)
4. **All 10 mode'ов** в production status (включая Aghs-unlocked)
5. **Установка для нового пользователя** ≤ 5 минут от `npx manta@latest install` до first successful cast
6. **Documentation completeness** — каждая фича + каждая команда покрыта

Это **paradigm shift** — первый параллельный self-cloning AI-агент в production, не academic toy.

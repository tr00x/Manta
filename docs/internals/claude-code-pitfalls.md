# Claude Code — pitfalls и hard-rules для Manta

Шпаргалка по реальному поведению Claude / Claude Code, написанная **из боли**: каждое правило — следствие конкретной ошибки в Manta, со ссылкой на post-mortem или bug. **Читать перед каждой архитектурной правкой, касающейся skills, priming text или enforcement.**

---

## 1. Skill-text НЕ enforces per-turn behaviour

**Правило:** Любая инструкция вида "первый tool call каждого assistant turn должен быть X" в skill-text или priming preamble — **soft prior, не hard rule**. Claude её игнорирует под пресс задачи.

**Доказательство:** Bug #9 (см. `docs/manta-bugs.md`) — закоммитили skill v0.0.2 + priming reinforcement правила "first tool call of every turn = manta.heartbeat". Validation cast `cast-1778189501846`: clone A — 3 heartbeat за 3 минуты, clone B — 1 heartbeat. Оба DEAD по staleness 92-93s. Skill+priming тройное reinforcement не сработало.

**Почему:** Claude — LLM, выбирает tools на основе контекста. Anthropic docs (tool-use/strict-tool-use) явно говорят: "First tool call of every turn" — instruction-following, не constraint. Никакой grammar-constrained sampling в API не контролирует **порядок** tool calls в turn — только их parameters (через `strict: true`).

**Что делать:**
- ❌ Не писать "first call of every turn must be X" в skills.
- ❌ Не писать time-based правила ("каждые 10 секунд") — Claude не имеет wallclock между turns.
- ✅ Если behavior нужен detrministic — **infrastructure-side** (см. §3, §4).
- ✅ Если behavior soft (best-effort) — skill для explainability, не для compliance.

---

## 2. Tool-call ordering INSIDE one turn — emergent, не детерминирован

**Правило:** Если Claude в одном assistant turn делает несколько parallel tool calls, **порядок их в response array — артефакт сериализации, не контракт**.

**Доказательство:** Anthropic API docs (parallel-tool-use.md): "tool calls may be invoked in parallel; ordering within a turn is not guaranteed for logic purposes."

**Что делать:**
- ❌ Не дизайнить системы где "tool A должен выполниться раньше tool B в том же turn".
- ✅ Если порядок критичен — два turn'а: вернуть результат tool A, затем в следующем turn'е вызывать tool B.
- ✅ Или enforcement через `PreToolUse` hook (см. §4).

---

## 3. MCP server side-effects — это **detection**, не enforcement

**Правило:** Side-effect на каждом успешном MCP handler (например, `Registry.touch(cloneId)` при любом `manta.*` call) — **надёжная liveness detection**. Любой call от живого клона ЕСТЬ liveness signal. Это структурный паттерн, а не дисциплина.

**Доказательство:** Bug #9 структурный фикс (option d, in flight). Skill v0.0.2 не работал. Вместо "Claude должен сам heartbeat'ить каждый turn" → "bus сам обновляет last_heartbeat_at на любой MCP call". Любая активность клона = liveness, точка.

**Когда применять:** Любой инвариант вида "клон жив пока что-то делает" → infrastructure side-effect. Не правило в skill.

**Когда НЕ применять:** Если инвариант требует **отказа** клона от действия (например, "не пиши вне scope") — нужен PreToolUse hook (§4) или validation в MCP handler с `permissionDecision: "deny"`.

---

## 4. PreToolUse hooks — единственный hard forcing function в Claude Code CLI

**Правило:** Claude Code CLI поддерживает `PreToolUse` hooks (configured в `.claude/settings.json` или родительский config), которые исполняются **harness'ом, не моделью**, перед каждым tool call. Hook может:
- Блокировать tool: вернуть `{ permissionDecision: "deny", permissionDecisionReason: "..." }` → Claude видит deny и должен попробовать другой подход.
- Возвращать context Claude'у через `permissionDecisionReason` (Claude увидит в next turn).
- Условно блокировать (например, "deny всё кроме `manta.heartbeat` если staleness > 30s").

**Это — единственный механизм, который НЕ зависит от instruction-following Claude.** Harness исполняет hook deterministically.

**Ограничения для Manta:**
- Hooks конфигурируются на уровне Claude Code instance. Каждый клон имеет свой `.claude/settings.json` (через worktree). Для централизованного контроля spawner должен генерировать settings.json с manta-specific hooks при создании worktree.
- Hook commands должны быть быстрыми (<2s timeout по умолчанию) — не блокирующими heavy I/O.

**Когда применять:** Hard invariants ("клон не может выйти за scope", "клон не может вызвать `manta.cast` рекурсивно", "клон не может писать в forbidden_paths"). См. spec Sec 5.7.

---

## 5. `tool_choice` API-only, через `claude --print` недоступен

**Правило:** Anthropic API имеет параметр `tool_choice: { type: "tool", name: "..." }` который заставляет Claude вызвать конкретный tool. **Это feature SDK, не CLI.** Manta запускает клонов через `claude --print --append-system-prompt ... <prompt>` — нет способа передать `tool_choice`.

**Что делать:** Не закладывать `tool_choice` в дизайн Manta. Если нужен deterministic first-call → PreToolUse hook (§4) + skill guidance (§1) + MCP tool side effect (§3).

---

## 6. System prompt (`--append-system-prompt`) durability vs skill content

**Правило:**
- **System prompt** (передаётся через `--append-system-prompt`) — **permanent**, остаётся в каждом turn'е сессии, не компактируется при overflow.
- **Skill content** (загружается через `Skill` tool) — **инъектируется один раз**, после компакции переинъектируется только первые ~5K токенов.

**Следствие:** Hard rules должны быть в **priming preamble** (system prompt), а не в skill text. Skill text — для контекста и examples, которые могут быть забыты после длинной задачи.

**Что делать:**
- ✅ Идентичность клона ("ты — Manta clone, parent_pid=N, scope=...") → priming preamble.
- ✅ Hard rules ("НИКОГДА не делай recursive cast") → priming preamble.
- ✅ Detailed playbooks ("графsефул shutdown — 7 шагов") → skill text (но не критичные).
- ❌ Не писать критичные rules только в skill — после компакции забудутся.

---

## 7. Cross-plan field-name drift — schema-first, then text

**Правило:** Любое имя поля в skill text или priming, ссылающееся на MCP tool argument — **должно существовать в bus Zod schema до того, как попасть в текст**. Иначе schema rejects payload, клон видит `validation_error`, поведение деградирует.

**Доказательство:** Bug #13 — я добавил `message` field в priming preamble + skill v0.0.2 без проверки `@manta/bus` heartbeat schema. Clone A's last-gasp: "manta.heartbeat rejected message field per current schema". Cross-plan drift class — тот же что в `CLAUDE.md` "Plan-writing discipline".

**Что делать:**
- ✅ Перед добавлением field в skill/priming → `grep -n` Zod schema в bus, убедиться что field принимается. 30 секунд страховки.
- ✅ Ship бы fix в правильном порядке: (1) widen schema + test, (2) reference field в skill+priming.
- ❌ Никогда не "напишу skill, schema догоню потом" — это invisible regression.

**Будущее:** skill-validator должен grow проверку cross-tool field names (entry в `docs/manta-bugs.md` #13 lessons).

---

## 8. Validation casts — обязательны перед "Fixed" claim

**Правило:** Local tests могут пройти, а реальный `claude --print` дрейфит. Любое изменение в skill/priming **обязано** проходить validation cast перед "Status: Fixed in <commit>".

**Доказательство:** Bug #9 fix `5cd7234` — все 268 локальных тестов зелёные, skill-validator clean. Validation cast `cast-1778189501846` — провалился. Я бы закоммитил fix в bug log как "Fixed" если бы не валидировал.

**Что делать:**
- ✅ После любого skill v.X update → cast small validation task (2 clones, простая task, ~$5).
- ✅ Validation cast — публикуй post-mortem с PASS/FAIL по конкретным гипотезам.
- ❌ Не помечать в bug log "Fixed" пока не валидировано на реальном claude.

---

## 9. Compaction — переинъектируется только начало

**Правило:** Когда conversation overflows context window, harness компактирует. После компакции **только первые ~5K токенов skill content переинъектируются в новый context**. Остальное — из summary, lossy.

**Следствие:**
- Длинные skills (> 5K токенов) рискованны — поздние секции забываются после длинной задачи.
- Critical rules — в начале skill markdown (первые секции).
- Examples — в конце (если потеряются — не страшно).

**Что делать:** Skill markdown ordering — **Required (ordered)** → **Allowed** → **Forbidden** → **Examples**. Это уже как в `manta-graceful-death` v0.0.3.

---

## 10. Anti-patterns — список того, что не работает

| Антипаттерн | Почему не работает | Что вместо |
|---|---|---|
| "First tool call каждого turn должен быть X" в skill | Soft instruction, ignored под task pressure | PreToolUse hook ИЛИ MCP side-effect |
| "Heartbeat каждые N секунд" в priming | Claude не имеет wallclock между turns | MCP server timestamp в response + side-effect |
| Параллельные tool calls с предполагаемым порядком | Order emergent, не контракт | Один tool на turn ИЛИ hook chain |
| Time-based rules в skill | Same — нет wallclock | Bus-side staleness check + hook |
| Schema-rejected field в priming/skill | Clone deviates с validation error | Schema-first, текст потом |
| Skill-only critical rule | Может забыться после компакции | Priming preamble (permanent) |
| Локальные тесты как единственная gate для skill change | Реальный Claude дрейфит | Validation cast + post-mortem |

---

## TL;DR — heuristic для будущих skill/priming правок

1. **Hard rule?** → PreToolUse hook ИЛИ MCP side-effect. Не skill text.
2. **Soft guidance?** → Skill text. Но не ожидать compliance под pressure.
3. **Identity / context?** → Priming preamble (permanent).
4. **Time-based?** → Не делать. Используй MCP staleness check.
5. **Field name?** → Сначала schema, потом text.
6. **"Fixed"?** → После validation cast, не до.

**Если заходит мысль "напишу в skill text правило, Claude послушает"** — стоп, это уже ошибка. Иди в §3-§4 и think infrastructure.

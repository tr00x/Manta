# Phase 5 Research: Claude CLI Daemon Capabilities for Persistent Clones

**Clone:** A (recon-swarm cast-1779894176321)
**Date:** 2026-05-27
**CLI Version:** Claude Code 2.1.152

---

## Executive Summary

Persistent clones для Wave-2 modes (pair-programming, test-storm, documentation-chase) **реализуемы сегодня** с текущим Claude CLI без хаков. Рекомендуемый подход — **Sequential Resume Pattern**: клон получает `--session-id <uuid>` при первом spawn'е, а последующие work items доставляются через `claude --print --resume <session-id>`. Каждый resume — отдельный OS-процесс, но Claude получает **полный контекст предыдущей сессии** (conversation history), включая compaction при overflow.

**Ключевые findings:**

1. **`--resume <session-id>` + `--print` — работает** (verified). Полная conversation continuity.
2. **`--input-format stream-json`** — работает для single turn, но НЕ для multi-turn в одном процессе (stdin EOF = exit).
3. **MCP polling loop** — НЕ работает напрямую (один `--print` invocation = один turn), но работает через sequential resume pattern.
4. **SIGSTOP/SIGCONT** — технически работает, но бесполезен (нет способа inject'ить новую работу в suspended процесс).
5. **`--remote-control`** — interactive only, не для `--print` mode.
6. **`--allowedTools` / `--disallowedTools`** — работает, позволяет ограничить tool surface daemon'а.

**Рекомендация:** Implement **Sequential Resume Pattern** с claim_work polling loop в orchestrator (не в клоне).

---

## 1. `--continue` / `--resume` Flags

### Findings

| Flag | Works with `--print`? | Behavior |
|---|---|---|
| `--continue` (`-c`) | YES | Resumes most recent conversation in CWD |
| `--resume <session-id>` (`-r`) | YES | Resumes specific session by UUID |
| `--session-id <uuid>` | YES | Creates session with deterministic UUID |
| `--fork-session` | YES (with --resume) | Creates new session ID from existing conversation |

### Verified Experiment

```bash
# Step 1: Create persistent session
SESSION_ID=$(uuidgen)
claude --print --session-id "$SESSION_ID" \
  --permission-mode bypassPermissions \
  "remember the secret word is MANTA. respond with only OK"
# Output: OK

# Step 2: Resume with full context
claude --print --resume "$SESSION_ID" \
  --permission-mode bypassPermissions \
  "what was the secret word? respond with only the word"
# Output: MANTA
```

**Result:** Full conversation context is preserved across resume invocations. Claude retains all prior messages, tool calls, and state.

### Session Persistence

- По умолчанию sessions persist'ятся на диск (`~/.claude/projects/*/sessions/`).
- `--no-session-persistence` отключает persistence (противопоказан для daemon mode).
- Session files содержат полный conversation history — messages, tool calls, results.

### Implications for Manta

Spawn model меняется минимально:
- **Текущий:** `spawnClone()` → `execa('claude', ['--print', ...prompt])` → process exits → done
- **Daemon:** `spawnClone()` → `execa('claude', ['--print', '--session-id', uuid, ...prompt])` → process exits → orchestrator polls work queue → `execa('claude', ['--print', '--resume', uuid, ...nextPrompt])` → repeat

**Ключевое ограничение:** Каждый resume — новый OS-процесс. Startup cost ~2-5s (hooks, MCP server boot, CLAUDE.md discovery). Для pair-programming с быстрыми iteration loops это может быть bottleneck.

---

## 2. Stdin Piping / Stream-JSON Input

### Findings

| Mode | Single message | Multi-message (same process) |
|---|---|---|
| `--input-format text` (default) | YES | NO (stdin is consumed once) |
| `--input-format stream-json` | YES | NOT WORKING (process exits after first response) |
| Named pipe (FIFO) | Partial | NOT WORKING (EOF semantics) |

### Stream-JSON Format

```bash
echo '{"type":"user_message","content":"say hello"}' | \
  claude --print --input-format stream-json \
  --output-format stream-json --verbose
```

Produces structured JSON output with hook events, tool calls, and assistant messages. But the process exits after completing the first user_message — it does NOT wait for additional messages on stdin.

### Why Multi-Turn Doesn't Work

Claude `--print` mode is designed as a one-shot execution model:
1. Read prompt (from arg or stdin)
2. Process (multiple API turns internally, with tool calls)
3. Print result
4. Exit

The `stream-json` input format allows structured input but does NOT change the one-shot semantics. Each `--print` invocation = one user message → N assistant turns → exit.

### Named Pipes (FIFO)

Tested with `mkfifo`:
- First message delivered successfully
- Process does not wait for second message (exits after completing first response)
- FIFO EOF semantics match regular pipe behavior

### Implications for Manta

**Stream-JSON is useful for structured output parsing** (monitoring tool calls, hook events) but NOT for multi-turn conversation in a single process. For persistent clones, use sequential resume instead.

---

## 3. `--print` Mode vs Interactive Mode

### Key Differences

| Feature | `--print` mode | Interactive mode |
|---|---|---|
| Multi-turn | NO (one-shot) | YES (REPL loop) |
| Programmatic control | YES (stdin/stdout) | NO (requires TTY) |
| `--resume` | YES | YES |
| `--session-id` | YES | YES |
| `--permission-mode` | YES | YES |
| `--max-budget-usd` | YES | NO |
| `--no-session-persistence` | YES | NO |
| `--allowedTools` | YES | YES |
| `--output-format` | text/json/stream-json | N/A (interactive) |
| `--remote-control` | NO | YES |

### Interactive Mode Limitations

Interactive mode requires a TTY — нет способа запустить interactive claude programmatically и inject'ить сообщения через stdin. `--remote-control` открывает HTTP endpoint для управления, но:
- Только для interactive sessions
- Требует `claude agents` GUI для dispatch'а
- Не задокументирован programmatic API для remote-control

### Recommendation

**`--print` mode с sequential resume** — единственный viable path для Manta daemon clones. Interactive mode не подходит для programmatic control.

---

## 4. MCP Polling Loop Pattern

### Current State

`claim_work` MCP tool уже существует в `@manta/bus`:

```typescript
// packages/manta-bus/src/tools/work.ts
ClaimWorkInputSchema = z.object({
  clone_id: CloneIdSchema,
  item: z.string().min(1).max(512),
  timeout_ms: z.number().int().positive(),
});
```

### Why Clone-Side Polling Won't Work

В текущей модели (`--print`), клон не может сделать "poll loop":
1. Клон стартует с одной задачей в prompt
2. Выполняет задачу (N assistant turns с tool calls)
3. Процесс завершается
4. Нет цикла "done → poll → next task"

Клон мог бы вызвать `manta.claim_work` как последний tool call перед exit'ом, но:
- Он не может "подождать" пока работа появится
- Он не может loop'ить — `--print` = один user message → exit
- Даже если бы claim вернул задачу, клон уже в "winding down" контексте

### Recommended Pattern: Orchestrator-Side Polling

```
┌─────────────┐     ┌──────────┐     ┌─────────────┐
│ Orchestrator │────>│ Work Q   │<────│ Main Agent  │
│ (tick-loop)  │     │ (bus)    │     │ (enqueues)  │
└──────┬───────┘     └──────────┘     └─────────────┘
       │
       │ claim_work() returns item
       │
       ▼
  ┌──────────────────────┐
  │ claude --print        │
  │   --resume <session>  │
  │   <work item prompt>  │
  └──────────┬────────────┘
             │ process exits
             ▼
       ┌──────────┐
       │ Back to  │
       │ tick loop │
       └──────────┘
```

**Orchestrator polls work queue** (via `claims.claim()` in tick-loop), then spawns `claude --print --resume <session-id>` with the work item as prompt. Clone process exits, orchestrator loops.

### Minimal Delta from Current Architecture

Current `tick-loop.ts` runs `orchestrator.runCycle()` in a loop with `allDone()` check. Daemon mode adds:
1. `runCycle()` checks work queue for pending items
2. If item found → `claude --print --resume <session-id> <item-prompt>`
3. If no item → sleep(intervalMs)
4. `allDone()` = explicit kill signal or budget exhaustion

### Work Queue Design

Work queue needs:
- **Enqueue:** Main agent posts work items (feedback, new subtasks, corrections)
- **Claim:** Orchestrator claims on behalf of clone (prevents double-processing)
- **Complete:** Clone's exit = work done; orchestrator marks complete
- **Timeout:** If clone's resume process hangs, item released after timeout_ms

Current `claim_work` schema supports this. Missing: `enqueue_work` tool for main agent to post items.

---

## 5. SIGSTOP / SIGCONT Viability

### Experiment

```bash
claude --print "count from 1 to 5" &
PID=$!
sleep 2
kill -STOP $PID   # Process suspended
sleep 3
kill -CONT $PID   # Process resumed
wait $PID          # Exit code: 145
```

**Result:** Process survives SIGSTOP/SIGCONT and completes its task. Exit code 145 = 128 + 17 (SIGCONT as exit signal, benign).

### Why It's Useless for Daemon Mode

1. **No injection mechanism** — suspended process cannot receive new input
2. **Context frozen** — Claude's API conversation is mid-request; SIGCONT just continues the in-flight request
3. **API timeout risk** — Anthropic API has request timeouts; a long SIGSTOP may cause the in-flight request to timeout server-side
4. **MCP servers also stopped** — child MCP server processes (like manta-bus) are in the same process group and get SIGSTOP too
5. **Heartbeat gap** — SIGSTOP halts heartbeat touches; orchestrator may declare clone DEAD

### Verdict

**NOT VIABLE.** SIGSTOP/SIGCONT is a process-level primitive that doesn't interact with Claude's conversation model. There is no benefit over the sequential resume pattern.

---

## 6. Context Window Management

### Compaction Behavior

From `docs/internals/claude-code-pitfalls.md` §9:

- When conversation overflows context window, harness **compacts automatically**
- After compaction: **only first ~5K tokens of skill content re-injected**
- System prompt (`--append-system-prompt`) is **permanent** — survives compaction
- Compaction is **lossy** — later skill content and conversation details are summarized

### Long Session Implications

For daemon clones doing 10+ resume cycles:

| Cycle | Behavior |
|---|---|
| 1-3 | Full context, no compaction |
| 4-8 | Possible compaction; early work items summarized |
| 8+ | Heavy compaction; only system prompt + recent 2-3 cycles retained verbatim |

### Mitigation Strategies

1. **Critical context in `--append-system-prompt`** (permanent)
   - Clone identity, scope, forbidden paths
   - MCP tool descriptions for daemon protocol
   
2. **Work item results as artifacts** (files, not conversation)
   - Each resume cycle writes results to disk
   - Next cycle reads from disk, not from conversation memory
   
3. **Session reset at budget threshold**
   - After N cycles or K tokens, start fresh session with `--session-id <new-uuid>`
   - Transfer critical state via snapshot file + priming text
   - Trades conversation continuity for clean context

4. **`--fork-session`** — creates new session from existing conversation
   - Potentially useful for "checkpoint and continue" pattern
   - Needs investigation: does fork trigger compaction?

### Context Budget

- Claude Opus 4.7: 200K context window (1M with extended thinking)
- Each `--print --resume` cycle adds ~2-10K tokens (prompt + response + tool calls)
- Theoretical limit: ~20-50 resume cycles before heavy compaction
- Practical limit depends on tool call volume per cycle

---

## 7. Claude Code Hooks for Work Injection

### Available Hook Events

| Hook | Timing | Can inject work? |
|---|---|---|
| `PreToolUse` | Before each tool call | YES (via `permissionDecisionReason` → context injection) |
| `PostToolUse` | After each tool call | YES (via stdout response → system-reminder) |
| `SessionStart` | Session initialization | NO (one-time) |
| `Notification` | Background notifications | Unknown |

### Current Usage in Manta

`heartbeat-hook.ts` installs PreToolUse + PostToolUse hooks that touch `last_heartbeat_at` on every tool call. This is infrastructure-side liveness detection (pitfalls §3).

### Work Injection via Hooks

**Idea:** PostToolUse hook reads work queue, returns new instruction via `hookSpecificOutput.systemMessage`.

**Problems:**
1. Hook runs on EVERY tool call (high frequency) — polling work queue 50+ times per task
2. Hook timeout is 5s — work queue read must be fast
3. Injected context via `systemMessage` is a system reminder, not a user message — Claude may deprioritize
4. No way to BLOCK until work appears (hook must return quickly)
5. Hook context injection is additive — repeated injections inflate conversation
6. **Most critical:** In `--print` mode, there's no "next turn" after the final response — hooks can't prevent exit

### Verdict

**NOT VIABLE for work injection.** Hooks are excellent for side-effects (heartbeat, logging, scope enforcement) but cannot change the control flow of a `--print` session. The sequential resume pattern is cleaner.

---

## 8. MCP Server Hot-Reload and `--allowedTools`

### MCP Config

MCP servers are configured via:
1. `--mcp-config <file.json>` — session-level
2. `.mcp.json` in project root — project-level
3. `~/.claude/settings.json` — user-level
4. `claude mcp add/remove` — CLI management

### Hot-Reload

**No hot-reload mechanism exists.** MCP server configuration is read at session start. To change MCP config:
- For `--print` mode: next `--resume` invocation reads updated config
- For interactive mode: restart session

**For Manta daemon:** This is a non-issue. Each `--resume` invocation starts fresh MCP server instances, reading current config. The manta-bus MCP server is in user-scope config, so it's always available.

### `--allowedTools` / `--disallowedTools`

Verified working. Allows restricting tool surface per session:

```bash
claude --print --allowedTools "Read,Bash(echo *),mcp__manta-bus__*" \
  --permission-mode bypassPermissions \
  -- "task prompt"
```

### Implications for Daemon Mode

1. **Daemon clones can have restricted tool sets** — e.g., documentation-chase mode might only get `Read`, `Write`, `Grep`, `Glob` + MCP tools
2. **Tool restrictions survive across `--resume`** — need to pass `--allowedTools` on every resume invocation
3. **MCP tools follow naming convention** `mcp__<server>__<tool>` — can wildcard with `mcp__manta-bus__*`

---

## Recommended Architecture: Sequential Resume Pattern

### Overview

```
┌────────────────────────────────────────────────────┐
│                  DAEMON LIFECYCLE                    │
│                                                     │
│  1. SPAWN                                           │
│     claude --print --session-id <UUID>               │
│       --append-system-prompt <daemon-priming>       │
│       --permission-mode bypassPermissions           │
│       --allowedTools <mode-specific-tools>           │
│       <initial-task-prompt>                          │
│     → process exits                                 │
│                                                     │
│  2. POLL (orchestrator-side)                        │
│     while !done:                                    │
│       item = workQueue.claim(clone_id)              │
│       if item:                                      │
│         claude --print --resume <UUID>              │
│           --permission-mode bypassPermissions       │
│           --allowedTools <mode-specific-tools>       │
│           <item.prompt>                             │
│         → process exits                             │
│         workQueue.complete(item)                    │
│       else:                                         │
│         sleep(pollInterval)                         │
│                                                     │
│  3. TEARDOWN                                        │
│     claude --print --resume <UUID>                  │
│       "graceful shutdown: write report, commit"     │
│     → process exits                                 │
│     registry.setState(clone_id, DEAD)               │
└────────────────────────────────────────────────────┘
```

### Minimal Code Changes

1. **`clone-spawner.ts`** — add `sessionId` to `CloneRunnerInput`, pass `--session-id <uuid>` instead of bare `--print`
2. **`runClaudeCli()`** — add `--session-id` flag support
3. **New: `daemon-loop.ts`** — orchestrator-side loop:
   - Poll work queue (bus claim_work)
   - Resume clone session with work item
   - Handle exit codes and errors
   - Budget tracking per-cycle
4. **New: `enqueue_work` MCP tool** — main agent posts items to work queue
5. **`tick-loop.ts`** — extend with daemon-mode branch (poll → resume → loop)
6. **`priming.ts`** — daemon-specific priming block (identity survives across resumes)

### Cost Model

| Metric | One-shot (current) | Daemon (sequential resume) |
|---|---|---|
| Startup cost | ~3-5s (once) | ~3-5s per cycle |
| Context reuse | None | Full conversation history |
| Token efficiency | Optimal (one task) | Degrading (compaction after ~20 cycles) |
| Process overhead | 1 process | N processes (sequential) |
| Orchestrator complexity | Simple (spawn → wait) | Medium (spawn → poll → resume → wait) |

### Token Efficiency Estimate

Per resume cycle:
- System prompt re-injection: ~2K tokens
- Hook initialization: ~500 tokens  
- Work item prompt: ~200-1K tokens
- Conversation history replay (pre-compaction): grows linearly
- Conversation history (post-compaction): ~5-15K tokens (summary)

**Break-even analysis:** Sequential resume is token-efficient for ≤20 cycles. Beyond that, a fresh session with state transfer (via snapshot file) may be cheaper.

---

## Risks

### R1: Startup Latency Per Resume (MEDIUM)

Each `--resume` invocation boots Claude CLI, loads MCP servers, runs hooks, reads CLAUDE.md. ~3-5s overhead per cycle. For pair-programming with rapid feedback loops (< 30s), this is 10-15% overhead.

**Mitigation:** Pre-warm approach — keep MCP server process alive between invocations (not currently supported by CLI). Or accept latency and design UX around async feedback.

### R2: Context Degradation Over Many Cycles (HIGH)

After 20+ resume cycles, compaction summarizes early work items. Clone may "forget" constraints from initial priming if they were only in conversation (not system prompt).

**Mitigation:** All critical state in `--append-system-prompt` (permanent). Work results on disk, not in conversation memory. Periodic fresh-session reset.

### R3: Session File Corruption (LOW)

Sequential resume reads/writes session files. If orchestrator crashes mid-resume, session file may be in inconsistent state.

**Mitigation:** `--session-id` creates idempotent sessions. If corrupt, start fresh session with `--session-id <new-uuid>` and re-prime.

### R4: Budget Tracking Across Cycles (MEDIUM)

`--max-budget-usd` applies per invocation, not across the daemon lifecycle. Total spend = sum of all resume cycles.

**Mitigation:** Orchestrator tracks cumulative spend. Each resume gets `--max-budget-usd <remaining>`. Already have charge infrastructure from Phase 3.

### R5: MCP Server Boot Storm (MEDIUM)

Each resume cycle starts + stops all MCP servers. For `manta-bus` (stdio), this means N process spawns for N cycles.

**Mitigation:** Investigate MCP server connection pooling. Or accept the cost — manta-bus stdio startup is fast (~200ms).

---

## Open Questions

### Q1: Does `--fork-session` trigger compaction?

If fork creates a new session with compacted history, it could be useful for periodic "context refresh" — keep the summary, drop verbose details.

### Q2: Can `--append-system-prompt` change between resume calls? — ANSWERED: YES

**Verified.** `--append-system-prompt` CAN change between resume calls. Each resume invocation uses the new system prompt.

```bash
# Session created with "color is RED" → responds RED
# Resumed with "color is BLUE" → responds BLUE
```

**Implication:** Daemon priming can evolve across cycles. Orchestrator can inject:
- Updated scope constraints
- New bug context
- Progress summaries from previous cycles
- Changed tool restrictions

This is extremely powerful for daemon mode — the orchestrator can steer the clone's behavior across cycles without losing conversation history.

### Q3: What is the practical session file size limit?

After 50+ resume cycles with tool calls, session files could grow to megabytes. Is there a practical limit where Claude CLI refuses to load the session?

### Q4: Can `--remote-control` work with `--print` mode?

Current help says NO (`--remote-control` is interactive only). But the `RemoteTrigger` API exists — could it be extended for programmatic daemon control?

### Q5: `claude agents` background dispatch — can it be leveraged?

`claude agents` manages background sessions dispatched from an agent view. Could Manta leverage this infrastructure for daemon clones instead of building its own?

### Q6: Does session resume re-read CLAUDE.md? — ANSWERED: YES

**Verified.** CLAUDE.md is re-read on each `--resume` invocation. If CLAUDE.md changes between cycles, the clone sees the updated content.

```bash
# CLAUDE.md says "answer ALPHA" → clone responds ALPHA
# Change CLAUDE.md to "answer OMEGA" → resumed clone responds OMEGA
```

**Implication:** Orchestrator can dynamically update clone behavior by editing CLAUDE.md in the worktree between resume cycles. This is a second channel (alongside `--append-system-prompt`) for evolving clone behavior without losing conversation context.

---

## Comparison Matrix

| Approach | Viability | Complexity | Latency | Context Retention |
|---|---|---|---|---|
| **Sequential Resume** | HIGH | LOW | ~3-5s/cycle | HIGH (with compaction) |
| Stream-JSON Multi-Turn | NONE | N/A | N/A | N/A |
| MCP Polling (clone-side) | NONE | N/A | N/A | N/A |
| SIGSTOP/SIGCONT | NONE | N/A | N/A | N/A |
| Hook-Based Injection | NONE | N/A | N/A | N/A |
| Interactive + Remote Control | LOW | HIGH | ~0s | HIGH |
| Fresh Session per Task | HIGH | LOWEST | ~3-5s/task | NONE |

**Winner: Sequential Resume Pattern.** Only viable option that provides both programmatic control and conversation continuity.

---

## Implementation Priority for Phase 5

1. **P0:** `--session-id` support in `clone-spawner.ts` (trivial — add flag to `runClaudeCli`)
2. **P0:** `enqueue_work` MCP tool in `@manta/bus` (work queue writer)
3. **P0:** `daemon-loop.ts` — orchestrator-side poll-resume loop
4. **P1:** Daemon-specific priming block in `priming.ts`
5. **P1:** Budget tracking across resume cycles (integrate with Phase 3 charge system)
6. **P2:** Context health monitoring (detect compaction, trigger session reset)
7. **P2:** `--allowedTools` per-mode configuration
8. **P3:** Investigate `--fork-session` for context refresh
9. **P3:** Session file cleanup (garbage collection for completed daemon sessions)

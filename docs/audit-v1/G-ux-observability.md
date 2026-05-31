# Audit G — UX / Observability inside the Claude Code interface

**Status:** Research + design only. No code changed.
**Date:** 2026-05-30
**Question:** The user wants to *see* clones and cast progress **inside the Claude Code UI**, not by typing `manta status` in a terminal. Audits A–F ignored UX entirely. This doc establishes what Claude Code (CC) actually supports, designs the recommended surface, and gives an honest list of what CC simply cannot do (so we never promise a "button" that can't exist).

All CC-behavior claims below are grounded in the official docs fetched 2026-05-30:
- `https://code.claude.com/docs/en/statusline`
- `https://code.claude.com/docs/en/plugins-reference`
and cross-checked against an installed reference implementation: **SOMA** ships a command-type statusline (`soma-statusline`, wired into `~/.claude/settings.json`), confirming the mechanism works end-to-end in this environment.

---

## 0. TL;DR

- **There are no buttons / clickable panels / custom views in CC.** The entire plugin-author surface is: slash commands, skills, agents, hooks, MCP servers, LSP servers, **background monitors**, output styles, themes, and a **statusline** (via the plugin's root `settings.json`). The only "clickable" affordance is an **OSC 8 hyperlink** inside statusline text, and only in terminals that support it (iTerm2/Kitty/WezTerm — *not* macOS Terminal.app).
- **Recommended design = three layers, all of which CC genuinely supports:**
  1. **Conditional statusline** (Tier 0, the gap S-OBS11) — `manta statusline` reads `.manta/state/registry.json`, prints one compact line `🦈 A▶WORKING B▶WINDING_DOWN · $2.40/15 · 4m` when clones are live, **prints nothing when idle**. CC blanks the row on empty output, so "nothing when idle" is free. Auto-wired via the plugin's **root `settings.json`** (no user hand-editing).
  2. **`refreshInterval: 2`** in that same settings block so the line stays live **while the main session is idle waiting on clones** (the exact scenario the docs call out: "a coordinator waits on background subagents").
  3. **A detail slash command** `/manta:status` (already exists) for the on-demand deep view, plus the existing `/manta:tail` Tier 3 stream for "watch every move."
- **Optional, experimental:** a **plugin monitor** (`experimental.monitors`) that tails cast state transitions and pushes them to the agent as notifications — this is the closest CC has to a real-time push into the conversation, but it feeds *Claude*, not a visible UI widget.

---

## 1. Statusline — full mechanics (grounded)

### 1.1 How a command statusline runs

A `statusLine` of `type: "command"` runs a shell command. CC pipes a JSON blob to the command on **stdin**, captures **stdout**, and renders it as the bar at the bottom of the UI.

Key behaviors, verbatim from the docs:

- **Trigger / cadence:** "Your script runs after each new assistant message, after `/compact` finishes, when the permission mode changes, or when vim mode toggles. **Updates are debounced at 300ms.** … If a new update triggers while your script is still running, the in-flight execution is cancelled."
- **Idle gap (critical for Manta):** "These triggers can go quiet when the main session is idle, for example **while a coordinator waits on background subagents.** To keep time-based or externally-sourced segments current during idle periods, set `refreshInterval` to also re-run the command on a fixed timer." → `refreshInterval` minimum is `1` (seconds).
- **Empty output → blank row:** "Scripts that exit with non-zero codes or **produce no output cause the status line to go blank**." This is exactly the conditional-rendering behavior we want: idle = print nothing = no Manta row.
- **Multi-line:** "each `echo` or `print` statement displays as a separate row."
- **Colors / emoji:** ANSI escape codes supported; emoji render fine (docs' own examples use 📁 🌿 💰 ⏱️).
- **Clickable:** OSC 8 escape sequences make text Cmd/Ctrl-clickable, terminal-dependent.
- **Sizing:** the script cannot read `tput cols` (CC captures stdout); CC sets `COLUMNS`/`LINES` env vars instead (CC ≥ 2.1.153). Use those to truncate.
- **No token cost:** "The status line runs locally and does not consume API tokens."
- **Trust gate:** the command only runs after the workspace trust dialog is accepted (same gate as hooks). Otherwise CC shows `statusline skipped · restart to fix`.
- **Shares its row with system notifications** (MCP errors, auto-update, context-low) on the right side; on narrow terminals these can truncate our output. Keep it short.

### 1.2 stdin JSON the script receives

Relevant fields (full schema in the docs' "Available data" accordion):

```jsonc
{
  "session_id": "...",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/Users/.../manta",
  "model": { "id": "...", "display_name": "Opus 4.x" },
  "workspace": { "current_dir": "...", "project_dir": "...", "added_dirs": [] },
  "cost": { "total_cost_usd": 1.23, "total_duration_ms": 240000, "total_api_duration_ms": 2300 },
  "context_window": { "used_percentage": 42 }
  // rate_limits.* present only for Pro/Max after first API response
}
```

For Manta we ignore most of this — our state lives in `.manta/state/`, not in the CC blob. We only need `workspace.current_dir` (the repo root, to locate `.manta/`). We deliberately **do not** use CC's `cost.total_cost_usd` for the budget segment: that is the *main session's* CC cost, not the *cast's* spend. Manta's per-cast spend lives in `.manta/state/daily-spend.json` + budget cap in `.manta/config/budget.json` (see `packages/manta-cli/src/commands/cost.ts`).

### 1.3 Can a plugin auto-register a statusline? — YES (decisive finding)

This was the open question. Answer from the plugins-reference **Standard plugin layout**:

> `settings.json   # Default settings for the plugin`

A plugin ships a **root `settings.json`** that provides default CC settings. The statusline docs confirm specifically: *"Plugins can ship a default `subagentStatusLine` in their `settings.json`."* The same mechanism carries the top-level `statusLine`. So **Manta can auto-wire its statusline on install — the user does not hand-edit `~/.claude/settings.json`.**

Caveat (honest): a user's existing personal `statusLine` in `~/.claude/settings.json` (e.g. SOMA's `soma-statusline`, which this very environment has) takes precedence over a plugin-supplied default — user/project scope wins over plugin defaults. So on a machine that already has a statusline, Manta's will be shadowed. Mitigations, in order of preference:
1. Accept it: the plugin default fills the slot only for users who have none.
2. Offer an opt-in `/manta:statusline` slash command (or a `manta install --statusline` flag) that *additively* rewrites the user's statusline to chain both (call the user's previous command, then append Manta's line as a second row). This is what we'd document but **must not do silently** — overwriting a user's statusline is destructive.
3. The SOMA precedent shows the alternative path: SOMA is a `uv` tool that edits `~/.claude/settings.json` directly on install. We **reject** that for Manta — silently mutating user settings violates least-surprise; plugin-default `settings.json` is the clean path.

The reference `soma-statusline` is a thin Python entrypoint that reads a state file and prints one line, never crashing (`except: print("SOMA: --")`). Manta's script follows the same shape.

---

## 2. Interactive elements — what's possible vs not (be precise)

CC is a **terminal TUI**. The complete plugin-author component list (plugins-reference) is:

| Surface | What it is | Manta-relevant? |
|---|---|---|
| **Skills / commands** | `/name` slash entries, markdown-driven | Yes — `/manta:*` already shipped |
| **Agents** | subagents Claude can dispatch | Not for clones (clones ≠ subagents) |
| **Hooks** | shell on Pre/PostToolUse, Stop, etc. | Yes — used for git-lock, heartbeat |
| **MCP servers** | tools + resources | Yes — `manta-bus` |
| **LSP servers** | language servers | No |
| **Monitors** (experimental) | background command, each stdout line → notification to Claude | **Yes — best real-time push** (§4) |
| **Output styles** | response formatting presets | Marginal |
| **Themes** (experimental) | color palettes in `/theme` | No |
| **Statusline** | bottom bar, command-type | **Yes — Tier 0 (§1, §3)** |
| **`bin/`** | executables added to PATH | Yes — could expose bare `manta` |
| **`userConfig`** | values CC prompts user for on enable | Maybe — budget cap prompt |

**What does NOT exist in Claude Code (do not promise these):**

- ❌ **Buttons.** No clickable button widget of any kind.
- ❌ **Panels / sidebars / custom views / webviews.** CC has no plugin-rendered surface beyond the statusline text rows. (VS Code-style webview panels — the `vibearound`/`va-preview` MCP opens content in an *external browser*, not inside CC.)
- ❌ **Persistent custom UI region.** The statusline is the only persistent author-controlled region, and it's plain text rows sharing space with system notifications.
- ❌ **A "live dashboard" inside the conversation.** Anything "live" is either statusline text (auto-refreshing) or a monitor pushing notification lines into Claude's stream.
- ❌ **Modifying the conversation transcript UI** (no inline cards, no collapsible blocks authored by a plugin).

**The closest things to "a button":**

1. **OSC 8 hyperlink in the statusline** — e.g. wrap the cast id in a link to `manta inspect`'s output, or a `file://` to the post-mortem. Cmd/Ctrl-click. Terminal-dependent (no Terminal.app), and it opens a URL — it cannot run a `manta` command. So a hyperlink to a local HTML status page is feasible; a hyperlink that *executes* a clone action is not.
2. **An always-current statusline** so the user never needs to "press" anything — the info is just always there. This is the honest substitute for a button and what we recommend.
3. **A slash command** `/manta:status` / `/manta:tail` — the user types it, but it is the closest interactive "open the detail view" gesture.

---

## 3. Recommended design — conditional statusline + detail slash command

### 3.1 Layering (maps onto the spec's Tier ladder, Sec 11.0)

- **Tier 0 (the gap, S-OBS11):** conditional `manta statusline` — passive, always-on, shows *that* clones are alive and rough cost/age. This doc closes S-OBS11.
- **Tier 1:** `/manta:status` (exists) — compact table, on demand.
- **Tier 2:** `/manta:inspect <id>` (exists as CLI; surface a `/manta:inspect` command) — deep dive.
- **Tier 3:** `/manta:tail <id>` (exists as CLI) — live stream into chat.
- **Tier 4:** `/manta:replay` + `/manta:audit` (exist) — forensic.

The statusline is the **only** new surface needed; everything else is already built and just needs slash-command wrappers if not present (`status`, `cast`, `cost`, `kill`, `abort`, `promote`, `recover` exist under `commands/`; `inspect`/`tail`/`replay`/`audit` are CLI subcommands that could get thin command wrappers).

### 3.2 The `manta statusline` script — exact spec

**Invocation:** `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" statusline` (new CLI subcommand, sibling of `status`). Same bin as every other command — single code path, no re-implementation.

**Contract:**

- Reads stdin JSON, takes `workspace.current_dir` to resolve repo root. Falls back to `cwd`. (If neither resolves to a Manta repo, print nothing, exit 0.)
- Reads, lock-free and tolerating torn reads:
  - `.manta/state/registry.json` → `clones` map (`CloneRecord`: `clone_id`, `mode`, `state`, `last_heartbeat_at`, `session_mode`, `tasks_completed`).
  - `.manta/state/daily-spend.json` → `spent_usd`.
  - `.manta/config/budget.json` → `dailyCapUsd` (fallback default 15).
- **Conditional render:**
  - If `registry.json` is absent, unreadable, or contains **zero non-DEAD clones** → **print nothing, exit 0.** CC blanks the row. Manta is invisible when idle. (This is the whole point — no noise in normal solo work.)
  - Else build a single line.
- **Output format (one line, ≤ `COLUMNS` chars, truncate mid if needed):**

  ```
  🦈 A▶WORKING B▶WINDING_DOWN · $2.40/15 · 4m
  ```

  - **`🦈`** — Manta marker (matches plugin identity).
  - **Per live clone** `<short-id>▶<STATE>`, space-separated. `short-id` = last path segment of `clone_id` (e.g. `cast-…-A` → `A`). State is the raw `CloneState` (`STARTING`/`WORKING`/`BLOCKED`/`IDLE`/`WAITING_FOR_TASK`/`WINDING_DOWN`). DEAD clones are excluded. Append ` [daemon]` only if `session_mode === 'daemon'`. Cap at ~4 clones shown, then `+N` overflow.
  - **`· $2.40/15`** — `spent_usd` to 2dp `/` integer `dailyCapUsd`. (Cast-scoped spend if a single cast is live; daily otherwise — start with daily since that's what's persisted.)
  - **`· 4m`** — age of the **oldest** live clone: `floor((now - min(last_heartbeat_at? no → registered_at)) / 60000)m`. Gives "how long has this cast been running." Use a coarse `Xm` (or `Xs` under 1 min) — sub-second precision is noise.
- **Color (ANSI, optional, degrade gracefully):**
  - Any clone `BLOCKED` or heartbeat age > stale-threshold → red marker.
  - All `WORKING`/`STARTING` → green.
  - Any `WINDING_DOWN`/`IDLE`/`WAITING_FOR_TASK` and none blocked → yellow.
  - Budget segment: yellow ≥70% cap, red ≥90%.
- **Robustness (mirror SOMA):** never throw, never block. Wrap everything; on any error print nothing (not an error string) so the row simply stays blank. Must be fast (<50ms target; the docs cancel in-flight runs and a slow script causes stale output). Pure sync file reads, no network, no bus round-trip — read the JSON files directly (do **not** spin up the orchestrator/MCP for a statusline tick).
- **Exit code:** always 0 (non-zero → blank row, same as empty, but 0 is cleaner).

**Refresh:** the script is event-driven (after each assistant message, debounced 300ms) **plus** we set `refreshInterval: 2`. The interval matters because during a cast the main session is often *idle waiting* — without it the line would freeze at the last assistant turn and show stale states. 2s is a good balance (min is 1; 1s would re-spawn node twice as often for marginal gain).

### 3.3 Plugin auto-wiring (root `settings.json`)

Add a `settings.json` at the plugin root (`/Users/timur/projectos/manta/settings.json`, shipped in the marketplace tree):

```jsonc
{
  "statusLine": {
    "type": "command",
    "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs\" statusline",
    "refreshInterval": 2
  }
}
```

- `${CLAUDE_PLUGIN_ROOT}` is substituted by CC (confirmed supported in command/monitor/MCP fields).
- This is a **plugin default** — it fills the statusline slot only for users with none set, and never overwrites a user's existing personal statusline. Honest limitation, documented in §1.3.
- No `manta install` change is strictly required to wire the statusline for *plugin* users — it ships in the plugin tree. For *npm-CLI-only* users (no plugin), provide an explicit, **opt-in** `manta statusline --install` that prints (and, with confirmation, writes) the settings snippet. Never auto-mutate `~/.claude/settings.json`.

### 3.4 Detail / interaction commands

- `/manta:status` — already wired (`commands/status.md` runs the bin once, renders the table; explicitly tells Claude *not* to poll in a loop — good, matches the no-heartbeat-polling rule).
- Add thin command wrappers for `inspect`, `tail`, `replay`, `audit` (CLI subcommands already exist) so the Tier 2–4 surfaces are one keystroke away, matching the spec's ladder.
- The statusline's job is *awareness*; the slash commands are *drill-down*. That split is the realistic CC-native answer to "I want to see my clones."

---

## 4. Live progress while a cast runs — the smoothest "I can see my clones"

Ranked by smoothness vs. cost, all CC-native:

1. **Conditional statusline with `refreshInterval: 2`** *(recommended primary).* Always-current summary, zero user action, zero token cost, survives idle waits. This is the single highest-value addition — it's the missing Tier 0.
2. **Plugin monitor (`experimental.monitors`)** *(recommended secondary, experimental).* A monitor runs `manta` in a tail-loop; **each stdout line becomes a notification delivered to Claude**, so the *agent* learns of state transitions without polling — and can then surface them to the user in prose. This is the only CC mechanism that *pushes* cast progress into the conversation. Spec it to emit **only state transitions** (STARTING→WORKING→WINDING_DOWN→DEAD), never heartbeat ages — this exactly matches the project's `feedback-monitor-noise` and `feedback-no-heartbeat-polling` rules (≈3k tokens wasted per noisy cast). Requires CC ≥ 2.1.105; runs unsandboxed at hook trust level; interactive sessions only. Example entry:

   ```jsonc
   // monitors/monitors.json
   [{
     "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs\" tail --all --transitions-only",
     "description": "Manta cast state transitions",
     "when": "on-skill-invoke:manta-cast"
   }]
   ```

   Note: `manta tail` today is per-clone and time-boxed; a `--all --transitions-only` follow-mode would be new work. Listed as a design option, not a claim that it exists.
3. **`/manta:tail <id>`** *(exists).* On-demand live stream of one clone's events into chat. Best for "I want every move of clone A," costs context per line. Tier 3.
4. **Broadcasts (`manta_broadcast` / `manta_read_broadcasts`)** *(exists, bus-level).* Clones broadcast milestones; the main can read them. This is a *pull* the agent does, not a UI surface — useful inside reasoning, not a passive display.

**Recommendation:** ship (1) for passive awareness + keep (3) for deep watching. Treat (2) as a Phase-N experimental add once `tail --all --transitions-only` exists, because it's the only true push-into-conversation and it directly serves "smooth, no-polling" — but it's experimental and noisy if mis-specced.

---

## 5. What Manta has TODAY vs. the gap

### Built (verified in repo)

| Tier | Surface | Code |
|---|---|---|
| 1 | `manta status` → table of live clones, states, heartbeat age, locks, claims | `packages/manta-cli/src/commands/status.ts`, `output/status-table.ts`; `/manta:status` command |
| 2 | `manta inspect <id>` | `commands/inspect.ts`, `output/inspect-renderer.ts` |
| 3 | `manta tail <id> [seconds]` — polls `events.jsonl` by id-cursor, renders into chat | `commands/tail.ts`, `output/tail-formatter.ts` |
| 4 | `manta replay <cast-id>`, `manta audit <clone-id>` | `commands/replay.ts`, `commands/audit.ts` |
| — | `manta cost` — daily budget bar + per-cast spend | `commands/cost.ts` |
| — | Bus broadcasts | `manta_broadcast` / `manta_read_broadcasts` MCP tools |
| — | Event log (single source of truth) | `.manta/state/events.jsonl` |
| — | Forensic timeline snapshots | orchestrator `runCycle` → `ForensicTimelineWriter` |

State files the statusline would read (paths from `packages/manta-bus/src/state/paths.ts`):
- `.manta/state/registry.json` — clones map (`CloneRecord`).
- `.manta/state/daily-spend.json` — `spent_usd`.
- `.manta/config/budget.json` — `dailyCapUsd`.
- `.manta/state/events.jsonl` — append-only event stream (tail source).

### The gap to "visible in the CC interface"

- **Tier 0 statusline is NOT built.** The spec is explicit (Sec 11.0 ship-status note): *"Tier 0 (passive statusline) is NOT yet implemented in v1 … Tracked as S-OBS11."* Today, *every* observability surface is **pull**: the user (or agent) must run a command. Nothing is *passively visible* in the CC UI. A solo session running a cast shows **no indication** in the interface that clones are alive — you must `/manta:status`.
- **No auto-wiring.** Even the CLI surfaces require the user to know the commands. There is no plugin `settings.json` and no statusline entry in the plugin tree (`grep` of plugin dir: none).
- **MCP resources are unused for status** (§6) — the bus exposes tools, not resources.

Closing the gap = build the §3.2 `manta statusline` subcommand + ship the §3.3 plugin `settings.json`. That single addition moves Manta from "100% pull, invisible-when-idle-or-busy" to "passively visible whenever clones are live, silent otherwise."

---

## 6. MCP resources — can the bus surface clone status passively?

Question: can `manta-bus` expose clone status as an **MCP resource** that CC renders persistently?

Findings:
- MCP supports **resources** (addressable read-only content) in addition to tools. CC *can* consume MCP resources — they appear via `@`-mention / resource picker and can be referenced in prompts.
- **But CC does not render MCP resources persistently or as a live panel.** A resource is surfaced **on demand** — when the user (or Claude) references/reads it — not as an always-visible widget. There is no "subscribe this resource to a UI region" in CC's plugin model. The persistent surfaces are statusline + monitor notifications, both command-driven.
- So an MCP resource `manta://status` would be a *pull* surface equivalent to `/manta:status`, with worse ergonomics (it has to be fetched). It does **not** give passive visibility.

**Conclusion:** MCP resources are **not** the right tool for passive clone visibility. The statusline (passive, persistent) and monitors (push) are. An MCP resource could still be a *nice-to-have* for letting Claude pull a structured status object mid-reasoning without a Bash call, but that's an agent-ergonomics improvement, not a UX/visibility one. Low priority.

---

## 7. Honest limitations — what CC cannot do (do not promise)

1. **No buttons, no panels, no custom views, no webviews inside CC.** The statusline (plain-text rows) is the only persistent author region. Anything richer requires an external browser (the `vibearound` route), which is *outside* the CC interface and a separate product decision.
2. **A plugin-default statusline is shadowed by a user's existing personal statusline.** On machines with SOMA (or any custom statusline — including this dev box), Manta's line won't show unless we offer an explicit opt-in chain, which must be user-consented (never silent overwrite).
3. **Statusline shares its row with system notifications** and truncates on narrow terminals. Keep the line short; budget for `COLUMNS`-based truncation.
4. **Clickable hyperlinks are terminal-dependent** (no macOS Terminal.app, fragile under tmux/SSH) and can only open a URL, not run a Manta action. A "click to abort cast" button is impossible.
5. **Monitors are experimental** (schema may change), require CC ≥ 2.1.105, run unsandboxed at hook trust, and are interactive-session-only. They feed *Claude* (notifications), not a visible widget — the user sees the result only if Claude relays it.
6. **Statusline cannot reflect the *cast's* CC token cost** — `cost.total_cost_usd` in the stdin blob is the *main session's* cost. Manta cast spend must come from `.manta/state/daily-spend.json`. (Don't conflate the two in the line.)
7. **Trust gate:** statusline (and monitors/hooks) only run after the workspace trust dialog is accepted; first-run shows `statusline skipped · restart to fix`.
8. **Idle-freeze without `refreshInterval`:** the event-driven triggers go silent exactly when a cast is running and the main is waiting. `refreshInterval` is mandatory for Manta's use case, not optional polish.

---

## 8. Concrete next-actions (for a future implementation cast — not done here)

1. Add `statusline` subcommand to `packages/manta-cli/src/commands/` + bin dispatch in `packages/manta-cli/src/bin/manta.ts`. Pure sync reads of `registry.json` / `daily-spend.json` / `budget.json`; conditional empty output; never throws; <50ms. ≥80% test coverage (mirror existing `output/*.test.ts` table tests with empty/one/many/blocked/over-budget fixtures).
2. Ship plugin-root `settings.json` with the `statusLine` block (§3.3) + `refreshInterval: 2`. Verify it loads as a plugin default and does not clobber a user statusline.
3. Add thin `/manta:inspect`, `/manta:tail`, `/manta:replay`, `/manta:audit` command wrappers to round out the Tier ladder in the UI.
4. (Experimental, later) `manta tail --all --transitions-only` follow-mode + a `monitors/monitors.json` entry gated `on-skill-invoke:manta-cast`, emitting only state transitions (honor `feedback-monitor-noise`).
5. Update spec Sec 11.0 ship-status note: S-OBS11 designed (this doc); flip to "implemented" once (1)+(2) merge with the gate green.

— End of Audit G.

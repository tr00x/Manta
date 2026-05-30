# Manta — User Journey Audit (v1)

**Date:** 2026-05-30
**Auditor:** automated end-user simulation (read-only; nothing fixed)
**Repo under test:** `https://github.com/tr00x/Manta.git` (public), cloned fresh to `/tmp/mj`
**Environment:** macOS (Darwin 25.3.0), Node v22.22.1, real `claude` CLI present at `/Users/timur/.local/bin/claude`, Manta plugin already installed in this machine's Claude Code config as `plugin:manta:manta-bus`.

## TL;DR

The user's claim — *"absolutely nothing works, user can't even install"* — is **mostly FALSE for the read-only surface and FALSE for install, but TRUE for the headline feature (`cast`) when Manta is used as a plugin.**

- Clean `git clone` works. The published bundle (`dist/bin/manta.cjs`, `dist/bin/server.cjs`) runs with **zero `npm install` / `pnpm install` / build** — bundled deps are committed under `dist/node_modules/`. Every `--help`, every read-only stateful command (`status`, `cost`, `charges`, `recover`, `limit get`, `daemon status`, `library list/doctor`), `cast --dry-run`, and `install --dry-run` run cleanly.
- The MCP bus server starts as a stdio server on the clean clone and answers JSON-RPC `initialize` + `tools/list` (25 tools). No `MODULE_NOT_FOUND`.
- The **headline feature is broken for plugin users**: `manta cast` (real, not dry-run) aborts at preflight because it checks for an MCP server literally named `manta-bus`, but Claude Code namespaces the plugin's server to `plugin:manta:manta-bus`. The cast **burns a charge and writes a spend entry before aborting**. This is BLOCKER #1.
- Two documented install/repair commands point at a **file that does not exist** in the published artifact (`packages/manta-bus/dist/bin/server.cjs`). BLOCKER #2.
- `npx manta@latest install` resolves to an **unrelated squatted `manta` package on npm (v5.4.2)**, not this project. README hedges this but the real behavior is worse than "will fail". HIGH.
- Every error path leaks a **raw stack trace** to stderr after the friendly `[manta] …` line. MED (polish).

---

## Step 1 — Clean plugin install via git clone

### Command
```
cd /tmp && rm -rf mj && git clone -q https://github.com/tr00x/Manta.git mj && cd mj
```
Result: `CLONE_OK`. The committed `dist/` contains:
```
dist/bin/manta.cjs    (1,879,142 bytes, executable)
dist/bin/server.cjs   (798,043 bytes, executable)
dist/node_modules/    graceful-fs, proper-lockfile, retry, signal-exit
```
**Finding (POSITIVE):** the runtime deps that aren't bundled into the .cjs (native-ish / dynamic-require deps `proper-lockfile`, `graceful-fs`, `retry`, `signal-exit`) are committed under `dist/node_modules/`. So the bin runs with no install step — exactly the plugin model. Verified below: `status`/`recover` (which use `proper-lockfile`) work with no crash.

### `manta.cjs --help` — WORKS
```
$ node dist/bin/manta.cjs --help
Usage: manta [options] [command]
Manta — self-cloning Claude Code pattern (Phase 0)
... (full command list, 27 subcommands) ...
EXIT=0
$ node dist/bin/manta.cjs --version
0.1.0
```

### Every subcommand `--help` — WORKS (EXIT=0)
`status, cost, charges, recover, inspect, audit, replay, tail, kill, abort, promote, refresh, limit, daemon, retask, feedback, install, share, uninstall, library, cast` — all printed correct usage, all exit 0. No crashes.

### Read-only stateful commands in a git repo (`/tmp/gitrepo`, `git init`) — WORK
```
$ node dist/bin/manta.cjs status
[info] status clones=0 locks=0 claims=0
No active clones.

$ node dist/bin/manta.cjs cost
Daily budget: $0.00 / $50.00 (0%)
░░░░░░░░░░░░░░░░░░░░ 0%
...

$ node dist/bin/manta.cjs charges
Charges: 3 / 5
State: nominal
... mode availability table ...

$ node dist/bin/manta.cjs recover
Recovery complete: 0 dead clone(s) ...

$ node dist/bin/manta.cjs limit get        # full budget config table
$ node dist/bin/manta.cjs daemon status     # "No active daemon clones."
$ node dist/bin/manta.cjs library list      # "No library packages installed."
$ node dist/bin/manta.cjs library doctor    # "Healthy: 0 / Unhealthy: 0"
$ node dist/bin/manta.cjs abort             # "Aborted 0 clone(s)."
```
All correct.

### Non-git cwd (`/tmp/nogit`) — FRIENDLY ERROR + STACK LEAK (MED)
```
$ node dist/bin/manta.cjs status      # (and cost, charges, recover — identical)
[manta] invalid_input: not a git repo root: /private/tmp/nogit
[manta] cause: ENOENT: no such file or directory, access '/private/tmp/nogit/.git'
Error: ENOENT: no such file or directory, access '/private/tmp/nogit/.git'
    at async Object.access (node:internal/fs/promises:603:10)
    at async createRuntime (/private/tmp/mj/dist/bin/manta.cjs:41538:5)
    at async runWithRuntime (/private/tmp/mj/dist/bin/manta.cjs:50943:15)
    ... 4 more stack frames ...
EXIT=1
```
Exit code is correct (1) and the `[manta] invalid_input` line is good UX, but the **raw `Error: … at async …` stack trace is dumped to stderr on top of it**. Same on the git-repo "not found" paths (`inspect fake-clone`, `audit fake-clone`, `replay fake-cast`, `kill fake-clone`) — each prints the `[manta] not_found:` line then a full `BusNotFoundError: … at Registry.get (…manta.cjs:9533) …` trace. See Finding F-5.

---

## Step 2 — Plugin commands (`commands/*.md`)

There are 7 command wrappers; each shells out to the bundled bin:
```
abort.md   → node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" abort $ARGUMENTS
cast.md    → node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" cast $ARGUMENTS
cost.md    → node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" cost   (+ charges)
kill.md    → … kill $ARGUMENTS
promote.md → … promote $ARGUMENTS
recover.md → … recover
status.md  → … status
```
**Simulated with `CLAUDE_PLUGIN_ROOT=/tmp/mj` — all WORK (EXIT=0):**
```
$ CLAUDE_PLUGIN_ROOT=/tmp/mj node "$CLAUDE_PLUGIN_ROOT/dist/bin/manta.cjs" status   → "No active clones."
$ … cost     → "Daily budget: $0.00 / $50.00 (0%)"
$ … recover  → "Recovery complete:"
$ … abort    → "Aborted 0 clone(s)."
```
No command wrapper crashes. The wrappers are thin and correct. (`/manta:cast` is gated by the cast preflight bug — see Step 4.)

---

## Step 3 — The `.mcp.json` bus

`.mcp.json` launches:
```
sh -c 'exec node "${CLAUDE_PLUGIN_ROOT:-.}/dist/bin/server.cjs"'
```
That path (`dist/bin/server.cjs`) **exists** in the clone. JSON-RPC handshake on the clean clone (no node_modules beyond `dist/node_modules`):
```
$ printf '{"jsonrpc":"2.0","id":1,"method":"initialize",...}\n' | node dist/bin/server.cjs
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},
 "serverInfo":{"name":"manta-bus","version":"0.0.0"}},"jsonrpc":"2.0","id":1}
```
`tools/list` returned **25 tools** (`manta.register`, `manta.heartbeat`, `manta.lock`, `manta.broadcast`, `manta.zk_write`, … `manta.enqueue_work`). **No `MODULE_NOT_FOUND`, no crash.** POSITIVE.

Note: `serverInfo.version` is `0.0.0` (the monorepo root version), not `0.1.0` — cosmetic mismatch with the plugin version. LOW.

---

## Step 4 — A real cast end-to-end (THE HEADLINE FEATURE)

### `cast --dry-run` — WORKS
```
$ node dist/bin/manta.cjs cast recon-swarm --clones 1 --task "list files" --dry-run
[info] gate.dry_run mode=recon-swarm cloneCount=1 chargeCost=1 estimatedCost=1.5 ...
Dry run complete for cast cast-1780178936161. No clones spawned.
EXIT=0
```

### Real cast — **BLOCKER**. Aborts at MCP preflight + burns a charge.
```
$ cd /tmp/castrepo  # git repo with one commit
$ CLAUDE_PLUGIN_ROOT=/tmp/mj timeout 90 node dist/bin/manta.cjs cast recon-swarm \
    --clones 1 --task "list the files…" --tick-budget-ms 60000 --cycle-interval-ms 3000
[info] gate.committed cast=cast-1780178981500 charges=2 dailySpent=1.5 dailyRemaining=48.5
[manta] spawn_failed: manta-bus MCP server is not registered with Claude Code
  (`claude mcp get manta-bus` said: No MCP server found with name: "manta-bus".
   Configured servers: claude-peers, … plugin:manta:manta-bus, serena, vibearound).
  Run:
    manta install
  ...
```
**Note the contradiction in the error itself:** the configured-servers list it prints **contains `plugin:manta:manta-bus`** — the bus *is* registered, just under the plugin-namespaced name.

#### Root cause (confirmed in source)
`packages/manta-cli/src/commands/mcp-preflight.ts:37-41`:
```ts
const defaultRunner: ClaudeMcpRunner = () =>
  execa('claude', ['mcp', 'get', 'manta-bus'], { reject: false, timeout: PREFLIGHT_TIMEOUT_MS });
```
and the check at line 73: `if (result.exitCode !== 0 || !result.stdout.includes('manta-bus'))`.

`claude mcp get manta-bus` (bare name) **exits non-zero** when Manta is installed as a plugin, because the server is named `plugin:manta:manta-bus`:
```
$ claude mcp get manta-bus
No MCP server found with name: "manta-bus". Configured servers: …, plugin:manta:manta-bus, …
$ claude mcp get plugin:manta:manta-bus
plugin:manta:manta-bus:
  Status: ✓ Connected
  Type: stdio
  Command: sh
```
So **a user who installed Manta the documented plugin way (`/plugin install manta@manta`) can never run a real cast** — the preflight is hardcoded to the bare name. The only escape hatch is `manta install`, which registers a *second*, user-scoped server under the bare name `manta-bus` (verified via `install --dry-run`: it would run `claude mcp add -s user manta-bus -- node /tmp/mj/dist/bin/server.cjs`). That is an undocumented prerequisite for plugin users and is unintuitive (you installed the plugin, why must you also self-bootstrap?).

#### Secondary defect: **charge + spend burned on a preflight failure**
`gate.committed` ran (charges 3→2) *before* the preflight aborted. Verified after the failed cast:
```
$ node dist/bin/manta.cjs charges     → Charges: 2 / 5
$ ls .manta/state/   → charges.json, charges.log, daily-spend.json all written
```
So every failed cast attempt costs the user a charge and logs spend, despite spawning zero clones. The preflight should run *before* `gate.committed`, or refund on spawn failure. HIGH (couples to BLOCKER #1: a plugin user repeatedly hitting the name-mismatch drains charges to 0).

I did **not** run the real `install` (it mutates user-scope MCP config — out of audit scope; the auto-mode classifier correctly blocked it). Dry-run output proves the command is well-formed.

---

## Step 5 — Skills delivery to a spawned clone

The priming (`packages/manta-cli/src/spawner/priming.ts:7`) instructs the clone:
> `1. Use the Skill tool to load \`manta-as-clone\`.`

How the clone is launched (`clone-spawner.ts:281-302`, `runClaudeCli`):
```ts
execa(bin /* "claude" */, [
  '--print', ...sessionArgs, ...extraArgs,
  '--append-system-prompt', input.appendSystemPrompt,
  '--permission-mode', 'bypassPermissions',
  input.prompt,
], { cwd: input.cwd /* the git worktree */, env: {...} });
```
**Finding:** there is **no `--plugin-dir`, no `--mcp-config`, no settings injection that makes the Manta skills available to the clone's session.** The only file the spawner writes into the worktree's `.claude/settings.local.json` is a heartbeat hook (`heartbeat-hook.ts:59-83`) — it does not register skills or plugins.

Therefore `manta-as-clone` resolves **only if the spawning user has the Manta plugin installed globally** in their Claude Code config (skills/MCP inherited from the user's environment, since the clone's `claude --print` reads the user's `~/.claude`). The skill ships in the repo at `skills/manta-as-clone/SKILL.md` (8 KB, present), and the repo carries all 14 skills. So:
- **Plugin install path:** skill resolves (plugin globally installed → clone inherits it). OK *if* the user got past BLOCKER #1.
- **Bare `git clone` + run-the-bin path (no plugin install):** the clone's `claude --print` session has **no access** to `manta-as-clone`; the clone would hit "skill not found" on its first startup step. This is the runner-only path some power users would try, and it silently lacks skills. MED–HIGH (depends how the project intends bare-clone usage; docs imply plugin install is the supported path).

---

## Additional findings (docs / distribution)

### F-DOC-1 — repair commands point at a non-existent file. **BLOCKER #2**
Both `docs/user/getting-started.md` (step 2) and the cast preflight's own fallback hint tell the user to run:
```
claude mcp add -s user manta-bus -- node "$(pwd)/packages/manta-bus/dist/bin/server.cjs"
```
But in the published artifact **that file does not exist**:
```
$ ls packages/manta-bus/dist/bin/server.cjs
ls: packages/manta-bus/dist/bin/server.cjs: No such file or directory
$ ls packages/manta-bus/    # no dist/ at all — only src/, tests/, configs
```
The only server that exists is the **bundled** `dist/bin/server.cjs` (repo root). A user who follows the docs verbatim from a bare clone registers a path that will fail to start. The `.mcp.json` plugin path correctly uses `${CLAUDE_PLUGIN_ROOT}/dist/bin/server.cjs`, but the human-facing docs and the error-message fallback use the wrong per-package path.

### F-NPM-1 — `npx manta@latest install` runs someone else's package. **HIGH**
```
$ npm view manta version
5.4.2
```
`manta` on npm is an **unrelated package at v5.4.2** (this project is private `manta-monorepo`, plugin v0.1.0). The README (line 110) hedges *"until manta is live on npm, npx manta@latest will fail with 'could not determine executable'"* — but reality is worse: the name is taken, so `npx manta@latest install` would download and run a **stranger's `manta` package**, not Manta. The README lines 113 (`npx manta@latest install`) and 30 of getting-started (`npm i -g manta` / `manta install`) are actively misleading.

### F-5 — raw stack traces on every error path. **MED**
Covered in Step 1. Every `CliError` / `BusNotFoundError` prints the friendly `[manta] …` lines *and then* a full Node stack trace with absolute bundle paths and line numbers (`…/manta.cjs:9533:23`). For a "production-grade from day 1" CLI this is noise that leaks internals to end users.

### F-6 — `serverInfo.version: "0.0.0"`. **LOW**
The MCP server reports the monorepo root version `0.0.0` rather than the plugin's `0.1.0`. Cosmetic.

---

## Ranked BLOCKERS (things that stop a user cold)

| # | Severity | What stops the user | Evidence |
|---|----------|---------------------|----------|
| **1** | **BLOCKER** | **Plugin users can never run a real `cast`.** Preflight does `claude mcp get manta-bus` (bare name); the plugin registers `plugin:manta:manta-bus`, so preflight always fails with `spawn_failed`. The headline feature is unreachable via the documented `/plugin install` path without an extra, non-obvious `manta install` self-bootstrap. | `cast` real run aborts; `mcp-preflight.ts:37-41,73`; `claude mcp get manta-bus` exits non-zero while `plugin:manta:manta-bus` is ✓ Connected |
| **2** | **BLOCKER** | **Documented MCP-registration command points at a missing file.** `getting-started.md` step 2 and the cast error's own fallback both say `node "$(pwd)/packages/manta-bus/dist/bin/server.cjs"`, which doesn't exist in the published artifact. Following the docs from a bare clone yields a broken registration. | `ls packages/manta-bus/dist/bin/server.cjs` → No such file; only `dist/bin/server.cjs` exists |
| 3 | HIGH | **`npx manta@latest install` runs an unrelated npm package** (`manta` v5.4.2 is squatted by a third party). Docs present this as a supported install route. | `npm view manta version` → 5.4.2; README:110-113, getting-started:29-33 |
| 4 | HIGH | **Failed casts burn charges + log spend.** `gate.committed` (charges 3→2) fires before the preflight abort; no refund. Combined with BLOCKER #1, a plugin user drains charges to zero just retrying. | `gate.committed … charges=2` then `spawn_failed`; `charges` shows 2/5; `.manta/state/{charges,daily-spend}.json` written |
| 5 | MED | Every error dumps a raw Node stack trace (absolute bundle paths, line numbers) on top of the friendly message. | non-git `status`; `inspect/audit/replay/kill <nonexistent>` |
| 6 | MED | **Bare `git clone` + run-the-bin path has no skills.** A clone spawned without the plugin globally installed can't resolve `manta-as-clone` — the spawner passes no `--plugin-dir`/skill path, and the worktree only gets a heartbeat hook. | `clone-spawner.ts:281-302`; `heartbeat-hook.ts`; no `--plugin`/`--mcp-config` in spawn argv |
| 7 | LOW | MCP `serverInfo.version` is `0.0.0`, not the plugin's `0.1.0`. | `tools/list` handshake output |

## What actually works (so the "nothing works" claim is calibrated)

- `git clone` → run bundled bin with **no install/build**: works (deps committed in `dist/node_modules/`).
- All 27 subcommands' `--help`: EXIT=0.
- Read-only stateful commands in a git repo (`status`, `cost`, `charges`, `recover`, `limit get`, `daemon status`, `library list/doctor`, `abort`): correct output.
- All 7 `/manta:*` command wrappers (simulated with `CLAUDE_PLUGIN_ROOT`): EXIT=0.
- `cast --dry-run` and `install --dry-run`: correct.
- MCP bus server on the clean clone: initialize + 25 tools, no MODULE_NOT_FOUND.
- Skills ship in-repo (all 14, incl. `manta-as-clone`), and resolve for the clone **when the plugin is globally installed**.

The accurate statement is **not** "nothing works / can't install" — install and the entire read-only surface work. The truth is: **the one thing a user installs Manta to do — cast a clone — is blocked for the documented plugin install path (BLOCKER #1), and the repair docs point at a missing file (BLOCKER #2).**

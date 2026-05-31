# Audit H — Blind Spots

Classes the technical audit (A–F: install/cast/tests/bundling/benchmark) did not cover.
Research-only: findings + severity + fix direction. **No code changed.**

Date: 2026-05-30. Investigator: recon. Scope: `/Users/timur/projectos/manta` @ `0c6abe1`,
installed plugin state under `~/.claude/plugins`.

Severity scale: **P0** ships-blocker / data-loss / money / silent footgun the first user hits ·
**P1** real user pain, no data loss · **P2** rough edge / polish.

---

## TL;DR ranked

| # | Finding | Severity |
|---|---------|----------|
| 1 | **Dogfood collision** — `/manta:*` vanish when cwd = the repo (local marketplace name-collides with installed `manta@manta`) | **P0** (for maintainer/contributor) |
| 2 | **Clone has no hard guardrails** — `--permission-mode bypassPermissions` + scope fence is *priming-text only*; clone can `git push`, `rm -rf`, touch main tree, spend API $ unbounded per-call | **P0** |
| 3 | **`manta uninstall` only removes library *packages*, not the plugin/Manta itself** — worktrees, bus MCP registration, `~/.claude` plugin state, charges ledger all orphaned. No uninstall path for Manta proper. | **P1** |
| 4 | **Error UX leaks raw Node stack traces** — top-level catch prints `cause.stack` / unexpected-error `stack` to stderr | **P1** |
| 5 | **Cross-platform: Windows is dead on arrival**; Linux mostly OK with caveats (`sh -c` MCP wrapper, `/tmp` realpath, SIGTERM/KILL) | **P1** (Win) / **P2** (Linux) |
| 6 | **First-run onboarding is doc-dependent** — nothing surfaces in-session after install; no `/manta:` welcome, no `manta init`/`manta doctor` discoverability | **P2** |
| 7 | **Multi-project concurrency is actually isolated** (per-repo `.manta/state`), with two narrow footguns (cwd≠repoRoot fallback; shared global `~/.claude/.../library` index) | **P2** |

---

## 1. DOGFOOD COLLISION — `/manta:*` disappear when cwd = the Manta repo (P0)

### What happens (verified earlier)
Fresh CC session started from `/tmp` → 7 `/manta:*` commands present.
Session started with cwd = the Manta repo → **zero** `/manta:*` commands.

### Root cause (now nailed down)
The repo is **both** an installed plugin **and** a self-declaring local marketplace, with the
**same name on both sides**:

- Installed globally (works from anywhere else):
  - `~/.claude/plugins/known_marketplaces.json` → marketplace `manta`, `source: git`, url `https://github.com/tr00x/Manta.git`, `installLocation: ~/.claude/plugins/marketplaces/manta`
  - `~/.claude/plugins/installed_plugins.json` → `manta@manta` (scope user), cache `~/.claude/plugins/cache/manta/manta/0.1.0`
  - `~/.claude/settings.json` → `enabledPlugins["manta@manta"]: true` and `extraKnownMarketplaces.manta` (git url)
- In the repo working dir:
  - `/Users/timur/projectos/manta/.claude-plugin/marketplace.json` declares a marketplace **named `manta`** containing a plugin **named `manta`** — `source: url` → same git url
  - `/Users/timur/projectos/manta/.claude-plugin/plugin.json` declares plugin `manta`

When CC boots with cwd inside the repo it discovers the cwd's `.claude-plugin/marketplace.json`
as a **directory/local marketplace source named `manta`**. That name collides with the
already-registered remote `manta` marketplace (different source: local-dir vs git-url). This is
the exact upstream bug class:

- **Name-collision flakiness**: CC's plugin resolver keys on plugin *name*, not the
  `name@marketplace` qualifier, so two `manta` marketplaces fight (same upstream class that breaks
  `superpowers` when it's in two marketplaces — obra/superpowers#355).
- **Directory-marketplace commands not discovered**: even when a directory-source marketplace is
  loaded, its **slash commands silently don't register** while skills do — confirmed upstream bug
  **anthropics/claude-code#14929** ("Commands from directory-based local marketplaces not
  discovered"). Symptom there is *identical* to ours: plugin shows enabled, commands absent.

Net: in the repo, CC binds the `manta` plugin to the *local directory* source (cwd wins / collides),
and the directory-source path doesn't surface commands → `/manta:*` gone. Skills (and the
`manta-bus` MCP via the project `.mcp.json`) survive because they take different discovery paths.

This is **inherent current CC behavior**, not a Manta bug we can fix in our own code paths — but it
**is avoidable by repo layout / naming**.

### Recommendation (concrete, ranked)

**A. Make the local marketplace name unique so it can't collide with the installed `manta`.**
Rename the *marketplace* in `.claude-plugin/marketplace.json` (the top-level `"name"`) to something
like `manta-dev` while keeping the *plugin* `name: "manta"`. The remote install stays `manta@manta`;
the cwd-discovered marketplace becomes `manta-dev`, so no same-name collision. (Plugin name still
matches the installed one, so verify CC doesn't then double-bind — test both orderings.) Cheapest
change, highest leverage; try first.

**B. If A still loses commands (because #14929 kills *directory*-source commands regardless of
name), the supported workaround is to NOT rely on cwd discovery for the maintainer:**
work on Manta from a **sibling directory** and load the source checkout explicitly:
```
claude --plugin-dir /Users/timur/projectos/manta      # documented in README line 104
```
`--plugin-dir` loads the plugin as a *plugin-dir* source (not a directory-*marketplace*), which is
the code path that DOES surface commands. This is the definitive, works-today escape hatch. The cost
is you can't have both "cwd = repo" and "`/manta:*` available" simultaneously via the installed
plugin until #14929 is fixed upstream.

**C. Decouple dev-checkout from installed plugin entirely:** when hacking on Manta, *disable* the
installed `manta@manta` (set `enabledPlugins["manta@manta"]: false`) and use `--plugin-dir .`. No
two sources, no collision. Document this as the maintainer workflow.

**D. (Defensive, doesn't fix the collision but reduces confusion):** add a `manta doctor` /
`/manta:status`-adjacent check that detects "cwd is the Manta repo AND plugin installed" and prints
the explanation + the `--plugin-dir` workaround, so a contributor isn't mystified.

**Definitive statement:** we **cannot** make the installed-plugin `/manta:*` commands appear while
cwd = the repo *and* the same-named local marketplace is auto-discovered, because (a) CC resolves
plugins by bare name → collision, and (b) directory-marketplace command discovery is broken upstream
(#14929). The robust fix is **A (rename the local marketplace)**; the guaranteed fallback is
**B/C (`--plugin-dir` from outside, or disable the installed copy)**. This should be written into
`README` and `docs/internals/plugin-packaging.md` as a known limitation with the workaround.

### Evidence
- `~/.claude/plugins/known_marketplaces.json:43-50` (marketplace `manta`, git source)
- `~/.claude/plugins/installed_plugins.json:83-92` (`manta@manta` user-scope)
- `~/.claude/settings.json` `enabledPlugins."manta@manta": true`, `extraKnownMarketplaces.manta`
- `/Users/timur/projectos/manta/.claude-plugin/marketplace.json` (marketplace **name: "manta"**, plugin **name: "manta"**)
- `/Users/timur/projectos/manta/.claude-plugin/plugin.json` (plugin name `manta`)
- Upstream: anthropics/claude-code#14929 (directory-marketplace commands not discovered); obra/superpowers#355 (same-name multi-marketplace flakiness)

---

## 2. Clone has no HARD guardrails — bypassPermissions + soft scope fence (P0)

### What a clone can actually do
Clones are launched by `runClaudeCli` / `runClaudeResume` with:
```
claude --print ... --append-system-prompt <priming> --permission-mode bypassPermissions <prompt>
```
(`packages/manta-cli/src/spawner/clone-spawner.ts:309-322` and `:369-388`)

`bypassPermissions` means **no per-tool permission gating** — the clone can run any Bash command, any
file write, network calls, etc., with zero prompts.

The only things presented as "guardrails" are **soft priming text** (`spawner/priming.ts`):
- "stay inside `taskContract.scope.allowedPaths` and outside `forbiddenPaths` (which always includes
  `.manta/state` and `secrets/`)" (`priming.ts:11`)
- "NEVER modify source files in packages/" (`priming.ts:70`)
- "Forbidden: recursive `/manta cast`, edits outside scope, direct user contact, quiet writes to
  `.manta/state/*`" (`priming.ts:17`)

Per the project's own HARD RULE (`CLAUDE.md` "Skill/priming/enforcement"), priming text is a **soft
prior, not a hard contract**. So **none of the scope fence is enforced**. The clone is *asked* to
stay in scope; nothing stops it from leaving.

### The one real hard hook only covers test-storm git
`installGitLockHook` writes a PreToolUse hook into the worktree's settings — but:
- It is installed **only when `castMode === 'test-storm'`** (`clone-spawner.ts:160-163`).
- It blocks **only git-mutating Bash commands** when the `GIT_OPERATIONS` lock isn't held
  (`hooks/git-lock-hook.ts:33-63`). It does **not** look at scope/allowedPaths at all.

So for `recon-swarm`, `forking-realities`, `bug-hunt`, `doc-chase`, `pair`, daemon, etc., there is
**no PreToolUse hook at all** — a clone runs fully unfenced.

### Concrete gaps
- **Main working tree:** clones get an isolated *worktree* (good — separate checkout), but the
  worktree **shares the same `.git`** (`git worktree add -b <branch> <wt> HEAD`,
  `spawner/worktree.ts:76`). A clone with bypassPermissions can `git checkout main`, force-push,
  delete branches, or `git -C <main repo path> ...` directly — nothing blocks cross-tree git.
- **`git push`:** no guardrail. A clone could push to origin. The orchestrator/cast layer never
  denies push.
- **Arbitrary commands / `rm -rf`:** unrestricted.
- **Money:** budget is a **pre-spawn USD estimate** + a **tick-budget** that aborts the cast *after*
  the fact; `--force` bypasses the daily cap (`cast.ts:277`, `--no-charge-check` at `:275`). There is
  no per-call/per-token hard ceiling enforced inside the clone — a runaway `claude --print` burns
  tokens until the tick budget reaper notices. Budget is *accounting*, not a *circuit breaker* at the
  API boundary.
- **`.manta/state` / `secrets/`:** "forbidden" only in priming; not hook-enforced for the clone.
  (Note: the *bus MCP server* does path-guard its own writes — `memory-writers.ts:66`,
  `state/paths.ts` reject traversal — but that protects bus-mediated writes, not raw Bash the clone
  runs.)

### Severity rationale
This is the gap most likely to bite a *trusting* user: "Manta clones write code on isolated branches"
implies sandboxing that isn't there. A misled or adversarial transcript could make a clone push, wipe
files, or spend unbounded API budget. P0 because it's money + data-loss + a trust-violating surprise.

### Fix direction
- Move scope enforcement from priming into a **PreToolUse hook** installed for *every* clone (not
  just test-storm), denying Bash/Write/Edit that touch paths outside `allowedPaths` ∪ inside
  `forbiddenPaths`. This is exactly what `CLAUDE.md` prescribes (hard invariant → PreToolUse hook).
- Block `git push` and cross-tree git (`git -C <not-my-worktree>`) in that hook unless an explicit
  capability is granted.
- Consider dropping `bypassPermissions` for an explicit allow-list permission mode, or at minimum
  gate it behind a capability flag per mode.
- Hard token/$ ceiling at the runner (kill the child at N tokens / $X), not only the post-hoc tick
  reaper.

### Evidence
- `packages/manta-cli/src/spawner/clone-spawner.ts:309-322,369-388` (`bypassPermissions`)
- `packages/manta-cli/src/spawner/clone-spawner.ts:160-163` (git-lock hook only for test-storm)
- `packages/manta-cli/src/hooks/git-lock-hook.ts:33-63` (only git-mutating, only lock check)
- `packages/manta-cli/src/spawner/priming.ts:11,17,70` (scope = soft text)
- `packages/manta-cli/src/spawner/worktree.ts:76` (shared `.git`)
- `packages/manta-cli/src/commands/cast.ts:275,277` (`--no-charge-check`, `--force` past cap)

---

## 3. Uninstall/cleanup leaves orphans — and there is NO uninstall for Manta itself (P1)

### What `manta uninstall` actually does
`runUninstallCommand` (`commands/uninstall.ts`) uninstalls a **Manta *library package***
(`@manta-library/foo`) from the Phase-7 library system. It:
1. resolves the package in the local-store index,
2. checks no live clone is using its modes,
3. `fs.rm` the install dir,
4. drops the local-store index entry,
5. drops the lockfile entry.

It does **not** touch: worktrees under `.manta/worktrees/`, the bus MCP registration, registry/charges
state, `~/.claude` plugin install, or daemon processes. That's fine — it's scoped to packages — but
it means **there is no command that uninstalls Manta the plugin and cleans up its footprint.**

### Orphans left after "removing Manta" (uninstalling the plugin via `/plugin`)
A user who does `/plugin uninstall manta@manta` (or deletes the marketplace) is left with:
- **`.manta/` in every repo they cast in** — `worktrees/`, `snapshots/`, `state/` (registry.json,
  charges.json, charges.log, daily-spend.json, locks, claims, casts, contracts, events.jsonl),
  `graveyard/`. None of this is cleaned. Worktrees are real git worktrees → also leave
  `.git/worktrees/...` entries and `manta/cast-*` branches behind.
- **Charges ledger** (`.manta/state/charges.json` + `charges.log`) persists per repo.
- **Library installs** under the global local-store (see #7) — `manta uninstall` is per-package; a
  blanket removal isn't offered.
- **Bus MCP registration** — lives in the project `.mcp.json` (committed to the repo) and/or
  `~/.claude` plugin state; uninstalling the plugin doesn't strip the repo's `.mcp.json`.
- **Daemon clones** — if a daemon cast is running, nothing reaps it on plugin removal.

### Severity
P1: no data loss for the user's own code (worktrees are isolated), but "I removed Manta" leaves a
litter of `.manta/`, dangling git worktrees/branches, and a stale `manta-bus` entry in `.mcp.json`
that will error on next session ("bus MCP failed to start" if the bundle is gone).

### Fix direction
- Add `manta clean` / `manta uninstall --all` (or document `manta recover --purge`) that:
  prunes all `.manta/worktrees/*` via `git worktree remove`, deletes `manta/cast-*` branches,
  removes `.manta/state` + `.manta/snapshots` + graveyard, and strips the `manta-bus` server from
  the repo `.mcp.json`.
- Plugin removal can't run our code automatically, so document a one-liner cleanup in the README
  "uninstall" section (currently absent).

### Evidence
- `packages/manta-cli/src/commands/uninstall.ts` (entire file — library-package scope only)
- `packages/manta-bus/src/state/paths.ts:34-55` (everything under `<repo>/.manta/state`)
- `packages/manta-cli/src/spawner/worktree.ts:76` (real git worktrees + branches)
- `/Users/timur/projectos/manta/.mcp.json` (committed bus registration, not auto-removed)

---

## 4. Error UX — raw Node stack traces leak to the user (P1)

Most typed command errors are clean `[manta] <kind>: <message>` lines (good — install/share/uninstall
all do `process.stderr.write('[manta] ...: ...')`). **But the top-level catch in `bin/manta.ts`
dumps stack traces:**

- `bin/manta.ts:1028-1029` — for a `CliError` with a `cause`, it writes `[manta] cause: ...` then
  `if (cause.stack) process.stderr.write(cause.stack)`. Any cast/spawn/orchestrator failure that
  wraps a `cause` (e.g. execa ENOENT when `claude` isn't on PATH, a bus ENOENT, a git failure)
  prints the **full Node stack**.
- `bin/manta.ts:1034-1036` — the unexpected-error branch (`exitCode 99`) writes
  `[manta] unexpected error: <msg>` then the full `stack`.
- `bin/manta.ts:1046-1049` — `unhandledRejection` similarly surfaces a raw message + exit 99.

### Worst offenders a real user hits
1. **`claude` not on PATH** → `runClaudeCli` execa fails → wrapped as `spawn_failed` CliError with an
   execa `cause` → top-level prints the execa stack. First-time CLI users (npm path) hit this
   immediately.
2. **Not a git repo** is handled cleanly (`runtime.ts:65`), but **bus server missing/`.cjs` not
   built** → ENOENT cause → stack.
3. **Any orchestrator/recovery internal throw** without a typed kind → exit 99 + stack.

### Severity
P1: not data loss, but a stack trace is the canonical "this is alpha and broken" signal to a new user;
the audit (D) already flagged this surface.

### Fix direction
- In the top-level catch, print `cause.message` (one line) and gate `cause.stack` behind
  `MANTA_DEBUG`/`--verbose`. Same for the unexpected-error and unhandledRejection branches.
- Map common execa errors (ENOENT for `claude`, for `git`) to a friendly `[manta]` hint
  ("`claude` not found on PATH — install Claude Code or pass --claude-bin").

### Evidence
- `packages/manta-cli/src/bin/manta.ts:1023-1049`

---

## 5. Cross-platform — Windows DOA, Linux mostly OK (P1 Win / P2 Linux)

The audit was macOS-only. Scan results:

### Windows — broken, multiple reasons
- **MCP server command is `sh -c`** in both the project and plugin `.mcp.json`:
  `command: "sh", args: ["-c", "exec node \"${CLAUDE_PLUGIN_ROOT:-.}/dist/bin/server.cjs\""]`.
  `sh`, `exec`, and `${VAR:-default}` expansion don't exist on stock Windows → **bus MCP won't
  start on Windows.** (Files: `/Users/timur/projectos/manta/.mcp.json`,
  `~/.claude/plugins/marketplaces/manta/.mcp.json`.)
- **Slash command bodies invoke `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" ...`** — relies on
  shell `${}` expansion in the Bash tool; on Windows shells this won't expand the same way.
  (`commands/cast.md:11`, all `commands/*.md`.)
- **SIGTERM→SIGKILL kill ladder** (`clone-spawner.ts:235-243`, `cast.ts:839,995`): Windows Node maps
  `process.kill('SIGTERM')` to an immediate hard terminate — the graceful window is a no-op, and
  signal semantics differ. Bus server's `SIGTERM`/`SIGINT` handlers (`bus/bin/server.ts:61-66`) won't
  fire the same way.

### Linux — works with caveats
- `sh -c` exists on Linux → bus MCP starts. ✔
- `os.tmpdir()` used for install workdir (`install.ts:173`) — fine. ✔
- **`realpath` symlink canonicalisation** is heavily relied on (`session-fork.ts:44`,
  `graveyard.ts`, `recover.ts:45`) to reconcile macOS `/tmp ↔ /private/tmp`. On Linux `/tmp` isn't a
  symlink, so it's a no-op — harmless. But note `docs/zk/macos-realpath-breaks-published-bin-path-assertions-*`
  exists (untracked) flagging realpath fragility around published bin paths — worth a Linux re-test.
- `path.sep`-aware code (`dir-digest.ts:12`, `share/*`, `bundle-assembler.ts`) normalizes to `/` for
  manifests — good cross-platform hygiene. ✔
- **`parent-pid.ts:8` uses `process.kill(pid, 0)`** for liveness — works on Linux; on Windows
  signal 0 semantics differ (another Windows hazard).

### Severity
- **Windows: P1** — bus MCP and command invocation both fail; effectively unsupported. Either declare
  Windows unsupported explicitly (README) or replace `sh -c` with a portable launcher (`node` direct
  with an env-resolving shim, or a `.cmd`/cross-spawn wrapper).
- **Linux: P2** — likely works; needs an actual Linux smoke test of cast + bus + recover to confirm
  the realpath assumptions hold.

### Fix direction
- Replace the `sh -c "exec node ..."` MCP command with a direct `node` invocation; resolve
  `CLAUDE_PLUGIN_ROOT` default inside the JS entry instead of in shell. (`exec`/`${:-}` are the only
  reason `sh` is there.)
- Test cast lifecycle on Linux CI; declare Windows status in README.

### Evidence
- `/Users/timur/projectos/manta/.mcp.json` (`sh -c` / `${CLAUDE_PLUGIN_ROOT:-.}`)
- `commands/*.md` (`node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs"`)
- `packages/manta-cli/src/spawner/clone-spawner.ts:235-243`
- `packages/manta-bus/src/bin/server.ts:61-66`
- `packages/manta-orchestrator/src/parent-pid.ts:8`

---

## 6. First-run onboarding — nothing surfaces in-session (P2)

After `/plugin install manta@manta`, a brand-new user gets (within the first minute):
- 7 `/manta:*` commands with decent one-line `description`s + `argument-hint`s (good — discoverable
  via `/` menu). `commands/*.md` frontmatter is solid.
- The `manta-bus` MCP server auto-registers (per README).
- **No welcome message, no `/manta:help`, no `manta init`/`manta doctor`** — there is no command that
  explains "what now." `cast.md` says "the core verb" but nothing nudges the user to it.
- The npm path has a **landmine documented but not guarded**: README line 110 warns `npx manta` hits
  an *unrelated* package ("could not determine executable") — the real package is `@tr00x/manta`,
  unpublished at audit time. A user following muscle memory (`npx manta`) gets a confusing failure
  from someone else's package.
- `docs/user/getting-started.md` exists (README links it) but the user must leave the session to read
  it.

### Severity
P2: the `/` menu descriptions carry most of the weight, so it's not opaque — but there's no in-product
"start here," and the `npx manta` namespace collision is a real first-minute trap.

### Fix direction
- Add a `/manta:help` (or make `/manta:status` print a "no casts yet — try `/manta:cast ...`" hint
  when empty).
- README: lead the install section with the *working* path and a copy-paste first cast; bold the
  `npx manta` ≠ us warning earlier (it's currently at line 110).
- Consider a one-time post-install notice (skill or command) pointing at getting-started.

### Evidence
- `commands/*.md` frontmatter (good descriptions)
- `/Users/timur/projectos/manta/README.md:84-119` (install paths; `npx manta` warning at :110)
- no `help`/`init`/`doctor` command in `commands/`

---

## 7. Multi-project / concurrent — isolated, with two footguns (P2)

### Good news: state is per-repo
All bus/registry/charges/locks/claims state is rooted at `<repoRoot>/.manta/state`
(`packages/manta-bus/src/state/paths.ts:34-55`). The bus MCP server resolves its root from
`MANTA_REPO_ROOT` (set by the spawner per cast, `clone-spawner.ts:168`) and the CLI runtime resolves
`repoRoot` from the invocation (`runtime.ts:57`). So running Manta in **two different repos
simultaneously**:
- Two separate `manta-bus` server processes (one per CC session, each its own cwd/root).
- Two separate `.manta/state` trees → registry, charges, daily-spend, locks **do not collide**. ✔
- Charges/daily-cap are **per repo**, not global — see footgun B.

### Footgun A — `MANTA_REPO_ROOT` unset → falls back to `process.cwd()`
`bus/bin/server.ts:36-38`: if `MANTA_REPO_ROOT` is unset the server uses `process.cwd()`. When CC
starts the `manta-bus` MCP server itself (project `.mcp.json`, not via the spawner), `MANTA_REPO_ROOT`
is **not set** → root = CC's cwd. If the user launches CC from a subdirectory of the repo, the bus
writes `.manta/state` into that subdir, **split-brain** from the repo-root state the CLI uses. The CLI
runtime requires `<root>/.git` to exist (`runtime.ts:63`) so it anchors at repo root; the bus does
*not* walk up to `.git`. Mismatch possible.

### Footgun B — library local-store is **global, shared across all repos**
The Phase-7 library install index/local-store (used by `manta install`/`uninstall`) is not under
`<repo>/.manta`; it's a single global store (under `~/.claude` / a home-dir local-store — see
`library/local-store.ts`, `library/lockfile.ts`). So installed library *packages* and the lockfile
are **shared** across every repo. Two repos installing different versions of the same
`@manta-library/foo` will contend on one global index/lockfile (the uninstall `uninstall_ambiguous`
path at `uninstall.ts:149-155` exists precisely because multiple versions can coexist globally).
Concurrent installs from two CC sessions race on that shared lockfile (it uses proper-lockfile, so
they serialize rather than corrupt — but cross-repo coupling is surprising).

### Severity
P2: the common case (cast/status/cost) is correctly isolated per repo. The footguns are edge cases
(launching from a subdir; concurrent library installs) and the second is mitigated by file locking.

### Fix direction
- Make the bus server walk up to the nearest `.git` when `MANTA_REPO_ROOT` is unset, matching the CLI
  runtime — so the project-`.mcp.json` launch can't split-brain from a subdir.
- Document that the library store is global by design (it's a shared package cache); confirm the
  lockfile serialization is enough for concurrent installs (looks OK).

### Evidence
- `packages/manta-bus/src/state/paths.ts:34-55` (per-repo state)
- `packages/manta-bus/src/bin/server.ts:36-38` (cwd fallback)
- `packages/manta-cli/src/runtime.ts:57-65` (CLI anchors at `.git`)
- `packages/manta-cli/src/spawner/clone-spawner.ts:168` (`MANTA_REPO_ROOT` set per cast)
- `packages/manta-cli/src/commands/uninstall.ts:149-155` (multiple global versions)
- `packages/manta-cli/src/library/local-store.ts`, `library/lockfile.ts` (global store)

---

## Sources (upstream CC behavior)
- [anthropics/claude-code#14929 — Commands from directory-based local marketplaces not discovered](https://github.com/anthropics/claude-code/issues/14929)
- [obra/superpowers#355 — install flaky due to name collision across marketplaces](https://github.com/obra/superpowers/issues/355)
- [Discover and install prebuilt plugins through marketplaces — Claude Code Docs](https://code.claude.com/docs/en/discover-plugins)

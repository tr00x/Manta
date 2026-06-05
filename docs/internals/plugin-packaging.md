# Plugin packaging — how Manta ships as a Claude Code plugin

**Status:** shipping in v1. The plugin packaging mechanics below were verified against live Claude Code
plugins and the official plugin docs.

## Why a plugin (not just npm)

Slash commands (`/manta:*`) and user-visible skills are **architecturally impossible** via an npm CLI —
only the Claude Code plugin mechanism delivers them (verified against live `superpowers` / `claude-mem`
plugins, and against the official docs at code.claude.com/docs/en/plugins). The plugin is a thin
packaging wrapper around the **existing** tsup bundle + skills; it is not a rewrite. npm and plugin
coexist: npm is the terminal / power-user path, the plugin is the in-Claude-Code discoverability path.

## Layout decision: repo root IS the plugin root

There were two viable shapes — a dedicated `plugin/` subdir, or the repo root itself. **We chose repo
root = plugin root.** Rationale:

- **Single source of truth.** The repo's existing `skills/` (16 dirs) and `commands/` are the plugin's
  skills/commands *in place* — no copying, no drift. Claude Code auto-discovers `skills/`, `commands/`,
  `.mcp.json`, `hooks/` from the plugin root by convention (there is **no `contributes` block** in
  `plugin.json`).
- **Sidesteps the symlink/duplication trap.** A `plugin/` subdir would force either copying the 16
  skills into `plugin/skills/` (drift + blows the task's file-change budget) or symlinking — and
  symlinks to a sibling are *skipped* under `claude --plugin-dir` (only dereferenced on marketplace
  install), so local testing would silently lose skills. Repo-root avoids all of it.
- **Empirically verifiable** with the official local-test flow: `claude --plugin-dir .` and
  `claude plugin validate .`.

Cost: a marketplace install copies the whole repo into the plugin cache (heavier than a curated
payload subdir). Acceptable for v1; a future optimization could carve out a payload subdir.

## What ships (anchored on `${CLAUDE_PLUGIN_ROOT}`)

| Artifact | Path | Purpose |
|---|---|---|
| Plugin manifest | `.claude-plugin/plugin.json` | name `manta`, version, description, author, repo, license, keywords. No `contributes`. |
| Marketplace catalog | `.claude-plugin/marketplace.json` | single-plugin catalog; marketplace `name` = `manta-dev` (deliberately *not* `manta` — see "dogfood collision" below); plugin `name` = `manta`, `source` = `{ "source": "url", "url": "https://github.com/tr00x/Manta.git" }` (see "source field" below). |
| MCP server | `.mcp.json` | `manta-bus` stdio runs a tiny `sh -c` shim that resolves `${CLAUDE_PLUGIN_ROOT:-.}/dist/bin/server.cjs` (falling back to a cwd `dist/`, which `manta install` writes), errors loudly if it is missing, then `exec node` on it. Auto-registers on enable — no `claude mcp add`. |
| Slash commands | `commands/{cast,status,inspect,tail,replay,promote,recover,kill,abort,doctor,help}.md` | thin Bash wrappers → `node ${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs <cmd>` (`help` is static text, no binary call — every other command shells the bin). Auto-namespaced to `/manta:*`. The CLI stays the single code path. |
| Skills | `skills/*/SKILL.md` | surfaced to the user's session AND resolvable by spawned clones (heals `spawner/priming.ts`'s previously-dead skill refs). |
| Hooks | `hooks/hooks.json` | convention-discovered at the plugin root. Wires four `${CLAUDE_PLUGIN_ROOT}/dist/bin/*.cjs` hooks: SessionStart→`manta-session-priming.cjs`, UserPromptSubmit→`manta-prompt-router.cjs`, PreToolUse(`manta_cast`/`Bash`)→`manta-skill-gate.cjs`, PostToolUse(`Skill`)→`manta-skill-mark.cjs`. |
| Status line | root `settings.json` | Tier 0 conditional statusLine → `node ${CLAUDE_PLUGIN_ROOT}/dist/bin/manta-statusline.cjs`. |
| Bundle | `dist/bin/{manta,server,manta-statusline,manta-session-priming,manta-prompt-router,manta-skill-gate,manta-skill-mark}.cjs` + vendored `dist/node_modules/` (proper-lockfile + graceful-fs + retry + signal-exit) | committed self-contained bins + runtime deps (see "the bundle must be committed"). |

## The bundle must be committed (plugins don't build on install)

A plugin installs by **git clone** into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` with
**no `npm install` and no build step**. Two consequences:

1. **Everything `${CLAUDE_PLUGIN_ROOT}`-anchored must be committed to git.** The bundle therefore lives
   at the repo-root `dist/`, which `.gitignore` normally ignores — a directory-negation exception
   (`!/dist/`, `!/dist/bin/`, `!/dist/node_modules/**`) re-includes the whole plugin payload: all seven
   `dist/bin/*.cjs` and the vendored `dist/node_modules/` tree. (The named `!/dist/bin/manta.cjs` /
   `server.cjs` lines are belt-and-suspenders; the `!/dist/bin/` directory negation already tracks every
   file under it.)
2. **The bundle must be fully self-contained.** The npm `manta` package keeps third-party deps external
   (npm resolves them); a plugin has no `node_modules`. So there is a **second** tsup config —
   `packages/manta-cli/tsup.plugin.config.ts` with `noExternal: [/.*/]` — that inlines every *inlinable*
   runtime dep across **seven** entrypoints (`manta`, `server`, `manta-statusline`,
   `manta-session-priming`, `manta-prompt-router`, `manta-skill-gate`, `manta-skill-mark`). Its output
   (`packages/manta-cli/plugin-dist/`, git-ignored) is copied to `dist/bin/` by `scripts/build-plugin.mjs`.
   The npm build (`tsup.config.ts`) is untouched, so the install-from-tarball e2e test stays valid.
3. **Runtime deps that escape tsup are vendored on disk.** `proper-lockfile` is reached via a dynamic
   `require.resolve('proper-lockfile')` (and the generated lock touch-script `require`s it from a *separate*
   node process), so tsup cannot inline it. `scripts/build-plugin.mjs` therefore copies `proper-lockfile`
   + its runtime tree (`graceful-fs`, `retry`, `signal-exit`) into `dist/node_modules/`, which node
   resolves from `dist/bin/*.cjs`. Without this every lock-using subcommand crashes
   `Cannot find module 'proper-lockfile'` on a fresh plugin clone.

Release step: `pnpm build && pnpm build:plugin`, then commit `dist/` (`bin/` + `node_modules/`).

## marketplace.json `source` field

`claude plugin validate` **rejects `"source": "."`** (`Invalid input`). The form Manta ships for a
plugin whose payload is its own repo root is the explicit git-url source:

```json
{ "name": "manta", "source": { "source": "url", "url": "https://github.com/tr00x/Manta.git" }, "version": "0.1.0" }
```

The github shorthand (`{ "source": "github", "repo": "tr00x/Manta" }`) and relative-path sources
(`"./plugin"`, `"./plugins/x"`) are also valid forms, but relative paths require the payload to live in
that subdir. We use the git-url form because the payload is the whole repo root and it matches the
`/plugin marketplace add https://github.com/tr00x/Manta.git` install line below.

## Install (verified against current Claude Code docs)

```
/plugin marketplace add https://github.com/tr00x/Manta.git
/plugin install manta@manta-dev
/reload-plugins
```

The install spec is `<plugin>@<marketplace>`. CC keys the marketplace by the top-level `name` in
`marketplace.json` (→ `manta-dev`) and the plugin by `plugins[].name` (→ `manta`), so the install
reference is `manta@manta-dev`. Verified against the real install state:
`~/.claude/plugins/known_marketplaces.json` keys marketplaces by name, and
`~/.claude/plugins/installed_plugins.json` keys installs as `<plugin>@<marketplace>`.

Local dev (no marketplace): `claude --plugin-dir .` from the repo root; `claude plugin validate .` to
check the manifest. These argument strings are confirmed against code.claude.com/docs/en/discover-plugins;
if a build differs, run `/plugin` and follow the in-app flow rather than guessing.

## Dogfood collision — `/manta:*` vanish when cwd = the Manta repo

**Symptom.** Start Claude Code with cwd inside this repo and the `/manta:*` slash commands disappear,
even though the plugin shows enabled. Start it from any other directory and the commands are present.

**Root cause (upstream CC, [#14929](https://github.com/anthropics/claude-code/issues/14929)).** When
cwd is inside the repo, CC auto-discovers the repo's own `.claude-plugin/marketplace.json` as a
*directory-source* marketplace. Two upstream behaviors then bite:

1. **Name collision.** CC's plugin resolver keys on the bare plugin name, not the `name@marketplace`
   qualifier. If the cwd marketplace shares a name with an already-registered remote marketplace, the
   two fight (same class as obra/superpowers#355). This is why the marketplace is named **`manta-dev`**,
   not `manta`: the installed remote marketplace is `manta`, so a differently-named local marketplace
   can't name-collide with it. (The *plugin* stays `manta` so the install spec is stable.)
2. **Directory-marketplace commands don't register (#14929).** Even with the name collision removed,
   CC's directory-source code path surfaces *skills* and the MCP server but **silently drops slash
   commands**. This is an upstream bug Manta cannot fix in its own code.

**Net.** Renaming the marketplace to `manta-dev` removes the name collision (and is verified by
`claude plugin validate .`), but cwd = repo *and* the installed `manta` plugin still cannot both
surface `/manta:*` until #14929 ships upstream, because the directory-source path drops commands
regardless of name.

**Contributor workarounds (work today):**

- **Sibling-dir + `--plugin-dir`** — loads the checkout via the *plugin-dir* source (not a directory
  *marketplace*), which is the code path that DOES surface commands:
  ```
  cd /some/other/dir && claude --plugin-dir /path/to/Manta
  ```
- **Disable the installed copy** — in `~/.claude/settings.json` set
  `"enabledPlugins": { "manta@manta-dev": false }`, then launch with `claude --plugin-dir .` from the
  repo root. One source, no collision.
- The bundled **`manta` CLI** (and `manta doctor`) works regardless of cwd — only the *slash command*
  surface is affected.

## The `proper-lockfile` runtime-dep escape (closed by vendoring)

The MCP `server.cjs` is fully standalone (verified: boots + answers `tools/list` with no `node_modules`).
The command bin `manta.cjs` has a dynamic `require.resolve('proper-lockfile')` that escapes the tsup
bundle (and the generated lock touch-script `require`s `proper-lockfile` from a *separate* node process),
so lock-using commands (`cast`/`abort`/`kill`/`recover`) cannot rely on the inlined bundle alone. This
was a publish-blocker for the command path; it is now **closed** by vendoring `proper-lockfile` + its
runtime tree (`graceful-fs`, `retry`, `signal-exit`) into the committed `dist/node_modules/` (see
"the bundle must be committed", point 3). Node resolves them as siblings of `dist/bin/*.cjs`, so a fresh
plugin clone runs every subcommand without an `npm install`.

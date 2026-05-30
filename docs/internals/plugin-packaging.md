# Plugin packaging — how Manta ships as a Claude Code plugin

**Status:** v1 (RB#3, 2026-05-30). Decision recorded in `docs/release-v1-board.md` "RB#3 — DECISION";
mechanics reverse-engineered in `docs/audits/2026-05-30-plugin-distribution-mechanics.md`.

## Why a plugin (not just npm)

Slash commands (`/manta:*`) and user-visible skills are **architecturally impossible** via an npm CLI —
only the Claude Code plugin mechanism delivers them (verified against live `superpowers` / `claude-mem`
plugins, and against the official docs at code.claude.com/docs/en/plugins). The plugin is a thin
packaging wrapper around the **existing** tsup bundle + skills; it is not a rewrite. npm and plugin
coexist: npm is the terminal / power-user path, the plugin is the in-Claude-Code discoverability path.

## Layout decision: repo root IS the plugin root

There were two viable shapes — a dedicated `plugin/` subdir, or the repo root itself. **We chose repo
root = plugin root.** Rationale:

- **Single source of truth.** The repo's existing `skills/` (13 dirs) and `commands/` are the plugin's
  skills/commands *in place* — no copying, no drift. Claude Code auto-discovers `skills/`, `commands/`,
  `.mcp.json`, `hooks/` from the plugin root by convention (there is **no `contributes` block** in
  `plugin.json`).
- **Sidesteps the symlink/duplication trap.** A `plugin/` subdir would force either copying the 13
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
| Marketplace catalog | `.claude-plugin/marketplace.json` | single-plugin catalog; plugin `source` = `{ "source": "github", "repo": "manta-pattern/manta" }` (see "source field" below). |
| MCP server | `.mcp.json` | `manta-bus` stdio = `node ${CLAUDE_PLUGIN_ROOT}/dist/bin/server.cjs`. Auto-registers on enable — no `claude mcp add`. |
| Slash commands | `commands/{cast,status,abort,cost,kill,promote,recover}.md` | thin Bash wrappers → `node ${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs <cmd>`. Auto-namespaced to `/manta:*`. The CLI stays the single code path. |
| Skills | `skills/*/SKILL.md` | surfaced to the user's session AND resolvable by spawned clones (heals `priming.ts`'s previously-dead skill refs). |
| Bundle | `dist/bin/{manta.cjs,server.cjs}` | committed self-contained bins (see "the bundle must be committed"). |

`hooks/hooks.json` is intentionally **not** shipped: heartbeat is implicit on every `manta.*` bus call
(bus auto-touch), and the bus registers via `.mcp.json` — no user-scope hook is needed for plugin users.

## The bundle must be committed (plugins don't build on install)

A plugin installs by **git clone** into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` with
**no `npm install` and no build step**. Two consequences:

1. **Everything `${CLAUDE_PLUGIN_ROOT}`-anchored must be committed to git.** The bundle therefore lives
   at the repo-root `dist/bin/`, which `.gitignore` normally ignores — a precise exception tracks
   exactly `dist/bin/manta.cjs` and `dist/bin/server.cjs`.
2. **The bundle must be fully self-contained.** The npm `manta` package keeps third-party deps external
   (npm resolves them); a plugin has no `node_modules`. So there is a **second** tsup config —
   `packages/manta-cli/tsup.plugin.config.ts` with `noExternal: [/.*/]` — that inlines every runtime
   dep. Its output (`packages/manta-cli/plugin-dist/`, git-ignored) is copied to `dist/bin/` by
   `scripts/build-plugin.mjs`. The npm build (`tsup.config.ts`) is untouched, so the install-from-tarball
   e2e (RB#2 Chunk 4) stays valid.

Release step: `pnpm build && pnpm build:plugin`, then commit `dist/bin/`.

## marketplace.json `source` field

`claude plugin validate` **rejects `"source": "."`** (`Invalid input`). The verified-valid form for a
plugin whose payload is its own repo root is the explicit github source:

```json
{ "name": "manta", "source": { "source": "github", "repo": "manta-pattern/manta" }, "version": "0.1.0" }
```

Relative-path sources (`"./plugin"`, `"./plugins/x"`) are also valid but require the payload to live in
that subdir. We use the github form because the payload is the repo root.

## Install (verified against current Claude Code docs)

```
/plugin marketplace add manta-pattern/manta
/plugin install manta@manta
/reload-plugins
```

Local dev (no marketplace): `claude --plugin-dir .` from the repo root; `claude plugin validate .` to
check the manifest. These argument strings are confirmed against code.claude.com/docs/en/discover-plugins;
if a build differs, run `/plugin` and follow the in-app flow rather than guessing.

## Known gap

The MCP `server.cjs` is fully standalone (verified: boots + answers `tools/list` with no `node_modules`).
The command bin `manta.cjs` has a dynamic `require.resolve('proper-lockfile')` that escapes the bundle, so
lock-using commands (`cast`/`abort`/`kill`/`recover`) still need `node_modules` at runtime — **bug #65**,
a publish-blocker for the command path, root-caused to `@manta/bus` runtime (out of RB#3 scope → RB#4).

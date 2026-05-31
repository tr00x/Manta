# Last-gasp report — clone-B (cast-1780189047825, bug-hunt: SLASH PARITY)

## Summary

Task complete. Added 4 thin `/manta:*` slash wrappers for read/diagnostic CLI subcommands that
previously had no in-session surface — `doctor`, `inspect <cloneId>`, `replay <castId>`, `charges` —
each mirroring the exact pattern of the existing `commands/*.md` (frontmatter `name: manta:<x>`,
`argument-hint`, `allowed-tools: Bash`, a single `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs" <cmd>
$ARGUMENTS` shell block, and a one-line "what to do with the output" note). Refreshed `commands/help.md`
to list all 13 slash commands and added an explicit "Terminal-only commands" line for the power-user /
destructive subcommands (daemon, retask, feedback, install/uninstall, share, library, limit, refresh,
cleanup, audit) that deliberately have no slash. Updated the two command-count tests:
`packages/manta-e2e/tests/preflight.test.ts` (9→13 commands) and
`packages/manta-skill-validator/tests/integration.test.ts` (sorted slash list now includes charges,
doctor, inspect, replay). Verified all four CLI subcommands exist and confirmed their argument shapes
by reading `packages/manta-cli/src/bin/manta.ts` (read-only) before writing wrappers — no invented
commands. `pnpm gate` is GREEN: typecheck + lint passed (fail-fast reached tests), 1600 passed /
7 skipped, including both target tests (`manta-e2e/preflight` and `manta-skill-validator/integration`).

Files changed: 7 (within scope cap of 10) — 4 new command files, help.md, 2 test files. Stayed inside
`commands/` + the two test dirs; touched no src/cast.ts/orchestrator/.mcp.json/statusline.

## Pending items

- None. Task fully delivered and gated green.

## Notes for main

- A fresh worktree had no `node_modules` and unbuilt cross-package dist — had to `pnpm install` +
  `pnpm -r build` before `pnpm gate`'s `tsc -b` could resolve `@manta/bus` / `@manta/orchestrator` /
  `@manta/skill-validator` type declarations. This is build-order, not a code defect.
- The CLI package's published name is `@tr00x/manta` (seen in vitest project labels), but the bundled
  binary path referenced by the slash commands stays `${CLAUDE_PLUGIN_ROOT}/dist/bin/manta.cjs` per the
  existing command pattern — left unchanged.

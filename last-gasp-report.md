# Last-Gasp Report — clone A — cast-1780257722556

**Mode:** bug-hunt (task was actually a FEATURE)
**Task:** Add user-facing MCP tools to the `@manta/bus` MCP server so an orchestrator
can drive Manta with native tool calls instead of shelling out to `/manta:*`.
**Outcome:** ✅ Complete. Full `pnpm gate` green. One feature, committed on this branch.

---

## Symptom (the user's ask)

> «почему все наши команды сделаны под shell? в клод коде нет команд нормальных и рабочих»

The `/manta:*` slash commands all route through `Bash` → `node manta.cjs <cmd>`. The
orchestrator gets no structured, programmatic tool surface.

## Findings

1. **`@manta/bus` does NOT depend on `@manta/cli`** (confirmed: grep clean, package.json
   clean). The reverse holds. So a bus-side tool **cannot** import `runCastCommand` —
   that is a circular dependency. The only clean seam is spawning the `manta` CLI
   **binary** as a child process. Locked architecture honoured.

2. **CLI flag audit** (`packages/manta-cli/src/bin/manta.ts`):
   - `cast <mode>`: `--task`, `-n/--clones`, `--max-parallel-clones`, `--max-casts-per-hour`,
     `--max-tokens-estimate`, `--max-files-changed`, `--allowed-paths` (**CSV**),
     `--forbidden-paths` (**CSV**), `--dry-run`. **No `--cast-id` flag** and **no `--json`**.
   - `status`, `cost`, `charges`, `kill`, `abort`: **no `--json`** → return raw text.
   - `inspect <id>`: **has `--json`** + `--events <n>`.
   No flags invented.

3. **ROOT-CAUSE SURPRISE — `manta cast` is BLOCKING.** `runCastCommand`
   (`packages/manta-cli/src/commands/cast.ts`) runs the full orchestrator tick-loop
   until every clone is DEAD or the tick budget (~25 min) elapses. It does **not**
   fork-and-return as the task contract assumed. Worse, the cast id is generated
   **internally** (`cast-${Date.now()}`) and printed to **stdout only at completion**.
   Blocking an MCP tool call for 25 minutes is unacceptable.

   **Mitigation (implemented):** `spawnCast` runs the child **non-blocking** and scans
   its **STDERR** for the early `cast.spawn ... worktree=…/clone-cast-<ts>-<CLONE>`
   reporter line, extracting the cast id via `/cast-\d{10,}/`. It resolves the tool call
   the moment the cast id appears (`launched:true`), then `unref()`s the child so the
   orchestrator keeps running in the background. Dry-runs / validation errors print to
   stdout / exit before any clone spawns, so they fall through to the child-exit path
   and return full output + exit code (`exited:true`).

## What shipped

- **`packages/manta-bus/src/tools/user-tools.ts`** (new) — `resolveMantaCliBin`
  (env → sibling `manta.cjs` → PATH), `runCliCapture` (fast terminating commands),
  `spawnCast` (non-blocking launch + id extraction), Zod input schemas, `buildCastArgv`
  (pure, tested), and `createUserTools()` returning the 6 tool entries with rich JSON
  Schemas.
- **`packages/manta-bus/src/server.ts`** — widened `ToolEntry.inputSchema`, spread the
  6 user tools into the table, added them to `CALLER_FIELDS_BY_TOOL` as `null`
  (main-driven → no auto-touch) via `USER_TOOL_NAMES` (drift guard).
- **Tools** (registered `manta.cast/status/cost/inspect/abort/kill`; surface to the
  orchestrator as `manta_*`).
- **Tests** — `tests/tools/user-tools.test.ts` (resolution, argv mapping, real-spawn
  against `tests/helpers/fake-manta.cjs` stub, non-blocking launch, MCP registration +
  schema, validation envelope, circular-dep guard); `tests/server.test.ts` updated to
  31 tools.
- **Docs** — `docs/user/mcp-tools.md` (new) + pointer section in `getting-started.md`.
- **Skill** — `skills/manta-orchestrate/SKILL.md` notes the native tools.

## Acceptance — verified

- `pnpm gate` (typecheck + lint + test): **GREEN**. `Test Files 183 passed | 7 skipped`,
  `Tests 1667 passed | 9 skipped` (skips are pre-existing, env-gated e2e — not mine).
- New tools in the bus tool list: asserted (server.test.ts → 31, user-tools.test.ts).
- Stub-binary test proves `manta_cast {mode,task,clones}` → correct argv + returns stdout.
- No `@manta/cli` import in `@manta/bus`: grep clean + a regression test guards the import.

## Naming decision (for the curator)

Registered with the **dot** prefix (`manta.cast`, …) to match the existing 25
clone-coordination tools (all dot-prefixed); the MCP client surfaces them as
`manta_cast`, … (dots → underscores in the tool-call namespace). This satisfies both
"prefixed `manta_`" and "match the clone-coordination tool naming".

## Cross-layer dependencies / follow-ups

- The `manta-orchestrate` skill line 25 still says "`manta cast` forks the orchestrator"
  — that is **inaccurate** (it blocks). Out of my scope to fix the skill's cast wording,
  but worth a curator pass. The non-blocking behaviour now lives correctly at the
  `manta_cast` **tool** layer regardless.
- A future, cleaner fix would add a `--cast-id` flag to `manta cast` (so the id is known
  before launch) — but that touches `@manta/cli` (out of this clone's scope).

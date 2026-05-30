# Manta v1 — Master Blocker List (full audit synthesis, 2026-05-30)

Synthesized from 6 parallel audits (A user-journey, B crutches/mocks, C bundling, D CLI, E cast-reliability, F benchmark-design). Each finding has evidence in its source report (`docs/audit-v1/{A..F}-*.md`). Ranked by "blocks the goal: real user casts end-to-end, zero crutches/mocks, then publish."

## Reality check
The user's "absolutely nothing works / can't even install" is **partly miscalibrated**: clean `git clone` install + the entire read-only surface (status/cost/charges/help, MCP bus, all wrappers) WORK (audit A, verified). The vendored `proper-lockfile` fix is **complete and correct** (audit C, verified — no whack-a-mole left). BUT the **headline feature (cast) is genuinely dead for plugin users**, there are real **NaN-guard-disarm bugs**, a real **fake gate test**, and **`manta` is squatted on npm**. So: not "nothing works" — but "the thing it's FOR doesn't work for an installed user, and there are real integrity holes."

## BLOCKERS (must fix before the goal is met)

| # | Blocker | Evidence | Fix direction |
|---|---------|----------|---------------|
| B1 | **Plugin users can NEVER cast** — `mcp-preflight.ts:37-41,73` runs `claude mcp get manta-bus` (bare), but the plugin registers `plugin:manta:manta-bus` → always `spawn_failed`. | A-1 | Preflight must accept the plugin-scoped name (probe `plugin:<mp>:manta-bus` / list-and-match, not bare-name-only). |
| B2 | **#66 clones reaped before first heartbeat** — `clone-spawner.ts:117-125` pre-registers `STARTING` with `registered_at=now` BEFORE `runner.run` (:159); `death-detector.ts:27-33` measures `now-registered_at`; no early "booting" heartbeat → `claude --print` cold-start + `--resume` replay blows the 300s grace. Kills casts late in a session. | E | Start the grace clock at process LAUNCH not register; emit an early "booting" heartbeat the instant the child spawns; and/or raise default startup grace. |
| B3 | **`manta` is squatted on npm (v5.4.2)** — `npx manta@latest install` runs an unrelated package. Cannot publish as `manta`. | A-3 | Rename the npm package to a scoped name (`@tr00x/manta`) or unique unscoped name; update bin/docs/marketplace. |
| B4 | **Fake gate test (nayobka)** — `merge-review-collector.test.ts` mocks execa to always `{exitCode:0}`; `runTests` always returns true; RED path (tsc errors, test fail, install reject) NEVER exercised. The scorer that gates merges is untested for failure. | B-F1 | Add RED-path tests (non-zero typecheck→tscErrors≥1; test fail→testsPassed false; install reject→prepareWorktreeForGate resolves). |
| B5 | **`share --version 1.0.0` silently no-ops** — global `-V/--version` intercepts the space-form, prints 0.1.0, exits 0, share action never runs. | D-F6 | Rename share's flag (e.g. `--pkg-version`) or detach from global version; the publish command must not silently succeed. |
| B6 | **NaN disarms money/timing guards (bug #60)** — `--daily-cap-usd` (manta.ts:183 raw parseFloat), `--budget-per-cast-usd`, `--budget-per-clone-usd`, `--cycle-interval-ms`, `--tick-budget-ms` all accept NaN/negative → `spend > NaN` always false → budget ceiling silently off. Fix pattern (`parsePositiveIntOption`) exists in-tree, not applied. | D-F1/F2, B | Apply validating coercers (add `parsePositiveFloatOption`) to all money/timing flags; reject NaN/negative at the CLI boundary. Tests per flag. |
| B7 | **Docs point at a nonexistent file** — getting-started step 2 + cast error fallback tell users to register `$(pwd)/packages/manta-bus/dist/bin/server.cjs` which is NOT in the published artifact (only bundled `dist/bin/server.cjs`). | A-2 | Fix the path in docs + the cast error fallback message. |
| B8 | **Failed casts burn charges, no refund** — `gate.committed` fires (charges decremented, spend logged) before preflight aborts; a plugin user (hit by B1) drains charges to zero just retrying. | A-4 | Commit the charge only after preflight passes / spawn succeeds; or refund on preflight abort. |

## HIGH (fix for a credible v1)
- **H1** real-claude e2e suites `console.warn(SKIPPED); return` → pass with ZERO assertions when `claude` absent; green CI ≠ real gate ran. (B-F2)
- **H2** `promote.ts` (destructive: graveyard move + worktree rm) has ZERO tests. (B-F3)
- **H3** `tail` doesn't stream (buffers to end), NaN duration runs forever, sub-10s clamped silently. (D-F5)
- **H4** #64 worktree path letter-scoped (not cast-scoped) at all call sites; data-loss guard fails-OPEN (`catch{return false}`→git error treated as clean→`rm -rf`); TOCTOU. (E)
- **H5** #65 `manta abort` has no process handle (only markDead); reaper never kills an OS process; `proc.kill` reaps only direct `claude` child, not its subtree. (E)
- **H6** bare-clone runner passes no skill path (`clone-spawner.ts:281-302`) → `manta-as-clone` resolves only if plugin globally installed → clones may run without discipline. (A-6)

## MED / LOW
- raw stack traces on routine errors (non-git cwd, not-found IDs) on top of friendly `[manta]` line (A-5, D-F7). promote exit-99 vs typed exit-1 (D-F3). `cost weekly`/garbage period silently ignored (D-F4). MCP `serverInfo.version` 0.0.0 not 0.1.0 (A-7). zk-harvest no tests (B-F4). eslint-disable without Reason (B-F5). dispose() empty (B-F6). bootstrap.ts stale comment manta.js vs .cjs (C).

## Benchmark (F) — proof methodology designed; runnable only after the above + a clean cast→merge cycle works. Built to show Manta LOSING where it should (anti-task T0, #66 cold-start as DNF).

## Fix order (toward the goal)
1. **B2 (#66 booting heartbeat)** — unblocks casts → restores bootstrap-by-Manta so the rest can be cast.
2. **B1 (preflight bus-name)** — unblocks cast for plugin users (the headline).
3. **B6 (NaN coercers)** + **B4 (RED-path gate tests)** — integrity.
4. **B8 (charge refund)**, **B5 (share version)**, **B7 (docs path)**.
5. **B3 (npm rename)** — right before publish.
6. HIGH cluster (H1-H6), then MED/LOW.
7. **Live end-to-end proof run** (DoD), then benchmark, then publish.

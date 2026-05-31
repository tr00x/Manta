# Manta v1 — Full Remediation Plan (post-audit, all 8 reports synthesized)

Sources: A user-journey, B crutches/mocks, C bundling, D CLI, E cast-reliability, F benchmark,
G UX/observability, H blind-spots. This plan covers EVERYTHING the audit surfaced, ordered, with
parallel-cast batching. DoD (from /goal): live user-journey green by hand (install→cast→inherit→
commit→merge), zero crutches/mocks/fake-tests/runtime-require bugs, good UX. THEN npm publish.

## DONE (merged + verified this session)
- B2 #66 clone startup-grace (booting heartbeat + grace from launch) — casts unblocked, live-cast proven.
- B1 plugin-bus preflight (probe `plugin:manta:manta-bus`) — plugin users can cast.
- B3 npm name → `@tr00x/manta` (unscoped squatted).
- B5 share --version no-op. B6 NaN money/timing guards. B7 docs path. B8 charge-refund-on-preflight.
- IN FLIGHT: batch-2 cast (B4 RED-gate-tests, H1 e2e-skip-visible, H2 promote tests, H3 tail, H5 abort-kill).

## REMAINING — batched for parallel casts (disjoint file fences; allocateCloneIds+CAS give disjoint letters)

### Batch UX (cast U) — Tier 0 observability [user-requested]
- **U1 conditional statusline (S-OBS11)**: new `manta statusline` script (reads registry.json +
  daily-spend.json + budget.json) → prints `🦈 A▶WORKING … · $x/cap · age` when clones live, EMPTY when
  idle. Plugin auto-wires via root `settings.json` `statusLine` (command + `refreshInterval:2`). Design in
  G-ux-observability.md. Fence: new `bin/manta-statusline.cjs` (or src + bundle), root `settings.json`, plugin.
- **U2 `/manta:tail` slash command** for on-demand deep watch (the "open details" affordance — CC has no
  buttons; this is the closest). Fence: `commands/tail.md`.
- **U3 (optional) plugin monitor** (experimental.monitors, CC≥2.1.105) — transitions-only push of clone
  state changes into the conversation (no heartbeat noise). Fence: `monitors/` + plugin.

### Batch SECURITY (cast S) — clone hard-guardrails [P0, I missed this]
- **S1**: clones run `--permission-mode bypassPermissions` with scope-fence as SOFT priming only. Install a
  PreToolUse hook for ALL clones (not just test-storm) that HARD-enforces allowedPaths/forbiddenPaths and
  blocks dangerous ops (git push, rm -rf outside worktree, touching the parent .git). Fence: spawner/hooks
  (clone-spawner.ts, a new guard-hook), NOT overlapping batch-2.
- **S2**: hard budget ceiling (not just post-hoc reaper) — or at minimum document `--force`/`--no-charge-check`
  as the only bypass and gate them. Fence: cast.ts charge path (coordinate — batch-2 touched cast.ts; sequence S after batch-2 merge).

### Batch DOGFOOD+ONBOARDING (cast D2) — [user wants /manta:* in the repo]
- **D2a dogfood-collision**: rename the MARKETPLACE in `.claude-plugin/marketplace.json` to `manta-dev`
  (keep plugin name `manta`) to kill the same-name collision (CC bug #14929) so `/manta:*` work even when
  cwd=repo. Update README/getting-started install commands (`/plugin marketplace add` → marketplace name).
  Document the `--plugin-dir` fallback. Fence: `.claude-plugin/marketplace.json`, README, docs/user.
- **D2b onboarding**: add `/manta:help` + `manta doctor` (env/claude/bus/charges health check). Fence:
  new `commands/help.md`, `src/commands/doctor.ts` + bin wiring.

### Batch CLEANUP+ERRORS (cast C2) — [P1]
- **C2a uninstall/cleanup**: `manta uninstall` only removes library packages, not Manta itself → add a
  cleanup path (or `manta uninstall --self` / document) that removes `.manta/` worktrees+branches, the
  `manta-bus` MCP registration, and state. Fence: `src/commands/uninstall.ts` or new cleanup command.
- **C2b error UX**: top-level catch (`bin/manta.ts:1023-1049`) dumps raw Node stack traces → friendly
  `[manta]` messages; special-case "claude not on PATH". Fence: `bin/manta.ts` top-level handler.
- **C2c multi-project bus cwd**: bus falls back to `cwd` when `MANTA_REPO_ROOT` unset (split-brain from a
  subdir) → walk up to `.git` like the CLI does. Fence: `manta-bus` repo-root resolution.

### Deferred to post-v1 (documented, NOT publish blockers)
- H4 worktree cast-scoped paths (data-loss guard already in place; structural refactor spans many call sites).
- Windows support (macOS/Linux first; `sh -c`/SIGTERM/`${VAR:-}` need a Windows pass) — note in README "macOS/Linux".
- H6 skills-to-clone path beyond plugin-global (plugin install covers the common case).

## Sequencing (parallel where fences are disjoint, serial where they overlap)
1. Land batch-2 (in flight) → merge → main stable.
2. Parallel wave 1 (disjoint fences): **cast U** (statusline/tail — new files + plugin settings) ‖ **cast D2**
   (marketplace/docs/onboarding) ‖ **cast C2** (uninstall/error/bus — manta-bus + bin top-level).
3. Then **cast S** (security guardrails — touches spawner + cast.ts; sequence after batch-2+others merge to
   avoid cast.ts collision).
4. **Switch dogfooding to `/manta:*`** once D2a lands (work from an external dir or with the renamed marketplace).
5. **Live end-to-end proof run** (DoD) — clean install → `/manta:cast` → clone inherits → commits → merge,
   by hand. Then benchmark (F). Then **npm publish @tr00x/manta** (user 2FA).

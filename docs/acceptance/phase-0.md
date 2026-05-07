# Phase 0 — Acceptance Checklist

Phase 0 is "shipped" when **every** box is ticked AND a human has signed off at the bottom. Cross-reference each item to the predecessor plan that owns it.

## Build & lint

- [x] `pnpm install` from a clean clone succeeds
- [x] `pnpm -r build` green for every package
- [x] `pnpm -r lint` zero errors, zero warnings
- [x] `pnpm -r typecheck` zero errors

## Per-package coverage gates (≥ 80 % on lines / functions / branches / statements)

Spec Sec 14.1 critical-path list:

- [x] `@manta/snapshot` — 97.03% lines / 100% functions / 92.72% branches / 97.03% statements (49 tests)
- [x] `@manta/bus` — 99.05% / 93.57% / 96.57% / 99.05% (143 tests)
- [x] `@manta/orchestrator` — 99.56% / 100% / 93.84% / 99.56% (44 tests)
- [x] `@manta/cli` — 95.97% / 95.23% / 84.10% / 95.97% (50 tests)

Phase-0 additions (held to the same bar as a self-imposed quality discipline; not in spec Sec 14.1 list):

- [x] `@manta/skill-validator` — 98.79% / 100% / 92.59% / 98.79% (27 tests)

## Skill / command validation

- [x] `manta-validate-skills --root .` reports 9 files, 0 errors, 0 warnings
- [x] All four Phase-0 skills present: `manta-as-clone`, `manta-coordinate`, `manta-graceful-death`, `manta-cast-decide`
- [x] All five Phase-0 slash commands present: `cast`, `status`, `kill`, `abort`, `recover`

## Pre-flight smoke

- [x] `pnpm --filter @manta/e2e test preflight.test.ts` green (3/3 in ~10 s)

## End-to-end (env-gated, real `claude`)

- [ ] On a developer machine with `claude` authenticated, `MANTA_E2E=1 pnpm e2e:recon-swarm` green within 25 minutes
- [ ] Both clones reached DEAD via the orchestrator
- [ ] Post-mortems on disk, parseable, contain Event-timeline sections
- [ ] ≥ 2 ZK notes written
- [ ] Snapshots persisted under `.manta/snapshots/cast-*/`
- [ ] Worktrees retained under `.manta/worktrees/clone-*/`
- [ ] Sample fixture's `docs/recon.md` (or equivalent task output) actually answers the task — **human review**

## Documentation

- [x] `docs/user/getting-started.md` walks a new contributor from clone to first cast
- [x] `docs/user/recon-swarm.md` describes the mode in user terms
- [x] Every production package has a `README.md` AND an `ARCHITECTURE.md`: `@manta/snapshot`, `@manta/bus`, `@manta/orchestrator`, `@manta/cli`, `@manta/skill-validator`. `@manta/e2e` is tests-only and ships only `README.md`.
- [x] `CHANGELOG.md` (top-level) records "Phase 0 — recon-swarm GA" with a date and a bullet list of what shipped
- [x] `docs/manta-bugs.md` exists (bootstrap commit `50e7957` created it) and is current (any known issues from the e2e dogfood are logged)

## Operational

- [x] `git log --oneline` shows atomic commits per chunk; no "fix later" / "WIP" commits in main
- [x] Every commit authored by the project owner per CLAUDE.md author-override rule (`-c user.email=… -c user.name=…` per command, never global)
- [ ] No `// TODO: implement` code comments in any production source path:
  ```
  rg -n '^\s*//\s*TODO: implement' \
    --glob 'packages/**/*.ts' \
    --glob '!packages/**/dist/**' \
    --glob '!packages/**/node_modules/**' \
    --glob '!packages/**/coverage/**' .
  ```
  (must return zero matches. The pattern targets the exact code-comment form; `// TODO: implement` strings inside docs / spec / plans / this checklist itself are policy text, not code violations, and are intentionally outside scope.)
- [x] No mocks or feature flags in production code paths (spec Sec 14.4)

## Sign-off

```
Phase 0 acceptance signed off by: ________________________
Date (YYYY-MM-DD UTC): ________________________
e2e cast id (from successful run): ________________________
Cost of acceptance run ($): ________________________
Next action: open Phase 1 milestone in `docs/superpowers/plans/INDEX.md`.
```

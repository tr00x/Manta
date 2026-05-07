# Phase 0 — Acceptance Checklist

Phase 0 is "shipped" when **every** box is ticked AND a human has signed off at the bottom. Cross-reference each item to the predecessor plan that owns it.

## Build & lint

- [ ] `pnpm install` from a clean clone succeeds
- [ ] `pnpm -r build` green for every package
- [ ] `pnpm -r lint` zero errors, zero warnings
- [ ] `pnpm -r typecheck` zero errors

## Per-package coverage gates (≥ 80 % on lines / functions / branches / statements)

Spec Sec 14.1 critical-path list:

- [ ] `@manta/snapshot` — `pnpm --filter @manta/snapshot test:coverage`
- [ ] `@manta/bus` — `pnpm --filter @manta/bus test:coverage`
- [ ] `@manta/orchestrator` — `pnpm --filter @manta/orchestrator test:coverage`
- [ ] `@manta/cli` — `pnpm --filter @manta/cli test:coverage`

Phase-0 additions (held to the same bar as a self-imposed quality discipline; not in spec Sec 14.1 list):

- [ ] `@manta/skill-validator` — `pnpm --filter @manta/skill-validator test:coverage`

## Skill / command validation

- [ ] `manta-validate-skills --root .` reports 9 files, 0 errors, 0 warnings
- [ ] All four Phase-0 skills present: `manta-as-clone`, `manta-coordinate`, `manta-graceful-death`, `manta-cast-decide`
- [ ] All five Phase-0 slash commands present: `cast`, `status`, `kill`, `abort`, `recover`

## Pre-flight smoke

- [ ] `pnpm --filter @manta/e2e test preflight.test.ts` green

## End-to-end (env-gated, real `claude`)

- [ ] On a developer machine with `claude` authenticated, `MANTA_E2E=1 pnpm e2e:recon-swarm` green within 25 minutes
- [ ] Both clones reached DEAD via the orchestrator
- [ ] Post-mortems on disk, parseable, contain Event-timeline sections
- [ ] ≥ 2 ZK notes written
- [ ] Snapshots persisted under `.manta/snapshots/cast-*/`
- [ ] Worktrees retained under `.manta/worktrees/clone-*/`
- [ ] Sample fixture's `docs/recon.md` (or equivalent task output) actually answers the task — **human review**

## Documentation

- [ ] `docs/user/getting-started.md` walks a new contributor from clone to first cast
- [ ] `docs/user/recon-swarm.md` describes the mode in user terms
- [ ] Every production package has a `README.md` AND an `ARCHITECTURE.md`: `@manta/snapshot`, `@manta/bus`, `@manta/orchestrator`, `@manta/cli`, `@manta/skill-validator`. `@manta/e2e` is tests-only and ships only `README.md`.
- [ ] `CHANGELOG.md` (top-level) records "Phase 0 — recon-swarm GA" with a date and a bullet list of what shipped
- [ ] `docs/manta-bugs.md` exists (bootstrap commit `50e7957` created it) and is current (any known issues from the e2e dogfood are logged)

## Operational

- [ ] `git log --oneline` shows atomic commits per chunk; no "fix later" / "WIP" commits in main
- [ ] Every commit authored by `Tim Hunt <tr00x@proton.me>` per CLAUDE.md
- [ ] No `// TODO: implement` strings anywhere outside ignored directories:
  ```
  rg -n "TODO: implement" --glob '!node_modules' --glob '!dist' --glob '!.git' --glob '!coverage' .
  ```
  (must return zero matches; this scope catches workspace-root configs / scripts that the per-directory variant misses)
- [ ] No mocks or feature flags in production code paths (spec Sec 14.4)

## Sign-off

```
Phase 0 acceptance signed off by: ________________________
Date (YYYY-MM-DD UTC): ________________________
e2e cast id (from successful run): ________________________
Cost of acceptance run ($): ________________________
Next action: open Phase 1 milestone in `docs/superpowers/plans/INDEX.md`.
```

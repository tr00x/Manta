# Z3 — Phase 8 Verification (decoy / council / Aghs-gate)

**Date:** 2026-05-31
**HEAD audited:** `84919b7 feat(modes): Phase 8 — implement Aghs-locked decoy + council modes`
**Scope:** confirm Phase 8 did not regress what Z/Z2 verified, and that Phase 8 itself is sound. Audit-only — no fixes applied. (`video/` ignored; parallel budget-repivot worktree does not touch main.)

---

## TOP-LINE VERDICT: PROBLEMS FOUND — 1 SHIP-BLOCKER

**Phase 8 source is sound. The Aghs-gate, schema, modes, skills, tests, and full `pnpm gate` are all CLEAN with NO regression to the existing 7 modes.**

**BUT:** the committed, GitHub-shipped bundled bin (`dist/bin/manta.cjs`) was **NOT rebuilt** in the Phase 8 commit. A fresh `git clone` of main ships a stale bin that does **not** recognize `decoy`/`council` — the new modes are unreachable through the installed CLI. They work only when running from rebuilt source. This is the exact "build artifact lags source" class the audit pattern predicts, and it's a real user-facing break: `npx manta install` + `manta cast decoy` → "mode not supported".

This is not a regression of Z2-verified behavior (the 7 modes still work in the shipped bin), but it is a Phase 8 soundness defect: the headline feature of the phase does not function as installed.

---

## Check table

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| 1 | decoy/council in schema; cast.ts Aghs-gate rejects locked / allows unlocked; phantom-lance still locked | ✓ (source) / ✗ (shipped bin, see #6) | Source: gate works. Fresh-build bin: locked decoy → exit 1 "Aghanim's-locked … Unlock it before casting" naming both channels; `MANTA_UNLOCK_AGHS=decoy` → `gate.dry_run mode=decoy … Dry run complete` exit 0; `MANTA_UNLOCK_AGHS=all cast phantom-lance` → "not supported" exit 1 (still locked). |
| 2 | No regression to 7 existing modes; gate does not block them | ✓ | All 7 dry-run exit 0 except refactor-wave (exit 1 = its own pre-existing `--tasks required` rule, not the aghs-gate). recon-swarm/forking-realities/bug-hunt/pair-programming/test-storm/documentation-chase all EXIT=0. |
| 3 | decoy/council skills exist, valid frontmatter, count 14→16, preflight updated+passing | ✓ | `skills/manta-decoy` + `skills/manta-council` present, valid `name/description/audience/version/related` frontmatter. `ls skills/` = 16. preflight asserts `skills.toHaveLength(16)`, `commands.toHaveLength(13)` — green in full run. |
| 4 | e2e decoy/council real, gated `skipIf(noClaude)`, not zero-assertion | ✓ | `decoy.e2e.test.ts`/`council.e2e.test.ts` use `describe.skipIf(noClaude)`, 28-min timeout, real `runAghsCastE2e` harness (spawns 2/3 real `claude --print` clones, asserts lifecycle+artifacts). Test run showed both `↓ skipped` (no claude bin in audit env). |
| 5 | Full `pnpm gate` green (tsbuildinfo cleared per #59) | ✓ | tsbuildinfo deleted first. `pnpm typecheck` clean, `pnpm lint` clean, `pnpm test` = **Tests 1656 passed \| 9 skipped (1665)**, Test Files 182 passed \| 7 skipped. Matches expected ~1656/9. |
| 6 | Clean clone smoke: `--help` exit 0, doctor 6/6, bundled bin runs w/o node_modules | ⚠ PARTIAL | `git clone … m3` HEAD=84919b7. `manta.cjs --help` EXIT=0. `doctor` → **All 6 checks passed**. node_modules ABSENT (self-contained). **BUT** `cast decoy` on the cloned bin → "mode 'decoy' is not supported (allowed: recon-swarm…documentation-chase)" — stale dist, see ship-blocker below. |
| 7 | No new TODO/FIXME/skip-no-skipIf/ts-ignore-no-reason/mocked-result; Phase 8 tests real | ✓ | No real markers. All `TODO/???` hits are skill-instruction prose (decoy/council draft markers) or a sample-repo fixture string. eslint-disables all carry `-- <reason>`. aghs-gate + cast-aghs-modes tests exercise reject AND allow (env, wildcard, config), per-mode granularity, count bounds, full-spawn manifest+approachHint — not tautological. |
| 8 | phantom-lance can't be unlocked the same way; recursive spawn stays locked | ✓ | phantom-lance absent from `BUILTIN_MODES` (cast.ts:65-66 = decoy/council only) → rejected at "not supported" before gate. Excluded from `WILDCARD_UNLOCK_MODES` (`['decoy','council']`), so `MANTA_UNLOCK_AGHS=all` does NOT unlock it (verified: exit 1). Can only be named explicitly in env, but BUILTIN_MODES upstream lock still rejects it. Confirmed locked. |

---

## SHIP-BLOCKER: stale committed `dist/` (bundled bin not rebuilt in Phase 8)

**Severity: High** (headline feature of the phase is unreachable as installed).

`dist/` is git-tracked and committed. Its last rebuild was commit `bc5d54f chore(plugin): rebuild payload after wave-3` — **before** Phase 8 (`84919b7`). The Phase 8 commit added decoy/council to the TypeScript source and to source-run tests, but did not run `pnpm build:plugin` to refresh the committed bundle.

Evidence (clean GitHub clone, HEAD = Phase 8):
```
$ cd /tmp/m3 && git log --oneline -1
84919b7 feat(modes): Phase 8 — implement Aghs-locked decoy + council modes
$ node dist/bin/manta.cjs cast decoy "x" --clones 2 --dry-run
[manta] mode "decoy" is not supported (allowed: recon-swarm, forking-realities,
  bug-hunt, refactor-wave, pair-programming, test-storm, documentation-chase)
```
The shipped bin's allowed-list ends at `documentation-chase` — decoy/council absent.

Proof the source is correct (after `pnpm build:plugin` rebuild, then reverted to keep audit clean):
```
$ node dist/bin/manta.cjs cast decoy "draft" --clones 2 --dry-run   # rebuilt
[manta] mode "decoy" is an Aghanim's-locked advanced mode and is disabled by
  default (spec Sec 6.6). Unlock it before casting:
  • config:  add "decoy" to "aghs.unlocked" in .manta/config/budget.json …
  • env:     run with MANTA_UNLOCK_AGHS=decoy …
$ MANTA_UNLOCK_AGHS=decoy node dist/bin/manta.cjs cast decoy "draft" --clones 2 --dry-run
[info] gate.dry_run mode=decoy cloneCount=2 chargeCost=2 …
Dry run complete for cast … No clones spawned.
$ MANTA_UNLOCK_AGHS=all node dist/bin/manta.cjs cast phantom-lance "x" --clones 2 --dry-run
[manta] mode "phantom-lance" is not supported (allowed: …, decoy, council)
```

**Fix (one command, not applied — audit-only):** `pnpm build:plugin && git add dist && git commit`. After that the shipped bin gains decoy/council and the gate behaves exactly as the rebuilt bin above. Per project convention this rebuild has historically been its own `chore(plugin): rebuild payload` commit (cf. `bc5d54f`, `08f8055`) — Phase 8 skipped it.

**Why prior audits missed it:** Z/Z2 verified the 7 pre-Phase-8 modes, which were present in the bin bundled at `bc5d54f`. The stale-dist gap only surfaces for modes added *after* the last bundle rebuild — i.e. it's intrinsic to Phase 8. This is the audit pattern ("each audit finds what the prior missed") holding true.

---

## Minor / informational (not blockers)

- **Working-tree change present:** `packages/manta-skill-validator/tests/integration.test.ts` is modified (uncommitted). It updates the hardcoded skill-inventory list 14→16 (adds manta-council, manta-decoy). This is the "1 fail … main applies a one-line list update" noted in the Phase 8 commit body — the curator-applied fix. It is what makes the gate green (1656 pass). It should be committed alongside the dist rebuild; as it stands it is correct but uncommitted, so a clean checkout of `84919b7` alone would show 1 test failure here. (The clean-clone in #6 uses the bundled bin, not this test, so it was unaffected.)

## Confirmed sound (no regression / no defect)

- Aghs-gate logic (`config/aghs-gate.ts`): wildcard tokens unlock decoy+council only, never phantom-lance; typos ignored (never silently unlock); config ∪ env union; clear actionable CliError. Unit tests cover every branch.
- Schema (`schema.ts`): `aghs.unlocked: z.array(ModeSchema).default([])`, `.strict()`, validated against ModeSchema; charge costs decoy=2/council=3/phantom-lance=3.
- cast.ts wiring: gate runs after mode resolution, before count validation (unlock message wins). decoy ≤2 clones / collaborative / drafter approachHint; council 3-5 / independent (peer_messaging denied) / auto_merge_threshold null / proposer approachHint. Full-spawn manifest+snapshot assertions in tests confirm.
- Priming: DECOY_BLOCK / COUNCIL_BLOCK conditional on mode, name the right skill, no cross-contamination — asserted in priming.test.ts.

---

## Bottom line

Phase 8 source code, tests, schema, skills, and gate are **clean and non-regressive** — `pnpm gate` is green at 1656/9 and the 7 existing modes are untouched. The single defect is operational, not logical: the **committed `dist/` bundle was not rebuilt**, so decoy/council are dead on arrival for anyone installing from GitHub. One `pnpm build:plugin` + commit closes it (plus committing the already-applied skill-validator list fix). Until then, Phase 8's headline modes do not work as shipped.

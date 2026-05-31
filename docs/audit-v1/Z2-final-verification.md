# Z2 — FINAL Publish-Readiness Verification (Audit #2)

**Date:** 2026-05-31
**Repo:** https://github.com/tr00x/Manta.git
**HEAD verified:** `bc5d54fc61850002eb6bb6a874ee30b3bf881a9f`
**Method:** clean clone from GitHub + real runs in throwaway git repos; zero "should work" claims.

---

## TOP-LINE VERDICT: **NOT PUBLISH-READY — 1 blocker**

Everything the prior audit flagged (Z1 self-death post-mortems, Z2 launcher hard-fail, slash-parity, onboarding hook) is **genuinely fixed and verified with real output**. The gate is green (1612 pass / 7 legit skip), the tarball is clean, the quality bar holds.

The **single remaining blocker is a FALSE CLAIM in the task brief itself**, not a regression: the brief asserts "C2c makes `manta status` from a SUBDIR resolve instead of 'not a git repo root'." **That is not true.** Only `manta doctor` walks up to find `.git`. `status`, `cost`, `cleanup`, and every other `runWithRuntime`/`createRuntime` command still hard-fail from a subdirectory. This is a documented, deliberate scope (memory obs 18287: "doctor works from subdirectories…; other commands require repo root") — but it directly contradicts the readiness claim, so the user must decide: (a) accept "must run from repo root" as the shipped contract and correct the claim, or (b) treat subdir-resolution for `status` as a real gap to close before publish.

This is a **decision blocker, not a code-crash blocker.** If the user accepts "repo-root-only except doctor" as intended UX, there are **0 technical blockers** and it is publish-ready.

---

## Check-by-check table

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| 1 | Clean clone, `manta --help` exit 0 | ✓ | `git rev-parse HEAD` = `bc5d54f`; `--help` lists all 24 commands, `EXIT=0` |
| 1 | `dist/node_modules/proper-lockfile` vendored (plugin path) | ✓ | `ls dist/node_modules/` → `graceful-fs proper-lockfile retry signal-exit`; `proper-lockfile/` has `index.js lib package.json` |
| 2 | Z1: clean self-death writes post-mortem (e2e PASS) | ✓ | `recon-swarm.e2e.test.ts` **1 passed** in 110.4s; asserts `clones.toHaveLength(2)`, both `state==='DEAD'`, `pmFiles.length >= 2`, `-A.md` + `-B.md` present with `# Post-mortem — clone` + `## Event timeline`, ZK notes >= 2 |
| 2 | `cast.ts` calls `ensureSelfDeathPostMortems`, exported from orchestrator | ✓ | `post-mortem.ts:128` defines+exports it; `index.ts:7` `export * from './post-mortem'`; `cast.ts:18` imports, `cast.ts:916` calls during settlement (idempotent, reuses `fsPostMortemWriter`+`runPostMortem`) |
| 3 | 13 commands in `commands/` (9 + doctor/inspect/replay/charges) | ✓ | `ls commands/*.md \| wc -l` = 13; all 13 have `---` frontmatter; slash list shows `manta:doctor/charges/inspect/replay` registered |
| 3 | `doctor`/`inspect`/`replay`/`charges` run from clean clone | ✓ | `doctor` → "All 6 checks passed", exit 0; `inspect nope` → "not found", exit **1**; `replay nope` → "not found", exit **1**; `charges` → "3 / 5, nominal" + mode table, exit 0 |
| 4 | `hooks/hooks.json` declares SessionStart hook | ✓ | matcher `startup\|resume\|clear\|compact` → `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/manta-session-priming.cjs"`, timeout 5 |
| 4 | Hook script emits orchestration priming, exit 0 | ✓ | running `manta-session-priming.cjs` → valid JSON `hookSpecificOutput.additionalContext` with cast-decide/orchestrate/serial guidance, `PRIMING_EXIT=0` |
| 4 | `claude plugin validate /tmp/m2` passes WITH hook | ✓ | "✔ Validation passed", `VALIDATE_EXIT=0` |
| 5 | Z2 `.mcp.json` launcher hard-fails with clear message | ✓ | sh-wrapper: `if [ ! -f "$SRV" ]; then echo "manta-bus: server entry not found at $SRV — …Run 'manta install'…" >&2; exit 1; fi`. Real run in dir with no dist/ and unset `CLAUDE_PLUGIN_ROOT` → exact message, `WRAPPER_EXIT=1` |
| 6 | All 24 CLI commands `--help` exit 0 | ✓ | swept cast..library, every one `OK` (0 failures) |
| 6 | B6 NaN-guard rejects `cast --daily-cap-usd xyz` | ✓ | "argument 'xyz' is invalid. expected a positive number", exit **1**; `-5` also rejected, exit 1 |
| 6 | B5 `share --pkg-version` runs | ✓ | `--pkg-version <semver>` listed; runs through to validation ("required option '--name' not specified") — no crash |
| 6 | C2 `cleanup --dry-run` works | ✓ | "Manta cleanup — dry run (nothing was changed)" + 4 would-do lines, exit 0 |
| 6 | **C2c: `manta status` from SUBDIR resolves** | **✗ BLOCKER** | from `/tmp/mtest/deep/nested/sub`: `[manta] not a git repo root: /private/tmp/mtest/deep/nested/sub`, exit **1**. Same for `cost`, `cleanup`. Only `doctor` walks up (`✓ cwd is a git repo  …/deep/nested/sub`). `runWithRuntime` (manta.ts:74) passes raw `process.cwd()` to `createRuntime` (runtime.ts:57-69) which requires `.git` at that exact path — no upward walk. Claim is FALSE for `status`. |
| 7 | Full `pnpm gate` green (tsbuildinfo cleared) | ✓ | exit 0; gate = `tsc -b && eslint … && vitest run`; reaching test phase proves typecheck+lint passed (fail-fast) |
| 7 | Totals ~1612 pass / 7 skip | ✓ | **Tests 1612 passed \| 7 skipped (1619)**; Test Files 179 passed \| 5 skipped |
| 7 | 7 skips are legit env-gated, not silent passes | ✓ | all are `describe.skipIf(noClaude)` real-claude e2e (recon-swarm/forking/bug-hunt/refactor/transcript/library); each comments "reports as skipped (not a zero-assertion pass)" |
| 8 | npm tarball `@tr00x/manta@0.1.0`, dist only, no junk | ✓ | `npm pack --dry-run` (dev repo): 18 files, dist/bin/{manta,server,manta-validate-skills}.{js,cjs} + maps + dist/index.* + README + package.json. **No src/tests/tsbuildinfo.** 1.1 MB packed |
| 8 | bin targets exist (no broken bin) | ✓ | bin → `manta.js`/`server.cjs`/`manta-validate-skills.js`; all present in tarball. (npm warns only in zero-build clone where `.js` variants aren't shipped — the npm build via tsup produces them) |
| 8 | npm deps declared (proper-lockfile etc.) | ✓ | `dependencies` includes `proper-lockfile ^4.1.2` + 9 others; npm package resolves deps normally (vendoring is the PLUGIN path only, see note) |
| 9 | No new TODO/FIXME/HACK/XXX in src | ✓ | grep across `packages/*/src` → none |
| 9 | No raw `.skip(`/`.todo(`/`xit`/`xdescribe` | ✓ | grep → none; every skip is `skipIf` |
| 9 | No `@ts-ignore`/`@ts-nocheck`/`eslint-disable` w/o Reason | ✓ | grep → none |
| 9 | B4 RED-path gate tests still real | ✓ | `merge-review-collector.test.ts`: execa mock faithfully REJECTS on non-zero exitCode (`if res.exitCode!==0 && opts?.reject!==false → throw`), explicitly noting the prior "green-only mock nayobka, bug #63". Asserts gate runs install+build+real tsc/eslint/vitest, not a divergent `eslint .` |

---

## Notes / nuances (not blockers)

- **"node_modules vendored in npm tarball"** (brief check 8): the npm tarball does NOT vendor node_modules — it declares deps and lets npm resolve them. Vendoring (`dist/node_modules/proper-lockfile`) is the **plugin / git-clone zero-build** path (verified ✓ in check 1). Both distribution paths are correct via different mechanisms; the brief conflated them. Not a defect.
- **inspect/replay not-found exit codes:** correctly exit 1 (an earlier `head` pipe masked this; verified with `>/dev/null; echo $?`).
- The plugin `dist/bin` ships `.cjs` variants only (manta, server, session-priming, statusline); the npm `dist/bin` (tsup) ships both `.js` and `.cjs`. Internally consistent per distribution channel.

## Exact remaining blocker

**B-Z2-1 (decision blocker):** `manta status` (and all non-`doctor` commands) hard-fail with `not a git repo root` when run from a subdirectory. The readiness brief claims C2c fixed this for `status`; it did not (only `doctor` got `resolveRepoRoot` upward-walk). Root: `runWithRuntime`→`createRuntime` uses raw `process.cwd()` (manta.ts:74, runtime.ts:57-69).

- **If intended** ("Manta anchors at repo root; run from root"): correct the claim, ship. 0 technical blockers.
- **If a gap**: extend the `doctor`-style `resolveRepoRoot` walk to `runWithRuntime` before publish.

User must adjudicate. Everything else is clean.

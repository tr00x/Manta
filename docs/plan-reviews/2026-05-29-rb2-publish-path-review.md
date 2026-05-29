# Plan Review — RB2 `npx manta@latest install` publish path

**Reviewed plan:** `docs/superpowers/plans/2026-05-29-release-rb2-publish-path.md`
**Audit source:** `docs/audits/2026-05-29-prod-readiness.md` (B-PUB1..4, S-PUB5/6)
**Reviewer:** independent plan-review subagent, evidence-based against live `main` (2026-05-29)
**Method:** read all 7 `package.json`, all 5 `tsup.config.ts`, the CLI bin/spawner/install/preflight/priming source, both build tsconfigs, bug #53, and grepped the full external-import closure.

---

## Verdict: **APPROVE-WITH-MUST-FIX**

The plan is architecturally sound and the headline risk (C1 dep-closure) is **correct**. But it ships **5 MUST-FIX blockers** that would each stop an implementer cold or produce a broken artifact: (1) the version string lives in **three** places, not one; (2) the heartbeat hook's `require.resolve('@manta/bus')` **breaks the instant `@manta/bus` is bundled away** — this is the *same* defect as bug #53 and makes bug #53 a hard prerequisite, not an open question; (3) the Chunk-1 rename grep misses the `@manta/e2e` consumers that pin `dist/bin/manta.cjs` and `pnpm --filter @manta/cli`; (4) the `mcp-preflight.ts` error string hard-codes the wrong `$(pwd)` path and must be in Chunk 0/3 scope; (5) the CLI `tsconfig.json` `references` array omits `manta-skill-validator`, which `tsc -b` (the typecheck gate) needs once the validator is a build input. None invalidate the strategy — they're all "the plan is incomplete here" fixes applicable before the first cast.

**MUST-FIX count: 5.**

---

## MUST-FIX (blockers)

### M1 — Version lives in THREE places; plan's Chunk 1 bumps only `package.json`
**Plan line:** 75 ("`version` `0.0.0`→`1.0.0`").
**Evidence:**
- `packages/manta-cli/package.json:3` — `"version": "0.0.0"` (the one the plan names).
- `packages/manta-cli/src/bin/manta.ts:144` — `.version('0.0.0');` (hard-coded commander `--version` output — the literal `manta --version` string).
- `packages/manta-cli/src/library/cli-version.ts:9` — `export const MANTA_CLI_VERSION = '0.0.0';`, consumed by `getMantaCliVersion()` and wired into the library-install compat check at `manta.ts:542,757` (`mantaCliVersion: getMantaCliVersion()`).

`cli-version.ts:5-7` even documents the contract: *"Single source of truth — mirrored to `package.json#version` at release time. When the version in package.json changes, update this constant in the same commit."* So acceptance criterion (1)/(7) and the library compat path will report `0.0.0` even after the package is `1.0.0` unless all three move together.
**Corrected text (Chunk 1):** "`version` `0.0.0`→`1.0.0` in **all three** sources in the same commit: `package.json#version`, the hard-coded `.version('0.0.0')` at `src/bin/manta.ts:144`, and `MANTA_CLI_VERSION` at `src/library/cli-version.ts:9`. `grep -rn \"0\\.0\\.0\" packages/manta-cli/src packages/manta-cli/package.json` must return zero version hits afterward." (None of these read package.json at runtime — all three are literals — so bundling is safe; the cost is purely keeping them in lockstep.)

---

### M2 — Bundling `@manta/bus` away BREAKS the heartbeat hook's `require.resolve('@manta/bus')` — bug #53 is a hard prerequisite, not "open item #3"
**Plan lines:** 53-55 (D2 bundles `@manta/*`), 120 + §8 item 3 (treats bug #53 as a *coordination flag* / open question).
**Evidence:** `packages/manta-cli/src/spawner/heartbeat-hook.ts`:
- Line 4: `import { busPaths } from '@manta/bus';` — bundled fine (inlined source).
- **Line 13:** `const PROPER_LOCKFILE_PATH = createRequire(require_.resolve('@manta/bus')).resolve('proper-lockfile');` — this is a **runtime `require.resolve` of the package specifier `@manta/bus`**, executed when `installHeartbeatHook` runs (clone-spawner.ts:152, every cast). Once D2 inlines `@manta/bus` source into the `manta` bundle via `noExternal`, **there is no `@manta/bus` entry in the published package's `node_modules`** → `require.resolve('@manta/bus')` throws `Cannot find module '@manta/bus'`. The generated touch-script never gets written, the spawn step throws.

This is not a hypothetical: it is the *exact* mechanism of **bug #53** (`docs/manta-bugs.md:768`, root cause at :817 — "embeds an install-time absolute `proper-lockfile` path... under a different `node_modules` layout"). The audit itself flags it (`prod-readiness.md:118`): *"embedding an install-time absolute proper-lockfile path into a script that later runs under a different node_modules layout — is exactly the condition an npm-global / npx install creates."* Bundling makes the layout *strictly worse* (the package literally disappears), so this moves from "low-probability latent" to "deterministic break."
**Corrected text:**
1. Promote §8 item 3 from "open question" to a **Chunk-2 prerequisite (or Chunk 2a)**: apply bug #53 fix (a)+(c) — resolve `proper-lockfile` *inside the generated subprocess* at runtime (e.g. emit `require('proper-lockfile')` and let the worktree's own `node_modules` resolve it, OR resolve relative to the bundled package root via `require.resolve` from a path that survives bundling), and have the lock `catch` `console.error` instead of fully swallowing.
2. Replace the `require_.resolve('@manta/bus')` chain at heartbeat-hook.ts:13 — it cannot survive `noExternal`. The plan's Chunk 2 gate ("`node dist/bin/server.cjs` starts") will NOT catch this because it tests the *server* bin, not the *spawn-time hook installation*; add an explicit Chunk-2 gate step: a bundled-`manta` cast (or unit test against the bundled bin) that exercises `installHeartbeatHook` and asserts the touch-script is written without `Cannot find module`.
3. The risk-table row (line 120) is right that it's a cross-dep, but understates it — re-label from "should land WITH or BEFORE" to "**MUST land in/before Chunk 2; bundling deterministically breaks the current resolve**."

---

### M3 — Chunk-1 rename grep misses the real `@manta/cli` consumers (e2e tests pin `manta.cjs` + `pnpm --filter @manta/cli`)
**Plan line:** 76 ("`grep -rn \"@manta/cli\"` FIRST and update every consumer: `@manta/e2e` dep, any import, tsconfig project refs, root `pnpm-workspace` globs").
**Evidence (the consumers that actually break, beyond the `package.json` dep):**
- `packages/manta-e2e/tests/manta-library.e2e.test.ts:30` — `execa('pnpm', ['-r', '--filter', '@manta/cli...', 'build'], …)`. After rename to `manta`, `--filter @manta/cli...` matches nothing → the e2e build step fails. (Same pattern likely in other e2e tests; grep `--filter @manta/cli`.)
- **Bin filename drift:** ALL e2e tests resolve the CLI as **`dist/bin/manta.cjs`** (the CJS bin), not `manta.js`: `forking-realities.e2e.test.ts:10`, `refactor-wave.e2e.test.ts:10`, `recon-swarm.e2e.test.ts:10`, `bug-hunt.e2e.test.ts:10`, `charge-system.e2e.test.ts:9`, `preflight.test.ts:31`, `manta-library.e2e.test.ts:12`. Meanwhile the plan's acceptance (lines 13, 84, 98) and the new Chunk-4 e2e all use `dist/bin/manta.js` (ESM). Both files exist today (tsup `format: ['esm','cjs']` emits both — confirmed `ls packages/manta-cli/dist/bin/` → `manta.cjs` + `manta.js`), so this is not itself a break — **but** the plan never reconciles that the *existing* e2e suite drives the `.cjs` bin while the published `bin.manta` points at `.js`. If Chunk 2 ever drops a format or the implementer "simplifies" to one bin, the existing 1.4k-test e2e suite silently breaks.
- `pnpm-workspace.yaml` keys off the **directory** glob `packages/*` (+ the `!.manta/worktrees/**` exclude), NOT the package name — so the workspace glob is safe (plan line 76 is right that "the dir can stay `packages/manta-cli`"). Confirmed: no name-keyed workspace entry.

**Corrected text (Chunk 1):** Expand the grep target list explicitly: "`git grep -n '@manta/cli'` AND `git grep -n 'manta-cli/dist/bin'` AND `git grep -n -- '--filter @manta/cli'`. Update: (a) `@manta/e2e` `package.json:16` dep; (b) every `--filter @manta/cli` invocation in `packages/manta-e2e/tests/*.ts` (currently manta-library.e2e:30, scan all); (c) the `manta.cjs` bin-path constants in 7 e2e test files — decide and document whether published `bin.manta` is `.js` (ESM) or `.cjs`, and make the e2e suite + the new Chunk-4 e2e agree on ONE. The `pnpm-workspace.yaml` globs key off the directory, not the name — no change needed there (verified)."

---

### M4 — `mcp-preflight.ts` hard-codes the wrong `$(pwd)/packages/manta-bus/...` path in its user-facing error — must be in scope
**Plan line:** 70 (Chunk 0 lists the doc files to fix: README, getting-started.md:111, cli README:7, bus README:37, spec:397 — but **not** `mcp-preflight.ts`).
**Evidence:** `packages/manta-cli/src/commands/mcp-preflight.ts:79`:
```
'  claude mcp add -s user manta-bus -- node "$(pwd)/packages/manta-bus/dist/bin/server.cjs"\n' +
```
This is the **runtime** error a real external user hits when the bus isn't registered — it tells them to register a path (`$(pwd)/packages/manta-bus/...`) that does not exist in an npm install (there is no monorepo). This is the *same lie-class* the plan's D3 is killing, but in code, not docs. The plan's Chunk 3 self-bootstrap fixes the *happy path* (`manta install` registers the right path) but leaves this error pointing users at the wrong manual command.
**Corrected text:** Add to Chunk 0 (or Chunk 3, since it's adjacent to the bootstrap): "Update the `claude mcp add` instruction string at `packages/manta-cli/src/commands/mcp-preflight.ts:79` to direct the user to `manta install` (the self-bootstrap) instead of the hard-coded `$(pwd)/packages/manta-bus/dist/bin/server.cjs` monorepo path. The preflight error is the runtime surface of the same wrong-path lie D3 corrects in docs." (Note: `getting-started.md:61` cited in plan §2 line 39 and audit:105 is the doc twin of this same string.)

---

### M5 — CLI `tsconfig.json` `references` omits `manta-skill-validator`; `tsc -b` (the typecheck gate) needs it once the validator is bundled
**Plan lines:** 82-83 (Chunk 2 adds the validator bin entry + bundles its source), 78/84 (gate = `pnpm gate`, which is `pnpm typecheck && …`, and `typecheck` = `tsc -b` at root `package.json:21`).
**Evidence:**
- `packages/manta-cli/tsconfig.json` `references`: only `../manta-bus`, `../manta-orchestrator`, `../manta-snapshot` — **`../manta-skill-validator` is absent**.
- Yet the CLI already imports skill-validator at runtime: `install.ts:9`, `share.ts:10`, `library.ts:3`, `share/bundle-assembler.ts:5`, `share/generate-readme.ts:1`, `share/publish-flow.ts:2`, `share/build-cast-origin.ts:1`.
- This is exactly prior-audit finding **M4** (`docs/audits/2026-05-28-full-audit.md:61`: "`@manta/cli` `tsconfig.json` references array omits `{ path: ../manta-skill-validator }` though cli imports it — `tsc -b` may produce stale incremental rebuilds"). Still open.

It compiles today only because skill-validator is consumed mostly as `type` imports + one value import (`CastOriginSchema`) and `tsc -b` finds it via node_modules resolution rather than the project graph — but it's fragile, and Chunk 2 makes skill-validator a *first-class build input of the published artifact*. Leaving the reference missing risks stale incremental `tsc -b` output reddening the gate non-deterministically mid-cast.
**Corrected text (Chunk 1 or 2):** "Add `{ \"path\": \"../manta-skill-validator\" }` to `packages/manta-cli/tsconfig.json` `references` (closes prior-audit M4; required for `tsc -b` to see the validator as a project dependency now that Chunk 2 bundles its source)."

---

## SHOULD-FIX (cheap, apply before commit)

### S1 — Chunk 2's `noExternal` will also try to bundle anything matching `/^@manta\//` that you DON'T want inlined — none today, but pin it
**Evidence:** the only `@manta/*` packages are the 5 internal ones; all are intended to inline. No external `@manta/*`-scoped npm package is a dep. **Verified safe.** But add a one-line note in Chunk 2 that the regex is intentionally greedy and there are no external `@manta/`-scoped deps to accidentally inline (so a future reviewer doesn't second-guess it).

### S2 — `files: ["dist"]` is correct but the npm page will have NO README
**Plan line:** 75 ("confirm `files: [\"dist\"]` will carry all bins").
**Evidence:** `packages/manta-cli/package.json:21` `"files": ["dist"]`. npm *always* includes `package.json` + `README.md` + `LICENSE` regardless of `files`, so the bins (under `dist/`) are carried and the existing `packages/manta-cli/README.md` ships. **But** that README (`cli README:7`) currently says *"Once published as a Claude Code plugin (Phase 7)… run via `pnpm --filter @manta/cli exec manta`"* — i.e. the npm landing page would tell installers to use a monorepo command. Chunk 0 already touches `cli README:7`; make sure its rewrite is the **npm-install-first** framing (this IS the published package's front page), not just a phase-label tweak.

### S3 — Chunk 4 e2e: the existing `claudeBin.ts` / `MANTA_E2E=1` gating is real — confirm the new test follows it
**Plan line:** 98 (says to reuse `MANTA_E2E=1` + `claudeBin.ts`).
**Evidence:** every e2e test imports `probeClaudeBin` from `./helpers/claudeBin.js` (e.g. `recon-swarm.e2e.test.ts:6`). The plan correctly says "do NOT invent a new env var." **Verified the guidance matches reality.** One addition: the publish e2e is the *only* one that doesn't need a real `claude` (it asserts `manta --help` + a mocked/dry-run bootstrap), so it can run even where `probeClaudeBin` would skip the others — call that out so it isn't gated off unnecessarily.

---

## ADVISORY (judgment calls / §8 items)

### A1 (§8 item 1) — Skills/commands shipping: the plan's "core cast does not depend on skills" is **WRONG for clone-side skills**
**This is the most important advisory — it borders on MUST-FIX depending on how you read the goal.**
**Evidence:** `packages/manta-cli/src/spawner/priming.ts` builds the clone's `--append-system-prompt`, and **step 1 of the mandatory startup sequence (line 7) is:** *"Use the Skill tool to load `manta-as-clone`."* Mode-specific blocks also name `manta-pair-writer`/`manta-pair-reviewer` (line 82) and the shutdown sequence names `manta-graceful-death` (line 15). The clone is *instructed to load skills as its first action.*

How skills resolve: clones run via `claude --print` with `cwd` = a `git worktree add` checkout of the host repo (`worktree.ts:28,45` → `.manta/worktrees/<name>`; `clone-spawner.ts:159-160` sets `cwd: opts.worktree`). The Skill tool resolves skills from the cwd's `.claude`/repo `skills/` — which exist because the worktree is a checkout of a repo that has `./skills/` (confirmed `./skills/manta-as-clone/SKILL.md` etc. at repo root, 10+ skills).

**Implication:** `manta cast` works for a user **who runs it inside a Manta git checkout** (the dev path — skills present). For a user who `npx manta@latest install`-ed into an *arbitrary* project with no `skills/`, the clone's "load `manta-as-clone`" step finds nothing and the documented startup contract degrades. So:
- The plan's premise "core cast does not depend on skills, so leaning Phase 8" (line 121) is **factually incorrect** — the core cast path's *priming* hard-references `manta-as-clone`.
- BUT: this is entangled with a *deeper* unstated assumption — **`manta cast` requires a git repo at all** (it does `git worktree add`). An npm-global `manta` in a non-repo dir can't cast regardless of skills. The plan's goal ("install works + `manta cast` works") implicitly assumes the user is in a Manta-style repo.
- **Recommendation:** Do NOT silently "lean Phase 8." Either (a) explicitly scope v1's `manta cast` to "run from within a Manta-enabled repo/worktree that carries `skills/`," and say so in the goal + docs (honest, cheap, matches the dev-dogfood reality); or (b) ship the `skills/` dir in `files:` AND have `manta install` (bootstrap) materialize them into the target — heavier, and still doesn't solve the "needs a git repo" constraint. Given the PROD-honesty bar, option (a) (scope + document the precondition) is the right v1 call, but it must be *stated*, because "install works → cast works on a clean machine" (the literal one-line goal, plan line 7) is **not** true for a non-repo dir. Flag this to the user before Chunk 0.

### A2 (§8 item 2) — `1.0.0` vs `0.1.0`
Judgment call; `1.0.0` is defensible *if* A1 is resolved honestly (GA that documents its repo precondition). If A1 is left ambiguous, `0.1.0` is the more honest signal. Recommend `1.0.0` **conditional on A1 being explicitly scoped**.

### A3 (§8 item 3) — bug #53 sequencing
**Resolved to MUST-FIX — see M2.** It is not an open question: bundling deterministically breaks `require.resolve('@manta/bus')` at heartbeat-hook.ts:13. Must land in/before Chunk 2.

### A4 (§8 item 4) — CHANGELOG `[1.0.0]` cut
Judgment call. The audit (`prod-readiness.md:107`) notes top entry is `[Unreleased]`, last versioned `[0.1.0]`. Cutting `[1.0.0]` fits naturally in Chunk 1 (alongside the version bump) since it's the same "make it releasable" beat; doing it in a separate release-cut ritual is also fine. No blocker. Minor: the CHANGELOG also still says "18 tools" (real = 25, audit S-DOC9) — out of this plan's scope per §7, but if you touch CHANGELOG in Chunk 1, fix it in the same pass.

---

## Verified-correct (do NOT re-verify)

- **C1 — dep closure is CORRECT and complete.** Exhaustive grep of all external (non-`node:`, non-relative, non-`@manta/`) runtime imports across `manta-cli` + the 4 bundled packages yields exactly: `@modelcontextprotocol/sdk, commander, execa, gray-matter, nanoid, proper-lockfile, semver, tar, yaml, zod` (10 packages). This matches the plan's D2 list (line 55) **exactly**. Per-package confirmation:
  - `@manta/bus` deps `@modelcontextprotocol/sdk` (`server.ts:1,5`, `bin/server.ts:4`), `nanoid`, `proper-lockfile` — all confirmed imported in src, all in `manta-bus/package.json:31-33`. ✅
  - `@manta/skill-validator` deps `gray-matter` (confirmed import in src; `skill-validator/package.json:32`) + `commander`. ✅
  - `@manta/orchestrator` (`package.json:26-29`) and `@manta/snapshot` (`package.json:24`) add **only `zod`** (plus their `@manta/*` workspace deps which inline) — confirmed, nothing else. ✅
  - Nothing is missing; nothing extra. The one apparent extra in the raw grep — bare `require('fs')` — is a Node builtin inside the *generated* heartbeat-touch.cjs string (heartbeat-hook.ts:92), not a real dep. ✅
  - (Caveat carried by the plan itself: tree-shaking may drop a transitive at build time; the plan's Chunk-2 pack-extract-run gate (line 84) is the correct backstop. Keep it.)
- **C2 — cross-package tsup entry is feasible** (with caveats already captured as M5). No `paths` aliases in `tsconfig.base.json` — `@manta/*` resolves purely via pnpm node_modules symlinks, which esbuild follows to source and inlines under `noExternal`. The DTS step uses `dts: { entry: 'src/index.ts' }` (cli tsup.config.ts:5) — only the index, NOT the bin entries — so the cross-package bin entries don't trigger DTS against the sibling `src/`, sidestepping the `tsconfig.build.json include: ["src/**/*"]` constraint. **CJS/ESM mixing is sound:** `outExtension` (bus tsup.config.ts:21-23, cli:13-15) already emits `.cjs` for cjs + `.js` for esm in the *same* config with `format: ['esm','cjs']`; the bus bin (`server.ts`) has **no `import.meta`** (grep confirmed zero across all 4 bundled packages), so transpiling its ESM source to a CJS `server.cjs` entry alongside the ESM `manta.js` is fine. The plan's "mirror manta-bus's `outExtension`" (line 82) is the right instruction. → **Not the multi-day rabbit hole; ~3h is plausible IF M2 (bug #53 / `@manta/bus` resolve) is fixed first.** The real Chunk-2 risk is M2, not the bundling mechanics.
- **C3 — commander optional-positional is the right mechanism.** Current declaration confirmed: `packages/manta-cli/src/bin/manta.ts:485` — `.command('install <spec>')` (required positional), `.action(async (spec: string, options) => …)` at :494-496. Changing to `install [spec]` and dispatching on `spec == null` is the idiomatic commander pattern and nothing else keys off the positional being required (the `--force/--offline/--integrity/--json/--dry-run/--no-validate/--no-hooks` options are orthogonal). Plan D4 (lines 60, 93) is correct.
- **C4 — self-bootstrap path resolution layout is correct.** Published bin is ESM at `dist/bin/manta.js`; the bus lands at `dist/bin/server.cjs` (both confirmed in the current `dist/bin/` listing AND by the bus `tsup.config.ts:6` `'bin/server'` entry → `.cjs`). They are **siblings** in `dist/bin/`, so `new URL('./server.cjs', import.meta.url)` resolves correctly from `manta.js`. ⚠️ Minor: the plan writes `new URL('../bin/server.cjs', import.meta.url)` (line 89) — `../bin/` is **wrong** if the bootstrap module lives in `dist/bin/` (it'd resolve to `dist/bin/bin/`... no — from a file *in* `dist/bin/`, `../bin/` → `dist/bin/`, which happens to work, but only by accident). If `runBootstrap` lives in `dist/commands/bootstrap.js` (per plan line 88 `src/commands/bootstrap.ts`), then from `dist/commands/` the correct relative path is `../bin/server.cjs`. So the plan's `../bin/` is **correct for a module under `dist/commands/`** but the plan's prose "(`../bin/` vs `./`)" should pin *which file* it's relative to. Net: path is right for the stated module location; just make the comment name the anchor file. Use `require.resolve`-from-package-root or `new URL` anchored on the bootstrap module's own `import.meta.url`, never `process.cwd()` — plan says this correctly.
- **C5 — §2 current-state table is accurate.** Spot-checked all rows: cli name/`private`/version/bin/deps (`package.json:2,4,3,18-19,30-40`) ✅; bus bin `manta-bus`→`dist/bin/server.cjs` + deps incl sdk/nanoid/proper-lockfile (`package.json:17-18,29-35`) ✅; orchestrator deps `@manta/bus`+`@manta/snapshot`+zod, no bin (`package.json:26-29`, no `bin` key) ✅; snapshot zod-only (`package.json:24`) ✅; skill-validator bin + commander/gray-matter/zod (`package.json:18-19,30-33`) ✅; e2e all-`@manta/*`+execa (`package.json:14-21`) ✅. Table is trustworthy.
- **C7 (partial) — no runtime asset/JSON reads in the bundled-away packages.** Grep for `import.meta.url`/`__dirname`/`readFileSync(...package.json)`/`new URL(` across `manta-cli/src` returns only: heartbeat-hook.ts:6 (the M2 problem) and `share/build-cast-origin.ts:53` (`new URL(value)` — parsing a *user-supplied* git URL string, not a filesystem asset — safe). No `@manta/*` package reads files relative to its own dir at runtime (the version constant is a literal, not a package.json read). `resolveJsonModule` is on but no `import x from './foo.json'` in src. So the "bundled-into-a-different-package breaks self-relative reads" hazard is **limited to M2** — everything else is clean. ✅

---

## One-paragraph summary

**APPROVE-WITH-MUST-FIX, 5 must-fix items.** The plan's strategy (single unscoped `manta`, bundle `@manta/*` via `noExternal`, real deps external+declared) is correct, and its highest-risk claim — the C1 dep closure (`commander, execa, semver, tar, yaml, zod, @modelcontextprotocol/sdk, nanoid, proper-lockfile, gray-matter`) — is **exactly right** (verified by exhaustive import grep). The blockers are completeness gaps, not strategy errors: (M1) the version string lives in three files, not one — `package.json`, `bin/manta.ts:144`, and `cli-version.ts:9`; (M2) bundling `@manta/bus` away deterministically breaks `heartbeat-hook.ts:13`'s `require.resolve('@manta/bus')` — this is bug #53's mechanism, so #53's fix is a hard Chunk-2 prerequisite, not an open question; (M3) the Chunk-1 rename grep misses the `@manta/e2e` `--filter @manta/cli` build calls and the 7 e2e files pinning `dist/bin/manta.cjs`; (M4) `mcp-preflight.ts:79` hard-codes the wrong `$(pwd)/packages/manta-bus/...` path in a user-facing error and must be in scope; (M5) the CLI `tsconfig.json` omits the `manta-skill-validator` project reference that `tsc -b` needs once the validator is a bundled build input. Beyond the must-fixes, the single biggest judgment call (A1): the plan's "core cast does not depend on skills" is **factually wrong** — priming.ts:7 makes "load the `manta-as-clone` skill" the clone's mandatory first action, and `manta cast` also requires a git repo (`git worktree add`), so the literal goal "install on a clean machine → cast works" is only true inside a Manta-enabled checkout; this precondition must be stated honestly before picking `1.0.0`. C2/C3/C4/C5 all verified sound.

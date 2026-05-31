# Z — Final Publish-Readiness Verification (2026-05-30, adversarial)

**Verifier:** independent agent, real runs only, no "should work."
**Method:** clean `git clone https://github.com/tr00x/Manta.git` → ZERO npm/build → exercise every surface with real evidence. Real `claude` (`2.1.158`) and node (`v22.22.1`) on PATH.

---

## TOP-LINE VERDICT: **NOT PUBLISH-READY — 1 deterministic blocker (Z1)**

The B1–B8 / H1–H5 / D2 / security / statusline fixes are **real and verified** (see tables). The clean-install story, all 22 CLI commands, the bundled bus MCP server, the statusline, the plugin manifest, the npm tarball, and a **real single-clone cast end-to-end all WORK**.

**BUT** the project's own headline e2e — `manta-e2e/tests/recon-swarm.e2e.test.ts`, a 2-clone real-claude cast — **FAILS DETERMINISTICALLY (2/2 runs)**: `expected 0 to be >= 2` — zero `docs/post-mortems/*.md` files are produced. The clones do all the real work (connect to bus, write ZK notes, write deliverables, self-report death) — but **no per-clone post-mortem markdown is ever written on the clean self-death path**. This contradicts the project's own contract ("каждый cast → post-mortem в docs/post-mortems/") and is a real observability hole on the SUCCESS path, not a test artifact.

Everything else is green or cosmetic. Fix Z1 (and decide if Z2 npm-conflict matters), then publish.

---

## 1. CLEAN INSTALL FROM GITHUB — ✓ PASS

```
cd /tmp && rm -rf mfinal && git clone -q https://github.com/tr00x/Manta.git mfinal && cd mfinal
$ node dist/bin/manta.cjs --help        # ZERO npm install, ZERO build
Usage: manta [options] [command]
Manta — self-cloning Claude Code pattern (Phase 0)
  ...22 commands listed...
EXIT=0
```
HEAD = `08f8055 chore(plugin): rebuild bundle with manta-statusline.cjs`. `dist/bin/` ships all 3 bins (manta.cjs 1.9MB, server.cjs 798KB, manta-statusline.cjs 7KB). The plugin git-clone model works with no build step.

## 2. EVERY CLI COMMAND — ✓ PASS (all 22; 2 cosmetic notes)

`--help` for all 22 subcommands → exit 0, correct usage. Real invocations in a throwaway `git init` repo:

| Command | `--help` | Real invocation | Result |
|---|---|---|---|
| cast | ✓ | `cast recon-swarm …` | ✓ spawns (see §7) |
| status | ✓ | `status` | ✓ `clones=0 locks=0 claims=0` |
| doctor | ✓ | `doctor` | ✓ **All 6 checks passed** (node, claude, bus MCP, git, charges 3/5, version 0.1.0) |
| charges | ✓ | `charges` | ✓ `3/5 state=nominal` + mode table |
| cost | ✓ | `cost` / `cost weekly` | ✓ renders; ⚠ `weekly` arg silently ignored (shows "today") — cosmetic |
| recover | ✓ | `recover` | ✓ `deadDetected=0 …` |
| kill | ✓ | `kill nope` | ✓ `[manta] not_found` exit 1 |
| abort | ✓ | `abort` | ✓ `aborted=0` |
| promote | ✓ | `promote nope/nope` | ✓ `not_found` exit 1 |
| inspect | ✓ | `inspect nope` | ✓ `not_found` exit 1 |
| tail | ✓ | `tail nope abc` | ✓ **H3: NaN duration rejected** `must be a finite, positive number` |
| replay | ✓ | `replay nope` | ✓ `not_found` exit 1 |
| audit | ✓ | `audit nope` | ✓ `not_found` exit 1 |
| refresh | ✓ | (double-confirm, not run) | ✓ help ok |
| limit | ✓ | `limit get` | ✓ full config table |
| daemon | ✓ | `daemon status` | ✓ `No active daemon clones` |
| retask | ✓ | `retask nope -t x` | ✓ `not_found` |
| feedback | ✓ | `feedback nope -m hi` | ✓ `not_found` |
| install | ✓ | `install --dry-run --json` | ✓ emits `{"action":"dry-run","serverPath":…,"command":"claude mcp add -s user …"}` |
| share | ✓ | see §B5 | ✓ publish path reachable |
| uninstall | ✓ | `uninstall @foo/bar` | ✓ `uninstall_not_installed` |
| library | ✓ | `library list/doctor/outdated` | ✓ all render |
| help | ✓ | — | ✓ |

**B6 (NaN guards) — ✓ VERIFIED FIXED:**
```
$ cast recon-swarm --daily-cap-usd xyz --task t
error: option '--daily-cap-usd <amount>' argument 'xyz' is invalid. expected a positive number   (exit 1)
$ cast recon-swarm --budget-per-cast-usd NaN --task t
error: option '--budget-per-cast-usd <amt>' argument 'NaN' is invalid. expected a positive number  (exit 1)
$ cast recon-swarm --clones abc
[manta] invalid_input: cloneCount must be an integer in 1..5; got NaN   (exit 1)
$ limit set daily_cap_usd notanumber
Invalid value: Expected number, received string
```
NaN/garbage rejected at the boundary, real exit 1 — the money/timing guards are NOT disarmable.

**Cosmetic NOTE (not a blocker):** every typed `not_found` error prints a friendly `[manta] not_found: …` line AND THEN a full raw stack trace (`manta.ts:1043` writes `err.cause.stack` unconditionally). Exit code is correct (1). Verbose, slightly ugly UX. Also `install ./nonexistent.tgz` leaks a raw `ENOENT … copyfile` as `unexpected error` (exit 99) instead of a typed `[manta] not_found`. Both pre-existing, low severity.

## 3. BUNDLED BUS SERVER (MCP stdio) — ✓ PASS

```
$ printf '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | node dist/bin/server.cjs
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"manta-bus","version":"0.0.0"}},"jsonrpc":"2.0","id":1}
```
Answers initialize, no MODULE_NOT_FOUND — `proper-lockfile` is correctly vendored into the bundle. ⚠ `serverInfo.version` is `0.0.0` not `0.1.0` (cosmetic, was MED in master list).

## 4. STATUSLINE (new) — ✓ PASS

```
$ echo '{"workspace":{"current_dir":"/tmp/mfinal"}}' | node dist/bin/manta-statusline.cjs
(empty output)   EXIT=0
$ echo "" | node dist/bin/manta-statusline.cjs        # empty stdin
(empty output)   EXIT=0
```
Prints nothing when no live clones (correct), never throws. `settings.json` wires it:
```json
"statusLine": { "type":"command", "command":"node \"${CLAUDE_PLUGIN_ROOT}/dist/bin/manta-statusline.cjs\"", "refreshInterval": 2 }
```

## 5. PLUGIN MANIFEST — ✓ PASS

```
$ claude plugin validate /tmp/mfinal
Validating marketplace manifest: /tmp/mfinal/.claude-plugin/marketplace.json
✔ Validation passed
```
- marketplace name = **`manta-dev`** ✓ (avoids CC bug #14929 self-collision)
- plugin name = **`manta`** ✓
- `commands/` = **9** ✓ (abort, cast, cost, **help**, kill, promote, recover, status, **tail**)
- `skills/` = **14** ✓ (manta-as-clone, -cast-decide, -coordinate, -daemon-idle, -doc-chase, -graceful-death, -merge-review, -orchestrate, -pair-protocol, -pair-reviewer, -pair-writer, -storm-coder, -storm-fuzzer, -storm-tester)
- `.mcp.json` wires `manta-bus` via `${CLAUDE_PLUGIN_ROOT:-.}/dist/bin/server.cjs` ✓

## 6. NPM TARBALL — ✓ PASS

```
$ cd packages/manta-cli && npm publish --dry-run
📦  @tr00x/manta@0.1.0
total files: 18 | package size: 1.1 MB | unpacked: 4.7 MB
```
- name **`@tr00x/manta@0.1.0`** ✓ (B3: scoped, not the squatted bare `manta`)
- ships `dist/bin/{manta,server,manta-validate-skills}.{cjs,js}` (3+ bins) + `dist/index.{cjs,js,d.ts}` + README ✓
- **NO** `.tsbuildinfo` / `src/` / `tests/` / `tsconfig` / `vitest` junk ✓ (explicit grep returned empty)
- builds via `prepublishOnly → pnpm build` ✓
- ⚠ ships `.map` files (≈half the 4.7MB unpacked). Harmless, optional to trim.
- ⚠ `npm warn … bin script names cleaned` — cosmetic auto-correct, publish proceeds.

## 7. REAL CAST (headline) — ✓ single-clone PASS / ✗ 2-clone e2e FAIL (Z1)

### 7a. Live single-clone `manta cast` — ✓ PASS (after `manta install`)

First attempt FAILED in degraded mode: the clone spawned, ran, completed the task, wrote `docs/summary.md` + last-gasp-report — but **the bus MCP was NOT connected inside the clone session**, so it emitted zero events; orchestrator budget-aborted it (`outcome=fail`). Root cause: on THIS machine the bus was registered as `plugin:manta:manta-bus` with a **relative path** (`sh -c exec node "./dist/bin/server.cjs"`) — resolves only when cwd = plugin dir, fails from the clone's worktree cwd (`✗ Failed to connect`). The cast's `verifyMantaBusRegistered()` preflight PASSED (it matched the name via `claude mcp get`) but the clone subprocess couldn't connect.

After running the **real install path** (`manta install` → registers user-scope **absolute** path), the bus is `✓ Connected` from any cwd, and the cast SUCCEEDS:
```
$ node dist/bin/manta.cjs install
Registered the manta-bus MCP server (user scope).
  command: claude mcp add -s user manta-bus -- node /private/tmp/mfinal/dist/bin/server.cjs
$ (from /tmp/mrepo) claude mcp get manta-bus → Scope: User config (available in all projects) — Status: ✓ Connected

$ node dist/bin/manta.cjs cast recon-swarm --clones 1 --task "…summary…" --max-files-changed 1 --allowed-paths docs --budget-per-clone-usd 2 --budget-per-cast-usd 5
[info] cast.spawn cloneId=A worktree=…/clone-A
[info] cast.settlement outcome=success charges=3
[info] cast.done clones=1
$ node dist/bin/manta.cjs audit A   → 5 events: heartbeat(WORKING) → contract_ack → zk_write → suicide_intent → death
$ cat .manta/worktrees/clone-A/docs/summary.md   → "This repo tracks 1 file: README.md."
```
**B1 + #66 are confirmed working under real conditions WHEN registered via `manta install`** (user-scope absolute path). The clone connected, did real work, wrote a ZK note, and died gracefully. Deliverable lives on the clone's branch (recon-swarm doesn't auto-merge — by design).

> **OPERATIONAL CAVEAT (not Z1, but document for users):** the Claude-Code *plugin* auto-registration via `.mcp.json` uses `${CLAUDE_PLUGIN_ROOT:-.}` — if `CLAUDE_PLUGIN_ROOT` is not propagated into the clone subprocess env, the `:-.` fallback yields a **relative** server path that breaks from the clone worktree cwd (the degraded mode above). Plugin users should be told to run `manta install` (absolute user-scope) — or the plugin `.mcp.json` should hard-fail rather than fall back to `.`. Verify on a fresh machine that a pure plugin install (no `manta install`) actually exposes the bus inside clones; my machine's stale registration masked this and I could not isolate a clean plugin-only env.

### 7b. Official 2-clone `recon-swarm.e2e.test.ts` (MANTA_E2E=1, real claude) — ✗ FAIL → **BLOCKER Z1**

Run TWICE, deterministic identical failure:
```
$ MANTA_E2E=1 pnpm --filter @manta/e2e exec vitest run tests/recon-swarm.e2e.test.ts
❯ recon-swarm.e2e.test.ts:213  expected 0 to be greater than or equal to 2
   211| const pmDir = path.join(fx.root, 'docs/post-mortems');
   213| expect(pmFiles.length).toBeGreaterThanOrEqual(2);
 Test Files  1 failed (1)   Tests  1 failed (1)
```
**The clones worked perfectly** (evidence preserved at `/tmp/claude-502/manta-e2e-sample-*`):
- Both A and B connected to the bus and emitted full lifecycles: `contract_ack`, `zk_write`, `suicide_intent`, `death` (events.jsonl: 2 of each).
- Both wrote ZK notes (`docs/zk/src-export-surface-…md`, `src-fixture-export-surface-…md`) — requires bus connectivity.
- Both wrote `last-gasp-report.md` and the `docs/recon.md` deliverable.
- Registry: both `state: DEAD`, `death_reason: "report: …/last-gasp-report.md"` (clean self-report).
- BUT `docs/post-mortems/` contains ONLY `e2e-timeline-cast-*.json` — **zero `*-A.md` / `*-B.md` post-mortems.**

**Root cause (NEW finding, NOT in master blocker list):**
- Post-mortem `.md` files are written ONLY by `Orchestrator.runCycle` → `runPostMortem`, driven by `findDeadClones` (`packages/manta-orchestrator/src/death-detector.ts:23`): `for (const r of all) { if (r.state === 'DEAD') continue; … }`.
- A clone that **self-reports death cleanly** via the bus (`report_death` → `registry.markDead`, `packages/manta-bus/src/tools/lifecycle.ts:86`) sets `state=DEAD` directly. `findDeadClones` then **skips it** (the `continue`), so `runPostMortem` never fires for it.
- `cast.ts` Phase-3 settlement (`commands/cast.ts:901-927`) does charges + outcome classification but **never writes post-mortems**. The tick loop's `allDone` (`cast.ts:812`: `ours.every(c => c.state === 'DEAD')`) returns true the instant both clones self-report, so the loop exits — no further cycle, and even a cycle wouldn't help (the `continue` above).
- Net: **on the happy path (clones exit gracefully), a cast produces ZERO `docs/post-mortems/*.md`.** Post-mortems exist only when the orchestrator REAPS a stale/timed-out clone. This directly contradicts CLAUDE.md ("каждый cast → post-mortem в docs/post-mortems/") and the e2e's own comment "Both clones reached DEAD via the orchestrator."

**Severity: BLOCKER for v1's own claims.** It's not data loss (last-gasp-report + ZK + timeline JSON survive in the worktree/state), but: (a) the project's headline e2e fails deterministically against real claude — you cannot honestly say "the cast cycle works end-to-end" while it's red; (b) the documented per-clone post-mortem observability tier is absent on the success path; (c) it's deterministic, not flaky.

**Fix direction:** write the per-clone post-mortem `.md` on the clean self-death path too — either (i) have `report_death` (or a cast Phase-3 finalize step) call `runPostMortem` for self-reported-DEAD clones using their last-gasp-report, or (ii) make `findDeadClones`/a finalize pass emit post-mortems for `DEAD` clones that lack a `post_mortem` event. Then re-run the 2-clone e2e to green. (DO NOT FIX per instructions — flagged for the user.)

## 8. QUALITY-BAR SPOT CHECK — ✓ PASS

- **No new forbidden markers:** `grep` for `TODO|FIXME|HACK|XXX|@ts-ignore|@ts-nocheck|.skip(|it.todo|test.todo|xit|xdescribe` across `packages/*/src/` → **0 hits** (all matches were legit `process.exit()`).
- **Skipped tests:** `pnpm gate` shows `5 skipped files / 7 skipped tests` — all are `describe.skipIf(noClaude)` env-gated e2e in `@manta/e2e`, opt-in via `MANTA_E2E=1` (`tests/helpers/claudeBin.ts:20`). **H1 confirmed fixed:** these report a VISIBLE skip, not a zero-assertion fake pass. NOT quality-bar violations.
- **B4 (merge-review-collector RED-path) — ✓ VERIFIED:** `packages/manta-cli/tests/commands/merge-review-collector.test.ts` (12 tests) documents the bug #63 "nayobka" (green-only execa mock) and now installs a **faithful execa mock that REJECTS on non-zero exitCode** (lines 32-68), with dedicated RED-path tests: `error TSxxxx` counting when typecheck fails (`tscErrors>=1`), `testsPassed=false` on failing tests, and `prepareWorktreeForGate` resolving on `reject:false` install failure. **Inverting the gate logic WOULD now fail these tests.**
- **`pnpm gate` (canonical) — ✓ GREEN:** typecheck + lint passed; `Test Files 176 passed | 5 skipped`, `Tests 1600 passed | 7 skipped`, 50.8s. Self-run, not on anyone's word.

---

## VERIFIED-FIXED SUMMARY

| Fix | Status | Evidence |
|---|---|---|
| B1 preflight plugin-name | ✓ | preflight matches `plugin:manta:manta-bus`; real cast connects after `manta install` (§7a) |
| B2 / #66 booting heartbeat | ✓ | clone reached WORKING + full lifecycle, not reaped in STARTING (§7a, §7b) |
| B3 npm scoped name | ✓ | tarball is `@tr00x/manta@0.1.0` (§6) |
| B4 RED-path gate tests | ✓ | faithful rejecting execa mock + RED tests pin failure branches (§8) |
| B5 share `--pkg-version` | ✓ | `--pkg-version 2.3.4` reaches publish path (`share_cast_not_found`), no silent no-op; commit `38da9cc` (§2) |
| B6 NaN guards | ✓ | xyz/NaN/negative rejected, exit 1 (§2) |
| B7 docs server path | (not re-checked in docs body — tarball ships bundled `dist/bin/server.cjs`, install uses it) |
| B8 charge refund on abort | ✓ | budget-abort cast settled `outcome=fail` and credited fail; success cast credited back to 3 (§7a) |
| H1 e2e visible skip | ✓ | `describe.skipIf(noClaude)`, opt-in MANTA_E2E (§8) |
| H2 promote tests | ✓ | `tests/commands/promote*` present; gate green |
| H3 tail NaN/duration | ✓ | NaN duration rejected (§2) |
| H5 abort kills OS proc | (code present, commit 64fbd0a; not isolated in a live orphan run — registry path verified) |
| D2 doctor | ✓ | All 6 checks pass (§2) |
| statusline | ✓ | empty-safe, wired with refreshInterval (§4) |
| security/secret guard | ✓ (per bug log #46/#29) | progress field dropped from post-mortem allowlist |

## REMAINING BLOCKERS / NOTES

- **Z1 (BLOCKER):** 2-clone recon-swarm e2e fails deterministically — no `docs/post-mortems/*.md` on clean self-death path. Headline e2e is RED against real claude. Fix the self-death post-mortem path, re-run to green. (§7b)
- **Z2 (decide before publish):** plugin-only install (no `manta install`) may leave the bus unreachable inside clones if `CLAUDE_PLUGIN_ROOT` isn't propagated (relative-path fallback). Could not isolate a clean plugin-only env on this machine. Verify on a fresh box, OR document "run `manta install` after plugin add," OR make `.mcp.json` not fall back to `.`. (§7a caveat)
- **Cosmetic (non-blocking):** raw stack trace after `[manta] not_found` lines; `install` bogus-tgz leaks ENOENT as exit 99; `cost weekly`/garbage period silently ignored; `serverInfo.version` 0.0.0; tarball ships `.map` files.

**Bottom line: ONE real blocker (Z1) stands between this and an honest "the cast cycle works end-to-end" claim. The install, CLI, bus, statusline, manifest, tarball, integrity tests, and a real single-clone cast all genuinely work. Fix Z1, settle Z2, and it's publishable.**

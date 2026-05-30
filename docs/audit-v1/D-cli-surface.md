# Audit D — CLI Surface (from-source built CLI)

**Scope:** Every subcommand exposed by the from-source built CLI, exhaustively. Sister auditor covers the plugin clean-install path (non-overlapping).

**CLI entry:** `node packages/manta-cli/dist/bin/manta.cjs`
**Build:** `pnpm -r build` (green; `manta-orchestrator` + all packages built clean)
**Version:** `0.1.0`
**Test rig:** throwaway repo `/tmp/cli-audit` (`git init`, no commits, no `.manta` state), plus non-git dirs `/tmp` and `/`.

**Mandate:** AUDIT ONLY — nothing was fixed. Files touched on disk: only the throwaway repo's `.manta/` (created by `limit set`), nothing in the manta repo except this report.

Commands enumerated from `--help`: `cast, status, kill, abort, recover, promote, inspect, tail, replay, audit, cost, charges, refresh, limit, daemon, retask, feedback, install, share, uninstall, library` (+ `help`).

---

## Per-command results

| Command | `--help` coherent? | Real run (clean state) | Validation | Verdict |
|---|---|---|---|---|
| `cast` | yes (very detailed) | dry-run works | **split: budget flags unvalidated** | FRAGILE (see F1, F2) |
| `status` | yes | clean (`0 clones`) | n/a | OK |
| `kill` | yes | clean not_found, **+stack trace** | n/a | minor (F7) |
| `abort` | yes | clean (`Aborted 0`) | n/a | OK |
| `recover` | yes | clean | n/a | OK |
| `promote` | yes | **exit 99 unexpected error / raw stack on bad target** | partial | BROKEN (F3) |
| `inspect` | yes | clean not_found, **+stack trace** | n/a | minor (F7) |
| `tail` | yes | **never streams; NaN-duration disarms deadline; <10s silently clamped** | weak | BROKEN (F5) |
| `replay` | yes | clean not_found, **+stack trace** | format unchecked* | minor (F7) |
| `audit` | yes | clean not_found, **+stack trace** | format/since unchecked* | minor (F7) |
| `cost` | thin | works for today | **`week`/garbage period silently ignored** | FRAGILE (F4) |
| `charges` | yes | clean, rich output | n/a | OK |
| `refresh` | yes | clean (`No cooldown active`) | double-confirm not reachable empty | OK |
| `limit` | yes | get/set work, Zod-validated | **good** | OK (minor F8) |
| `daemon` | yes | clean (`No active daemon`) | n/a | OK |
| `retask` | yes | clean not_found (no stack) | n/a | OK |
| `feedback` | yes | clean not_found (no stack) | requiredOption fires | OK |
| `install` | yes (detailed) | dry-run safe, offline/integrity guards | **good** | OK |
| `share` | yes | **`--version <v>` collides with global `-V/--version`: prints `0.1.0`, exit 0, never runs** | broken | **BLOCKER (F6)** |
| `uninstall` | yes | clean not_installed | minor: bad spec → "not installed" | OK (minor F9) |
| `library` | yes | list/show/doctor/outdated all clean | good | OK |

\* `audit`/`replay` failed on not-found before format/since validation could be reached in the clean repo; format coercion not exercised against a real cast.

---

## Findings (severity-ranked)

### F6 — `share --version <semver>` (space form) is intercepted by global `--version`, command silently no-ops — **BLOCKER**

**Command (exactly as --help instructs):**
```
manta share castX --name @s/n --version 1.0.0 --non-interactive
```
**Output:**
```
0.1.0
```
exit code **0**, stdout = `0.1.0`, stderr empty. The `share` action **never executes**.

**Proof it is the global version flag:**
- `--version=1.0.0` (equals form) → `[manta] share: share_cast_not_found: cast castX not found` (correct, command runs)
- `--version 1.0.0 --name @s/n` (space form, any order) → `0.1.0`, exit 0
- omitting `--version` → `error: required option '--version <semver>' not specified` (so the subcommand option IS registered)

**Root cause:** `bin/manta.ts:146` calls `.version('0.1.0')` on the root program, registering global `-V, --version`. `bin/manta.ts:664` declares `.requiredOption('--version <semver>')` on `share`. With the space-separated form, commander's global `--version` action fires first, prints the program version, and exits 0 before the subcommand value is bound. The natural, documented invocation form is completely broken AND it exits 0 (looks like success while building nothing). A user following the help text will believe they published/bundled a package when nothing happened.

**Severity rationale:** documented happy-path of a release-publishing command is non-functional and fails silently with success exit code. This is the worst combination (silent + exit 0).

---

### F1 — `--daily-cap-usd <garbage>` injects NaN that disarms the daily budget ceiling — **BLOCKER (bug #60 class)**

**Commands:**
```
manta cast recon-swarm --clones 1 --daily-cap-usd xyz --dry-run
manta cast recon-swarm --clones 1 --daily-cap-usd NaN --dry-run
```
**Output (both):**
```
[info] gate.dry_run ... dailyCap=NaN dailySpent=0 dailyRemaining=NaN ...
Dry run complete for cast cast-... No clones spawned.
```
exit **0** — cast proceeds with `dailyCap=NaN`.

**Root cause:** `bin/manta.ts:183` — `--daily-cap-usd` uses raw `parseFloat` as the commander coercer; `parseFloat("xyz")` = `NaN`, passed straight through as `dailyCapUsdOverride: NaN`. In `budget/pre-spawn-gate.ts:38` `dailyCap = override ?? config`, and the guard at line 95 `if (projectedSpend > dailyCap && !force)` evaluates `x > NaN` → always `false`. **The daily budget ceiling is silently bypassed entirely.** This is the exact bug #60 pattern (NaN that disarms a guard). Contrast: the safety-timeout flags (`--heartbeat-timeout-ms`, `--startup-grace-ms`, `--distill-threshold-bytes`) correctly use `parsePositiveIntOption` which rejects NaN. The money guard does not.

---

### F2 — `--budget-per-cast-usd` / `--budget-per-clone-usd` / `--cycle-interval-ms` / `--tick-budget-ms` accept NaN/negative silently — **HIGH (bug #60 class)**

**Commands & output:**
```
$ manta cast recon-swarm --clones 1 --budget-per-cast-usd NaN --dry-run   → exit 0, proceeds (default 15 used)
$ manta cast recon-swarm --clones 1 --budget-per-cast-usd abc --dry-run   → exit 0, proceeds
$ manta cast recon-swarm --clones 1 --budget-per-clone-usd -5 --dry-run   → exit 0, proceeds (negative accepted)
$ manta cast recon-swarm --clones 1 --cycle-interval-ms abc --dry-run     → exit 0, proceeds
$ manta cast recon-swarm --clones 1 --tick-budget-ms NaN --dry-run        → exit 0, proceeds
```
Only `--budget-per-cast-usd 0` is caught (`cumulative budget ... exceeds --budget-per-cast-usd=$0`), and `--max-files-changed abc/-5` is caught downstream (`must be a non-negative integer`). `--clones abc/0/99/-3` is caught downstream by the runtime range check (`cloneCount must be an integer in 1..5`).

**Root cause:** these flags are stored as strings and parsed with raw `parseInt`/`parseFloat` inside the action (`bin/manta.ts:259-267`) with no finite/positive guard. The resulting NaN/negative is silently absorbed: `NaN > cap` is false, so a NaN per-cast/per-clone budget disarms its own cap; a NaN `cycle-interval`/`tick-budget` would feed the orchestrator loop a NaN deadline. Dry-run doesn't reach the orchestrator loop, so the NaN-timing damage isn't observable in dry-run — but the parse-time gap is real for a live cast. **Inconsistent with F1's safe-timeout flags using `parsePositiveIntOption`.**

---

### F5 — `tail` does not stream, NaN duration disarms the deadline, sub-10s duration silently clamped — **HIGH**

**Commands:**
```
$ timeout 8 manta tail nonexistent-clone 1      → exit 124 (timeout killed it; did NOT stop after 1s)
$ timeout 8 manta tail nonexistent-clone abc    → exit 124 (NaN duration → no deadline)
```
**Three distinct defects, root cause in `commands/tail.ts` + wiring `bin/manta.ts:357-368`:**

1. **Not real-time despite `--help` "Stream events for a clone in real-time".** `runTailCommand` buffers every line into an array (`lines.push`) and only emits the joined buffer on return (`tail.ts:21,38-39`). Nothing prints until the command exits. Help is misleading.
2. **`[durationSeconds] < 10` silently clamped to 10s.** `bin/manta.ts:367` `Math.min(Math.max(durationMs, 10_000), 3_600_000)`. `tail clone 1` runs ~10s, not 1s — not documented in `--help`.
3. **NaN duration disarms the deadline (bug #60 class).** `tail clone abc` → `parseInt("abc")*1000 = NaN` → `Math.max(NaN,10000)=NaN` → `deadline = now + NaN = NaN` → loop condition `now() >= NaN` is always false (`tail.ts:63`), so the deadline never fires. For a *nonexistent* clone it is rescued at 10s by the not-found grace throw (`tail.ts:85`); for an **existing** clone there is no grace throw, so `tail <live-clone> abc` would **run forever**.

---

### F3 — `promote` leaks raw internal errors as "unexpected error" with exit 99 instead of clean CliError — **MED**

**Commands:**
```
$ manta promote castX/cloneY
[manta] unexpected error: cast not found: castX
BusNotFoundError: cast not found: castX
    at CastsStore.read (.../manta.cjs:1233:32)
    ... (full stack) ...
   exit 99
```
```
$ manta promote /
[manta] unexpected error: busPaths.castFile: invalid cast_id:
Error: busPaths.castFile: invalid cast_id:
    at Object.castFile (.../manta.cjs:555:15)
   exit 99
```
**Contrast:** `kill nope`, `inspect nope`, `audit nope`, `replay nope` all map the same `BusNotFoundError` to a typed `[manta] not_found:` with **exit 1**. `promote` does not wrap it → falls through to the generic `[manta] unexpected error:` branch (`bin/manta.ts:1010`) with **exit 99**. Also, `promote /` (empty cast id half) leaks an internal path-construction error rather than a validation message — `promote` validates the `/` separator (`promote badformat` → clean `expected format castId/cloneId`) but not the emptiness of either half. A non-existent cast and a malformed target are both user errors and should be exit-1 typed errors, not exit-99 unexpected-error crashes.

---

### F4 — `cost [period]`: `week`/garbage period silently ignored; `--help` says "weekly" but only `week` is recognized — **MED**

**Commands & output (all three identical "today" view):**
```
$ manta cost weekly        → renders TODAY's budget
$ manta cost bogusperiod   → renders TODAY's budget
$ manta cost week          → renders TODAY's budget (in clean repo, 0 spend — indistinguishable, but see root cause)
```
**Root cause:** `bin/manta.ts:421` `const p = period === 'week' ? 'week' : 'today'`. Any value other than the exact token `week` silently maps to `today`. The `--help` text says "Show daily/**weekly** spend summary" — a user typing the natural `cost weekly` gets daily data with no error. `cost.ts:126` does branch on `period === 'week'` to `renderWeek`, so the weekly view exists but is only reachable via the exact undocumented token `week`. An invalid period is never rejected.

---

### F7 — Routine not-found errors dump a full Node stack trace; verbosity is inconsistent across commands — **LOW**

`kill`, `inspect`, `audit`, `replay` print a clean `[manta] not_found: ...` line **followed by a raw `BusNotFoundError` stack trace** (4-5 frames pointing into `manta.cjs`). Root cause: the top-level handler (`bin/manta.ts:1002-1005`) prints `cause.stack` whenever a CliError carries a `cause`. `retask` and `feedback` produce a clean one-line not_found with **no** stack (no cause attached). So a routine "clone not found" sometimes spews a stack and sometimes doesn't — inconsistent and noisy for an expected user error. Same noise appears on the non-git-dir error for `cost`/`charges`/`status` (clean `[manta] invalid_input: not a git repo root` line + a raw `ENOENT ... at async Object.access` stack).

---

### F8 — `limit set <key> -10` reports "unknown option '-10'" instead of an invalid-value message — **LOW**

```
$ manta limit set daily_cap_usd -10
error: unknown option '-10'
```
Commander parses the leading-`-` value as a flag. The rejection is correct (negative should be refused — `per_cast_usd 0` is cleanly rejected by Zod with "Number must be greater than 0"), but the message misleads. Also `limit set charges.max 999` is accepted with no upper sanity bound. Note keys are snake_case (`daily_cap_usd`); `limit set dailyCapUsd abc` → "Unknown key" (camelCase rejected) — fine, but worth a doc note. Otherwise `limit` is the best-validated command (Zod-backed, rejects `abc`/`NaN`/`0`, exit 1 on unknown key).

---

### F9 — `uninstall <bad-spec>` reports "not installed" rather than "invalid spec" — **LOW**

```
$ manta uninstall garbage      → [manta] uninstall: uninstall_not_installed: garbage is not installed
```
`--help` documents the spec as `@scope/name`. A spec with no scope (`garbage`) is treated as a lookup miss rather than a format error. Harmless (correct exit 1) but slightly imprecise.

---

## What works well (no defects)

- `status`, `abort`, `recover`, `charges`, `daemon status/stop`, `refresh` — all handle empty state cleanly with informative output and exit 0.
- `install` — dry-run is genuinely side-effect-free, `--offline` correctly refuses npm specs, `--integrity badhash` cleanly rejects (`must be sha256-<base64>`), `--json` emits a single clean line. Best-behaved FS/network command.
- `library list/show/outdated/doctor` — all clean on empty state, `--json` valid.
- `limit get/set` — Zod-validated, rejects garbage and zero, exit 1 on unknown key.
- `--clones` and `--max-files-changed` — properly range/integer-validated downstream.
- Unknown subcommand (`frobnicate`) and bare `manta` — clean commander usage output.
- Not-found exit codes are consistently **1** everywhere **except `promote`** (which is 99 — see F3).

---

## Ranked list of broken / fragile commands

1. **`share` — BLOCKER (F6).** Documented `--version <v>` space form intercepted by global `-V/--version`; prints `0.1.0`, exits 0, command never runs. Silent failure with success exit code.
2. **`cast --daily-cap-usd` — BLOCKER (F1).** Garbage → NaN silently disarms the daily budget ceiling (bug #60 class). Money guard bypassed.
3. **`cast` budget/timing flags — HIGH (F2).** `--budget-per-cast-usd`/`--budget-per-clone-usd`/`--cycle-interval-ms`/`--tick-budget-ms` accept NaN/negative silently; raw `parseInt`/`parseFloat` with no guard, inconsistent with the safe-timeout flags.
4. **`tail` — HIGH (F5).** Doesn't stream (buffers to end) despite "real-time"; NaN duration disarms the deadline (runs forever on a live clone); sub-10s duration silently clamped.
5. **`promote` — MED (F3).** Unwrapped `BusNotFoundError` / path error → "unexpected error" exit 99 instead of typed not_found exit 1; `promote /` leaks internal path error.
6. **`cost` — MED (F4).** `week`/garbage period silently ignored; `--help` says "weekly" but only exact token `week` works; no rejection of invalid period.
7. **`kill`/`inspect`/`audit`/`replay` — LOW (F7).** Dump raw stack traces on routine not-found; inconsistent with `retask`/`feedback`.
8. **`limit` — LOW (F8).** `-10` value mis-reported as "unknown option"; no upper bound on `charges.max`.
9. **`uninstall` — LOW (F9).** Invalid spec → "not installed" instead of "invalid spec".

**Common root-cause cluster:** Findings F1, F2, F5 are all the **bug #60 class** — raw `parseInt`/`parseFloat` coercers passing NaN downstream where a guard uses `x > NaN` / `now >= NaN` (always false), silently disarming the guard. The fix pattern already exists in-tree (`parsePositiveIntOption`, used for timeout flags) but was not applied to the money/timing flags. F6 (`share --version` collision) and F3 (`promote` unwrapped errors) are independent.

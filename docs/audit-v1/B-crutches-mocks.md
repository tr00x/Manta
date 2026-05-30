# Audit B — Crutches, Mocks, and Fake/Nayobka Tests

Date: 2026-05-30
Scope: `packages/*/src` + `packages/*/tests` across all 6 packages (manta-bus, manta-cli, manta-e2e, manta-orchestrator, manta-skill-validator, manta-snapshot).
Method: adversarial grep sweeps + manual read of every flagged site. Audit only — nothing fixed.

## Executive summary

The codebase is, on the whole, unusually disciplined against the patterns this audit hunts for. **Clean on:** `TODO`/`FIXME`/`HACK`/`XXX` markers in src (0 hits), `it.skip`/`test.skip`/`describe.skip`/`it.todo`/`xit`/`.only` (0 hits), env-switch behavior swaps (`if NODE_ENV==='prod' else mock` — 0 hits), and silent `catch {}` that swallows real errors (every catch block read carries a documented fallback rationale). Only **one** test file uses `vi.mock` of a module; the rest use injected DI seams, which is the correct pattern.

That said, there are real findings. The headline one is a **fake-green gate-executor test** that mocks `execa` to always return `{exitCode:0}` and therefore never exercises the RED path of the very gate it claims to test — exactly the nayobka class flagged. Plus two untested production commands, an env-availability soft-skip that lets the e2e acceptance suite pass with zero assertions, and a couple of `// Reason:`-less eslint-disables.

---

## Findings

### F1 — `merge-review-collector.test.ts` mocks execa green-only; never tests a RED gate (BLOCKER)

File: `packages/manta-cli/tests/commands/merge-review-collector.test.ts:11-19, 36-39`

```ts
const { execaMock, execaCalls } = vi.hoisted(() => {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const fn = vi.fn(async (cmd: string, args: readonly string[] = []) => {
    calls.push({ cmd, args });
    // `[]` parses as empty eslint json (0 warnings/errors); exitCode 0 = green.
    return { exitCode: 0, stdout: '[]', stderr: '' };
  });
  return { execaMock: fn, execaCalls: calls };
});
vi.mock('execa', () => ({ execa: execaMock }));
```

Every test in the suite asserts only **command ordering** (`installIdx < buildIdx < tscIdx`, the lint scope string, "uses `pnpm test` not `pnpm -r test`"). The mock unconditionally returns `{exitCode:0, stdout:'[]'}`, so the production code under test — `runTests`, `readTscErrors`, `readEslintResults` in `merge-review-collector.ts` — can **never** take its failing branch:

- `runTests` (src:76-86) returns `true` because `execa` resolves; the `catch { return false }` RED path is never reached. **No test ever asserts `testsPassed === false`.**
- `readTscErrors` (src:149-164) returns `0` because `execa` resolves; the error-line-parsing branch (`errorLines.length`, `Math.max(..., 1)`) is dead under this mock.
- `readEslintResults` (src:166-203) returns `{warnings:0, errors:0}` from `'[]'`; the `catch` + JSON-from-stderr re-parse + `{warnings:0, errors:1}` fallback are all unexercised.

This is the precise failure mode the project's own bug log warns about: **bug #63 was a scorer/gate divergence that false-negatived real work.** A test suite that only proves "the right commands run in the right order" but never proves "a failing typecheck produces `tscErrors > 0`" or "a failing test run produces `testsPassed: false`" gives false confidence in the gate executor. If someone inverts the `try/catch` in `runTests` (return `true` on failure), **this suite stays green.**

Why it proves nothing about correctness: the assertions are about the *inputs the code emits* (argv), tautologically derived from reading the source, not about the *outputs the code computes* from gate results. The metric-collection logic — the whole point of the module — is untested for any non-green outcome.

Contrast with the correct pattern in the same repo: `merge-all.test.ts` (orchestrator) injects `runQualityGate` as a DI seam and varies it across `gatePass()`, `gateFail()`, `gateEmptyDiff()`, all-fail → verdicts `all_merged`/`partial_merge`/`no_merges`/`conflict_escalation`. That exercises real branch logic. `merge-review-collector.test.ts` should do the analogous thing: make `execaMock` return `exitCode: 1` / TS-error stderr / eslint-error JSON and assert `testsPassed:false`, `tscErrors>0`, `eslintErrors>0`.

Severity: **BLOCKER** — it is the gate-executor for the merge scorer, the exact subsystem with a recent false-negative bug (#63), and it has zero RED-path coverage.

---

### F2 — e2e acceptance suites pass with ZERO assertions when `claude` is unavailable (HIGH)

Files (same pattern in all real-claude e2e suites):
- `packages/manta-e2e/tests/recon-swarm.e2e.test.ts:49-53`
- `packages/manta-e2e/tests/forking-realities.e2e.test.ts`, `bug-hunt.e2e.test.ts`, `refactor-wave.e2e.test.ts`, `charge-system.e2e.test.ts`, `manta-library.e2e.test.ts`, `transcript-inheritance.e2e.test.ts`

```ts
it('runs a 2-clone recon-swarm cast and produces post-mortems and ZK notes', async () => {
  if (!claude.available) {
    console.warn(`[recon-swarm.e2e] SKIPPED: ${claude.reason}`);
    return;          // <-- test PASSES, having asserted nothing
  }
  ...
}, 28 * 60 * 1000);
```

This is a soft-skip-as-pass. It is not an `it.skip` (so the marker-scan is clean), but the effect is worse: in any environment without a real `claude` binary (default CI, a clone running the unit gate), these tests report **green** while exercising none of the spawn/bus/orchestrator/CLI wiring they exist to prove. The project leans on these as the *empirical* acceptance gate ("pack→extract→run real bin" per the memory note `feedback-no-fake-tests`), yet `pnpm test` can pass with every one of them no-opping.

Note: this is partly by design (they're env-gated heavyweight suites, and `transcript-inheritance.e2e.test.ts:147` documents "SKIPS in the unit gate"). The risk is that an early-`return` silent pass is indistinguishable from a real pass in the test report — a reviewer reading "all green" cannot tell whether the e2e path ran. A `ctx.skip()` (vitest runtime skip) would at least mark them SKIPPED rather than PASSED. As written, "green CI" overstates what was verified.

Severity: **HIGH** — masks whether the load-bearing empirical gate actually executed; violates the spirit of "tests exercise REAL behavior" / "acceptance gates empirical."

---

### F3 — Production command `promote.ts` has no test (HIGH)

File: `packages/manta-cli/src/commands/promote.ts` (full command, ~130 lines: reads cast manifest, validates roster, finds merge_review event, moves worktrees to graveyard, removes worktree).

No test file exists (`tests/commands/promote*` absent; the only grep hits for "promote" are substring false-positives in unrelated files). This is a fully-implemented, side-effecting command (it calls `moveWorktreeToGraveyard` and `removeWorktree` — destructive git operations) with **zero** coverage. Violates the ≥80%-coverage-per-package bar in CLAUDE.md and the "every feature ships with tests" rule. A regression in roster validation or the graveyard move would be caught by nothing.

Severity: **HIGH** — untested destructive command.

---

### F4 — Production command `zk-harvest` has no test (MED)

File: `packages/manta-cli/src/commands/zk-harvest.ts`

No test references it anywhere in `packages/*/tests`. Same coverage-bar violation as F3; lower severity only because (pending a read of its body) it is presumably read-mostly rather than destructive.

Severity: **MED** — untested command.

---

### F5 — eslint-disable without adjacent `// Reason:` (MED)

The project rule (CLAUDE.md / `feedback-skill-priming-enforcement`): `eslint-disable`/`@ts-ignore` must carry `// Reason: <concrete justification>`. Violations:

- `packages/manta-bus/tests/server.test.ts:64`
  ```ts
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  zkWrite: () => Promise.reject('plain string failure'),
  ```
  No `// Reason:`. (In-context it's deliberately testing rejection with a non-Error value, which is legitimate, but the justification is unwritten — the rule is "no silent suppress.")

- `packages/manta-cli/tests/spawner/pre-register.test.ts:162` — has a trailing explanation (`vi mock pattern; runner.run does not access this`) but **not** in the mandated `-- Reason:` form.

- The four `no-console` disables in e2e tests (`forking-realities.e2e.test.ts:29`, `recon-swarm.e2e.test.ts:38`, `manta-library.e2e.test.ts:165,178,291,293`) use `-- forensics signal…` / `-- diagnosis aid…` rather than the literal `Reason:` token. Substantively justified; formally off-spec.

Severity: **MED** for `server.test.ts:64` (no justification at all), **LOW** for the rest (justified, wrong keyword). These are in tests, not merged src, so blast radius is limited.

---

### F6 — `runtime.ts` `dispose()` is an empty placeholder (LOW — acceptable, flagged for visibility)

File: `packages/manta-cli/src/runtime.ts:135-137`
```ts
dispose: async () => {
  // No resources to release in Phase 0 — placeholder for daemon-mode.
},
```

A no-op function whose name promises resource release. Documented as forward-compat for daemon-mode, no resources held in current phase. This is the *acceptable* form of a placeholder (honest, documented, not pretending to do work), but a future daemon path that acquires resources and forgets to wire them here would leak silently. Not a violation today; noted so the contract ("dispose releases resources") doesn't quietly rot.

Severity: **LOW** — honest placeholder, but a name/behavior gap to watch.

---

## Non-findings (verified clean — recorded so the audit is auditable)

- **TODO/FIXME/HACK/XXX in src:** 0 hits.
- **it.skip / test.skip / describe.skip / it.todo / xit / xdescribe / .only:** 0 hits anywhere.
- **env-switch prod/mock branches:** 0. The `process.env` uses are legit: `MANTA_REPO_ROOT` (server boot config), `MANTA_CLONE_ID` (runtime identity in generated hook code), `{...process.env, ...input.env}` (subprocess env passthrough). None swap behavior between test and prod. `cast.ts:672` and `clone-spawner.ts:332` explicitly comment "no NODE_ENV branch."
- **Silent `catch {}`:** every catch block read is a documented, intentional fallback (e.g. `worktree.ts:34` "non-worktree leftover → not-dirty", `events.ts:79` "torn-tail recovery skip-and-warn", `heartbeat-hook.ts:75` "no existing settings — start fresh", `daemon-loop.ts:83` "best-effort release, don't mask original failure", `scoring.ts:37` rethrows on non-ENOENT). None swallow an error it should surface.
- **`computeCompositeScore` / `normalizeCohort` / tie-breaking (scoring.ts):** pure logic, and `scoring.test.ts` tests RED paths properly — disqualification on `testsPassed:false`, `assertNoDominationInversion` detecting a dominated top-rank, axis/pareto/self-certainty/defer tie-break branches. Genuine behavior coverage.
- **`merge-all.test.ts`:** correct DI-seam pattern (injected `runQualityGate`) varied across pass/fail/empty-diff/all-fail → distinct verdicts. The gate result is varied *input*, not a mocked *verified outcome*. Exemplary.
- **`bootstrap.test.ts` / `cast-mcp-preflight.test.ts`:** inject `exec`/`runner` seams and test BOTH green (`exitCode:0`) AND red (`exitCode:1`/`exitCode:2` → `spawn_failed`). Real branch coverage.
- **Only one `vi.mock` in the whole test tree** (the F1 file). The repo systematically prefers DI seams — structurally healthy.
- **`pnpm gate`** is correctly `pnpm typecheck && pnpm lint && pnpm test` with `typecheck: tsc -b`, matching the canonical gate the collector mirrors.

---

## Ranked findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| F1 | **BLOCKER** | Gate-executor test mocks execa green-only; never asserts `testsPassed:false`/`tscErrors>0`/`eslintErrors>0`. RED path of the merge-scorer gate (bug-#63 subsystem) is dead code under test. | `manta-cli/tests/commands/merge-review-collector.test.ts:11-19,36-39` |
| F2 | **HIGH** | All real-claude e2e acceptance suites early-`return` (PASS, no assertions) when `claude` unavailable — "green" overstates what ran; the empirical gate can silently no-op. | `manta-e2e/tests/*.e2e.test.ts` (recon-swarm:49-53 et al.) |
| F3 | **HIGH** | `promote.ts` — fully-implemented destructive command (graveyard move + worktree removal) with **zero** tests. Coverage-bar violation. | `manta-cli/src/commands/promote.ts` |
| F4 | **MED** | `zk-harvest` command — no tests anywhere. Coverage-bar violation. | `manta-cli/src/commands/zk-harvest.ts` |
| F5 | **MED/LOW** | eslint-disable without mandated `// Reason:` — `server.test.ts:64` (no justification), others (justified, wrong keyword). | `manta-bus/tests/server.test.ts:64`; `manta-cli/tests/spawner/pre-register.test.ts:162`; 6× e2e `no-console` |
| F6 | **LOW** | `dispose()` is a documented empty placeholder; name promises resource release. Acceptable now, contract-rot risk for daemon-mode. | `manta-cli/src/runtime.ts:135-137` |

**Bottom line:** the repo is clean on the loud violations (skips, TODOs, env-switches, silent catches). The one genuine nayobka is **F1** — a gate test that proves command shape but never proves the gate goes RED — which is high-leverage because it shadows the exact bug class (#63) the project just fought. F2 (silent e2e pass) and F3/F4 (untested commands) are the next priorities.

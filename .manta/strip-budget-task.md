# Task: strip the cost/charges/cooldown budget system — keep ONLY parallelism

Claude Code is a **subscription**, not pay-per-token. So fake "charges", a
"cooldown", a dollar/usage "cost" tracker, and per-mode charge gating are all
**meaningless** and must be removed. The ONLY real constraint is **parallelism**
(how many `claude` clone processes run at once) — that protects the machine and
the subscription rate limit. Keep that. Remove everything else.

You inherited the main agent's full blast-radius map of this — use it.

## KEEP (do NOT touch the behavior)
- `--max-parallel-clones <n>` flag + its enforcement in `cast.ts` (the
  `parallelismCap` check around line 585 that throws CliError when
  cloneCount > cap). This is the machine/rate guard. Keep it working.
- `manta limit` command, BUT strip it down to only show/set `max_parallel_clones`
  (remove charges/cooldown/token-estimate/cast-rate rows from it).
- The bus coordination primitives (locks, claims, broadcasts, heartbeats,
  contracts, registry) — UNRELATED, do not touch.

## CUT (remove entirely — code, flags, commands, tests, docs, schema fields)
1. **CLI commands**: delete `cost`, `charges`, `refresh` commands from
   `packages/manta-cli/src/bin/manta.ts` and delete their files
   `packages/manta-cli/src/commands/{cost,charges,refresh}.ts` (+ their tests).
2. **Flags** on `cast` in manta.ts: remove `--max-tokens-estimate`,
   `--max-casts-per-hour`, `--charge-check`/`--no-charge-check`. Remove the
   `castRateCap` / cast-rate-per-hour check in `cast.ts` (rate-limiting is a
   usage-limit concept, gone). KEEP `--max-parallel-clones`.
3. **ChargeStore**: delete `packages/manta-bus/src/state/charge-store.ts` and
   `daily-spend.ts`; remove their wiring from `server.ts`, `tools/index.ts`,
   `index.ts`, `state/paths.ts` (the charges/chargesLog/dailySpend paths).
4. **Pre-spawn gate**: `packages/manta-cli/src/budget/pre-spawn-gate.ts` — remove
   all charge-deduct / cooldown / passive-recovery / daily-spend logic. If the
   only thing left would be parallelism (already enforced in cast.ts), delete the
   file and its call site. The cost-estimator (`budget/cost-estimator.ts`) is a
   token *estimate* used only for display — delete it too unless something
   non-cosmetic depends on it; if removing breaks a type, remove the consumer.
5. **budget-config.ts**: drop `charges`, `cooldownHours`, `tokenEstimate*`,
   `maxCastsPerHour` from `ResolvedBudgetConfig` + defaults + the zod/parse of
   `.manta/config/budget.json`. Keep `maxParallelClones`. Rename the file/type if
   "budget" no longer fits (e.g. `parallelism-config.ts`) — your call, but update
   ALL imports.
6. **Bus MCP user tools** (`packages/manta-bus/src/tools/user-tools.ts`): remove
   the `manta.cost` tool (surfaces as `manta_cost`) and its schema. Keep
   `manta.cast/.status/.inspect/.abort/.kill`. Update the tool count anywhere it's
   asserted (README says "31 bus tools … 6 for driving Manta" → it becomes 5;
   fix the number in README + any test that counts tools).
7. **Schemas**: `packages/manta-bus/src/schema.ts` + `trigger-schema.ts` +
   `manta-snapshot/src/schema.ts` — remove charge/cooldown/daily-spend/token-cap
   fields and the now-stale "renamed from *_usd" comments. Don't break unrelated
   fields.
8. **statusline** (`bin/manta-statusline.ts`): remove the token-usage segment
   (`1.2M/5M`) — keep clone states + age. It's a usage meter, gone.
9. **doctor** (`commands/doctor.ts`): remove the "Charges / cooldown" health
   check row. Keep node/claude/bus/git/version rows.
10. **cleanup.ts**: remove any charges/daily-spend state-file cleanup that no
    longer applies.
11. **Plugin commands + skills + docs**: delete `commands/cost.md`,
    `commands/charges.md` (and refresh if present) from the plugin; remove
    `/manta:cost`, `/manta:charges` from `manta:help` skill text and from
    `docs/user/*.md`, README, `skills/manta-orchestrate` / `manta-cast-decide`.
    Rewrite any "usage/rate/charges/cooldown" guidance to: "the only limit is
    --max-parallel-clones; Claude Code is subscription-based."

## HARD constraints
- **Do NOT break Manta.** The cast→spawn→inherit→commit→merge path must still
  work. After your changes, `pnpm gate` (typecheck + lint + test) MUST be green.
  Delete/rewrite tests that asserted the removed behavior — do not `it.skip` them.
- Zero `// TODO`, no dead exports, no orphan imports, no `@ts-ignore`. If you
  remove a thing, remove everything that referenced it.
- Rebuild the distributed binary: run `pnpm build && pnpm build:plugin` so
  `dist/bin/manta.cjs` reflects the changes (the plugin ships that file).
- `manta --help`, `manta cast --help`, `manta doctor`, `manta status`,
  `manta limit` must all run clean afterward. No reference to cost/charges/
  cooldown anywhere a user can see.
- One commit at the end:
  `refactor(budget): remove cost/charges/cooldown — keep only --max-parallel-clones`
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Acceptance (run yourself before committing)
- `git grep -niE 'charge|cooldown|max-casts-per-hour|max-tokens-estimate' -- packages/*/src ':!*.test.*'` → only incidental matches (e.g. "discharge" — there are none expected); cost/charges/cooldown machinery gone.
- `manta cost` / `manta charges` / `manta refresh` → "unknown command".
- `pnpm gate` green. `manta cast recon-swarm --clones 1 --task "noop" --dry-run` still works (parallelism path intact).

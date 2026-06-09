# @manta/e2e

End-to-end tests for the Manta stack. Two tiers: a cheap always-on pre-flight, and
the armed suite that spawns **real `claude` clones**.

## Pre-flight (always runs, ~25s)

```
pnpm --filter @manta/e2e test preflight.test.ts
```

Asserts every workspace package builds, the skill validator is clean, and the CLI
bin starts on an empty repo. A few other files (`manta-library`, `transcript-…`)
also carry an always-on preflight `describe` that needs no real clone. These run
as part of `pnpm test` / `pnpm gate`.

## Armed suite (env-gated, ~5–6 min wall-clock, real clones)

```
pnpm gate:e2e
# = MANTA_E2E=1 pnpm --filter @manta/e2e test
```

Spawns real `claude --print` clones against sample fixture repos and runs the
orchestrator until every clone dies cleanly, asserting the real artifacts
(registry, post-mortems, ZK notes, snapshots, cast-scoped worktrees, forensic
timelines, merge reviews). Covers every cast mode plus the headline
transcript-inheritance proof and the library install→cast→uninstall round-trip:

- `recon-swarm` · `bug-hunt` · `forking-realities` · `refactor-wave` · `decoy` ·
  `council` — one cast each, lifecycle + artifacts.
- `transcript-inheritance` — the binding #56 proof: a clone reproduces a
  parent-only token via forked-transcript `--resume` (positive flow + negative
  control + cross-mode).
- `manta-library` — install a library-mode package, cast through it, uninstall.

**Subscription, not money.** Manta runs on the Claude Code subscription — there
are no dollar budgets, charges, or cooldowns (the budget system was removed). The
only cast limit is `--max-parallel-clones`. Do **not** prepend
`env -u ANTHROPIC_API_KEY` — this project has no Anthropic API key set.

**Skipped automatically** when `MANTA_E2E` is unset OR when `claude --version`
fails (no auth / not installed). Never silently passes — skipped runs print
SKIPPED with the reason.

## ⚠️ This suite is NOT in `pnpm gate` — run it before claiming "all green"

`pnpm gate` (typecheck + lint + `pnpm test`) **skips** the armed suite because each
clone takes minutes. That convenience has a failure mode: the suite is easy to
forget, and an unrun e2e suite rots. It went 6/9 files red once (stale assertions
after the charges removal and the cast-scoped-worktree rename) precisely because
nobody ran it armed for weeks. **`pnpm gate` green ≠ e2e green.** Before a release
or any "everything passes" claim, run `pnpm gate:e2e` separately and read the
result. (`pnpm typecheck` *does* cover this package's types — see bug #70 — but
not its runtime behavior.)

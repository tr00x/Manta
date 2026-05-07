# @manta/e2e

End-to-end smoke tests for the Manta Phase-0 stack. Two suites:

## Pre-flight (always runs, ~2 minutes)

```
pnpm --filter @manta/e2e test preflight.test.ts
```

Asserts every workspace package builds, the skill validator is clean, and the CLI bin starts. Catches integration regressions without spending real money.

## Recon-swarm e2e (env-gated, ~25 minutes, costs money)

```
MANTA_E2E=1 pnpm --filter @manta/e2e test recon-swarm.e2e.test.ts
```

Spawns two real `claude --print` clones against a sample fixture repo, runs the orchestrator until both clones die cleanly, and verifies the artifacts (registry, post-mortems, ZK notes, snapshots, worktrees).

**Skipped automatically** when `MANTA_E2E` is unset OR when `claude --version` fails (no auth, not installed). Never silently passes — skipped runs print SKIPPED with the reason.

**Cost guard**: defaults to `--budget-per-clone-usd 5` and `--tick-budget-ms 1_500_000` (25 min). Override via env if you need to debug a longer-running scenario.

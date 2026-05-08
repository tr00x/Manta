# forking-realities — multiple realities, one task

`forking-realities` is the second mode allowlisted on `manta cast` (after
`recon-swarm`). The shape: spawn N clones (1..5 — the Phase 0 ceiling for
all modes; spec Sec 6.4 recommends ≤ 3 for forking-realities) against the
**same task** but with **different per-clone overlays** — typically a
different `approach_hint` so each clone explores a distinct strategy.
After the cast, the operator picks the winner by reading each clone's
worktree branch.

> **Phase 2a is not production-ready forking-realities.** This release ships
> the spawn surface only. Sibling messaging policy is *recorded* on the cast
> manifest (`policy.peer_messaging = "denied"`) but *not yet enforced* — the
> bus filter lands in Phase 2b. Merge-review (`/manta promote`, automated
> scoring) lands in Phase 2c. Until then, treat forking-realities casts as a
> structured way to spawn N parallel branches; do the merge by hand.

## When to use it

- You have a single well-defined task and ≥ 2 plausible approaches.
- The approaches are large enough to justify a full clone (per spec Sec 6.4
  N ≤ 3; >3 is research territory, not implementation).
- You want each clone to commit on its own branch so you can `git diff` the
  results before merging.

If only one approach is obvious, use `recon-swarm` and a single clone.
If you want multiple agents collaborating on one branch, that's not
forking-realities at all — that's `pair-programming` (Phase 6+).

## Run a cast

The minimum forking-realities invocation:

```bash
manta cast forking-realities \
  --clones 2 \
  --task "rewrite the slow customer-orders SQL"
```

This shapes the cast like recon-swarm — both clones see the same task and
no approach hint. To diverge their work, supply a per-clone tasks file:

```bash
manta cast forking-realities \
  --clones 2 \
  --task "rewrite the slow customer-orders SQL" \
  --tasks plan.yaml
```

`--task` and `--tasks` are **complementary**, not mutually exclusive. The
cast-level `--task` is the default; per-clone entries in `--tasks` override
it for that clone only. A clone with no entry in `--tasks` inherits the
cast-level `--task`.

## `--tasks` schema

YAML or JSON; clone_ids are ASCII slugs (matching the spawn roster — Phase 0
ceiling = 5, default `A`/`B`/`C`/`D`/`E`). Each entry is a partial
`CloneAssignment` (the schema lives in `packages/manta-bus/src/schema.ts`
under `CloneAssignmentSchema`):

```yaml
A:
  task: rewrite the SQL
  approach_hint: use an index on orders.customer_id
B:
  task: rewrite the SQL
  approach_hint: denormalize the order-totals column
  budget_usd: 4
  deadline_seconds: 1800
C:
  task: rewrite the SQL
  scope:
    allowed_paths: [db/, services/orders/]
    forbidden_paths: [.manta/state, secrets/]
    max_files_changed: 10
```

Same content as JSON:

```json
{
  "A": { "task": "rewrite the SQL", "approach_hint": "use an index on orders.customer_id" },
  "B": { "task": "rewrite the SQL", "approach_hint": "denormalize", "budget_usd": 4 }
}
```

All fields are optional. Missing fields fall back to the cast-level
defaults from `--task`, `--budget-per-clone-usd`, `--allowed-paths`, etc.
Supplying `scope` is all-or-nothing — the bus's `ScopeSchema` is `.strict()`,
so you must provide `allowed_paths` and `max_files_changed` together if you
override scope at all.

### Asymmetric budgets

The cumulative-budget gate sums the **effective** per-clone budget, not
`N × budget-per-clone-usd`. If you set `--budget-per-cast-usd 7` and the
overlay puts both clones at `budget_usd: 4`, the cast is rejected up front:

```
[manta] invalid_input: cumulative budget (A=$4 + B=$4 = $8) exceeds
        --budget-per-cast-usd=$7. Reduce per-clone budgets, lower
        --budget-per-clone-usd, or raise --budget-per-cast-usd.
```

### Roster typo guard

A `--tasks` key that's not in the spawn roster is an error, not a no-op —
catches `--clones 2 --tasks plan.yaml` where `plan.yaml` mentions `Z`.

## What the spawner produces

After a successful `manta cast forking-realities`:

- **Cast manifest** at `.manta/state/casts/<castId>.json`. Mode, policy,
  full per-clone roster (with `assignment` carrying each overlay verbatim).
  Schema details: `docs/user/cast-manifest.md`.
- **Per-clone branches** at `manta/<castId>/<cloneId>` — each clone's
  graceful-death commit lives here. The operator pulls the chosen branch
  into `main` (or `git diff`s several before deciding).
- **Per-clone worktrees** at `.manta/worktrees/clone-<cloneId>/`. These
  stay on disk after the cast for post-mortem inspection (deleted only
  by `manta abort` or explicit Phase 7 commands).
- **Per-clone last-gasp reports** at `.manta/worktrees/clone-<cloneId>/last-gasp-report.md`.
  Read these before picking the winner — the clone wrote the report knowing
  it was about to die.
- **Registry records** with `metadata.cast_mode = "forking-realities"` and
  `metadata.cast_id = "<castId>"`. The Phase 2b sibling-message filter
  joins on these without re-reading the manifest.

Merge-review is manual until Phase 2c lands — the operator inspects each
`manta/<castId>/<cloneId>` branch via plain `git diff` / `git log` and
merges the chosen one with `git merge`.

## Runtime dependency note

Parsing `--tasks` adds a `yaml@^2.6` runtime dependency to `@manta/cli`.
Operators on lockdown / air-gapped environments need to allowlist it
alongside the existing `commander` / `execa` / `zod` dependencies.

## See also

- `docs/user/cast-manifest.md` — the per-cast on-disk manifest format.
- `docs/user/recon-swarm.md` — the simpler mode (no per-clone overlay).
- `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` Sec 6.4 — the
  full spec for forking-realities, including Phase 2c merge-review.

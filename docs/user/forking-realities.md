# forking-realities — multiple realities, one task

`forking-realities` spawns N clones (1..5; ≤ 3 works best for
forking-realities) against the
**same task** but with **different per-clone overlays** — typically a
different `approach_hint` so each clone explores a distinct strategy.
After the cast, the operator picks the winner by reading each clone's
worktree branch.

## Sibling isolation

Forking-realities clones cannot exchange work-in-progress through the Bus.
The bus rejects sibling-to-sibling `manta.message` and cross-clone
`manta.task_contract.read`; `manta.claim_work` is rejected entirely for
forking-realities clones (no shared work board in this mode). Broadcast
events are stamped with `cast_id` + `cast_mode` so future `tail` consumers
can filter sibling visibility.

For the closed-set allow/reject table, see
[docs/internals/forking-realities-isolation.md](../internals/forking-realities-isolation.md).

Known limitations:
- Lock owner-id leak on shared-path contention. Skill discipline is the
  primary defense; filesystem-level enforcement hooks are not yet shipped.
- Filesystem-level isolation is skill-only. A clone could `cd ../clone-B`
  if it ignored skill discipline.

## Merge review

When all clones in a forking-realities cast are DEAD, the CLI automatically
collects metrics from each clone's worktree and generates a scored
merge-review at `docs/merge-reviews/<castId>.md`.

The scoring engine evaluates candidates on 6 axes: test coverage delta,
diff size, cyclomatic complexity delta, TypeScript errors, ESLint
warnings/errors, and performance (when benchmarks exist). Candidates whose
test suite fails are disqualified entirely.

An agentic rubric pre-pass adjusts weights based on the project's
configuration (e.g., strict tsconfig bumps the typeCheck weight). Weights
can also be tuned manually via `.manta/config/scoring.json`.

The merge-review document includes:
- **Verdict**: `manual_review_required` (the default), `auto_merge_eligible`,
  `no_candidates_passed_gate`, or `dominance_inversion_flagged`.
- **Score table**: per-candidate normalized scores and composite ranking.
- **Tie-break explanation**: axis priority → Pareto dominance → self-certainty → defer.
- **Proposed merge command**: the exact `git merge` to run.

To promote the winner:

```bash
manta promote <castId>/<cloneId>
```

This merges the winner's branch (`--no-ff`), moves loser worktrees to
`.manta/graveyard/`, and emits a `promote` event. The operator can promote
any clone in the roster — not just the top-ranked one — when domain
knowledge overrides the scoring engine's recommendation.

## When to use it

- You have a single well-defined task and ≥ 2 plausible approaches.
- The approaches are large enough to justify a full clone (N ≤ 3 is the
  sweet spot; >3 is research territory, not implementation).
- You want each clone to commit on its own branch so you can `git diff` the
  results before merging.

If only one approach is obvious, use `recon-swarm` and a single clone.
If you want multiple agents collaborating on one branch, that's not
forking-realities at all — that's `pair-programming`.

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

YAML or JSON; clone_ids are ASCII slugs (matching the spawn roster — up to
5 clones, default `A`/`B`/`C`/`D`/`E`). Each entry is a partial
`CloneAssignment` (the schema lives in `packages/manta-bus/src/schema.ts`
under `CloneAssignmentSchema`):

```yaml
A:
  task: rewrite the SQL
  approach_hint: use an index on orders.customer_id
B:
  task: rewrite the SQL
  approach_hint: denormalize the order-totals column
  token_estimate: 300000
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
  "B": { "task": "rewrite the SQL", "approach_hint": "denormalize", "token_estimate": 300000 }
}
```

All fields are optional. Missing fields fall back to the cast-level
defaults from `--task`, `--allowed-paths`, etc. (the per-clone token-estimate
budget is internal and applied automatically).
Supplying `scope` is all-or-nothing — the bus's `ScopeSchema` is `.strict()`,
so you must provide `allowed_paths` and `max_files_changed` together if you
override scope at all.

### Asymmetric usage estimates

The cumulative usage gate sums the **effective** per-clone token estimate against
the internal per-cast ceiling. If the overlay puts both clones at a high
`token_estimate` that together exceed the per-cast ceiling, the cast is rejected
up front (token estimates are a subscription-usage proxy, not dollars):

```
[manta] invalid_input: cumulative per-clone usage estimate (A=900000 + B=900000
        = 1800000) exceeds the per-cast usage budget (1500000). Lower the
        per-clone overrides in --tasks, or spawn fewer clones.
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
  by `manta abort` or explicit cleanup commands).
- **Per-clone last-gasp reports** at `.manta/worktrees/clone-<cloneId>/last-gasp-report.md`.
  Read these before picking the winner — the clone wrote the report knowing
  it was about to die.
- **Registry records** with `metadata.cast_mode = "forking-realities"` and
  `metadata.cast_id = "<castId>"`. The sibling-message filter joins on these
  without re-reading the manifest.

After a cast, the merge-review is auto-generated. The operator reads
`docs/merge-reviews/<castId>.md`, inspects branches via `git diff`, and
runs `manta promote <castId>/<cloneId>` to merge the chosen winner.

## Runtime dependency note

Parsing `--tasks` adds a `yaml@^2.6` runtime dependency to `@manta/cli`.
Operators on lockdown / air-gapped environments need to allowlist it
alongside the existing `commander` / `execa` / `zod` dependencies.

## See also

- `docs/user/cast-manifest.md` — the per-cast on-disk manifest format.
- `docs/user/recon-swarm.md` — the simpler mode (no per-clone overlay).
- `docs/internals/merge-review-scoring.md` — how the merge-review scores
  candidates and picks a winner.

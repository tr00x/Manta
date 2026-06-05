# refactor-wave — parallel module migration mode

`refactor-wave` spawns 2–5 clones to apply the same refactoring pattern
across disjoint modules in parallel. Each clone owns a slice of the
codebase and works independently; after all clones finish, Manta merges
their branches sequentially with per-clone quality gates.

## When to use

- Mechanical migration across many packages (e.g. replace `throw` with
  `Result<T>`, upgrade an API across all callers).
- Codemod-style changes that touch N modules with the same pattern.
- Cross-package rename or restructuring where each module can be
  migrated independently.
- Large-scale lint-fix or dependency-bump sweep.

**Not suited for:** competing design approaches (use
`forking-realities`), investigation work (use `bug-hunt`), or changes
where modules have tight coupling that requires coordinated edits (do
those manually or in a single `recon-swarm`).

## How it works

1. You define the migration task and assign disjoint module partitions
   via `--tasks`.
2. Manta validates that partitions don't overlap (no shared paths).
3. Clones are spawned, each scoped to its partition's `allowedPaths`.
4. Peer messaging is `denied` — clones work independently on their
   modules. Broadcasts still work for progress signals.
5. Each clone applies the migration pattern to its module, runs tests,
   and commits.
6. After all clones finish, Manta runs `merge-all`: merges each clone's
   branch sequentially into main with a per-clone quality gate (language-aware
   type-check + tests — pnpm/npm, pytest, cargo, or go).
7. A merge-all report is written to `docs/merge-all-reports/`.

## Module partitioning

Partitions must be **strictly disjoint**:

- No exact path duplicates across clones.
- No prefix containment (e.g. `src/auth/` and `src/auth/login/` would
  be rejected).
- Each clone's `forbiddenPaths` should include other clones' modules
  (enforced by the operator, not auto-computed).

The validator runs before clone spawn and throws `invalid_input` on
overlap.

## Tasks file format

```yaml
A:
  task: "Migrate packages/auth to Result<T> pattern"
  approach_hint: "Start with auth-middleware.ts, then propagate to callers"
  scope:
    allowed_paths:
      - packages/auth
    forbidden_paths:
      - .manta/state
      - secrets/
      - packages/billing
    max_files_changed: 15
B:
  task: "Migrate packages/billing to Result<T> pattern"
  approach_hint: "Start with payment-processor.ts, then propagate to callers"
  scope:
    allowed_paths:
      - packages/billing
    forbidden_paths:
      - .manta/state
      - secrets/
      - packages/auth
    max_files_changed: 15
```

Key fields:

| Field | Required | Description |
|-------|----------|-------------|
| `task` | Yes | What migration to apply in this module |
| `approach_hint` | No | Strategy guidance for the clone |
| `scope.allowed_paths` | Yes | Disjoint module paths for this clone |
| `scope.forbidden_paths` | Recommended | Exclude other clones' modules |
| `scope.max_files_changed` | Recommended | Safety cap on file writes |
| `deadline_seconds` | No | Per-clone deadline override |

## CLI examples

Basic 2-clone refactor wave:

```bash
manta cast refactor-wave \
  --clones 2 \
  --task "Migrate error handling from throw to Result<T>" \
  --tasks migration-plan.yaml
```

3-clone wave across more packages:

```bash
manta cast refactor-wave \
  --clones 3 \
  --task "Replace console.log with structured logger" \
  --tasks logger-migration.yaml \
  --max-parallel-clones 3
```

Validate without spawning (`--dry-run` checks the mode, partitions, and
scope, then exits — no clones are launched):

```bash
manta cast refactor-wave --clones 2 --task "..." --tasks plan.yaml --dry-run
```

## Tips

- **Keep partitions truly disjoint.** The validator catches path
  overlaps, but semantic coupling (module A imports module B's types)
  is your responsibility. Use `forbidden_paths` to prevent accidental
  cross-module edits.
- **Include shared types in a read-only layer.** If modules share a
  types package, don't assign it to any clone — let them import the
  current version read-only.
- **One pattern per wave.** Don't combine unrelated refactors in one
  cast — each clone should apply the same mechanical change.
- **Use `max_files_changed`** as a safety net. If a clone touches more
  files than expected, the scope validator flags it.
- **Quality gates catch regressions.** Each clone's branch must pass the
  project's type-check and test gate before merge — **language-aware**:
  `tsc` + the test script for pnpm/npm, `pytest` for Python, `cargo
  check`/`cargo test` for Rust, `go vet`/`go test` for Go. A tool that
  isn't installed (or an axis that doesn't apply) is skipped, not a
  failure. Real failures skip that clone's merge but don't block others.
- **Check the merge-all report.** After the cast, read
  `docs/merge-all-reports/cast-<id>.md` for per-clone results and any
  conflict escalations.

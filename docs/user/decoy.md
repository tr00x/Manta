# decoy — a draft to react to

`decoy` spawns **at most 2 clones that produce a DRAFT deliverable** for you (the
main agent) to review, edit, and finalize. The clone deliberately stops at "good
enough to react to" — it is **not** trying to ship a finished artifact. The point
is to break the blank-page problem: it is faster to fix a draft than to write
from scratch, and a concrete draft surfaces the real questions.

> **🔒 Aghs-locked.** `decoy` is a higher-power mode gated behind an explicit
> opt-in (see "Unlocking" below). A bare `manta cast decoy …` is rejected until
> you unlock it.

## The shape

- **1–2 clones** (the CLI rejects `>2`: a decoy drafts, it does not swarm).
- Each clone produces a **DRAFT**, not a finished deliverable — a first pass you
  are expected to revise. The clone-side skill explicitly frames the output as
  "for the main to review/edit/finalize", and the clone stays collaborative
  (unlike council/forking, it is not forced into independence).
- **You finalize.** There is no scoring and no auto-merge. You take the draft,
  edit it, and land the polished version yourself.

## When to use it

- You face a **blank page** and want a fast first draft to react to — a doc,
  a config, a schema, a refactor sketch, a test plan.
- You expect to **rewrite a chunk of it** anyway: the draft's job is to be wrong
  in useful ways, surfacing the decisions you actually need to make.
- Contrast:
  - **documentation-chase** — when you want *finished* docs, not a draft.
  - **pair-programming** — when you want a tight writer↔reviewer loop on
    production code, not a throwaway-grade first pass.
  - **bug-hunt / refactor-wave** — when you want committed, gate-green changes.

## Unlocking

`decoy` (and `council`) are Aghs-locked. Unlock via **either** channel:

```jsonc
// .manta/config/budget.json
{ "aghs": { "unlocked": ["council", "decoy"] } }
```

or set the env var (unlocks every safe Aghs mode for the session):

```bash
export MANTA_UNLOCK_AGHS=1
```

If you cast a locked mode, the CLI refuses with a clear message pointing here —
it does not silently downgrade.

## Run a cast

```bash
manta cast decoy \
  --clones 1 \
  --task "Draft a first-pass GitHub Actions CI workflow for this monorepo (lint, typecheck, test)."
```

The clone commits its draft on `manta/<castId>/<cloneId>` and writes a last-gasp
report. When it is DEAD, read the draft and finalize it yourself:

```bash
manta status                                   # watch until DEAD
git diff main..manta/<castId>/<cloneId>        # review the draft
cat .manta/worktrees/clone-<id>/last-gasp-report.md
```

Then edit the draft to production quality and land it — the decoy got you to the
50% mark fast; the last mile is yours. (No `manta promote` — decoy output is a
starting point, not a scored winner.)

## See also

- `docs/user/council.md` — the other Aghs mode (independent proposals).
- `docs/user/documentation-chase.md` — when you want finished docs, not a draft.
- `skills/manta-decoy/SKILL.md` — the clone-side behavior contract.

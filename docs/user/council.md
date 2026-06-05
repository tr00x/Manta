# council — wisdom of crowds, you aggregate

`council` spawns **3–5 clones that each independently propose one reasoned
solution** to the same question, then **you** (the main agent) read all the
proposals and synthesize the answer. It is the "ask N experts in separate rooms,
then decide" pattern: clones never see each other's work, so you get genuinely
independent viewpoints instead of groupthink.

> **🔒 Aghs-locked.** `council` is a higher-power mode gated behind an explicit
> opt-in (see "Unlocking" below). A bare `manta cast council …` is rejected until
> you unlock it.

## The shape

- **3–5 clones** (the CLI rejects `<3` or `>5`: 5 independent proposers is the
  spec ideal, 3 is the minimum for a meaningful crowd).
- Every clone gets the **same question** and proposes **one** solution, with its
  reasoning. Clones are expected to propose **independently** — no peeking, no
  peer chatter. Unlike `forking-realities`, the bus does **not** structurally
  reject council sibling `manta.message` / cross-clone `manta.task_contract.read`
  (that fence is keyed to `cast_mode === 'forking-realities'` only). Council
  independence is enforced by the `manta-council` clone skill plus the cast's
  recorded `peer_messaging: denied` policy, not by a hard bus wall.
- **No auto-merge, no scoring engine.** Unlike forking-realities (which scores
  branches and writes a merge-review), council produces N *proposals* for a human
  judgment call. You read them and aggregate by hand — the value is the diversity
  of independent reasoning, not a mechanical winner.

## When to use it

- A hard **judgment call** with more than one defensible answer where you want
  several independent takes before committing (architecture choice, a tricky
  trade-off, a "which approach is least bad" decision).
- You value **independent** reasoning — you specifically do NOT want the clones
  influencing each other.
- Contrast:
  - **forking-realities** — when the alternatives are *implementations* you want
    built and *scored* (it merges a winner). Council is for *opinions* you
    aggregate yourself.
  - **recon-swarm** — when you need *facts/maps*, not opinions.

## Unlocking

`council` (and `decoy`) are Aghs-locked. Unlock via **either** channel:

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
manta cast council \
  --clones 5 \
  --task "Should the event store be Postgres or DynamoDB for our access patterns? Propose one and justify."
```

Each clone commits its proposal on its own branch `manta/<castId>/<cloneId>` and
writes a last-gasp report. When all clones are DEAD, read the proposals:

```bash
manta status                      # watch until all DEAD
git log manta/<castId>/A          # or read each clone's worktree / last-gasp
cat .manta/worktrees/clone-<id>/last-gasp-report.md
```

Then **you** synthesize the decision — there is no `manta promote` step for
council (nothing is auto-merged). Cherry-pick or write up the conclusion yourself.

## See also

- `docs/user/forking-realities.md` — the *scored, auto-merged* sibling pattern.
- `docs/user/decoy.md` — the other Aghs mode (draft-for-review).
- `skills/manta-council/SKILL.md` — the clone-side behavior contract.

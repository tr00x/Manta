---
name: manta-council
description: Council clone instructions — independently propose one reasoned solution to a shared question; the main aggregates (wisdom of crowds, no auto-merge)
audience: clone
version: 0.0.1
related: [manta-as-clone, manta-graceful-death]
---

# manta-council

## Purpose

You are a **council clone** (spec Sec 2 #9, an Aghanim's-locked mode). You and your siblings each answer the **same question independently**. The main agent reads every proposal and aggregates them by hand — there is **no auto-merge** and **no scoring engine** ranking you against each other. The value of a council comes from genuine diversity: if everyone converges by peeking at each other, the crowd is worthless.

This is forking-realities **minus the auto-merge**: independent worktrees, independent thinking, but the main synthesizes the answer rather than a scorer picking a winner.

## Allowed

- Read any file inside your `taskContract.scope.allowedPaths` for context.
- Write **one** proposal document on your branch (e.g. `proposal-<your-id>.md`).
- Broadcast a `self_certainty` event with your confidence score (used by the main as a signal, not a verdict).
- Broadcast `event_type: 'blocker'` to the main if you discover the question is malformed or blocked.
- Commit your proposal + `last-gasp-report.md` and die gracefully.

## Forbidden

- **Peeking at siblings.** Do not read sibling worktrees, do not call `manta.message` (peer messaging is denied at the bus for this mode), do not try to coordinate or converge. Independence is the entire point.
- **Hedging across every option.** Commit to ONE recommendation and defend it. "It depends, here are five equal choices" is a non-answer — the crowd's strength is each member taking a clear stance.
- Arguing your proposal is better than a sibling's (anti-gossip, spec Sec 5.5). You don't see theirs anyway.
- Merging or finalizing — you never merge; the main synthesizes.
- Writing more than your single proposal doc, or writing outside scope.

## Proposal document structure (mandatory sections)

```
# Proposal — clone <your-id> (cast <cast-id>)

## Recommendation
<your single, committed answer in 1-3 sentences>

## Reasoning
<why this is the right call — the core of your proposal>

## Trade-offs / risks
<what you give up; where this could go wrong>

## Alternatives considered
<options you rejected, and the one-line reason each lost>

## Confidence
<1-10> — <one sentence on what would raise or lower it>
```

## Why independence matters (don't skip this)

Wisdom-of-crowds aggregation only works when errors are **uncorrelated**. The moment you read a sibling's proposal, your error correlates with theirs and the main loses signal. Reason from the question and the code, not from what you imagine a sibling would say.

## Examples

### A filled-in proposal document

```
# Proposal — clone B (cast cast-1780249787129)

## Recommendation
Cache query results in Redis with a 60s TTL, keyed by normalized SQL + bound params.

## Reasoning
Read-heavy workload, 90%+ identical queries within a request burst; Redis is already
in the stack so no new dependency. 60s bounds staleness below the product's freshness SLA.

## Trade-offs / risks
Stale reads up to 60s; cache stampede on a cold key under load (mitigate with a lock).

## Alternatives considered
- In-process LRU — rejected: no cross-instance sharing.
- Materialized views — rejected: write amplification too high for this churn rate.

## Confidence
7 — would rise to 9 with a measured hit-rate from a traffic replay.
```

### Broadcasting your confidence (optional, tie-break signal for the main)

```
manta.broadcast({ clone_id: "B", event_type: "self_certainty", payload: {
  score: 7, rationale: "Clear win on a read-heavy load; staleness risk is bounded and acceptable."
}})
```

### Anti-example (do NOT do this)

- Read a sibling's worktree or message a peer to "align" before writing — that destroys the uncorrelated-error property the council depends on.
- Hedge: "any of Redis / LRU / materialized views could work" with no committed recommendation.
- Argue your proposal is better than a sibling's. You can't see theirs, and the main does the comparing.

## Shutdown

Follow `manta-graceful-death`: broadcast your `self_certainty` score, write `last-gasp-report.md`, `git add` the proposal + report and commit on your branch, at least one `manta.zk_write`, then `manta.suicide_intent` → `manta.report_death`. Never push.

---
name: manta-coordinate
description: File locks, broadcast etiquette, work-claim board. How a clone shares the bus without stepping on siblings.
audience: clone
version: 0.0.2
related: [manta-as-clone]
---

# manta-coordinate

## Purpose

Multiple clones share a single Manta Bus. Coordination is data-driven (locks, claims, broadcasts) — never social. This skill defines exactly which calls to make, when, and what to never do.

## Allowed

- **Lock before write**: any path you intend to edit goes through `manta.lock { clone_id, path }` first. Renew via `manta.renew_lock` every 5 s while held. Release via `manta.unlock` the moment you stop editing.
- **Claim before duplicating**: before doing a piece of work that a sibling could also do (e.g. "summarize subdir X"), call `manta.claim_work { item: "summarize:X", timeout_ms: 600000 }`. If it returns a `conflict`, pick a different item.
- **Filtered broadcast**: only three event types are bus-traffic. Use them sparingly:
  - `breakthrough` — root cause / subproblem solved (sibling may unblock)
  - `blocker` — stuck (main agent intervenes)
  - `dependency` — discovered code that affects another clone's scope
- **Drift report**: every ~50 actions, call `manta.drift_report { score: 0..1, evidence }` so the main agent can spot scope drift early.
- **Anchor sync**: when you receive a `contract_refresh` event from the main, re-read `manta.task_contract.read` and re-ack via `manta.ack_contract`.

## Cast-agnostic contract_refresh (Sec 5.7)

When you broadcast a `manta.contract_refresh` it fans out to every active
clone, regardless of cast. Therefore the payload must be cast-agnostic —
do not include per-cast approach hints, per-cast scope, or per-cast
deliberations. For per-cast updates, use `manta.task_contract.write` per
clone instead. Violation is a soft information leak across casts (research
clone-C §6 "Contract refresh content").

## Forbidden

- **Holding a lock without renewing.** Stale leases (15 s without `renew_lock`) are reaped by the orchestrator and emit `lock_reap` events visible in the post-mortem — a quality signal against you. Renew on time or release.
- **Broadcasting status pings** ("started reading routes/index.ts"). Local log only — bus traffic is for actionable events.
- **Direct messages for opinions.** `manta.message` is for round-table escalation (sibling proposes vs sibling proposes). Disagreements → broadcast `blocker` so the main can decide.
- **Bypassing the work-claim board.** Even if you "know" no sibling is doing something, claim it. Future-you (or a re-spawn) reads the claim log to reconstruct lineage.

## Examples

You're cloning a refactor-wave with sibling B and C:

1. Each clone takes a region by claim:
   - You: `manta.claim_work { item: "refactor:auth", timeout_ms: 600000 }` → ok
   - B: claims `refactor:billing`
   - C: claims `refactor:logging`
2. You discover `auth/index.ts` imports `billing/utils.ts` — that's B's scope.
   - You broadcast: `manta.broadcast { event_type: 'dependency', payload: { from: 'auth/index.ts', to: 'billing/utils.ts' } }`.
   - You DO NOT edit billing yourself; you DO NOT message B asking permission.
3. You finish: `manta.release_work { item: "refactor:auth" }`, `manta.unlock` every held path.

Bad pattern:

- "I'll just touch billing/utils.ts since it's a one-liner." → outside scope. Hooks block. Fragility -1.
- "B's plan is wrong, I'll msg them." → anti-gossip violation. Escalate via `blocker` broadcast instead.

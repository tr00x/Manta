# Phase 2 Research — Bus Isolation / Plagiarism Prevention Strategies

**Deliverable for:** `docs/superpowers/plans/2026-05-07-phase-2-forking-realities-research-prep.md` → Per-clone tasks → C
**Author:** clone-C of cast `cast-1778187665150` (recon-swarm)
**Scope of evidence:** read-only walk of `packages/manta-bus/src/**`, `packages/manta-cli/src/spawner/**`, `packages/manta-orchestrator/src/**`, plus spec Sec 5.5/5.7/5.8. No code changes, no edits outside `docs/research/`.

---

## 1. Spec recap

**Sec 5.8 — Plagiarism prevention (forking-realities only)** (verbatim, lines 230–232 of `docs/superpowers/specs/2026-05-06-manta-pattern-design.md`):

> Клоны **не видят** код / Bus-сообщения друг друга до финала. Bus в этом режиме = read-only с мейном.

**Sec 5.5 — Anti-gossip rule** (lines 213–220):

> Запрещено в `manta-as-clone` skill:
> - Обсуждать «чья версия лучше»
> - Self-promotion
> - Социальные игры
>
> Только факты + evidence.

**Sec 5.7 — Anchor sync** (lines 226–228):

> Мейн broadcast'ит `contract-refresh` каждые 5 минут. Клоны переподтверждают.

### What "Bus = read-only с мейном" means operationally

Decomposed against the actual handler surface in `packages/manta-bus/src/server.ts`:

| MCP tool                            | Direction                | Forking-realities policy                          |
|-------------------------------------|--------------------------|---------------------------------------------------|
| `manta.register`                    | spawner → bus            | Allowed (spawner only; clones don't self-register per Phase-0 design — `clone-spawner.ts:80-93` does pre-registration). |
| `manta.heartbeat`                   | clone → bus              | Allowed (per-clone lifecycle, never reveals siblings). |
| `manta.suicide_intent`/`report_death`| clone → bus              | Allowed. |
| `manta.task_contract.read`          | clone → bus              | Allowed *only* for own `clone_id`. Today the handler trusts the input (`tools/contract.ts:38-42`) — see §6 hardening note. |
| `manta.task_contract.write`         | spawner/main → bus       | Allowed (spawner-only by convention; no bus-side enforcement). |
| `manta.ack_contract`                | clone → bus              | Allowed for own clone. |
| `manta.contract_refresh`            | **main → bus**           | Allowed. **Schema (`schema.ts:98-102`) carries no `clone_id`** — main is the implicit author. |
| `manta.claim_work`/`release_work`   | clone → bus              | Allowed (work board is shared by design — but should be **disabled** in forking-realities since plagiarism prevention requires isolated worlds; see §6 edge case). |
| `manta.lock`/`unlock`/`renew_lock`  | clone → bus              | Per-worktree locks are isolated by file path; shared-path collisions reveal sibling identity via `BusLockedError.ownerCloneId` (`errors.ts:39-44`). Soft-information leak. |
| **`manta.broadcast`**               | clone → bus              | **Restrict** — sibling-readable in Phase 2 once Tier-3 `tail` ships. |
| **`manta.message`**                 | sibling → sibling        | **Restrict** — direct addressing requires *opt-in* (round-table escalation in Sec 5.4 funnels through main, not peers). |
| `manta.drift_report`                | clone → bus              | Allowed (per-clone, audit-only). |
| `manta.zk_write`/`para_append`      | clone → bus              | Allowed (memory writers append per-clone tags; see `tools/memory.ts`). |

**Operational restatement of Sec 5.8:** in forking-realities, the only **bidirectional** Bus traffic permitted between a clone and any other actor is clone↔main (via `contract_refresh` and the post-mortem flow). Sibling↔sibling traffic on `broadcast`/`message` MUST be rejected before being persisted to the events log.

### Surprise finding (drives the whole recommendation)

**No MCP tool currently exposes `EventsLog.readAll`/`readSince`.** `grep -rn "events.readAll" packages/` returns one production caller — `packages/manta-orchestrator/src/post-mortem.ts:44` — and a handful of test callers. The events log is **not** a publish/subscribe channel for clones today; it is a *write-only audit channel* whose only readers are the orchestrator and tests.

Consequence: in Phase 0/1 the spec's "клоны не видят Bus-сообщения друг друга" is **already structurally true** for `broadcast`/`message`, because there is no read tool for clones to call. The vulnerability surface that Sec 5.8 actually has to defend against in Phase 2 is therefore narrower than the prose suggests:

1. **Phase 2 is going to add Tier-3 `/manta tail <id>` and Tier-4 `/manta replay <cast-id>`** (spec Sec 11.0, lines 461–462). The moment those tools exist, sibling-visibility becomes a real risk *unless* the broadcast/message handlers tag events with `cast_id` and the tail/replay subscriber filters by membership.
2. **`BusLockedError` reveals owner clone-id** when two clones contend on a shared path (`packages/manta-bus/src/state/locks.ts:64,91,111`). In recon-swarm this is fine; in forking-realities, where worktrees are physically separate, lock paths *should* be repo-relative-but-worktree-scoped — but if a clone tries `manta.lock <repo-root-relative-path>` thinking of the parent worktree, a sibling on the same file gets a leaked clone_id. Soft-information leak, currently enforced by clone discipline only.
3. **`manta.message` is technically wired** between any two registered clones (`tools/communication.ts:26-40`). It currently has no delivery mechanism — it just appends an audit event — but a sibling could call it and the event would land in the events log. Phase 2 Tier-3 tail would then surface that to whoever is tailing, including a tailing sibling.

These three surfaces define the actual enforcement boundary for Phase 2.

---

## 2. Strategy 1 — Bus-layer filter

> `manta-bus` rejects `broadcast` / `message` calls between siblings during a `forking-realities` cast.

### Where the cast-id comes from at handler-call time

The cast-id is **already** persisted in the registry. Evidence:

- `packages/manta-cli/src/spawner/clone-spawner.ts:80-93` calls `opts.registry.register({ clone_id, mode, parent_pid, worktree, metadata: { cast_id: castId } })` before launching the clone process.
- `CloneRecord.metadata: Record<string, string>` is defined at `packages/manta-bus/src/state/registry.ts:13` and persisted in `RegistryFile.clones[cloneId].metadata`.
- `RegisterInputSchema` (`packages/manta-bus/src/schema.ts:27-35`) accepts `metadata: z.record(z.string(), z.string()).default({})`.
- Confirmed end-to-end: heartbeat reply in this cast included `"metadata":{"cast_id":"cast-1778187665150"}` for clone C.
- `CloneRecord.mode` is also persisted at the registry root (`registry.ts:9`, `register` method line 46), so cast membership is `{c | c.metadata.cast_id === X && c.mode === 'forking-realities'}`.

This means the filter has **no schema migration** to do. Both fields the filter needs are already in the registry today.

### What needs to be persisted in `Registry.metadata` to make this enforceable

Nothing new — `metadata.cast_id` is sufficient. But two **invariants** should be tightened in the schema layer:

1. **`metadata.cast_id` becomes a required key** when `mode === 'forking-realities'`. Today `RegisterInputSchema` accepts an empty metadata object (`.default({})`); a forking-realities register without `cast_id` would silently bypass the filter. Add a `.refine((input) => input.mode !== 'forking-realities' || typeof input.metadata.cast_id === 'string', { message: 'forking-realities clones must register with metadata.cast_id' })` check on `RegisterInputSchema`.
2. **`cast_id` must match `^[A-Za-z0-9._-]+$`** (the `SAFE_KEY` pattern already enforced in `clone-spawner.ts:53`). Promote the same regex into the bus schema so the filter cannot be tricked by a homoglyph or path traversal in `metadata.cast_id`.

Both are Phase-2 schema patches, ≤ 10 LOC, no migration of stored data.

### Filter implementation sketch

In `packages/manta-bus/src/tools/communication.ts` (current handler at lines 12–52). Add a private helper and call it in both `broadcast` and `message`:

```ts
async function siblingsInSameForkingCast(
  ctx: Pick<BusContext, 'registry'>,
  fromCloneId: string,
  toCloneId: string,
): Promise<boolean> {
  const [from, to] = await Promise.all([
    ctx.registry.get(fromCloneId),
    ctx.registry.get(toCloneId),
  ]);
  if (from.mode !== 'forking-realities') return false;
  if (to.mode !== 'forking-realities') return false;
  const castId = from.metadata.cast_id;
  return Boolean(castId) && castId === to.metadata.cast_id && fromCloneId !== toCloneId;
}
```

In the `message` handler (`tools/communication.ts:26-40`), after the existing `registry.get` calls (which already validate both peers exist), add:

```ts
if (await siblingsInSameForkingCast(ctx, parsed.from_clone_id, parsed.to_clone_id)) {
  throw new BusForkingIsolationError(parsed.from_clone_id, parsed.to_clone_id, fromCastId);
}
```

For `broadcast` (which has no recipient field — it's append-only), the filter is *forward-looking* infrastructure: stamp the resulting event payload with `cast_id` and `mode` so the future Tier-3 `tail` consumer can filter by cast-membership before delivering to a sibling. Concretely, change line 22 from:

```ts
payload: { event_type: parsed.event_type, body: parsed.payload },
```

to:

```ts
payload: {
  event_type: parsed.event_type,
  body: parsed.payload,
  cast_id: from.metadata.cast_id,    // populated by sibling-lookup helper above
  mode: from.mode,
},
```

Cost: one extra `registry.get` per broadcast (~µs of file IO; cheap relative to the file mutex already held). Tier-3 tail then enforces "if subscriber.mode === 'forking-realities' AND event.cast_id === subscriber.cast_id AND event.clone_id !== subscriber.clone_id → drop".

### New error class

`BusForkingIsolationError` belongs alongside the existing `BusConflictError`/`BusLockedError`/etc. in `packages/manta-bus/src/errors.ts`. Wire it through `serializeError` in `server.ts:281-307` to map onto a stable wire envelope `{ error: 'forking_isolation', message, details: { from, to, cast_id } }`. Spec-style: closed-set error mapping (the comment at `server.ts:275-280` already mandates this).

### Pros

- **Hard enforcement.** The clone has to actively work around a bus-side rejection; skill drift cannot quietly bypass it.
- **Zero registry/schema migration.** `metadata.cast_id` is already populated by the spawner.
- **Symmetric with existing handler patterns.** `tools/communication.ts:32-33` already does `registry.get` lookups for both peers — same primitive, just one more check.
- **Explainable failure mode.** A malformed clone gets `forking_isolation` envelope, not silent success — so post-mortem and future skill linting can spot the regression class.
- **Composable with Strategy 2.** Skill text says "don't try"; bus says "and if you do, you fail loud". Belt-and-braces.

### Cons

- **Two extra atomic-read of `registry.json` per `broadcast`/`message`.** With current heartbeat traffic (every ≤ 10 s per clone) this is noise in the critical path; in N=2/3 forking casts even noisier than that is a non-issue. If perf surfaces in Phase 5 daemon mode, cache the registry record on the connection.
- **Tier-3 `tail` enforcement still has to be implemented.** Strategy 1 only closes the *write-time* hole on `message`; the *read-time* hole on `broadcast` becomes real once `/manta tail` exists. The cast_id-stamped payload above is the prerequisite.
- **`task_contract.read` and `claim_work` need parallel hardening** (see §6) — Strategy 1 by itself doesn't cover them.

---

## 3. Strategy 2 — Spawner-injected scope (env var + skill text)

> The spawner gives each clone a `MANTA_BUS_PEER_SCOPE=parent-only` env var; `manta-as-clone` honors it via skill text. Soft-enforcement only.

### How it would work, end-to-end

1. `clone-spawner.ts:95-104` already injects `MANTA_SNAPSHOT_PATH`, `MANTA_REPO_ROOT`, `MANTA_CLONE_ID`. Add `MANTA_BUS_PEER_SCOPE: opts.snapshot.taskContract.mode === 'forking-realities' ? 'parent-only' : 'siblings-allowed'`.
2. `priming.ts:3-15` already has a section that lists forbidden actions. Append: "If `MANTA_BUS_PEER_SCOPE === 'parent-only'`, do not call `manta.broadcast` or `manta.message` to siblings; the only audience is main."
3. `skills/manta-as-clone/SKILL.md` (current v0.0.1, lines 38–46 of the skill in this worktree) gets a new bullet under **Forbidden**: "When the cast mode is `forking-realities` (Sec 5.8): no `broadcast`, no `message`, no `claim_work`, no `task_contract.read` of any clone_id but your own. Bus is read-only with the main."

### Pros

- **Zero bus-side code changes.** Smallest possible diff. Aligns with Phase-0 minimality philosophy.
- **Composes with Strategy 1.** Belt and braces. Skill catches honest clones early; bus catches buggy ones.
- **Self-documenting.** A reviewer reading the skill or priming sees the rule explicitly; bus filter alone is invisible to a clone reading its own scope.

### Cons

- **Skill drift is a known failure mode.** Phase-1 dogfood produced bug #5 — clones not writing ZK notes despite skill saying "required". The fix was to (a) tighten skill v0.0.2 ("non-negotiable") AND (b) add post-mortem flagging. Pure skill enforcement has been observed insufficient in this very project.
- **Discipline-only.** A clone with stale skill memory, a bug in its system prompt, or a confused interpretation can violate the rule with zero feedback.
- **Doesn't handle the future Tier-3 `tail` scenario.** A sibling subscribing to events.log via `tail` is a *positive* action ("read peer broadcasts") that no skill rule catches at the bus layer.

### Where it fits

Strategy 2 is the **complement**, not the replacement, for Strategy 1. Ship both: skill says "don't", bus enforces "can't", post-mortem says "you did".

---

## 4. Strategy 3 — Orchestrator-policed redaction

> Broadcasts go through, but the orchestrator redacts them from the registry's `events.log` view that siblings query. Heavyweight; rejected unless 1 and 2 both fail.

### Why it's confused in purpose

Re-reading `packages/manta-orchestrator/src/post-mortem.ts:44` — `events.readAll` is consumed at **post-cast time**, by the post-mortem composer, after every clone has died. By the time the orchestrator could redact, the clone has already received the leaked information at write-time (e.g. the `manta.message` tool call returned a success envelope to the sibling clone, which means the sibling now knows the recipient exists by clone_id and the message landed). Post-hoc redaction does not retroactively un-leak that.

The only world in which Strategy 3 makes sense is a hypothetical Phase 5+ daemon-mode where clones tail events.log live (Tier 3). In that world, the orchestrator could intercept the streaming feed and drop sibling events. But that's not "policed redaction" — that's a *streaming filter*, which is architecturally identical to the cast_id-stamped broadcast in Strategy 1 §2 above. So Strategy 3 either degenerates into Strategy 1 (filter at the source), or it's a no-op (filter only after damage is done).

### Pros

- (None that survive the analysis above.)
- Theoretical pro: orchestrator already has `runCycle` integration points; adding a redaction step there *feels* like reusing existing infrastructure. But that feeling is misleading — the leak surface isn't where `runCycle` operates.

### Cons

- **Doesn't actually prevent leakage** — only retroactively cleans audit trail.
- **Heavyweight.** Adds a stateful filter layer to every consumer of `events.readAll`. Today there's one consumer (post-mortem); in Phase 2 there'd be more (replay, audit, tail). Each becomes a redaction client.
- **Couples orchestrator to bus internals.** Today the orchestrator treats events as opaque audit records. Redaction requires the orchestrator to know which event payloads are sensitive per cast — that's bus-domain knowledge bleeding into orchestrator-domain code.
- **Drift-prone.** A new event type added to the bus (Phase 3 charge events, say) requires a parallel redaction-rule update in the orchestrator. Forget the update → silent leak.

### Verdict

**Reject.** Not because Strategy 1 and 2 succeed (they do, separately), but because Strategy 3 is solving a different problem (audit cleanliness) than the spec demands (information isolation at write time).

---

## 5. Recommendation

**Ship Strategy 1 + Strategy 2 in tandem during Phase 2.**

Justification against the three axes the plan asks for:

| Axis            | Strategy 1 + 2 ranking                                                                                            |
|-----------------|-------------------------------------------------------------------------------------------------------------------|
| **Drift cost**  | Strategy 1 alone is hard-enforced — bus rejects malformed calls. Strategy 2 alone is soft (Phase 1 bug #5 proved skill text is regressable). Pair = drift detected at two layers; one regressing without the other still catches the bug. |
| **Implementation cost** | Strategy 1 ≈ 50 LOC (helper + 2 handler edits + new error + 4 tests). Strategy 2 ≈ 15 LOC (env var injection + 1 skill section). Total ≤ 1 chunk of a Phase-2 plan, ≤ 1 day of focused work. |
| **Failure modes** | Strategy 1 fails only if `metadata.cast_id` isn't populated — closed by the schema refine in §2. Strategy 2 fails only if a clone ignores skill text — closed by Strategy 1 catching it loud. Combined failure requires *both* a schema bypass *and* a skill regression — multiplicatively harder than either alone. |

Concrete ordering inside the Phase-2 plan:

1. **Schema patch first** (`schema.ts` refine on `RegisterInputSchema` for `mode === 'forking-realities' → metadata.cast_id required`). One commit, with a unit test on a forking-realities register that omits `cast_id` failing validation.
2. **`BusForkingIsolationError` + `serializeError` mapping**. One commit, error class + server.ts dispatcher branch + test on the dispatcher.
3. **`siblingsInSameForkingCast` helper + `message` handler reject + `broadcast` handler stamp**. One commit, three tests:
   - sibling→sibling `message` under forking-realities → rejected with `forking_isolation`.
   - sibling→sibling `message` under recon-swarm → succeeds (regression guard).
   - clone→bus `broadcast` under forking-realities → succeeds, payload contains `cast_id` + `mode`.
4. **Spawner env var + skill text**. One commit, integration-style test: spawn forking-realities clone, assert `MANTA_BUS_PEER_SCOPE=parent-only` in child env; skill-validator pass on updated `manta-as-clone` v0.0.3.

Each step is independently revertible; the order keeps tests green at every commit (TDD-friendly).

---

## 6. Edge cases

### Main → siblings (allowed) vs sibling → sibling (forbidden) — distinguishing them

**Already structurally distinguished by the existing tool surface.** Evidence:

- `manta.contract_refresh` (the spec Sec 5.7 main-broadcast channel) takes **no `clone_id` input** — schema at `packages/manta-bus/src/schema.ts:98-102` is `{ payload: z.record(...) }` only. The handler at `tools/contract.ts:61-71` appends a `contract_refresh` event with no `clone_id`. So a `contract_refresh` is *implicitly authored by main* and applies to all clones; the filter never sees it via `broadcast` or `message`.
- `manta.broadcast` and `manta.message` both **require** `clone_id` / `from_clone_id` (schema lines 136–151). Main has no clone_id (the orchestrator and CLI never call `manta.register`). So if these handlers see a `clone_id`, they know the caller is a clone, not main.
- Therefore: main → siblings goes through `contract_refresh` (allowed, filter doesn't trigger). Sibling → sibling goes through `message`/`broadcast` (filter triggers iff both peers in same forking cast).

No additional capability tag or auth claim needed. The schema already separates the channels.

### Round-table escalation (Sec 5.4)

Spec Sec 5.4: "Если два клона предложили разные решения — **сами не голосуют**. Эскалация в мейна (как тренер в спорте)."

This is **not** a sibling→sibling channel. It's a clone→main escalation, implemented today via `manta.broadcast { event_type: 'blocker', payload: {...} }`. The main is the implicit consumer (via Tier-2 `manta inspect` and Tier-4 `manta replay`). Strategy 1's broadcast handler still allows this — it just stamps the event with cast_id so a tail consumer can filter. The blocker reaches main; it doesn't reach the rival sibling.

### Shared-path lock contention reveals sibling identity

`BusLockedError(path, ownerCloneId)` (`errors.ts:39-44`) is thrown on conflict. In forking-realities each clone has its own worktree (per spec Sec 15.1: "Worktree-based isolation"), so file paths in `manta.lock` calls are *worktree-relative* — collisions are vanishingly rare unless a clone targets a path outside its worktree. Strict mitigation: in forking-realities, the lock path schema (`LockInputSchema.path` at `schema.ts:127-132`) should additionally refuse paths starting with anything that could resolve outside `taskContract.scope.allowed_paths`. That's a Phase-3 hardening once `forbidden_paths` enforcement (spec Sec 5.7's PreToolUse hooks) is implemented; for Phase 2 ship the existing `BusLockedError` and accept the soft-info leak as a known limitation, documented in `manta-bugs.md` and the forking-realities skill.

### `task_contract.read` cross-reading

Today `tools/contract.ts:38-42` accepts any `clone_id` in the input — a forking-realities sibling could call `manta.task_contract.read { clone_id: 'B' }` and learn sibling B's approach_hint, defeating Sec 5.8. **Phase 2 must add an authorization check**: the handler should compare the requested `clone_id` against the calling clone's identity. Identity at the bus layer today is *implicit* — the only signal is the `clone_id` that's passed in. The MCP transport doesn't carry a verified clone identity (the per-clone MCP connection is identified by which clone process launched it, but the bus server today doesn't track that).

**Recommendation:** in Phase 2, add an optional `requesting_clone_id` field to `TaskContractReadInputSchema` and require it match the `clone_id` for forking-realities mode. Until per-connection identity is plumbed (Phase 5 daemon-mode candidate), this is best-effort — the calling clone can lie about `requesting_clone_id`. So treat it as a defense-in-depth signal complementing Strategy 2 skill text, not a hard guarantee. Log all forking-realities `task_contract.read` calls to events.log for audit; post-mortem flags any cross-reads.

### `claim_work` cross-clone visibility

`packages/manta-bus/src/state/claims.ts` exposes a shared work-claim board. In recon-swarm the board is collaborative — no isolation needed. In forking-realities, sibling B claiming work item X reveals to a tailing sibling A that B exists and what B is working on. **Mitigation:** in forking-realities mode, work-claim is conceptually a no-op (each sibling does the *same* job in isolation), so the simplest fix is to reject `manta.claim_work` for forking-realities clones in the handler — same pattern as the broadcast/message filter, ~10 LOC. Phase-2 plan should call this out explicitly; the spec's Sec 5.2 "Work Claim Board" is implicitly a recon-swarm/refactor-wave concept.

### Contract refresh content

`manta.contract_refresh` payload (`schema.ts:98-102`) is `z.record(z.string(), z.unknown())` — arbitrary content. Per Sec 5.7 the main uses it to broadcast contract updates. In forking-realities the same refresh fan-outs to all siblings, which is *correct* by spec (anchor sync should hit everyone uniformly). But if main accidentally broadcasts cast-A-specific approach_hint via contract_refresh, that leaks across forks. Mitigation: Phase-2 plan must enforce that `manta.contract_refresh` payloads are cast-agnostic; per-cast updates use `manta.task_contract.write` per clone instead. This is a *main-side discipline* rule, codifiable in `manta-coordinate` skill.

### Race: clone calls `broadcast` before its register-time cast_id is queryable

The spawner pre-registers before launching the runner (`clone-spawner.ts:80-93`), and `Registry.register` is `atomicMutateJson` (`registry.ts:31-58`). So by the time the clone process starts and makes its first MCP call, `metadata.cast_id` is already in `registry.json`. No race.

### Cross-mode `from`/`to` mismatch

`siblingsInSameForkingCast` short-circuits on `from.mode !== 'forking-realities'` and `to.mode !== 'forking-realities'`. A recon-swarm clone trying to message a forking-realities clone (which shouldn't happen in normal operation but could happen if two casts overlap and a clone misroutes) returns `false` and falls through to the existing message-handler logic. Acceptable: cross-cast messaging is bizarre but not a Sec 5.8 violation.

### Rejection by subset: filter only blocks, never relaxes

Strategy 1's helper returns `false` (= "not isolated, fall through to existing logic") on every edge case where any precondition is missing. This is **fail-safe**: a misconfigured cast still goes through the normal handler path, doesn't get accidentally dropped. The only way the filter rejects is when *all* the conditions for sibling-in-same-forking-cast are met. Mistakes on the schema-refine side become "filter doesn't fire when it should" (graceful degradation toward today's behavior), never "filter fires when it shouldn't" (blast radius zero).

---

## 7. References

- **Spec section anchors** — all line numbers refer to `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` as of commit `9ed5609` (worktree HEAD at the time of this report).
- **Code references** — all paths and line numbers refer to the current main branch of the worktree this clone runs in (`/Users/timur/projectos/manta/.manta/worktrees/clone-C`), reflecting commits up to `9ed5609`. Files cited:
  - `packages/manta-bus/src/server.ts:115-224` — tool table
  - `packages/manta-bus/src/schema.ts:27-158` — registration + scope + broadcast + message schemas
  - `packages/manta-bus/src/state/registry.ts:7-114` — `CloneRecord`, register, heartbeat, markDead
  - `packages/manta-bus/src/state/events.ts:35-99` — append-only events log; `readAll`/`readSince` private to in-process consumers
  - `packages/manta-bus/src/state/contracts.ts:53-100` — contract store, ack semantics
  - `packages/manta-bus/src/state/locks.ts:17,58-122` — lock owner field, `BusLockedError` site
  - `packages/manta-bus/src/state/paths.ts:1-38` — file layout under `.manta/state`
  - `packages/manta-bus/src/tools/communication.ts:12-52` — broadcast/message/drift handlers (filter target)
  - `packages/manta-bus/src/tools/contract.ts:38-71` — task_contract.read, ack, contract_refresh handlers
  - `packages/manta-bus/src/tools/lifecycle.ts:24-96` — register/heartbeat/suicide/death handlers
  - `packages/manta-bus/src/tools/locks.ts:14-53` — lock/unlock/renew handlers
  - `packages/manta-bus/src/errors.ts:39-44` — `BusLockedError.ownerCloneId`
  - `packages/manta-cli/src/spawner/clone-spawner.ts:53-104` — spawner pre-registration, env injection
  - `packages/manta-cli/src/spawner/priming.ts:3-26` — priming text template
  - `packages/manta-orchestrator/src/post-mortem.ts:44` — only production caller of `events.readAll`
  - `packages/manta-orchestrator/src/orchestrator.ts:1-71` — `runCycle` integration surface
  - `packages/manta-orchestrator/src/status.ts:1-40` — status build (CLI consumer; clones don't query)
- **Prior-art (tertiary, no WebSearch performed in this cast for budget reasons; Phase-2 plan author should verify before relying on these characterisations):**
  - LangGraph's `thread_id` scoping on the checkpointer is the closest direct analogue to Strategy 1 — channel-membership is cast-scoped at the persistence layer, not at the agent layer.
  - CrewAI delegates tasks but does not isolate communication channels between sibling agents in a multi-agent crew; sibling visibility is controlled at the agent prompt level (analogous to Strategy 2 alone).
  - AutoGen's GroupChat broadcasts every message to every participant by default; isolation requires custom group-chat-manager logic at the orchestrator layer. Closer to a Strategy-3-style approach, with the same fundamental write-time leakage issue noted above.

---

## 8. Summary table

| Strategy | Where filter lives | Code cost | Hard or soft | Phase-2 verdict |
|---|---|---|---|---|
| 1. Bus-layer filter | `tools/communication.ts` + new error class + schema refine | ~50 LOC | Hard | **Ship.** |
| 2. Spawner env + skill text | `clone-spawner.ts` env injection + `manta-as-clone` SKILL.md edit | ~15 LOC | Soft | **Ship as belt-and-braces.** |
| 3. Orchestrator-policed redaction | `orchestrator.ts` post-cycle filter on `events.readAll` consumers | ~80 LOC + per-event rules | Soft, post-hoc | **Reject** — solves a different problem; degenerates into Strategy 1 in the cases that matter. |

Combined Strategy 1+2 closes the spec Sec 5.8 surface for Phase 2 with one schema patch, one error class, one helper function, one handler edit each in `broadcast` and `message`, one env var, one skill v0.0.3 bullet, and four tests. Ship as Phase-2 Chunk 2 (after worktree-N spawning lands in Chunk 1).

---

## 9. Industry update — 2026-05-22 (post-cast addendum)

Original bus-isolation research (above) was authored 2026-05-07 by clone-C with prior-art annotated as "tertiary, no WebSearch performed in this cast" (§7). Verifying those characterisations now, plus surveying what shipped industry-side since then. **None of the new entries change the recommendation (Strategy 1 + Strategy 2 still ships).** They sharpen the framing of *what Manta is unique in* and *why competitor isolation models leave the Sec 5.8 surface open*.

### What every public competitor does for isolation, and what gap it leaves

| System | Isolation primitive | Peer-bus exists? | Plagiarism prevention? | Maps to Manta |
|---|---|---|---|---|
| **Claude Code Agent Teams** (Anthropic, v2.1.32+, experimental) | None at filesystem level — "two teammates editing the same file leads to overwrites; break the work so each teammate owns a different set of files" | **Yes** — mailbox with direct teammate-to-teammate messaging, plus shared task list with file-lock-based claim | **No** — teammates can read each other's outputs via mailbox; design intent is collaboration, not adversarial parallel candidates | Closer to `recon-swarm` (peer messaging *allowed*) than `forking-realities`. Anthropic's mailbox is the closest public competitor to our `manta.message` MCP tool. The fact that it ships **with no isolation mode at all** confirms there is no off-the-shelf solution for Sec 5.8. |
| **Replit Agent 4** (2026-03) | Each task runs in "isolated environments — exact copies of your current project"; merge-agent resolves conflicts on reintegration | No peer-bus disclosed; coordination via orchestrator | N/A — forks are different *tasks*, not parallel candidates for the same task | Different problem domain (refactor-wave-like). No insight transferable to Phase 2b. |
| **oh-my-codex / Conductor / Composio agent-orchestrator** | Git worktree per agent; PreToolUse/PostToolUse hooks prevent cross-boundary writes | No bus; coordination via shared `.git` object database and tmux dashboard | Not addressed — there is nothing to leak through because no peer-channel exists | Validates that worktree isolation is necessary and table-stakes (matches Manta Phase 0 baseline). Doesn't address Sec 5.8 because the problem doesn't exist in their architecture. |
| **CrewAI** | Process-level agent isolation; communication via tasks/delegations | Implicit via task delegation; no broadcast surface | Soft, prompt-level only (matches Manta's Strategy 2 if used alone) | Verified §7's characterisation. Strategy 2 alone is what CrewAI ships; Manta improves on this with Strategy 1's hard-stop at the bus. |
| **AutoGen GroupChat** | None at filesystem level; group-chat-manager logic at orchestrator | Yes — every message broadcast to every participant by default | None built-in; isolation requires custom group-chat-manager rules | Verified §7's characterisation. Closest to a "Strategy 3" shape — exactly the pattern §6 rejects for being soft and post-hoc. |
| **LangGraph** | `thread_id`-scoped checkpointer | Channel membership cast-scoped at the persistence layer | Hard via thread isolation, but channel-per-cast model differs from Manta's per-clone-within-cast | Verified §7's characterisation. `thread_id` is structurally similar to Manta's `metadata.cast_id` stamp, but LangGraph isolates at thread boundaries; Manta isolates *within* a cast (forking-realities siblings) which LangGraph doesn't natively address. |

**Synthesis:** the public competitor that comes closest architecturally — Claude Code Agent Teams — explicitly *opts out* of the isolation problem ("break the work so each teammate owns a different set of files"). The competitor that comes closest to forking-realities semantically — Replit Agent 4 — solves a different problem (different tasks, not parallel candidates). **No public system enforces Sec 5.8 because no public system has both (a) a peer-messaging bus and (b) parallel candidates for the same task.** Manta is in unclaimed territory; ship Strategy 1+2 as-is.

### Validates our design

- **Bus-layer filter (Strategy 1) is the right mechanism for hard isolation.** Every public system that punts on isolation (Agent Teams, AutoGen) does so *because* the filter is missing at the message-bus layer. The few that have it (LangGraph thread_id) prove it works.
- **Worktree isolation is necessary but insufficient.** oh-my-codex's PreToolUse/PostToolUse hooks confirm filesystem-level isolation is industry standard; Phase 0 baseline is correct. But that isolation doesn't address peer messaging — exactly the gap Strategy 1 closes.
- **Cast-stamp at write time, not read-time redaction.** Strategy 3 (§6) was rejected on the grounds that orchestrator-policed redaction is post-hoc. AutoGen's GroupChat broadcasting-then-filtering is the cautionary example: write-time leakage exists in their architecture because the filter runs at read time.

### Adjacent changes worth tracking (deferred, not Phase 2b)

These come from competitor observation, not from spec changes:

1. **`MANTA_BUS_PEER_SCOPE=denied` semantic stays right, but consider exposing it as `peer_scope: 'denied'|'cast'|'global'`.** Phase 2b ships binary denied/allowed; Phase 4 modes (`refactor-wave`, `bug-hunt`) may want `cast`-scoped peer messaging where siblings in the same cast can talk but cross-cast cannot. Defer to Phase 4 — needs use case validation from dogfood first.
2. **`TaskCompleted` / `TeammateIdle` hooks (Agent Teams).** Anthropic infrastructurised lifecycle events that Manta currently expresses in the `manta-graceful-death` skill (soft prior). When Phase 4+ matures, consider migrating to PreToolUse/PostToolUse hook surface for hard enforcement — consistent with `claude-code-pitfalls.md` §3-§4 guidance. Defer until skill-based approach actually fails in dogfood; speculative migration burns budget.
3. **Audit `events.readAll` consumer list (§5).** The original research listed `post-mortem.ts:44` as the only production caller. Verify before Phase 2b execute — if a second caller appeared (e.g., new debug/replay tooling from Phase 2d preview), Strategy 1 may need extension. Cheap to re-check: `grep -rn 'events.readAll\|EventsLog.readAll' packages/`. Treat as Phase 2b pre-flight, not blocking.

### What we are explicitly choosing not to copy

- **Agent Teams' mailbox-over-isolation default.** For `forking-realities`, hard deny at the bus is correct. For `recon-swarm`, our existing `peer_messaging: 'allowed'` already matches Agent Teams' default — no change needed.
- **AutoGen-style "filter on read" architecture.** Confirmed write-time leakage risk in §6. Reject again.
- **Replit-style merge-agent for sibling reconciliation.** Phase 2c best-of-N replaces this — sibling diffs are scored and one wins, no reconciliation needed.

### Updated source list

See "Sources" below — entries 1-9 are the original 2026-05-07 cast prior-art (mostly Wikipedia/spec); entries 10-15 added 2026-05-22.

## Sources

1. `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` Sec 5.5, 5.7, 5.8, 11
2. `packages/manta-bus/src/server.ts` — 18-tool handler surface
3. `packages/manta-bus/src/state/events.ts` — append-only log architecture
4. `packages/manta-bus/src/tools/communication.ts` — broadcast/message/drift handlers
5. `packages/manta-bus/src/tools/contract.ts` — task_contract handlers
6. `packages/manta-cli/src/spawner/clone-spawner.ts` — spawner pre-registration and env injection
7. `packages/manta-orchestrator/src/post-mortem.ts` — only production `events.readAll` consumer at time of cast
8. LangGraph checkpointer thread_id scoping (general docs, characterisation verified)
9. CrewAI delegation model (general docs, characterisation verified)
10. [Claude Code Agent Teams — official docs (Anthropic)](https://code.claude.com/docs/en/agent-teams) — mailbox / shared task list / file-lock claim / "no built-in worktree isolation" admission
11. [Replit — What's changed from Agent 3 to Agent 4 (2026-03)](https://replit.com/blog/whats-changed-agent3-to-agent4) — fork-per-task + merge-agent architecture
12. [particula.tech — oh-my-codex worktree pattern](https://particula.tech/blog/parallel-coding-agents-worktree-pattern-oh-my-codex) — PreToolUse/PostToolUse hooks for cross-boundary writes
13. [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) — git-worktree-per-agent, no peer-bus
14. [AutoGen GroupChat docs](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/components/group-chat.html) — broadcast-all default, characterisation verified
15. [LangGraph checkpointer / thread_id docs](https://langchain-ai.github.io/langgraph/concepts/persistence/) — thread-scoped persistence as Strategy-1 analogue

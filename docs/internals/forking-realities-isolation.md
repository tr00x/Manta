# Forking-realities Bus tool allow/reject table

Per spec Sec 5.8 + Phase 2b enforcement. Closed set — every Bus tool is
either allow-listed or reject-listed below; an unlisted tool is a plan
gap. Cross-reference: `packages/manta-bus/src/server.ts` tool table.

| Tool                          | recon-swarm | forking-realities          | Enforcement layer                |
|-------------------------------|-------------|----------------------------|----------------------------------|
| manta.register                | allow       | allow (cast_id required)   | RegisterInputSchema.refine       |
| manta.heartbeat               | allow       | allow                      | n/a                              |
| manta.suicide_intent          | allow       | allow                      | n/a                              |
| manta.report_death            | allow       | allow                      | n/a                              |
| manta.task_contract.read      | allow       | allow self only            | crossCloneRead helper            |
| manta.task_contract.write     | allow       | allow (spawner-only)       | n/a                              |
| manta.ack_contract            | allow       | allow                      | n/a                              |
| manta.contract_refresh        | allow       | allow (main-only by shape) | schema (no clone_id field)       |
| manta.claim_work              | allow       | reject                     | claim_work handler               |
| manta.release_work            | allow       | allow (no plagiarism risk) | n/a                              |
| manta.lock                    | allow       | allow (soft-leak — below)  | manta-bugs known limitation      |
| manta.unlock                  | allow       | allow                      | n/a                              |
| manta.renew_lock              | allow       | allow                      | n/a                              |
| manta.broadcast               | allow       | allow (cast_id-stamped)    | communication handler            |
| manta.message                 | allow       | reject sibling             | siblingsInSameForkingCast helper |
| manta.drift_report            | allow       | allow                      | n/a                              |
| manta.read_broadcasts         | allow       | allow (cast_id-scoped, self-excluded — see limitation) | communication handler (cast_id filter) |
| manta.zk_write                | allow       | allow (skill-restricted)   | manta-as-clone v0.0.4            |
| manta.para_append             | allow       | allow (skill-restricted)   | manta-as-clone v0.0.4            |
| manta.retask                  | allow       | allow (main→clone control) | n/a (orchestrator-issued)        |
| manta.pause                   | allow       | allow (main→clone control) | n/a (orchestrator-issued)        |
| manta.resume                  | allow       | allow (main→clone control) | n/a (orchestrator-issued)        |
| manta.request_task            | allow       | allow (daemon self-signal) | n/a                              |
| manta.feedback                | allow       | allow (main→clone control) | n/a (orchestrator-issued)        |
| manta.enqueue_work            | allow       | allow (main→clone control) | n/a (orchestrator-issued)        |

The table now enumerates all 25 Bus tools (the original Phase 2b table covered
18; the 6 daemon/work control-plane tools — `retask`/`pause`/`resume`/`feedback`
/`enqueue_work` plus `request_task` — landed in Phase 5/7c, and `read_broadcasts`
was a communication-family omission). The control-plane tools are `allow` because
the caller is the **main/orchestrator**, not a sibling clone, so they carry no
sibling-plagiarism risk; `request_task` is a daemon clone's own idle-signal.

## Known limitations

- **`read_broadcasts` is cast-scoped, not peer-scoped.** The handler filters
  events by `cast_id` and excludes the caller's own events
  (`communication.ts` `readBroadcasts`), but applies no `parent-only`
  peer-scope gate. In a forking-realities cast all siblings share one
  `cast_id`, so a clone calling `read_broadcasts` could observe sibling
  broadcast events — the broadcast channel is the clone→main escalation path,
  and nothing structurally stops a FR clone from reading it. Whether this is
  acceptable (broadcasts are deliberately low-sensitivity) or wants a
  peer-scope filter is an open isolation question, consistent with the
  soft-info-leak class below. Flagged for curator review; not a doc-destaling
  fix.
- **Lock owner-id leak.** `BusLockedError.ownerCloneId` reveals who holds a
  lock on a contended path. In forking-realities each clone has its own
  worktree so collisions are rare, but an aggressive clone could lock a
  parent-repo path to probe siblings. Phase 5+ PreToolUse hooks are the
  durable fix.
- **Filesystem-level access.** A skill-violating clone could
  `cd ../clone-B && cat`. Skill discipline is the only Phase 2b defense;
  Phase 5+ filesystem hooks are the durable fix.
- **`requesting_clone_id` is operator-trusted.** A malicious clone can lie
  about its own clone_id. Per-connection identity lands in Phase 5
  daemon-mode.

## Forward pointers

- Phase 2c: merge-review with composite scoring reads `cast_id`-stamped
  broadcast events to build per-clone quality signals.
- Phase 2d: `tail` consumer uses `cast_id` + `cast_mode` from broadcast
  events to filter sibling visibility before delivering to a tailing peer.
- Phase 4+: helper swaps from `cast_mode === 'forking-realities'` to
  `ctx.casts.read(cast_id).policy.peer_messaging === 'denied'` once more
  modes need partial-isolation policies.
- Phase 5+: PreToolUse hooks for filesystem-level enforcement + per-
  connection identity for transport-verified `requesting_clone_id`.

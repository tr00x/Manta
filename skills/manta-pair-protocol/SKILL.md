---
name: manta-pair-protocol
description: Pair-programming mode protocol for writer/reviewer clone coordination. Load when mode is pair-programming.
audience: clone
version: 0.0.1
related: [manta-as-clone, manta-daemon-idle, manta-graceful-death]
---

# manta-pair-protocol

## Purpose

Coordination protocol for pair-programming mode. Two daemon clones collaborate: one writes code, the other reviews each commit. The orchestrator mediates via sequential resume cycles with broadcast-based signaling.

## Allowed

- Writer: implement code, run tests, commit, broadcast `task_complete`, transition to IDLE
- Reviewer: review diffs, broadcast `feedback_received` with verdict, transition to IDLE
- Both: call `manta.heartbeat` for state transitions, `manta.broadcast` for coordination
- Both: read sibling broadcasts via `manta.read_broadcasts` for cross-clone signals
- Both: up to 5 review iterations per task before escalating to main

## Forbidden

- Writer must NOT push to remote — main pulls from worktree branch
- Reviewer must NOT modify code files — review only, feedback via broadcast
- Neither clone calls `manta-graceful-death` between iterations — only at session end
- Neither clone starts the next iteration without the other's signal

## Examples

```
# Writer completes implementation:
manta.broadcast({ clone_id: "A", event_type: "task_complete",
  payload: { commit_ref: "abc123", summary: "implement query builder cache" } })
manta.heartbeat({ clone_id: "A", state: "IDLE" })

# Reviewer reviews and responds:
manta.broadcast({ clone_id: "B", event_type: "feedback_received",
  payload: { verdict: "changes_requested", comments: ["missing edge case for empty input"] } })
manta.heartbeat({ clone_id: "B", state: "IDLE" })

# Orchestrator delivers feedback to writer via next resume cycle.
# Writer applies feedback, re-commits, broadcasts again.
# After approval: both clones proceed to graceful death.
```

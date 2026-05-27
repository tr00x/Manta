---
name: manta-pair-protocol
description: Pair-programming mode protocol for writer/reviewer clone coordination. Load when mode is pair-programming.
audience: clone
version: 0.1.0
related: [manta-as-clone, manta-daemon-idle, manta-graceful-death, manta-pair-writer, manta-pair-reviewer]
---

# manta-pair-protocol

## Purpose

Coordination protocol for pair-programming mode. Two daemon clones collaborate: one writes code, the other reviews each commit. The orchestrator mediates via the PairDispatcher state machine with broadcast-based signaling.

After loading this skill, load your role-specific skill: `manta-pair-writer` (if you are the writer) or `manta-pair-reviewer` (if you are the reviewer). Your role is specified in your task contract's approach_hint field.

## Allowed

- Writer: implement code, run tests, commit, broadcast `commit_ready`, transition to IDLE
- Reviewer: review diffs, broadcast `review_complete` with verdict, transition to IDLE
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
manta.broadcast({ clone_id: "A", event_type: "commit_ready",
  payload: { commit_ref: "abc123", summary: "implement query builder cache",
  files_changed: ["src/cache.ts"], iteration: 1 } })
manta.heartbeat({ clone_id: "A", state: "IDLE" })

# Reviewer reviews and responds:
manta.broadcast({ clone_id: "B", event_type: "review_complete",
  payload: { verdict: "changes_requested", iteration: 1,
  comments: [{ file: "src/cache.ts", line: 42, severity: "correction",
  comment: "missing edge case for empty input" }] } })
manta.heartbeat({ clone_id: "B", state: "IDLE" })

# PairDispatcher delivers feedback to writer via work queue.
# Writer applies feedback, re-commits, broadcasts commit_ready again.
# After approval: both clones proceed to graceful death.
```

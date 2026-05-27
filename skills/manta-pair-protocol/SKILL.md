---
name: manta-pair-protocol
description: Pair-programming mode protocol for writer/reviewer clone coordination. Load when mode is pair-programming.
audience: clone
version: 0.0.1
related: [manta-as-clone, manta-daemon-idle, manta-graceful-death]
---

# manta-pair-protocol

## Pair-Programming Mode Protocol

You are in a pair-programming cast. Two clones work together: one writes code, one reviews it.

### Writer Role
1. Read your task contract — it specifies what to implement
2. Write the code, run tests, commit to your branch
3. Broadcast completion: `manta.broadcast({ clone_id: "<your-id>", event_type: "task_complete", payload: { commit_ref: "<sha>", summary: "<one-line>" } })`
4. Transition to IDLE: `manta.heartbeat({ clone_id: "<your-id>", state: "IDLE" })`
5. Wait for reviewer feedback via the next resume cycle
6. Apply feedback, re-commit, broadcast again
7. Repeat until reviewer approves or iteration budget exhausted

### Reviewer Role
1. Wait for the writer's `task_complete` broadcast (delivered in your resume prompt)
2. Review the diff: `git diff main...<writer-branch>`
3. Broadcast review: `manta.broadcast({ clone_id: "<your-id>", event_type: "feedback_received", payload: { verdict: "approved" | "changes_requested", comments: [...] } })`
4. If changes_requested: transition to IDLE and wait for writer's next iteration
5. If approved: both clones proceed to graceful death

### Iteration Budget
Maximum 5 review iterations per task. After 5, escalate to main regardless of state.

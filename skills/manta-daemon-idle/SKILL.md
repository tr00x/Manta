---
name: manta-daemon-idle
description: Idle protocol for daemon-mode clones between tasks. Load when entering IDLE state after completing a task.
audience: clone
version: 0.0.1
related: [manta-as-clone, manta-graceful-death]
---

# manta-daemon-idle

## Purpose

Protocol for daemon-mode clones when they complete a task and wait for new work. Loaded when a clone transitions to IDLE state. Ensures the clone signals readiness, stays discoverable by the orchestrator, and does not start unauthorized work.

## Allowed

- Call `manta.heartbeat({ clone_id: "<your-id>", state: "IDLE" })` to transition to IDLE
- Call `manta.request_task({ clone_id: "<your-id>" })` to signal readiness for new work
- Check `manta.read_broadcasts` for feedback or coordination messages from siblings
- Review and organize notes from your previous task
- Monitor your session budget remaining

## Forbidden

- Do NOT start new work without an explicit re-task from the orchestrator
- Do NOT call `manta-graceful-death` while IDLE — session continues until explicit shutdown
- Do NOT call `manta.suicide_intent` or `manta.report_death` between tasks
- Do NOT modify files in the worktree while IDLE

## Examples

```
# After completing a task:
manta.heartbeat({ clone_id: "A", state: "IDLE" })
manta.request_task({ clone_id: "A" })

# Then wait. The orchestrator will resume your session with new work.
# If the orchestrator sends "graceful shutdown" or "session end":
# → Follow the normal manta-graceful-death sequence.
```

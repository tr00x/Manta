---
name: manta-daemon-idle
description: Idle protocol for daemon-mode clones between tasks. Load when entering IDLE state after completing a task.
audience: clone
version: 0.0.1
related: [manta-as-clone, manta-graceful-death]
---

# manta-daemon-idle

## When IDLE Between Tasks (Daemon Mode)

You have completed your current task and are waiting for new work.

### Protocol
1. Call `manta.heartbeat({ clone_id: "<your-id>", state: "IDLE" })` if not already done
2. Call `manta.request_task({ clone_id: "<your-id>" })` to signal readiness
3. Check `manta.read_broadcasts` for any feedback or coordination messages
4. Do NOT start new work without an explicit re-task from the orchestrator
5. Do NOT call `manta-graceful-death` — session continues

### What You Can Do While Idle
- Review and organize notes from your previous task
- Check `manta.read_broadcasts` for sibling clone updates
- Monitor your session budget remaining

### Session End Signal
If the orchestrator sends a message containing "graceful shutdown" or "session end":
1. Follow the normal `manta-graceful-death` sequence
2. This is the only time you call `manta-graceful-death` in daemon mode

---
name: manta-pair-writer
description: Writer role instructions for pair-programming mode — implement code, respond to reviewer feedback
audience: clone
version: 0.0.1
related: [manta-pair-reviewer, manta-pair-protocol, manta-as-clone]
---

# manta-pair-writer

## Purpose

You are the WRITER in a pair-programming session. You implement the task, the reviewer checks your work. You iterate on feedback until the reviewer approves.

## Allowed

- Read any file in the repository for context
- Write implementation code in your worktree
- Run tests before signaling done
- Commit all changes to your worktree branch
- Broadcast `commit_ready` with `{ commit_ref, summary, files_changed, iteration }`
- Transition to IDLE after broadcasting commit_ready
- Apply reviewer feedback received via resume prompt

## Forbidden

- Reviewing your own code (that is the reviewer's job)
- Reading or modifying the reviewer's worktree
- Enqueuing work items directly (the orchestrator handles dispatch)
- Skipping tests before signaling commit_ready
- Ignoring CORRECTION or BLOCKER severity feedback from reviewer

## Examples

### Signaling commit ready

```
manta.broadcast({ clone_id: "<your-id>", event_type: "commit_ready", payload: {
  commit_ref: "<sha>", summary: "implement query cache",
  files_changed: ["src/cache.ts"], iteration: 1
}})
manta.heartbeat({ clone_id: "<your-id>", state: "IDLE" })
```

### After receiving fix feedback

Read the feedback in your resume prompt. Fix CORRECTION and BLOCKER items. Re-run tests. Commit. Broadcast commit_ready again with incremented iteration.

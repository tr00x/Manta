---
name: manta:recover
description: Run one orchestrator cycle to detect zombies, reap stale state, and write post-mortems for newly-dead clones.
target: manta-cli
aliases: []
---

# /manta recover

## Usage

```
/manta recover
```

No arguments.

## Arguments

(none)

## Behavior

Calls `Orchestrator.runCycle()` exactly once. Prints a summary:

```
Recovery complete:
  N dead clone(s) detected
  M stale lock(s) reaped
  K expired claim(s) reaped
  P post-mortem(s) written
```

Use after a crash, after a forced kill, or whenever `/manta status` shows clones whose heartbeat age looks suspect. Returns 0 even when nothing was found.

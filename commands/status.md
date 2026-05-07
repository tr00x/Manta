---
name: manta:status
description: Print the orchestrator's snapshot — clones, locks, claims, thresholds.
target: manta-cli
aliases: []
---

# /manta status

## Usage

```
/manta status
```

No arguments.

## Arguments

(none)

## Behavior

Calls `Orchestrator.getStatus()` and renders an ASCII table:

```
Clone | Mode         | State        | Heartbeat age | Locks                | Claims
------+--------------+--------------+---------------+----------------------+----------------------
A     | recon-swarm  | WORKING      | 4s            | src/foo.ts           | task-1
B     | recon-swarm  | WINDING_DOWN | 12s           | -                    | -
```

Exits 0 always. If no clones are registered, prints `No active clones.`

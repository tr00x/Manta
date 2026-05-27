# Pair-Programming Mode

Two clones collaborate on a task: one writes code, the other reviews each commit. The orchestrator mediates iteration cycles through the PairDispatcher state machine.

## Usage

```bash
manta cast pair-programming --task "implement auth module" --clones 2
```

Exactly 2 clones are required. Clone A is auto-assigned the **writer** role, Clone B the **reviewer** role.

## How It Works

1. **Writer** implements the task, runs tests, commits, and broadcasts `commit_ready`
2. **PairDispatcher** detects the broadcast and enqueues a review work item for the reviewer
3. **Reviewer** reviews the diff, runs tests, broadcasts `review_complete` with a verdict
4. If verdict is `approved` — cast completes
5. If verdict is `changes_requested` — dispatcher routes feedback back to the writer
6. Writer applies fixes, re-commits, broadcasts `commit_ready` again
7. Max 5 iterations; after that the dispatcher escalates to the main agent

## Broadcast Events

| Event | Sender | Payload |
|-------|--------|---------|
| `commit_ready` | writer | `{ commit_ref, summary, files_changed, iteration }` |
| `review_complete` | reviewer | `{ verdict, comments, iteration, summary }` |

## Review Verdicts

- `approved` — code is ready, cast ends
- `changes_requested` — writer must fix issues and re-submit
- `blocker` — critical issue, high-priority fix enqueued

## Skills

- `manta-pair-protocol` — coordination protocol (both clones)
- `manta-pair-writer` — writer role instructions
- `manta-pair-reviewer` — reviewer role instructions

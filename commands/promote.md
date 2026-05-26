---
name: manta:promote
description: Merge the winning candidate from a forking-realities cast
target: main
aliases: []
---

# /manta promote

## Usage

```
/manta promote <castId>/<cloneId>
```

## Arguments

| Argument | Required | Description |
|---|---|---|
| `<castId>/<cloneId>` | yes | The cast ID and winning clone ID separated by `/`. Example: `cast-1234567890/B`. |

## Behavior

1. Validates the cast exists and the clone is in the roster.
2. Checks that a merge-review has been generated for this cast.
3. Reads the winner's score from the merge-review event.
4. Merges the winner's worktree branch into the current branch with `git merge --no-ff`.
5. Moves all loser worktrees to `.manta/graveyard/<castId>-<cloneId>/` with `info.json` sidecar.
6. Removes the winner's worktree (already merged).
7. Emits a `promote` event to the events log.

Error cases:
- Cast not found → `not_found` error.
- Clone not in roster → `invalid_input` error.
- No merge-review event → `invalid_input` error.
- Git merge conflict → `cast_failed` error (resolve manually).

# Test-Storm Mode

A coder, tester, and optional fuzzer clone collaborate in a pipeline: the coder implements, the tester writes and runs tests, the fuzzer writes property/boundary tests. The TestStormDispatcher manages stage transitions and fix cycles.

## Usage

```bash
manta cast test-storm --task "implement and test caching layer" --clones 3
```

2–3 clones required. Clone A is the **coder**, Clone B the **tester**, Clone C (optional) the **fuzzer**. With 2 clones, the tester also handles fuzzing.

## How It Works

1. **Coder** implements the feature, locks source files, commits, broadcasts `code_ready`
2. **TestStormDispatcher** routes to tester with a test prompt
3. **Tester** writes tests, runs suite, broadcasts `tests_ready` with pass/fail verdict
4. If tests **pass** — dispatcher routes to fuzzer
5. If tests **fail** — dispatcher routes fix request back to coder (high priority)
6. **Coder** fixes, re-commits, broadcasts `code_ready` again
7. Max 3 fix cycles; after that the stage is escalated to the main agent
8. **Fuzzer** writes property-based and boundary tests, broadcasts `fuzz_complete`
9. Stage is marked **complete**

## Pipeline Stages

Each feature goes through these states:

```
coding → testing → fuzzing → complete
              ↓
           fixing → testing (retry)
              ↓ (after 3 cycles)
           escalated
```

## Broadcast Events

| Event | Sender | Payload |
|-------|--------|---------|
| `code_ready` | coder | `{ feature_id, commit_ref, summary, files_changed }` |
| `tests_ready` | tester | `{ feature_id, verdict, commit_ref, summary, failures? }` |
| `fuzz_complete` | fuzzer | `{ feature_id, commit_ref, summary, tests_added }` |

## Test Verdicts

- `pass` — all tests pass, proceed to fuzzing
- `fail` — tests failed, fix cycle begins

## Concurrency

The dispatcher manages multiple features concurrently. Each feature has its own independent pipeline stage, so the coder can start a new feature while the tester tests a previous one.

## Shared Worktree

All test-storm clones operate in the same worktree (unlike forking-realities). Source file access is coordinated via `manta.lock` — the coder locks source files, the tester locks test files. All clones must acquire the `GIT_OPERATIONS` virtual lock before running git commands.

## Skills

- `manta-storm-coder` — coder role instructions
- `manta-storm-tester` — tester role instructions
- `manta-storm-fuzzer` — fuzzer role instructions

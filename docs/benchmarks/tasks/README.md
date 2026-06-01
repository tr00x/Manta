# Benchmark task fixtures

Each `*.task.md` is one benchmark task: a clear **prompt** (handed verbatim to
each method) and an **objective success check** (a shell command that exits `0`
when the task is done correctly). The check is what makes the benchmark honest —
"tests pass" is the gate before any speed/diff/usage number counts.

| Task | Mode it exercises | Success check kind |
|---|---|---|
| [`recon-map`](./recon-map.task.md) | recon-swarm (read-only) | grep: the audit doc covers the required areas |
| [`refactor-rename`](./refactor-rename.task.md) | refactor-wave | grep + build: zero old call sites, still compiles |
| [`bug-multilayer`](./bug-multilayer.task.md) | bug-hunt | test: the regression test passes |

## How a fixture is used

1. **Target repo.** Each task names the kind of repo it needs. Point the runner
   at a checkout via `BENCH_TARGET=/path/to/repo`. For reproducibility, pin it to
   a specific commit. (These fixtures are *specs*, not bundled repos — that keeps
   the benchmark small and lets you run it against a codebase you trust.)
2. **Prompt.** The `## Prompt` block is fed identically to manta / subagents /
   solo. No method gets extra hints.
3. **Success check.** The `## Success check` block is run after the method
   finishes; exit `0` = pass. Only passing runs count toward the other metrics.

## Adding a task

Copy an existing `*.task.md`, keep the three sections (`## Repo`, `## Prompt`,
`## Success check`), and make the success check **objective and cheap** (a grep
or a single test, not a human judgment call). A task whose success can't be
checked by a script doesn't belong in an automated benchmark.

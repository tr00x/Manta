# Task: refactor-rename

Exercises **refactor-wave** — the same mechanical change across many files. Tests
parallel partitioning + correctness on a tedious, well-defined change.

## Repo

Any TS/JS project that uses a function with many call sites you can rename. Pick a
real symbol in your target repo and set:

```
BENCH_TARGET=/path/to/target-repo
BENCH_TARGET_REF=<commit-sha>
OLD_SYMBOL=oldName        # e.g. logger.log(level, msg)
NEW_SYMBOL=newName        # e.g. logger[level](msg)
```

## Prompt

```
Rename every call site of `${OLD_SYMBOL}` to the new API `${NEW_SYMBOL}`
throughout src/ and tests/. Keep behavior identical. Update any test that asserts
on the old signature. Do not change unrelated code.
```

## Success check

Zero remaining old call sites **and** the project still builds/tests green. Exit
`0` = pass:

```bash
# no occurrences of the old symbol remain in source/tests
! grep -rIn --include='*.ts' --include='*.js' -e "$OLD_SYMBOL" src tests
# and the project still passes its own gate (adjust to the target repo)
&& (pnpm gate || npm test || pnpm test)
```

> The `&& (pnpm gate || npm test …)` line means: the rename is only a pass if the
> codebase still compiles and its tests pass. A rename that leaves the build
> broken is a fail, no matter how fast.

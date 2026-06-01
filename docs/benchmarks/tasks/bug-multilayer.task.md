# Task: bug-multilayer

Exercises **bug-hunt** — a bug whose root cause spans more than one layer. Tests
whether a clone that inherited the discussion finds the real cause vs. a cold
helper patching a symptom.

## Repo

A project with a **known, seeded** multi-layer bug and a regression test that is
currently failing (or absent and specified). The cleanest setup: a fixture branch
where the bug is real and a test `bug-repro` reproduces it.

```
BENCH_TARGET=/path/to/target-repo
BENCH_TARGET_REF=<commit-with-the-seeded-bug>
REPRO_TEST="bug-repro"      # the test name / file that must go green
```

## Prompt

```
There is a bug: <one-line symptom, e.g. "the running total is wrong when an item
is removed then re-added"it reproduces with the `${REPRO_TEST}` test>. Find the
root cause — it may span more than one layer (the reducer, the selector, and the
cache). Fix the cause, not the symptom, and make `${REPRO_TEST}` pass without
breaking other tests.
```

## Success check

The regression test passes **and** the rest of the suite still passes. Exit `0` =
pass:

```bash
# the specific repro test goes green
(pnpm test "$REPRO_TEST" || npm test -- "$REPRO_TEST") \
# and nothing else regressed
&& (pnpm gate || npm test)
```

> Two-part check on purpose: fixing the repro while breaking another test is a
> fail. This is what separates a real root-cause fix from a symptom patch.

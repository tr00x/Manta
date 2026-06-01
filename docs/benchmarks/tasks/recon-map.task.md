# Task: recon-map

Exercises **recon-swarm** — read-only codebase mapping. Tests whether warm
context (inheriting the conversation) produces a more useful map than a cold
helper.

## Repo

Any moderately-sized TypeScript/JS project with at least two distinct subsystems
(e.g. an `auth` area and a `billing`/`api` area). Pin to a commit:

```
BENCH_TARGET=/path/to/target-repo
BENCH_TARGET_REF=<commit-sha>
```

## Prompt

```
Map this codebase for someone about to add a feature. Produce docs/audits/map.md
covering, for each major subsystem: its entry points, the main data-flow path,
and where a new feature would hook in. Be specific (file:line references), not
generic.
```

## Success check

The map must exist and actually cover the subsystems (adjust the grep terms to
the target repo). Exit `0` = pass:

```bash
test -f docs/audits/map.md \
  && grep -qiE 'entry point' docs/audits/map.md \
  && grep -qiE 'auth' docs/audits/map.md \
  && grep -qiE 'billing|api' docs/audits/map.md \
  && grep -qE '[A-Za-z0-9_/-]+\.(ts|js|tsx):[0-9]+' docs/audits/map.md   # has file:line refs
```

> This is a coarse check (does the map exist and reference the right areas with
> concrete file:line pointers). Quality beyond that is a qualitative note in
> RESULTS.md — record it honestly, including when a method's map is thin.

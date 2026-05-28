# Last-gasp report — clone-A (cast-1779997703425, refactor-wave)

## Summary

Phase 7a Chunk 2 — CLI command surface complete. Four atomic commits land
Tasks 2.1 (install flag matrix), 2.2 (uninstall), 2.3 (library subcommands),
and 2.5 (e2e test + fixture) on branch `manta/cast-1779997703425/A`.
Workspace-wide `pnpm -r build && pnpm -r test` is green: 1110/1110 tests
across all six packages. Lint matches main (zero new errors introduced;
@manta/cli baseline of 360 pre-existing errors is unchanged). Stayed inside
allowed_paths — never touched `cast.ts`, `integrity.ts`, `tests/library/`,
or `docs/`, all of which belong to Clone B.

## Commits on the worktree branch

| SHA      | Subject |
|----------|---------|
| ec132ab  | feat(cli): manta install flag completeness — force/offline/integrity/json/dry-run/no-validate/no-hooks |
| 944851f  | feat(cli): manta uninstall — multi-version check, in-use check, lockfile drop |
| 29253f9  | feat(cli): manta library list/show/outdated/doctor observability subcommands |
| 4abd744  | test(e2e): install + cast a library mode end-to-end (env-gated MANTA_E2E=1) |

## Deliverables

* `packages/manta-cli/src/commands/install.ts` — extended with 7 flags + new
  `install_network_required_for_spec_kind` (exit 11) and
  `install_checksum_mismatch` (exit 13) error codes; reorganised pipeline so
  integrity preflight runs before extract and dry-run short-circuits before
  commit.
* `packages/manta-cli/src/library/registry-client.ts` — added
  `CreateRegistryClientOptions.offline` + `RegistryClientErrorCode.offline_refused`
  so the `--offline` flag refuses non-local-tgz specs before any runner call.
* `packages/manta-cli/src/commands/uninstall.ts` — new; full pipeline per plan
  §3.4, including in-use check that enumerates all six non-DEAD lifecycle
  states (STARTING/WORKING/BLOCKED/IDLE/WAITING_FOR_TASK/WINDING_DOWN) and
  rejects `--force` against hot states.
* `packages/manta-cli/src/commands/library.ts` — new; runLibraryList/Show/
  Outdated/Doctor with `LibraryError` codes 12 (not_installed) and 20
  (library_unhealthy). `LibraryNetworkRunner` kept disjoint from the
  registry-client `NetworkRunner` to avoid widening unrelated consumers.
* `packages/manta-cli/src/bin/manta.ts` — wired install/uninstall/library
  subcommands + `rejectHookOverrideEarly()` pre-commander guard that fires
  before commander would otherwise reject `--no-hooks=false` as an unknown
  option.
* `packages/manta-cli/src/index.ts` — re-exports `commands/uninstall` and
  `commands/library`.
* `packages/manta-cli/tests/commands/{install,uninstall,library}.test.ts` —
  26 net-new tests (6 install flag tests, 9 uninstall, 11 library) plus the
  11 pre-existing install tests still pass with the rewritten implementation.
* `packages/manta-e2e/tests/manta-library.e2e.test.ts` — preflight describe
  block (always runs; verifies --help surface + `--no-hooks=false` rejection
  + isolated `library list --json` on empty repo) and an env-gated body that
  drives the full install→list→cast --dry-run→real cast→uninstall round-trip.
* `packages/manta-e2e/tests/fixtures/library-mode-package/` — self-contained
  `@manta-library/e2e-sample@0.1.0` fixture with one library mode
  (`basedOn: 'recon-swarm'`) and one skill.

## Pending / explicitly out of scope

* `packages/manta-cli/src/commands/cast.ts` integration of hash-pin
  verification (Task 2.4) — owned by Clone B per the partition. Clone B also
  owns `library/integrity.ts`, `tests/library/integrity.test.ts`, and the
  user-facing docs (`docs/user/manta-library.md`, `docs/internals/mode-registry.md`),
  CHANGELOG.md, and INDEX.md (Tasks 2.4 / 2.6 / 2.7).
* The e2e body is `MANTA_E2E=1`-gated and will not exercise the real-claude
  cast unless that env var is set; the preflight is what runs in this gate.
* Workspace lint baseline (`@manta/cli`: 360 errors, `@manta/bus`: 1 error +
  1 warning) is unchanged. Cleaning that baseline is a separate hygiene task
  and was outside the Chunk 2 contract; my files contribute zero new lint
  failures.

## Most surprising thing learned

`commander.js`'s `--no-X` negate-pattern treats any explicit value form
(`--no-hooks=false`, `--no-hooks=anything`) as an *unknown option* before
the action handler ever runs — commander exits with its generic error and
exit code 1, never giving the action a chance to print our deferred-to-Phase-8
message. The fix is a pre-commander argv scan (`rejectHookOverrideEarly`)
that runs at the top of `main()`. The same lesson likely applies to any
other `--no-X` flag we ever need to *forbid* re-enabling: commander cannot
do that for us. Captured in the ZK note `commander-negate-rejection-pattern`.

## Verification snapshot

```
pnpm -r build                # all 6 packages green
pnpm -r test                 # 1110/1110 green (55+57+355+152+476+15)
pnpm --filter @manta/e2e lint # clean
pnpm --filter @manta/cli lint # 360 errors, matches main baseline (0 new)
```

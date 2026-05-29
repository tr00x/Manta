# Last-gasp report — clone-A, cast-1780055076370

## Summary

Implemented **Phase 7b Chunk 3 ONLY** (publish flow + MVTS-7 threat-model gates)
from `docs/superpowers/plans/2026-05-28-phase-7b-manta-share.md`, following the
TDD Step 1–7 pattern per task. All five Chunk 3 tasks (3.1–3.5) are complete and
the canonical `pnpm gate` is fully green. The mandated structural gate —
`--publish` together with `--non-interactive` — is enforced at **two code
levels** (CLI pre-commander guard `exit 2` + command-layer `ShareError` exit 27),
never in skill text. Stopped at Chunk 3 as instructed; Chunks 1 and 2 were
already merged into main and were not touched.

## Commits (branch `manta/cast-1780055076370/A`, newest first)

| SHA | Message |
|---|---|
| `bce52a1` | chore: Phase 7b — INDEX + CHANGELOG + bug #18 full close |
| `3b84ebe` | docs: manta share user guide + share-sanitization architecture note |
| `e09aa6c` | feat(cli): manta share --publish flow + non-interactive publish hard-block (auto-share guard) |
| `de07e11` | feat(cli): npm publish-flow with MVTS-7 gates (scan/checksum/login/scope/double-confirm/size) |
| `63a8b44` | feat(cli): static malicious-pattern scanner for bundle JS (advisory + hard-block) |

(plus this last-gasp commit `manta-clone-A: …`)

## Files changed (12, cap was 30)

- **New (impl):** `packages/manta-cli/src/share/static-scanner.ts`,
  `packages/manta-cli/src/share/publish-flow.ts`
- **New (tests):** `packages/manta-cli/tests/share/static-scanner.test.ts`,
  `packages/manta-cli/tests/share/publish-flow.test.ts`
- **Modified (impl):** `packages/manta-cli/src/commands/share.ts`,
  `packages/manta-cli/src/bin/manta.ts`
- **Modified (tests):** `packages/manta-cli/tests/commands/share.test.ts`
- **New (docs):** `docs/user/manta-share.md`,
  `docs/internals/share-sanitization.md`
- **Modified (docs):** `docs/superpowers/plans/INDEX.md`, `CHANGELOG.md`,
  `docs/manta-bugs.md`

## Tests added / changed

- `static-scanner.test.ts` — **21 tests**: every block rule (exec/execSync,
  sensitive-home reads, sensitive-file writes), every warn rule (eval,
  new Function, non-literal spawn, dynamic require, network, env-secret),
  clean/empty/non-JS skip, `.mjs`/`.cjs` coverage, snippet truncation, multi-file
  line/file attribution.
- `publish-flow.test.ts` — **11 tests**: each gate failure (scan_blocked,
  checksum_mismatch, not_logged_in, scope_not_owned, declined×2, too_large), the
  all-pass happy path (publishes once with `access:public`), confirmation prompt
  content, the gate-order/short-circuit assertion, and publish-throw propagation.
- `share.test.ts` — **+4 tests** (12 total): `--publish` + `--non-interactive`
  command-layer block, interactive happy publish (`result.published` set, runner
  called once with `public`), declined publish leaves the local tarball on disk,
  not-logged-in surfaces as `share_publish_blocked`. Replaced the obsolete
  "publish refused — Chunk 2 only" test (publish now ships in Chunk 3) and made
  the fake deps inject `publishRunner`/`confirmer` so no test touches real npm or
  stdin.

## Gate output (verified by independent re-run, not self-reported)

```
pnpm typecheck → exit 0   (tsc -b)
pnpm lint      → exit 0   (eslint, 0 errors / 0 warnings)
pnpm test      → 163 files, 1386 tests, ALL PASS (61s)
```

Per-package targeted runs also green:
`tests/share/static-scanner.test.ts` 21✓, `tests/share/publish-flow.test.ts`
11✓, `tests/commands/share.test.ts` 12✓.

## Design decisions worth a reviewer's eye

- **exec/execSync always blocks** (research §2 rows 3+4): Phase 7b has no
  `requiresChildProcess` manifest declaration, so both the literal and
  non-literal forms hard-block. `spawn`/`require` only flag the *non-literal*
  first-arg form (literal `spawn("git", …)` is fine).
- **`sk-` secret regex** stays as the tightened Chunk-1 form (prefixed
  `sk-ant-/proj-/live-/test-/or-` or ≥48-char alphanumeric) — I did not loosen
  it; the static scanner's `env-secret-read` is a separate advisory rule.
- **Single publish error code** (`share_publish_blocked`, exit 27) covers both
  the non-interactive refusal and every `publishBundle` gate failure; the message
  carries the specific reason. Kept the local tarball on any failure (no delete).
- **Scope-ownership gate**: a scoped name with an empty `listScopePackages`
  result → `scope_not_owned`; an unscoped name skips the gate (npm enforces it
  server-side). Tested via the scoped happy path + empty-list failure.

## Pending / handoff to main (post-merge ceremony)

- **INDEX row `**Executed**` flip with real merge SHAs** is deliberately left to
  the main's post-cast ceremony (Task 3.5 Step 6) — a clone cannot know the merge
  commit hashes. The row is currently marked `**In progress**`.
- This is a **forking-realities** cast; sibling **B** implemented the same Chunk 3
  independently. INDEX/CHANGELOG/manta-bugs edits will conflict between A and B —
  expected; follow the merge-review verdict, do not blind-merge both.
- No locks or work-claims were held (forking-realities; `claim_work` is
  structurally rejected in this mode).

## Self-certainty: 9/10

Clean TDD, every gate green on an independent re-run, the mandated structural
gate is code-level and double-layered, no hacks / skips / suppressions. Held back
one point because the `--publish` happy path was exercised only through injected
fakes (no live `npm publish` — by design, since publishing is PUBLIC/PERMANENT).

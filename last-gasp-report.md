# Last-gasp report — clone-A — RB1 Chunk 5

**Cast:** cast-1780075155395 (forking-realities) · **Task:** prove the resume spine e2e + guard against transcript leak in `manta share`.

## Summary

Authored the two Chunk-5 deliverables and brought the full gate to green. Part 1: a new env-gated e2e
(`packages/manta-e2e/tests/transcript-inheritance.e2e.test.ts`) that proves transcript inheritance
semantically — a `MANTA_E2E_<random12>` token seeded *only* into a throwaway parent conversation must
resurface in each clone's `token.txt` — with a **required negative control** (inheritance disarmed →
clones write `NONE` + snapshot `resumeEnabled:false`) that stops the test passing for the wrong reason.
Part 2: a hermetic **share-leak guard** added to `bundle-assembler.test.ts` that whitelists `events.jsonl`
and fails on any other `.jsonl` (a leaked `<uuid>.jsonl` transcript fork), with a teeth test that plants a
fork and asserts it is caught. Both run in the normal gate. To import the real `mangle()` (never
re-implement it — drift from Claude Code's on-disk scheme is the make-or-break failure mode), I re-exported
`spawner/session-fork.js` from `@manta/cli`'s public surface (`packages/manta-cli/src/index.ts`).

## Honest exit status (proven vs deferred)

- **Proven by me (gate-green):** `pnpm typecheck` ✓, `pnpm lint` ✓, `pnpm test` ✓ (169 files / 1438 tests).
  The e2e **skips cleanly** under `MANTA_E2E` unset (`probeClaudeBin` → `available:false` → loud warn +
  return; 2 tests, 9 ms) — it is an unarmed armed-opt-in test, **not** a skipped/todo test. The share-leak
  guard is **green** (bundle-assembler now 8 tests, +2). Both new test files lint-clean under their package
  lint (root gate scopes `src/**` only).
- **Deferred to curator (real-claude run):** the e2e's actual end-to-end execution against real `claude`
  (`MANTA_E2E=1`, haiku). I did **not** run it: it spawns a nested `manta cast` (cast-within-a-cast,
  forbidden) and costs real money. Report exactly: *"e2e authored; skips cleanly under MANTA_E2E unset;
  share-leak guard green; real-claude validation deferred to curator."*

## Deliverables (committed on this worktree branch)

- `packages/manta-e2e/tests/transcript-inheritance.e2e.test.ts` (new) — positive flow (steps 1-5) + negative control (step 6).
- `packages/manta-cli/tests/share/bundle-assembler.test.ts` (edit) — share-leak guard suite (+2 tests).
- `packages/manta-cli/src/index.ts` (edit) — re-export `session-fork.js` so the e2e imports the real `mangle()`.

## Flags / pending for the curator

- **Did NOT touch `docs/manta-bugs.md` #56** — per contract, the curator marks it `Fixed + validated`
  only after the real-claude e2e is green.
- **recon-swarm permission model (flagged, not silently switched):** the e2e drives `manta cast recon-swarm`
  with `--allowed-paths . --max-files-changed 5` so writing `token.txt` is contract-legal, and the resume
  argv runs `--permission-mode bypassPermissions`. BUT recon-swarm is normally a read/map mode; if its
  priming biases the clone away from writing `token.txt` (e.g. it insists on producing `docs/recon.md`),
  the crux assertion will fail. Fix = switch the cast to a write-capable mode (e.g. forking-realities) —
  the contract says **flag, do not silently switch**, so this is surfaced here for the curator to decide.
  An inline FLAG comment marks the exact spot in the e2e.
- **Fresh-worktree build prerequisite:** the armed e2e resolves `@manta/*` from built `dist/` and the
  cliBin is `packages/manta-cli/dist/bin/manta.cjs`, so the curator must `pnpm build` before the armed run
  (this worktree had no `node_modules`/`dist`; I ran `pnpm install` + `pnpm build` to gate). No code issue.
- **Relocated `~/.claude`:** the e2e mirrors `session-fork.ts` and uses `~/.claude` (no `CLAUDE_CONFIG_DIR`
  read, by design — plan §5). A relocated config home would need the same treatment in both; tracked as the
  plan's deferred follow-up, not handled here (out of scope §7).

## Pending items

- None within scope. Real-claude e2e execution is the curator's step (division of labor).

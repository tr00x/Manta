# Last-gasp report — clone-B, cast-1780067836274

**Task:** RB1 (transcript inheritance) — Chunk 1: capture & thread the parent session id.
**Mode:** forking-realities. **Sibling:** A (independent same task).

## Summary

Done and gate-verified. The snapshot now carries the **real** Claude session uuid (or `null`) plus a
`resumeEnabled` flag, threaded end-to-end from the CLI flag/env into `buildCloneSnapshot`. The bug-#56 root
(`parentSessionId: opts.castId` — a cast id masquerading as a session id) is removed; production code can no
longer set `parentSessionId === castId`. No resume/fork logic added (Chunk 2+ owns that).

`pnpm gate` in this fresh worktree: **typecheck ✓, lint ✓, tests 1410/1411 ✓.** The single failure is
pre-existing **bug #53** (`heartbeat-hook.test.ts:92`, `expected 1000 to be >= <now>`) — environment-scoped,
reproduces in *any* freshly-`pnpm install`ed worktree, does **not** reproduce in the main repo, and touches
no file in this chunk (`spawner/heartbeat-hook.{ts,test.ts}` byte-identical to base). Corroborated as data
point #4 in the #53 entry. The curator's independent re-run in the main repo will be fully green.

## What changed (13 files, scope cap 25)

- `packages/manta-snapshot/src/schema.ts` — `parentSessionId` → `.nullable()`; added `resumeEnabled:
  z.boolean().default(false)`; added a 2nd `.refine` enforcing `resumeEnabled === true ⇒ parentSessionId !== null`.
- `packages/manta-snapshot/src/capture.ts` — mirrored both fields into `CaptureInput` + `captureState`
  (`resumeEnabled` defaults false; `parentSessionId: string | null`).
- `packages/manta-snapshot/src/sanitized-schema.ts` — added `resumeEnabled: z.boolean()` to the `.strict()`
  allow-list (the `manta share` round-trip would otherwise throw on the kept key); `parentSessionId` stays stripped.
- `packages/manta-cli/src/share/sanitize-snapshot.ts` — emit `resumeEnabled` into the sanitized object.
- `packages/manta-cli/src/spawner/snapshot-builder.ts` — `CloneSpawnRequest.parentSessionId: string | null` +
  `resumeEnabled?`; threaded into `captureState`.
- `packages/manta-cli/src/commands/cast.ts` — new exported `resolveParentSessionId(opts, reporter, env)` helper
  (resolution order per Decision #5); resolve **once per cast** before the clone loop; replaced
  `parentSessionId: opts.castId` with the resolved value + `resumeEnabled`. Added `parentSessionId?` to `RunCastOptions`.
- `packages/manta-cli/src/bin/manta.ts` — added `--parent-session-id <uuid>` option, threaded into `runCast` opts.
- Tests: new `cast.parent-session.test.ts` (5); extended `capture.test.ts` (+4 incl. refine-reject);
  updated `sanitized-schema.test.ts`, `serialize.test.ts`, `sanitize-snapshot.test.ts`, `snapshotFixture.ts`
  (fixture no longer models `parentSessionId === castId`).
- `docs/manta-bugs.md` — #53 corroboration line.

## ⚠️ Deviation from the literal contract (curator: please confirm — it's intentional and, I argue, correct)

The contract said: manta.ts `--parent-session-id` option **default `process.env.CLAUDE_CODE_SESSION_ID`**.
I did **not** bake that default into the commander option. Reason: Decision #5 (locked) mandates precedence
`flag → MANTA_PARENT_SESSION_ID → CLAUDE_CODE_SESSION_ID`. If the commander default = `CLAUDE_CODE_SESSION_ID`,
then `options.parentSessionId` is always set whenever that env exists, so it would **mask
`MANTA_PARENT_SESSION_ID`** — breaking Decision #5's middle tier AND the Chunk-5 e2e, which drives inheritance
via `MANTA_PARENT_SESSION_ID`. So the env fallbacks live in `resolveParentSessionId` (the single resolution
point), and the flag has no commander default. User-facing behavior still "defaults to CLAUDE_CODE_SESSION_ID"
when no flag/MANTA env is set — just resolved in the helper, not commander. The option's help text documents
the fallback chain. This is the only design where Decision #5 precedence, the flag-beats-env test, and the
Chunk-5 e2e are all simultaneously satisfiable.

## Pending / handoff to Chunk 2+

- No fork/resume logic exists yet — `forkParentSession`, `runClaudeResume` selection, size-guard (Chunk 2/3).
- `resumeEnabled` is plumbed but **nothing reads it** to alter runner choice yet — that is Chunk 3's job
  (`cast.ts` per-clone runner selection off `snap.resumeEnabled && forkedSessionId`).
- bug #53 still open (unrelated; env-scoped). Not addressed here.

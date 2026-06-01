# Clone context-recall proof

This file is written by a Manta clone during a **live, in-session cast** to prove
that transcript inheritance works: the clone boots already knowing what the main
agent and the user have been doing in *this* conversation.

## Session recall

Concrete things the main agent and the user worked on in this session — recalled
from the inherited transcript, not guessed:

1. **The transcript-inheritance fork bug — root cause and fix.** The blocker was
   in `packages/manta-cli/src/spawner/session-fork.ts`: `forkParentSession`
   byte-**copied** the parent transcript, which kept the parent's internal
   `sessionId` (and `cwd`). `claude --print --resume <forkUuid>` then rejected the
   fork because the records' `sessionId` didn't match the resumed uuid, so the
   clone fell back to a fresh, empty session and booted cold (wrote nothing). The
   fix rewrites each JSONL record — `sessionId` → the forked uuid, `cwd` →
   `realpath(cloneCwd)` — instead of a raw copy. Proven live on an 18 MB session
   where the clone recalled the conversation.

2. **npm publish of `@tr00x/manta` + OIDC CI.** v0.1.0 went live on npm under the
   scoped name `@tr00x/manta` (plain `manta` is an unrelated package). The
   GitHub Actions workflow `publish-npm.yml` was switched to an **OIDC Trusted
   Publisher** (no `NPM_TOKEN` secret), after a chain of CI fixes: the
   pnpm/action-setup `version:` clash with `packageManager`, building packages
   before the gate (TS2307 on missing `dist`), and `tsc -b` clobbering the tsup
   bundles → a rebuild-before-test step.

3. **Harvesting the doc-accuracy cast + a caught inaccuracy.** The
   `doc-accuracy + orchestrator-UX` cast (`cast-1780273045900/B`) was harvested
   **surgically** — only the two contracted skill files
   (`skills/manta-cast-decide`, `skills/manta-orchestrate`), dropping the clone's
   out-of-scope edits and its base-drift deletion of `examples/` + `docs/benchmarks/`.
   The main also caught the clone claiming the startup-grace default was **600 s**
   when the real default is **300 s** (`manta.ts:258`) and reworded both spots.

4. **De-emoji'd README (anti-"AI slop").** All decorative emoji were stripped from
   the README — section headers, the building-blocks and comparison tables, the
   readiness checklist, and the lock markers — leaving only the `⧉` brand glyph
   and textual `✓`/`✗`. The nav/badge anchors that the leading header emoji had
   shifted were fixed (`#-how-it-works` → `#how-it-works`), and the mermaid
   diagrams were left intact.

## What I am

I am a **clone spawned by `manta cast`** (mode: `recon-swarm`, clone id `A`,
cast `cast-1780322618209`). I booted **warm** from a fork of the parent agent's
transcript and I am working in my own isolated **git worktree**
(`.manta/worktrees/clone-cast-1780322618209-A`) on branch
`manta/cast-1780322618209/A`. I coordinate with the main over the manta-bus MCP
server; I do not push — the main pulls and merges.

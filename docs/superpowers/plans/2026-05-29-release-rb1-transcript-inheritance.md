# v1 Release Blocker #1 — Transcript Inheritance (implementation plan)

> **Status:** Approved (curator-written from recon audit; plan-review subagent pass `2026-05-29` → verdict NEEDS-FIXES, 2 MUST-FIX [e2e gate env-var drift; unverified `CLAUDE_CONFIG_DIR`] + 2 advisories applied. Ready to execute Chunks 1–5 via casts).
> **Date:** 2026-05-29
> **Author:** Claude Code (curator), from clone-A recon `docs/audits/2026-05-29-transcript-inheritance-plan.md` (cast-1780064388927).
> **Spec basis:** Sec 1 (claim) + Sec 9 «Transcript inheritance — механизм и cost-tiers (v1)» (reconciled in `d201e20`).
> **Closes:** `docs/manta-bugs.md` #56.
> **Goal context:** `/goal` 2026-05-29 — «продукт реально делает что заявляет: клоны наследуют транскрипт, а не субагенты. Release blocker #1 = transcript inheritance.»

---

## 1. Goal & acceptance

Today a Manta clone boots from an **empty** Claude Code session + a priming preamble — functionally a subagent. The headline claim (spec Sec 1: «same-system-prompt cloning с full context inheritance») is **false**. This plan wires the full-transcript pipe so a clone boots as a **continuation of the main agent's actual conversation**.

**Acceptance test (the only one that matters):** an e2e where a fact (`MANTA_E2E_<random>`) exists **only** in the parent conversation — never in the task, priming, snapshot arrays, or any file — and a spawned clone **reproduces that fact**. A flag-assertion test is worthless here: it passes even while clones are subagents. The distinguishing test is **semantic** (clone recalls parent-only content). Negative control: same cast with resume disabled → clone **cannot** produce the fact.

**v1 split (do not conflate):**
- **MUST — delivers the /goal claim:** Chunks 1, 2, 3, 5 = full forked-session resume (Tier A) + e2e sentinel proof. This alone makes "clones inherit transcript" TRUE.
- **SHOULD — cost-control, ships in v1 but gated separately:** Chunk 4 = distilled tier (Tier B). Required for economic viability on large transcripts (live main was **11.7 MB**), but its trim-and-resume mechanism is **unproven** and must be empirically validated *before* it's built on (step 4.0). A Chunk-4 surprise must **not** block the Chunk 1–3+5 claim from shipping.

---

## 2. Mechanism (proven; full proof in the audit, do not re-derive)

Empirically established by clone-A (4 experiments, audit Q1; corrects the pre-recon `--resume "$CLAUDE_CODE_SESSION_ID" --fork-session` model which was **wrong**):

1. Main's session id is in-process at `process.env.CLAUDE_CODE_SESSION_ID` (**not** `CLAUDE_SESSION_ID` — unset). The `manta cast` child inherits the env → sees the main's id.
2. Transcript on disk: `~/.claude/projects/<mangle(cwd)>/<sessionId>.jsonl`, `mangle = cwd.replaceAll('/','-').replaceAll('.','-')`. Verified worktree case: `…/.manta/worktrees/clone-A` → `…-manta--manta-worktrees-clone-A` (double-dash from leading `.manta`).
3. `--resume` is **cwd-scoped**: a clone in its worktree (different project dir) **cannot** `--resume <parentId>` directly ("No conversation found").
4. **Fork = copy + resume:** `fs.copyFile` the parent JSONL into the clone's worktree project dir under a fresh uuid, then `claude --print --resume <fork_i> --append-system-prompt <priming> <prompt>`. Parent JSONL is opened exactly once (the copy) and never by `claude` → byte-identical after. Each clone owns a private fork in its own project dir → no parent race, no inter-clone interference. `--fork-session` not required (the copy *is* the fork). `--resume` + `--append-system-prompt` **coexist** (transcript + clone-priming both apply).

---

## 3. Decisions locked by the curator (so implementing clones don't drift)

These resolve the audit's open seams. **Do not re-litigate in the cast; implement as written.**

1. **Schema shape (schema-first, per bug #13):** add `resumeEnabled: z.boolean().default(false)` to `SnapshotSchema`; relax `parentSessionId` from `z.string().min(1)` → `z.string().min(1).nullable()` (real Claude session uuid when resuming, `null` otherwise). Add a `.refine`: `resumeEnabled === true ⇒ parentSessionId !== null`. **Before** changing the schema, `grep -rn parentSessionId packages/` and update every consumer (notably `sanitized-schema.ts:9-10` share-stripping and `snapshot-builder.ts:34`) — cross-plan field-name drift is the #1 historical blocker class.
2. **Runner unification (Chunk 3):** select the runner **per clone in `cast.ts`** — `runClaudeResume({ sessionId: forkedSessionId })` when `resumeEnabled && forkedSessionId`, else today's `runClaudeCli()`. This reuses the already-tested `runClaudeResume` and keeps `runClaudeCli` as the no-session fallback. Do **not** add an `if NODE_ENV` branch; the runner choice is data-driven off the snapshot.
3. **Auto-distill is a FIRM default, not "consider"** (curator note; audit under-stated this): above a configurable size threshold (default **2 MB**; rationale: 11.7 MB live transcripts × N clones would blow budget/context), the system auto-engages Tier B. Flags: `--distill` forces distill, `--no-distill` forces full, `--distill-threshold-bytes <n>` overrides. The threshold guard ships in **Chunk 2** (see below) so the spine is safe even before Chunk 4 exists.
4. **Size-guard ships with the spine (Chunk 2), distill plugs into it (Chunk 4):** in Chunk 2, if the parent JSONL exceeds the threshold and no distill path is available yet → `resumeEnabled = false` + `reporter.warn` (fall back to today's empty-context behavior) **unless** `--force-full-transcript`. This means Tier A is **safe-by-default** (never silently copies an 11.7 MB transcript × N) before Chunk 4 lands. Chunk 4 turns "above-threshold → fall back to empty" into "above-threshold → auto-distill".
5. **Never fabricate a session id.** Resolution order: `--parent-session-id` flag → `MANTA_PARENT_SESSION_ID` env → `CLAUDE_CODE_SESSION_ID` env → else `resumeEnabled = false` + warn. No invented uuids.

---

## 4. Chunks

Guiding constraints: PROD-only (DI seams, no `if NODE_ENV`, no mocks in prod paths); `pnpm gate` green per chunk (re-run by the curator independently before any merge — implementer self-reports are not trusted); one atomic commit per chunk; reviewer-per-chunk loop.

### Chunk 0 — Spec reconcile + bug log — ✅ DONE (`d201e20`)

Spec Sec 9 subsection + Sec 1 cell + Status amended; bug #56 logged. No code. **Complete** — do not redo.

### Chunk 1 — Capture & thread the parent session id — ~1.5 h

**TDD first (write failing tests):**
- `packages/manta-cli/tests/commands/cast.parent-session.test.ts`: with `process.env.CLAUDE_CODE_SESSION_ID = '<uuid>'`, `buildCloneSnapshot` receives `parentSessionId === '<uuid>'` and `resumeEnabled === true`. Env unset + no flag → `parentSessionId === null`, `resumeEnabled === false`, a `reporter.warn` fired.
- `packages/manta-snapshot/tests/capture.test.ts`: `parentSessionId` round-trips verbatim (real uuid distinct from `castId`); `resumeEnabled` round-trips; the `.refine` rejects `resumeEnabled:true + parentSessionId:null`.

**Implementation (exact):**
- `packages/manta-snapshot/src/schema.ts:69` — apply Decision #1 (nullable + `resumeEnabled` + refine). Mirror into `capture.ts` `CaptureInput` + `captureState` (the existing `sessionId` conditional-spread at `capture.ts:50` is the pattern).
- **`sanitized-schema.ts` (FIRM — reviewer-locked, not "decide"):** `SanitizedSnapshotSchema` is `.strict()` (`sanitized-schema.ts:36`), so the new `resumeEnabled` field MUST be added to its allow-list (`resumeEnabled: z.boolean()`) or the `manta share` round-trip parse throws on the unknown kept key. `parentSessionId`/`recentMessages`/`sessionId` are already omitted (`:9-10`) — correct, keep stripping them; only `resumeEnabled` (a harmless boolean) is added.
- new `resolveParentSessionId(opts)` helper in `cast.ts` (order per Decision #5).
- `packages/manta-cli/src/commands/cast.ts:538` — replace `parentSessionId: opts.castId` with `parentSessionId: resolveParentSessionId(opts)` and pass `resumeEnabled` into `buildCloneSnapshot`.
- `packages/manta-cli/src/bin/manta.ts` — add `.option('--parent-session-id <uuid>', …)` to the cast command. **As-built correction (both Chunk-1 clones + code-reviewer, see post-mortem `2026-05-29-cast-1780067836274.md`):** the flag has **NO commander default**. A default of `process.env.CLAUDE_CODE_SESSION_ID` is applied by commander *before* user code and is indistinguishable from an explicit `--flag`, so it would mask the `MANTA_PARENT_SESSION_ID` tier (Decision #5) and break the Chunk-5 e2e (which drives inheritance via that env). ALL precedence lives in `resolveParentSessionId`; thread the flag into `runCast` opts only when explicitly set. **General rule for later chunks: never encode an env-precedence tier as a CLI-framework option default.**

**Exit gate:** `pnpm gate` green. `parentSessionId` is never the castId again. **Commit.**

### Chunk 2 — Fork the parent JSONL into each clone's worktree project dir (+ size guard) — ~2.5 h

**TDD first (hermetic — temp `claudeHome`, no real `claude`):**
- new `packages/manta-cli/src/spawner/session-fork.ts`: `forkParentSession({ parentSessionId, parentCwd, cloneCwd, claudeHome?, thresholdBytes? }): Promise<{ forkedSessionId } | { skipped: 'not_found' | 'over_threshold' }>`. `parentSessionId: string` (non-null — the sole caller invokes only when `snap.resumeEnabled`, which the Chunk-1 `.refine` guarantees ⇒ `parentSessionId !== null`; no `no_parent` variant, per quality-bar "don't handle states that can't happen").
- `packages/manta-cli/tests/spawner/session-fork.test.ts`:
  - fixture JSONL at `<claudeHome>/projects/<mangle(parentCwd)>/<parentId>.jsonl` → copy written to `<claudeHome>/projects/<mangle(cloneCwd)>/<newUuid>.jsonl`; returns the new uuid; **source byte-identical** (`readFile` equality); the two project dirs differ.
  - parent file missing → `{ skipped: 'not_found' }`, nothing written.
  - **`mangle()` unit tests** including the exact verified worktree string `…-manta--manta-worktrees-clone-A` (double-dash). Mangling MUST match Claude Code's real scheme — derive from the audit's verified examples; this is the highest-risk correctness point (a mismatch writes the fork where `--resume` won't look → silent empty inheritance).
  - concurrency: two `forkParentSession` calls (clones A, B) from one parent → two distinct files in two distinct dirs, distinct uuids.
  - **size guard:** parent JSONL > `thresholdBytes` → `{ skipped: 'over_threshold' }` (Chunk 4 later replaces this branch with distill).

**Implementation (exact):**
- `session-fork.ts`: `claudeHome` is an **injected parameter** defaulting to `path.join(os.homedir(), '.claude')` — the empirically-proven path (every live transcript is under `~/.claude/projects/`). **Do not read `CLAUDE_CONFIG_DIR`** (reviewer MUST-FIX): `claude --help` exposes no `--config-dir` flag and no such env var, so reading it would ship an *unverified guess* dressed as fact. Relocatable-home support → deferred follow-up bug only if a real user ever needs it; the `claudeHome?` param already covers test injection. `mangle(cwd) = cwd.replaceAll('/','-').replaceAll('.','-')`. `randomUUID()` for the fork id. Plain `fs.copyFile`.
- Wire into `cast.ts` clone loop (verified at `cast.ts:505-543`): **after** `wt.path` is known (`cloneWorktree: wt.path` at :536) and **before** `spawnClone`, call `forkParentSession` when `snap.resumeEnabled`. On `over_threshold` without `--force-full-transcript` → flip `resumeEnabled=false` + `reporter.warn` (Decision #4). Store `forkedSessionId` for Chunk 3.
- add `--force-full-transcript` + `--distill-threshold-bytes` flags in `manta.ts` (threshold default 2 MB).

**Exit gate:** `pnpm gate` green; fork is hermetic-tested; size guard verified. **Commit.**

### Chunk 3 — Resume runner on the batch path + thread the fork id — ~2 h

**TDD first:**
- `packages/manta-cli/tests/spawner/clone-spawner.resume.test.ts` (fake `CloneRunner` capturing `run()` input): when snapshot has `resumeEnabled && forkedSessionId`, the resume runner is selected and emits argv `['--print','--resume',<forkedSessionId>,'--append-system-prompt',<priming>,'--permission-mode','bypassPermissions',<prompt>]` (exact ordering). When `!resumeEnabled`, today's `runClaudeCli` argv (no `--resume`) — byte-identical to current behavior.

**Implementation (exact):**
- thread `forkedSessionId` onto `SpawnCloneOptions`; `clone-spawner.ts` passes it through.
- per Decision #2: in `cast.ts`, construct `runClaudeResume({ sessionId: forkedSessionId })` per clone when resuming, else `runClaudeCli()`. (`manta.ts:255`'s static `runner: runClaudeCli()` becomes a per-clone choice resolved in `cast.ts`.)

**Exit gate:** `pnpm gate` green; resume argv pinned. **Commit.**

> **At end of Chunk 3 the /goal claim is mechanically delivered** (full forked resume on the batch path). Chunk 5 proves it semantically. Chunk 4 is cost-control on top.

### Chunk 4 — Distilled tier (cost-control fallback) — ~3 h (was 2.5; +0.5 for the proof step)

**Step 4.0 — EMPIRICAL PROOF FIRST (mandatory; the audit hand-waved this):** a trimmed JSONL is a broken `parentUuid` linked list (the first kept record points at a dropped parent). It is **unknown** whether `claude --resume` accepts such a file. **Prove it before building on it**, with the same empirical-proof rigor that made the recon valuable:
- Construct a trimmed fork (header records + last-N message records) from a real fixture transcript; `claude --print --resume <trimmed> "what is <parent-only-sentinel>?"` (haiku, cheap). 
- If it resumes cleanly → that's Tier B. If it errors on the dangling `parentUuid` → fallback: rewrite the first kept record's `parentUuid` to the last header record (or `null`/root) and re-test. Record the working sub-mechanism in the plan/post-mortem.
- If **neither** trims-and-resumes reliably → Tier B degrades to "size-cap + warn + full-or-skip" (Chunk 2's guard already does this); distill is then **deferred** out of v1 and bug #56 ships with Tier A only + a follow-up bug. **Do not ship a distill that wasn't proven to resume.**

**TDD (after 4.0 picks the sub-mechanism):**
- `packages/manta-cli/tests/spawner/priming.distill.test.ts`: `resumeEnabled=false && recentMessages` non-empty → `buildPrimingText`/`buildInitialPrompt` render a `## Inherited context (distilled)` block (last-N + scoped open files). `resumeEnabled=true` → block **absent** (full transcript already carried; rendering would double-count tokens). Both empty → no block (byte-identical to today).
- `packages/manta-cli/tests/spawner/session-fork.distill.test.ts`: above-threshold parent → `forkParentSession` produces a **trimmed** fork that the proven sub-mechanism accepts (header + last-N records present, middle dropped, chain repaired per 4.0).
- `packages/manta-cli/tests/commands/cast.distill.test.ts`: above threshold (or `--distill`) → trimmed-fork path taken; below → full copy.

**Implementation (exact):**
- new `readSessionMessages(parentSessionId, parentCwd, claudeHome?)` parsing the parent JSONL into `MessageSchema[]` (the only new dependency; ≈ the parser a future `manta.fetch_history` would reuse).
- `snapshot-builder.ts:46-48` — replace empty-array literals: `resumeEnabled` (full) → keep `[]`; else distill available → `distillContext({ messages: readSessionMessages(...), openFiles, maxRecentMessages, allowedPaths: scope.allowedPaths })`; else `[]`.
- `session-fork.ts` — `over_threshold` branch now writes the trimmed fork (per 4.0) instead of skipping.
- `priming.ts` — add `{INHERITED_CONTEXT_BLOCK}` to `PRIMING_TEMPLATE` + renderer (emits only when `recentMessages.length > 0`).

**Exit gate:** `pnpm gate` green; **4.0 proof recorded**; distilled block rendered only in fallback. **Commit.**

### Chunk 5 — End-to-end sentinel proof + share-leak guard — ~2 h

**E2E** (`packages/manta-e2e/tests/transcript-inheritance.e2e.test.ts`, gated via the **existing** `claudeBin.ts` helper — `MANTA_E2E=1`, enforced at `claudeBin.ts:20`; reuse `assertClaudeAvailable` + `sampleRepo`, do **not** invent a new env var (all 6 existing e2e tests share this gate); haiku, real `claude`):
1. Seed a throwaway parent in a temp cwd: `claude --print --session-id <PARENT_UUID> --model haiku --permission-mode bypassPermissions "Remember this exact build token: MANTA_E2E_<random12>. Reply ACK."`; assert JSONL at `<claudeHome>/projects/<mangle(tempcwd)>/<PARENT_UUID>.jsonl`.
2. `manta cast recon-swarm` (2 clones) with `MANTA_PARENT_SESSION_ID=<PARENT_UUID>`, task: *"Write the build token you were told to remember into `token.txt`, then graceful-death."* (real spawner path, Chunks 1–3).
3. **The crux:** each clone's `token.txt` contains the exact `MANTA_E2E_<random12>` — only possible if the clone saw the parent conversation (token was never in task/priming/snapshot/file).
4. **Non-corruption:** parent JSONL hash byte-identical before/after; each clone's fork is a separate file; the two forks are distinct.
5. **Priming coexistence:** clone still obeyed Manta priming (called `manta.ack_contract`, committed on its branch) — `--resume` + `--append-system-prompt` both applied.
6. **Negative control:** same cast with `resumeEnabled=false` → clone writes `NONE` (cannot produce the token) — proves inheritance does the work, not luck.

**Share-leak regression guard** (audit failure-mode, do not lose): add a `manta share` suite assertion that **no `*.jsonl` from any project dir** is ever included in a share bundle (forked transcripts must never leak). Complements the existing `sanitized-schema.ts` field-stripping.

**Bug-log:** mark #56 `Fixed + validated by cast <id>` only after the e2e is green (real-claude run), not on unit-gate alone.

**Exit gate:** `pnpm gate` green (unit); e2e green on a real-claude run; share-leak guard green. **Commit.**

---

## 5. Failure modes (each pinned by a test)

| Failure mode | Cause | Mitigation | Pinned by |
|---|---|---|---|
| Parent session not found | `CLAUDE_CODE_SESSION_ID` unset (CI, human shell) | resolve order flag→env→`CLAUDE_CODE_SESSION_ID`; none → `resumeEnabled=false` + warn; never fabricate | Chunk 1 env-unset |
| Cross-cwd resume silently empty | `--resume <parentId>` from worktree → "No conversation found" | never resume parent id directly; copy into worktree projdir, resume the fork | Chunk 2 copy + Chunk 5 negative control |
| Clone clobbers parent JSONL | resuming parent id in place | per-clone copy; parent opened once by `fs.copyFile` | Chunk 2 immutability + Chunk 5 hash |
| Fork race / interference | two clones share a session id | fresh `randomUUID()` per clone in distinct projdir | Chunk 2 concurrency |
| **Mangling mismatch** | our `mangle()` ≠ Claude's scheme → fork written where `--resume` won't search | derive from verified examples; fixture-assert `…-manta--manta-worktrees-clone-A`; e2e fails loudly if Claude changes scheme | Chunk 2 mangling + Chunk 5 |
| `--resume` + `--append-system-prompt` conflict | priming dropped on resume | proven to coexist (audit exp. C); keep priming as-is | Chunk 5 step 5 |
| **Trimmed-fork won't resume** | dangling `parentUuid` after trim | **Chunk 4 step 4.0 proves the sub-mechanism first**; degrade to size-cap+warn if unprovable | Chunk 4.0 |
| Token blow-up / huge transcript | 11.7 MB JSONL × N re-ingested | size guard (Chunk 2) + distill (Chunk 4); FIRM default above 2 MB | Chunk 2 guard + Chunk 4 |
| Relocated `~/.claude` (non-default home) | user moved Claude's config dir | injectable `claudeHome` param (default `~/.claude`); **no** `CLAUDE_CONFIG_DIR` read (unverified in `claude --help`) → deferred follow-up if ever needed | Chunk 2 (injectable `claudeHome`) |
| Transcript leaks via `manta share` | forked JSONL bundled into `.tar.gz` | `sanitized-schema.ts:9-10` strips fields + new no-`*.jsonl`-in-bundle assert | Chunk 5 share-leak guard |
| Daemon first-turn id mismatch (adjacent, pre-existing) | daemon spawn uses `runClaudeCli` w/o `sessionId`; later `--resume`s a non-UUID id | **out of scope**; logged in bug #56 lessons for a future fix | n/a (tracked) |

---

## 6. Recommended cast strategy (curator runtime; finalize via `manta-cast-decide`)

Dependency graph: Chunk 1 → {2, 4}; 2 → 3 → 5. Chunks 2 & 4 both touch `cast.ts`/`snapshot-builder.ts` → **do not run them as concurrent worktrees** (guaranteed conflict). Recommended grouping:

- **Cast A — Chunk 1** (foundation/schema everyone depends on): 2-clone forking-realities, merge-review picks the cleaner schema+capture, curator applies review fixes. Small but foundational — worth best-of-N.
- **Cast B — Chunks 2 + 3** (resume spine, sequential within each clone): 2-clone forking-realities, per-chunk atomic commits + gate. End of B = claim mechanically delivered.
- **Cast C — Chunk 4** (distill): 2-clone forking-realities **after** B merges (avoids cast.ts/snapshot-builder conflict). Clone must do step 4.0 first.
- **Cast D — Chunk 5** (e2e proof + share-leak guard): 1–2 clones after the pipeline lands. This is mostly test-authoring + a real-claude validation run.

Budget: prior implementation casts ran ~$8–18. Chunks 2+3 is the heaviest; size budget accordingly and remember the per-clone × N ≤ per-cast gate (default $15 rejected $8×2 last cast — raise `--budget-per-cast-usd` explicitly). Post-mortem after each cast → `docs/post-mortems/`.

---

## 7. Out of scope for RB1 (do not scope-creep)

- `manta.fetch_history` lazy-load — deferred (spec Sec 9; `--resume` carries history natively).
- Daemon first-turn id mismatch — separate future bug (tracked in #56 lessons).
- RB2 publish/distribution path — independent release blocker, separate plan.
- Any non-batch (daemon/Wave-2) resume rework — batch path only for v1.

# Manta Bugs Log

Живой реестр обнаруженных багов клонов и оркестратора. Curated manually мейном после каждой сессии. См. `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` Sec 15.2.

## Структура записи

```
### #N — <короткое название>
**Discovered:** YYYY-MM-DD, cast-id <id>, mode <mode>
**Severity:** Catastrophic | High | Medium | Low
**Status:** Open | In progress | Fixed in <release>
**Reproducer:** <минимальный сценарий>
**Root cause:** <если найдена>
**Fix:** <PR / commit / skill update>
**Lessons:** <что меняем в spec/skills чтобы не повторилось>
```

## Severity scale

- **Catastrophic** — corrupted state / lost code / orphan zombie processes
- **High** — failed cast при штатном использовании / clone расходится с task contract заметно / cost overrun > 2x
- **Medium** — neпредсказуемое поведение, но recoverable
- **Low** — UX-нюансы, неудобства, edge cases

## Open bugs

### #14 — `auditAppend` callback fires on idempotent no-op `CastsStore.create` calls

**Discovered:** 2026-05-08, code-quality review of Phase 2a Chunk 1 commit `69de728` (cast-manifest infrastructure).
**Severity:** Medium — observable only when Phase 2c wires a real audit-event callback into `casts.create`. Currently no production caller passes `auditAppend`, so the bug is latent. But `casts.create` is **explicitly designed** to be called idempotently by every clone of a cast (see `clone-spawner.ts` lines 125-129 rationale), so once an audit hook is attached, every cast emits N duplicate audit entries (one per clone) instead of one.
**Status:** Fixed — `atomicMutateJson` now gates `auditAppend` on `existing === null || next !== current` (first-write fires, idempotent re-write skips). Regression test in `casts.test.ts`: 3× idempotent create with spy → callback fires exactly once.
**Reproducer (forward-looking):**
1. Phase 2c attaches `auditAppend` callback to `casts.create` to record cast-creation events in the events log.
2. A 3-clone cast spawns: clone-A creates the manifest (mutator returns `next` with new content; audit fires once — correct).
3. Clone-B calls `casts.create` with identical input (idempotent path — mutator returns `current` unchanged); but `atomicMutateJson` calls `auditAppend()` unconditionally after the mutator (`packages/manta-bus/src/atomic-fs.ts:101-107`), so audit fires again — wrong.
4. Clone-C same story — audit fires a third time.
5. Result: events log shows 3 `cast.created` events for one cast.
**Root cause:** `atomicMutateJson` invokes `auditAppend` unconditionally if provided, with no signal from the mutator about whether new content was actually written. `state/contracts.ts` shares the same pattern but is typically called once per contract version (write-new-version semantic), so the bug is invisible there. `state/casts.ts` is the first store where idempotent-every-call is part of the contract.
**Fix (proposed):** Two viable approaches —
- (a) Extend `atomicMutateJson` to detect mutator returning `===` reference-identical `current` and skip `auditAppend`. Reference-identity is what idempotent paths already use; semantic-equality detection (canonicalized) would also work but is more complex. Cleaner downstream because all stores benefit. Cross-cuts `contracts.ts`, `registry.ts` etc. — needs regression sweep.
- (b) Move the audit-fire decision into `CastsStore.create` itself: read existing manifest first (outside the mutex), compare canonically, and pass `auditAppend` to `atomicMutateJson` only if the input differs. Simpler change, isolated to casts.ts, but adds a non-mutex read before the write — race window is benign (worst case is firing the callback when we shouldn't, which is the current bug — net no worse).
- **Recommended:** (a). The fix belongs in the shared infra so the same trap doesn't bite Phase 4+ stores.
**Lessons:**
- "Pre-existing pattern" is not the same as "correct pattern" — `contracts.ts` happened to dodge this because of its single-writer-per-version usage. New stores with new usage shapes need their audit semantics audited.
- Idempotency contracts must specify side-effect semantics, not just data semantics. `casts.create` documents idempotent data writes but says nothing about audit emissions.

### #9 — Heartbeat cadence is not interleaved with long read sequences (skill-level enforcement is non-functional)

**Discovered:** 2026-05-07, Phase-2 research-prep cast `cast-1778187665150` (after bug #8 fix in `9ed5609`). Independently surfaced by clone A and clone C in their last-gasp reports, with concrete fix proposals.
**Severity:** High — recurring across every research clone with non-trivial reading load. The 90 s threshold from bug #8 helps but does not eliminate the failure mode; it only widens the window.
**Status:** **Fixed in this commit** via structural option (d) — the bus auto-touches `last_heartbeat_at` on every successful MCP handler from a registered clone. Skill v0.0.2 + priming "first call of every turn" rule (commit `5cd7234`) was insufficient as proven by validation cast `cast-1778189501846` (see `docs/post-mortems/2026-05-07-cast-1778189501846-validation.md`); skill-level + priming-level enforcement of per-turn heartbeat is not a forcing function. The structural fix sidesteps Claude's instruction-following entirely: any `manta.*` call IS a liveness signal, so the dispatcher in `packages/manta-bus/src/server.ts` calls `Registry.touch(cloneId)` after every successful handler whose args include a `clone_id`. Silent no-op contract on DEAD or unknown clones (no zombie resurrection). Skill `manta-as-clone` v0.0.3 + priming preamble both rewritten to reflect: "heartbeat is implicit, manta.heartbeat is for state transitions only". 6 new tests pin the behaviour: 3 unit (`Registry.touch` on WORKING / DEAD / unknown), 3 integration (non-heartbeat call updates last_heartbeat_at, failed call does not, DEAD clone is no-op). Validate via Phase-2 dogfood — success = clones surviving multi-minute read+draft loops without explicit heartbeats.
**Symptom:** A research clone reading multi-KB specs + drafting markdown can legitimately go 50–80 s between MCP calls (especially during batched parallel `Read` turns). The skill `manta-as-clone` v0.0.1 said "heartbeat every ≤ 10 s" but Claude has no wallclock between assistant turns; it only sees "next turn." A clone doing 60 s of `Read` + `Grep` without any `manta.*` tool use lapses into heartbeat staleness despite working productively.
**Reproducer (historical):**
1. Cast a clone with a research mission that requires reading >10 files (e.g. spec + plan + 5–8 source files).
2. Observe the events.jsonl: typically one heartbeat at startup, then no further heartbeats until shutdown — the orchestrator marks DEAD between them.
**Root cause:** Heartbeat cadence was treated as a wall-clock SLA in skill text, but enforcement required a conversation-loop primitive instead.
**Fix:** `manta-as-clone` v0.0.2 + priming preamble both lift heartbeat to Required with explicit "the **first** tool call of every assistant turn that contains tool calls must be `manta.heartbeat({state: 'WORKING', message})`". Cadence becomes a property of the conversation loop (a conversation-loop primitive Claude can actually observe), not a property of wall-clock seconds (which Claude cannot observe between turns). The `heartbeatTimeoutMs=90 000ms` is now framed as hard, not advisory. New `priming.test.ts` cases pin the cadence rule in the spawner preamble. Validate via Phase-2 dogfood re-cast — the success criterion is a heartbeat per assistant turn in `events.jsonl`, not per N seconds.
**Lessons:**
- A skill saying "every ≤ 10 s" is not a forcing function when the runtime has no concept of wall-clock between turns. Future skill thresholds must be expressed in terms of conversation-loop primitives ("every Nth turn", "first call of every turn", "before/after every Read"), not seconds.
- Bugs #7 + #8 + #9 form a cluster — the orchestrator's death-detector treats one wallclock threshold as the universal liveness signal, but real clones operate on a conversation-loop clock. The conversation-loop primitive (#9 fix) is the discipline-side complement to the threshold widening (#8 fix); together they should make heartbeat reliable. If next dogfood still drifts, ship option 2 (bus-side `heartbeat_keepalive`) as the structural decouple.

### #10 — Clones leave deliverables uncommitted on graceful death

**Discovered:** 2026-05-07, Phase-2 research-prep cast `cast-1778187665150`. Clone A wrote both deliverable + last-gasp uncommitted; clone C committed the deliverable but not the last-gasp; only clone B committed both. Main had to manually `cp` files out of dead worktrees.
**Severity:** Medium — survivable but creates archaeology overhead and breaks the "main pulls from worktree branch" contract that `manta-merge-review` (Phase 2) will rely on.
**Status:** Fixed in this commit.
**Reproducer (historical):** Cast any clone with a deliverable scope; observe in some clones that `git status` inside the worktree shows untracked files at exit time even though `report_death` was called.
**Root cause:** `manta-graceful-death` v0.0.2 had "Final commit" in **Allowed**, not **Required**. Clones interpreted that as optional. Skill text didn't enforce the order of (commit → ZK → release → suicide → report_death) either.
**Fix:** `manta-graceful-death` v0.0.3 introduces a numbered `## Required (ordered)` section with seven steps, of which step 1 is the final commit. The Forbidden list now flags "Skipping the final commit" alongside "Skipping the ZK dump". Priming preamble was rewritten to mirror the same ordering. The clone-spawner test will catch regressions in the priming text via the new `final commit` assertion in `priming.test.ts`. Phase-2 acceptance must re-validate: `git -C <worktree> status --porcelain` should be empty at clone exit time across all dogfood casts.
**Lessons:**
- Skill files used to advertise "Allowed" actions ambiguously — Required vs. Allowed must be a structural distinction in the skill, not a colour-of-bullet distinction. Future skills should always have a numbered `Required (ordered)` section when there's a multi-step protocol.
- Bug seed #4 from the Phase-2 research post-mortem is now closed as #10. Promoted from seed → numbered the moment the fix shipped.

### #8 — `heartbeatTimeoutMs` default (30 s) too tight for actively-working clones

**Discovered:** 2026-05-07, Phase-2 research-prep dogfood re-run (`cast-1778187134719`, after bugs #6 + #7 fix in commit `ae192ec`).
**Severity:** High — any cast where clones do real work between heartbeats (reading multi-KB specs, drafting markdown, running greps) is silently aborted ~30 s after the first heartbeat. Phase-1 lockdown dogfood passed by coincidence: its task ("map src/ public exports") is small enough that clones called heartbeat several times during execution.
**Status:** Fixed in this commit.
**Reproducer (historical):**
1. After bugs #6/#7 fix (`ae192ec`), re-cast Phase-2 research-prep with the new `--max-files-changed 5 --allowed-paths` flags.
2. All 3 clones reach STARTING → WORKING fine (startup grace works), each sends exactly one heartbeat, each calls `manta.ack_contract` with a sane interpretation.
3. Each clone then begins reading CLAUDE.md + spec sections + INDEX.md + research-prep.md before drafting its deliverable — that read+think+draft loop runs for ~30 s with no MCP roundtrip.
4. At t ≈ first-heartbeat + 30 s, orchestrator marks each clone DEAD with reason `"heartbeat 32323ms ago > 30000ms"`. No deliverable on disk; no second heartbeat ever sent.
**Root cause:** The skill `manta-as-clone` instructs "heartbeat every ≤ 10 s", but Claude does not track wallclock between tool calls and there is no in-loop forcing function. A clone reading a 5 KB spec section + drafting markdown can legitimately go 30–60 s between MCP calls. The original 30 s threshold (justified in `thresholds.ts` as "Sec 9 blocker #5: suicide через 30 сек после смерти parent") conflated two different deadlines: a clone's *own* suicide-on-orphan deadline (which it self-checks frequently) and the *orchestrator's* third-party staleness threshold (which must accommodate realistic working windows).
**Fix:** Default `heartbeatTimeoutMs` raised from `30_000` → `90_000`, matching `startupGraceMs` for symmetry. Justification embedded in `thresholds.ts` comment with a pointer to the dogfood cast id. Tests that asserted DEAD after `advance(31_000)` updated to `advance(91_000)`; post-mortem fixture text updated; whole-workspace sweep 338+ tests green. Operators can still tighten via `--heartbeat-timeout-ms` for fixture/integration scenarios that need fast death detection.
**Lessons:**
- **Spec thresholds are theoretical until production-validated.** 30 s came from spec prose without empirical wall-time data on real research workloads. Future threshold changes must come with a captured-timing rationale, not a comment citing the spec.
- **A skill saying "every ≤ 10 s" is not a forcing function** — Claude doesn't have a wallclock-based heartbeat scheduler between tool calls. For real liveness, either (a) bump the threshold to cover the realistic working window, or (b) add a side-channel heartbeat (e.g. spawner-side periodic ping). 90 s is the (a) path; (b) is a Phase-2+ improvement candidate.
- **Bugs #7 and #8 are the same bug at different timepoints** — #7 was startup-window staleness, #8 is working-window staleness, both caused by treating threshold-tightness as more important than realistic timing. Future detector changes should think in terms of state-machine transitions (registered → first-heartbeat → DEAD) and pick a threshold per transition.

### #6 — `cast` command hardcoded `scope.max_files_changed = 0`, blocking any deliverable cast

**Discovered:** 2026-05-07, Phase-2 research-prep dogfood (`cast-1778185934043`)
**Severity:** Catastrophic — every `manta cast` whose mission produces an on-disk artifact (research markdown, plan, code patch) was impossible. Phase-1 lockdown dogfood passed by coincidence: the e2e assertion required only `clone DEAD + post-mortem on disk`, not a deliverable.
**Status:** Fixed in this commit.
**Reproducer (historical):**
1. `manta cast recon-swarm --clones 3 --task "produce docs/research/x.md"`
2. Spawner writes task contract with hardcoded `scope: { allowed_paths: ['.'], forbidden_paths: ['.manta/state', 'secrets/'], max_files_changed: 0 }`.
3. Clone B reads contract, calls `manta.ack_contract`:
   > "scope.max_files_changed=0 contradicts the task's mandate to produce a deliverable file — both blockers prevent doing the assigned best-of-N research; entering graceful death with a forensic note instead of producing the deliverable."
4. All three clones reach DEAD with empty deliverables; `docs/research/` is empty.
**Root cause:** `packages/manta-cli/src/commands/cast.ts:107-111` hardcoded the scope literal. No CLI surface, no per-mode default, no override path. Phase-1 e2e assertion did not require deliverable verification, so the bug shipped to GA.
**Fix:** `cast` now exposes `--max-files-changed <n>` (default `0` — preserves existing behaviour), `--allowed-paths <csv>` (default `.`), `--forbidden-paths <csv>` (default `.manta/state,secrets/`). `RunCastOptions.scope` is the typed pass-through; defaults apply when omitted (test back-compat). Validation: negative `maxFilesChanged` and empty `allowedPaths` throw `CliError(invalid_input)`. Two new tests in `cast.test.ts` pin custom-scope propagation and the negative validation.
**Lessons:**
- **Pre-flight + skill validator + lifecycle-only e2e is not enough.** Phase-1 lockdown e2e asserted DEAD + post-mortem; bug #6 was production-grade by that bar but immediately fatal for any deliverable cast. Phase-2+ e2e must assert the **deliverable artifact** as well, not just the lifecycle.
- **Hardcoded defaults that contradict the dominant use-case are landmines.** Recon-swarm research is overwhelmingly going to write a markdown deliverable; the default should reflect that, or the CLI must surface the override prominently.

### #7 — heartbeat threshold (30s) too tight for cold-start `claude --print`; STARTING clones DEAD before first MCP call

**Discovered:** 2026-05-07, Phase-2 research-prep dogfood (`cast-1778185934043`)
**Severity:** High — any cast where clones take >30 s to reach first heartbeat is silently aborted. Phase-1 lockdown dogfood passed by coincidence (2 clones with lighter context started in ≤ 30 s).
**Status:** Fixed in this commit.
**Reproducer:**
1. `manta cast recon-swarm --clones 3 --task "<heavy priming>"`
2. Spawner pre-registers each clone with `state: 'STARTING'` (Phase-1 lockdown invariant; `last_heartbeat_at` stamped equal to `registered_at`).
3. `claude --print --append-system-prompt <preamble> <prompt>` cold-starts: skill load + snapshot read + first MCP call ≈ 30–60 s.
4. Within that window, orchestrator's death-detector runs, sees `now - last_heartbeat_at > 30_000`, marks clone DEAD with reason `"heartbeat 30364ms ago > 30000ms"`.
5. Clones eventually call `manta.heartbeat`; bus replies the clone is DEAD; clones go straight to `manta.ack_contract` with a forensic explanation and exit.
**Root cause:** `packages/manta-orchestrator/src/death-detector.ts` applied `heartbeatTimeoutMs` uniformly regardless of `state`. STARTING clones haven't sent a real heartbeat yet — `last_heartbeat_at` is just the registration timestamp from the spawner. Treating it as a stale heartbeat punishes cold-start latency.
**Fix:** New threshold `startupGraceMs` (default 90 s) applies when `state === 'STARTING'` and is checked against `now - registered_at`. Once a clone calls `manta.heartbeat` (state → WORKING), the existing `heartbeatTimeoutMs` (30 s) takes over against `last_heartbeat_at`. Updated tests in `death-detector.test.ts` (added STARTING-grace coverage) and `thresholds.test.ts` (default value), plus migrated existing tests that registered + advanced without heartbeating to call `heartbeat({state: 'WORKING'})` first.
**Lessons:**
- **`last_heartbeat_at` is not a positive liveness signal during STARTING** — Phase-1 dogfood post-mortem already noted this for the e2e watcher, but the detector itself still treated it as one. Generalised the lesson: any code consuming `last_heartbeat_at` must also gate on `state` to know whether it's a real heartbeat or a registration fingerprint.
- **30 s is realistic for an established session, not for cold start with priming.** Future orchestrator thresholds should be empirically derived from real cast wall-time histograms, not from spec prose.
- **Bug #6 and bug #7 are independent but reinforced each other in the failure mode** — bug #6 made the deliverable impossible; bug #7 killed the clones before they could even discover bug #6. Without forensic post-mortems and `contract_ack` payloads, the dual root-cause would have been much harder to disentangle.

### #13 — Priming preamble + `manta-as-clone` v0.0.2 instruct clones to send `message` field on `manta.heartbeat`, but bus schema rejects it

**Discovered:** 2026-05-07, validation cast `cast-1778189501846` (the cast intended to validate bug #9/#10 fixes from commit `5cd7234`).
**Severity:** Medium — silent observability loss. Best case: clone drops the `message` field after a schema rejection (degrading observability — `events.jsonl` records `progress: null` instead of an operator-grade status string). Worst case: clone interprets the validation_error as a hard failure and skips heartbeating entirely, compounding bug #9.
**Status:** **Fixed in this commit** via cleanup (not schema widening). Since bug #9's structural fix removes the per-turn heartbeat rule entirely, the `message` field is no longer needed in the priming preamble or `manta-as-clone` skill — both were rewritten to drop it. The bus `HeartbeatInputSchema` keeps its existing `progress?: string` field (which clones can still use for state-transition heartbeats); `message` was a duplicate concept, not an additional one. Future operator-grade message field can ship as a separate decision if observability proves wanting; for now, the schema and the text agree.
**Symptom:** Clone A's last-gasp report explicitly logged: *"`manta.heartbeat` rejected the `message` field per its current schema (the priming preamble in this snapshot instructed me to send `{ clone_id, state, message }`). Heartbeated successfully without `message`."*
**Reproducer:**
1. Cast any clone with the priming preamble shipped in commit `5cd7234`.
2. Observe the bus accepts `{clone_id, state}` but rejects `{clone_id, state, message}` with `validation_error`.
3. Cross-check `packages/manta-bus/src/schemas/heartbeat.ts` (or wherever the schema lives) — there is no `message` field declared.
**Root cause:** I introduced the `message` field in the skill text (`manta-as-clone` v0.0.2) and priming preamble in commit `5cd7234` without auditing the bus's `manta.heartbeat` Zod schema, which still ends at `{clone_id, state}`. Cross-plan field-name drift, exactly the failure mode `CLAUDE.md` "Plan-writing discipline" warns against.
**Fix:** Widen the bus schema to accept an optional `message?: string` (≤ 200 char, trimmed). Persist into `events.jsonl` heartbeat entries so the `progress`/`message` field becomes operator-grade observability. Tests: schema accepts both `{clone_id,state}` and `{clone_id,state,message}`; events.jsonl emits the message when provided. Ship together with bug #9 structural fix in the same commit.
**Lessons:**
- **Skill-validator must grow a cross-tool field-name check.** Any `manta.*` field name mentioned in a skill or priming text should exist in that tool's Zod schema. This is the same shape as the cross-plan field-name drift class of bug from Phase-0 plan reviews; we knew about it as a *plan* hazard but didn't generalise to skills+priming until now.
- **Field additions must be schema-first, then skill-text.** Adding `message` to `manta.heartbeat` should have been a 2-step: (1) widen schema with test, (2) reference field in skill+priming. Going skill-first creates an invisible regression.

### #11 — `manta.zk_write` array-param transport bug (clone B reproducer)

**Discovered:** 2026-05-07, Phase-2 research-prep cast `cast-1778187665150`. Surfaced in clone B's last-gasp; clones A and C succeeded with their ZK writes from the same skill version, so the failure is not deterministic across clones.
**Severity:** Medium — affects bug #5 mitigation (some failures may be transport-layer, not skill-discipline).
**Status:** Open. Needs independent reproduction before promotion to a confirmed orchestrator-side bug.
**Symptom:** Clone B attempted `manta.zk_write` 5× with various `tags: string[]` shapes; every call returned `validation_error: invalid_type, expected: array, received: string, path: ['tags']`. Clones A and C succeeded with structurally-similar payloads in the same cast.
**Hypothesis:** Either (a) claude-CLI's MCP tool-use serialiser flattened the array into a CSV string for that one clone (transient renderer-state bug), or (b) the bus's `tags` schema is too tight for an LLM payload that occasionally arrives as `"a,b"` instead of `["a","b"]` (we should be liberal in what we accept here — tags is metadata, not load-bearing).
**Reproducer (needed):** Spawn 3+ clones in a research cast and grep `events.jsonl` for `validation_error` against `manta.zk_write`. If repeats appear cross-cast on a non-zero fraction of clones, escalate.
**Recommended next step:** Phase-2 add an e2e assertion that exercises `manta.zk_write` with both array-literal and CSV-string inputs and accepts both at the bus boundary; OR fix at the LLM-prompt layer by example-driven cooking ("tags: [\"a\",\"b\"]") in the priming preamble.
**Lessons:** Be liberal in what you accept at the bus boundary for soft-schema metadata fields. ZK tags are an audit trail, not a primary key; coercing a CSV string to `string[]` is benign and prevents this class of failure.

### #12 — Forensic timeline JSON not produced by production cast path

**Discovered:** 2026-05-07, Phase-2 research-prep cast `cast-1778187665150`. Clone A's last-gasp explicitly asked for the timeline JSON; the research-prep acceptance checklist also required it.
**Severity:** Low-Medium — observability gap, not a correctness bug.
**Status:** Open. Deferred to Phase 2 (folded into the `forking-realities` plan).
**Symptom:** The forensic timeline writer from commit `64bf188` runs only inside `packages/manta-e2e` test harness — it produces `docs/post-mortems/e2e-timeline-<cast-id>.json`. A real `manta cast` invocation does not produce this artifact, even though the timeline data (cast lifecycle, clone states, event jsonl interleavings) is exactly what the post-mortem needs to be useful at scale.
**Recommended fix:** Lift the timeline writer into the production cast path (`packages/manta-cli/src/commands/cast.ts` or the orchestrator's post-mortem composer), so every cast — not just e2e — emits a timeline JSON alongside the markdown post-mortem. Sketch: extract `recordCloneEvent` + `writeTimeline` from `packages/manta-e2e/src/forensics.ts` into `@manta/orchestrator` and have the orchestrator call them on cast finalisation. Phase-2 plan should fold this into the `manta-merge-review` design (the same metadata is needed for forking-realities best-of-N selection).
**Lessons:** Test-harness-only observability is technical debt — every signal we wired into e2e is a signal a production operator will eventually want. When wiring observability into e2e, bias toward writing it once at the orchestrator layer and making the e2e harness *consume* it, rather than reimplementing it inside the harness.

### #1 — manta-cli integration test flakes under concurrent workspace test run

**Discovered:** 2026-05-07, during Phase 0e Chunk-2 spec-review remediation
**Severity:** Low
**Status:** Open
**Reproducer:**
1. `git checkout 1ddabb0`
2. `pnpm -r test` (default workspace concurrency)
3. Sometimes `@manta/cli` integration test fails with "orchestrator cycle failed"
4. Re-running `pnpm --filter @manta/cli test` or `pnpm -r --workspace-concurrency=1 test` → green
**Root cause:** Likely resource contention in `packages/manta-cli/tests/integration.test.ts`'s parent-PID probe + process-spawning path when other test workers consume process / fd budget. Not yet investigated.
**Fix:** Pending. Workaround: run whole-repo sweep with `--workspace-concurrency=1` until rooted.
**Lessons:** Tests that interact with real OS process state (PID probes, child spawns) are concurrency-sensitive. Consider isolating them into a serialized vitest pool or marking them with `test.serial` once we encounter another such case.

## Fixed bugs

### #5 — Clones do not invoke `manta.zk_write` during graceful death

**Discovered:** 2026-05-07, Phase-1 lockdown dogfood cast (commit `57551ef`)
**Severity:** Medium — was flaky skill-adherence; root cause was skill text presenting ZK as merely "Allowed" rather than required
**Status:** Fixed in Phase-1 follow-up commit (skill v0.0.2 + priming text update).
**Reproducer (historical):**
1. First Phase-1 dogfood: 0/2 ZK notes written
2. Second Phase-1 dogfood (same code, same skill): 1/2 ZK notes written
3. Pattern: flaky, not infrastructural — clones could write ZK but skipped because skill listed it under "Allowed" alongside optional actions, and "Massive ZK dumps" appearing in Forbidden discouraged any write.
**Root cause:** Skill `manta-graceful-death` (v0.0.1) presented `manta.zk_write` as one of several "Allowed" actions, with a "Massive ZK dumps" Forbidden line that discouraged any writing. No required-actions section, no ordered shutdown checklist. Clones interpreted the skill conservatively and skipped ZK to avoid violating the "no massive dumps" guardrail.
**Fix:** Skill `manta-graceful-death` v0.0.2 — added explicit "shutdown checklist is ordered and required" framing; promoted `manta.zk_write` to a "Required" bullet within Allowed (with bolded violation language); added "Skipping the ZK dump" to Forbidden; added per-step ZK numbering in Examples. Priming text in `packages/manta-cli/src/spawner/priming.ts` also tightened to enumerate the 5-step required shutdown ordering. e2e assertion in `recon-swarm.e2e.test.ts` re-tightened from warning back to `expect(≥ 2)`. Verified by Phase-1 v3 dogfood (2m45s wallclock, ≥ 2 ZK notes written, e2e green).
**Lessons:** Skills are read literally — what's "Allowed" gets interpreted as "optional unless you specifically need it." For required behaviours, use a "Required steps" framing or move the bullet into Forbidden ("skipping X is forbidden"). For audit-trail-style requirements (where the *act* matters more than the *content*), provide a fallback (e.g. "if you genuinely have nothing novel, write a no-novel-findings note"). The Phase-1 v0.0.1 → v0.0.2 skill diff is the canonical pattern for tightening clone discipline without changing infrastructure.

### #2 — Spawner-registers-clone-before-launch claim is misleading

**Discovered:** 2026-05-07, during Phase 0f Chunk-2 code-quality review (commit `53b9b4b`)
**Severity:** Medium
**Status:** Fixed in `57551ef` (Phase-1 lockdown).
**Reproducer:**
1. Read `skills/manta-as-clone/SKILL.md` ~line 17 — claims "the CLI spawner registered you on the bus before launching this process"
2. Read `docs/user/recon-swarm.md` line 20 — repeats the claim ("the spawner registered the clone *before* the process started")
3. Grep `packages/manta-cli/src/commands/cast.ts` and `packages/manta-cli/src/spawner.ts` — the spawner calls `ctx.contracts.write(...)` (writes the task contract) before launching, but never calls `ctx.registry.register`. The registry record is created by the clone calling `manta.register` itself on startup.
**Root cause:** Skill text and now user-facing docs assert behaviour the spawner does not perform.
**Fix:** Spawner now pre-registers the clone via `runtime.ctx.registry.register({ clone_id, mode, parent_pid, worktree, metadata: { cast_id } })` before invoking the runner (`packages/manta-cli/src/spawner/clone-spawner.ts`). The skill claim is now accurate. Behavioural fixture in `packages/manta-cli/tests/spawner/startup-sequence.test.ts` pins the invariant against the real Bus Registry.
**Lessons:** When a skill's instructional text describes orchestrator/CLI behaviour, the validator should cross-check the claim against the implementation. The Phase-1 behavioural-fixture test is the precedent for similar future invariants.

### #3 — e2e cast hangs against real `claude --print`; clones never register

**Discovered:** 2026-05-07, during Phase 0f acceptance dogfood (commit `2f641b2`)
**Severity:** High — blocks Phase-0 acceptance signoff
**Status:** Fixed in `57551ef` (Phase-1 lockdown).
**Fix:** Spawner pre-registers the clone before invoking the runner (closes #2 family) AND replaces the dead `--snapshot <path>` argv with the real claude flags `--print --append-system-prompt <priming-text> --permission-mode bypassPermissions <prompt>`. Priming text loads the `manta-as-clone` skill and points at `MANTA_SNAPSHOT_PATH` (env var, already exported). Phase-1 lockdown dogfood (4m36s wallclock, 2 clones, both DEAD with post-mortems on disk) proved the wedge is gone. e2e gained a positive-timeline watcher (`tickBudgetMs/4 = 6m15s`) that fails fast with a registry dump if any clone stays in `STARTING`.
**Reproducer:**
1. `claude mcp add -s user manta-bus -- node "$(pwd)/packages/manta-bus/dist/bin/server.cjs"`
2. `MANTA_E2E=1 pnpm e2e:recon-swarm`
3. Cast spawns 2 `claude-haiku-4-5` clone subprocesses successfully (visible in `ps`).
4. Worktrees, contracts, snapshots all written to `.manta/state/` and `.manta/snapshots/`.
5. **Registry file (`.manta/state/registry.json`) stays empty** — no clone calls `manta.register` over MCP.
6. Two clone processes idle at low CPU; `manta status` shows `clones=0 locks=0 claims=0`.
7. After ≥ 5 min of zero progress (no log output, no registry mutation, no post-mortem) the harness has to be killed via `pkill -f vitest`.
**Root cause (hypothesised):**
- The spawner passes `--snapshot <path>` to `claude --print` (`packages/manta-cli/src/spawner/clone-spawner.ts:171`), but the current `claude` CLI (2.1.132) **silently ignores unknown flags** — verified by `claude --print --snapshot /dev/null --version` returning version + exit 0. So the clone receives no inherited transcript, no context about who it is or what to do.
- Without snapshot inheritance, the spawned clone has no priming prompt, no system-prompt overlay, and no path to discover its task contract. It launches as a fresh idle session and waits — heartbeat never fires, register never called.
- This is the **same family** as bug #2 (spawner-registers-clone claim is misleading): the docs/skills say the harness wires up identity for the clone, but the code path is incomplete.
**Fix:** Pending. Two real fixes required:
1. Replace `--snapshot <path>` with a snapshot-inheritance mechanism the running `claude` CLI actually supports — likely a stdin priming protocol (pipe the snapshot as the initial user message), or an env var (`MANTA_SNAPSHOT_PATH`) that a startup hook reads.
2. Either pre-register the clone from the spawner before launch (closing bug #2), or add a startup-skill / hook that reads the env-passed contract and calls `manta.register` deterministically on launch.
**Lessons:**
- **Pre-flight does NOT prove end-to-end.** Phase-0e/0f preflight passed for 7 sessions while this fundamental wiring was broken. Lesson for Phase 1 lockdown: behavioural-fixture tests for the clone-startup sequence (snapshot ingest → register → first heartbeat) are not optional, they're acceptance-blocking.
- **`claude` CLI silently ignoring unknown flags is a foot-gun.** Any future spawner change that adds a flag must be validated by `claude --print --new-flag …` actually doing what's intended; absence of error is not confirmation.
- **The Phase-0 e2e test asserted only on harness lifecycle (registry DEAD + post-mortems on disk), not on quality of mapping output.** Even if it had passed, it wouldn't have caught the no-snapshot-inheritance issue, since clones never reaching DEAD also produce no post-mortems. The assertion needs a positive timeline check, not just a final-state check.

### #4 — `claude --print --snapshot <path>` silently accepts the unknown `--snapshot` flag

**Discovered:** 2026-05-07, while diagnosing bug #3
**Severity:** Medium — surface of the deeper bug #3, but worth tracking separately
**Status:** Fixed in `57551ef` (Phase-1 lockdown).
**Fix:** Manta no longer passes `--snapshot`; instead uses `--append-system-prompt <text>` which the claude CLI actually parses. Negative regression guards in `packages/manta-cli/tests/spawner/clone-spawner.test.ts` and `priming.test.ts` assert the dead flag never appears in argv or priming text. Phase-1 plan task 1.2 added a positive-behavioural smoke (`claude --print --append-system-prompt "REPLY_TOKEN=…"` returns the embedded token) — the lesson is now codified for any future flag addition.
**Reproducer:** `claude --print --snapshot /dev/null --version` → prints `2.1.132 (Claude Code)` and exits 0 with no warning about `--snapshot`.
**Root cause:** Current `claude` CLI tolerates unknown flags (probably to forward-compatibility for plugins). Manta's spawner relied on it being a real flag.
**Lessons:** When integrating with a third-party CLI, validate every new flag with `--help | grep <flag>` and a positive behavioural smoke, not just exit-code 0 from a no-op invocation. The Phase-1 lockdown plan formalised this as task 1.2 (probe + smoke before code change).

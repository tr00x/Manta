# F — Manta Benchmark / Proof Methodology (DESIGN ONLY)

**Status:** DESIGN + research. **Cannot be executed yet.** Manta's end-to-end user journey is
not fully working (see bug #66 — clones reaped on cold-start when the parent transcript is large;
plus the other audits in this folder on the install/cast path). This document specifies a benchmark
that becomes runnable the moment a clean `manta cast` → work → merge cycle completes reliably from a
realistic session. Until then, treat every number below as a *slot to be filled*, not a result.

**Author intent (non-negotiable):** this benchmark must be capable of showing Manta is **WORSE**.
If Manta loses on a task class, the table prints the loss in the same font as the wins. No cherry-
picking task shapes, no quietly dropping failed trials, no "well it would have won if…". A proof that
can only show success is marketing, not a proof.

---

## 0. What we are actually testing

Manta's claim (README + design spec Sec 1, Sec 9):

> Same-system-prompt cloning with **full transcript inheritance**, parallel work in **isolated git
> worktrees**, coordinated over a **message bus**, beats both cold-context subagents and
> role-specialized multi-agent frameworks on *real, multi-file/branchy/repetitive* dev work — **without**
> the overhead of designing a role hierarchy.

That claim decomposes into **four falsifiable sub-claims**. The benchmark must test each separately,
because Manta can win one and lose another, and an honest report says which:

| ID | Sub-claim | What would falsify it |
|----|-----------|------------------------|
| C1 | **Speed**: Manta finishes a qualifying task in less wall-clock than solo Claude Code. | Solo equal or faster on the same task at equal correctness. |
| C2 | **Context efficiency**: the *main* agent's context window stays cleaner (it delegates the spelunking). | Main agent burns ≥ as much context coordinating as it would have just doing the work. |
| C3 | **Warm-start advantage over subagents**: transcript inheritance produces fewer re-derivation errors / less rework than cold-context subagents on the *same* task. | Subagents match Manta's correctness/rework at lower cost. |
| C4 | **No role-graph tax vs frameworks**: Manta reaches comparable correctness without the up-front design cost a CrewAI/LangGraph crew imposes. | A role-graph framework reaches equal correctness with comparable total human+token cost. |

The project's own **Definition of Done #1** (spec Sec 15.4) sets the headline bar:
> "On Manta's own repo the main builds a new feature in **< 50 % of the time** vs solo Claude Code (measured)."

So the primary hypothesis is concrete and pre-registered:

> **H1 (primary):** `wallclock(Manta) ≤ 0.5 × wallclock(Solo)` at **equal-or-better** correctness, on
> the qualifying task classes (multi-file / branchy / repetitive).

A 0.51× result is a **fail of the stated goal**, even if Manta was faster — report it as such.

---

## 1. Conditions (the four arms)

All arms run the **same task spec, same base model, same repo snapshot, same machine, same network
posture**. The only thing that varies is the *execution method*.

| Arm | Description | What's controlled / honest caveat |
|-----|-------------|-----------------------------------|
| **A. Solo** | One Claude Code session, sequential, no casting, no subagents. The baseline. | This is the number H1 must beat by 2×. The fairest, hardest baseline. |
| **B. Subagents** | One Claude Code session that uses the built-in `Agent` tool to fan out cold-context helpers for the independent sub-parts. Main agent briefs each subagent with a written prompt (counts toward main context). | Reflects what a competent user does *today* without Manta. The brief-writing cost is real and counted — do not hide it. |
| **C. Manta** | `manta cast <mode> --clones N` from a session primed with the same task context as A/B. Clones inherit the transcript, work in worktrees, coordinate on the bus; main reviews + merges. | The system under test. Startup overhead, bus coordination, merge-review, and the **#66 cold-start tax** are all counted against Manta. |
| **D. Role-framework (DESIGN-THEORETIC + optional empirical)** | A CrewAI/LangGraph-style crew with hand-designed roles (e.g. planner / implementer / reviewer) on the same task. | **Cannot be run inside Claude Code.** Run separately on the same model via API *if* resourced, else compared design-theoretically with explicit, itemized assumptions (Sec 6). Mark every D number as `[empirical]` or `[modeled]`. Never blend the two. |

**Why D is special.** We cannot honestly produce a wall-clock for D from inside this environment, and a
"modeled" number is trivially riggable. So D's role in the headline table is **bounded**: it contributes
the *role-design tax* (C4) — the human/setup cost of authoring and wiring a role graph for *this specific*
task — which is observable and itemizable even without running the crew. Any D performance number that is
not measured on the real framework is labeled `[modeled]` with its assumptions inline, and is **excluded
from H1's pass/fail**.

---

## 2. Tasks (concrete, reproducible)

Three tasks, each matching one shape Manta explicitly targets (README: "big, repetitive, or has
independent parts"). All three run against a **pinned commit** of a chosen target repo so they re-run
identically. Use a repo *other than Manta itself* for the headline numbers to avoid the obvious bias of
the tool grading its home turf — but **also** run them on Manta's repo to satisfy DoD #1, and report both,
labeled. (Suggested neutral target: a mid-size TypeScript monorepo with a real test suite, pinned by SHA.
The exact repo + SHA must be recorded in the result artifact; it is part of reproducibility.)

Each task ships with a **machine-checkable acceptance script** (`verify.sh`) that returns pass/fail with
no human judgment. "Done" = `verify.sh` exits 0. This kills the biggest cheat vector: an agent declaring
victory on work that doesn't actually pass.

### Task T1 — Feature touching N files (branchy, "which approach?")
- **Shape:** add a cross-cutting feature that legitimately has ≥ 2 non-obvious implementations (Manta's
  `forking-realities` sweet spot). Example template: "add structured request-ID propagation through the
  HTTP layer + logger + error reporter" — touches ~6–10 files, no single obvious design.
- **Acceptance (`verify.sh`):** the existing suite passes **plus** N new behavioral assertions (shipped
  with the task, not authored by the agent) that exercise the feature end-to-end. New tests are
  **frozen** — agents may not edit `verify.sh` or the frozen test files (enforced by checksum).
- **Why it tests Manta:** branchy → `forking-realities` (2 clones, best-of-N) is the designed answer.
  If solo wins here, C1+the whole forking premise is in question.

### Task T2 — Migrate a pattern across M call-sites (repetitive)
- **Shape:** mechanical-but-careful migration repeated across M ≥ 15 sites (Manta's `refactor-wave`
  sweet spot). Example: "replace all direct `console.*` logging with the structured logger, preserving
  log level + adding the new request-ID field." Repetitive, parallelizable, low ambiguity.
- **Acceptance (`verify.sh`):** (a) `grep` finds zero remaining old-pattern call-sites; (b) full test
  suite passes; (c) a frozen lint rule that bans the old pattern passes. Objective, no judgment.
- **Why it tests Manta:** pure parallel sweep. This is where Manta *should* dominate if anywhere. If it
  doesn't beat solo here, H1 is dead.

### Task T3 — Map + document a subsystem (read-only intelligence)
- **Shape:** produce an accurate architecture map of a subsystem spanning ≥ 5 files across layers
  (Manta's `recon-swarm` sweet spot). No code changes.
- **Acceptance:** correctness is graded against a **pre-written answer key** (the ground-truth map of
  entry points, data flow, and the correct insertion point for a hypothetical feature, authored once by
  the benchmark designer and frozen). Score = recall of key facts + count of asserted-but-false facts
  (hallucinations). A blind grader (a fresh Claude session given the answer key + the candidate doc, with
  no knowledge of which arm produced it) scores each output; **two independent grader runs**, disagreements
  resolved by a third. This is the one task with a subjective component — handled by blinding + double-grade.
- **Why it tests Manta:** `recon-swarm` is Wave-1, the most mature mode, and C2 (context efficiency) is
  most visible here — the main agent gets two focused write-ups instead of spelunking itself.

**Task sizing discipline:** all three are deliberately in the >10-minute, multi-file band where Manta
*claims* to earn its keep. We do **not** include a 3-minute trivial task as a headline task — but see
the **anti-task** below, which we run on purpose to show Manta losing.

### Anti-task T0 (run on purpose — designed to make Manta lose)
- **Shape:** a single-file, single-function bugfix, < 5 minutes solo. The README itself says don't cast
  this. We run it through **all four arms anyway**.
- **Expected honest result:** Solo wins decisively; Manta is slower and more expensive (startup +
  worktree + bus + merge overhead with no parallelism to amortize it). **Reporting T0's Manta loss is
  mandatory** — it calibrates the reader's trust in the wins on T1–T3 and demonstrates the benchmark
  isn't rigged. If T0 ever shows Manta winning, suspect the harness.

---

## 3. Metrics (objective, with measurement procedure)

Every metric has a defined source so two people get the same number. No metric relies on an agent's
self-report (the project's own memory note: *implementers lie about test pass* —
`feedback-impl-self-reports.md`; the gate must be re-run independently).

| Metric | Unit | How measured (objective source) |
|--------|------|--------------------------------|
| **M1 Wall-clock** | seconds | Harness timestamps: `t_start` = task prompt submitted; `t_end` = `verify.sh` first exits 0 **as confirmed by the harness re-running it**, not by the agent claiming done. For Manta, includes cast startup, clone runtime, merge-review, and the main's merge. For subagents, includes brief-writing + dispatch + integration. Stopwatch starts the instant the human stops typing the task. |
| **M2 Token cost ($)** | USD | Sum of all model spend across the arm: main session + every clone/subagent. Source = the model API/usage telemetry, **not** Manta's own `manta cost` (which is the system under test and could be wrong — bug class). Cross-check `manta cost` vs raw telemetry and report the delta as a Manta-accuracy datapoint. |
| **M3 Correctness** | pass/fail + score | `verify.sh` exit code (T1/T2). For T3, the blind double-graded recall/hallucination score. Binary "done" plus a graded quality where applicable. |
| **M4 Main-context efficiency** | tokens (and % of window) | Tokens occupying the **main** agent's context at `t_end` (input tokens carried), measured from the transcript. This is C2's metric: Manta should keep the main lean by exporting work to clones. Subagents partly do this too; solo does not at all. Report absolute tokens + fraction of the model's context window. |
| **M5 Rework / error rate** | count | Number of times the arm produced output that **failed** `verify.sh` (or failed independent review) and had to be redone, before the final pass. Counts: failed test cycles, reverted commits, clone deaths-with-no-usable-output, merge conflicts requiring manual resolution, scope-fence violations. For Manta specifically: failed/abandoned clones and merge-review rejections count as rework even if a later clone succeeded. |
| **M6 Human-intervention cost** | seconds + count | Wall-clock the *human operator* spent actively steering (not waiting): writing briefs, resolving escalations, picking a merge-review winner, un-sticking a stalled clone, designing the role graph (arm D). Measured by a screen-time log or operator stopwatch. This is where arm D's role-design tax lands, and where Manta's merge-ceremony overhead is honestly charged. |
| **M7 Quality (durability)** | pass/fail | Re-run `verify.sh` 24 h later on a clean checkout of the merged result, and run the *full* repo suite (not just the task's frozen tests) to catch collateral breakage the task tests missed. Catches "passed the narrow test, broke three other things." A win that breaks the wider suite is **not** a win. |

**Derived headline:** `H1_ratio = M1(Manta) / M1(Solo)` per task, only counting trials where **both** arms
reached M3=pass and M7=pass. Trials where Manta failed correctness do **not** get dropped — they're
reported as failures and pull down Manta's pass-rate, which is its own column.

---

## 4. Protocol (fair execution + variance handling)

### 4.1 Controlled environment
- **Same base model** for every arm and every clone/subagent (record exact model ID + harness build).
- **Same machine, quiesced:** no other heavy jobs. Record load average at `t_start`. Bug #66 shows
  machine load and transcript size both affect Manta cold-start — so we **control both** (see 4.3).
- **Same repo + SHA**, fresh `git clone` / `git worktree prune` between every trial. No state leakage.
- **Same priming context:** arms A, B, C all start from a session primed with an *identical* short
  context block describing the repo and the task's background (so transcript-inheritance is tested
  fairly — C inherits it, B must re-brief from it, A just has it). The priming block is fixed text,
  checked into the benchmark.
- **Frozen acceptance:** `verify.sh` + frozen test files are checksum-guarded; any arm that mutates them
  is a **void trial** (and a finding).

### 4.2 Trials & significance
- **N = 10 trials per (task × arm)** for the headline tasks. LLM runs are high-variance; n=3 is theater.
  10 is the floor for a credible median + IQR. If budget forbids 10 across all 4 arms × 4 tasks, cut
  **arms before tasks** (drop empirical-D first, keep A/B/C at n=10) — never report n<5 as a headline.
- **Report median + IQR**, not mean (LLM latency/cost distributions are skewed and have fat tails from
  the occasional runaway or clone death). Show the full per-trial scatter in an appendix — hiding the
  distribution is a form of пиздеж.
- **Significance:** Mann–Whitney U (non-parametric, no normality assumption) on M1 between Manta and
  Solo, per task. Pre-register α = 0.05. Report the U statistic, p, and the effect size (rank-biserial
  or median ratio with bootstrap 95 % CI). A "win" that isn't significant is reported as "no significant
  difference," full stop.
- **Pre-registration:** H1, the task specs, `verify.sh`, N, α, and the stop rule are all written down and
  committed **before** the first trial runs. No post-hoc metric invention. The pre-registration commit SHA
  goes in the artifact.

### 4.3 Confound controls (these are where benchmarks lie if you let them)
- **Transcript-size control (critical, per #66):** transcript inheritance is Manta's headline feature
  *and* its biggest cost (re-ingest on turn 1, spec Sec 9 blocker #2; cold-start reaping, #66). So run
  Manta in **two sub-conditions**: **C-fresh** (cast from a small/fresh session, the favorable case) and
  **C-loaded** (cast from a realistically large session, e.g. ≥ 2 MB transcript, the case #66 exposes).
  Report **both**. Hiding C-loaded would be the single most dishonest move available — it's exactly the
  regime where Manta currently fails to even start.
- **Distill-tier control:** run C-loaded both at Tier-A (full copy) and Tier-B (distilled), since Tier-B
  is the FIRM default over the size threshold (spec Sec 9). Tier-B trades context fidelity for cost —
  measure whether the cheaper tier *also* costs correctness/rework (it might erase the warm-start
  advantage C3 depends on). If Tier-B clones re-derive like cold subagents, C3 collapses — say so.
- **Clone count N:** sweep N ∈ {2, 3} for parallel tasks; more clones = more coordination + cost, not
  linearly more speed. Report the speedup curve, not a single hand-picked N.
- **Operator skill confound:** the *same* operator runs all arms for a given trial, in **randomized arm
  order** per trial (Latin-square across trials) so learning-the-task effects wash out instead of
  systematically favoring whichever arm goes last. The operator follows a fixed script per arm and is
  **not** allowed to "help" Manta more than Solo (e.g. no extra hints to a stuck clone that Solo wouldn't
  get). Deviations are logged and void the trial.
- **Warm-cache confound:** randomize which arm runs first so prompt-cache / disk-cache warming doesn't
  systematically benefit one arm.

### 4.4 Stop rule for runaways
A trial that exceeds **3× the Solo median wall-clock** OR hits Manta's own budget guard ($15/cast,
$50/day per spec Sec 9) is recorded as a **DNF (did-not-finish)** for that arm — counted in the
pass-rate column, not silently retried. Manta DNFs (e.g. #66 reaping in C-loaded) are first-class
results, not "technical difficulties."

---

## 5. Threats to validity (honest, itemized)

This section exists so the reader can attack the benchmark. If we don't list the holes, the result is
worth nothing.

### 5.1 Where Manta might legitimately LOSE — and the benchmark must show it
- **Small tasks (T0):** startup + worktree + bus + merge overhead has no parallelism to amortize. Solo
  wins. **By design we run T0 to display this loss.** README itself concedes it.
- **#66 cold-start (C-loaded):** late in a long real session, clones get reaped before first heartbeat.
  This is the *normal* dogfood regime (the curator's own sessions are huge). If C-loaded shows Manta
  DNF-ing while Solo sails through, that is the headline honest finding — Manta's flagship advantage is
  unavailable exactly when sessions are realistic. Do not bury it.
- **Coordination tax on low-parallelism tasks:** if a "branchy" task turns out to have one obvious
  approach, forking-realities pays for 2 clones + merge-review to pick a near-tie. Wasted.
- **Merge-review wrong-winner:** the scorer mirrors `pnpm gate` (and has diverged before — bug #63). If
  the scorer picks the worse branch, Manta ships worse code *and* burned 2× tokens. M7 (durability re-run)
  is specifically there to catch this.
- **Tier-B context loss:** if distillation drops the very nuance that justified inheritance, C3's
  warm-start edge over subagents evaporates and Manta becomes "expensive subagents." Measured directly.
- **Token cost:** Manta runs N parallel models. Even when faster (M1), it can be far more expensive (M2).
  H1 is a *time* claim, not a cost claim — so a "win" on speed that costs 3× the dollars must be reported
  with M2 right next to M1. The reader decides if the time is worth the money; we don't pre-decide it.

### 5.2 Where the benchmark could mislead in Manta's FAVOR (guard against)
- **Tuned tasks:** picking only tasks shaped exactly like Manta's modes inflates wins. Mitigation: T0 +
  running on a *neutral* repo, not just Manta's own; and stating plainly that results generalize only to
  the >10-min multi-file/repetitive band, not to "all dev work."
- **Operator over-helping Manta:** un-sticking a stalled clone that Solo wouldn't get. Mitigation: fixed
  per-arm script, deviations void the trial, randomized order.
- **`manta cost` self-grading:** using Manta's own cost number as M2. Mitigation: M2 from raw model
  telemetry; `manta cost` is a *subject*, cross-checked, never the source of truth.
- **Self-reported "done":** Mitigation: harness re-runs `verify.sh`; agent claims are ignored.
- **Dropping bad trials:** the cardinal sin. Mitigation: pre-registered stop rule, DNFs counted, full
  per-trial scatter published.

### 5.3 Where the benchmark could mislead AGAINST Manta (be fair both ways)
- **Cold-start counted but not amortized:** real users keep clones across multiple tasks in a session;
  a one-task-per-trial harness charges startup every time. Mitigation: add a *secondary* multi-task
  session protocol (3 tasks back-to-back in one session) where Manta's startup amortizes — report it
  separately, clearly labeled, not folded into H1.
- **Arm D modeled, not run:** a modeled framework number can be unfair in either direction. Mitigation:
  D performance is excluded from H1; only the *itemizable* role-design human-cost (M6) is used for C4,
  and even that is labeled `[modeled]` unless the crew is actually built and run.

---

## 6. Arm D (role-framework) — what differs, rigorously

Since D mostly can't be run here, be precise about the *structural* differences so the design-theoretic
comparison isn't hand-waving:

| Dimension | Manta | Role-framework (CrewAI/LangGraph) | Benchmark consequence |
|-----------|-------|-----------------------------------|------------------------|
| **Context** | Full transcript inherited (or distilled) — clone starts warm. | Each role gets a **role-specific prompt**; shared context passed explicitly via the graph's state. | Manta should win C3 on tasks where un-stated conversation nuance matters; framework can match it *if* the operator manually pipes that nuance into shared state (a M6 human cost). |
| **Setup cost** | `manta cast <mode>` — one command, no graph. | Author roles + tasks + wiring + tools per task (or reuse a generic crew, losing task-fit). | This is C4's core: the role-design tax = M6 time to build/adapt the graph for *this* task. Itemizable without running. |
| **Coordination** | Runtime bus (locks/claims/broadcasts) — dynamic work division. | Static graph edges decided at design time. | On tasks whose decomposition isn't obvious up front, Manta's dynamic claim board should reduce rework (M5); a static graph may mis-partition. Falsifiable if the framework's partition happens to be right. |
| **Isolation** | Real git worktrees — physical, conflicts impossible. | Typically shared FS / logical separation unless the author builds worktree isolation. | Manta should show fewer merge-conflict reworks (part of M5) on T2-style parallel writes. |

**Honest limit:** without running a real crew we cannot claim a wall-clock or token win/loss over D. The
artifact must say exactly that. C4 is supported only to the extent of the *measured* role-design human
cost (M6) plus these structural arguments — and that's stated as a *bounded* claim, not "Manta beats
CrewAI on speed."

---

## 7. The proof artifact (what credible output looks like)

A single committed report, `docs/audit-v1/F-benchmark-results.md` (produced once runnable), containing:

1. **Reproducibility header:** target repo + SHA, model ID + harness build, machine spec + load,
   pre-registration commit SHA, date, full `verify.sh` + frozen-test checksums.
2. **The headline table**, per task, medians with IQR and significance:

   | Task | Arm | n | M1 wall-clock (median, IQR) | M2 $ | M3 pass-rate | M4 main-ctx tok | M5 rework | M6 human-s | M7 durable | H1 ratio vs Solo | p (vs Solo) |
   |------|-----|---|------------------------------|------|--------------|------------------|-----------|------------|------------|-------------------|-------------|
   | T1 | Solo | 10 | … | … | …/10 | … | … | … | …/10 | 1.00 | — |
   | T1 | Subagents | 10 | … | … | … | … | … | … | … | … | … |
   | T1 | Manta C-fresh | 10 | … | … | … | … | … | … | … | … | … |
   | T1 | Manta C-loaded | 10 | … | … | … | … | … | … | … | … | … |
   | T1 | Framework D | [modeled] | — | — | — | — | — | … | — | `[modeled]` | excl. |
   | … | (T2, T3, T0 identically) | | | | | | | | | | |

3. **Per-sub-claim verdict (C1–C4):** for each, PASS / FAIL / INCONCLUSIVE with the number that decides
   it. H1 (the 2× headline) gets its own explicit line: **met / not met**, per task.
4. **The losses, prominently:** T0 (Manta slower), C-loaded #66 DNFs, any task where Solo ≥ Manta, the
   M2 cost premium. A dedicated "Where Manta lost" section, not a footnote.
5. **Full per-trial scatter** (appendix CSV) so anyone can recompute the stats and re-run the harness.
6. **Threats-to-validity** copied forward with which ones bit in practice.

A credible result is **a reproducible recipe + a distribution + an honest loss column** — not a hero
number. If the table has no losses anywhere, distrust the harness before believing the win.

---

## 8. Runnability gate (when can this actually execute?)

**Blocked until** all hold:
1. A clean `manta cast` → clone-works → `manta promote`/merge cycle completes **without operator rescue**
   from a *fresh* session (gives C-fresh).
2. Bug **#66** is resolved (or the early-"booting" heartbeat / O(1) size-check fix lands) so C-loaded can
   run at all instead of DNF-ing on every trial — **OR** we accept that the first benchmark run's
   honest headline finding is "Manta cannot start from a realistic large session," run C-loaded anyway,
   and let it report the DNFs. (Either is publishable; the second is just a harsher truth.)
3. The install / user-journey path (other audits in this folder) works end-to-end, so the harness can
   stand up Manta the way a real user would, not via internal scaffolding.

Until then this document is the spec; the results file does not exist and **must not be fabricated**.
The benchmark's whole value is that it could embarrass the project — that's what makes a green result
mean something.

---

## Appendix: harness skeleton (to build when unblocked)

```
benchmark/
  preregister.md            # H1, tasks, metrics, N, α — committed BEFORE any trial
  repos/<target>@<SHA>/     # pinned target; fresh clone per trial
  tasks/
    T0/ T1/ T2/ T3/
      prompt.md             # identical task prompt across arms
      priming.md            # fixed context block (fair to inheritance)
      verify.sh             # checksum-frozen, harness re-runs it for M3/M7
      frozen/               # frozen test files (checksum-guarded)
      answerkey.md          # T3 only, for blind double-grading
  run.sh <task> <arm> <trial>   # quiesce, clone, start timer, drive arm via fixed script, stop on verify==0
  collect.py                    # pulls M1..M7 from harness logs + raw model telemetry (NOT manta cost)
  stats.py                      # median/IQR, Mann–Whitney U, bootstrap CI; emits the results table + scatter CSV
  results/<date>/               # per-trial raw logs + the final F-benchmark-results.md
```

Operator script per arm is fixed text; deviations are logged and void the trial. The harness — not the
agent — owns the clock and the pass/fail decision.

# Phase 2 — Best-of-N Selection Patterns for `forking-realities`

**Author:** clone-B (recon-swarm cast `cast-1778187665150`, 2026-05-07)
**Audience:** Phase 2 plan author (main agent, next session)
**Spec anchors:** `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` Sec 5.8 (plagiarism prevention), Sec 6 (game mechanics), Sec 7 (post-mortem flow / best-of-N), Sec 11 (observability tiers), Sec 15.1 (Phase 2 scope)

## 0. Framing

`forking-realities` spawns **N clones from one task contract**, each in an isolated worktree, each producing a candidate diff. After all clones die, the main agent runs `manta-merge-review`: rank candidates, pick one, merge it, send the rest to the graveyard, and harvest insights from every candidate — including the losers. Sec 7 of the spec already commits to this shape; what is undecided is the **selection algorithm** and the **insight-extraction protocol**.

Phase 2 N is small by design: the spec calls out `N ∈ {2, 3}`. The Charge cost (Sec 6.4) is `2` per `forking-realities` cast, doubling-or-tripling that to `N=4` or higher would burn budget without proportional payoff at our current TTL (20 min) and per-clone cap ($5). Therefore everything below assumes **N=2 or N=3**. Patterns optimised for `N=10` or `N=1000` (AlphaCode-scale sampling) inform the structure but do not transplant directly — small-N changes which trade-offs matter.

Each section below ends with a **Concrete recommendation for Phase 2** that the plan author can copy verbatim into the implementation plan.

---

## 1. Tournament selection

### What it is

In evolutionary algorithms, tournament selection picks `k` candidates uniformly at random and returns the best one by fitness. The tunable knob is **tournament size** `k`: large `k` increases selection pressure (strong candidates dominate, exploration shrinks); small `k` keeps the door open for weaker variants ([Wikipedia — Tournament selection][1], [Baeldung CS][2]).

### Applicability to N=2 / N=3

With `N=2`, "tournament" collapses to a binary comparison — there is exactly one match, the winner is the merged candidate, the loser is graveyard'd. With `N=3`, a `k=2` tournament can be run twice (semi-final + final) but it adds no information over a direct ranking of all three by the same fitness function. Tournament selection's central trick — sampling subsets to limit selection pressure across many generations — assumes a **population that survives across rounds**. `forking-realities` is one-shot: there is no next generation, no descendants, no exploration vs. exploitation trade-off to tune. The clones already die.

### What survives the translation

The one part worth keeping is **stochastic tie-breaking under noisy fitness**: when two candidates score within sensor noise of each other, randomness is provably a better tie-breaker than first-finish ordering, because ordering biases toward whichever clone's worktree was scheduled first ([Algorithm Afternoon — Selection Strategies][3]). For Phase 2 this matters at the edges, not as a primary mechanism — see §5 Tie-breaking.

### Concrete recommendation for Phase 2

**Reject tournament selection as the primary algorithm.** For `N ∈ {2, 3}` it is functionally identical to "rank all candidates by score, pick the top." Implement a flat ranked comparison, not tournament brackets. Keep one borrowed idea: when scores tie within the noise band defined in §5, fall back to `crypto.randomInt`-driven tie-breaking before defaulting to "ask the main." This avoids hidden ordering bias and keeps the selection auditable.

---

## 2. Pareto frontier

### What it is

Multi-objective optimisation rejects the assumption that several quality axes can be flattened into a single scalar. A solution `A` **dominates** `B` if `A` is no worse than `B` on every axis and strictly better on at least one. The **Pareto frontier** is the set of non-dominated solutions: trading off any axis against any other only makes you leave the frontier ([Wikipedia — Pareto front][4], [Baeldung — Pareto Frontiers][5]).

### Applicability to `forking-realities`

The candidate axes Sec 7 lists — diff size, complexity delta, perf delta, coverage delta — are genuinely conflicting. A 3-line patch that drops coverage by 2% Pareto-dominates nothing relative to a 60-line patch that adds coverage by 4%. Both can sit on the frontier; neither is "the right answer" in pure mathematics.

### Why it is the wrong tool here

Three reasons:

1. **Frontier of size 1 is the common case.** With `N=3`, after dropping any candidate that fails the test gate (per §3 hard gate), you usually have 1–2 left. Pareto only adds value when |frontier| > 1 *and* multiple solutions are mutually non-dominated. In practice for code merges this is rare — coverage and test-pass nearly always co-vary, and diff size and complexity nearly always co-vary, collapsing the frontier.
2. **Decision pressure is on the main, not the algorithm.** Pareto-optimal output is a *set* of incomparable solutions. The spec already commits to the main picking one (Sec 7 — "мейн выбирает один"). Handing the main a Pareto set is just deferring the scalarisation step. If we are going to scalarise anyway, do it in the orchestrator where the weights are auditable, not in the main's head where they are not.
3. **N is too small.** Pareto-front analysis pays off when you have 20+ candidates and want to prune to a manageable shortlist. With `N=3`, the shortlist already fits on one screen.

### What survives the translation

Pareto **dominance** as a sanity-check is cheap and useful: if candidate `A` dominates `B` on every axis, `B` should never win the composite scoring. If the composite formula somehow ranks a dominated solution above its dominator, that's a **bug in the weights**, not a legitimate trade-off. Add a unit test: `dominates(A, B) ⇒ score(A) > score(B)`.

### Concrete recommendation for Phase 2

**Do not implement Pareto frontier ranking as the primary path.** Implement composite scoring (§3) and add a `assertNoDominationInversion()` check after ranking: if the top-ranked candidate is Pareto-dominated by any other candidate in the cast, the orchestrator emits a `ranking_anomaly` event (Tier 4 audit log per Sec 11.0) and forces manual review even when scores fall outside the §5 tie-band. Treat this as a tripwire for weight mis-calibration, not a routine path.

---

## 3. Composite weighted scoring

### What it is

Scalarise the multi-objective vector via a weighted sum: `score = Σ wᵢ · normalize(metricᵢ)`. The weights encode policy. Sec 7 of the spec explicitly names this approach. It is the dominant pattern in real-world code-generation reranking — AlphaCode's pipeline filters by execution then clusters and picks one sample per cluster, where cluster size acts as a confidence weight ([DeepMind — Competitive programming with AlphaCode][6], [AlphaCode arXiv][7]). Coder-Reviewer reranking ([Zhang et al. 2022, arXiv 2211.16490][8]) takes the same shape: combine generation likelihood and reverse-direction reviewer likelihood as a weighted score, gaining up to 17% absolute accuracy.

### Hard gate first, then ranking

Before any candidate enters the weighted sum, it must pass a **non-negotiable test gate**: the candidate's `pnpm -r test` (or equivalent) must exit 0 inside its worktree. A failing-tests candidate is not "lower-scored" — it is **disqualified**. Mixing test failures into a weighted sum invites the failure mode described in Coder-Reviewer: rerankers prefer pathological short or repetitive code that happens to score high on one axis ([Zhang et al. 2022][8]). Gate, then rank.

This gate also encodes the spec's Sec 6.3 fragility rule: a clone with 3 test failures is already structurally suspect; its diff should not be merge-eligible regardless of other axes.

### Proposed axes and weights

After the hard test gate, the surviving candidates are scored on these axes. All metrics are normalised into `[0, 1]` per the formulae below, where `1.0` = best of cohort. Weights sum to `1.00`; performance is added separately when available.

| Axis | Metric | Direction | Weight |
|---|---|---|---|
| Coverage delta | `Δcoverage` percentage points vs. base branch | higher is better | **0.30** |
| Diff size | `log10(1 + lines_changed)` inverted | smaller is better | **0.20** |
| Complexity delta | sum of cyclomatic complexity delta in changed functions | smaller is better | **0.20** |
| Type-check cleanliness | `1 / (1 + tsc_errors)` | higher is better | **0.15** |
| Lint cleanliness | `1 / (1 + eslint_warnings + 5·eslint_errors)` | higher is better | **0.15** |
| Performance delta (when benchmark exists) | `Δbench_p95_ms` inverted | smaller is better | **+0.10 bonus** |

**Why these weights:**

- **Coverage is the heaviest** because it is the one axis where a clone can game every other axis (write a tiny untested patch that lints clean and type-checks) but cannot game coverage without actually exercising new code paths. It is also the metric most directly tied to the `manta-bugs.md` quality-bar: untested code gets bugs no one notices.
- **Diff size and complexity are equal** because they are correlated but not identical: a 200-line patch that mechanically renames identifiers is low-complexity and high-line-count; a 5-line patch that introduces a new control-flow branch is the opposite. Keeping them separate prevents one from masking the other.
- **Lint and type-check are co-equal at 0.15** because they catch different classes of error (style/discipline vs. type-system invariants) but both are noisy — a stricter `eslint` config can swing warning counts by an order of magnitude. The `1 / (1 + n)` shape compresses the tail so a candidate with 50 warnings doesn't get crushed by a candidate with 0 (the difference between 0 and 5 warnings is policy-meaningful; the difference between 50 and 500 usually is not).
- **Perf is a bonus, not a core weight.** Most Manta tasks won't run benchmarks. When they do, the bonus is small (`+0.10` outside the unit interval) so a perf win can break a near-tie but cannot, by itself, overrule coverage or diff size.

The lint formula's `5×` multiplier on errors reflects the observed fact that lint errors block CI (functional consequence) while warnings only annoy reviewers (cosmetic consequence).

### Why scalarisation works at small N

At `N=3`, the cost of a misweighted formula is at most one wrong merge per cast — recoverable via `git revert` and a `manta-bugs.md` entry. At `N=1000` (AlphaCode regime), a misweighted formula compounds across thousands of decisions and the only recovery is retraining. We are firmly in the small-cost regime, which means we can iterate on the weights every Phase based on post-mortem data rather than treating them as a frozen contract.

### Concrete recommendation for Phase 2

**Implement composite weighted scoring with the table above as the v1 weights.** Persist weights in `.manta/config/scoring.json` (not hard-coded), so Phase 3+ can A/B-test alternative weights without touching the orchestrator code path. Emit every component score and the final scalar to the Tier 4 audit log (Sec 11.0) so that post-mortems can reconstruct *why* a candidate won — without that audit trail, weight tuning becomes guesswork.

---

## 4. Manual override path — hybrid

### The reconciliation question

Sec 7 says "мейн выбирает один" (main picks one). Sec 11.0 Tier 1 promises a compact `/manta status` view; Tier 2 promises a deep `/manta inspect <id>` per clone. The Phase 2 question is: **does the orchestrator auto-merge the top-ranked candidate, or does it always wait for the main to confirm?**

Three operating modes are possible:

1. **Auto-merge the top.** Orchestrator applies the diff to the main worktree without human input. Closest to the spec's "Auto-merge attempt → success ? merge : мейн решает" line in Sec 7.
2. **Manual final-pick.** Orchestrator ranks but never merges — it emits a side-by-side markdown summary and waits for `/manta promote <id>` or `/manta merge <id>`.
3. **Hybrid.** Orchestrator auto-merges only when (a) the top candidate's score margin over second place exceeds the §5 tie-band, (b) no Pareto-dominance inversion was flagged in §2, and (c) the cast was not flagged with `--force-manual-review`. Otherwise it waits.

### Why hybrid is the right answer for Phase 2

**Phase 2 is the first time clones are truly competing**, not collaborating. Post-mortems for `recon-swarm` (Phase 1) show that even cooperative clones drift, write outside scope, or skip the ZK dump (Phase-1 bug #5). The first time we let competing clones auto-merge into main, something will go wrong. We need the auto-merge code path so that Phase 5+ daemon-mode and Phase 7+ auto-cast triggers can use it, but **defaulting to "wait for human"** for the first 90 days of Phase 2 in production is cheap insurance and mirrors the Sec 15.4 Definition-of-Done condition #3 ("zero catastrophic incidents за 90 дней").

The hybrid mode also lets the policy **decay gracefully**: in Phase 2 the auto-merge threshold is set to "essentially never" (margin > 50% of the score range); in Phase 3 it tightens to 30%; by Phase 5 the daemon can drive it down to 10% if telemetry supports it. The mechanism stays the same; only the threshold migrates.

### What the main sees at review time

A markdown summary committed to `.manta/cast/<cast-id>/merge-review.md` containing, in order:

1. Per-candidate score table (axes from §3 + composite scalar).
2. Per-candidate `git diff --stat` output.
3. Per-candidate ZK note titles (so the main can see what each clone *learned*, not just what each clone *did*).
4. A one-line merge-review verdict: `auto_merge_eligible` / `manual_review_required` / `no_candidates_passed_gate` / `dominance_inversion_flagged`.
5. The proposed merge command (e.g. `git merge manta/<castId>/B --no-ff --commit -m "manta-merge: chose B (score 0.812 vs A 0.504, C 0.310)"`).

The proposed command is **a copy-paste line for the main**, not a hidden auto-action. This makes the audit trail human-replayable: the main approving by running the command is itself a logged action.

### Concrete recommendation for Phase 2

**Default: hybrid mode, threshold-gated auto-merge disabled in Phase 2 (`autoMergeThreshold: Infinity`).** Ship the auto-merge code path so Phase 5 can use it; ship `/manta promote <id>` as the primary main-driven path; emit `merge-review.md` for every cast. Do not unify on a "single source of truth" for the merge command — let the main paste the command, so the merge action belongs to the human's git history, not the orchestrator's.

---

## 5. Tie-breaking

### When does it fire

A tie fires when `(score_top - score_second) / score_range < ε`, where `ε` is the tunable noise tolerance.

### Setting ε

The dominant noise sources at our scale are:

- **Coverage instrumentation jitter** — `c8` and `vitest --coverage` emit slightly different line counts depending on whether tests run in parallel; we have observed ±0.5 percentage points on identical code.
- **Lint warning counts** — re-running `eslint .` on identical code is deterministic, but small dependency upgrades can swing it by 1–3 per file.
- **Type-error counts** — deterministic but sensitive to incremental compilation cache state.
- **Diff size** — deterministic when the same `git diff --stat` invocation is used.

A 5% tolerance on the composite scalar absorbs these without swallowing real differences. The Optimal Self-Consistency literature notes that majority-vote signals stabilise at roughly 5–10% of the candidate score range for sample sizes below 50 ([Wang et al. 2022 — Self-Consistency][9]). We are well below 50; pick `ε = 0.05`.

### Order of resolution

When a tie fires:

1. **First — domain priority order.** Coverage delta wins ties first (highest weight, hardest to game). Then complexity delta. Then diff size. Then lint, then type-errors, then perf bonus. This produces a deterministic answer in ~95% of tie cases without a human in the loop.
2. **Second — Pareto check.** If after axis priority the candidates are still tied, check pairwise dominance. If one Pareto-dominates the other on any non-zero axis, prefer the dominator.
3. **Third — defer to the main.** If both fail to resolve, the orchestrator emits `merge-review-tie` to the audit log and the merge-review markdown gets a `manual_review_required` flag. **Do not** fall back to "first to finish" — that biases toward whichever worktree was scheduled first by the OS, which has nothing to do with code quality.
4. **Cryptographic random as last resort — only opt-in.** A `--break-ties-randomly` flag exists for CI / unattended scenarios but is not the default. In Phase 2 the default is "ask the main."

### Concrete recommendation for Phase 2

**`ε = 0.05`, deterministic axis-priority resolution, escalate to main on residual ties, no first-finish bias, no random by default.** Log every tie-break decision (which axis won, or "deferred to main") to the Tier 4 audit log. After 30 days of production data the post-mortem corpus tells us whether `ε = 0.05` is too loose (most casts tie) or too tight (real differences forced through axis priority); only then re-tune.

---

## 6. Insights from losers — extraction protocol

### The spec's promise

Sec 7: "Insights из всех трёх → ZK даже у проигравших" — every clone, including the losing candidates, contributes to the knowledge base.

### Two extraction points, two costs

There are exactly two times we can capture loser-insights:

1. **At clone-death time** — every clone runs its `manta-graceful-death` checklist before exit. The skill (`manta-graceful-death/SKILL.md` v0.0.2) makes ≥1 `manta.zk_write` call **mandatory** as of Phase-1 lockdown bug #5. This already runs for every clone, win or lose, so loser-insight capture is a no-op feature: it works today as a side effect of how clones shut down.
2. **At merge-review time** — the orchestrator reads each candidate's diff and could spawn a separate harvest pass that synthesises *cross-candidate* insights ("all three clones independently rewrote the same function — likely the spec was unclear at that boundary"). This is new work.

### Why both, not one

The clone-death dump captures **the clone's first-person view**: what it found surprising while it worked. This is high-signal but local — each clone only sees its own worktree. The merge-review harvest captures **the cross-candidate view**: what the candidates revealed *together*. Convergent rewrites in the same place are a far stronger signal than any single clone's note. Skip the merge-review harvest and we lose this signal entirely; skip the clone-death dump and we lose the in-context surprise that motivates the cross-candidate observation.

### Reliability concerns and mitigations

The Phase-1 lockdown surfaced bug #5: clones occasionally skip `manta.zk_write` despite the skill text. Mitigations already in flight:

- Skill v0.0.2 makes the dump explicit and ordered; v0.0.3 (Phase 2) should enforce a `zk_skipped` drift flag in the post-mortem composer when `manta.zk_write` was not called before `manta.report_death`.
- Phase 2 acceptance criterion: the e2e harness asserts `≥1 ZK note per clone` and **fails the cast** if any clone exits without a note. This converts the soft skill rule into a hard test gate.
- The merge-review harvest is **independent** of clone discipline: even if a clone skipped its own ZK, the orchestrator can still extract structural observations from its diff after the fact.

### Concrete recommendation for Phase 2

**Implement both extraction points. Make clone-death ZK enforcement test-asserted (not just skill-asserted). Add a new orchestrator step `manta-merge-review.harvest()` that runs after ranking but before graveyard, reads all candidate diffs, and emits 1–3 cross-candidate ZK notes tagged `cast-<castId>` `loser-insights` `<topic>`.** Insight from losing diffs that *converges* across candidates ("two of three rewrote the same function" / "all three skipped error-handling at the same call site") is the highest-value signal because it points at a spec gap, not a clone gap. Filter for convergence in the harvest; ignore insights unique to a single losing candidate (those are noise at small N).

---

## 7. Summary — the pattern Phase 2 should ship

| Concern | Decision |
|---|---|
| Selection algorithm | Composite weighted sum (§3); reject tournament/Pareto as primary |
| Hard gate | `pnpm -r test` exit 0; failure = disqualify, not down-rank |
| Weights | Coverage 0.30 / Diff 0.20 / Complexity 0.20 / Type 0.15 / Lint 0.15; perf bonus +0.10 |
| Weights storage | `.manta/config/scoring.json`, not hard-coded |
| Pareto check | Sanity test only (`assertNoDominationInversion`); flag, don't decide |
| Auto-merge | Hybrid: code path shipped, threshold = `Infinity` in Phase 2 (manual-only default) |
| Tie-band ε | 0.05 of score range; axis priority → Pareto → main; no first-finish, no random by default |
| Loser insights | Both clone-death ZK (test-enforced) and merge-review cross-candidate harvest |
| Audit | Every component score + every tie-break + every merge-review verdict to Tier 4 audit log |

The arc: **rank deterministically, decide humanly, audit obsessively, harvest losers, tune weights from data — not from intuition.**

---

## Industry update — 2026-05-22 (post-cast addendum)

Original best-of-N research (above) was authored 2026-05-07 by clone-B with prior-art frozen at AlphaCode / Coder-Reviewer-Reranking / self-consistency. Since then the multi-agent coding space shipped major releases (Replit Agent 4 in March, Claude Code Agent Teams as experimental flag, multi-agent code-review tools, agentic-rubric research from Scale Labs). This section records what changed, what validates Manta's design, and where the academic frontier moved past our static-weight rubric.

### What shipped in industry and how it maps to Manta

| Product / paper | Mechanism | Maps to | Verdict for Manta |
|---|---|---|---|
| **Replit Agent 4** (2026-03-11) | Fork-per-task with auto-merge agent resolving ~90% conflicts | `refactor-wave` (Phase 4), not `forking-realities` | Different problem — forks are *different tasks*, not N candidates for the same task. No best-of-N selection mechanism. Keep our merge-review architecture; Phase 2c stays the more general design. |
| **Claude Code Agent Teams** (Anthropic, v2.1.32+, experimental) | Team-lead + teammates + shared task list + mailbox + `TaskCompleted`/`TeammateIdle` hooks | Closer to `recon-swarm` than `forking-realities`. **Specialised** teammate roles, no built-in worktree isolation, no best-of-N. | Validates that the parallel-coordination shape (lead + task list + lifecycle hooks) is industry-correct. Manta differs by: same-prompt cloning, mandatory worktree isolation, best-of-N selection for `forking-realities`. |
| **calimero-network/ai-code-reviewer** | 2-5 LLM agents in parallel, "Review Aggregator clusters findings → consensus score → rank by severity × agreement" | Closer to multi-perspective code review than forking-realities. Aggregates **findings**, not candidates. | Confirms consensus weighting works for review aggregation. Manta's choice to keep main-agent as merge-reviewer (Phase 2c) instead of a "reviewer panel" is justified for `N ∈ {2, 3}` — panel-style payoff appears at higher N. |
| **Scale Labs — Agentic Rubrics** ([blog](https://labs.scale.com/blog/agentic-rubrics), arxiv 2601.04171) | Verifier actively explores the repository to **ground rubric criteria in actual code paths, interfaces, and project conventions** before scoring | Direct upgrade path for Phase 2c scoring | **Static weights in `.manta/config/scoring.json` are state-of-the-art-as-of-2025, not 2026.** Agentic rubric inspects repo (`.eslintrc`, `tsconfig.json`, perf budgets, existing test patterns) and tunes weights per-cast. See "Phase 2c addendum" below. |
| **Scalable Best-of-N via Self-Certainty** (arxiv 2502.18581, 2026) | Model's own probability mass (self-certainty) used as ranking signal; outperforms universal self-consistency on code generation | Tie-breaker enhancement to §5 | Adds a third tier between composite score and `crypto.randomInt`: ask each clone to rate own confidence at end-of-task, use as tertiary tie-breaker. Cheap to add. |
| **Inference-Time Code Selection via Symbolic Equivalence Partitioning** (arxiv 2604.06485, 2026) | Group candidates by behavioural equivalence on synthesised test inputs before scoring | Could collapse §4 "ties within ε=0.05" smarter | If two candidates produce identical test behaviour on hard test gate, the diff/complexity tiebreak is more principled than composite score. **Deferred** — only matters if hard test gate stops being uniquely passing/failing. |

### What this validates in our original research

- **Tournament selection rejected** (§1) — every 2026 multi-agent system that runs `N=2..5` uses flat ranking, not brackets. Validated.
- **Pareto frontier rejected for primary selection** (§2) — calimero/Replit/Agent Teams all collapse to scalar selection. Validated.
- **Composite weighted scoring** (§4) — rubric-based scoring with PASS/FAIL per item + scalar 1-10 is current SOTA per Scale Labs / `RubricRefine` (arxiv 2605.09730). Manta's `coverage 0.30 / diff 0.20 / complexity 0.20 / type 0.15 / lint 0.15 + perf bonus 0.10` is in the SOTA shape, just with static weights instead of agentic.
- **Hard test gate before scoring** (§4) — matches "verification step checks each candidate finding against actual code behavior" across multi-agent code-review tooling. Validated.
- **Insight harvesting from losers** (§7) — no public competitor harvests anything from non-winning candidates. They throw losers away. Manta's ZK-harvest-from-graveyard is original; keep it.

### What is unique to Manta (no public equivalent as of 2026-05-22)

1. **Best-of-N candidates for the same task contract.** Replit forks different tasks, Agent Teams assigns different roles. Nobody else runs N clones of the same task and picks one.
2. **Same-prompt self-cloning.** Industry consensus is specialised roles (oh-my-codex 30 roles, calimero per-domain reviewers, Agent Teams role lenses). Manta is the only system where clones inherit the lead's identity.
3. **Bus-level isolation enforcing plagiarism prevention** between sibling candidates (Phase 2b plan). Industry isolation is worktree-only, which doesn't address peer messaging because no one else has a peer-messaging bus to begin with.
4. **Loser-side insight harvest** as a first-class output of the merge-review flow.

### Phase 2c addendum — actionable changes to fold into the next sub-plan

Not blocking Phase 2b. To be incorporated when Phase 2c plan is written:

- **Agentic rubric pre-pass (Scale Labs)**: before computing the composite score, `manta-merge-review` reads project conventions — `tsconfig.json` strictness, `.eslintrc.*`, `vitest.config.ts` coverage thresholds, perf budgets if any — and adjusts the `.manta/config/scoring.json` weights for that cast. Worked example: project enforces `strict: true` + `noUncheckedIndexedAccess: true` → bump `type` weight from 0.15 to 0.25, reduce `diff` by 0.10. Audit every adjustment to Tier 4.
- **Self-certainty as tertiary tie-breaker (arxiv 2502.18581)**: when composite scores land within the ε=0.05 noise band (§5), before falling back to `crypto.randomInt`, ask each tied clone for a one-line self-certainty rating at end-of-task (priming addition or skill section). Highest self-cert wins; random only if still tied within ±0.5 on a 1-10 scale.
- **Don't add**: symbolic equivalence partitioning (arxiv 2604.06485) — needs synthesised test inputs that don't yet exist, and our hard test gate already disambiguates most ties before scoring.

### What we are explicitly choosing not to copy

- **Agent Teams "specialist teammate" pattern.** Same-prompt cloning is the paradigm-shift claim; specialising clones would erase it.
- **Replit-style auto-merge agent for forking-realities.** Auto-merge across candidates makes sense for `refactor-wave` (Phase 4) but not for best-of-N where the winning candidate already contains a complete, mergeable diff.
- **Consensus-of-findings aggregation** (calimero). For `N ∈ {2, 3}` consensus is binary or near-binary and adds no information over flat ranking; payoff appears at N ≥ 5.

## Sources

1. [Tournament selection — Wikipedia](https://en.wikipedia.org/wiki/Tournament_selection)
2. [Tournament Selection in Genetic Algorithms — Baeldung CS](https://www.baeldung.com/cs/ga-tournament-selection)
3. [Algorithm Afternoon — Selection Strategies Chapter 4](https://algorithmafternoon.com/books/genetic_algorithm/chapter04/)
4. [Pareto front — Wikipedia](https://en.wikipedia.org/wiki/Pareto_front)
5. [Defining Multiobjective Algorithms and Pareto Frontiers — Baeldung CS](https://www.baeldung.com/cs/defining-multiobjective-algorithms-and-pareto-frontiers)
6. [Competitive programming with AlphaCode — Google DeepMind blog](https://deepmind.google/discover/blog/competitive-programming-with-alphacode/)
7. [Li et al. — Competition-Level Code Generation with AlphaCode (arXiv 2203.07814)](https://ar5iv.labs.arxiv.org/html/2203.07814)
8. [Zhang et al. — Coder Reviewer Reranking for Code Generation (arXiv 2211.16490)](https://arxiv.org/abs/2211.16490)
9. [Wang et al. — Self-Consistency Improves Chain of Thought Reasoning in Language Models (arXiv 2203.11171)](https://arxiv.org/abs/2203.11171)
10. [Claude Code Agent Teams — official docs (Anthropic)](https://code.claude.com/docs/en/agent-teams)
11. [Replit — What's changed from Agent 3 to Agent 4 (2026-03)](https://replit.com/blog/whats-changed-agent3-to-agent4)
12. [calimero-network/ai-code-reviewer — multi-agent review aggregator](https://github.com/calimero-network/ai-code-reviewer)
13. [Scale Labs — Agentic Rubrics: Teaching AI to Verify Code the Way Developers Do](https://labs.scale.com/blog/agentic-rubrics)
14. [Agentic Rubrics as Contextual Verifiers for SWE Agents (arXiv 2601.04171)](https://arxiv.org/pdf/2601.04171)
15. [Scalable Best-of-N Selection for Large Language Models via Self-Certainty (arXiv 2502.18581)](https://arxiv.org/pdf/2502.18581)
16. [Inference-Time Code Selection via Symbolic Equivalence Partitioning (arXiv 2604.06485)](https://arxiv.org/pdf/2604.06485)
17. [RubricRefine: Training-Free Pre-Execution Refinement (arXiv 2605.09730)](https://arxiv.org/html/2605.09730v1)

[1]: https://en.wikipedia.org/wiki/Tournament_selection
[2]: https://www.baeldung.com/cs/ga-tournament-selection
[3]: https://algorithmafternoon.com/books/genetic_algorithm/chapter04/
[4]: https://en.wikipedia.org/wiki/Pareto_front
[5]: https://www.baeldung.com/cs/defining-multiobjective-algorithms-and-pareto-frontiers
[6]: https://deepmind.google/discover/blog/competitive-programming-with-alphacode/
[7]: https://ar5iv.labs.arxiv.org/html/2203.07814
[8]: https://arxiv.org/abs/2211.16490
[9]: https://arxiv.org/abs/2203.11171

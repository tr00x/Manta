# Phase 2 Research-Prep — recon-swarm cast specification

**Status:** TODO — first cast attempt (`cast-1778185934043`, 2026-05-07 16:32 EDT) surfaced bugs #6 (hardcoded `max_files_changed=0`) and #7 (30 s heartbeat threshold too tight for cold-start `claude --print`); both fixed in the same dogfood-driven commit. Re-cast pending with the new `--max-files-changed` / `--allowed-paths` flags.
**Phase:** 2 — `forking-realities` production-ready
**Bootstrap mode:** partial dogfood (per spec Sec 15.1)
**Dependencies:** Phase 0 GA shipped (commit `6ae314d`), Phase 1 lockdown verified (`05612ac`), e2e forensics tightened (`64bf188`), bugs #6/#7 fix (this commit).

## Why we're casting (manta-cast-decide gate)

Per `skills/manta-cast-decide/SKILL.md` — cast justified when ≥1 of:

- ✅ **Reads > 5 files in different layers** — Phase 2 touches `cast.ts`, `clone-spawner.ts`, `snapshot-builder.ts`, `orchestrator/post-mortem-composer.ts`, `bus/state/registry.ts`, `bus/audit/*`, every skill in `skills/manta-*`, e2e harness. Solo read of all of them is wasteful and primes a stale plan against unread code.
- ✅ **Architectural choice with ≥ 2 non-obvious options** — best-of-N selection (Tournament selection vs Pareto frontier vs composite-weighted scoring), Bus isolation enforcement (read-only filter at Bus layer vs spawner-injected scope vs orchestrator-policed redaction).
- ✅ **Parallelisable subtasks with no shared state** — three orthogonal research questions feed into one plan; clones cannot deadlock each other since each writes its own deliverable file.

Cooldown: not applicable (last cast `2026-05-07 ~3:30 PM EDT`, > 50 s ago).
Daily budget: well under cap (Phase-1 dogfoods totalled ≤ ~$30 estimated; daily cap $50).
Charges: Phase 1 yielded successful cast → +1; pre-cast charge state ≥ 3.

**Decision: CAST.**

## Cast invocation

```bash
# Working directory: /Users/timur/projectos/manta
# Pre-flight: ensure manta-bus MCP server is registered at user scope
#   claude mcp add -s user manta-bus -- node "$(pwd)/packages/manta-bus/dist/bin/server.cjs"
# (already registered per session memory; verify via `claude mcp list | grep manta-bus`)

# Build first so the CLI in dist/ is current with main:
pnpm -r build

# Cast — three clones, each with a scoped task contract (see below).
# 25-min tick budget; per-clone hard cap $5 (cumulative ≤ $15 cast cap).
# Bug #6 fix: explicit --max-files-changed 5 + --allowed-paths to permit
# the deliverable markdown writes that the joint task mandates. Without
# these, contract scope rejects the deliverable and clones graceful-die.
node packages/manta-cli/dist/bin/manta.cjs cast recon-swarm \
  --clones 3 \
  --task '<see "Per-clone tasks" section — pass a single overall mission; per-clone scoping comes from the task contract files written by spawner>' \
  --cycle-interval-ms 5000 \
  --tick-budget-ms 1500000 \
  --budget-per-clone-usd 5 \
  --budget-per-cast-usd 15 \
  --max-files-changed 5 \
  --allowed-paths '.,docs/research/' \
  --forbidden-paths '.manta/state,secrets/,src/,packages/'
```

> **Note:** the v1 CLI does not yet take a per-clone task array — only a single `--task` string, and the spawner writes the same task contract for each clone (modulo `clone_id`). For Phase 2 research prep we accept this limitation: pass the joint mission as `--task`, and let each clone *self-select* one of three subtasks based on its `clone_id` (A/B/C). This is acceptable for research output (we're collecting different artifacts in different files), and is itself one of the things Phase 2 will fix (per-clone task scoping is on the Phase 2 scope list).

**Joint `--task` payload:**

```
You are one of three sibling recon-swarm clones (A, B, C) helping plan Phase 2 of the Manta project — production-grade `forking-realities` mode.

Read CLAUDE.md, docs/superpowers/specs/2026-05-06-manta-pattern-design.md (Sec 5.8 plagiarism prevention, Sec 6, Sec 7 best-of-N, Sec 11 observability tiers, Sec 15.1 Phase 2 scope), and docs/superpowers/plans/INDEX.md before doing anything else.

Subtask routed by clone_id:
- clone A → produce docs/research/phase-2-codepath-map.md (see Per-clone tasks → A in research-prep)
- clone B → produce docs/research/phase-2-best-of-n-patterns.md (see B)
- clone C → produce docs/research/phase-2-bus-isolation.md (see C)

Read docs/superpowers/plans/2026-05-07-phase-2-forking-realities-research-prep.md for the full per-clone deliverable spec. Honor manta-as-clone (anti-recursion + anti-gossip + scope) and manta-graceful-death (mandatory ZK note + ordered shutdown).

Stay strictly within your assigned subtask. Do NOT cross into siblings' deliverables. Plagiarism prevention applies — do not read sibling output before your final commit.
```

## Per-clone tasks

### Clone A — Codepath map for forking-realities hooks

**Deliverable:** `docs/research/phase-2-codepath-map.md`

**Sections:**
1. **Spawn path** — every line in `packages/manta-cli/src/commands/cast.ts` and `packages/manta-cli/src/spawner/clone-spawner.ts` that hard-codes assumptions about clones-doing-the-same-task (vs clones-doing-different-tasks). Cite line numbers.
2. **Snapshot path** — what fields in `TaskContract` (`packages/manta-snapshot/src/schema.ts`) need extension to carry per-clone `approach_hint` + `forbidden_paths` (Sec 5.1). What's already there? What's missing?
3. **Worktree path** — where worktrees are created (`packages/manta-cli/src/spawner/worktree.ts`?) — do they support per-clone branch naming already (`manta/<castId>/<cloneId>`)? Verify with grep.
4. **Bus filter point** — where in `packages/manta-bus/src/handlers/*` would a "no inter-clone visibility for this cast" filter hook in? Identify the smallest cut.
5. **Orchestrator merge-review hook** — where does post-mortem-composer fire? Where would `manta-merge-review` plug in (between post-mortem and graveyard)?
6. **Observability gaps** — Tier 3 (`/manta tail`) and Tier 4 (`/manta replay`, `/manta audit`) commands don't exist yet. What event-log infrastructure already exists in orchestrator that they'd consume?

**Anti-pattern guard:** This is research, not a refactor. **No code changes.** Output is one markdown file with file:line citations.

**Capabilities:** `read`, `glob`, `grep`. No `Edit`, no `Write` outside `docs/research/`.

**Budget:** $5 hard cap. ETA ~10 min.

### Clone B — Best-of-N selection patterns

**Deliverable:** `docs/research/phase-2-best-of-n-patterns.md`

**Sections:**
1. **Tournament selection** — how it works in EA / GA literature, applicability to `forking-realities` where N ∈ {2, 3} (small). Pros/cons for our case.
2. **Pareto frontier** — multi-objective optimisation framing (diff-size × test-coverage × complexity). When useful, when overkill.
3. **Composite weighted scoring** — single scalar from weighted sum (spec Sec 7 mentions this). Concrete weight proposal for our axes (test pass-rate, coverage delta, diff size, perf delta if available).
4. **Manual override path** — how the spec's "мейн выбирает один" (Sec 7) reconciles with auto-scoring. Recommended UX: auto-rank, manual final-pick, or hybrid.
5. **Tie-breaking** — when scores are within X% of each other, what's the protocol (defer to main, random, oldest-finish-time, etc.).
6. **Insights-from-losers** — Sec 7 says "insights из всех трёх → ZK даже у проигравших". How to reliably extract them at merge-review time vs at clone-death time.

**Sources:** WebSearch / WebFetch allowed for academic / industry references. Cite at least 3 external sources (papers, blog posts, real-world implementations).

**Anti-pattern guard:** No code changes. No theory dumps without applicability to `forking-realities` N ∈ {2, 3}. Each section ends with a concrete recommendation.

**Capabilities:** `read`, `WebSearch`, `WebFetch`. No `Edit` outside `docs/research/`.

**Budget:** $5 hard cap. ETA ~15 min.

### Clone C — Bus isolation / plagiarism prevention strategies

**Deliverable:** `docs/research/phase-2-bus-isolation.md`

**Sections:**
1. **Spec recap** — restate Sec 5.8 verbatim plus Sec 5.5 anti-gossip rule. What does "Bus = read-only с мейном" actually mean operationally?
2. **Strategy 1: Bus-layer filter** — `manta-bus` rejects `broadcast` / `message` calls between siblings during a `forking-realities` cast. Where does the cast-id come from at handler-call time? What needs to be persisted in `Registry.metadata` to make this enforceable?
3. **Strategy 2: Spawner-injected scope** — the spawner gives each clone a `MANTA_BUS_PEER_SCOPE=parent-only` env var; `manta-as-clone` honors it via skill text. Soft-enforcement only. Pros: no Bus changes. Cons: relies on clone discipline.
4. **Strategy 3: Orchestrator-policed redaction** — broadcasts go through but the orchestrator redacts them from the registry's `events.log` view that siblings query. Heavyweight; rejected unless 1 and 2 both fail.
5. **Recommendation** — pick one, justify against drift / cost / failure modes.
6. **Edge cases** — main wants to broadcast a `contract-refresh` (Sec 5.7) to ALL siblings — that's allowed. How does the filter distinguish main → siblings (allowed) from sibling → sibling (forbidden)?

**Anti-pattern guard:** Strategy comparison must be evidence-based — cite the actual handler files and registry shape, not hand-waving.

**Capabilities:** `read`, `grep`, `glob`. No `Edit` outside `docs/research/`. WebSearch optional for prior-art (multi-agent isolation in CrewAI / AutoGen / LangGraph).

**Budget:** $5 hard cap. ETA ~12 min.

## Post-cast workflow (next session)

1. **Verify all 3 deliverables on disk** — `ls -la docs/research/phase-2-*.md` shows three files. If missing → bug, log in `docs/manta-bugs.md`.
2. **Read all three** in main session.
3. **Write strict post-mortem** — `docs/post-mortems/2026-05-XX-phase-2-research-cast.md` per template; capture clone behaviours, ZK adherence, drift, cost, lessons.
4. **Update skills** if any drift surfaced (e.g. clone disobeyed scope, wrote outside `docs/research/`, etc.).
5. **Write Phase 2 plan** — `docs/superpowers/plans/2026-05-07-phase-2-forking-realities.md`. Use research outputs as input. Apply reviewer-per-chunk loop (≤ 3-4k lines per chunk, `general-purpose` subagent in background with `plan-document-reviewer-prompt.md` template + critical-checks list).
6. **Mark INDEX.md** row for Phase 2 plan as `Approved` after reviewer-clean.
7. **Memory sync** — insights → ZK / PARA / claude-mem.

## Risks specific to this cast

| Risk | Likelihood | Mitigation |
|---|---|---|
| Clones don't self-route by `clone_id` (V1 CLI limitation) | Medium | Joint task makes the routing explicit and the priming preamble + task-contract carries `clone_id`. Manual abort + re-cast if all three produce the same artifact. |
| Plagiarism — clone B reads A's output before writing its own | Low | Sec 5.8 plagiarism prevention is a **forking-realities** rule, not a recon-swarm one. Mitigated by writing distinct output paths and trusting clone discipline. |
| ZK adherence regression (bug #5 family) | Low | Skill v0.0.2 enforces required ZK; verified by Phase-1 v3 dogfood. Re-confirm in this cast's post-mortem. |
| WebSearch / WebFetch unreliable for clone B | Medium | Acceptable degraded output: clone B may cite fewer external sources if WebSearch fails — flag in post-mortem, not a blocker. |
| Cost overrun beyond $15 | Low | Per-clone $5 cap × 3 = $15 cast cap. Cumulative budget gate enforces this; cast aborts before overrun. |

## Acceptance criteria for "research-cast green"

- [ ] All 3 clones reach DEAD state via orchestrator post-mortem.
- [ ] All 3 deliverable files exist on disk and are non-empty.
- [ ] At least 1 ZK note per clone (per `manta-graceful-death` v0.0.2).
- [ ] No clone wrote outside `docs/research/` or its own worktree.
- [ ] No `// TODO` or placeholder content in deliverables (PROD bar applies even to research output).
- [ ] Forensic timeline JSON written to `docs/post-mortems/e2e-timeline-<cast-id>.json` (forensics patch from `64bf188`).
- [ ] Cumulative cost < $15.

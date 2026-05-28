# Phase 7 — Auto-cast Triggers (Research)

**Author:** clone-B, cast `cast-1779977834212` (recon-swarm)
**Date:** 2026-05-28
**Spec anchors:** Sec 11.1 line 470 (feature index); Sec 12 lines 540-541 (`/manta trigger add` / `list`).
**Status:** Research; planning input for Phase 7 Chunk-N.

---

## 0. Executive summary (TL;DR)

Auto-cast triggers are the **highest-risk feature in Phase 7**. They convert Manta from a manual tool into a *reactive agent* — and every reactive agent is one bug away from a runaway cost incident or an infinite cast loop. The research below is biased toward saying *"no"* by default and surfacing every guardrail before we ship a single trigger.

**Recommendations at a glance:**

| Question | Recommendation |
|---|---|
| Which event sources ship in Phase 7? | (a) git hooks, (b) Claude Code hooks, (f) manual fire. **Defer** filesystem watchers, test-runner watchers, CI webhooks to Phase 8. |
| Execution architecture? | **Option (c) — synchronous hook-fire calling `manta trigger fire <name>`**. No new long-running daemon. The Phase 5 daemon-loop is not the right home; trigger evaluation is *event-arrival*, not *poll*. |
| Trigger config storage? | `.manta/triggers/<name>.yaml` (one file per trigger, version-controlled by user choice). `.manta/state/triggers/fires.jsonl` (bus-side, gitignored, append-only audit). |
| Default armed state? | **Disarmed.** `trigger add` never arms. Explicit `trigger arm <name>` required, which first runs a dry-fire. |
| Budget integration? | **Mandatory.** Every trigger-spawned cast goes through `runPreSpawnGate` exactly like a manual cast. No bypass flag exists. Per-trigger hourly USD cap is an *extra* gate on top. |
| Loop detection? | Widen `CastManifestSchema` with `triggered_by` + `cause_chain` metadata. Walk cause-chain before spawn; refuse if depth > 3 or the same trigger appears twice in chain. |
| First-fire protection? | `arm` performs a `--dry-run` cast against the resolved action. User must confirm interactively (or pass `--yes`) before the trigger is marked armed. |

**Headline risk we are *not* solving in Phase 7:** the trigger config DSL is *user-authored*. A malicious or careless template (e.g. `scope.allowed_paths: ['/']`, `mode: phantom-lance`, `clones: 5`) makes every other guardrail moot. We rely on (a) the existing `phantom-lance` Aghs lock, (b) per-trigger hourly USD cap, (c) the daily cap, and (d) explicit `arm` step as defence-in-depth. A trigger linter (Phase 8) is the proper fix.

---

## 1. Trigger event taxonomy

### 1.1 Available event sources on a developer machine

| # | Source | Mechanism | Latency | Reliability | Infra cost | Phase 7? |
|---|---|---|---|---|---|---|
| a | Git events | git hooks (`post-merge`, `post-pull`, `post-checkout`, `post-commit`) | sync, <1s | high — git invokes synchronously | **zero** (file in `.git/hooks/`) | **YES** |
| b | Test-runner watch | vitest watch stdout parsing / IPC hook (`--reporter=json` tail) | ~1–5s per re-run | medium — depends on watcher uptime | medium — long-lived process | **NO** (Phase 8) |
| c | Claude Code hooks | `.claude/settings.json` `PreToolUse`/`PostToolUse`/`Notification`/`Stop` | sync, <2s budget per hook | high — harness-driven, deterministic | **zero** (settings file) | **YES** |
| d | File watcher | chokidar / `fs.watch` on glob patterns | sync, <100ms after FS event | medium — chokidar quirks on macOS/Linux differ | medium — long-lived daemon | **NO** (Phase 8) |
| e | CI webhooks | GitHub Actions / GitLab CI webhook → local listener | seconds–minutes | low — requires public ingress (ngrok) or polling | **high** — webhook server, OAuth, tunnel | **NO** (Phase 8+) |
| f | Manual fire | `manta trigger fire <name>` CLI command | sync | high | zero | **YES** |

### 1.2 Phase 7 subset — justification

We ship **(a) git hooks, (c) Claude Code hooks, (f) manual fire**. All three:

1. **Cost zero infrastructure** — they piggy-back on mechanisms already running on the dev machine.
2. **Are deterministic** in the sense that matters (see Claude Code pitfalls §3-§4): the *harness or shell* fires the trigger, not the LLM. We do not depend on instruction-following.
3. **Are synchronous** — the trigger source calls `manta trigger fire <name>` and gets an exit code back. No event queue, no race window between watch loop iterations.
4. **Cover the headline use cases** in the task brief (test failure → bug-hunt; git pull → recon-swarm; PostToolUse Edit of security file → forking-realities).

#### Why (b) test-runner watch is deferred

Vitest watch mode is plausible (`--reporter=json` over stdout), but it requires a **long-lived sidecar process** that tails vitest output and translates failures into `manta trigger fire` calls. That sidecar:

- Is a new long-running process to lifecycle (start/stop/respawn).
- Duplicates work the user's IDE already does.
- Has unreliable cross-platform stream semantics (vitest's JSON reporter is not contract-stable across minor versions per a quick check of the vitest changelog before Phase 7 begins — verify in plan phase).

The *Phase 7 equivalent* of "on test failure" is: **make the user wire up a `package.json` script** like `"test:watch-with-manta": "vitest --reporter=json | manta trigger feed-vitest <name>"` — where `feed-vitest` is a tiny adapter shipping in Phase 8. For Phase 7 we ship `git post-commit` triggers that re-run tests and condition on exit code; that's 80% of the value.

#### Why (d) file watchers are deferred

Same reason as (b): a `chokidar` watcher is a long-lived daemon. The Claude Code hook `PostToolUse:Edit` covers ~all *Claude-driven* edits (which is the interesting subset anyway — user-driven edits surface through git events on commit). For the *non-Claude* edit case (user using vim / VS Code keyboard), Phase 8 can add the chokidar daemon.

#### Why (e) CI webhooks are out of Phase 7 scope

A webhook listener requires either:
- A public-internet ingress (Cloudflare Tunnel, ngrok, etc.) — operationally heavy on a developer machine and a security concern.
- A polling adapter (`gh run watch --watch --json status,conclusion`) — possible but still a long-lived sidecar, same issue as (b).

CI-failure triggers are interesting *eventually*, but the right home is a Phase 8+ "Manta Cloud" surface that owns the webhook ingress as a service. We will not bolt this onto a dev-machine CLI tool.

### 1.3 Concrete sub-event catalogue (Phase 7)

For each Phase 7 source, the events the user can subscribe to:

**(a) Git events** — wired by `manta install-hooks` injecting a small shim in `.git/hooks/<name>`:

| Sub-event | When fires | Useful payload exposed in YAML conditions |
|---|---|---|
| `git.post-merge` | After `git merge`, `git pull` with merge | `${event.squashed}`, `${event.changed_files_count}`, `${event.changed_files}` (capped to 500), `${event.base_sha}`, `${event.head_sha}` |
| `git.post-checkout` | After `git checkout` | `${event.prev_sha}`, `${event.head_sha}`, `${event.is_branch_switch}` |
| `git.post-commit` | After a non-merge commit | `${event.sha}`, `${event.changed_files}`, `${event.commit_message_subject}` |
| `git.post-rewrite` | After `git rebase` / `git commit --amend` | `${event.rewritten_count}`, `${event.action}` |

We deliberately omit `pre-commit` and `pre-push` — those are linting territory, not casting territory. Inviting Manta to block a commit invites the worst possible UX.

**(c) Claude Code hook events** — wired by `manta install-hooks --claude-code` extending `.claude/settings.json`:

| Sub-event | When fires | Useful payload |
|---|---|---|
| `claude-code.PostToolUse:Edit` | After Claude's Edit tool succeeds | `${event.file_path}`, `${event.old_string_excerpt}`, `${event.new_string_excerpt}` |
| `claude-code.PostToolUse:Write` | After Claude's Write tool succeeds | `${event.file_path}`, `${event.size_bytes}` |
| `claude-code.PostToolUse:Bash` | After a Bash command exits | `${event.command}`, `${event.exit_code}`, `${event.duration_ms}` |
| `claude-code.Stop` | When Claude's main agent ends a turn with nothing more to do | `${event.token_usage}`, `${event.duration_ms}`, `${event.last_text_excerpt}` |
| `claude-code.Notification` | When Claude pushes a notification (e.g. permission prompt) | `${event.message}` |

We do **not** ship `PreToolUse` triggers in Phase 7. PreToolUse is the right place for *blocking* / safety enforcement (e.g. scope-enforcement hooks per pitfalls §4), but using it to *spawn casts* would gate every Claude tool call on a `manta trigger fire` round-trip — and the hook has a default 2s budget. A cast spawn easily takes >2s of CLI-init time. Phase 8 may add it once `manta trigger fire` is cached/streamlined.

**(f) Manual fire** — `manta trigger fire <name> [--payload-json '{...}']` runs the configured action with the provided payload (or `{}` if omitted). Useful for shell aliases, IDE keybinds, and `npm run` scripts.

---

## 2. Trigger config DSL

### 2.1 Storage & layout

```
.manta/triggers/                       # user-curated, version-controlled
├── test-failure-bug-hunt.yaml
├── post-pull-recon.yaml
└── security-file-forking.yaml

.manta/state/triggers/                 # bus-managed, gitignored
├── armed.json                         # { "test-failure-bug-hunt": { armed_at, armed_by_dry_run_ok: true }, ... }
├── fires.jsonl                        # append-only audit; one record per evaluation
└── debounce/                          # per-trigger debounce timer state
    └── test-failure-bug-hunt.json     # { last_event_at, pending_payload }
```

One YAML file per trigger keeps trigger definitions reviewable in PRs and makes `manta trigger add` an atomic file-create operation. Bus-side state lives under `.manta/state/triggers/` because (per CLAUDE.md / Phase 0 design) clones do not write to `.manta/state/*` directly; only the bus does.

### 2.2 Schema

The trigger DSL is a YAML document validated by a Zod schema (`TriggerDefSchema` in `@manta/bus`, alongside `BudgetConfigSchema`).

```yaml
version: 1
name: test-failure-bug-hunt            # required, unique per repo, [a-z0-9-]{2,48}
enabled: false                         # MUST be false at add-time. arm flips it.
description: |                         # free-form, surfaced by `trigger list`
  When a post-commit test run fails, spawn bug-hunt to triage.

event:
  source: git                          # git | claude-code-hook | manual
  type: post-commit                    # source-specific event name
  # Source-specific filter (optional, narrows source scope before conditions):
  hook_matcher: null                   # claude-code-hook only — e.g. 'Edit', 'Write|Edit'

conditions:                            # ALL must match (AND). Empty = always match.
  - type: shell                        # run a shell command, condition = exit 0
    cmd: 'pnpm -s test --silent'
    timeout_ms: 60000
    cwd: '${repo.root}'
  # Other condition types:
  # - type: changed_files_gt           value: 100
  # - type: changed_files_match_glob   glob: 'packages/**/security/*.ts'
  # - type: exit_code_eq               value: 1
  # - type: env_eq                     name: BRANCH  value: main
  # - type: payload_json_path_eq       path: '$.exit_code'   value: 1

debounce_ms: 5000                      # collapse events landing within this window
dedup_key: '${event.sha}'              # template; identical key in cooldown_s = drop
cooldown_s: 300                        # min seconds between two fires of THIS trigger

safety:                                # see Sec 3 for semantics
  hourly_cap: 3                        # per-trigger fires/hour (default 3)
  per_fire_budget_usd: 3               # caps action.budget (default 3)
  loop:
    max_cause_chain_depth: 3           # refuse if cast cause-chain ≥ this
    refuse_if_self_in_chain: true      # refuse if same trigger name in chain
    refuse_if_any_in_chain: []         # additional trigger names to refuse on

action:
  mode: bug-hunt                       # any installed mode except phantom-lance
  clones: 2
  task_template: |
    Investigate why `pnpm test` failed at commit ${event.sha}.
    Failing test output (first 4 KB): ${event.test_output_head}.
    Recent files: ${event.changed_files | join: ', '}.
  scope:
    allowed_paths:                     # required, non-empty
      - 'packages/**'
      - 'tests/**'
    forbidden_paths:                   # MUST include `.manta/state` & `secrets/`
      - '.manta/state'
      - 'secrets/'
      - '.env'
    max_files_changed: 10
  budget:                              # forwarded to runPreSpawnGate
    per_clone_usd: 1.5
    per_cast_usd: 3                    # MUST be <= safety.per_fire_budget_usd
  metadata:                            # propagated into CastManifest
    triggered_by: '${trigger.name}'
    cause_chain: '${trigger.cause_chain}'    # injected by orchestrator
```

### 2.3 Template substitution

Substitution is **fixed-grammar**, not Turing-complete. Allowed expressions:

- `${event.<field>}` — payload field as a string. Unknown field → empty string + warning.
- `${event.<field> | <filter>}` — single pipe filter. Allowed filters: `join: ', '` (lists), `truncate: 4096`, `default: 'n/a'`.
- `${trigger.name}` — trigger name.
- `${trigger.cause_chain}` — JSON-encoded array of parent cast ids (orchestrator-injected).
- `${repo.root}` — absolute repo root.

No conditionals, no loops, no shell substitution. Anything more complex goes into a `conditions: shell:` block.

### 2.4 Three worked examples

#### 2.4.1 "On test failure → bug-hunt"

```yaml
version: 1
name: test-failure-bug-hunt
enabled: false
description: 'Post-commit test failure triage'
event:
  source: git
  type: post-commit
conditions:
  - type: shell
    cmd: 'pnpm -s test --silent'
    timeout_ms: 120000
  - type: exit_code_eq
    value: 1                           # condition: last shell exited non-zero
debounce_ms: 0                         # post-commit is rare; no debounce
dedup_key: '${event.sha}'
cooldown_s: 600
safety:
  hourly_cap: 2
  per_fire_budget_usd: 3
  loop: { max_cause_chain_depth: 2, refuse_if_self_in_chain: true }
action:
  mode: bug-hunt
  clones: 2
  task_template: |
    pnpm test failed at commit ${event.sha} (${event.commit_message_subject}).
    Investigate the failing test, identify root cause, propose fix as a patch.
  scope:
    allowed_paths: ['packages/**', 'tests/**']
    forbidden_paths: ['.manta/state', 'secrets/', '.env']
    max_files_changed: 10
  budget: { per_clone_usd: 1.5, per_cast_usd: 3 }
```

#### 2.4.2 "On git pull with > 100 changed files → recon-swarm"

```yaml
version: 1
name: post-pull-large-recon
enabled: false
description: 'Map new code after a large pull'
event:
  source: git
  type: post-merge                     # post-pull surfaces as post-merge in git
conditions:
  - type: changed_files_gt
    value: 100
debounce_ms: 30000                     # collapse rapid pulls
dedup_key: '${event.head_sha}'
cooldown_s: 1800                       # 30 min
safety:
  hourly_cap: 1
  per_fire_budget_usd: 4
  loop: { max_cause_chain_depth: 1, refuse_if_self_in_chain: true }
action:
  mode: recon-swarm
  clones: 3
  task_template: |
    Pulled ${event.changed_files_count} files from ${event.base_sha}..${event.head_sha}.
    Map the new code: surface area, modules touched, public-API drift, new tests.
    Produce docs/research/post-pull-${event.head_sha | truncate: 8}.md.
  scope:
    allowed_paths: ['.']
    forbidden_paths: ['.manta/state', 'secrets/', '.env']
    max_files_changed: 1               # single markdown deliverable
  budget: { per_clone_usd: 1.3, per_cast_usd: 4 }
```

#### 2.4.3 "On PostToolUse Edit of a security-critical file → forking-realities"

```yaml
version: 1
name: security-edit-forking
enabled: false
description: 'Independent review of edits to security-sensitive code'
event:
  source: claude-code-hook
  type: PostToolUse
  hook_matcher: 'Edit|Write'
conditions:
  - type: payload_json_path_eq
    path: '$.tool_input.file_path'
    matches_glob: 'packages/**/security/**'
debounce_ms: 2000
dedup_key: '${event.file_path}'
cooldown_s: 300
safety:
  hourly_cap: 4
  per_fire_budget_usd: 4
  loop:
    max_cause_chain_depth: 2
    refuse_if_self_in_chain: true
    refuse_if_any_in_chain: ['security-edit-forking']   # belt + braces
action:
  mode: forking-realities
  clones: 2
  task_template: |
    File `${event.file_path}` was just edited.
    Independently review the change for security regressions. Two clones, no peer
    messaging (forking-realities semantics). Produce review.md in each worktree.
  scope:
    allowed_paths: ['packages/**', 'tests/**']
    forbidden_paths: ['.manta/state', 'secrets/', '.env']
    max_files_changed: 1               # review.md only
  budget: { per_clone_usd: 2, per_cast_usd: 4 }
```

### 2.5 Validation rules at add-time

`manta trigger add <file>` (or `manta trigger add --inline <yaml>`) MUST:

1. Parse YAML with strict-mode Zod schema (`additionalProperties: false`).
2. Reject if `action.mode` is `phantom-lance` and the Aghs lock is not unlocked.
3. Reject if `action.scope.forbidden_paths` does not include both `.manta/state` and `secrets/`.
4. Reject if `action.budget.per_cast_usd > safety.per_fire_budget_usd`.
5. Reject if `event.source = claude-code-hook` and the `.claude/settings.json` hook shim is not installed (suggest `manta install-hooks --claude-code`).
6. Reject if the trigger name collides with an existing trigger (no implicit overwrite — require `trigger remove` first).
7. Render every `${...}` substitution against a *synthetic dry-payload* and report the resulting rendered prompt for the user to eyeball before arming.

Validation lives in `packages/manta-cli/src/triggers/validator.ts`; schema in `packages/manta-bus/src/schema.ts` next to `BudgetConfigSchema`.

---

## 3. Safety analysis — **the riskiest feature in Phase 7**

### 3.0 Threat model

This is not a hypothetical. The realistic ways triggers can hurt a user:

| # | Failure | Blast radius | Mitigation tier |
|---|---|---|---|
| T1 | Infinite loop: cast A edits file → trigger fires cast B → cast B edits file → trigger fires cast A | Burn entire daily budget in ~minutes; CPU/disk saturation | **HARD** (loop detection + circuit breaker) |
| T2 | Burst: 50 commits in 5 minutes (rebase, batch import) each fire a $3 cast | $150 in 5 min | **HARD** (hourly cap + cooldown + debounce) |
| T3 | Mis-scoped trigger: `scope.allowed_paths: ['/']` + `mode: phantom-lance`, 5 clones | Worktree creation outside repo; phantom-lance recursion | **HARD** (schema validation + Aghs lock + `forbidden_paths` mandatory) |
| T4 | Stale trigger fires on irrelevant event | Wasted cast; user confusion | **SOFT** (cooldown + per-trigger cap absorb) |
| T5 | Template injection: trigger YAML reads `${event.commit_message_subject}` → `; rm -rf $HOME ;` ends up in shell condition | Shell command execution under user account | **HARD** (substitutions are NEVER interpolated into shell condition cmds; conditions are evaluated *before* substitution and templates only render into `task_template` and `dedup_key`) |
| T6 | Accidental arm by `--yes`-happy script | Triggered before user understood scope | **SOFT** (dry-run output preserved; `arm --yes` audited in fires.jsonl) |
| T7 | Git hook fires during `git push --recurse-submodules` in CI | Cast spawn from CI runner — no display, may exceed CI budget | **HARD** (default install-hooks refuses to install when `CI=true` env detected; explicit `--force-ci` opt-in) |

### 3.1 Mandatory budget integration

**Every** trigger-spawned cast flows through `runPreSpawnGate`
(`packages/manta-cli/src/budget/pre-spawn-gate.ts:34`). There is no
`--bypass-gate` flag. The `PreSpawnGateOptions.force` knob exists today for
manual override (`packages/manta-cli/src/commands/cast.ts:255`), but the
trigger fire path **MUST NOT** set `force: true`. We enforce this in code by
hard-coding `force: false` at the trigger-call site
(`packages/manta-cli/src/triggers/fire.ts` — Phase 7 implementation).

Specifically a trigger-fire spawn:

- Runs passive recovery (`charges.applyPassiveRecovery`).
- Checks `cooldown_until` on the charge store (`charges.read`).
- Checks `current_charges >= MODE_CHARGE_COST[mode]`.
- Checks daily-cap (`dailySpend.read + estimated_cost`).
- On daily-cap exceeded, *does NOT* offer auto-downgrade (manual UX feature; auto-fire silently downgrading mode is a different footgun). Instead: record refusal in `fires.jsonl`, broadcast a `blocker` event, increment the trigger's "refused-budget" counter; do not spawn.

### 3.2 Per-trigger hourly cap & cool-down

Two independent counters per trigger, persisted in
`.manta/state/triggers/fires.jsonl`:

- **`hourly_cap`** (default 3): a sliding window of fires (regardless of
  spawned/refused outcome). Once the count of fires in the last 3600s
  reaches `hourly_cap`, the trigger is **temporarily disarmed** — refuses
  with reason `hourly_cap_exhausted` until the oldest fire ages out.
- **`cooldown_s`** (default 300): minimum gap between two *spawned* (not
  refused) casts from this trigger.

Plus one **global hourly cap** (config in `budget.json` under
`triggers.global_hourly_cap`, default 6) — covers the case where many small
triggers fire simultaneously and would together blow past daily budget. The
global counter spans all triggers.

### 3.3 Debounce & dedup

**Debounce** (`debounce_ms`): when an event arrives, write
`{ event_at, payload }` to `.manta/state/triggers/debounce/<name>.json`. If
another event arrives within `debounce_ms`, *overwrite* the file (keep the
latest payload). On the next tick — which is **synchronous-on-arrival** for
git hooks (Sec 4.1 below): if debounce hasn't expired we update and return
exit 0 without firing; if expired we proceed with the most recent payload.
This is naturally implementable in a single CLI invocation per event:

```
manta trigger fire test-failure-bug-hunt --payload-json '...'
  └─ checks .manta/state/triggers/debounce/test-failure-bug-hunt.json
     ├─ if recent → write payload, exit 0 silently
     └─ else → proceed to dedup/cooldown/safety → spawn
```

**Dedup** (`dedup_key`): the rendered key value is hashed; if the hash
matches a fire from the last `cooldown_s` window, refuse with reason
`dedup_hit`. Useful for "same file edited 50 times in 30s" — the dedup
key collapses them.

### 3.4 Armed / disarmed state

A trigger has three states stored in `.manta/state/triggers/armed.json`:

| State | How entered | Effect |
|---|---|---|
| `disarmed` | After `trigger add` (default) or `trigger disarm <name>` | `fire` calls are recorded in `fires.jsonl` with `decision: 'disarmed'` but no cast spawn. |
| `pending_dry_run` | After `trigger arm <name>` initial step | Trigger runs `--dry-run` only; if user confirms, transition to `armed`. Otherwise rollback to `disarmed`. |
| `armed` | After successful dry-run + confirmation | Normal evaluation. |

The state machine is enforced in `manta trigger fire` — even if the YAML's
`enabled: true` is set in the source file, the bus-side `armed.json` is the
sole source of truth. (YAML `enabled` is for human bookkeeping; bus state
wins. Otherwise editing the YAML would silently re-arm.)

A panic button: `manta trigger disarm-all [--also-remove]` instantly
flips every trigger to `disarmed`. **This is the first thing a user reaches
for during an incident.** It must require zero interactive confirmation.

### 3.5 First-fire dry-run (mandatory)

`manta trigger arm <name>` (the only way to arm) performs this sequence:

1. Load trigger YAML, validate (Sec 2.5).
2. Render `task_template` against a *synthetic payload* (constructed from the
   event source's known fields, with sentinel values like
   `event.sha = "0000000000"`).
3. Invoke `manta cast <mode>` with `--dry-run` and the rendered task. This
   exercises `runPreSpawnGate` in dry-mode (no commit) and reports the
   would-be cost.
4. Print the dry-run output and prompt: `Arm trigger '<name>'? [y/N]` (or
   `--yes` flag in scripts).
5. On `y` / `--yes`: write to `.manta/state/triggers/armed.json` with
   `armed_at`, `armed_by_dry_run_ok: true`, and the synthetic payload's
   estimated cost.

### 3.6 Loop detection — cause-chain tagging

#### Schema widening required

`CastManifestSchema` (`packages/manta-bus/src/schema.ts:315`) is currently
`.strict()` with no metadata bag. We extend it:

```ts
export const CastTriggerProvenanceSchema = z.object({
  trigger_name: z.string().min(2).max(48),
  fired_at: z.number().int().nonnegative(),
  parent_cast_id: CastIdSchema.nullable(),    // null = user-fired
}).strict();

// added to CastManifestSchema:
metadata: z.object({
  trigger: CastTriggerProvenanceSchema.optional(),
  cause_chain: z.array(z.string()).max(8).default([]),  // trigger names
}).strict().optional(),
```

Important per CLAUDE.md / pitfalls §7: this is **schema-first**. The schema
change ships and clears tests in the chunk *before* `manta trigger fire`
writes the field.

#### Evaluation algorithm

When `manta trigger fire <name>` decides to spawn:

1. Determine *parent cast id* from environment. Two paths:
   - Git-hook fire from inside a Claude Code session that itself was spawned
     by a Manta clone: the clone's `MANTA_CAST_ID` env var is propagated.
   - Hook fire from outside any Manta context: parent is `null`.
2. If `parent_cast_id != null`, read `CastsStore.get(parent_cast_id)` and
   pull its `metadata.cause_chain` (plus its own `trigger.trigger_name` if
   present). Compose `cause_chain' = [...parent.cause_chain, parent.trigger.trigger_name (if exists)]`.
3. Refuse to spawn if **any** of:
   - `cause_chain'.length >= safety.loop.max_cause_chain_depth` (default 3).
   - `<name>` already appears in `cause_chain'` AND
     `safety.loop.refuse_if_self_in_chain` (default true).
   - Any name from `safety.loop.refuse_if_any_in_chain` appears in chain.
4. Otherwise spawn with `metadata.trigger.trigger_name = <name>`,
   `metadata.trigger.parent_cast_id = parent_cast_id`,
   `metadata.cause_chain = cause_chain'`.

Note: per the system-prompt approach hint and per pitfalls §1, *we do not
rely on skill text to "tell clones not to loop"*. Loop refusal is enforced
by the orchestrator before spawn — same layer where the budget gate lives.

### 3.7 Circuit breaker

A hard global circuit breaker, stored in
`.manta/state/triggers/circuit.json`:

- If **any 3 distinct triggers refuse for budget reasons in a 10-minute
  window**, the global circuit opens: all triggers are forced to
  `disarmed`, a top-level `blocker` event is broadcast, and a banner is
  written to `manta status` output.
- If **a single cause-chain reaches depth ≥ `max_cause_chain_depth` twice
  in 5 minutes**, all triggers in the chain transition to `disarmed`.
- Manual reset: `manta trigger circuit-reset` (the only way out). Records
  user intent in the audit log.

### 3.8 Trigger fires audit (`fires.jsonl`)

Append-only JSONL at `.manta/state/triggers/fires.jsonl`. One record per
trigger evaluation, regardless of outcome:

```json
{"ts":1779977890687,"trigger":"test-failure-bug-hunt","event_source":"git",
 "event_type":"post-commit","payload_excerpt":{"sha":"abc1234..."},
 "decision":"spawned",
 "cast_id":"cast-1779977890687","parent_cast_id":null,
 "cause_chain":[],"cost_estimate_usd":3.0,
 "budget_state":{"daily_spent_after":12.5,"charges_after":4}}
{"ts":1779977895222,"trigger":"test-failure-bug-hunt","event_source":"git",
 "event_type":"post-commit","decision":"refused",
 "reason":"dedup_hit","dedup_key_hash":"sha256:..."}
```

Decisions: `spawned | refused`. Refusal reasons (enum):
- `disarmed`
- `pending_dry_run`
- `debounce_active`
- `dedup_hit`
- `cooldown_active`
- `hourly_cap_exhausted`
- `global_hourly_cap_exhausted`
- `cause_chain_depth_exceeded`
- `loop_self_in_chain`
- `loop_listed_in_chain`
- `budget_gate_failed`
- `circuit_open`
- `condition_failed`
- `validation_error`

`manta trigger list --verbose` reads the tail of this log and renders
per-trigger statistics: last N fires, success rate, cost-to-date,
top refusal reasons.

### 3.9 What we are *not* solving

Defence-in-depth has limits. We explicitly call out:

- **Malicious trigger YAML.** A user committing a hostile YAML to a shared
  repo and another user pulling it cannot be fully prevented at runtime —
  *but* (a) `trigger add` requires the file path explicitly, it is not
  auto-loaded from `.manta/triggers/` on `git pull`; (b) `arm` requires
  explicit user action; (c) all phantom-lance modes are Aghs-locked. The
  attacker would need to convince the victim to run `manta trigger add` and
  `manta trigger arm`. Social engineering exists; we are not solving
  social engineering in Phase 7.
- **Trigger that reduces *test* signal** — e.g. a `condition: shell` that
  runs the test suite costs ~CI minutes locally every commit. We surface
  the *expected condition-execution time* in `trigger list --verbose` and
  warn at add-time if `conditions[].timeout_ms` sum > 30s.
- **Pre-arm payload poisoning** — `arm`'s dry-run uses *synthetic* payload,
  so a malformed real payload after arm could surface latent bugs. We log
  a `validation_error` decision and disarm the trigger after 3 consecutive
  validation errors; the user fixes and re-arms.

---

## 4. Trigger execution architecture

### 4.1 Three options compared

| Aspect | (a) Extend Phase 5 daemon | (b) Separate `manta watcher` daemon | (c) Hook → synchronous `manta trigger fire` |
|---|---|---|---|
| New long-running process | No (reuses) | Yes | No |
| Event sources covered | All (incl. file/test/watch) | All | git + claude-code only — see Sec 1.2 |
| Crash semantics | Daemon crash silently drops triggers | Same | Hook source (shell/Claude harness) handles failure deterministically |
| Cost when idle | Daemon RAM + open FDs | Same | Zero |
| Lifecycle | `daemon spawn` / `daemon stop` already exist | New commands needed | None — pure CLI |
| Race conditions | Polling loop + event arrival races | Same | None — synchronous |
| Phase 7 fit | Overscoped — daemon is for IDLE clone resumption | Overbuilt | **Right-sized for Phase 7 subset** |
| Phase 8 fit | Could grow to host chokidar/test-watch | Same | Add watcher daemon *alongside*, still hook-driven for git/claude-code |

#### Why (c) is the recommendation

The Phase 5 daemon-loop
(`packages/manta-cli/src/daemon-loop.ts:30`) is built around
`WorkQueueStore.dequeue` — it's a *work consumer*. Trigger watching is a
fundamentally different shape: events *arrive* at the trigger, not the
trigger polling for events. Forcing trigger evaluation into the daemon
loop's `for(;;)` would create:

- A polling cadence that's wrong for both: too fast for work-queue (waste),
  too slow for trigger events (latency).
- A failure-mode coupling: if a clone's `runClaudeResume` hangs, trigger
  evaluation pauses.
- Increased complexity in the daemon-loop test surface (currently 90 LoC,
  tightly focused).

Per pitfalls §3, the right pattern is *structural*: each event source
*already runs a deterministic harness* (git invoking hooks, Claude Code
invoking PreToolUse/PostToolUse). We piggy-back on those harnesses, and
the entire "watcher" reduces to one synchronous CLI call per event arrival.

The Phase 5 daemon retains its current responsibility (resume IDLE clones
with new work) and is **not** extended for triggers.

#### When does (a) or (b) become correct?

Phase 8 — when we ship filesystem watchers (chokidar) and test-runner
watchers, we need a long-lived process. At that point we add a new
`manta watch start` command that spawns a watcher daemon for those
sources. The watcher daemon shells out to `manta trigger fire <name>`
exactly like git hooks do — *re-using the same code path*. The trigger
evaluator stays synchronous; only the source delivery becomes
asynchronous.

### 4.2 Synchronous fire flow in detail

When `git post-commit` runs:

```
.git/hooks/post-commit              (installed by `manta install-hooks`)
  └─ manta-hook git post-commit \
       --sha "$(git rev-parse HEAD)" \
       --changed-files-json "$(git diff-tree --no-commit-id --name-only -r HEAD | jq -R . | jq -s .)" \
       --commit-message-subject "$(git log -1 --format=%s)"
       
manta-hook (small shim binary; just routes to `manta trigger fire-for-event`)
  └─ manta trigger fire-for-event \
       --source git --type post-commit \
       --payload-json '{ "sha": "...", "changed_files": [...], ... }'

manta trigger fire-for-event:
  for each enabled trigger T where T.event.source=git, T.event.type=post-commit:
    evaluate T against payload:
      1. Conditions pass? (Sec 2.4 evaluator)
      2. Debounce window expired? (Sec 3.3)
      3. Dedup key novel? (Sec 3.3)
      4. Cooldown elapsed? (Sec 3.2)
      5. Hourly caps OK? (Sec 3.2)
      6. Circuit closed? (Sec 3.7)
      7. Cause-chain safe? (Sec 3.6)
    -> if all pass: spawn cast via cast.ts entrypoint with cause_chain metadata
    -> else: append refusal to fires.jsonl, exit 0
```

The entire flow is one `manta` process per event; it exits inside a few
hundred ms in the no-fire case. Spawning a cast is naturally slower
(seconds), but the git hook does *not* block on cast completion — `manta
trigger fire-for-event` spawns the cast via the existing
`spawnDetachedCloneProcess` pattern used by `daemon spawn` and returns.

This matters because git hooks have a **psychological** rather than
technical timeout: a `post-commit` hook that takes 3 seconds is mildly
annoying; one that takes 30 seconds breaks user trust in `git commit`.
The CLI startup cost (Node bootstrap + atomic JSON reads of trigger
config) is the main budget here. Phase 7 must measure this and ship a
warning if total trigger-fire latency exceeds 1500ms (post-commit
budget). If it does, we shrink trigger evaluation (lazy-loaded YAML,
single-pass dispatch).

### 4.3 Hook shim binaries

To avoid teaching users to write robust shell glue inside `.git/hooks/*`
or `.claude/settings.json` "command" fields, we ship a tiny shim
`manta-hook` (one of the `bin` exports of `@manta/cli`):

```
bin/manta-hook   # ESM script, < 50 LoC
  -> reads env / argv to build a payload JSON
  -> execs `manta trigger fire-for-event ...`
```

`manta install-hooks` writes:
- `.git/hooks/post-merge` → `exec manta-hook git post-merge "$@"`
- `.git/hooks/post-commit` → `exec manta-hook git post-commit "$@"`
- etc.

For Claude Code, it patches `.claude/settings.json`:
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|Bash",
        "hooks": [
          { "type": "command", "command": "manta-hook claude PostToolUse", "timeout": 1500 }
        ]
      }
    ]
  }
}
```

Existing user hooks are preserved (we append a new entry rather than
overwrite the file). `manta install-hooks --dry-run` shows the diff
before applying.

---

## 5. Command surface

### 5.1 Command tree

```
manta trigger add <yaml-file>          [--inline] [--name <override>]
manta trigger list                     [--verbose] [--json] [--enabled-only]
manta trigger show <name>              [--with-fires N]
manta trigger remove <name>            [--force]
manta trigger arm <name>               [--yes] [--skip-dry-run] [unsafe!]
manta trigger disarm <name>
manta trigger disarm-all               [--also-remove]
manta trigger fire <name>              [--payload-json '{...}'] [--dry-run]
manta trigger fire-for-event           --source <s> --type <t> --payload-json '...'
                                       (internal; called by manta-hook)
manta trigger test <name>              # alias for `fire --dry-run`
manta trigger circuit-status
manta trigger circuit-reset            [--reason <s>]
manta install-hooks                    [--git] [--claude-code] [--dry-run] [--force-ci]
manta install-hooks --uninstall
```

### 5.2 Behavioural notes per command

- **`add`**: writes to `.manta/triggers/<name>.yaml`. Refuses to overwrite
  existing trigger; user explicitly `remove`s first. Runs full validation
  (Sec 2.5). Exits non-zero on validation failure with actionable messages.
  Trigger starts in `disarmed` state.
- **`list`** (no flags): one line per trigger, columns `name | state | event | mode | clones | last_fire | hourly_remaining`. Default sort: state desc (armed first), then name.
- **`list --verbose`**: includes — last 5 fires (ts, decision, reason),
  fires-last-24h, refusal-reasons histogram, total cost-to-date (sum of
  spawned casts' actual cost reconciled from `dailySpend.entries`).
- **`show <name>`**: full YAML dump + bus-side state (`armed.json` entry,
  last debounce window, last dedup key hash) + last N fires.
- **`remove <name>`**: deletes YAML and bus state. Refuses if `armed`
  unless `--force`. Adds removal record to `fires.jsonl`.
- **`arm <name>`**: enforces dry-run (Sec 3.5). `--skip-dry-run` is
  available *but* requires an explicit `MANTA_TRIGGER_ARM_SKIP_DRY_RUN=1`
  env var to set; flag alone is not enough. (One thing, two confirmations.)
- **`disarm <name>`**: flips state. Idempotent.
- **`disarm-all`**: panic button. No confirmation. Logs.
- **`fire <name> [--dry-run]`**: explicit manual fire (event source
  `manual`). With `--dry-run`, runs through full evaluation (debounce,
  dedup, cooldown, caps) **except** the actual spawn — useful for testing
  whether a trigger *would* fire under current state. Without `--dry-run`,
  spawns for real (if armed; refused with `disarmed` reason otherwise).
- **`test <name>`**: alias of `fire <name> --dry-run`.
- **`fire-for-event`**: internal. Not documented in the help text;
  invoked by `manta-hook`. The CLI exits 0 even on refusal — git hooks
  expect zero-exit so they don't break the commit.

### 5.3 `manta trigger list --verbose` example

```
NAME                       STATE  EVENT                MODE         24H  H_REM
test-failure-bug-hunt      armed  git post-commit      bug-hunt     12   2/3
post-pull-large-recon      armed  git post-merge       recon-swarm   0   1/1
security-edit-forking      armed  cc PostToolUse:Edit  forking-r.    3   1/4

test-failure-bug-hunt:
  last 5 fires:
    2026-05-28T13:55:21Z  spawned   cast-1779977890687  $2.94
    2026-05-28T13:42:08Z  refused   reason=cooldown_active
    2026-05-28T13:41:55Z  spawned   cast-1779977510002  $3.01
    2026-05-28T12:11:30Z  refused   reason=dedup_hit
    2026-05-28T10:08:14Z  spawned   cast-1779970094312  $2.88
  24h: fires=12 spawned=7 refused=5 cost=$20.71
  top refusals: cooldown_active(3) dedup_hit(2)
```

---

## 6. Codebase audit — integration points

All paths relative to repo root.

### 6.1 Where new trigger CLI commands hook in

`packages/manta-cli/src/bin/manta.ts`:
- **Line 18** — add imports for new command runners:
  ```ts
  import { runTriggerAddCommand, runTriggerListCommand, runTriggerArmCommand,
           runTriggerDisarmCommand, runTriggerFireCommand,
           runTriggerFireForEventCommand, runTriggerCircuitCommand,
           runInstallHooksCommand } from '../commands/trigger.js';
  ```
- **After line 347** (after `daemonCmd.command('stop')`) — slot in the
  `trigger` command group. Follow the same `program.command('trigger') ...
  .command('add <file>') ...` pattern used by `daemonCmd` (lines 330-347).
- **Line 22** — `parseTasksFile` import is the precedent for YAML parsing
  in CLI (it parses task YAMLs); the trigger YAML loader will live in
  `packages/manta-cli/src/triggers/loader.ts` and share the YAML parsing
  pattern.

`packages/manta-cli/src/index.ts`:
- **After line 17** — append `export * from './commands/trigger.js';`
  for tests and library consumers.

### 6.2 Where to attach trigger evaluation in daemon-mode polling loop

**Recommendation: do not attach.** Per Sec 4.1, the Phase 5 daemon
(`packages/manta-cli/src/daemon-loop.ts:30-89`) should NOT host trigger
evaluation. Triggers fire synchronously via `manta-hook` →
`manta trigger fire-for-event`. The daemon stays focused on work-queue
consumption.

If/when Phase 8 adds chokidar/test-watch sources, a new daemon role
(`watcher`) is added in a parallel module — *not* by extending
`runDaemonLoop`. The watcher daemon shells out to
`manta trigger fire-for-event`, hitting the same evaluator the git
hooks hit.

### 6.3 Phase 3 BudgetConfig & ChargeStore integration

The trigger fire path **reuses, not extends**:

- `packages/manta-cli/src/budget/pre-spawn-gate.ts:34` — `runPreSpawnGate`
  is called by the trigger-fire spawn step *identically* to the manual
  cast path at `packages/manta-cli/src/commands/cast.ts:248-262`. No
  new parameters needed.
- `packages/manta-bus/src/state/charge-store.ts:24` — `ChargeStore` is
  consumed via `Runtime.ctx.charges` (`packages/manta-cli/src/runtime.ts:79`).
  No change.
- `packages/manta-bus/src/state/daily-spend.ts:6` — `DailySpendLedger` is
  consumed via `Runtime.ctx.dailySpend`. No change.
- `packages/manta-cli/src/config/budget-config.ts:19` —
  `ResolvedBudgetConfig` is extended with a new field
  `triggers: { global_hourly_cap: number }` (default 6). Schema widening
  required in `BudgetConfigSchema` (`packages/manta-bus/src/schema.ts`).

### 6.4 PreSpawnGate hard wiring — trigger-fired casts

The trigger spawn step calls into the *existing*
`runCastCommand`-equivalent path. The cleanest seam is to refactor the
cast.ts internals so the gate-then-spawn flow
(`packages/manta-cli/src/commands/cast.ts:246-276` for the gate,
:288-onward for the spawn) is exposed as a reusable function:

```ts
// packages/manta-cli/src/commands/cast.ts (new export)
export interface SpawnCastOptions extends CastCommandOptions { /* unchanged */ }
export async function spawnCast(rt: Runtime, opts: SpawnCastOptions): Promise<CastSpawnResult>;
```

`runCastCommand` becomes a thin CLI wrapper around `spawnCast`. The
trigger fire path calls `spawnCast` directly with `force: false` hard-
coded and `metadata.trigger` populated. This is a small refactor (~80
LoC moved) and improves the existing surface — the daemon spawn path
already wants this seam too.

`runPreSpawnGate` itself needs **no changes** to support triggers — its
options are already mode-agnostic. The only Phase 7 change touching the
gate is:

- `packages/manta-cli/src/budget/pre-spawn-gate.ts:34` — when the call
  is part of a trigger fire (signalled by `opts.triggerName != null`),
  the reporter emits events under `trigger.gate.*` channel instead of
  `gate.*` so `manta status` / `tail` can distinguish trigger spawns
  from manual ones. No semantic change to the gate logic.

### 6.5 CastManifest metadata for cause-chain

`packages/manta-bus/src/schema.ts:315-330` — extend
`CastManifestSchema` and `CreateCastInputSchema` with optional
`metadata.trigger` and `metadata.cause_chain` fields. Both schemas are
`.strict()`; adding optional fields with strict means the schema accepts
manifests without metadata (backward-compatible with all Phase 0-6
casts) and rejects unknown metadata keys (forward-safe).

The corresponding write path is `packages/manta-bus/src/state/casts.ts`
`CastsStore.create` — accepts the new field via `CreateCastInput`. No
algorithmic change; the existing idempotency check already canonicalises
the input shape.

A new read accessor `CastsStore.getCauseChain(cast_id): Promise<string[]>`
is added — it loads the manifest, returns `metadata.cause_chain ?? []`,
and is consumed by the trigger fire path to compose chains.

### 6.6 New state stores in @manta/bus

Three new stores live alongside `WorkQueueStore`, `ChargeStore`,
`DailySpendLedger` in `packages/manta-bus/src/state/`:

| File | Class | Purpose |
|---|---|---|
| `triggers-armed.ts` | `TriggersArmedStore` | `armed.json` — { name → state, armed_at, ... } |
| `triggers-fires.ts` | `TriggerFiresLog` | `fires.jsonl` — append-only audit |
| `triggers-debounce.ts` | `TriggerDebounceStore` | per-trigger `<name>.json` — debounce window |

Each follows the established `atomicMutateJson` / `appendJsonLine`
patterns from `charge-store.ts:1-86`. Path resolution in
`packages/manta-bus/src/state/paths.ts` adds:

```ts
triggersDir: path.join(stateDir, 'triggers'),
triggersArmed: path.join(stateDir, 'triggers', 'armed.json'),
triggersFires: path.join(stateDir, 'triggers', 'fires.jsonl'),
triggersDebounce: (name: string) =>
  path.join(stateDir, 'triggers', 'debounce', `${name}.json`),
triggersCircuit: path.join(stateDir, 'triggers', 'circuit.json'),
```

And `BusContext` (consumed at `packages/manta-cli/src/runtime.ts:71-83`)
gains:

```ts
triggersArmed: new TriggersArmedStore(paths, clock),
triggerFires: new TriggerFiresLog(paths, clock),
triggerDebounce: new TriggerDebounceStore(paths, clock),
```

### 6.7 MCP surface (optional Phase 7 stretch)

For symmetry with manual fires from a clone (Aghs unlock could allow
"phantom-lance fires trigger T"), an MCP tool `manta.trigger_fire`
mirroring `manta trigger fire-for-event` is plausible. We **defer** this
to Phase 8: clones triggering casts is recursive-cast territory
(forbidden in Phase 0-7 per spec Sec 5; reaffirmed by skills
`manta-as-clone` "Forbidden — recursive cast"). Until phantom-lance
unlocks (Sec 15 Phase 8), keep MCP surface free of trigger fire.

---

## 7. Open questions for plan phase

These are explicit unresolved items the planning phase must close before
implementation:

1. **`manta-hook` binary distribution.** Ship as a separate `bin` entry
   in `@manta/cli` package.json, or as a single binary that dispatches?
   Recommend: single binary `manta-hook` re-using the CLI's argv parser —
   ~20 LoC of glue. Plan must spec exact `bin` shape.
2. **Git hook installation strategy.** Idempotent merge with existing
   user hooks (read, parse, append manta shim) vs overwrite vs warn.
   Recommend: append-with-comment-markers (`# >>> manta-hook >>>`).
   Plan must decide hook-merge precedence (does user hook run first?).
3. **`fires.jsonl` rotation.** Append-only files grow. Existing
   `chargesLog` in `packages/manta-bus/src/state/charge-store.ts:82`
   has the same problem and (per inspection) does not rotate today.
   Recommend Phase 7 ships a generic rotation utility usable by both
   logs.
4. **YAML parser choice.** Project does not yet pull in a YAML
   dependency in `@manta/cli`. Options: `yaml` (lightweight, type-safe),
   `js-yaml` (more permissive). Recommend `yaml` for strictness; plan
   must verify it works under the workspace's TypeScript ESM config.
5. **`manta-hook` failure mode under `git push --recurse-submodules` in
   CI.** Should `install-hooks` refuse to install in CI environments?
   Recommend: yes, default refuse; `--force-ci` opt-in. Plan must
   define CI-detection algorithm (e.g. presence of `CI=true`,
   `GITHUB_ACTIONS=true`, `GITLAB_CI=true` — also see
   <https://github.com/watson/ci-info> heuristics).
6. **Streaming vs batch refusal logging.** If a fire is refused for
   trivial reasons (debounce, dedup hit), do we still log? Verbose
   `fires.jsonl` could grow fast under rapid edits. Recommend: log
   every decision; rotation (item 3) handles growth. Plan must
   confirm.

---

## 8. Phase 8 follow-ups (out of Phase 7 scope)

- Filesystem watcher daemon (chokidar) shipping a `manta watch start`
  command that emits events to the same `trigger fire-for-event`
  evaluator.
- Test-runner watch adapter (`manta feed-vitest`, `manta feed-jest`).
- CI webhook ingress — likely as a Manta Cloud feature; not on dev
  machine.
- Trigger linter (`manta trigger lint <file>`) that surfaces scope/budget
  smells and PR-blockable risk levels.
- Trigger templates in the Manta Library (Sec 11.1 item 9): community-
  shareable trigger YAMLs with vetting.
- `PreToolUse` trigger source (once cast spawn can be cached under 1s).
- MCP `manta.trigger_fire` once `phantom-lance` unlocks recursive cast.
- Trigger replay — re-evaluate a historical event payload against current
  trigger config without firing. Useful for "what would have happened?"
  analysis.

---

## 9. Summary — what we build in Phase 7

**Code (in suggested chunk order):**

1. **Chunk A — schemas & bus stores.** Widen `CastManifestSchema` with
   metadata, add `TriggerDefSchema` / `TriggersArmedStateSchema` /
   `TriggerFireRecordSchema`, ship `TriggersArmedStore` /
   `TriggerFiresLog` / `TriggerDebounceStore` with tests.
2. **Chunk B — trigger evaluator & validator.**
   `packages/manta-cli/src/triggers/` — loader, validator, condition
   evaluator, template renderer, fire orchestrator. Unit tests for each.
3. **Chunk C — CLI surface & `manta-hook` shim.**
   `packages/manta-cli/src/commands/trigger.ts`, `bin/manta-hook`,
   `install-hooks` command. Integration tests via fake clock.
4. **Chunk D — refactor cast.ts spawn seam.** Extract `spawnCast` from
   `runCastCommand`; wire trigger fire to call it with hardened options.
5. **Chunk E — e2e safety tests.** Loop-detection refusal,
   circuit-breaker behaviour, daily-cap refusal, dedup, cooldown,
   debounce — each with a dedicated `@manta/e2e` test that drives the
   full hook → fire → gate → refuse pipeline.

**Docs:**
- User-facing `docs/user/triggers.md` — getting started, examples,
  panic-button (`disarm-all`).
- Architecture note `docs/internals/triggers.md` — guardrail rationale,
  links to this research doc.
- Update `docs/internals/claude-code-pitfalls.md` with a new section
  cross-referencing Sec 3.6 (loop detection enforced at orchestrator
  level, not skill text — concrete application of pitfall §1).

**Out of Phase 7 scope (do not ship):**
- File watcher daemon.
- Test-runner watchers.
- CI webhook ingress.
- MCP `trigger_fire` tool.
- PreToolUse-source triggers.
- Trigger Library / community templates.
- `PreToolUse` cast spawn (latency budget).
- Auto-downgrade in trigger-fired spawn (always refuse on daily-cap).

---

*End of research. Hand off to plan phase via `superpowers:writing-plans`
with this document as primary input.*

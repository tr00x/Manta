# Charge System & Budget Controls

Manta uses a charge-based frequency limiter and multi-layer budget system to prevent runaway costs and encourage disciplined cast usage.

## Charges

Each cast deducts charges based on mode complexity:

| Mode | Charge cost |
|---|---|
| recon-swarm | 1 |
| forking-realities | 2 |
| bug-hunt | 2 |
| test-storm | 2 |
| refactor-wave | 2 |
| pair-programming | 1 |
| documentation-chase | 1 |
| council | 3 |
| phantom-lance | 3 |
| decoy | 2 |

Default: 3 initial charges, max 5, min -1 (overdraft).

### Idle recovery

Charges regenerate passively: +1 every 30 minutes of idle time (no casts running). Recovery is applied automatically when the next cast starts.

### Overdraft & cooldown

If charges go below 0 (overdraft) and a cast fails, a 24-hour cooldown activates. During cooldown, no casts can be launched. Use `manta refresh` to manually clear the cooldown (requires double confirmation).

### Post-cast settlement

After each cast completes:
- **Success** (all clones completed normally): +1 charge
- **Fail** (budget abort or clone crashes): -1 charge
- **Neutral** (manual kill): no change

## Usage layers

Claude Code is a **subscription** (Pro/Max), not pay-per-token, so Manta tracks
**usage**, not dollars. The unit everywhere below is a **token estimate** — a
rough proxy for how much of your subscription's usage/rate limit a cast consumes.

### L1: Parallelism cap

`--max-parallel-clones <n>` — maximum clones a single cast may spawn at once.
Default: 5 (config key `max_parallel_clones`). A cast requesting more is rejected
before any clone spawns.

### L2: Cast-rate cap

`--max-casts-per-hour <n>` — maximum casts allowed to start in a rolling hour.
Default: 6 (config key `max_casts_per_hour`). Protects your subscription's
usage/rate limit when many casts fire in quick succession.

### L3: Daily token-estimate cap

Configurable via `manta limit set daily_token_cap <tokens>`, or override a single
cast with `--max-tokens-estimate <tokens>`. Default: 5,000,000 tokens/day.

When the daily token-estimate cap would be exceeded, Manta computes downgrade
options (fewer clones, cheaper mode) and presents them.

### L4: Auto-downgrade

When budget is tight, Manta suggests alternatives:
- Reduce clone count (N-1, N-2, ...)
- Switch to a cheaper mode (e.g., recon-swarm instead of forking-realities)

Controlled via `manta limit set auto_downgrade.enabled true|false`.

## CLI commands

### `manta cast --dry-run`

Preview cost without spawning clones:

```
$ manta cast recon-swarm -n 3 --dry-run
Dry Run: recon-swarm
  Clones:     3
  Est. usage: ~450k tok (3 × ~150k/clone)
  Usage check:
    Parallelism: 3 ≤ 5 ✓
    Daily cap:   5,000,000 - 1,200,000 = 3,800,000 ≥ 450,000 tok ✓
    Charges:     3 ≥ 1 ✓
```

### `manta cost [today|week]`

Show spend summary:

```
$ manta cost
Usage today: 2 casts, 5 clones spawned
Cast rate: 2/6 this hour  ████░░░░░░░░░░░░░░░░
  4 more casts allowed before the hourly cap

Token estimate today: ~1.2M tok (usage proxy, not dollars)
Charges: 3/5  (parallelism cap: 5 clones/cast)
```

### `manta charges`

Show charge system state:

```
$ manta charges
Charges: 3 / 5
State: nominal
Last cast: 12 min ago (success, +1)
Idle recovery: next +1 in 18 min
```

### `manta refresh`

Clear a 24h cooldown (requires double confirmation):

```
$ manta refresh
⚠️  This resets the 24h cooldown.
Type "refresh" to confirm: refresh
Type "refresh" again: refresh
Cooldown cleared. Charges set to 0.
```

### `manta limit get|set`

Read or write budget configuration:

```
$ manta limit get
max_parallel_clones:               5
max_casts_per_hour:                6
token_estimate_per_cast:           1500000
token_estimate_per_clone:          auto (computed: per_cast / N)
daily_token_cap:                   5000000
charges.initial:                   3
...

$ manta limit set daily_token_cap 8000000
Updated daily_token_cap: 5000000 → 8000000
```

### Additional cast flags

- `--force` — bypass the daily token-estimate cap check
- `--no-charge-check` — skip charge system entirely (testing only)
- `--max-tokens-estimate <tokens>` — override the daily token-estimate projection for this cast

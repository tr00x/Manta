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

## Budget layers

### L1: Per-clone budget

`--budget-per-clone-usd <amount>` — maximum USD each clone can spend. Default: auto (per-cast / N).

### L2: Per-cast budget

`--budget-per-cast-usd <amount>` — maximum total USD for the entire cast. Default: $15.

### L3: Daily cap

Configurable via `manta limit set daily_cap_usd <amount>` or `--daily-cap-usd` flag. Default: $50/day.

When daily cap would be exceeded, Manta computes downgrade options (fewer clones, cheaper mode) and presents them.

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
  Est. cost:  ~$4.50 (3 × $1.50/clone)
  Budget check:
    Per-cast:   $15.00 ≥ $15.00 ✓
    Daily cap:  $50.00 - $23.50 = $26.50 ≥ $4.50 ✓
    Charges:    3 ≥ 1 ✓
```

### `manta cost [today|week]`

Show spend summary:

```
$ manta cost
Daily budget: $23.50 / $50.00 (47%)
Remaining today: $26.50
Charges: 3/5
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
per_cast_usd:                      15
daily_cap_usd:                     50
charges.initial:                   3
...

$ manta limit set daily_cap_usd 100
Updated daily_cap_usd: 50 → 100
```

### Additional cast flags

- `--force` — bypass daily cap check
- `--no-charge-check` — skip charge system entirely (testing only)
- `--daily-cap-usd <amount>` — override daily cap for this cast

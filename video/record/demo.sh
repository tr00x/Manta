#!/usr/bin/env bash
#
# Manta terminal-truth demo runner.
# Run UNDER a screen recording, from a CLEAN shell (not inside a Claude Code
# session — bug #66: a large parent transcript eats the clone startup grace).
#
#   cd /Users/timur/projectos/manta
#   ./video/record/demo.sh            # read-only beats only (cheap, safe)
#   ./video/record/demo.sh --live     # also fires a REAL forking cast (costs charges, slow)
#
# Each command types itself out, runs for real, and pauses so the frame is
# readable. Deterministic timing → the editor knows every beat's length.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

MANTA="${MANTA:-node dist/bin/manta.cjs}"
LIVE=0
[[ "${1:-}" == "--live" ]] && LIVE=1

GREEN=$'\033[32m'; DIM=$'\033[2m'; RST=$'\033[0m'
TYPE_DELAY="${TYPE_DELAY:-0.035}"   # seconds per character
HOLD="${HOLD:-2.4}"                 # default pause after a command's output

type_cmd() {
  local s="$1" i
  printf '%s❯ %s' "$GREEN" "$RST"
  for ((i = 0; i < ${#s}; i++)); do
    printf '%s' "${s:i:1}"
    sleep "$TYPE_DELAY"
  done
  printf '\n'
}

# run "<command>" [hold-seconds]
run() {
  type_cmd "$1"
  sleep 0.4
  eval "$1"
  echo
  sleep "${2:-$HOLD}"
}

note() { printf '%s# %s%s\n' "$DIM" "$1" "$RST"; sleep 1.2; }

clear
sleep 1.0

# ── BEAT 1 — proof first ──────────────────────────────────────────────
run "$MANTA doctor" 2.8

# ── BEAT 2 — one command, three of me ─────────────────────────────────
if [[ $LIVE -eq 1 ]]; then
  run "$MANTA cast forking-realities --clones 3 --task \"add rate limiting to the API\"" 3.2
  note "clones are booting — give them a few seconds…"
  sleep 6
else
  note "(read-only run — clones already live from an earlier real cast)"
fi

# ── BEAT 3 — not 'agents'. me, again. ─────────────────────────────────
run "$MANTA status" 3.0

# ── BEAT 4 — warm, not cold (the killer shot) ─────────────────────────
run "$MANTA inspect A" 4.5

# ── BEAT 5 — real isolation (also see tmux-clones.sh for the 3-pane live tail)
run "git worktree list" 3.0

# ── BEAT 6 — three branches, real commits ─────────────────────────────
run "git log --all --graph --oneline -16" 4.0

# ── BEAT 7 — I review. I merge. (uses a real post-mortem as the artifact)
run "ls docs/post-mortems/ | tail -5" 2.6

# ── BEAT 8 — it can't run away with your money ────────────────────────
run "$MANTA cost" 3.0
run "$MANTA charges" 3.0

sleep 1.5
clear
printf '\n\n  %s❯%s a clone is just you, again, somewhere else.\n\n' "$GREEN" "$RST"
printf '    github.com/tr00x/Manta\n\n'
sleep 4

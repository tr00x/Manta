#!/usr/bin/env bash
#
# Beat 5 money shot: three clones tailed LIVE, side by side.
# Requires tmux and three clones currently active (run a real cast first,
# from a clean shell:  manta cast forking-realities --clones 3 --task "…").
#
#   ./video/record/tmux-clones.sh A B C
#
# Records nothing itself — start your screen recording, then run this.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
MANTA="${MANTA:-node dist/bin/manta.cjs}"

A="${1:-A}"; B="${2:-B}"; C="${3:-C}"
DUR="${DUR:-40}"   # seconds to stream

command -v tmux >/dev/null || { echo "tmux not installed: brew install tmux"; exit 1; }

SESSION="manta-cast"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 220 -y 50

# three vertical panes
tmux send-keys -t "$SESSION" "$MANTA tail $A $DUR" C-m
tmux split-window -h -t "$SESSION"
tmux send-keys -t "$SESSION" "$MANTA tail $B $DUR" C-m
tmux split-window -h -t "$SESSION"
tmux send-keys -t "$SESSION" "$MANTA tail $C $DUR" C-m
tmux select-layout -t "$SESSION" even-horizontal

tmux attach -t "$SESSION"

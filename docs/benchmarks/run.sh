#!/usr/bin/env bash
# Manta benchmark runner — honest harness skeleton.
#
# Measures three methods on the same task: `manta` (real `manta cast`),
# `subagents` (STUB — wire to your Agent-tool runner), `solo` (STUB — wire to a
# solo session). Records wall-clock, pass/fail (the task's own success check),
# diff size, and usage into a CSV. NO numbers are invented — a cell you don't
# measure stays empty, and the stub arms record `stub` not a fake result.
#
# Usage:
#   MANTA_BENCH=1 BENCH_TARGET=/path/to/repo bash docs/benchmarks/run.sh [task]
#     task : optional task name (recon-map | refactor-rename | bug-multilayer).
#            Omitted → all tasks.
#   REPEATS=3        repeats per cell (default 3; claude is non-deterministic)
#   METHODS="manta"  space-separated subset of: manta subagents solo (default all)
#
# Output: docs/benchmarks/results.csv  (gitignored — transcribe medians to RESULTS.md)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
TASKS_DIR="$HERE/tasks"
OUT="$HERE/results.csv"
REPEATS="${REPEATS:-3}"
METHODS="${METHODS:-manta subagents solo}"

if [[ "${MANTA_BENCH:-}" != "1" ]]; then
  echo "Refusing to run without MANTA_BENCH=1 (this spends real claude usage)." >&2
  echo "  MANTA_BENCH=1 BENCH_TARGET=/path/to/repo bash docs/benchmarks/run.sh [task]" >&2
  exit 2
fi
: "${BENCH_TARGET:?set BENCH_TARGET=/path/to/target/repo}"

# task name → manta mode
mode_for() {
  case "$1" in
    recon-map)        echo "recon-swarm" ;;
    refactor-rename)  echo "refactor-wave" ;;
    bug-multilayer)   echo "bug-hunt" ;;
    *) echo "unknown"; return 1 ;;
  esac
}

# Pull the fenced ## Prompt block out of a task .md (text between the ```
# fences under the "## Prompt" heading).
prompt_for() {
  awk '/^## Prompt/{f=1;next} f&&/^```/{c++; next} f&&c==1{print} c==2{exit}' "$1"
}
# Pull the fenced ## Success check block (a shell snippet to eval).
check_for() {
  awk '/^## Success check/{f=1;next} f&&/^```/{c++; next} f&&c==1{print} c==2{exit}' "$1"
}

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

if [[ ! -f "$OUT" ]]; then
  echo "ts,task,mode,method,repeat,wall_clock_s,passed,diff_lines,usage_note" > "$OUT"
fi

run_check() {  # $1 = success-check snippet; runs in BENCH_TARGET; 0 = pass
  ( cd "$BENCH_TARGET" && bash -c "$1" >/dev/null 2>&1 )
}

diff_lines() {  # changed lines in BENCH_TARGET working tree (0 for read-only)
  ( cd "$BENCH_TARGET" && git diff --shortstat 2>/dev/null \
      | grep -oE '[0-9]+ insertion|[0-9]+ deletion' | grep -oE '[0-9]+' \
      | paste -sd+ - | bc 2>/dev/null ) || echo 0
}

# ── method arms ────────────────────────────────────────────────────────────
# REAL: actually casts. Returns via globals PASSED/WALL/DIFF/USAGE.
arm_manta() {  # $1 task  $2 mode  $3 prompt  $4 check
  local task="$1" mode="$2" prompt="$3" check="$4"
  local t0 t1
  t0="$(now_ms)"
  # The real thing. allowed-paths/max-files-changed are task-agnostic here;
  # tighten per task if you want a stricter scope. Read-only recon → 0 files.
  local maxfiles=20; [[ "$mode" == "recon-swarm" ]] && maxfiles=5
  ( cd "$BENCH_TARGET" && manta cast "$mode" \
      --clones 2 \
      --task "$prompt" \
      --allowed-paths "." \
      --max-files-changed "$maxfiles" \
      --max-tokens-estimate 600000 ) >/dev/null 2>&1
  # NOTE: for forking-realities/bug-hunt you then promote/merge a branch before
  # the check — wire that here for your repo. The skeleton checks the worktree
  # as-is so the harness runs end-to-end; adapt to your merge step.
  t1="$(now_ms)"
  WALL="$(python3 -c "print(($t1-$t0)/1000)")"
  if run_check "$check"; then PASSED=1; else PASSED=0; fi
  DIFF="$(diff_lines)"
  USAGE="$(cd "$REPO_ROOT" && manta cost 2>/dev/null | grep -oiE 'Token estimate.*' | head -1)"
  [[ -z "$USAGE" ]] && USAGE="see-manta-cost"
}

# STUB: driving the Agent tool programmatically is environment-specific.
arm_subagents() {
  echo "  [stub] subagents arm — wire this to your Agent-tool runner." >&2
  echo "         Prompt to feed: (see task file). Then run the success check." >&2
  PASSED=""; WALL=""; DIFF=""; USAGE="stub"
}
# STUB: solo session — run the prompt yourself in one session, then the check.
arm_solo() {
  echo "  [stub] solo arm — run the prompt in a single session, then the check." >&2
  PASSED=""; WALL=""; DIFF=""; USAGE="stub"
}

# ── main loop ──────────────────────────────────────────────────────────────
TASKS=("${1:-}")
[[ -z "${TASKS[0]}" ]] && TASKS=(recon-map refactor-rename bug-multilayer)

for task in "${TASKS[@]}"; do
  f="$TASKS_DIR/$task.task.md"
  [[ -f "$f" ]] || { echo "no such task: $task ($f)" >&2; continue; }
  mode="$(mode_for "$task")" || { echo "no mode for $task" >&2; continue; }
  prompt="$(prompt_for "$f")"
  check="$(check_for "$f")"
  echo "== task=$task mode=$mode =="
  for method in $METHODS; do
    for r in $(seq 1 "$REPEATS"); do
      echo "-- $method repeat $r/$REPEATS"
      PASSED=""; WALL=""; DIFF=""; USAGE=""
      case "$method" in
        manta)     arm_manta "$task" "$mode" "$prompt" "$check" ;;
        subagents) arm_subagents ;;
        solo)      arm_solo ;;
      esac
      printf '%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
        "$(now_ms)" "$task" "$mode" "$method" "$r" \
        "${WALL:-}" "${PASSED:-}" "${DIFF:-}" "${USAGE:-}" >> "$OUT"
    done
  done
done

echo
echo "Wrote rows to $OUT"
echo "Transcribe medians (passing runs only) into docs/benchmarks/RESULTS.md."
echo "Reminder: the subagents/solo arms are STUBS — their rows are 'stub' until you wire a runner."

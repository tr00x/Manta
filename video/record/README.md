# Recording the Manta explainer (terminal-truth)

The video is **real terminal footage** with terse typography on top. Nothing
is faked. This folder is the kit to capture that footage deterministically.

## 1. Terminal setup
- Dark theme, monospace, **font size 18–22pt**, window ~1920px wide.
- Clean prompt (hide git-status noise if it's loud). Generous line height.
- A theme with a clear green for `✓` and readable dim text reads best.

## 2. Run from a CLEAN shell — not inside Claude Code
Bug #66: a large parent transcript eats the clone startup grace, so casts may
not boot from inside a Claude session. A plain terminal is fine.

```bash
cd /Users/timur/projectos/manta
```

## 3. (Optional) fire a real cast first, for live clones
For beats 3–6 to show **three** clones, have a real forking cast running:

```bash
node dist/bin/manta.cjs cast forking-realities --clones 3 --task "add rate limiting to the API"
```

This costs charges and the clones run for real. Let them reach WORKING, then
record. If you skip this, the demo still works against whatever clones already
exist — it just won't show a fresh 3-up.

## 4. Record the main run
Start screen recording (`⌘⇧5` on macOS → record the terminal window), then:

```bash
./video/record/demo.sh           # read-only beats (safe, cheap)
./video/record/demo.sh --live    # also fires the cast inline
```

Each command types itself, runs for real, holds. ~70s end to end.

## 5. Record the money shot (beat 5) separately
Three clones tailed live, side by side:

```bash
./video/record/tmux-clones.sh A B C
```

Record this as its own clip; I'll cut it into beat 5.

## 6. Hand off
Drop the `.mov`/`.mp4` files anywhere and tell me the paths. I composite them
in Remotion with the overlay lines from `voiceover.md`, point-highlight key
rows (the `✓`s, the `WORKING`s, the inherited contract), and cut to time.

## Knobs
- `TYPE_DELAY=0.05` — slower typing. `HOLD=3` — longer pauses.
- `MANTA="manta"` — if you have the binary on PATH instead of `node dist/...`.

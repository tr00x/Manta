# Last Gasp Report — Clone A

**Cast:** cast-1779818782275
**Clone:** A
**Task:** Create forking-realities e2e test

## Deliverables

1. **`packages/manta-e2e/tests/forking-realities.e2e.test.ts`** — Full e2e test for forking-realities mode following the exact pattern from recon-swarm.e2e.test.ts. Covers:
   - 2-clone forking-realities cast with per-clone approach_hints via --tasks YAML
   - Registry assertions (both clones DEAD)
   - Post-mortem markdown files
   - ZK notes
   - Snapshot persistence
   - Worktree retention
   - Clone branch commit assertions (at least 1 commit per clone)
   - merge_review event in events.jsonl with cast_id match
   - Merge-review verdict validation (auto_merge_eligible, manual_review_required, no_candidates_passed_gate, dominance_inversion_flagged)
   - Merge-review markdown at docs/merge-reviews/<castId>.md
   - Forensic timeline NDJSON at .manta/state/timelines/<castId>.ndjson

2. **`packages/manta-e2e/tests/fixtures/sample-repo/src/auth.ts`** — Updated fixture with extractable `authenticate()` function containing validation logic suitable for the forking-realities refactoring task.

## Notes

- Test is gated by MANTA_E2E=1 env var (skip with console.warn if claude unavailable)
- 28 minute timeout
- No TODO/FIXME/skip markers
- Evidence-preservation pattern identical to recon-swarm (MANTA_E2E_KEEP=1 support)
- The forensic timeline assertion uses `.ndjson` extension (matching ForensicTimelineWriter output), not `.jsonl` as mentioned in the task spec — this matches the actual implementation in cast.ts line 282

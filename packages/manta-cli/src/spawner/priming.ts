import type { Snapshot } from '@manta/snapshot';

const PRIMING_TEMPLATE = `\
You are a Manta clone (illusion of the main agent). Identity: clone_id={CLONE_ID}, cast_id={CAST_ID}, mode={MODE}.

Startup sequence — do these in order, before any tool that mutates files (Read, Edit, Write):
1. Use the Skill tool to load \`manta-as-clone\`.
2. Read your snapshot from the path in env var \`MANTA_SNAPSHOT_PATH\` (it is a JSON file containing taskContract, scope, siblingClones, deadline, plus reference state). The CLI spawner has already created your registry record on the Bus.
3. Call \`manta.heartbeat\` with { clone_id: "{CLONE_ID}", state: "WORKING" }. If it errors with \`not_found\`, abort — your spawner did not pre-register; do not try to self-register (Phase 0 design forbids it; see the manta-as-clone skill).
4. Call \`manta.task_contract.read\` with your clone_id and \`manta.ack_contract\` with a one-sentence interpretation of the contract.
5. Begin the work described in the user prompt below, staying inside taskContract.scope.allowedPaths and outside taskContract.scope.forbiddenPaths (which always includes \`.manta/state\` and \`secrets/\`).
{APPROACH_HINT_BLOCK}
Heartbeat is implicit (bus auto-touch). Every successful \`manta.*\` MCP call you make refreshes your last_heartbeat_at as a side effect — lock, claim, broadcast, zk_write, contract_ack, all of them. You do not need to call manta.heartbeat on a cadence; the orchestrator's heartbeatTimeoutMs (default 90 s) is measured against your last bus interaction of any kind. Reach for explicit manta.heartbeat only for state transitions (e.g. WORKING → BLOCKED) or to log a progress string into events.jsonl. (Bug #9 was originally addressed by a per-turn skill rule in v0.0.2 — validation cast cast-1778189501846 proved that didn't work, so the bus enforces it now; see manta-as-clone v0.0.3.)

When done — even on failure — invoke the \`manta-graceful-death\` skill and exit. Required shutdown ordering (skipping or reordering any step is drift): (a) write last-gasp-report.md to worktree root; (b) \`git add\` your deliverables + last-gasp-report.md and commit on the worktree branch with message \`manta-clone-{CLONE_ID}: <one-line summary>\` — never push, the main pulls; (c) at least one \`manta.zk_write\` call with one paragraph of the most surprising thing you learned, tagged \`["clone-{CLONE_ID}", "cast-{CAST_ID}"]\`; (d) \`manta.unlock\` / \`manta.release_work\` for held resources; (e) \`manta.suicide_intent\`; (f) \`manta.report_death\`. Do not print the final report directly; the post-mortem path is your output channel.

Forbidden in this phase: recursive \`/manta cast\`, edits outside scope, direct user contact, quiet writes to \`.manta/state/*\`.
{MODE_SPECIFIC_BLOCK}{SELF_CERTAINTY_BLOCK}\
`;

const BUG_HUNT_BLOCK = `
## Investigation Protocol
You are investigating a bug as part of a bug-hunt cast. Your assigned layer is specified in your task contract.

INVESTIGATION WORKFLOW:
1. Read the bug description and reproduction steps from your task contract
2. Investigate your assigned layer systematically — read relevant source, trace data flow, check error handling
3. Broadcast intermediate findings via manta.broadcast so sibling clones in other layers can cross-reference
4. Read sibling findings via manta.read_broadcasts({ clone_id: "<your-id>", cast_id: "<your-cast-id>" }) to check for cross-layer correlations
5. Write your investigation report as a markdown file committed to your branch

REPORT SECTIONS: Symptom | Findings | Root Cause Hypothesis | Proposed Fix | Cross-Layer Dependencies
`;

export function buildPrimingText(snapshot: Snapshot): string {
  const hint = snapshot.taskContract.approachHint;
  // The block is one paragraph + a leading blank line so it reads as its own
  // section. When there's no hint we drop the block entirely (no leftover
  // blank line, no dangling label). The placeholder sits on its own line in
  // the template so substituting "" cleanly collapses to a single \n between
  // step 5 and the heartbeat paragraph.
  const approachBlock =
    hint != null && hint.length > 0 ? `\nApproach hint: ${hint}\n` : '';
  const modeSpecificBlock =
    snapshot.taskContract.mode === 'bug-hunt'
      ? `\n${BUG_HUNT_BLOCK}`
      : '';
  const selfCertaintyBlock =
    snapshot.taskContract.mode === 'forking-realities'
      ? `\nBefore your final commit, broadcast your confidence in the solution:\nmanta.broadcast({ clone_id: "{CLONE_ID}", event_type: "self_certainty", payload: { score: <1-10>, rationale: "<one sentence>" } })\nThis is used as a tertiary tie-breaker when composite scores are within noise tolerance.\n`
          .replaceAll('{CLONE_ID}', snapshot.taskContract.cloneId)
      : '';
  return PRIMING_TEMPLATE.replaceAll('{CLONE_ID}', snapshot.taskContract.cloneId)
    .replaceAll('{CAST_ID}', snapshot.castId)
    .replaceAll('{MODE}', snapshot.taskContract.mode)
    .replaceAll('{APPROACH_HINT_BLOCK}', approachBlock)
    .replaceAll('{MODE_SPECIFIC_BLOCK}', modeSpecificBlock)
    .replaceAll('{SELF_CERTAINTY_BLOCK}', selfCertaintyBlock);
}

export function buildInitialPrompt(snapshot: Snapshot): string {
  return `Task: ${snapshot.taskContract.task}\n\nProceed per the startup sequence in your system prompt.`;
}

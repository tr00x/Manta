#!/usr/bin/env node
// Stand-in for `claude --print`. Spawner pre-registers the clone in the Bus
// Registry BEFORE this script runs (Phase-1 lockdown, closes manta-bugs #2/#3).
// This script no longer self-registers — that would conflict with the spawner's
// pre-registration via atomicMutateJson. Behaviours by MANTA_FAKE_CLONE_STATE:
//   - 'crash'    (default): exit 0 immediately. Orchestrator's heartbeat
//                death-detector should mark the clone DEAD when its
//                last_heartbeat_at goes stale. This is the realistic Phase-0
//                path — production clones go through MCP heartbeat, never
//                self-mark DEAD.
//   - 'graceful': mark DEAD ('graceful-finish') via direct registry file write
//                (test-only side channel; production uses manta.report_death
//                over MCP), exit 0
//   - 'fail':    mark DEAD ('fake-fail'), exit 2
//   - 'hang':    never exit (tests SIGTERM path)
//
// Env vars from spawner: MANTA_SNAPSHOT_PATH, MANTA_REPO_ROOT, MANTA_CLONE_ID.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

async function markDead(repoRoot, cloneId, reason) {
  const registryPath = path.join(repoRoot, '.manta', 'state', 'registry.json');
  let reg;
  try {
    reg = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  } catch {
    // Unit tests use an in-memory RegistryFake; the real on-disk registry
    // file may not exist. Skip the markDead-on-disk side effect — the
    // exit code below is what unit tests assert.
    return;
  }
  const rec = reg.clones?.[cloneId];
  if (!rec) {
    // Same rationale as above: unit tests don't materialise the record on disk.
    return;
  }
  rec.state = 'DEAD';
  rec.death_reason = reason;
  rec.died_at = Date.now();
  await fs.writeFile(registryPath, JSON.stringify(reg, null, 2), 'utf8');
}

async function main() {
  const cloneState = process.env.MANTA_FAKE_CLONE_STATE || 'crash';

  if (cloneState === 'hang') {
    setInterval(() => {}, 60_000);
    return;
  }

  if (cloneState === 'crash') {
    // Just exit. The spawner-pre-registered record stays at STARTING; the
    // orchestrator's heartbeat death-detector fires once last_heartbeat_at
    // goes stale.
    process.exit(0);
  }

  // graceful / fail need access to repo + clone identity to mark DEAD.
  const repoRoot = process.env.MANTA_REPO_ROOT;
  const cloneId = process.env.MANTA_CLONE_ID;
  if (!repoRoot) throw new Error('MANTA_REPO_ROOT unset');
  if (!cloneId) throw new Error('MANTA_CLONE_ID unset');
  if (!SAFE_KEY.test(cloneId)) throw new Error(`unsafe clone_id: ${cloneId}`);

  if (cloneState === 'graceful') {
    await markDead(repoRoot, cloneId, 'graceful-finish');
    process.exit(0);
  }
  if (cloneState === 'fail') {
    await markDead(repoRoot, cloneId, 'fake-fail');
    process.exit(2);
  }
  throw new Error(`unknown MANTA_FAKE_CLONE_STATE: ${cloneState}`);
}

main().catch((err) => {
  console.error('fake-clone error:', err);
  process.exit(1);
});

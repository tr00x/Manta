#!/usr/bin/env node
// Stand-in for `claude --print`. Reads the snapshot from MANTA_SNAPSHOT_PATH,
// writes a register record directly to .manta/state/registry.json (skipping
// MCP since the test doesn't run a bus subprocess), then takes one of four
// behaviours based on MANTA_FAKE_CLONE_STATE:
//   - 'crash'    (default): register, exit 0 WITHOUT marking DEAD — the
//                orchestrator is expected to detect the stale heartbeat and
//                run the death workflow. This is the realistic Phase-0 path:
//                production clones go through MCP, never self-mark DEAD.
//   - 'graceful': register, mark DEAD ('graceful-finish'), exit 0
//   - 'fail':    register, mark DEAD ('fake-fail'), exit 2
//   - 'hang':    register, never exit (tests SIGTERM path)
//
// This is the test seam for clone-spawner. Production uses `claude --print`,
// which talks to the real Manta Bus over MCP.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

async function main() {
  const snapPath = process.env.MANTA_SNAPSHOT_PATH;
  if (!snapPath) throw new Error('MANTA_SNAPSHOT_PATH unset');
  const repoRoot = process.env.MANTA_REPO_ROOT;
  if (!repoRoot) throw new Error('MANTA_REPO_ROOT unset');
  const snap = JSON.parse(await fs.readFile(snapPath, 'utf8'));
  // Snapshot taskContract uses camelCase (cloneId) per @manta/snapshot schema.
  const cloneId = snap.taskContract.cloneId;
  if (!SAFE_KEY.test(cloneId)) throw new Error(`unsafe clone_id: ${cloneId}`);
  const cloneState = process.env.MANTA_FAKE_CLONE_STATE || 'crash';
  const registryPath = path.join(repoRoot, '.manta', 'state', 'registry.json');

  let reg;
  try {
    reg = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  } catch {
    reg = { version: 1, clones: {} };
  }
  const now = Date.now();
  // RegisterInputSchema requires metadata: Record<string, string>, so coerce.
  const metadata = { cast_id: String(snap.castId) };
  reg.clones[cloneId] = {
    clone_id: cloneId,
    mode: snap.taskContract.mode,
    parent_pid: process.ppid,
    worktree: snap.cloneWorktree,
    metadata,
    registered_at: now,
    last_heartbeat_at: now,
    state: 'WORKING',
  };
  await fs.writeFile(registryPath, JSON.stringify(reg, null, 2), 'utf8');

  if (cloneState === 'hang') {
    setInterval(() => {}, 60_000);
    return;
  }

  if (cloneState === 'graceful' || cloneState === 'fail') {
    reg.clones[cloneId].state = 'DEAD';
    reg.clones[cloneId].died_at = Date.now();
    reg.clones[cloneId].death_reason =
      cloneState === 'graceful' ? 'graceful-finish' : 'fake-fail';
    await fs.writeFile(registryPath, JSON.stringify(reg, null, 2), 'utf8');
  }

  process.exit(cloneState === 'fail' ? 2 : 0);
}

main().catch((err) => {
  console.error('fake-clone error:', err);
  process.exit(1);
});

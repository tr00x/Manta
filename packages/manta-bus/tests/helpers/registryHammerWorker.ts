/**
 * Worker script for the cross-process Registry test (Fix #13).
 *
 * Spawned via `node:child_process.fork` with the `tsx` loader. Reads the
 * shared `repoRoot` and worker config from argv, then registers N clones via
 * the public RegistryStore API. Reports back via `process.send` and exits 0.
 *
 * The whole point: exercise proper-lockfile's *cross-process* code path
 * (separate locker pids, real fs.watch / retry behaviour). In-process
 * Promise.all concurrency goes through a different code path internally and
 * does not catch a broken file mutex.
 */
import { busPaths } from '../../src/state/paths';
import { systemClock } from '../../src/clock';
import { Registry } from '../../src/state/registry';

interface WorkerArgs {
  repoRoot: string;
  workerId: string;
  count: number;
}

function parseArgs(): WorkerArgs {
  const [, , repoRoot, workerId, countRaw] = process.argv;
  if (!repoRoot || !workerId || !countRaw) {
    throw new Error('registryHammerWorker: missing args (repoRoot, workerId, count)');
  }
  const count = Number(countRaw);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`registryHammerWorker: invalid count ${countRaw}`);
  }
  return { repoRoot, workerId, count };
}

async function main(): Promise<void> {
  const { repoRoot, workerId, count } = parseArgs();
  const registry = new Registry(busPaths(repoRoot), systemClock);
  const registered: string[] = [];
  for (let i = 0; i < count; i++) {
    const cloneId = `${workerId}-${i}`;
    await registry.register({
      clone_id: cloneId,
      mode: 'recon-swarm',
      parent_pid: process.pid,
      worktree: '/tmp/w',
      metadata: {},
    });
    registered.push(cloneId);
  }
  if (process.send) process.send({ ok: true, registered });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  // process.send is async; exiting immediately can drop the not-yet-flushed
  // IPC frame, leaving the parent with a bare "exit 1" and no error. Exit only
  // from the flush callback so the diagnostic always reaches the parent.
  if (process.send) {
    process.send({ ok: false, error: msg }, () => process.exit(1));
  } else {
    process.exit(1);
  }
});

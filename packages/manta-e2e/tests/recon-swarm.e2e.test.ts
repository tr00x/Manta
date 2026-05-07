import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { probeClaudeBin } from './helpers/claudeBin.js';
import { makeSampleRepo, type SampleRepoFixture } from './helpers/sampleRepo.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cliBin = path.join(repoRoot, 'packages/manta-cli/dist/bin/manta.cjs');

// NOTE: this suite proves the *harness* — that the spawn / bus / orchestrator /
// CLI / skills wiring carries a real `claude --print` clone through its full
// lifecycle and produces every expected on-disk artifact. It does NOT assert
// the *quality* of the answer the clone produced (e.g. that `docs/recon.md`
// usefully maps the codebase). Output-quality assessment is the human's job
// in `docs/acceptance/phase-0.md`.
describe('recon-swarm end-to-end against real claude', () => {
  let fx: SampleRepoFixture | undefined;
  let claude: Awaited<ReturnType<typeof probeClaudeBin>>;

  beforeAll(async () => {
    claude = await probeClaudeBin();
  });

  it('runs a 2-clone recon-swarm cast and produces post-mortems and ZK notes', async () => {
    if (!claude.available) {
      // eslint-disable-next-line no-console
      console.warn(`[recon-swarm.e2e] SKIPPED: ${claude.reason}`);
      return;
    }
    fx = await makeSampleRepo();
    const r = await execa(
      'node',
      [
        cliBin, 'cast', 'recon-swarm',
        '--clones', '2',
        '--task', 'Map every public export in src/. Produce a markdown summary as docs/recon.md.',
        '--cycle-interval-ms', '5000',
        '--tick-budget-ms', '1500000', // 25 min ceiling
        '--budget-per-clone-usd', '5',
      ],
      { cwd: fx.root, reject: false, timeout: 28 * 60 * 1000 },
    );

    // Surface stdout/stderr on failure for diagnosis
    if (r.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error('cast stdout:\n', r.stdout);
      // eslint-disable-next-line no-console
      console.error('cast stderr:\n', r.stderr);
    }
    expect(r.exitCode).toBe(0);

    // Both clones reached DEAD via the orchestrator. Use the public Registry API
    // (not raw JSON) so this assertion stays correct if the on-disk shape evolves.
    const { busPaths, Registry, systemClock } = await import('@manta/bus');
    const registry = new Registry(busPaths(fx.root), systemClock);
    const clones = await registry.list();
    expect(clones).toHaveLength(2);
    for (const c of clones) {
      expect(c.state).toBe('DEAD');
    }

    // Post-mortems on disk — at least 2 (orchestrator may write more if recover ran)
    const pmDir = path.join(fx.root, 'docs/post-mortems');
    const pmFiles = (await fs.readdir(pmDir)).filter((f) => f.endsWith('.md'));
    expect(pmFiles.length).toBeGreaterThanOrEqual(2);
    expect(pmFiles.some((f) => f.endsWith('-A.md'))).toBe(true);
    expect(pmFiles.some((f) => f.endsWith('-B.md'))).toBe(true);
    for (const f of pmFiles) {
      const body = await fs.readFile(path.join(pmDir, f), 'utf8');
      expect(body).toContain('# Post-mortem — clone');
      expect(body).toContain('## Event timeline');
    }

    // Each clone wrote at least one ZK note (1-3 per the manta-graceful-death skill)
    const zkDir = path.join(fx.root, 'docs/zk');
    const zkFiles = (await fs.readdir(zkDir)).filter((f) => f.endsWith('.md'));
    expect(zkFiles.length).toBeGreaterThanOrEqual(2);

    // Snapshots persisted under at least one cast directory
    const snapDirs = (await fs.readdir(path.join(fx.root, '.manta/snapshots')))
      .filter((d) => d.startsWith('cast-'));
    expect(snapDirs.length).toBeGreaterThanOrEqual(1);
    const snaps = await fs.readdir(path.join(fx.root, '.manta/snapshots', snapDirs[0]!));
    expect(snaps).toContain('A.snapshot.json');
    expect(snaps).toContain('B.snapshot.json');

    // Worktrees retained
    for (const id of ['A', 'B']) {
      const wt = path.join(fx.root, '.manta/worktrees', `clone-${id}`);
      await expect(fs.access(wt)).resolves.toBeUndefined();
    }
  }, 28 * 60 * 1000);
});

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { probeClaudeBin } from './helpers/claudeBin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const cliBin = path.join(repoRoot, 'packages/manta-cli/dist/bin/manta.cjs');
const fixtureRoot = path.join(__dirname, 'fixtures', 'library-mode-package');

const FIXTURE_PACKAGE_NAME = '@manta-library/e2e-sample';
const FIXTURE_PACKAGE_VERSION = '0.1.0';
const FIXTURE_LIBRARY_MODE = 'e2e-sample-mode';

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureCliBuilt(): Promise<void> {
  if (await exists(cliBin)) return;
  const r = await execa('pnpm', ['-r', '--filter', 'manta...', 'build'], {
    cwd: repoRoot,
    reject: false,
    timeout: 5 * 60 * 1000,
  });
  if (r.exitCode !== 0) {
    throw new Error(`pnpm build for manta failed: ${r.stderr || r.stdout}`);
  }
}

async function packFixtureTarball(outDir: string): Promise<string> {
  // Pack the directory contents (NOT the directory itself) so the resulting
  // tarball matches the layout `manta install` extracts: manta-package.json at
  // root, then `modes/` and `skills/`. Shell out to the system `tar` because
  // @manta/e2e doesn't take the npm `tar` package as a dep (and we'd rather
  // not widen its closure for one fixture build).
  const tarballPath = path.join(outDir, `e2e-sample-${FIXTURE_PACKAGE_VERSION}.tgz`);
  const entries = (await fs.readdir(fixtureRoot)).filter((e) => !e.startsWith('.'));
  const r = await execa('tar', ['-czf', tarballPath, '-C', fixtureRoot, ...entries], {
    reject: false,
  });
  if (r.exitCode !== 0) {
    throw new Error(`tar -czf failed for fixture: ${r.stderr || r.stdout}`);
  }
  return tarballPath;
}

interface IsolatedRepo {
  repoDir: string;
  homeDir: string;
  cleanup: () => Promise<void>;
}

async function makeIsolatedRepo(prefix: string): Promise<IsolatedRepo> {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-repo-`));
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-home-`));
  // Per-test git repo so `manta install` / `manta cast` recognise it as a
  // proper checkout (Runtime.createRuntime validates `.git` exists).
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
  await execa('git', ['config', 'user.email', 'e2e@example.com'], { cwd: repoDir });
  await execa('git', ['config', 'user.name', 'Manta E2E'], { cwd: repoDir });
  // Empty commit so HEAD resolves cleanly for downstream tooling.
  await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repoDir });
  return {
    repoDir,
    homeDir,
    cleanup: async () => {
      await fs.rm(repoDir, { recursive: true, force: true });
      await fs.rm(homeDir, { recursive: true, force: true });
    },
  };
}

function envWithHome(homeDir: string): NodeJS.ProcessEnv {
  // HOME drives `os.homedir()` which LocalStore uses to root ~/.manta/library/.
  // Setting HOME (and macOS's USERPROFILE for parity) isolates the install
  // artifacts so concurrent test runs don't trample each other.
  return { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
}

describe('manta library preflight (always runs, no MANTA_E2E required)', () => {
  beforeAll(async () => {
    await ensureCliBuilt();
  }, 5 * 60 * 1000);

  it('manta --help lists install, uninstall, and library', async () => {
    const r = await execa('node', [cliBin, '--help'], { reject: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('install');
    expect(r.stdout).toContain('uninstall');
    expect(r.stdout).toContain('library');
  });

  it('manta install --help advertises the Chunk-2 flag matrix', async () => {
    const r = await execa('node', [cliBin, 'install', '--help'], { reject: false });
    expect(r.exitCode).toBe(0);
    for (const flag of ['--force', '--offline', '--integrity', '--json', '--dry-run', '--no-validate', '--no-hooks']) {
      expect(r.stdout).toContain(flag);
    }
  });

  it('manta library --help lists list/show/outdated/doctor subcommands', async () => {
    const r = await execa('node', [cliBin, 'library', '--help'], { reject: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('list');
    expect(r.stdout).toContain('show');
    expect(r.stdout).toContain('outdated');
    expect(r.stdout).toContain('doctor');
  });

  it('rejects --no-hooks=false at parse time with the hooks-not-yet-available message', async () => {
    const r = await execa(
      'node',
      [cliBin, 'install', '/tmp/never-resolved.tgz', '--no-hooks=false'],
      { reject: false },
    );
    expect(r.exitCode).toBe(11);
    expect(r.stderr).toContain('hooks distribution is not yet available');
  });

  it('manta library list --json on a fresh repo emits {installs: []} and exits 0', async () => {
    const fx = await makeIsolatedRepo('manta-library-preflight');
    try {
      const r = await execa('node', [cliBin, 'library', 'list', '--json'], {
        cwd: fx.repoDir,
        env: envWithHome(fx.homeDir),
        reject: false,
      });
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as { installs: unknown[] };
      expect(parsed.installs).toEqual([]);
    } finally {
      await fx.cleanup();
    }
  });
});

// Probe once at module load so the skip is VISIBLE in the reporter. A suite-level
// `describe.skipIf` reports as skipped (not a zero-assertion pass), so green CI can
// distinguish a real armed run from a no-op when claude is absent (H1).
const claude = await probeClaudeBin();
const noClaude = !claude.available;

describe.skipIf(noClaude)('manta library install + cast + uninstall round-trip (MANTA_E2E=1, real claude)', () => {
  let fx: IsolatedRepo | undefined;
  let suiteFailed = false;

  beforeAll(async () => {
    await ensureCliBuilt();
  }, 5 * 60 * 1000);

  afterEach((ctx) => {
    if (ctx.task.result?.state === 'fail') suiteFailed = true;
  });

  afterAll(async () => {
    if (!fx) return;
    const force = process.env.MANTA_E2E_KEEP === '1';
    if (suiteFailed || force) {
      // eslint-disable-next-line no-console -- forensic signal for the human
      console.warn(
        `[manta-library.e2e] preserving evidence at ${fx.repoDir} (home=${fx.homeDir}; ${
          force ? 'MANTA_E2E_KEEP=1' : 'test failed'
        })`,
      );
      return;
    }
    await fx.cleanup();
  });

  it('install → library list → cast --dry-run → real cast → uninstall', async () => {
    fx = await makeIsolatedRepo('manta-library-e2e');
    const env = envWithHome(fx.homeDir);

    // Step 1: build the fixture tarball in a tmp dir.
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-library-e2e-stage-'));
    let tarballPath: string;
    try {
      tarballPath = await packFixtureTarball(stagingDir);

      // Step 2: install. Use --no-validate=false (default), exercise the full
      // happy path through validation.
      const installR = await execa('node', [cliBin, 'install', tarballPath, '--json'], {
        cwd: fx.repoDir,
        env,
        reject: false,
        timeout: 60_000,
      });
      expect(installR.exitCode, installR.stderr || installR.stdout).toBe(0);
      const installJson = JSON.parse(installR.stdout) as { name: string; version: string };
      expect(installJson.name).toBe(FIXTURE_PACKAGE_NAME);
      expect(installJson.version).toBe(FIXTURE_PACKAGE_VERSION);

      // Lockfile must exist with the entry; install dir must exist under HOME.
      const lockfilePath = path.join(fx.repoDir, 'manta-lock.json');
      expect(await exists(lockfilePath)).toBe(true);
      const lockRaw = await fs.readFile(lockfilePath, 'utf8');
      const lock = JSON.parse(lockRaw) as {
        packages: Record<string, { version: string; directoryDigest: string }>;
      };
      expect(lock.packages[FIXTURE_PACKAGE_NAME]).toBeDefined();
      expect(lock.packages[FIXTURE_PACKAGE_NAME]!.version).toBe(FIXTURE_PACKAGE_VERSION);
      expect(lock.packages[FIXTURE_PACKAGE_NAME]!.directoryDigest).toMatch(/^sha256-/);

      const installPath = path.join(
        fx.homeDir,
        '.manta',
        'library',
        '@manta-library',
        'e2e-sample',
        FIXTURE_PACKAGE_VERSION,
      );
      expect(await exists(path.join(installPath, 'manta-package.json'))).toBe(true);

      // Step 3: library list --json includes the install.
      const listR = await execa('node', [cliBin, 'library', 'list', '--json'], {
        cwd: fx.repoDir,
        env,
        reject: false,
      });
      expect(listR.exitCode, listR.stderr).toBe(0);
      const listJson = JSON.parse(listR.stdout) as {
        installs: Array<{ packageName: string; modes: string[] }>;
      };
      expect(listJson.installs).toHaveLength(1);
      expect(listJson.installs[0]!.packageName).toBe(FIXTURE_PACKAGE_NAME);
      expect(listJson.installs[0]!.modes).toContain(FIXTURE_LIBRARY_MODE);

      // Step 4: cast --dry-run on the library mode. Asserts the mode resolved
      // through the library + the dry-run preview succeeded. (#M7: the budget/
      // charges system was removed, so there is no `--no-charge-check` flag and
      // no cost preview anymore — dry-run just validates + previews the plan.)
      const dryR = await execa(
        'node',
        [
          cliBin,
          'cast',
          FIXTURE_LIBRARY_MODE,
          '--clones',
          '2',
          '--task',
          'e2e library-mode dry-run',
          '--dry-run',
          '--max-files-changed',
          '1',
        ],
        { cwd: fx.repoDir, env, reject: false, timeout: 60_000 },
      );
      expect(dryR.exitCode, dryR.stderr).toBe(0);
      const dryOut = dryR.stdout + '\n' + dryR.stderr;
      // Cast --dry-run previews the plan; the library-mode path must have
      // resolved to the recon-swarm dispatcher (basedOn). The CLI prints
      // "dry run complete for cast …" (space, not hyphen), so match either form.
      expect(dryOut.toLowerCase()).toMatch(/dry[ -]run/);

      // #71: the cast's MCP pre-flight runs `claude mcp get manta-bus`. This
      // round-trip isolates HOME (to sandbox the library install dir under
      // ~/.manta/library/), which ALSO hides the dev machine's user-scope bus
      // registration — so without this the pre-flight aborts the cast with "no
      // MCP servers configured". Register the bus in the fixture repo's project
      // .mcp.json so the pre-flight resolves it (exit 0); clones still boot from
      // the spawner's own curated MCP profile, not this file.
      const busServer = path.join(repoRoot, 'packages/manta-bus/dist/bin/server.cjs');
      await fs.writeFile(
        path.join(fx.repoDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            'manta-bus': {
              type: 'stdio',
              command: 'node',
              args: [busServer],
              env: { MANTA_REPO_ROOT: fx.repoDir },
            },
          },
        }),
        'utf8',
      );

      // Step 5: real cast — small budget, single clone, claude must produce
      // a deliverable artifact. We don't grade the artifact (same convention
      // as recon-swarm.e2e.test.ts); we only verify the lifecycle reaches DEAD.
      const tickBudgetMs = 1_500_000; // 25 min ceiling
      const castR = await execa(
        'node',
        [
          cliBin,
          'cast',
          FIXTURE_LIBRARY_MODE,
          '--clones',
          '2',
          '--task',
          'Map every export under src/. Produce docs/library-e2e.md.',
          '--cycle-interval-ms',
          '5000',
          '--tick-budget-ms',
          String(tickBudgetMs),
          '--max-files-changed',
          '5',
        ],
        { cwd: fx.repoDir, env, reject: false, timeout: 28 * 60 * 1000 },
      );
      if (castR.exitCode !== 0) {
        // eslint-disable-next-line no-console -- diagnosis aid on real-claude failure
        console.error('cast stdout:\n', castR.stdout);
        // eslint-disable-next-line no-console -- diagnosis aid on real-claude failure
        console.error('cast stderr:\n', castR.stderr);
      }
      expect(castR.exitCode).toBe(0);

      const { busPaths, Registry, systemClock } = await import('@manta/bus');
      const reg = new Registry(busPaths(fx.repoDir), systemClock);
      const clones = await reg.list();
      expect(clones.length).toBeGreaterThanOrEqual(2);
      for (const c of clones) expect(c.state).toBe('DEAD');

      // Step 6: uninstall while clones are DEAD — must succeed without --force.
      const unR = await execa(
        'node',
        [cliBin, 'uninstall', `${FIXTURE_PACKAGE_NAME}@${FIXTURE_PACKAGE_VERSION}`, '--json'],
        { cwd: fx.repoDir, env, reject: false, timeout: 60_000 },
      );
      expect(unR.exitCode, unR.stderr).toBe(0);
      expect(await exists(installPath)).toBe(false);
      const lockAfter = JSON.parse(await fs.readFile(lockfilePath, 'utf8')) as {
        packages: Record<string, unknown>;
      };
      expect(lockAfter.packages[FIXTURE_PACKAGE_NAME]).toBeUndefined();
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  }, 28 * 60 * 1000);
});

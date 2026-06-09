import { describe, it, expect, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { probeClaudeBin } from './helpers/claudeBin.js';
import { makeSampleRepo, type SampleRepoFixture } from './helpers/sampleRepo.js';

// NOTE on @manta/* imports: like the sibling e2e suites, every workspace-package import
// is DYNAMIC and lives INSIDE a test body, after the skip guard. The packages resolve to
// their built `dist/`, which does not exist in a fresh worktree until `pnpm build`. A
// top-level static import would force `dist` to exist at module-load and break the clean
// skip (the unit gate runs without building dist). `mangle` is imported the same way — it
// is the REAL primitive cast.ts uses to place the fork (`manta` re-exports it from
// session-fork.ts); re-implementing it here would risk drifting from Claude Code's on-disk
// scheme, the exact make-or-break failure mode this e2e exists to catch.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cliBin = path.join(repoRoot, 'packages/manta-cli/dist/bin/manta.cjs');

// Claude Code keeps every live transcript under `~/.claude/projects/`. session-fork.ts
// deliberately does NOT read CLAUDE_CONFIG_DIR (unverified in `claude --help`), so the
// real fork source is derived from this exact home. We mirror that here — if the curator
// runs against a relocated config home, both this seed and the spawner would need the same
// (tracked as a deferred follow-up in the plan §5 «relocated ~/.claude» row).
const claudeHome = path.join(os.homedir(), '.claude');

function sha256File(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Files ending `.jsonl` inside a Claude project dir (the transcript forks). */
async function listForkJsonl(projectDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(projectDir);
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith('.jsonl'));
}

/**
 * Run a `manta cast recon-swarm` (2 clones) with a STARTING-liveness guard (bug #3
 * regression: a cast that never moves clones off STARTING used to hang vitest for
 * 30 min). Mirrors the recon-swarm.e2e skeleton. `env` is the FULL child environment
 * (extendEnv:false) so each it() controls MANTA_PARENT_SESSION_ID / CLAUDE_CODE_SESSION_ID
 * exactly — the positive flow arms inheritance, the negative control disarms it, and
 * neither leaks the e2e-runner's own CLAUDE_CODE_SESSION_ID into the child.
 */
async function runReconCast(opts: {
  repoCwd: string;
  task: string;
  env: NodeJS.ProcessEnv;
  mode?: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; observedCastId?: string }> {
  const tickBudgetMs = 1_500_000; // 25 min ceiling — keep in lockstep with --tick-budget-ms
  const heartbeatBudgetMs = tickBudgetMs / 4; // positive-liveness budget
  const expectedCloneCount = 2;

  const castProc = execa(
    'node',
    [
      // Inheritance is mode-agnostic — it lives in the shared forkParentSession
      // primitive every clone of every mode goes through. The mode is
      // parametrized so the suite can prove inheritance across mode types
      // (recon-swarm = read; forking-realities = write/branch).
      cliBin, 'cast', opts.mode ?? 'recon-swarm',
      '--clones', String(expectedCloneCount),
      '--task', opts.task,
      // The clone must be allowed to write token.txt at its worktree root. recon-swarm
      // is normally a read/map mode; allowed-paths='.' + a small file cap make the write
      // legal under the task contract.
      '--allowed-paths', '.',
      '--max-files-changed', '5',
      '--cycle-interval-ms', '5000',
      '--tick-budget-ms', String(tickBudgetMs),
    ],
    { cwd: opts.repoCwd, reject: false, timeout: 28 * 60 * 1000, env: opts.env, extendEnv: false },
  );

  const { busPaths, Registry, systemClock } = await import('@manta/bus');
  const watcherRegistry = new Registry(busPaths(opts.repoCwd), systemClock);

  let observedCastId: string | undefined;
  let metStartingMilestone = false;
  const startedAt = Date.now();

  const timelineRecorder = (async () => {
    while (castProc.exitCode == null && Date.now() - startedAt < tickBudgetMs) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      let clones;
      try {
        clones = await watcherRegistry.list();
      } catch {
        continue;
      }
      if (!observedCastId) {
        const withCast = clones.find((c) => typeof c.metadata?.cast_id === 'string');
        if (withCast) observedCastId = withCast.metadata.cast_id;
      }
      if (
        !metStartingMilestone &&
        clones.length === expectedCloneCount &&
        clones.every((c) => c.state !== 'STARTING')
      ) {
        metStartingMilestone = true;
      }
      if (!metStartingMilestone && Date.now() - startedAt >= heartbeatBudgetMs) {
        let final;
        try {
          final = await watcherRegistry.list();
        } catch (e) {
          final = `<registry unreadable: ${(e as Error).message}>`;
        }
        castProc.kill('SIGTERM');
        throw new Error(
          `e2e timeline assertion: not all clones transitioned off STARTING within ${heartbeatBudgetMs}ms; registry=${JSON.stringify(final)}`,
        );
      }
    }
  })();

  let r: Awaited<typeof castProc> | undefined;
  let recorderError: unknown;
  try {
    const settled = await Promise.all([castProc, timelineRecorder]);
    r = settled[0];
  } catch (e) {
    recorderError = e;
    try {
      r = await castProc;
    } catch {
      // castProc already rejected; recorderError will be rethrown below
    }
  }
  if (recorderError) throw recorderError;
  if (!r) throw new Error('cast process did not produce a result');

  // #70: under exactOptionalPropertyTypes, `observedCastId?: string` rejects an
  // explicit `undefined` — omit the key when unset instead of assigning undefined.
  return {
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    ...(observedCastId !== undefined ? { observedCastId } : {}),
  };
}

/**
 * The acceptance test that actually matters (plan §1): a fact lives ONLY in the parent
 * conversation — never in the task, priming, snapshot arrays, or any file — and a spawned
 * clone reproduces it. A flag-assertion test is worthless here (it passes even while clones
 * are subagents). This proof is SEMANTIC: the clone recalls parent-only content.
 *
 * DIVISION OF LABOR: this suite is AUTHORED here but SKIPS in the unit gate (MANTA_E2E unset
 * → probeClaudeBin returns available:false → `describe.skipIf` reports a VISIBLE skip, not a
 * zero-assertion pass). The CURATOR runs it armed
 * (MANTA_E2E=1 + real claude) post-merge; a clone must NOT run it (it spawns a nested
 * `manta cast` = cast-within-a-cast, forbidden, and costs real money). ANTI-THEATER: when
 * armed, every assertion runs and fails loudly on mismatch; there is no assertion-free happy
 * path, and the negative control is what stops a pass for the wrong reason.
 */
// Probe once at module load so the skip is VISIBLE in the reporter. A suite-level
// `describe.skipIf` reports as skipped (not a zero-assertion pass), so green CI can
// distinguish a real armed run from a no-op when claude is absent (H1).
const claude = await probeClaudeBin();
const noClaude = !claude.available;

describe.skipIf(noClaude)('transcript inheritance end-to-end against real claude', () => {
  let fxPositive: SampleRepoFixture | undefined;
  let fxNegative: SampleRepoFixture | undefined;
  let fxForking: SampleRepoFixture | undefined;
  let suiteFailed = false;

  afterEach((ctx) => {
    if (ctx.task.result?.state === 'fail') suiteFailed = true;
  });

  afterAll(async () => {
    const force = process.env.MANTA_E2E_KEEP === '1';
    for (const fx of [fxPositive, fxNegative, fxForking]) {
      if (!fx) continue;
      if (suiteFailed || force) {
        console.warn(
          `[transcript-inheritance.e2e] preserving evidence at ${fx.root} (${
            force ? 'MANTA_E2E_KEEP=1' : 'test failed'
          }) — inspect token.txt under .manta/worktrees, the parent/fork JSONLs under ${claudeHome}/projects, docs/post-mortems`,
        );
        continue;
      }
      await fx.cleanup();
    }
  });

  it('positive flow: clones reproduce a parent-only token via forked-transcript --resume (plan steps 1-5)', async () => {
    const bin = claude.path ?? 'claude';
    // Dynamic, post-guard (see top-of-file note): resolves to the built dist.
    const { mangle } = await import('manta');
    fxPositive = await makeSampleRepo();
    const repoCwd = fxPositive.root;

    // ── Step 1: seed a throwaway parent conversation. The token lives ONLY here. ──
    // cwd MUST be repoCwd: cast.ts forks from `mangle(rt.repoRoot)` (cast.ts:607), and the
    // repo root the cast runs in is this fixture root, so the parent transcript must land in
    // the same project dir the spawner will copy from.
    const PARENT_UUID = randomUUID();
    const TOKEN = `MANTA_E2E_${randomBytes(6).toString('hex')}`; // 12 hex chars
    const seed = await execa(
      bin,
      [
        '--print',
        '--session-id', PARENT_UUID,
        '--model', 'haiku',
        '--permission-mode', 'bypassPermissions',
        `Remember this exact build token for later: ${TOKEN}. Reply with only the word ACK.`,
      ],
      { cwd: repoCwd, reject: false, timeout: 5 * 60 * 1000 },
    );
    if (seed.exitCode !== 0) {
      console.error('seed stdout:\n', seed.stdout);
      console.error('seed stderr:\n', seed.stderr);
    }
    expect(seed.exitCode).toBe(0);

    const parentJsonl = path.join(claudeHome, 'projects', mangle(repoCwd), `${PARENT_UUID}.jsonl`);
    const parentStatBefore = await fs.stat(parentJsonl);
    expect(parentStatBefore.isFile()).toBe(true);
    const parentHashBefore = sha256File(await fs.readFile(parentJsonl));
    // Guard the whole premise: the token must NOT already be sitting in any file the clone
    // can read. It exists solely inside the parent JSONL conversation records.
    expect((await fs.readFile(parentJsonl, 'utf8')).includes(TOKEN)).toBe(true);

    // ── Step 2: real spawner spine — cast 2 clones, arming inheritance via env. ──
    // FLAG (for the curator): recon-swarm is normally a read/map mode. If its priming biases
    // the clone away from writing token.txt (e.g. it insists on producing docs/recon.md), the
    // crux assertion below fails. The fix is to switch the cast to a write-capable mode
    // (e.g. forking-realities) — do NOT silently change it here; surface it and let the curator
    // adjust the contract. Per Chunk-5 instructions: flag, don't switch modes.
    const baseEnv: NodeJS.ProcessEnv = { ...process.env };
    delete baseEnv.CLAUDE_CODE_SESSION_ID; // don't let the e2e-runner's own session leak in
    delete baseEnv.MANTA_PARENT_SESSION_ID;
    const positiveTask =
      'Earlier in this conversation you were told an exact build token to remember (a string ' +
      'starting with MANTA_E2E_). Write that exact token — and nothing else — into a file named ' +
      'token.txt at the root of your worktree, then graceful-death. If you genuinely do not recall ' +
      'any such token, write the single word NONE into token.txt instead.';

    const cast = await runReconCast({
      repoCwd,
      task: positiveTask,
      env: { ...baseEnv, MANTA_PARENT_SESSION_ID: PARENT_UUID },
    });
    if (cast.exitCode !== 0) {
      console.error('cast stdout:\n', cast.stdout);
      console.error('cast stderr:\n', cast.stderr);
    }
    expect(cast.exitCode).toBe(0);

    const { busPaths, Registry, EventsLog, systemClock } = await import('@manta/bus');
    const paths = busPaths(repoCwd);
    const registry = new Registry(paths, systemClock);
    const clones = await registry.list();
    expect(clones).toHaveLength(2);
    for (const c of clones) expect(c.state).toBe('DEAD');

    // ── Step 3 (THE CRUX): each clone's token.txt is the EXACT parent-only token. ──
    // The token was never in the task, priming, snapshot, or any file the clone could read —
    // only in the parent conversation. A match is only possible via transcript inheritance.
    // Worktrees are cast-scoped (`clone-<castId>-<id>`) so concurrent casts can't
    // collide; derive the path from each clone's own registry record.
    for (const c of clones) {
      const castId = c.metadata?.cast_id as string | undefined;
      const tokenPath = path.join(
        repoCwd,
        '.manta/worktrees',
        `clone-${castId}-${c.clone_id}`,
        'token.txt',
      );
      const body = (await fs.readFile(tokenPath, 'utf8')).trim();
      expect(body).toContain(TOKEN);
    }

    // ── Step 4: non-corruption — parent JSONL byte-identical; forks distinct files. ──
    const parentHashAfter = sha256File(await fs.readFile(parentJsonl));
    expect(parentHashAfter).toBe(parentHashBefore);

    const castIdA = clones.find((c) => c.clone_id === 'A')?.metadata?.cast_id as string;
    const castIdB = clones.find((c) => c.clone_id === 'B')?.metadata?.cast_id as string;
    const forkDirA = path.join(claudeHome, 'projects', mangle(path.join(repoCwd, '.manta/worktrees', `clone-${castIdA}-A`)));
    const forkDirB = path.join(claudeHome, 'projects', mangle(path.join(repoCwd, '.manta/worktrees', `clone-${castIdB}-B`)));
    const forksA = await listForkJsonl(forkDirA);
    const forksB = await listForkJsonl(forkDirB);
    expect(forksA.length).toBeGreaterThanOrEqual(1);
    expect(forksB.length).toBeGreaterThanOrEqual(1);
    // Forks live in distinct per-clone project dirs (distinct cwds → distinct mangle) and carry
    // fresh uuids, so no fork can be the parent file or another clone's fork.
    expect(forkDirA).not.toBe(forkDirB);
    const forkAbs = new Set([
      ...forksA.map((f) => path.join(forkDirA, f)),
      ...forksB.map((f) => path.join(forkDirB, f)),
    ]);
    expect(forkAbs.has(parentJsonl)).toBe(false);
    expect(forkAbs.size).toBe(forksA.length + forksB.length); // all distinct paths

    // ── Step 5: priming coexistence — --resume AND --append-system-prompt both applied. ──
    // Step 3 already proves --resume (the token came through the forked transcript). This step
    // proves --append-system-prompt was ALSO applied (not silently dropped by --resume) — that is
    // what makes a clone a Manta clone and not a vanilla resumed session.
    //
    // We deliberately do NOT require a *specific* startup-ceremony step from *every* clone. Manta's
    // own hard rule (docs/internals/claude-code-pitfalls.md): priming text is a SOFT PRIOR — clones
    // run under it but do not deterministically perform any one ceremony step. Observed live: clone A
    // acked its contract while clone B skipped straight to work; a per-clone `contract_ack` assertion
    // would be testing soft-prior compliance, not the CLI-arg coexistence we care about. The bug this
    // guards (--resume drops --append-system-prompt) is a per-process arg interaction: if it bit, a
    // clone would emit ZERO Manta lifecycle events and the orchestrator reaper — not the clone — would
    // mark it DEAD. So we assert two grounded signals instead.
    const events = await new EventsLog(paths, systemClock).readAll();

    // (A) Cast-level, the uniquely-attributable priming signal: at least one contract_ack. Acking
    // requires reading manta.task_contract (written by the spawner for THIS cast, absent from the
    // parent transcript) and calling manta.ack_contract — both introduced ONLY by the appended Manta
    // system prompt. It cannot come from a --resume-only session nor be inherited from the parent
    // conversation, so a single ack proves priming coexisted with --resume.
    expect(events.some((e) => e.type === 'contract_ack')).toBe(true);

    // (B) Per-clone, robust to soft-prior variance: each clone emitted ≥1 clone-driven Manta
    // lifecycle event. Every type below is appended ONLY when a clone calls the matching manta.* MCP
    // tool, all of which exist solely because of the appended system prompt. None is emitted by the
    // spawner or orchestrator on a clone's behalf — the spawner writes the registry record and task
    // contract directly (no event), and the reaper emits `reaped`, not these. So any one of them,
    // tagged with a clone's id, proves that clone ran under Manta priming, regardless of which
    // ceremony steps it happened to follow.
    const CLONE_DRIVEN_EVENTS = new Set([
      'heartbeat', 'contract_ack', 'contract_refresh', 'suicide_intent', 'zk_write', 'death',
      'drift_report', 'claim', 'release', 'lock', 'unlock', 'renew_lock', 'para_append',
      'broadcast', 'message',
    ]);
    for (const id of ['A', 'B']) {
      const ranUnderPriming = events.some(
        (e) => e.clone_id === id && CLONE_DRIVEN_EVENTS.has(e.type),
      );
      expect(ranUnderPriming).toBe(true);
    }
  }, 35 * 60 * 1000);

  it('cross-mode: forking-realities clones also inherit context (write-mode, same fork primitive)', async () => {
    // Inheritance lives in the shared forkParentSession primitive (called per-clone
    // before any mode-specific logic), so a STRUCTURALLY DIFFERENT mode — forking
    // (write/branch, per-clone overlays, sibling isolation) vs recon (read) — must
    // inherit identically. Same sentinel-recall proof.
    const bin = claude.path ?? 'claude';
    const { mangle } = await import('manta');
    fxForking = await makeSampleRepo();
    const repoCwd = fxForking.root;

    const PARENT_UUID = randomUUID();
    const TOKEN = `MANTA_E2E_${randomBytes(6).toString('hex')}`;
    const seed = await execa(
      bin,
      ['--print', '--session-id', PARENT_UUID, '--model', 'haiku', '--permission-mode', 'bypassPermissions',
        `Remember this exact build token for later: ${TOKEN}. Reply with only the word ACK.`],
      { cwd: repoCwd, reject: false, timeout: 5 * 60 * 1000 },
    );
    expect(seed.exitCode).toBe(0);
    const parentJsonl = path.join(claudeHome, 'projects', mangle(repoCwd), `${PARENT_UUID}.jsonl`);
    expect((await fs.readFile(parentJsonl, 'utf8')).includes(TOKEN)).toBe(true);

    const baseEnv: NodeJS.ProcessEnv = { ...process.env };
    delete baseEnv.CLAUDE_CODE_SESSION_ID;
    delete baseEnv.MANTA_PARENT_SESSION_ID;
    const task =
      'Earlier in this conversation you were told an exact build token to remember (a string ' +
      'starting with MANTA_E2E_). Write that exact token — and nothing else — into a file named ' +
      'token.txt at the root of your worktree, then graceful-death. If you genuinely do not recall ' +
      'any such token, write the single word NONE into token.txt instead.';

    const cast = await runReconCast({
      repoCwd,
      task,
      mode: 'forking-realities',
      env: { ...baseEnv, MANTA_PARENT_SESSION_ID: PARENT_UUID },
    });
    if (cast.exitCode !== 0) {
      console.error('forking cast stdout:\n', cast.stdout);
      console.error('forking cast stderr:\n', cast.stderr);
    }
    expect(cast.exitCode).toBe(0);

    const { busPaths, Registry, systemClock } = await import('@manta/bus');
    const clones = await new Registry(busPaths(repoCwd), systemClock).list();
    expect(clones).toHaveLength(2);
    for (const c of clones) {
      expect(c.state).toBe('DEAD');
      const castId = c.metadata?.cast_id as string | undefined;
      const tokenPath = path.join(repoCwd, '.manta/worktrees', `clone-${castId}-${c.clone_id}`, 'token.txt');
      const body = (await fs.readFile(tokenPath, 'utf8')).trim();
      expect(body).toContain(TOKEN);
    }
  }, 35 * 60 * 1000);

  it('negative control: same setup with inheritance disarmed → clones write NONE (plan step 6)', async () => {
    const bin = claude.path ?? 'claude';
    fxNegative = await makeSampleRepo();
    const repoCwd = fxNegative.root;

    // Seed an identical parent (token on disk) so the ONLY variable vs. the positive flow is
    // whether the cast is given the parent id. This is what makes it a control, not a different
    // experiment: same token, same task — inheritance simply disarmed.
    const PARENT_UUID = randomUUID();
    const TOKEN = `MANTA_E2E_${randomBytes(6).toString('hex')}`;
    const seed = await execa(
      bin,
      [
        '--print',
        '--session-id', PARENT_UUID,
        '--model', 'haiku',
        '--permission-mode', 'bypassPermissions',
        `Remember this exact build token for later: ${TOKEN}. Reply with only the word ACK.`,
      ],
      { cwd: repoCwd, reject: false, timeout: 5 * 60 * 1000 },
    );
    expect(seed.exitCode).toBe(0);

    // Disarm inheritance: NO parent id reaches the cast (no flag, both env tiers cleared) →
    // resolveParentSessionId yields resumeEnabled=false → no fork → empty-context clones.
    const baseEnv: NodeJS.ProcessEnv = { ...process.env };
    delete baseEnv.CLAUDE_CODE_SESSION_ID;
    delete baseEnv.MANTA_PARENT_SESSION_ID;
    const negativeTask =
      'Earlier in this conversation you were told an exact build token to remember (a string ' +
      'starting with MANTA_E2E_). Write that exact token — and nothing else — into a file named ' +
      'token.txt at the root of your worktree, then graceful-death. If you genuinely do not recall ' +
      'any such token, write the single word NONE into token.txt instead.';

    const cast = await runReconCast({ repoCwd, task: negativeTask, env: baseEnv });
    if (cast.exitCode !== 0) {
      console.error('cast stdout:\n', cast.stdout);
      console.error('cast stderr:\n', cast.stderr);
    }
    expect(cast.exitCode).toBe(0);

    // The snapshot proves the mechanism was OFF: resumeEnabled=false for the spawned clones.
    // The fixture is a fresh makeSampleRepo() repo running exactly one cast, so exactly one
    // `cast-*` snapshot dir must exist — asserting === 1 (not >= 1) pins that invariant so a
    // future fixture-reuse can't make snapDirs[0] read an arbitrary, unsorted, stale snapshot.
    const snapDirs = (await fs.readdir(path.join(repoCwd, '.manta/snapshots')))
      .filter((d) => d.startsWith('cast-'));
    expect(snapDirs).toHaveLength(1);
    const snapRaw = await fs.readFile(
      path.join(repoCwd, '.manta/snapshots', snapDirs[0]!, 'A.snapshot.json'),
      'utf8',
    );
    expect((JSON.parse(snapRaw) as { resumeEnabled: boolean }).resumeEnabled).toBe(false);

    // The crux of the control: with inheritance disarmed the clone CANNOT produce the token.
    // It writes NONE (or at minimum, never the seeded token). A token here would mean the
    // positive result was luck/leakage, not inheritance.
    // Worktrees are cast-scoped (`clone-<castId>-<id>`); resolve each by suffix.
    const wtRoot = path.join(repoCwd, '.manta/worktrees');
    const wtEntries = await fs.readdir(wtRoot);
    for (const id of ['A', 'B']) {
      const dir = wtEntries.find((e) => e.startsWith('clone-') && e.endsWith(`-${id}`));
      const tokenPath = path.join(wtRoot, dir!, 'token.txt');
      const body = (await fs.readFile(tokenPath, 'utf8')).trim();
      expect(body).not.toContain(TOKEN);
      expect(body).toContain('NONE');
    }
  }, 35 * 60 * 1000);
});

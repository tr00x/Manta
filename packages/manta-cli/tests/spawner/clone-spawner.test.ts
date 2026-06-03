import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import {
  spawnClone,
  runFakeCloneScript,
  runClaudeCli,
  runClaudeResume,
  classifyFirstTurnFailure,
  type CastsCreator,
} from '../../src/spawner/clone-spawner.js';
import type { CastManifest, CreateCastInput } from '@manta/bus';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { makeRegistryFake } from '../helpers/registryFake.js';
import { makeSnapshotFor } from '../helpers/snapshotFixture.js';

function makeFakeCasts(opts?: { rejectWith?: Error }): {
  creator: CastsCreator;
  calls: CreateCastInput[];
} {
  const calls: CreateCastInput[] = [];
  return {
    creator: {
      create(input) {
        calls.push(input);
        if (opts?.rejectWith) return Promise.reject(opts.rejectWith);
        const manifest: CastManifest = {
          version: 1,
          cast_id: input.cast_id,
          mode: input.mode,
          clones: input.clones,
          policy: input.policy,
          created_at: 1700000000000,
        };
        return Promise.resolve(manifest);
      },
    },
    calls,
  };
}

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-clone.mjs',
);

// #M16: surface a clone's first-turn failure (billing/auth/quota/model/spawn)
// from its captured output instead of a silent STARTING→grace reap.
describe('classifyFirstTurnFailure (bug #M16)', () => {
  it('classifies the credit/billing case (the ANTHROPIC_API_KEY=$0 trap)', () => {
    const r = classifyFirstTurnFailure('API error 400: {"message":"Credit balance is too low"}');
    expect(r).toMatch(/credit\/billing/);
    expect(r).toMatch(/ANTHROPIC_API_KEY/);
  });
  it('classifies auth, rate/quota, model, and spawn failures', () => {
    expect(classifyFirstTurnFailure('401 Unauthorized: invalid api key')).toMatch(/auth/);
    expect(classifyFirstTurnFailure('429 rate limit exceeded')).toMatch(/rate\/quota/);
    expect(classifyFirstTurnFailure('model claude-x does not exist')).toMatch(/model/);
    expect(classifyFirstTurnFailure('spawn claude ENOENT')).toMatch(/spawn/);
  });
  it('returns null for unknown / empty output (caller surfaces the raw tail)', () => {
    expect(classifyFirstTurnFailure('some unrelated log line')).toBeNull();
    expect(classifyFirstTurnFailure('')).toBeNull();
    expect(classifyFirstTurnFailure(undefined)).toBeNull();
  });
});

describe('clone-spawner', () => {
  let fx: RepoFixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('spawnClone runs the runner with snapshot path injected via env', async () => {
    fx = await makeRepoFixture();
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'A', castId: 'cast-1' }),
      worktree: fx.root,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      registry: makeRegistryFake(),
      casts: makeFakeCasts().creator,
      castMode: 'recon-swarm',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
      castRoster: [{ clone_id: 'A', assignment: null }],
    });
    expect(handle.cloneId).toBe('A');
    expect(handle.snapshotPath).toContain(fx.root);
    expect(typeof handle.pid).toBe('number');
    const result = await handle.exit;
    expect(result.code).toBe(0);
  });

  it('spawnClone propagates non-zero exit', async () => {
    fx = await makeRepoFixture();
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'B', castId: 'cast-1' }),
      worktree: fx.root,
      runner: runFakeCloneScript({
        scriptPath: fixturePath,
        env: { MANTA_FAKE_CLONE_STATE: 'fail' },
      }),
      registry: makeRegistryFake(),
      casts: makeFakeCasts().creator,
      castMode: 'recon-swarm',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
      castRoster: [{ clone_id: 'A', assignment: null }],
    });
    const result = await handle.exit;
    expect(result.code).toBe(2);
  });

  it('spawnClone supports kill via signal', async () => {
    fx = await makeRepoFixture();
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'C', castId: 'cast-1' }),
      worktree: fx.root,
      runner: runFakeCloneScript({
        scriptPath: fixturePath,
        env: { MANTA_FAKE_CLONE_STATE: 'hang' },
      }),
      registry: makeRegistryFake(),
      casts: makeFakeCasts().creator,
      castMode: 'recon-swarm',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
      castRoster: [{ clone_id: 'A', assignment: null }],
    });
    handle.kill('SIGTERM');
    const result = await handle.exit;
    expect(result.signal).toBe('SIGTERM');
  });

  // I-1 regression: when the runner fails to start (ENOENT — non-existent
  // binary), `execa({ reject: false })` resolves with `failed: true` and
  // exitCode == null. Without the I-1 fix this masks as `{ code: null,
  // signal: null }` and the cast loop hangs waiting for a heartbeat.
  it('spawnClone surfaces runner spawn failure (ENOENT) as CliError spawn_failed', async () => {
    fx = await makeRepoFixture();
    // Point at a binary that does not exist; execa with reject:false will
    // resolve with `failed: true, exitCode: undefined, signal: undefined`
    // (the spawn ENOENT path). The runtime must surface that as spawn_failed.
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'X', castId: 'cast-1' }),
      worktree: fx.root,
      runner: runClaudeCli({ claudeBin: '/no/such/binary/manta-test-xyzabc' }),
      registry: makeRegistryFake(),
      casts: makeFakeCasts().creator,
      castMode: 'recon-swarm',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
      castRoster: [{ clone_id: 'A', assignment: null }],
    });
    await expect(handle.exit).rejects.toMatchObject({
      name: 'CliError',
      kind: 'spawn_failed',
    });
  });

  // I-5 regression: terminate sends SIGTERM, then SIGKILL after gracefulMs.
  // The 'hang' fake-clone never exits on its own, so the only way the exit
  // promise resolves is via signal. We use a short gracefulMs so the test
  // doesn't sit on the default 5s.
  it('terminate escalates SIGTERM → SIGKILL when child ignores the term signal', async () => {
    fx = await makeRepoFixture();
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'T', castId: 'cast-1' }),
      worktree: fx.root,
      runner: runFakeCloneScript({
        scriptPath: fixturePath,
        env: { MANTA_FAKE_CLONE_STATE: 'hang' },
      }),
      registry: makeRegistryFake(),
      casts: makeFakeCasts().creator,
      castMode: 'recon-swarm',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
      castRoster: [{ clone_id: 'A', assignment: null }],
    });
    const result = await handle.terminate({ gracefulMs: 50 });
    // Child must have died via a signal (SIGTERM if it ignored it briefly,
    // or SIGKILL if SIGTERM took longer than 50ms).
    expect(result.signal === 'SIGTERM' || result.signal === 'SIGKILL').toBe(true);
  });

  it('spawnClone writes the snapshot to a deterministic path under .manta/snapshots/', async () => {
    fx = await makeRepoFixture();
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'D', castId: 'cast-1' }),
      worktree: fx.root,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      registry: makeRegistryFake(),
      casts: makeFakeCasts().creator,
      castMode: 'recon-swarm',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
      castRoster: [{ clone_id: 'A', assignment: null }],
    });
    expect(handle.snapshotPath).toMatch(/\.manta\/snapshots\/cast-1\/D\.snapshot\.json$/);
    await handle.exit;
  });

  // Phase-1 lockdown: argv must use real claude flags, never the dead `--snapshot`
  // and never `--strict-mcp-config` (which would cut off user-scope manta-bus MCP).
  it('production runClaudeCli argv does NOT contain dead --snapshot flag (bug #3/#4 regression guard)', async () => {
    fx = await makeRepoFixture();
    const captured: string[][] = [];
    const probeRunner = {
      run(input: { cwd: string; env: Record<string, string>; appendSystemPrompt: string; prompt: string }) {
        // Build the same argv runClaudeCli would, then capture and short-circuit.
        const argv = [
          '--print',
          '--append-system-prompt',
          input.appendSystemPrompt,
          '--permission-mode',
          'bypassPermissions',
          input.prompt,
        ];
        captured.push(argv);
        // Return a successful no-op child.
        return execa(process.execPath, ['-e', 'process.exit(0)'], { reject: false });
      },
    };
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'F', castId: 'cast-1' }),
      worktree: fx.root,
      runner: probeRunner,
      registry: makeRegistryFake(),
      casts: makeFakeCasts().creator,
      castMode: 'recon-swarm',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
      castRoster: [{ clone_id: 'A', assignment: null }],
    });
    await handle.exit;
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toContain('--snapshot');
    expect(captured[0]).not.toContain('--strict-mcp-config');
    expect(captured[0]).toContain('--append-system-prompt');
    expect(captured[0]).toContain('--permission-mode');
    expect(captured[0]).toContain('bypassPermissions');
  });

  it('injects MANTA_BUS_PEER_SCOPE=parent-only for forking-realities clones', async () => {
    fx = await makeRepoFixture();
    let capturedEnv: Record<string, string> | undefined;
    const envRunner = {
      run(input: { cwd: string; env: Record<string, string>; appendSystemPrompt: string; prompt: string }) {
        capturedEnv = input.env;
        return execa(process.execPath, ['-e', 'process.exit(0)'], { reject: false });
      },
    };
    await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'A', castId: 'cast-fr-env', mode: 'forking-realities' }),
      worktree: fx.root,
      runner: envRunner,
      registry: makeRegistryFake(),
      casts: makeFakeCasts().creator,
      castMode: 'forking-realities',
      castPolicy: { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: 'batch' },
      castRoster: [{ clone_id: 'A', assignment: null }],
    });
    expect(capturedEnv?.MANTA_BUS_PEER_SCOPE).toBe('parent-only');
  });

  it('injects MANTA_BUS_PEER_SCOPE=siblings-allowed for recon-swarm clones', async () => {
    fx = await makeRepoFixture();
    let capturedEnv: Record<string, string> | undefined;
    const envRunner = {
      run(input: { cwd: string; env: Record<string, string>; appendSystemPrompt: string; prompt: string }) {
        capturedEnv = input.env;
        return execa(process.execPath, ['-e', 'process.exit(0)'], { reject: false });
      },
    };
    await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'A', castId: 'cast-rs-env' }),
      worktree: fx.root,
      runner: envRunner,
      registry: makeRegistryFake(),
      casts: makeFakeCasts().creator,
      castMode: 'recon-swarm',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
      castRoster: [{ clone_id: 'A', assignment: null }],
    });
    expect(capturedEnv?.MANTA_BUS_PEER_SCOPE).toBe('siblings-allowed');
  });

  it('writes the cast manifest input identically across two spawnClone calls', async () => {
    fx = await makeRepoFixture();
    const reg = makeRegistryFake();
    const casts = makeFakeCasts();
    const roster = [
      { clone_id: 'A', assignment: null },
      { clone_id: 'B', assignment: null },
    ];
    const policy = { peer_messaging: 'allowed' as const, auto_merge_threshold: null, session_mode: 'batch' as const };
    const snapA = makeSnapshotFor({ cloneId: 'A', castId: 'cast-spawn-1' });
    const snapB = makeSnapshotFor({ cloneId: 'B', castId: 'cast-spawn-1' });
    await spawnClone({
      repoRoot: fx.root,
      snapshot: snapA,
      worktree: fx.root,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      registry: reg,
      casts: casts.creator,
      castMode: 'recon-swarm',
      castPolicy: policy,
      castRoster: roster,
    });
    await spawnClone({
      repoRoot: fx.root,
      snapshot: snapB,
      worktree: fx.root,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      registry: reg,
      casts: casts.creator,
      castMode: 'recon-swarm',
      castPolicy: policy,
      castRoster: roster,
    });
    expect(casts.calls).toHaveLength(2);
    expect(casts.calls[0]).toEqual(casts.calls[1]);
    expect(casts.calls[0]!.cast_id).toBe('cast-spawn-1');
  });

  it('throws CliError(register_failed) with cause when casts.create rejects', async () => {
    fx = await makeRepoFixture();
    const reg = makeRegistryFake();
    const cause = new Error('disk full');
    const casts = makeFakeCasts({ rejectWith: cause });
    const snap = makeSnapshotFor({ cloneId: 'A', castId: 'cast-spawn-2' });
    await expect(
      spawnClone({
        repoRoot: fx.root,
        snapshot: snap,
        worktree: fx.root,
        runner: runFakeCloneScript({ scriptPath: fixturePath }),
        registry: reg,
        casts: casts.creator,
        castMode: 'recon-swarm',
        castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
        castRoster: [{ clone_id: 'A', assignment: null }],
      }),
    ).rejects.toMatchObject({ kind: 'register_failed' });
    // Registry record was already written before casts.create — verify no
    // best-effort rollback (cleanup is cast.ts's concern, not the spawner's).
    expect(reg.records.find((r) => r.clone_id === 'A')).toBeDefined();
  });

  it('passes metadata.cast_mode and metadata.cast_id to registry.register', async () => {
    fx = await makeRepoFixture();
    const captured: { clone_id: string; metadata?: Record<string, string> }[] = [];
    const reg = makeRegistryFake({
      onRegister(input) {
        captured.push({ clone_id: input.clone_id, metadata: input.metadata });
      },
    });
    const casts = makeFakeCasts();
    const snap = makeSnapshotFor({ cloneId: 'A', castId: 'cast-spawn-3' });
    await spawnClone({
      repoRoot: fx.root,
      snapshot: snap,
      worktree: fx.root,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      registry: reg,
      casts: casts.creator,
      castMode: 'forking-realities',
      castPolicy: { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: 'batch' },
      castRoster: [{ clone_id: 'A', assignment: null }],
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.metadata).toEqual({
      cast_id: 'cast-spawn-3',
      cast_mode: 'forking-realities',
      // bug #M11: role is recorded so the death-detector can spare a reviewer
      // that's legitimately waiting on its writer. Empty when no role assigned.
      role: '',
    });
  });

  it('passes metadata.role from the contract approachHint (bug #M11)', async () => {
    fx = await makeRepoFixture();
    const captured: { clone_id: string; metadata?: Record<string, string> }[] = [];
    const reg = makeRegistryFake({
      onRegister(input) {
        captured.push({ clone_id: input.clone_id, metadata: input.metadata });
      },
    });
    const casts = makeFakeCasts();
    const snap = makeSnapshotFor({ cloneId: 'B', castId: 'cast-pair-1', approachHint: 'reviewer' });
    await spawnClone({
      repoRoot: fx.root,
      snapshot: snap,
      worktree: fx.root,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      registry: reg,
      casts: casts.creator,
      castMode: 'pair-programming',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
      castRoster: [{ clone_id: 'B', assignment: null }],
    });
    expect(captured[0]!.metadata?.role).toBe('reviewer');
  });

  // #M11: a daemon clone's initial turn must run under the resumable session id
  // (so runDaemonLoop can `--resume` it later) and the handle must expose a
  // resumeSpec carrying byte-identical env/priming for the resume path. Batch
  // clones get neither.
  it('daemon clone runs under resumableSessionId and exposes a resumeSpec (bug #M11)', async () => {
    fx = await makeRepoFixture();
    const seenInputs: Array<{ sessionId: string | undefined; mcpConfigPath: string | undefined }> = [];
    const realRunner = runFakeCloneScript({ scriptPath: fixturePath });
    const capturingRunner = {
      run(input: Parameters<typeof realRunner.run>[0]) {
        seenInputs.push({ sessionId: input.sessionId, mcpConfigPath: input.mcpConfigPath });
        return realRunner.run(input);
      },
    };
    const snap = makeSnapshotFor({
      cloneId: 'B',
      castId: 'cast-pair-2',
      approachHint: 'reviewer',
      sessionMode: 'daemon',
      sessionId: 'cast-pair-2-B-uuid',
    });
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: snap,
      worktree: fx.root,
      runner: capturingRunner,
      registry: makeRegistryFake(),
      casts: makeFakeCasts().creator,
      castMode: 'pair-programming',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'daemon' },
      castRoster: [{ clone_id: 'B', assignment: null }],
      resumableSessionId: 'cast-pair-2-B-uuid',
    });
    await handle.exit;
    // initial turn pinned to the resumable session id
    expect(seenInputs[0]!.sessionId).toBe('cast-pair-2-B-uuid');
    // resumeSpec is present and complete
    expect(handle.isDaemon).toBe(true);
    expect(handle.resumeSpec).toBeDefined();
    expect(handle.resumeSpec!.sessionId).toBe('cast-pair-2-B-uuid');
    expect(handle.resumeSpec!.worktree).toBe(fx.root);
    expect(handle.resumeSpec!.env.MANTA_CLONE_ID).toBe('B');
    expect(handle.resumeSpec!.appendSystemPrompt.length).toBeGreaterThan(0);
  });

  it('batch clone gets NO resumeSpec and no pinned session id (regression)', async () => {
    fx = await makeRepoFixture();
    const seenInputs: Array<{ sessionId: string | undefined }> = [];
    const realRunner = runFakeCloneScript({ scriptPath: fixturePath });
    const capturingRunner = {
      run(input: Parameters<typeof realRunner.run>[0]) {
        seenInputs.push({ sessionId: input.sessionId });
        return realRunner.run(input);
      },
    };
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'A', castId: 'cast-batch-1' }),
      worktree: fx.root,
      runner: capturingRunner,
      registry: makeRegistryFake(),
      casts: makeFakeCasts().creator,
      castMode: 'recon-swarm',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
      castRoster: [{ clone_id: 'A', assignment: null }],
      // no resumableSessionId for batch
    });
    await handle.exit;
    expect(seenInputs[0]!.sessionId).toBeUndefined();
    expect(handle.resumeSpec).toBeUndefined();
    expect(handle.isDaemon).toBe(false);
  });

  it('runClaudeCli passes --session-id when provided in input', async () => {
    const runner = runClaudeCli({ claudeBin: '/usr/bin/echo' });
    const proc = runner.run({
      cwd: '/tmp',
      env: {},
      appendSystemPrompt: 'test-prompt',
      prompt: 'hello',
      sessionId: 'sess-123',
    });
    expect(proc.spawnargs).toContain('--session-id');
    expect(proc.spawnargs).toContain('sess-123');
    await proc;
  });

  it('runClaudeCli omits --session-id when not provided', async () => {
    const runner = runClaudeCli({ claudeBin: '/usr/bin/echo' });
    const proc = runner.run({
      cwd: '/tmp',
      env: {},
      appendSystemPrompt: 'test-prompt',
      prompt: 'hello',
    });
    expect(proc.spawnargs).not.toContain('--session-id');
    await proc;
  });

  it('runClaudeResume passes --resume with session-id', async () => {
    const runner = runClaudeResume({ claudeBin: '/usr/bin/echo', sessionId: 'sess-456' });
    const proc = runner.run({
      cwd: '/tmp',
      env: {},
      appendSystemPrompt: 'test-prompt',
      prompt: 'new-task',
    });
    expect(proc.spawnargs).toContain('--resume');
    expect(proc.spawnargs).toContain('sess-456');
    expect(proc.spawnargs).toContain('--print');
    await proc;
  });

  it('CloneHandle.isDaemon is false for batch snapshots', async () => {
    fx = await makeRepoFixture();
    const handle = await spawnClone({
      repoRoot: fx.root,
      snapshot: makeSnapshotFor({ cloneId: 'A', castId: 'cast-batch' }),
      worktree: fx.root,
      runner: runFakeCloneScript({ scriptPath: fixturePath }),
      registry: makeRegistryFake(),
      casts: makeFakeCasts().creator,
      castMode: 'recon-swarm',
      castPolicy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
      castRoster: [{ clone_id: 'A', assignment: null }],
    });
    expect(handle.isDaemon).toBe(false);
    expect(handle.sessionId).toBeUndefined();
    await handle.exit;
  });
});

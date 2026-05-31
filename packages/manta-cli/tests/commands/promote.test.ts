import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runPromoteCommand } from '../../src/commands/promote.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';
import { addWorktree } from '../../src/spawner/worktree.js';
import { isCliError } from '../../src/errors.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

// H2 — `manta promote` is DESTRUCTIVE: it `git merge`s the winner into main,
// `git worktree move`s every loser into `.manta/graveyard`, and removes the
// winner's worktree+branch. These tests run against a THROWAWAY git repo with
// real worktrees and branches, then assert the REAL filesystem outcome — no
// execa mock, no stubbed "verified result". A green pass here means the disk
// actually changed the way the command claims it did.

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stand up a forking-realities cast on disk: a manifest, a `merge_review` event
 * carrying per-clone scores, and one real git worktree+branch per clone. Each
 * clone's branch gets a distinct committed file so a merge is observable and a
 * loser's graveyarded tree is identifiable.
 */
async function setupCast(
  rt: Runtime,
  fx: RepoFixture,
  castId: string,
  cloneIds: string[],
  scores: Record<string, number>,
): Promise<void> {
  await rt.ctx.casts.create({
    cast_id: castId,
    mode: 'forking-realities',
    clones: cloneIds.map((id) => ({ clone_id: id, assignment: null })),
    policy: {
      peer_messaging: 'denied',
      auto_merge_threshold: null,
      session_mode: 'batch',
    },
  });

  await rt.ctx.events.append({
    type: 'merge_review',
    payload: {
      cast_id: castId,
      scores: cloneIds.map((id) => ({ clone_id: id, score: scores[id] ?? 0 })),
    },
  });

  for (const id of cloneIds) {
    const branch = `manta/${castId}/${id}`;
    const { path: wt } = await addWorktree({
      repoRoot: fx.root,
      name: `clone-${id}`,
      branch,
    });
    await fs.writeFile(path.join(wt, `${id}.txt`), `content authored by clone ${id}\n`, 'utf8');
    await fx.run(['add', `${id}.txt`], wt);
    await fx.run(['commit', '-q', '-m', `clone ${id} work`], wt);
  }
}

describe('promote command', () => {
  let fx: RepoFixture | undefined;
  let rt: Runtime | undefined;
  afterEach(async () => {
    await rt?.dispose();
    await fx?.cleanup();
    fx = undefined;
    rt = undefined;
  });

  it('happy path: merges the winner into main, graveyards losers, removes winner worktree', async () => {
    fx = await makeRepoFixture('manta-promote-');
    rt = await createRuntime({ repoRoot: fx.root });
    const castId = 'cast-promote-happy';
    await setupCast(rt, fx, castId, ['A', 'B'], { A: 0.9, B: 0.4 });

    const sink = new MemorySink();
    const result = await runPromoteCommand(rt, {
      castId,
      cloneId: 'A',
      reporter: createReporter({ sink }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Promoted clone A');

    // ── Winner's content really landed on main ──────────────────────────
    expect(await exists(path.join(fx.root, 'A.txt'))).toBe(true);
    // ── The loser's branch was NOT merged ───────────────────────────────
    expect(await exists(path.join(fx.root, 'B.txt'))).toBe(false);

    // ── A real --no-ff merge commit exists on main ──────────────────────
    const { stdout: merges } = await fx.run(['log', '--merges', '--oneline']);
    expect(merges).toContain('manta-merge: promote A');

    // ── Loser graveyarded: original worktree gone, graveyard entry present ──
    expect(await exists(path.join(fx.root, '.manta/worktrees/clone-B'))).toBe(false);
    const graveyardInfo = path.join(fx.root, '.manta/graveyard', `${castId}-B`, 'info.json');
    expect(await exists(graveyardInfo)).toBe(true);
    const info = JSON.parse(await fs.readFile(graveyardInfo, 'utf8')) as {
      cloneId: string;
      castId: string;
      originalBranch: string;
    };
    expect(info.cloneId).toBe('B');
    expect(info.castId).toBe(castId);
    expect(info.originalBranch).toBe(`manta/${castId}/B`);

    // ── Winner's worktree was cleaned up ────────────────────────────────
    expect(await exists(path.join(fx.root, '.manta/worktrees/clone-A'))).toBe(false);

    // ── A `promote` event was recorded with the winner + graveyarded losers ──
    const events = await rt.ctx.events.readAll();
    const promoteEvent = events.find((e) => e.type === 'promote');
    expect(promoteEvent).toBeDefined();
    const payload = promoteEvent!.payload as Record<string, unknown>;
    expect(payload.cast_id).toBe(castId);
    expect(payload.winner_clone_id).toBe('A');
    expect(payload.losers_graveyarded).toEqual(['B']);
  });

  it('guard: unknown castId throws not_found and changes nothing', async () => {
    fx = await makeRepoFixture('manta-promote-');
    rt = await createRuntime({ repoRoot: fx.root });

    await expect(
      runPromoteCommand(rt, {
        castId: 'cast-does-not-exist',
        cloneId: 'A',
        reporter: createReporter({ sink: new MemorySink() }),
      }),
    ).rejects.toMatchObject({ kind: 'not_found' });

    // No merge happened — main has no merge commits.
    const { stdout: merges } = await fx.run(['log', '--merges', '--oneline']);
    expect(merges.trim()).toBe('');
  });

  it('guard: cloneId not in the cast roster throws invalid_input', async () => {
    fx = await makeRepoFixture('manta-promote-');
    rt = await createRuntime({ repoRoot: fx.root });
    const castId = 'cast-promote-roster';
    await setupCast(rt, fx, castId, ['A', 'B'], { A: 0.9, B: 0.4 });

    let caught: unknown;
    try {
      await runPromoteCommand(rt, {
        castId,
        cloneId: 'Z',
        reporter: createReporter({ sink: new MemorySink() }),
      });
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    expect((caught as { kind: string }).kind).toBe('invalid_input');
    // The roster names are surfaced so the operator can self-correct.
    expect((caught as Error).message).toContain('roster');

    // Nothing merged.
    const { stdout: merges } = await fx.run(['log', '--merges', '--oneline']);
    expect(merges.trim()).toBe('');
  });

  it('guard: missing merge-review event throws invalid_input', async () => {
    fx = await makeRepoFixture('manta-promote-');
    rt = await createRuntime({ repoRoot: fx.root });
    const castId = 'cast-promote-noreview';
    // Roster + worktrees exist, but deliberately NO merge_review event.
    await rt.ctx.casts.create({
      cast_id: castId,
      mode: 'forking-realities',
      clones: [
        { clone_id: 'A', assignment: null },
        { clone_id: 'B', assignment: null },
      ],
      policy: { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: 'batch' },
    });

    await expect(
      runPromoteCommand(rt, {
        castId,
        cloneId: 'A',
        reporter: createReporter({ sink: new MemorySink() }),
      }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('guard: a second promote of an already-promoted cast fails — no silent double-merge', async () => {
    fx = await makeRepoFixture('manta-promote-');
    rt = await createRuntime({ repoRoot: fx.root });
    const castId = 'cast-promote-twice';
    await setupCast(rt, fx, castId, ['A', 'B'], { A: 0.9, B: 0.4 });

    // First promote succeeds and consumes the winner branch+worktree.
    await runPromoteCommand(rt, {
      castId,
      cloneId: 'A',
      reporter: createReporter({ sink: new MemorySink() }),
    });

    // Second promote: the winner branch was deleted, so the merge cannot run.
    // It must fail loudly rather than silently re-merging or corrupting state.
    let caught: unknown;
    try {
      await runPromoteCommand(rt, {
        castId,
        cloneId: 'A',
        reporter: createReporter({ sink: new MemorySink() }),
      });
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    expect((caught as { kind: string }).kind).toBe('cast_failed');

    // Exactly ONE merge commit on main — the double-promote did not stack a second.
    const { stdout: merges } = await fx.run(['log', '--merges', '--oneline']);
    const mergeLines = merges.trim().split('\n').filter((l) => l.length > 0);
    expect(mergeLines).toHaveLength(1);
  });
});

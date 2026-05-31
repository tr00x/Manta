import { execa } from 'execa';
import { BusNotFoundError } from '@manta/bus';
import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { CliError } from '../errors.js';
import { moveWorktreeToGraveyard } from '../spawner/graveyard.js';
import { removeWorktree } from '../spawner/worktree.js';

export interface RunPromoteOptions {
  castId: string;
  cloneId: string;
  reporter: Reporter;
}

export async function runPromoteCommand(
  rt: Runtime,
  opts: RunPromoteOptions,
): Promise<CommandResult> {
  // `casts.read` THROWS BusNotFoundError on a missing cast (it never resolves
  // null), so the unknown-castId guard must catch that and convert it to a
  // clean, typed CLI error — otherwise the internal bus error leaks to the
  // operator. (A bare `if (!manifest)` here was dead code: read() throws first.)
  let manifest;
  try {
    manifest = await rt.ctx.casts.read(opts.castId);
  } catch (err) {
    if (err instanceof BusNotFoundError) {
      throw new CliError(`cast not found: ${opts.castId}`, {
        kind: 'not_found',
        cause: err,
      });
    }
    throw err;
  }

  const rosterIds = manifest.clones.map((c) => c.clone_id);
  if (!rosterIds.includes(opts.cloneId)) {
    throw new CliError(
      `clone "${opts.cloneId}" is not in cast ${opts.castId} roster (${rosterIds.join(', ')})`,
      { kind: 'invalid_input' },
    );
  }

  const events = await rt.ctx.events.readAll();
  const reviewEvent = events.find(
    (e) =>
      e.type === 'merge_review' &&
      (e.payload as Record<string, unknown>)?.cast_id === opts.castId,
  );
  if (!reviewEvent) {
    throw new CliError(
      `no merge-review found for cast ${opts.castId}. Run merge-review first.`,
      { kind: 'invalid_input' },
    );
  }

  const scores = (reviewEvent.payload as Record<string, unknown>)?.scores as
    | Array<{ clone_id: string; score: number }>
    | undefined;
  const winnerScore = scores?.find((s) => s.clone_id === opts.cloneId)?.score;
  const scoreStr = winnerScore != null ? winnerScore.toFixed(3) : 'N/A';

  const winnerBranch = `manta/${opts.castId}/${opts.cloneId}`;
  try {
    await execa(
      'git',
      [
        'merge',
        winnerBranch,
        '--no-ff',
        '-m',
        `manta-merge: promote ${opts.cloneId} from cast ${opts.castId} (score ${scoreStr})`,
      ],
      { cwd: rt.repoRoot },
    );
  } catch (err) {
    throw new CliError(
      `git merge failed for branch ${winnerBranch}. Resolve conflicts manually.`,
      { kind: 'cast_failed', cause: err },
    );
  }

  const losers = rosterIds.filter((id) => id !== opts.cloneId);
  const graveyarded: string[] = [];

  for (const loserId of losers) {
    const loserBranch = `manta/${opts.castId}/${loserId}`;
    const worktreePath = `${rt.repoRoot}/.manta/worktrees/clone-${loserId}`;
    try {
      const { graveyardPath } = await moveWorktreeToGraveyard({
        repoRoot: rt.repoRoot,
        cloneId: loserId,
        castId: opts.castId,
        worktreePath,
        branch: loserBranch,
      });
      graveyarded.push(graveyardPath);
    } catch {
      opts.reporter.info('promote.graveyard_skip', {
        cloneId: loserId,
        reason: 'worktree move failed',
      });
    }
  }

  const winnerWorktree = `${rt.repoRoot}/.manta/worktrees/clone-${opts.cloneId}`;
  try {
    await removeWorktree({
      repoRoot: rt.repoRoot,
      worktreePath: winnerWorktree,
      branch: winnerBranch,
    });
  } catch {
    opts.reporter.info('promote.winner_cleanup_skip', {
      cloneId: opts.cloneId,
      reason: 'worktree removal failed',
    });
  }

  await rt.ctx.events.append({
    type: 'promote',
    payload: {
      cast_id: opts.castId,
      winner_clone_id: opts.cloneId,
      score: winnerScore ?? null,
      losers_graveyarded: losers,
    },
  });

  opts.reporter.info('promote', {
    castId: opts.castId,
    winner: opts.cloneId,
    score: scoreStr,
    graveyarded: graveyarded.length,
  });

  return {
    exitCode: 0,
    stdout: `Promoted clone ${opts.cloneId} from cast ${opts.castId} (score ${scoreStr}). ${graveyarded.length} loser(s) graveyarded.`,
  };
}

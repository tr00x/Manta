import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBusServer, systemClock } from '@manta/bus';

describe('cast-manifest integration', () => {
  it('survives handle restart via on-disk persistence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-cast-int-'));
    try {
      const h1 = await createBusServer({ repoRoot: dir, clock: systemClock });
      await h1.context.casts.create({
        cast_id: 'cast-int-1',
        mode: 'recon-swarm',
        clones: [
          { clone_id: 'A', assignment: null },
          { clone_id: 'B', assignment: null },
        ],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
      });
      // Simulate process exit + new handle pointing at the same dir.
      const h2 = await createBusServer({ repoRoot: dir, clock: systemClock });
      const round = await h2.context.casts.read('cast-int-1');
      expect(round.clones).toHaveLength(2);
      expect(round.mode).toBe('recon-swarm');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two concurrent create attempts on same cast_id resolve to one manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-cast-int-'));
    try {
      const h = await createBusServer({ repoRoot: dir, clock: systemClock });
      const input = {
        cast_id: 'cast-int-2',
        mode: 'recon-swarm' as const,
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed' as const, auto_merge_threshold: null, session_mode: 'batch' as const },
      };
      const [a, b] = await Promise.all([
        h.context.casts.create(input),
        h.context.casts.create(input),
      ]);
      expect(a.cast_id).toBe('cast-int-2');
      expect(b.cast_id).toBe('cast-int-2');
      // Mutex serialises; second call sees the first's write, returns the
      // existing record (preserving its created_at). Wallclock skew between
      // the two scheduling points cannot leak into either record.
      expect(a.created_at).toBe(b.created_at);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('list() returns every persisted manifest after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manta-cast-int-'));
    try {
      const h1 = await createBusServer({ repoRoot: dir, clock: systemClock });
      await h1.context.casts.create({
        cast_id: 'cast-list-1',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' },
      });
      await h1.context.casts.create({
        cast_id: 'cast-list-2',
        mode: 'forking-realities',
        clones: [
          { clone_id: 'A', assignment: { task: 'one' } },
          { clone_id: 'B', assignment: { task: 'two' } },
        ],
        policy: { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: 'batch' },
      });
      const h2 = await createBusServer({ repoRoot: dir, clock: systemClock });
      const all = await h2.context.casts.list();
      expect(all.map((m) => m.cast_id).sort()).toEqual(['cast-list-1', 'cast-list-2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CastManifestSchema,
  CastPolicySchema,
  CloneAssignmentSchema,
  CreateCastInputSchema,
} from '../../src/schema';
import { CastsStore } from '../../src/state/casts';
import { busPaths } from '../../src/state/paths';
import type { Clock } from '../../src/clock';

describe('CastPolicySchema', () => {
  it('accepts a recon-swarm-style policy', () => {
    expect(
      CastPolicySchema.parse({
        peer_messaging: 'allowed',
        auto_merge_threshold: null,
      }),
    ).toEqual({ peer_messaging: 'allowed', auto_merge_threshold: null });
  });

  it('accepts a forking-realities-style policy with a finite threshold', () => {
    const parsed = CastPolicySchema.parse({
      peer_messaging: 'denied',
      auto_merge_threshold: 0.3,
    });
    expect(parsed.peer_messaging).toBe('denied');
    expect(parsed.auto_merge_threshold).toBe(0.3);
  });

  it('rejects unknown peer_messaging values', () => {
    expect(() =>
      CastPolicySchema.parse({ peer_messaging: 'mostly', auto_merge_threshold: null }),
    ).toThrow();
  });

  it('rejects auto_merge_threshold outside [0, 1] when finite', () => {
    expect(() =>
      CastPolicySchema.parse({ peer_messaging: 'denied', auto_merge_threshold: 1.5 }),
    ).toThrow();
    expect(() =>
      CastPolicySchema.parse({ peer_messaging: 'denied', auto_merge_threshold: -0.1 }),
    ).toThrow();
  });
});

describe('CloneAssignmentSchema', () => {
  it('accepts a minimal assignment (task only)', () => {
    expect(CloneAssignmentSchema.parse({ task: 'do the thing' })).toEqual({ task: 'do the thing' });
  });

  it('accepts a full assignment', () => {
    const parsed = CloneAssignmentSchema.parse({
      task: 'rewrite the SQL query for performance',
      approach_hint: 'consider an index on orders.customer_id',
      scope: { allowed_paths: ['db/'], forbidden_paths: ['secrets/'], max_files_changed: 3 },
      budget_usd: 4.5,
      deadline_seconds: 900,
    });
    expect(parsed.task).toMatch(/SQL/);
    expect(parsed.scope?.max_files_changed).toBe(3);
    expect(parsed.budget_usd).toBe(4.5);
  });

  it('rejects empty task strings', () => {
    expect(() => CloneAssignmentSchema.parse({ task: '' })).toThrow();
  });

  it('rejects negative budget_usd', () => {
    expect(() =>
      CloneAssignmentSchema.parse({ task: 't', budget_usd: -0.01 }),
    ).toThrow();
  });
});

describe('CastManifestSchema', () => {
  it('accepts a recon-swarm manifest', () => {
    const parsed = CastManifestSchema.parse({
      version: 1,
      cast_id: 'cast-1700000000000',
      mode: 'recon-swarm',
      clones: [
        { clone_id: 'A', assignment: null },
        { clone_id: 'B', assignment: null },
      ],
      policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      created_at: 1700000000000,
    });
    expect(parsed.clones).toHaveLength(2);
  });

  it('accepts a forking-realities manifest with assignments', () => {
    const parsed = CastManifestSchema.parse({
      version: 1,
      cast_id: 'cast-1700000000001',
      mode: 'forking-realities',
      clones: [
        { clone_id: 'A', assignment: { task: 'algorithmic approach' } },
        { clone_id: 'B', assignment: { task: 'index-based approach' } },
        { clone_id: 'C', assignment: { task: 'denormalize approach' } },
      ],
      policy: { peer_messaging: 'denied', auto_merge_threshold: null },
      created_at: 1700000000001,
    });
    expect(parsed.policy.peer_messaging).toBe('denied');
  });

  it('rejects an empty roster', () => {
    expect(() =>
      CastManifestSchema.parse({
        version: 1,
        cast_id: 'cast-x',
        mode: 'recon-swarm',
        clones: [],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
        created_at: 1,
      }),
    ).toThrow();
  });

  it('rejects unsafe cast_id (allow-list pattern only)', () => {
    expect(() =>
      CastManifestSchema.parse({
        version: 1,
        cast_id: 'cast/../escape',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
        created_at: 1,
      }),
    ).toThrow();
  });

  it('rejects duplicate clone_ids in the roster', () => {
    expect(() =>
      CastManifestSchema.parse({
        version: 1,
        cast_id: 'cast-x',
        mode: 'recon-swarm',
        clones: [
          { clone_id: 'A', assignment: null },
          { clone_id: 'A', assignment: null },
        ],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
        created_at: 1,
      }),
    ).toThrow();
  });

  it('rejects malformed clone_id (allow-list pattern)', () => {
    expect(() =>
      CastManifestSchema.parse({
        version: 1,
        cast_id: 'cast-1',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A/B', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
        created_at: 1,
      }),
    ).toThrow();
  });
});

describe('CreateCastInputSchema', () => {
  it('accepts a recon-swarm input', () => {
    const parsed = CreateCastInputSchema.parse({
      cast_id: 'cast-1',
      mode: 'recon-swarm',
      clones: [
        { clone_id: 'A', assignment: null },
        { clone_id: 'B', assignment: null },
      ],
      policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
    });
    expect(parsed.mode).toBe('recon-swarm');
  });

  it('rejects extra keys (strict)', () => {
    expect(() =>
      CreateCastInputSchema.parse({
        cast_id: 'cast-1',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
        unknown_field: 'should not survive',
      }),
    ).toThrow();
  });
});

function tmpRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'manta-casts-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fixedClock(t: number): Clock {
  return { now: () => t };
}

describe('CastsStore.create', () => {
  it('writes a manifest and returns it', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const paths = busPaths(dir);
      const store = new CastsStore(paths, fixedClock(1700000000000));
      const manifest = await store.create({
        cast_id: 'cast-A',
        mode: 'recon-swarm',
        clones: [
          { clone_id: 'A', assignment: null },
          { clone_id: 'B', assignment: null },
        ],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      });
      expect(manifest.created_at).toBe(1700000000000);
      expect(manifest.clones).toHaveLength(2);
      // Persisted on disk under casts/<castId>.json:
      const round = await store.read('cast-A');
      expect(round).toEqual(manifest);
    } finally {
      cleanup();
    }
  });

  it('is idempotent on identical create calls', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1700000000000));
      const input = {
        cast_id: 'cast-B',
        mode: 'recon-swarm' as const,
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed' as const, auto_merge_threshold: null },
      };
      const a = await store.create(input);
      const b = await store.create(input);
      expect(a).toEqual(b);
    } finally {
      cleanup();
    }
  });

  it('rejects re-create with a different roster (BusConflictError)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await store.create({
        cast_id: 'cast-C',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      });
      await expect(
        store.create({
          cast_id: 'cast-C',
          mode: 'recon-swarm',
          clones: [
            { clone_id: 'A', assignment: null },
            { clone_id: 'B', assignment: null },
          ],
          policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
        }),
      ).rejects.toMatchObject({ name: 'BusConflictError' });
    } finally {
      cleanup();
    }
  });

  it('rejects re-create with a different mode (BusConflictError)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await store.create({
        cast_id: 'cast-D',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      });
      await expect(
        store.create({
          cast_id: 'cast-D',
          mode: 'forking-realities',
          clones: [{ clone_id: 'A', assignment: null }],
          policy: { peer_messaging: 'denied', auto_merge_threshold: null },
        }),
      ).rejects.toMatchObject({ name: 'BusConflictError' });
    } finally {
      cleanup();
    }
  });

  it('rejects re-create with a different policy (BusConflictError)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await store.create({
        cast_id: 'cast-E',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      });
      await expect(
        store.create({
          cast_id: 'cast-E',
          mode: 'recon-swarm',
          clones: [{ clone_id: 'A', assignment: null }],
          policy: { peer_messaging: 'denied', auto_merge_threshold: null },
        }),
      ).rejects.toMatchObject({ name: 'BusConflictError' });
    } finally {
      cleanup();
    }
  });

  it('preserves original created_at on idempotent re-create (clock-skew safe)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      let t = 1700000000000;
      const store = new CastsStore(busPaths(dir), { now: () => t });
      const input = {
        cast_id: 'cast-F',
        mode: 'recon-swarm' as const,
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed' as const, auto_merge_threshold: null },
      };
      const a = await store.create(input);
      t += 5_000;
      const b = await store.create(input); // idempotent: must keep a.created_at
      expect(b.created_at).toBe(a.created_at);
    } finally {
      cleanup();
    }
  });

  it('treats key-order-permuted assignments as identical (canonicalize)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await store.create({
        cast_id: 'cast-G',
        mode: 'forking-realities',
        clones: [{ clone_id: 'A', assignment: { task: 't', budget_usd: 5 } }],
        policy: { peer_messaging: 'denied', auto_merge_threshold: null },
      });
      // Same content, different key insertion order — must NOT be a conflict.
      await expect(
        store.create({
          cast_id: 'cast-G',
          mode: 'forking-realities',
          clones: [{ clone_id: 'A', assignment: { budget_usd: 5, task: 't' } }],
          policy: { peer_messaging: 'denied', auto_merge_threshold: null },
        }),
      ).resolves.toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('invokes auditAppend when provided (Phase 2c hook)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      const calls: string[] = [];
      await store.create(
        {
          cast_id: 'cast-H',
          mode: 'recon-swarm',
          clones: [{ clone_id: 'A', assignment: null }],
          policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
        },
        () => {
          calls.push('audit');
          return Promise.resolve();
        },
      );
      expect(calls).toEqual(['audit']);
    } finally {
      cleanup();
    }
  });
});

describe('CastsStore.read', () => {
  it('throws BusNotFoundError on missing cast_id', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await expect(store.read('cast-nope')).rejects.toMatchObject({ name: 'BusNotFoundError' });
    } finally {
      cleanup();
    }
  });
});

describe('CastsStore.list', () => {
  it('returns [] on a fresh repo', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      expect(await store.list()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('returns every persisted manifest', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await store.create({
        cast_id: 'cast-1',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null },
      });
      await store.create({
        cast_id: 'cast-2',
        mode: 'forking-realities',
        clones: [
          { clone_id: 'A', assignment: { task: 'one' } },
          { clone_id: 'B', assignment: { task: 'two' } },
        ],
        policy: { peer_messaging: 'denied', auto_merge_threshold: null },
      });
      const all = await store.list();
      expect(all.map((m) => m.cast_id).sort()).toEqual(['cast-1', 'cast-2']);
    } finally {
      cleanup();
    }
  });
});

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
    ).toEqual({ peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' });
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
      token_estimate: 4.5,
      deadline_seconds: 900,
    });
    expect(parsed.task).toMatch(/SQL/);
    expect(parsed.scope?.max_files_changed).toBe(3);
    expect(parsed.token_estimate).toBe(4.5);
  });

  it('rejects empty task strings', () => {
    expect(() => CloneAssignmentSchema.parse({ task: '' })).toThrow();
  });

  it('rejects negative token_estimate', () => {
    expect(() =>
      CloneAssignmentSchema.parse({ task: 't', token_estimate: -0.01 }),
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
      policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
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
      policy: { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: 'batch' as const },
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
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
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
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
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
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
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
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
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
      policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
    });
    expect(parsed.mode).toBe('recon-swarm');
  });

  it('rejects extra keys (strict)', () => {
    expect(() =>
      CreateCastInputSchema.parse({
        cast_id: 'cast-1',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
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
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
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
        policy: { peer_messaging: 'allowed' as const, auto_merge_threshold: null, session_mode: 'batch' as const },
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
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
      });
      await expect(
        store.create({
          cast_id: 'cast-C',
          mode: 'recon-swarm',
          clones: [
            { clone_id: 'A', assignment: null },
            { clone_id: 'B', assignment: null },
          ],
          policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
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
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
      });
      await expect(
        store.create({
          cast_id: 'cast-D',
          mode: 'forking-realities',
          clones: [{ clone_id: 'A', assignment: null }],
          policy: { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: 'batch' as const },
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
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
      });
      await expect(
        store.create({
          cast_id: 'cast-E',
          mode: 'recon-swarm',
          clones: [{ clone_id: 'A', assignment: null }],
          policy: { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: 'batch' as const },
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
        policy: { peer_messaging: 'allowed' as const, auto_merge_threshold: null, session_mode: 'batch' as const },
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
        clones: [{ clone_id: 'A', assignment: { task: 't', token_estimate: 5 } }],
        policy: { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: 'batch' as const },
      });
      // Same content, different key insertion order — must NOT be a conflict.
      await expect(
        store.create({
          cast_id: 'cast-G',
          mode: 'forking-realities',
          clones: [{ clone_id: 'A', assignment: { token_estimate: 5, task: 't' } }],
          policy: { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: 'batch' as const },
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
          policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
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

  it('does NOT invoke auditAppend on idempotent re-create (bug #14)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      const input = {
        cast_id: 'cast-I',
        mode: 'recon-swarm' as const,
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed' as const, auto_merge_threshold: null, session_mode: 'batch' as const },
      };
      const calls: string[] = [];
      const audit = (): Promise<void> => { calls.push('audit'); return Promise.resolve(); };
      await store.create(input, audit);
      await store.create(input, audit);
      await store.create(input, audit);
      expect(calls).toEqual(['audit']);
    } finally {
      cleanup();
    }
  });
});

describe('CastsStore metadata round-trip + cause-chain accessors (Task 1.9)', () => {
  it('persists metadata.cause_chain through create + read', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await store.create({
        cast_id: 'cast-meta',
        mode: 'bug-hunt',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: 'batch' as const },
        metadata: {
          trigger: { trigger_name: 'test-trigger', fired_at: 123, parent_cast_id: null },
          cause_chain: ['test-trigger'],
        },
      });
      const round = await store.read('cast-meta');
      expect(round.metadata?.cause_chain).toEqual(['test-trigger']);
      expect(round.metadata?.trigger?.trigger_name).toBe('test-trigger');
    } finally {
      cleanup();
    }
  });

  it('getCauseChain returns the stored chain', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await store.create({
        cast_id: 'cast-cc',
        mode: 'bug-hunt',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: 'batch' as const },
        metadata: {
          trigger: { trigger_name: 'tt', fired_at: 1, parent_cast_id: null },
          cause_chain: ['aa', 'bb'],
        },
      });
      expect(await store.getCauseChain('cast-cc')).toEqual(['aa', 'bb']);
    } finally {
      cleanup();
    }
  });

  it('getCauseChain returns [] when the cast has no metadata', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await store.create({
        cast_id: 'cast-nometa',
        mode: 'recon-swarm',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
      });
      expect(await store.getCauseChain('cast-nometa')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('getCauseChain returns [] for an unknown cast (no throw)', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      expect(await store.getCauseChain('cast-unknown')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('getTriggerName returns the name when present, null otherwise', async () => {
    const { dir, cleanup } = tmpRepo();
    try {
      const store = new CastsStore(busPaths(dir), fixedClock(1));
      await store.create({
        cast_id: 'cast-tn',
        mode: 'bug-hunt',
        clones: [{ clone_id: 'A', assignment: null }],
        policy: { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: 'batch' as const },
        metadata: { trigger: { trigger_name: 'the-trigger', fired_at: 1, parent_cast_id: null }, cause_chain: ['the-trigger'] },
      });
      expect(await store.getTriggerName('cast-tn')).toBe('the-trigger');
      expect(await store.getTriggerName('cast-unknown')).toBeNull();
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
        policy: { peer_messaging: 'allowed', auto_merge_threshold: null, session_mode: 'batch' as const },
      });
      await store.create({
        cast_id: 'cast-2',
        mode: 'forking-realities',
        clones: [
          { clone_id: 'A', assignment: { task: 'one' } },
          { clone_id: 'B', assignment: { task: 'two' } },
        ],
        policy: { peer_messaging: 'denied', auto_merge_threshold: null, session_mode: 'batch' as const },
      });
      const all = await store.list();
      expect(all.map((m) => m.cast_id).sort()).toEqual(['cast-1', 'cast-2']);
    } finally {
      cleanup();
    }
  });
});

import { describe, it, expect } from 'vitest';
import { CastOriginSchema } from '@manta/skill-validator';
import { buildCastOrigin } from '../../src/share/build-cast-origin.js';

const BUNDLED_AT = '2026-05-29T03:00:00Z';

function baseManifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    cast_id: 'cast-1780023574334',
    mode: 'forking-realities',
    created_at: 1780023574334,
    clones: [{ clone_id: 'B', assignment: null }],
    policy: {},
    ...extra,
  };
}

describe('buildCastOrigin', () => {
  it('user-fired cast (no metadata) → provenance null', () => {
    const { castOrigin, warnings } = buildCastOrigin({
      castManifest: baseManifest(),
      winningCloneId: 'B',
      repoRoot: '/repo',
      bundledAt: BUNDLED_AT,
      gitRemoteOrigin: null,
    });
    expect(castOrigin.provenance).toBeNull();
    expect(castOrigin.castId).toBe('cast-1780023574334');
    expect(castOrigin.castMode).toBe('forking-realities');
    expect(castOrigin.winningCloneId).toBe('B');
    expect(warnings).toEqual([]);
    expect(() => CastOriginSchema.parse(castOrigin)).not.toThrow();
  });

  it('trigger-fired cast → provenance populated, offset computed, causeChain verbatim', () => {
    const causeChain = ['c1', 'c2', 'c3'];
    const { castOrigin } = buildCastOrigin({
      castManifest: baseManifest({
        metadata: {
          trigger: {
            trigger_name: 'nightly-audit',
            fired_at: 1780023574334 + 5000,
            parent_cast_id: 'cast-parent-1',
          },
          cause_chain: causeChain,
        },
      }),
      winningCloneId: 'A',
      repoRoot: '/repo',
      bundledAt: BUNDLED_AT,
      gitRemoteOrigin: null,
    });
    expect(castOrigin.provenance).not.toBeNull();
    expect(castOrigin.provenance!.triggerName).toBe('nightly-audit');
    expect(castOrigin.provenance!.firedAtOffsetMs).toBe(5000);
    expect(castOrigin.provenance!.parentCastId).toBe('cast-parent-1');
    expect(castOrigin.provenance!.causeChain).toEqual(causeChain);
    expect(castOrigin.provenance!.causeChain).toHaveLength(3);
  });

  it('path-shaped git remote → originalRepoOrigin null + one warning, path never leaks', () => {
    const { castOrigin, warnings } = buildCastOrigin({
      castManifest: baseManifest(),
      winningCloneId: 'B',
      repoRoot: '/repo',
      bundledAt: BUNDLED_AT,
      gitRemoteOrigin: '/Users/x/repo',
    });
    expect(castOrigin.originalRepoOrigin).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.rule).toBe('castOrigin.originalRepoOrigin');
    expect(JSON.stringify(castOrigin)).not.toContain('/Users/x/repo');
  });

  it('url git remote → originalRepoOrigin set, no warning', () => {
    const { castOrigin, warnings } = buildCastOrigin({
      castManifest: baseManifest(),
      winningCloneId: 'B',
      repoRoot: '/repo',
      bundledAt: BUNDLED_AT,
      gitRemoteOrigin: 'https://github.com/u/r.git',
    });
    expect(castOrigin.originalRepoOrigin).toBe('https://github.com/u/r.git');
    expect(warnings).toEqual([]);
  });

  it('null git remote → originalRepoOrigin null, no warning (absent remote is normal)', () => {
    const { castOrigin, warnings } = buildCastOrigin({
      castManifest: baseManifest(),
      winningCloneId: 'B',
      repoRoot: '/repo',
      bundledAt: BUNDLED_AT,
      gitRemoteOrigin: null,
    });
    expect(castOrigin.originalRepoOrigin).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('output always validates against CastOriginSchema', () => {
    const { castOrigin } = buildCastOrigin({
      castManifest: baseManifest({
        metadata: {
          trigger: { trigger_name: 'xy', fired_at: 1780023574334, parent_cast_id: null },
          cause_chain: [],
        },
      }),
      winningCloneId: 'B',
      repoRoot: '/repo',
      bundledAt: BUNDLED_AT,
      gitRemoteOrigin: 'https://example.com/r',
    });
    expect(() => CastOriginSchema.parse(castOrigin)).not.toThrow();
  });
});

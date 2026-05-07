import { describe, it, expect } from 'vitest';
import { busPaths } from '../../src/state/paths';

describe('busPaths', () => {
  it('returns the canonical layout under the repo root', () => {
    const p = busPaths('/repo');
    expect(p.stateDir).toBe('/repo/.manta/state');
    expect(p.registry).toBe('/repo/.manta/state/registry.json');
    expect(p.locks).toBe('/repo/.manta/state/locks.json');
    expect(p.claims).toBe('/repo/.manta/state/claims.json');
    expect(p.eventsLog).toBe('/repo/.manta/state/events.jsonl');
    expect(p.contractsDir).toBe('/repo/.manta/state/contracts');
    expect(p.contractFile('A')).toBe('/repo/.manta/state/contracts/A.json');
    expect(p.lockfileDir).toBe('/repo/.manta/state/.locks');
  });

  it('rejects empty repo root', () => {
    expect(() => busPaths('')).toThrow(/repoRoot/);
  });

  it('rejects clone_id with path-traversal in contractFile', () => {
    const p = busPaths('/repo');
    expect(() => p.contractFile('../escape')).toThrow();
    expect(() => p.contractFile('a/b')).toThrow();
  });
});

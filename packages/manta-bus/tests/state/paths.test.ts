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
    expect(p.castsDir).toBe('/repo/.manta/state/casts');
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

  it('busPaths.castFile validates cast_id and joins under stateDir/casts', () => {
    const p = busPaths('/tmp/repo');
    expect(p.castFile('cast-1700000000000')).toBe(
      '/tmp/repo/.manta/state/casts/cast-1700000000000.json',
    );
    expect(() => p.castFile('cast/../bad')).toThrow();
  });

  it('busPaths.charges points to stateDir/charges.json', () => {
    const p = busPaths('/tmp/repo');
    expect(p.charges).toBe('/tmp/repo/.manta/state/charges.json');
  });

  it('busPaths.chargesLog points to stateDir/charges.log', () => {
    const p = busPaths('/tmp/repo');
    expect(p.chargesLog).toBe('/tmp/repo/.manta/state/charges.log');
  });

  it('busPaths.dailySpend points to stateDir/daily-spend.json', () => {
    const p = busPaths('/tmp/repo');
    expect(p.dailySpend).toBe('/tmp/repo/.manta/state/daily-spend.json');
  });

  it('busPaths.configDir points to .manta/config', () => {
    const p = busPaths('/tmp/repo');
    expect(p.configDir).toBe('/tmp/repo/.manta/config');
  });

  it('busPaths.budgetConfig points to configDir/budget.json', () => {
    const p = busPaths('/tmp/repo');
    expect(p.budgetConfig).toBe('/tmp/repo/.manta/config/budget.json');
  });
});

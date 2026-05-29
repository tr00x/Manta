import { describe, it, expect } from 'vitest';
import type { CastOrigin, SharedBundleManifest } from '@manta/skill-validator';
import { generateReadme } from '../../src/share/generate-readme.js';
import { scanForSecrets } from '../../src/share/secret-scanner.js';

function manifest(): SharedBundleManifest {
  return {
    schemaVersion: 1,
    name: '@scope/sample-mode',
    version: '1.2.3',
    description: 'A sample shared bundle for README tests.',
    author: 'Jane Tester',
    license: 'MIT',
    mantaVersionCompat: '^0.0.0',
    contributes: { skills: [], commands: [], modes: [], templates: [], hooks: [] },
    deps: {},
    castOrigin: castOrigin(null),
  };
}

function castOrigin(provenance: CastOrigin['provenance']): CastOrigin {
  return {
    castId: 'cast-1780023574334',
    castMode: 'forking-realities',
    originalRepoOrigin: null,
    originalMantaVersion: '0.0.0',
    bundledAt: '2026-05-29T03:00:00Z',
    winningCloneId: 'B',
    provenance,
  };
}

const base = {
  sanitizedPostMortem: '# Post-mortem\n\nThis mode bundles a sanitization pipeline.\n',
  sanitizedZkFirstParagraphs: ['Default-deny survives schema evolution.'],
  diffStats: { filesChanged: 7, insertions: 120, deletions: 8 },
};

describe('generateReadme', () => {
  it('contains all seven sections', () => {
    const out = generateReadme({ manifest: manifest(), castOrigin: castOrigin(null), ...base });
    for (const h of [
      'What this mode does',
      'Cast lineage',
      'Compatibility',
      'Installation',
      'Author',
      'License',
    ]) {
      expect(out).toContain(`## ${h}`);
    }
    expect(out).toContain('# @scope/sample-mode');
  });

  it('installation shows manta install <name>@<version>', () => {
    const out = generateReadme({ manifest: manifest(), castOrigin: castOrigin(null), ...base });
    expect(out).toContain('manta install @scope/sample-mode@1.2.3');
  });

  it('lineage shows trigger line only when provenance present', () => {
    const userFired = generateReadme({ manifest: manifest(), castOrigin: castOrigin(null), ...base });
    expect(userFired).not.toContain('Triggered by');

    const prov = castOrigin({
      triggerName: 'nightly-audit',
      firedAtOffsetMs: 1000,
      parentCastId: null,
      causeChain: [],
    });
    const m = manifest();
    m.castOrigin = prov;
    const triggered = generateReadme({ manifest: m, castOrigin: prov, ...base });
    expect(triggered).toContain('Triggered by: `nightly-audit`');
  });

  it('output has no secrets (consumes only sanitized inputs)', () => {
    const out = generateReadme({ manifest: manifest(), castOrigin: castOrigin(null), ...base });
    expect(scanForSecrets(out)).toEqual([]);
  });

  it('deterministic: same input → same output', () => {
    const a = generateReadme({ manifest: manifest(), castOrigin: castOrigin(null), ...base });
    const b = generateReadme({ manifest: manifest(), castOrigin: castOrigin(null), ...base });
    expect(a).toBe(b);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SharedBundleManifest } from '@manta/skill-validator';
import { assembleBundle, type BundleArtifacts } from '../../src/share/bundle-assembler.js';
import {
  publishBundle,
  type PublishRunner,
  type Confirmer,
  type PublishOptions,
} from '../../src/share/publish-flow.js';

const BUNDLED_AT = '2026-05-29T03:00:00Z';

function manifest(): SharedBundleManifest {
  return {
    schemaVersion: 1,
    name: '@manta-library/pub-sample',
    version: '1.0.0',
    description: 'A sample shared bundle used by the publish-flow gate tests.',
    author: 'tester',
    license: 'MIT',
    mantaVersionCompat: '^0.7.0',
    contributes: { skills: [{ name: 'pub-sample', description: 'demo' }], commands: [], modes: [], templates: [], hooks: [] },
    deps: {},
    castOrigin: {
      castId: 'cast-1780023574334',
      castMode: 'forking-realities',
      originalRepoOrigin: null,
      originalMantaVersion: '0.7.0',
      bundledAt: BUNDLED_AT,
      winningCloneId: 'B',
      provenance: null,
    },
  } as SharedBundleManifest;
}

function artifacts(): BundleArtifacts {
  return {
    manifest: manifest(),
    readme: '# pub-sample\n',
    license: 'MIT License\n',
    taskContract: { cloneId: 'B' },
    snapshot: { version: 1 },
    postMortems: [{ cloneId: 'B', markdown: '# pm\n' }],
    zkNotes: [],
    eventsJsonl: '',
    worktreeDiff: 'diff --git a/x b/x\n+ok\n',
    skills: [{ relPath: 'pub-sample/SKILL.md', content: '# skill\n' }],
  };
}

interface RecordingRunner extends PublishRunner {
  calls: string[];
}

function makeRunner(over: Partial<{ who: string | null; scopePkgs: string[]; publishThrows: boolean }> = {}): RecordingRunner {
  const calls: string[] = [];
  return {
    calls,
    whoami: async () => {
      calls.push('whoami');
      return over.who === undefined ? 'tester' : over.who;
    },
    listScopePackages: async (scope) => {
      calls.push(`listScopePackages:${scope}`);
      return over.scopePkgs ?? ['@manta-library/other'];
    },
    publish: async (tarballPath, opts) => {
      calls.push(`publish:${opts.access}`);
      if (over.publishThrows) throw new Error('npm publish failed');
    },
  };
}

function makeConfirmer(answers: boolean[]): Confirmer & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    confirm: async (prompt) => {
      prompts.push(prompt);
      const a = answers[i] ?? false;
      i += 1;
      return a;
    },
  };
}

let outDir: string;
let tarballPath: string;
let unpackedDir: string;

async function assemble(): Promise<void> {
  const a = await assembleBundle(artifacts(), { outDir, packageBaseName: 'pub-sample-1.0.0' });
  tarballPath = a.tarballPath;
  unpackedDir = a.unpackedDir;
}

function baseOpts(over: Partial<PublishOptions> = {}): PublishOptions {
  return {
    tarballPath,
    unpackedDir,
    manifest: manifest(),
    bundleJsFiles: [],
    runner: makeRunner(),
    confirmer: makeConfirmer([true, true]),
    ...over,
  };
}

beforeEach(async () => {
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-publish-'));
  await assemble();
});
afterEach(async () => {
  await fs.rm(outDir, { recursive: true, force: true });
});

describe('publishBundle — gate failures', () => {
  it('static scan with a block finding → scan_blocked; publish never called', async () => {
    const runner = makeRunner();
    const res = await publishBundle(
      baseOpts({ runner, bundleJsFiles: [{ relPath: 'skills/x/d.js', content: 'execSync(userInput);\n' }] }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'scan_blocked' });
    expect(runner.calls).not.toContain('publish:public');
    expect(runner.calls).toHaveLength(0); // scan is the FIRST gate
  });

  it('checksum mismatch → checksum_mismatch; publish never called', async () => {
    // Corrupt a payload file after assembly so verifyBundleChecksums fails.
    await fs.writeFile(path.join(unpackedDir, 'README.md'), '# tampered\n', 'utf8');
    const runner = makeRunner();
    const res = await publishBundle(baseOpts({ runner }));
    expect(res).toMatchObject({ ok: false, reason: 'checksum_mismatch' });
    expect(runner.calls).not.toContain('publish:public');
  });

  it('whoami null → not_logged_in; scope/publish never called', async () => {
    const runner = makeRunner({ who: null });
    const res = await publishBundle(baseOpts({ runner }));
    expect(res).toMatchObject({ ok: false, reason: 'not_logged_in' });
    expect(runner.calls).toContain('whoami');
    expect(runner.calls.some((c) => c.startsWith('listScopePackages'))).toBe(false);
  });

  it('scope not owned (empty list) → scope_not_owned; publish never called', async () => {
    const runner = makeRunner({ scopePkgs: [] });
    const res = await publishBundle(baseOpts({ runner }));
    expect(res).toMatchObject({ ok: false, reason: 'scope_not_owned' });
    expect(runner.calls).not.toContain('publish:public');
  });

  it('first confirmation declined → declined; publish never called', async () => {
    const runner = makeRunner();
    const confirmer = makeConfirmer([false]);
    const res = await publishBundle(baseOpts({ runner, confirmer }));
    expect(res).toMatchObject({ ok: false, reason: 'declined' });
    expect(confirmer.prompts).toHaveLength(1); // short-circuits after first decline
    expect(runner.calls).not.toContain('publish:public');
  });

  it('second confirmation declined → declined; publish never called', async () => {
    const runner = makeRunner();
    const confirmer = makeConfirmer([true, false]);
    const res = await publishBundle(baseOpts({ runner, confirmer }));
    expect(res).toMatchObject({ ok: false, reason: 'declined' });
    expect(confirmer.prompts).toHaveLength(2);
    expect(runner.calls).not.toContain('publish:public');
  });

  it('tarball larger than maxBytes → too_large; publish never called', async () => {
    const runner = makeRunner();
    const res = await publishBundle(baseOpts({ runner, maxBytes: 1 }));
    expect(res).toMatchObject({ ok: false, reason: 'too_large' });
    expect(runner.calls).not.toContain('publish:public');
  });
});

describe('publishBundle — happy path + order', () => {
  it('all gates pass + both confirms accepted → publishes once with access:public', async () => {
    const runner = makeRunner();
    const confirmer = makeConfirmer([true, true]);
    const res = await publishBundle(baseOpts({ runner, confirmer }));
    expect(res).toEqual({ ok: true, published: '@manta-library/pub-sample@1.0.0' });
    expect(runner.calls.filter((c) => c === 'publish:public')).toHaveLength(1);
  });

  it('confirmation prompts mention name@version, whoami, and PUBLIC/PERMANENT', async () => {
    const confirmer = makeConfirmer([true, true]);
    await publishBundle(baseOpts({ confirmer }));
    expect(confirmer.prompts[0]).toContain('@manta-library/pub-sample@1.0.0');
    expect(confirmer.prompts[0]).toContain('tester');
    expect(confirmer.prompts[1]).toMatch(/PUBLIC|PERMANENT/i);
  });

  it('gate order is scan → checksum → whoami → scope → confirms → size → publish', async () => {
    const runner = makeRunner();
    const confirmer = makeConfirmer([true, true]);
    await publishBundle(baseOpts({ runner, confirmer }));
    // whoami precedes scope precedes publish in the recorded call order.
    const whoamiIdx = runner.calls.indexOf('whoami');
    const scopeIdx = runner.calls.findIndex((c) => c.startsWith('listScopePackages'));
    const publishIdx = runner.calls.indexOf('publish:public');
    expect(whoamiIdx).toBeGreaterThanOrEqual(0);
    expect(scopeIdx).toBeGreaterThan(whoamiIdx);
    expect(publishIdx).toBeGreaterThan(scopeIdx);
  });

  it('a throw from runner.publish propagates (no reason code covers a network failure)', async () => {
    const runner = makeRunner({ publishThrows: true });
    await expect(publishBundle(baseOpts({ runner }))).rejects.toThrow();
  });
});

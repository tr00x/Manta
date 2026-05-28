import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as tar from 'tar';
import { buildSampleTarball } from '../fixtures/library/build-sample.js';
import {
  createRegistryClient,
  RegistryClientError,
  type NetworkRunner,
} from '../../src/library/registry-client.js';

let workDir: string;
let fixtureTarball: string;

beforeAll(async () => {
  fixtureTarball = await buildSampleTarball();
});

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-registry-client-test-'));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

function fakeRunner(opts: {
  npmPack?: (spec: string, opts: { cwd: string }) => Promise<string>;
  gitClone?: (opts: { url: string; ref?: string; dest: string }) => Promise<void>;
}): NetworkRunner {
  return {
    async npmPack(spec, options) {
      if (!opts.npmPack) throw new Error('npmPack not stubbed');
      return opts.npmPack(spec, options);
    },
    async gitClone(options) {
      if (!opts.gitClone) throw new Error('gitClone not stubbed');
      return opts.gitClone(options);
    },
  };
}

describe('parseSpec', () => {
  const client = createRegistryClient({ runner: fakeRunner({}) });

  it('parses a scoped npm name with version range', () => {
    expect(client.parseSpec('@manta-library/foo@^1.0')).toEqual({
      kind: 'npm',
      npmName: '@manta-library/foo',
      npmRange: '^1.0',
    });
  });

  it('parses a scoped npm name without version', () => {
    expect(client.parseSpec('@manta-library/foo')).toEqual({
      kind: 'npm',
      npmName: '@manta-library/foo',
      npmRange: undefined,
    });
  });

  it('parses a bare npm name', () => {
    expect(client.parseSpec('foo@1.2.3')).toEqual({
      kind: 'npm',
      npmName: 'foo',
      npmRange: '1.2.3',
    });
  });

  it('parses a git+https URL with ref', () => {
    expect(client.parseSpec('git+https://github.com/u/r#v1.2.3')).toEqual({
      kind: 'git',
      gitUrl: 'https://github.com/u/r',
      gitRef: 'v1.2.3',
    });
  });

  it('parses a git+https URL without ref', () => {
    expect(client.parseSpec('git+https://github.com/u/r')).toEqual({
      kind: 'git',
      gitUrl: 'https://github.com/u/r',
      gitRef: undefined,
    });
  });

  it('parses a relative local tarball', () => {
    expect(client.parseSpec('./pkg.tgz')).toEqual({
      kind: 'local-tgz',
      localPath: './pkg.tgz',
    });
  });

  it('parses an absolute local tarball', () => {
    expect(client.parseSpec('/tmp/pkg.tgz')).toEqual({
      kind: 'local-tgz',
      localPath: '/tmp/pkg.tgz',
    });
  });

  it('throws RegistryClientError on garbage input', () => {
    expect(() => client.parseSpec('not a package')).toThrow(RegistryClientError);
  });
});

describe('resolve — local-tgz', () => {
  it('resolves a local .tgz fixture and reads name+version from manta-package.json', async () => {
    const client = createRegistryClient({ runner: fakeRunner({}) });
    const resolved = await client.resolve(fixtureTarball, { workDir });
    expect(resolved.kind).toBe('local-tgz');
    expect(resolved.name).toBe('@manta-library/sample-package');
    expect(resolved.version).toBe('0.1.0');
    expect(resolved.contentSha256Hex).toMatch(/^[a-f0-9]{64}$/);
    expect(resolved.resolved).toBe(path.resolve(fixtureTarball));
    expect(resolved.tarballPath.startsWith(workDir)).toBe(true);
  });

  it('resolve produces matching sha256 vs hand-computed', async () => {
    const client = createRegistryClient({ runner: fakeRunner({}) });
    const resolved = await client.resolve(fixtureTarball, { workDir });
    const buf = await fs.readFile(fixtureTarball);
    const expected = crypto.createHash('sha256').update(buf).digest('hex');
    expect(resolved.contentSha256Hex).toBe(expected);
  });
});

describe('resolve — npm', () => {
  it('resolves via fake NetworkRunner.npmPack and produces a ResolvedPackage', async () => {
    const fake = fakeRunner({
      async npmPack(_spec, options) {
        // Copy the fixture tarball into the cwd as if `npm pack` did it.
        const filename = 'manta-library-sample-package-0.1.0.tgz';
        await fs.copyFile(fixtureTarball, path.join(options.cwd, filename));
        return filename;
      },
    });
    const client = createRegistryClient({ runner: fake });
    const resolved = await client.resolve('@manta-library/sample-package@^0.1.0', { workDir });
    expect(resolved.kind).toBe('npm');
    expect(resolved.name).toBe('@manta-library/sample-package');
    expect(resolved.version).toBe('0.1.0');
    expect(resolved.resolved.startsWith('https://registry.npmjs.org/')).toBe(true);
    expect(resolved.tarballPath.endsWith('.tgz')).toBe(true);
  });
});

describe('resolve — git', () => {
  it('resolves via fake gitClone, packs into deterministic .tgz, reads manifest', async () => {
    const fake = fakeRunner({
      async gitClone(options) {
        // Materialise the fixture directory into the dest as if git cloned it.
        await fs.mkdir(options.dest, { recursive: true });
        await tar.x({
          file: fixtureTarball,
          cwd: options.dest,
        });
      },
    });
    const client = createRegistryClient({ runner: fake });
    const resolved = await client.resolve('git+https://github.com/u/r#v0.1.0', { workDir });
    expect(resolved.kind).toBe('git');
    expect(resolved.name).toBe('@manta-library/sample-package');
    expect(resolved.version).toBe('0.1.0');
    expect(resolved.resolved).toBe('git+https://github.com/u/r#v0.1.0');
  });
});

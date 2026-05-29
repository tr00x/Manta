import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SharedBundleManifestSchema, type SharedBundleManifest } from '@manta/skill-validator';
import { computeDirDigest } from '../../src/library/dir-digest.js';
import {
  assembleBundle,
  verifyBundleChecksums,
  CHECKSUM_FILENAME,
  MANIFEST_FILENAME,
  type BundleArtifacts,
} from '../../src/share/bundle-assembler.js';

const BUNDLED_AT = '2026-05-29T03:00:00Z';

function makeManifest(): SharedBundleManifest {
  return {
    schemaVersion: 1,
    name: '@scope/sample-mode',
    version: '1.0.0',
    description: 'A sample shared bundle for assembler tests.',
    author: 'tester',
    license: 'MIT',
    mantaVersionCompat: '>=0.0.0',
    contributes: { skills: [], commands: [], modes: [], templates: [], hooks: [] },
    deps: {},
    castOrigin: {
      castId: 'cast-1780023574334',
      castMode: 'forking-realities',
      originalRepoOrigin: null,
      originalMantaVersion: '0.0.0',
      bundledAt: BUNDLED_AT,
      winningCloneId: 'B',
      provenance: null,
    },
  };
}

function makeArtifacts(): BundleArtifacts {
  return {
    manifest: makeManifest(),
    readme: '# Sample\n\nReadme body.\n',
    license: 'MIT License\n',
    taskContract: { cloneId: 'B', task: 'do a thing' },
    snapshot: { castId: 'cast-1780023574334', mode: 'forking-realities' },
    postMortems: [{ cloneId: 'B', markdown: '# Post-mortem B\n\nbody\n' }],
    zkNotes: [{ filename: 'insight-1.md', markdown: '---\nid: 1\n---\n\nnote body\n' }],
    eventsJsonl: '{"type":"heartbeat","ts":"+0ms"}\n',
    worktreeDiff: 'diff --git a/x b/x\n',
    skills: [{ relPath: 'sample/SKILL.md', content: '# skill\n' }],
  };
}

let outDir: string;
beforeEach(async () => {
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-assemble-'));
});
afterEach(async () => {
  await fs.rm(outDir, { recursive: true, force: true });
});

describe('assembleBundle', () => {
  it('writes the tarball + unpacked dir with the full layout', async () => {
    const result = await assembleBundle(makeArtifacts(), { outDir, packageBaseName: 'foo-1.0.0' });
    expect(result.tarballPath).toBe(path.join(outDir, 'foo-1.0.0.manta-pkg.tar.gz'));
    expect(result.unpackedDir).toBe(path.join(outDir, 'foo-1.0.0'));
    await expect(fs.access(result.tarballPath)).resolves.toBeUndefined();
    for (const rel of [
      MANIFEST_FILENAME,
      'README.md',
      'LICENSE',
      'task-contract.json',
      'snapshot.json',
      'post-mortems/B.md',
      'zk-notes/insight-1.md',
      'events.jsonl',
      'worktree-diff.patch',
      'skills/sample/SKILL.md',
      CHECKSUM_FILENAME,
    ]) {
      await expect(fs.access(path.join(result.unpackedDir, ...rel.split('/')))).resolves.toBeUndefined();
    }
  });

  it('checksum.json has a sha256 for every file except itself; verify ok', async () => {
    const result = await assembleBundle(makeArtifacts(), { outDir, packageBaseName: 'foo-1.0.0' });
    expect(result.checksums[CHECKSUM_FILENAME]).toBeUndefined();
    expect(result.checksums['README.md']).toMatch(/^[0-9a-f]{64}$/);
    const verify = await verifyBundleChecksums(result.unpackedDir);
    expect(verify).toEqual({ ok: true });
  });

  it('mutating a payload byte → verifyBundleChecksums reports that file', async () => {
    const result = await assembleBundle(makeArtifacts(), { outDir, packageBaseName: 'foo-1.0.0' });
    await fs.writeFile(path.join(result.unpackedDir, 'README.md'), '# tampered\n');
    const verify = await verifyBundleChecksums(result.unpackedDir);
    expect(verify.ok).toBe(false);
    if (!verify.ok) expect(verify.mismatches).toContain('README.md');
  });

  it('directoryDigest equals computeDirDigest of the unpacked tree', async () => {
    const result = await assembleBundle(makeArtifacts(), { outDir, packageBaseName: 'foo-1.0.0' });
    expect(result.directoryDigest).toBe(await computeDirDigest(result.unpackedDir));
  });

  it('two assembles of identical artifacts produce byte-identical tarballs', async () => {
    const r1 = await assembleBundle(makeArtifacts(), { outDir, packageBaseName: 'a' });
    const r2 = await assembleBundle(makeArtifacts(), { outDir, packageBaseName: 'b' });
    const b1 = await fs.readFile(r1.tarballPath);
    const b2 = await fs.readFile(r2.tarballPath);
    expect(b1.equals(b2)).toBe(true);
  });

  it('the unpacked manta-package.json parses against SharedBundleManifestSchema', async () => {
    const result = await assembleBundle(makeArtifacts(), { outDir, packageBaseName: 'foo-1.0.0' });
    const raw = await fs.readFile(path.join(result.unpackedDir, MANIFEST_FILENAME), 'utf8');
    expect(() => SharedBundleManifestSchema.parse(JSON.parse(raw))).not.toThrow();
  });
});

/** Recursively collect every `*.jsonl` under `root`, as POSIX-relative paths. */
async function listJsonl(root: string, current: string, acc: string[]): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(current, e.name);
    if (e.isDirectory()) {
      await listJsonl(root, full, acc);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      acc.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
}

/**
 * RB1/bug #56 share-leak regression guard (plan §5 «Transcript leaks via manta share»).
 *
 * A clone's forked transcript lives on disk as `<uuid>.jsonl`. It must NEVER end up inside
 * a shared `.manta-pkg.tar.gz` — that would leak the full parent+clone conversation to anyone
 * who installs the bundle. This complements the field-stripping in sanitize-snapshot.ts (which
 * scrubs `parentSessionId`/`recentMessages`/`sessionId` from the SNAPSHOT); this guard defends
 * the BUNDLE TREE itself.
 *
 * ⚠️ `events.jsonl` is a LEGITIMATE bundle member (sanitized bus events, bundle-assembler.ts).
 * The guard therefore WHITELISTS `events.jsonl` and fails on ANY OTHER `.jsonl` — a blanket
 * "no *.jsonl" rule would false-fail on the legitimate events.jsonl.
 */
describe('assembleBundle — share-leak guard (no transcript fork leaks)', () => {
  const WHITELISTED_JSONL = new Set(['events.jsonl']);

  it('the only `.jsonl` in an assembled bundle is the whitelisted events.jsonl', async () => {
    const result = await assembleBundle(makeArtifacts(), { outDir, packageBaseName: 'foo-1.0.0' });

    // Walk the assembled tree on disk (the tarball is built from exactly this tree).
    const jsonlOnDisk: string[] = [];
    await listJsonl(result.unpackedDir, result.unpackedDir, jsonlOnDisk);
    expect(jsonlOnDisk).toEqual(['events.jsonl']);

    // Cross-check the integrity witness: every `.jsonl` recorded in checksum.json is whitelisted.
    // (Two independent views — the on-disk walk and the checksum manifest — must agree.)
    const jsonlInChecksums = Object.keys(result.checksums).filter((rel) => rel.endsWith('.jsonl'));
    expect(jsonlInChecksums).toEqual(['events.jsonl']);
    for (const rel of jsonlInChecksums) {
      const base = rel.split('/').pop()!;
      expect(WHITELISTED_JSONL.has(base)).toBe(true);
    }
  });

  it('a planted `<uuid>.jsonl` transcript fork is caught by the guard (the guard has teeth)', async () => {
    const result = await assembleBundle(makeArtifacts(), { outDir, packageBaseName: 'foo-1.0.0' });

    // Simulate a regression: a forked transcript leaks into the bundle tree (e.g. a future
    // change that copies a clone's project dir, or a path-traversal artifact). The guard MUST
    // reject it while still accepting the legitimate events.jsonl — proving the whitelist is a
    // whitelist, not a blanket allow. An assertion-free "no jsonl present" check would silently
    // pass on a clean tree and never exercise the rejection path; this is the anti-theater half.
    const leakedForkName = `${randomUUID()}.jsonl`;
    await fs.writeFile(
      path.join(result.unpackedDir, leakedForkName),
      '{"type":"user","message":{"role":"user","content":"secret parent transcript"}}\n',
      'utf8',
    );

    const jsonlOnDisk: string[] = [];
    await listJsonl(result.unpackedDir, result.unpackedDir, jsonlOnDisk);

    const offenders = jsonlOnDisk.filter((rel) => !WHITELISTED_JSONL.has(rel.split('/').pop()!));
    expect(offenders).toEqual([leakedForkName]);
    // events.jsonl is still present and still allowed — the whitelist did not over-reject.
    expect(jsonlOnDisk).toContain('events.jsonl');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserializeSnapshot } from '../src/deserialize';
import {
  SnapshotIOError,
  SnapshotValidationError,
  SnapshotVersionError,
} from '../src/errors';
import { CURRENT_SCHEMA_VERSION } from '../src/version';

describe('deserializeSnapshot', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manta-snap-de-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads and validates a valid snapshot file', async () => {
    const valid = {
      version: CURRENT_SCHEMA_VERSION,
      castId: 'c1',
      parentSessionId: 's1',
      parentPid: 1,
      createdAt: '2026-05-06T10:00:00.000Z',
      taskContract: {
        cloneId: 'A',
        mode: 'recon-swarm',
        task: 'x',
        scope: { allowedPaths: ['src/'], forbiddenPaths: [], maxFilesChanged: 0 },
        approachHint: null,
        siblingClones: [],
        deadlineSeconds: 1200,
      },
      recentMessages: [],
      activeTodos: [],
      openFiles: [],
      parentWorktree: '/p',
      cloneWorktree: '/c',
      mode: 'recon-swarm',
      budget: { tokensTotal: 1, tokensUsed: 0, tokensEstimatedTotal: 1, tokensEstimatedUsed: 0 },
      ttlSeconds: 60,
      siblingCloneIds: [],
    };
    const path = join(dir, 'snap.json');
    writeFileSync(path, JSON.stringify(valid));
    const out = await deserializeSnapshot(path);
    expect(out.castId).toBe('c1');
  });

  it('throws SnapshotIOError when file does not exist', async () => {
    await expect(deserializeSnapshot(join(dir, 'missing.json'))).rejects.toBeInstanceOf(
      SnapshotIOError,
    );
  });

  it('throws SnapshotIOError on malformed JSON', async () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{not json');
    await expect(deserializeSnapshot(path)).rejects.toBeInstanceOf(SnapshotIOError);
  });

  it('throws SnapshotVersionError on unsupported future version', async () => {
    const path = join(dir, 'futureverz.json');
    writeFileSync(path, JSON.stringify({ version: 999, castId: 'c1' }));
    await expect(deserializeSnapshot(path)).rejects.toBeInstanceOf(SnapshotVersionError);
  });

  it('throws SnapshotValidationError (not VersionError) on version: 0', async () => {
    const path = join(dir, 'zero.json');
    writeFileSync(path, JSON.stringify({ version: 0, castId: 'c1' }));
    await expect(deserializeSnapshot(path)).rejects.toBeInstanceOf(SnapshotValidationError);
    await expect(deserializeSnapshot(path)).rejects.not.toBeInstanceOf(SnapshotVersionError);
  });

  it('throws SnapshotValidationError (not VersionError) on negative version', async () => {
    const path = join(dir, 'neg.json');
    writeFileSync(path, JSON.stringify({ version: -1, castId: 'c1' }));
    await expect(deserializeSnapshot(path)).rejects.toBeInstanceOf(SnapshotValidationError);
    await expect(deserializeSnapshot(path)).rejects.not.toBeInstanceOf(SnapshotVersionError);
  });

  it('throws SnapshotValidationError on schema-invalid snapshot', async () => {
    const path = join(dir, 'invalid.json');
    writeFileSync(path, JSON.stringify({ version: CURRENT_SCHEMA_VERSION, castId: '' }));
    await expect(deserializeSnapshot(path)).rejects.toBeInstanceOf(SnapshotValidationError);
  });
});

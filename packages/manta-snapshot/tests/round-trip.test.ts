import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureState,
  serializeSnapshot,
  deserializeSnapshot,
} from '../src/index';
import { CURRENT_SCHEMA_VERSION } from '../src/version';

describe('snapshot round-trip', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manta-rt-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('captures, serializes, deserializes, and produces an equivalent snapshot', async () => {
    const captured = captureState({
      castId: 'cast-RT',
      parentSessionId: 'session-RT',
      parentPid: 4242,
      taskContract: {
        cloneId: 'A',
        mode: 'recon-swarm',
        task: 'roundtrip',
        scope: { allowedPaths: ['src/'], forbiddenPaths: ['secrets/'], maxFilesChanged: 0 },
        approachHint: 'depth-first',
        siblingClones: ['B'],
        deadlineSeconds: 600,
      },
      recentMessages: [
        { role: 'user', content: 'hi', timestamp: '2026-05-06T10:00:00.000Z' },
      ],
      activeTodos: [{ id: 't1', subject: 'do', status: 'pending' }],
      openFiles: [{ path: 'src/x.ts', reason: 'open' }],
      parentWorktree: '/p',
      cloneWorktree: '/c',
      budget: { tokensTotal: 1000, tokensUsed: 100, dollarsTotal: 5, dollarsUsed: 0.5 },
      ttlSeconds: 600,
      siblingCloneIds: ['B'],
    });

    const path = join(dir, 'rt.json');
    await serializeSnapshot(captured, path);
    const restored = await deserializeSnapshot(path);

    expect(restored.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(restored).toEqual(captured);
  });
});

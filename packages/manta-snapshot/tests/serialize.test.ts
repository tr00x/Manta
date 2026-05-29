import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeSnapshot } from '../src/serialize';
import { SnapshotValidationError, SnapshotIOError } from '../src/errors';
import { CURRENT_SCHEMA_VERSION } from '../src/version';
import type { Snapshot } from '../src/schema';

const valid: Snapshot = {
  version: CURRENT_SCHEMA_VERSION,
  castId: 'cast-001',
  parentSessionId: 'session-abc',
  resumeEnabled: false,
  parentPid: 12345,
  createdAt: '2026-05-06T10:00:00.000Z',
  taskContract: {
    cloneId: 'A',
    mode: 'recon-swarm',
    task: 'Map repo',
    scope: { allowedPaths: ['src/'], forbiddenPaths: [], maxFilesChanged: 0 },
    approachHint: null,
    siblingClones: [],
    deadlineSeconds: 1200,
  },
  recentMessages: [],
  activeTodos: [],
  openFiles: [],
  parentWorktree: '/tmp/parent',
  cloneWorktree: '/tmp/clone-A',
  mode: 'recon-swarm',
  budget: { tokensTotal: 100000, tokensUsed: 0, dollarsTotal: 5, dollarsUsed: 0 },
  ttlSeconds: 1200,
  siblingCloneIds: [],
};

describe('serializeSnapshot', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manta-snap-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a valid snapshot to disk', async () => {
    const path = join(dir, 'snap.json');
    await serializeSnapshot(valid, path);
    expect(existsSync(path)).toBe(true);
    const content = JSON.parse(readFileSync(path, 'utf-8')) as Snapshot;
    expect(content.castId).toBe('cast-001');
    expect(content.version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('writes formatted JSON (2-space indent)', async () => {
    const path = join(dir, 'snap.json');
    await serializeSnapshot(valid, path);
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toContain('\n  "castId"');
  });

  it('rejects an invalid snapshot before writing', async () => {
    const path = join(dir, 'snap.json');
    // Intentionally malformed runtime input to trigger zod validation.
    // The type `parentPid: number` accepts -1 statically, but the schema
    // requires a positive integer — this exercises the runtime gate.
    const bad = { ...valid, parentPid: -1 } as unknown as Snapshot;
    await expect(serializeSnapshot(bad, path)).rejects.toBeInstanceOf(SnapshotValidationError);
    expect(existsSync(path)).toBe(false);
  });

  it('throws SnapshotIOError when destination dir cannot be created (path conflicts with existing file)', async () => {
    // Create a regular file, then attempt to write a snapshot into a path that treats it as a directory.
    // This is portable across macOS/Linux: mkdir fails on EEXIST/ENOTDIR.
    const fileBlocker = join(dir, 'blocker');
    writeFileSync(fileBlocker, 'i am a file');
    const blockedPath = join(fileBlocker, 'sub', 'snap.json');
    await expect(serializeSnapshot(valid, blockedPath)).rejects.toBeInstanceOf(SnapshotIOError);
  });
});

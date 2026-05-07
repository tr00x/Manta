import { describe, it, expect } from 'vitest';
import { SnapshotSchema, TaskContractSchema } from '../src/schema';
import { CURRENT_SCHEMA_VERSION } from '../src/version';

const validContract = {
  cloneId: 'A',
  mode: 'recon-swarm',
  task: 'Map the codebase',
  scope: {
    allowedPaths: ['src/'],
    forbiddenPaths: ['secrets/'],
    maxFilesChanged: 0,
  },
  approachHint: null,
  siblingClones: [],
  deadlineSeconds: 1200,
};

const validSnapshot = {
  version: CURRENT_SCHEMA_VERSION,
  castId: 'cast-001',
  parentSessionId: 'session-abc',
  parentPid: 12345,
  createdAt: '2026-05-06T10:00:00.000Z',
  taskContract: validContract,
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

describe('TaskContractSchema', () => {
  it('accepts a valid contract', () => {
    expect(() => TaskContractSchema.parse(validContract)).not.toThrow();
  });

  it('rejects unknown mode', () => {
    expect(() => TaskContractSchema.parse({ ...validContract, mode: 'wat' })).toThrow();
  });

  it('rejects negative deadline', () => {
    expect(() => TaskContractSchema.parse({ ...validContract, deadlineSeconds: -1 })).toThrow();
  });

  it('rejects empty cloneId', () => {
    expect(() => TaskContractSchema.parse({ ...validContract, cloneId: '' })).toThrow();
  });
});

describe('SnapshotSchema', () => {
  it('accepts a valid snapshot', () => {
    expect(() => SnapshotSchema.parse(validSnapshot)).not.toThrow();
  });

  it('rejects mismatched version', () => {
    expect(() => SnapshotSchema.parse({ ...validSnapshot, version: 999 })).toThrow();
  });

  it('rejects mismatched mode in contract vs root', () => {
    expect(() =>
      SnapshotSchema.parse({
        ...validSnapshot,
        mode: 'forking-realities',
        taskContract: { ...validContract, mode: 'recon-swarm' },
      }),
    ).toThrow(/mode/i);
  });

  it('rejects parentPid that is not positive integer', () => {
    expect(() => SnapshotSchema.parse({ ...validSnapshot, parentPid: 0 })).toThrow();
    expect(() => SnapshotSchema.parse({ ...validSnapshot, parentPid: 1.5 })).toThrow();
  });

  it('rejects createdAt that is not ISO 8601', () => {
    expect(() => SnapshotSchema.parse({ ...validSnapshot, createdAt: 'yesterday' })).toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import { resolveParentSessionId } from '../../src/commands/cast.js';
import { buildCloneSnapshot } from '../../src/spawner/snapshot-builder.js';
import { createReporter, MemorySink } from '../../src/output/reporter.js';

/**
 * RB1 Chunk 1 (bug #56): the parent Claude session uuid must be resolved from
 * the flag/env chain (Decision #5) and threaded into the snapshot as the REAL
 * session id — never the castId. When nothing resolves we fall back to
 * `resumeEnabled=false` + a warn, and NEVER fabricate an id.
 *
 * Env is injected (not mutated on `process.env`) so the resolution order is
 * tested deterministically without cross-test leakage.
 */
const CAST_ID = 'cast-1780067836274';
const UUID = '550e8400-e29b-41d4-a716-446655440000';
const FLAG_UUID = '11111111-2222-3333-4444-555555555555';

describe('resolveParentSessionId (RB1 Chunk 1, Decision #5)', () => {
  it('resolves CLAUDE_CODE_SESSION_ID when set → resumeEnabled=true, no warn', () => {
    const sink = new MemorySink();
    const reporter = createReporter({ sink });
    const out = resolveParentSessionId({ castId: CAST_ID }, reporter, {
      CLAUDE_CODE_SESSION_ID: UUID,
    });
    expect(out.parentSessionId).toBe(UUID);
    expect(out.resumeEnabled).toBe(true);
    expect(sink.lines.some((l) => l.level === 'warn')).toBe(false);
  });

  it('env unset AND no flag → null, resumeEnabled=false, and a warn is emitted', () => {
    const sink = new MemorySink();
    const reporter = createReporter({ sink });
    const out = resolveParentSessionId({ castId: CAST_ID }, reporter, {});
    expect(out.parentSessionId).toBeNull();
    expect(out.resumeEnabled).toBe(false);
    const warned = sink.lines.filter((l) => l.level === 'warn');
    expect(warned.length).toBe(1);
  });

  it('--parent-session-id flag beats the env var', () => {
    const sink = new MemorySink();
    const reporter = createReporter({ sink });
    const out = resolveParentSessionId({ castId: CAST_ID, parentSessionId: FLAG_UUID }, reporter, {
      CLAUDE_CODE_SESSION_ID: UUID,
      MANTA_PARENT_SESSION_ID: 'env-manta',
    });
    expect(out.parentSessionId).toBe(FLAG_UUID);
    expect(out.resumeEnabled).toBe(true);
  });

  it('MANTA_PARENT_SESSION_ID beats CLAUDE_CODE_SESSION_ID (precedence per Decision #5)', () => {
    const sink = new MemorySink();
    const reporter = createReporter({ sink });
    const out = resolveParentSessionId({ castId: CAST_ID }, reporter, {
      MANTA_PARENT_SESSION_ID: UUID,
      CLAUDE_CODE_SESSION_ID: 'claude-env',
    });
    expect(out.parentSessionId).toBe(UUID);
    expect(out.resumeEnabled).toBe(true);
  });

  it('the resolved values thread into buildCloneSnapshot — never the castId', () => {
    const sink = new MemorySink();
    const reporter = createReporter({ sink });
    const { parentSessionId, resumeEnabled } = resolveParentSessionId({ castId: CAST_ID }, reporter, {
      CLAUDE_CODE_SESSION_ID: UUID,
    });
    const snap = buildCloneSnapshot({
      cloneId: 'A',
      mode: 'forking-realities',
      task: 't',
      scope: { allowedPaths: ['.'], forbiddenPaths: [], maxFilesChanged: 0 },
      siblingClones: [],
      deadlineMs: 60_000,
      parentWorktree: '/p',
      cloneWorktree: '/c',
      parentPid: process.pid,
      parentSessionId,
      resumeEnabled,
      castId: CAST_ID,
    });
    expect(snap.parentSessionId).toBe(UUID);
    expect(snap.parentSessionId).not.toBe(snap.castId);
    expect(snap.resumeEnabled).toBe(true);
  });
});

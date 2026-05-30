import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  formatStatusline,
  formatDuration,
  isLive,
  resolveRepoRoot,
  readClones,
  readSpentUsd,
  readCapUsd,
  computeStatusline,
  type StatuslineClone,
} from '../../src/bin/manta-statusline.js';

// Fixed clock so duration math is deterministic. 2026-05-30T23:46:29Z-ish.
const NOW = 1_780_184_789_000;

function clone(partial: Partial<StatuslineClone> & { clone_id: string; state: string }): StatuslineClone {
  return partial;
}

describe('formatStatusline', () => {
  it('renders the canonical line: clones · spend/cap · elapsed', () => {
    const line = formatStatusline({
      clones: [
        clone({ clone_id: 'A', state: 'WORKING', registered_at: NOW - 4 * 60_000 }),
        clone({ clone_id: 'B', state: 'WINDING_DOWN', registered_at: NOW - 2 * 60_000 }),
      ],
      spentUsd: 2.4,
      capUsd: 15,
      nowMs: NOW,
    });
    expect(line).toBe('🦈 A▶WORKING B▶WINDING_DOWN · $2.40/15 · 4m');
  });

  it('returns EMPTY string when there are no clones at all', () => {
    expect(formatStatusline({ clones: [], spentUsd: 2.4, capUsd: 15, nowMs: NOW })).toBe('');
  });

  it('returns EMPTY string when every clone is DEAD (no live clones)', () => {
    const line = formatStatusline({
      clones: [
        clone({ clone_id: 'A', state: 'DEAD', registered_at: NOW - 60_000 }),
        clone({ clone_id: 'B', state: 'DEAD', registered_at: NOW - 60_000 }),
      ],
      spentUsd: 2.4,
      capUsd: 15,
      nowMs: NOW,
    });
    expect(line).toBe('');
  });

  it('hides DEAD clones but keeps live siblings on the line', () => {
    const line = formatStatusline({
      clones: [
        clone({ clone_id: 'A', state: 'DEAD', registered_at: NOW - 60_000 }),
        clone({ clone_id: 'B', state: 'WORKING', registered_at: NOW - 30_000 }),
      ],
      spentUsd: 1,
      capUsd: 15,
      nowMs: NOW,
    });
    expect(line).toBe('🦈 B▶WORKING · $1.00/15 · 30s');
  });

  it('omits the cap when capUsd is null', () => {
    const line = formatStatusline({
      clones: [clone({ clone_id: 'A', state: 'WORKING', registered_at: NOW - 60_000 })],
      spentUsd: 3,
      capUsd: null,
      nowMs: NOW,
    });
    expect(line).toBe('🦈 A▶WORKING · $3.00 · 1m');
  });

  it('omits the spend segment when spentUsd is null', () => {
    const line = formatStatusline({
      clones: [clone({ clone_id: 'A', state: 'WORKING', registered_at: NOW - 60_000 })],
      spentUsd: null,
      capUsd: 15,
      nowMs: NOW,
    });
    expect(line).toBe('🦈 A▶WORKING · 1m');
  });

  it('omits the elapsed segment when no live clone has registered_at', () => {
    const line = formatStatusline({
      clones: [clone({ clone_id: 'A', state: 'WORKING' })],
      spentUsd: 2,
      capUsd: 15,
      nowMs: NOW,
    });
    expect(line).toBe('🦈 A▶WORKING · $2.00/15');
  });

  it('renders a non-integer cap with two decimals', () => {
    const line = formatStatusline({
      clones: [clone({ clone_id: 'A', state: 'WORKING' })],
      spentUsd: 2.5,
      capUsd: 12.5,
      nowMs: NOW,
    });
    expect(line).toBe('🦈 A▶WORKING · $2.50/12.50');
  });

  it('treats a clock skew (now before registration) as 0s, not negative', () => {
    const line = formatStatusline({
      clones: [clone({ clone_id: 'A', state: 'WORKING', registered_at: NOW + 5_000 })],
      spentUsd: null,
      capUsd: null,
      nowMs: NOW,
    });
    expect(line).toBe('🦈 A▶WORKING · 0s');
  });

  it('uses the OLDEST live clone for elapsed', () => {
    const line = formatStatusline({
      clones: [
        clone({ clone_id: 'A', state: 'WORKING', registered_at: NOW - 30_000 }),
        clone({ clone_id: 'B', state: 'WORKING', registered_at: NOW - 5 * 60_000 }),
      ],
      spentUsd: null,
      capUsd: null,
      nowMs: NOW,
    });
    expect(line).toBe('🦈 A▶WORKING B▶WORKING · 5m');
  });
});

describe('formatDuration', () => {
  it('formats sub-minute as seconds', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59_000)).toBe('59s');
  });

  it('formats sub-hour as minutes', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(59 * 60_000)).toBe('59m');
  });

  it('formats hours as HhMm', () => {
    expect(formatDuration(60 * 60_000)).toBe('1h0m');
    expect(formatDuration(90 * 60_000)).toBe('1h30m');
  });
});

describe('isLive', () => {
  it('is false only for DEAD', () => {
    expect(isLive('DEAD')).toBe(false);
    for (const s of ['STARTING', 'WORKING', 'BLOCKED', 'IDLE', 'WAITING_FOR_TASK', 'WINDING_DOWN']) {
      expect(isLive(s)).toBe(true);
    }
  });
});

describe('I/O readers (tmp repo)', () => {
  let dir: string;
  let stateDir: string;
  let configDir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'manta-statusline-'));
    stateDir = path.join(dir, '.manta', 'state');
    configDir = path.join(dir, '.manta', 'config');
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.mkdir(configDir, { recursive: true });
    await fsp.mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('readClones parses registry.json into clone records', async () => {
    await fsp.writeFile(
      path.join(stateDir, 'registry.json'),
      JSON.stringify({
        version: 1,
        clones: {
          A: { clone_id: 'A', state: 'WORKING', registered_at: 111 },
          B: { clone_id: 'B', state: 'DEAD', registered_at: 222 },
        },
      }),
    );
    const clones = readClones(dir);
    expect(clones).toHaveLength(2);
    expect(clones.find((c) => c.clone_id === 'A')).toMatchObject({ state: 'WORKING', registered_at: 111 });
  });

  it('readClones returns [] on a missing registry', () => {
    expect(readClones(dir)).toEqual([]);
  });

  it('readClones returns [] on malformed JSON', async () => {
    await fsp.writeFile(path.join(stateDir, 'registry.json'), '{ not json');
    expect(readClones(dir)).toEqual([]);
  });

  it('readSpentUsd reads today spent_usd', async () => {
    const today = new Date(NOW).toLocaleDateString('en-CA');
    await fsp.writeFile(
      path.join(stateDir, 'daily-spend.json'),
      JSON.stringify({ version: 1, date: today, spent_usd: 7.5, entries: [] }),
    );
    expect(readSpentUsd(dir, NOW)).toBe(7.5);
  });

  it('readSpentUsd returns 0 for a stale (previous-day) ledger', async () => {
    await fsp.writeFile(
      path.join(stateDir, 'daily-spend.json'),
      JSON.stringify({ version: 1, date: '2000-01-01', spent_usd: 99, entries: [] }),
    );
    expect(readSpentUsd(dir, NOW)).toBe(0);
  });

  it('readSpentUsd returns null when the ledger is missing', () => {
    expect(readSpentUsd(dir, NOW)).toBeNull();
  });

  it('readCapUsd prefers state/budget.json', async () => {
    await fsp.writeFile(path.join(stateDir, 'budget.json'), JSON.stringify({ daily_cap_usd: 15 }));
    await fsp.writeFile(path.join(configDir, 'budget.json'), JSON.stringify({ daily_cap_usd: 999 }));
    expect(readCapUsd(dir)).toBe(15);
  });

  it('readCapUsd falls back to config/budget.json', async () => {
    await fsp.writeFile(path.join(configDir, 'budget.json'), JSON.stringify({ daily_cap_usd: 42 }));
    expect(readCapUsd(dir)).toBe(42);
  });

  it('readCapUsd returns null when no budget file is present', () => {
    expect(readCapUsd(dir)).toBeNull();
  });

  it('resolveRepoRoot walks up to the nearest .git', () => {
    const nested = path.join(dir, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    // resolveRepoRoot uses path.resolve (no symlink expansion), so it returns
    // the same absolute string we walked up from — not the realpath.
    expect(resolveRepoRoot(nested)).toBe(path.resolve(dir));
  });

  it('resolveRepoRoot returns null when no .git ancestor exists', async () => {
    const orphan = await fsp.mkdtemp(path.join(os.tmpdir(), 'manta-no-git-'));
    try {
      expect(resolveRepoRoot(orphan)).toBeNull();
    } finally {
      await fsp.rm(orphan, { recursive: true, force: true });
    }
  });
});

describe('computeStatusline (end-to-end)', () => {
  let dir: string;
  let stateDir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'manta-statusline-e2e-'));
    stateDir = path.join(dir, '.manta', 'state');
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.mkdir(path.join(dir, '.manta', 'config'), { recursive: true });
    await fsp.mkdir(path.join(dir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('live clones → a rendered line', async () => {
    await fsp.writeFile(
      path.join(stateDir, 'registry.json'),
      JSON.stringify({
        version: 1,
        clones: { A: { clone_id: 'A', state: 'WORKING', registered_at: NOW - 60_000 } },
      }),
    );
    const today = new Date(NOW).toLocaleDateString('en-CA');
    await fsp.writeFile(
      path.join(stateDir, 'daily-spend.json'),
      JSON.stringify({ version: 1, date: today, spent_usd: 3, entries: [] }),
    );
    await fsp.writeFile(path.join(stateDir, 'budget.json'), JSON.stringify({ daily_cap_usd: 15 }));
    expect(computeStatusline(dir, NOW)).toBe('🦈 A▶WORKING · $3.00/15 · 1m');
  });

  it('no live clones → EMPTY string', async () => {
    await fsp.writeFile(
      path.join(stateDir, 'registry.json'),
      JSON.stringify({ version: 1, clones: { A: { clone_id: 'A', state: 'DEAD', registered_at: NOW } } }),
    );
    expect(computeStatusline(dir, NOW)).toBe('');
  });

  it('empty registry → EMPTY string', () => {
    // No registry written at all — every reader degrades to empty/null.
    expect(computeStatusline(dir, NOW)).toBe('');
  });

  it('error path (no .git ancestor) → EMPTY string', async () => {
    const orphan = await fsp.mkdtemp(path.join(os.tmpdir(), 'manta-orphan-'));
    try {
      expect(computeStatusline(orphan, NOW)).toBe('');
    } finally {
      await fsp.rm(orphan, { recursive: true, force: true });
    }
  });

  it('malformed registry → EMPTY string (never throws)', async () => {
    await fsp.writeFile(path.join(stateDir, 'registry.json'), 'GARBAGE{{{');
    expect(() => computeStatusline(dir, NOW)).not.toThrow();
    expect(computeStatusline(dir, NOW)).toBe('');
  });
});

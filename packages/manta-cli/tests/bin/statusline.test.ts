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
  readTokensEstimated,
  readTokenCap,
  computeStatusline,
  type StatuslineClone,
} from '../../src/bin/manta-statusline.js';

// Fixed clock so duration math is deterministic. 2026-05-30T23:46:29Z-ish.
const NOW = 1_780_184_789_000;

function clone(partial: Partial<StatuslineClone> & { clone_id: string; state: string }): StatuslineClone {
  return partial;
}

describe('formatStatusline', () => {
  it('renders the canonical line: clones · token-usage/cap · elapsed', () => {
    const line = formatStatusline({
      clones: [
        clone({ clone_id: 'A', state: 'WORKING', registered_at: NOW - 4 * 60_000 }),
        clone({ clone_id: 'B', state: 'WINDING_DOWN', registered_at: NOW - 2 * 60_000 }),
      ],
      tokensEstimated: 2_400_000,
      tokenCap: 15_000_000,
      nowMs: NOW,
    });
    expect(line).toBe('⧉ A▶WORKING B▶WINDING_DOWN · 2.4M/15M · 4m');
  });

  it('returns EMPTY string when there are no clones at all', () => {
    expect(formatStatusline({ clones: [], tokensEstimated: 2_400_000, tokenCap: 15_000_000, nowMs: NOW })).toBe('');
  });

  it('returns EMPTY string when every clone is DEAD (no live clones)', () => {
    const line = formatStatusline({
      clones: [
        clone({ clone_id: 'A', state: 'DEAD', registered_at: NOW - 60_000 }),
        clone({ clone_id: 'B', state: 'DEAD', registered_at: NOW - 60_000 }),
      ],
      tokensEstimated: 2_400_000,
      tokenCap: 15_000_000,
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
      tokensEstimated: 1_000_000,
      tokenCap: 15_000_000,
      nowMs: NOW,
    });
    expect(line).toBe('⧉ B▶WORKING · 1M/15M · 30s');
  });

  it('omits the cap when tokenCap is null', () => {
    const line = formatStatusline({
      clones: [clone({ clone_id: 'A', state: 'WORKING', registered_at: NOW - 60_000 })],
      tokensEstimated: 3_000_000,
      tokenCap: null,
      nowMs: NOW,
    });
    expect(line).toBe('⧉ A▶WORKING · 3M · 1m');
  });

  it('omits the usage segment when tokensEstimated is null', () => {
    const line = formatStatusline({
      clones: [clone({ clone_id: 'A', state: 'WORKING', registered_at: NOW - 60_000 })],
      tokensEstimated: null,
      tokenCap: 15_000_000,
      nowMs: NOW,
    });
    expect(line).toBe('⧉ A▶WORKING · 1m');
  });

  it('omits the elapsed segment when no live clone has registered_at', () => {
    const line = formatStatusline({
      clones: [clone({ clone_id: 'A', state: 'WORKING' })],
      tokensEstimated: 2_000_000,
      tokenCap: 15_000_000,
      nowMs: NOW,
    });
    expect(line).toBe('⧉ A▶WORKING · 2M/15M');
  });

  it('renders sub-million usage as compact k and a fractional-M cap', () => {
    const line = formatStatusline({
      clones: [clone({ clone_id: 'A', state: 'WORKING' })],
      tokensEstimated: 250_000,
      tokenCap: 2_500_000,
      nowMs: NOW,
    });
    expect(line).toBe('⧉ A▶WORKING · 250k/2.5M');
  });

  it('treats a clock skew (now before registration) as 0s, not negative', () => {
    const line = formatStatusline({
      clones: [clone({ clone_id: 'A', state: 'WORKING', registered_at: NOW + 5_000 })],
      tokensEstimated: null,
      tokenCap: null,
      nowMs: NOW,
    });
    expect(line).toBe('⧉ A▶WORKING · 0s');
  });

  it('uses the OLDEST live clone for elapsed', () => {
    const line = formatStatusline({
      clones: [
        clone({ clone_id: 'A', state: 'WORKING', registered_at: NOW - 30_000 }),
        clone({ clone_id: 'B', state: 'WORKING', registered_at: NOW - 5 * 60_000 }),
      ],
      tokensEstimated: null,
      tokenCap: null,
      nowMs: NOW,
    });
    expect(line).toBe('⧉ A▶WORKING B▶WORKING · 5m');
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

  it('readTokensEstimated reads today tokens_estimated', async () => {
    const today = new Date(NOW).toLocaleDateString('en-CA');
    await fsp.writeFile(
      path.join(stateDir, 'daily-spend.json'),
      JSON.stringify({ version: 1, date: today, tokens_estimated: 750_000, entries: [] }),
    );
    expect(readTokensEstimated(dir, NOW)).toBe(750_000);
  });

  it('readTokensEstimated returns 0 for a stale (previous-day) ledger', async () => {
    await fsp.writeFile(
      path.join(stateDir, 'daily-spend.json'),
      JSON.stringify({ version: 1, date: '2000-01-01', tokens_estimated: 990_000, entries: [] }),
    );
    expect(readTokensEstimated(dir, NOW)).toBe(0);
  });

  it('readTokensEstimated returns null when the ledger is missing', () => {
    expect(readTokensEstimated(dir, NOW)).toBeNull();
  });

  it('readTokenCap prefers state/budget.json', async () => {
    await fsp.writeFile(path.join(stateDir, 'budget.json'), JSON.stringify({ daily_token_cap: 5_000_000 }));
    await fsp.writeFile(path.join(configDir, 'budget.json'), JSON.stringify({ daily_token_cap: 999_000_000 }));
    expect(readTokenCap(dir)).toBe(5_000_000);
  });

  it('readTokenCap falls back to config/budget.json', async () => {
    await fsp.writeFile(path.join(configDir, 'budget.json'), JSON.stringify({ daily_token_cap: 42_000_000 }));
    expect(readTokenCap(dir)).toBe(42_000_000);
  });

  it('readTokenCap returns null when no budget file is present', () => {
    expect(readTokenCap(dir)).toBeNull();
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
      JSON.stringify({ version: 1, date: today, tokens_estimated: 3_000_000, entries: [] }),
    );
    await fsp.writeFile(path.join(stateDir, 'budget.json'), JSON.stringify({ daily_token_cap: 15_000_000 }));
    expect(computeStatusline(dir, NOW)).toBe('⧉ A▶WORKING · 3M/15M · 1m');
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

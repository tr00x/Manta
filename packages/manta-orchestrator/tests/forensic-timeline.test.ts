import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ForensicTimelineWriter, readForensicTimeline } from '../src/forensic-timeline';

describe('ForensicTimelineWriter', () => {
  async function makeTmpDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'manta-timeline-'));
  }

  const meta = { cast_id: 'cast-100', mode: 'recon-swarm', started_at: 1000 };

  it('appendSnapshot writes JSONL with incrementing cycleNumber', async () => {
    const root = await makeTmpDir();
    try {
      const fp = path.join(root, 'timelines', 'cast-100.jsonl');
      const writer = new ForensicTimelineWriter(fp, meta);

      await writer.appendSnapshot({
        ts: 1000,
        clones: [{ clone_id: 'A', state: 'WORKING', last_heartbeat_at: 1000 }],
      });
      await writer.appendSnapshot({
        ts: 2000,
        clones: [{ clone_id: 'A', state: 'WORKING', last_heartbeat_at: 1500 }],
      });

      const raw = await fs.readFile(fp, 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(2);

      const snap0 = JSON.parse(lines[0]!) as Record<string, unknown>;
      const snap1 = JSON.parse(lines[1]!) as Record<string, unknown>;
      expect(snap0.cycleNumber).toBe(0);
      expect(snap0.ts).toBe(1000);
      expect(snap1.cycleNumber).toBe(1);
      expect(snap1.ts).toBe(2000);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('seal appends a seal line with finished_at and duration_ms', async () => {
    const root = await makeTmpDir();
    try {
      const fp = path.join(root, 'cast-100.jsonl');
      const writer = new ForensicTimelineWriter(fp, meta);
      await writer.appendSnapshot({
        ts: 1000,
        clones: [{ clone_id: 'A', state: 'WORKING', last_heartbeat_at: 1000 }],
      });
      await writer.seal(5000);

      const raw = await fs.readFile(fp, 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(2);

      const sealLine = JSON.parse(lines[1]!) as Record<string, unknown>;
      expect(sealLine.sealed).toBe(true);
      expect(sealLine.finished_at).toBe(5000);
      expect(sealLine.duration_ms).toBe(4000);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('getFilePath returns the configured path', () => {
    const writer = new ForensicTimelineWriter('/tmp/test.jsonl', meta);
    expect(writer.getFilePath()).toBe('/tmp/test.jsonl');
  });
});

describe('readForensicTimeline', () => {
  async function makeTmpDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'manta-timeline-'));
  }

  const meta = { cast_id: 'cast-100', mode: 'recon-swarm', started_at: 1000 };

  it('parses JSONL into ForensicTimeline with snapshots', async () => {
    const root = await makeTmpDir();
    try {
      const fp = path.join(root, 'cast-100.jsonl');
      const writer = new ForensicTimelineWriter(fp, meta);
      await writer.appendSnapshot({
        ts: 1000,
        clones: [{ clone_id: 'A', state: 'STARTING', last_heartbeat_at: 1000 }],
      });
      await writer.appendSnapshot({
        ts: 2000,
        clones: [{ clone_id: 'A', state: 'WORKING', last_heartbeat_at: 1500 }],
      });
      await writer.seal(5000);

      const timeline = await readForensicTimeline(fp, meta);
      expect(timeline).not.toBeNull();
      expect(timeline!.cast_id).toBe('cast-100');
      expect(timeline!.mode).toBe('recon-swarm');
      expect(timeline!.started_at).toBe(1000);
      expect(timeline!.finished_at).toBe(5000);
      expect(timeline!.duration_ms).toBe(4000);
      expect(timeline!.sealed).toBe(true);
      expect(timeline!.snapshots).toHaveLength(2);
      expect(timeline!.snapshots[0]!.cycleNumber).toBe(0);
      expect(timeline!.snapshots[1]!.cycleNumber).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('returns null for missing file', async () => {
    const result = await readForensicTimeline('/nonexistent/path.jsonl', meta);
    expect(result).toBeNull();
  });

  it('tolerates truncated last line', async () => {
    const root = await makeTmpDir();
    try {
      const fp = path.join(root, 'truncated.jsonl');
      const content =
        '{"ts":1000,"cycleNumber":0,"clones":[{"clone_id":"A","state":"WORKING","last_heartbeat_at":1000}]}\n' +
        '{"ts":2000,"cycleNumb';
      await fs.writeFile(fp, content, 'utf8');

      const timeline = await readForensicTimeline(fp, meta);
      expect(timeline).not.toBeNull();
      expect(timeline!.snapshots).toHaveLength(1);
      expect(timeline!.sealed).toBe(false);
      expect(timeline!.finished_at).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('unsealed timeline has sealed=false and null finished_at', async () => {
    const root = await makeTmpDir();
    try {
      const fp = path.join(root, 'unsealed.jsonl');
      const writer = new ForensicTimelineWriter(fp, meta);
      await writer.appendSnapshot({
        ts: 1000,
        clones: [{ clone_id: 'A', state: 'WORKING', last_heartbeat_at: 1000 }],
      });

      const timeline = await readForensicTimeline(fp, meta);
      expect(timeline!.sealed).toBe(false);
      expect(timeline!.finished_at).toBeNull();
      expect(timeline!.duration_ms).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

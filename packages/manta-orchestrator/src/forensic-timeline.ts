import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CloneState } from '@manta/bus';

export interface TimelineCloneSnapshot {
  clone_id: string;
  state: CloneState;
  last_heartbeat_at: number;
  progress?: string | undefined;
  death_reason?: string | undefined;
  died_at?: number | undefined;
}

export interface TimelineSnapshot {
  ts: number;
  cycleNumber: number;
  clones: TimelineCloneSnapshot[];
}

interface SealLine {
  sealed: true;
  finished_at: number;
  duration_ms: number;
}

export interface ForensicTimeline {
  cast_id: string;
  mode: string;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  sealed: boolean;
  snapshots: TimelineSnapshot[];
}

export class ForensicTimelineWriter {
  private cycleNumber = 0;

  constructor(
    private readonly filePath: string,
    private readonly meta: { cast_id: string; mode: string; started_at: number },
  ) {}

  async appendSnapshot(snapshot: Omit<TimelineSnapshot, 'cycleNumber'>): Promise<void> {
    const line: TimelineSnapshot = { ...snapshot, cycleNumber: this.cycleNumber++ };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, JSON.stringify(line) + '\n', 'utf8');
  }

  async seal(finishedAt: number): Promise<void> {
    const sealLine: SealLine = {
      sealed: true,
      finished_at: finishedAt,
      duration_ms: finishedAt - this.meta.started_at,
    };
    await fs.appendFile(this.filePath, JSON.stringify(sealLine) + '\n', 'utf8');
  }

  getFilePath(): string {
    return this.filePath;
  }
}

export async function readForensicTimeline(
  filePath: string,
  meta?: { cast_id: string; mode: string; started_at: number },
): Promise<ForensicTimeline | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  const snapshots: TimelineSnapshot[] = [];
  let sealData: SealLine | null = null;

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.sealed === true) {
        sealData = parsed as unknown as SealLine;
      } else {
        snapshots.push(parsed as unknown as TimelineSnapshot);
      }
    } catch {
      // Truncated last line — same crash-safety as EventsLog.readAll
    }
  }

  return {
    cast_id: meta?.cast_id ?? '',
    mode: meta?.mode ?? '',
    started_at: meta?.started_at ?? (snapshots[0]?.ts ?? 0),
    finished_at: sealData?.finished_at ?? null,
    duration_ms: sealData?.duration_ms ?? null,
    sealed: sealData !== null,
    snapshots,
  };
}

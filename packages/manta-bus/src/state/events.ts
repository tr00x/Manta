import * as fs from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { appendJsonLine } from '../atomic-fs';
import type { Clock } from '../clock';
import type { BusPaths } from './paths';

export interface BusEvent {
  id: string;
  ts: number;
  type: string;
  clone_id?: string;
  payload: unknown;
}

export type AppendInput = Omit<BusEvent, 'id' | 'ts'>;

export class EventsLog {
  constructor(private readonly paths: BusPaths, private readonly clock: Clock) {}

  async append(input: AppendInput): Promise<BusEvent> {
    const event: BusEvent = {
      id: nanoid(12),
      ts: this.clock.now(),
      ...input,
    };
    await appendJsonLine(this.paths.eventsLog, event);
    return event;
  }

  async readAll(): Promise<BusEvent[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.paths.eventsLog, 'utf8');
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as BusEvent);
  }

  async readSince(tsExclusive: number): Promise<BusEvent[]> {
    const all = await this.readAll();
    return all.filter((e) => e.ts > tsExclusive);
  }
}

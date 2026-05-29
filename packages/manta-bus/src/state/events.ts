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

/**
 * Append-only JSONL events log.
 *
 * **Ordering contract:**
 *   - Append-order in the JSONL file is the *authoritative* event order.
 *     Readers (`readAll` / `readSince`) preserve file order — they must not
 *     re-sort by id or ts.
 *   - Event IDs are designed to be lex-sortable as a *secondary* ordering
 *     hint: `<13-digit-ms-epoch>-<6-digit-per-process-seq>-<random-suffix>`.
 *     Within a single process, IDs are strictly monotonic. Across processes,
 *     IDs are *approximately* monotonic (best-effort; clocks may skew). Do
 *     not rely on global cross-process id-monotonicity — use file order.
 *
 * **Crash safety:**
 *   - `readAll` tolerates a truncated last line (writer crashed mid-append).
 *     Malformed lines are skipped with a single `console.warn`. The well-
 *     formed prefix is returned in order.
 */
export class EventsLog {
  // Per-process counter, scoped to one EventsLog instance so multiple stores
  // pointed at the same file in the same process still produce monotonic ids
  // (modulo the random suffix — see class JSDoc). Cross-process collision
  // resistance comes from `nanoid(6)` at the tail.
  #seq = 0;

  constructor(private readonly paths: BusPaths, private readonly clock: Clock) {}

  async append(input: AppendInput): Promise<BusEvent> {
    const now = this.clock.now();
    // Pad ts to 13 digits — sufficient through Sep 2286 (the Y2.286K problem
    // we are explicitly not solving today). Pad seq to 6 digits — enough for
    // 10^6 events/ms without overflowing the lex-sort prefix; if a single
    // process ever hits that rate we have bigger problems. Random suffix
    // breaks ties between processes appending in the same ms.
    const padded = String(now).padStart(13, '0');
    const seq = String(this.#seq++).padStart(6, '0');
    const id = `${padded}-${seq}-${nanoid(6)}`;
    const event: BusEvent = {
      id,
      ts: now,
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
    const out: BusEvent[] = [];
    let skipped = 0;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as BusEvent);
      } catch {
        // Truncated last line from a writer that crashed mid-append.
        // Skip-and-warn is the recovery path — typed errors here would
        // poison every reader for one bad tail line.
        skipped++;
      }
    }
    if (skipped > 0) {
      // eslint-disable-next-line no-console -- Reason: operational warning on torn-tail recovery; skip-and-warn avoids poisoning every reader for one bad line.
      console.warn(
        `EventsLog.readAll: skipped ${skipped} malformed line(s) in ${this.paths.eventsLog} (likely a torn last write)`,
      );
    }
    return out;
  }

  /**
   * Events appended strictly after `idExclusive`, in file (authoritative) order.
   *
   * The cursor is an event *id*, not a ts: ids are lex-sortable
   * `<padded-ts>-<seq>-<rand>`, so same-ms events stay distinguishable. A ts
   * cursor (`e.ts > cursor`) drops every event that ties the cursor on the
   * millisecond (bug #42). Empty string sorts before any real id, so
   * `readSince('')` returns all events. Mirrors `BroadcastReader`'s cursor.
   */
  async readSince(idExclusive: string): Promise<BusEvent[]> {
    const all = await this.readAll();
    return all.filter((e) => e.id > idExclusive);
  }
}

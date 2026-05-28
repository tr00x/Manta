export interface EventSource {
  readAll: () => Promise<Array<{ id: string; ts: number; type: string; payload: unknown }>>;
}

export class BroadcastReader {
  // Bus event ids are lex-sortable `<padded-ts>-<seq>-<rand>` (see
  // packages/manta-bus/src/state/events.ts). Tracking the id cursor — not ts —
  // means same-ms broadcasts from distinct appends are still distinguishable.
  // Empty string sorts before any real id, so the first readNew() sees all events.
  private lastProcessedId = '';

  constructor(
    private readonly castId: string,
    private readonly events: EventSource,
  ) {}

  async readNew(): Promise<Array<{ clone_id: string; event_type: string; payload: Record<string, unknown> }>> {
    const all = await this.events.readAll();
    const fresh = all.filter(
      (e) =>
        e.type === 'broadcast' &&
        e.id > this.lastProcessedId &&
        (e.payload as Record<string, unknown>)?.cast_id === this.castId,
    );
    if (fresh.length > 0) {
      // Take the max id seen in this batch as the new cursor. Within a single
      // bus process ids are strictly monotonic by append order; across
      // processes they're approximately monotonic (clocks may skew slightly),
      // which is acceptable because each cast is served by one bus.
      let maxId = this.lastProcessedId;
      for (const e of fresh) {
        if (e.id > maxId) maxId = e.id;
      }
      this.lastProcessedId = maxId;
    }
    return fresh.map((e) => {
      const p = e.payload as Record<string, unknown>;
      return {
        clone_id: String(p.clone_id ?? ''),
        event_type: String(p.event_type ?? ''),
        payload: (p.body as Record<string, unknown>) ?? {},
      };
    });
  }
}

export class BroadcastReader {
  private lastProcessedTs = 0;

  constructor(
    private readonly castId: string,
    private readonly events: { readAll: () => Promise<Array<{ ts: number; type: string; payload: unknown }>> },
  ) {}

  async readNew(): Promise<Array<{ clone_id: string; event_type: string; payload: Record<string, unknown> }>> {
    const all = await this.events.readAll();
    const fresh = all.filter(
      (e) => e.type === 'broadcast' && e.ts > this.lastProcessedTs &&
        (e.payload as Record<string, unknown>)?.cast_id === this.castId,
    );
    if (fresh.length > 0) {
      this.lastProcessedTs = Math.max(...fresh.map((e) => e.ts));
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

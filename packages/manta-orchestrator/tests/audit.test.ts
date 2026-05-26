import { describe, it, expect } from 'vitest';
import type { BusEvent, CloneRecord } from '@manta/bus';
import { BusNotFoundError } from '@manta/bus';
import { createCastEventSequence } from './fixtures/event-factory';
import {
  buildAuditLog,
  renderAuditMarkdown,
  renderAuditJson,
  EVENT_TYPE_GROUPS,
  type AuditBusContext,
} from '../src/audit';

function makeCloneRecord(id: string, overrides: Partial<CloneRecord> = {}): CloneRecord {
  return {
    clone_id: id,
    mode: 'recon-swarm',
    parent_pid: 1234,
    worktree: `/tmp/${id}`,
    metadata: { cast_id: 'cast-audit-1' },
    registered_at: 3000,
    last_heartbeat_at: 7000,
    state: 'DEAD',
    death_reason: 'task complete',
    died_at: 122000,
    ...overrides,
  };
}

function makeCtx(opts: {
  records?: Record<string, CloneRecord> | undefined;
  events?: BusEvent[] | undefined;
} = {}): AuditBusContext {
  const records = opts.records ?? { A: makeCloneRecord('A') };
  const events = opts.events ?? createCastEventSequence({
    castId: 'cast-audit-1',
    cloneIds: ['A', 'B'],
    startTs: 1000,
  });

  return {
    registry: {
      get: async (id: string): Promise<CloneRecord> => {
        const r = records[id];
        if (!r) throw new BusNotFoundError('clone', id);
        return r;
      },
    },
    events: {
      readAll: async (): Promise<BusEvent[]> => events,
    },
  };
}

describe('EVENT_TYPE_GROUPS', () => {
  it('covers all expected groups', () => {
    expect(Object.keys(EVENT_TYPE_GROUPS)).toEqual(
      expect.arrayContaining(['lifecycle', 'contract', 'resources', 'communication', 'knowledge', 'orchestrator']),
    );
  });

  it('includes register in lifecycle', () => {
    expect(EVENT_TYPE_GROUPS.lifecycle).toContain('register');
  });

  it('includes zk_write in knowledge', () => {
    expect(EVENT_TYPE_GROUPS.knowledge).toContain('zk_write');
  });
});

describe('buildAuditLog', () => {
  it('filters events to target clone only', async () => {
    const ctx = makeCtx();
    const log = await buildAuditLog(ctx, 'A');

    for (const entry of log.entries) {
      expect(entry.event.clone_id).toBe('A');
    }
  });

  it('computes gaps between consecutive events', async () => {
    const ctx = makeCtx();
    const log = await buildAuditLog(ctx, 'A');

    expect(log.entries.length).toBeGreaterThan(1);
    expect(log.entries[0]!.gapFromPreviousMs).toBe(0);
    for (let i = 1; i < log.entries.length; i++) {
      expect(log.entries[i]!.gapFromPreviousMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('identifies gap anomalies above threshold', async () => {
    const ctx = makeCtx();
    const log = await buildAuditLog(ctx, 'A', { gapThresholdMs: 5000 });

    for (const anomaly of log.gapAnomalies) {
      expect(anomaly.gapMs).toBeGreaterThan(5000);
    }
  });

  it('computes stats correctly', async () => {
    const ctx = makeCtx();
    const log = await buildAuditLog(ctx, 'A');

    expect(log.stats.totalEvents).toBe(log.entries.length);
    expect(log.stats.lifespanMs).toBeTypeOf('number');
    if (log.entries.length > 1) {
      expect(log.stats.avgGapMs).toBeTypeOf('number');
      expect(log.stats.maxGapMs).toBeTypeOf('number');
    }
  });

  it('populates clone metadata', async () => {
    const ctx = makeCtx();
    const log = await buildAuditLog(ctx, 'A');

    expect(log.cloneId).toBe('A');
    expect(log.mode).toBe('recon-swarm');
    expect(log.registeredAt).toBe(3000);
    expect(log.diedAt).toBe(122000);
    expect(log.deathReason).toBe('task complete');
  });

  it('applies since filter', async () => {
    const ctx = makeCtx();
    const log = await buildAuditLog(ctx, 'A', { since: 50000 });

    for (const entry of log.entries) {
      expect(entry.event.ts).toBeGreaterThanOrEqual(50000);
    }
  });

  it('throws BusNotFoundError for unknown clone', async () => {
    const ctx = makeCtx();
    await expect(buildAuditLog(ctx, 'Z')).rejects.toThrow(BusNotFoundError);
  });

  it('handles clone with no events', async () => {
    const ctx = makeCtx({
      records: { X: makeCloneRecord('X') },
      events: [],
    });
    const log = await buildAuditLog(ctx, 'X');

    expect(log.entries).toHaveLength(0);
    expect(log.gapAnomalies).toHaveLength(0);
    expect(log.stats.totalEvents).toBe(0);
    expect(log.stats.avgGapMs).toBeNull();
    expect(log.stats.maxGapMs).toBeNull();
  });
});

describe('renderAuditMarkdown', () => {
  it('produces markdown with header and entries', async () => {
    const ctx = makeCtx();
    const log = await buildAuditLog(ctx, 'A');
    const md = renderAuditMarkdown(log);

    expect(md).toContain('# Audit');
    expect(md).toContain('clone A');
    expect(md).toContain('recon-swarm');
    expect(md).toContain('## Statistics');
  });
});

describe('renderAuditJson', () => {
  it('returns the log object', async () => {
    const ctx = makeCtx();
    const log = await buildAuditLog(ctx, 'A');
    const json = renderAuditJson(log);

    expect(json).toBe(log);
    expect(json.cloneId).toBe('A');
  });
});

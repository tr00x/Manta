import { describe, it, expect } from 'vitest';
import { createReporter, MemorySink } from '../../src/output/reporter.js';
import type { LogLine } from '../../src/output/reporter.js';

describe('reporter', () => {
  it('logs structured events to the sink', () => {
    const sink = new MemorySink();
    const r = createReporter({ sink });
    r.info('cast.spawn', { cloneId: 'A' });
    r.warn('cast.slow', { cloneId: 'A', age: 30 });
    r.error('cast.fail', { cloneId: 'A', reason: 'fail' });
    expect(sink.lines.map((l: LogLine) => l.level)).toEqual(['info', 'warn', 'error']);
    expect(sink.lines[0]!.event).toBe('cast.spawn');
  });

  it('serializes payloads to readable text', () => {
    const sink = new MemorySink();
    const r = createReporter({ sink });
    r.info('x', { a: 1, b: 'two' });
    expect(sink.lines[0]!.rendered).toContain('a=1');
    expect(sink.lines[0]!.rendered).toContain('b=two');
  });
});

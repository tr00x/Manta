import { describe, it, expect } from 'vitest';
import { sleep } from '../../src/util/sleep.js';

describe('sleep', () => {
  it('resolves after the specified duration', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('resolves immediately on pre-aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const start = Date.now();
    await sleep(5000, ctrl.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('resolves early on mid-sleep abort', async () => {
    const ctrl = new AbortController();
    const start = Date.now();
    setTimeout(() => ctrl.abort(), 30);
    await sleep(5000, ctrl.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicReadJson, atomicMutateJson, appendJsonLine } from '../src/atomic-fs';
import { makeTmpRoot } from './helpers/tmpRoot';

describe('atomic-fs', () => {
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
  });
  afterEach(async () => {
    await cleanup();
  });

  it('atomicReadJson returns the default when file is missing', async () => {
    const result = await atomicReadJson<{ x: number }>(path.join(root, 'missing.json'), () => ({ x: 0 }));
    expect(result).toEqual({ x: 0 });
  });

  it('atomicReadJson parses an existing JSON file', async () => {
    const file = path.join(root, 'file.json');
    await fs.writeFile(file, JSON.stringify({ x: 5 }));
    const result = await atomicReadJson<{ x: number }>(file, () => ({ x: 0 }));
    expect(result).toEqual({ x: 5 });
  });

  it('atomicMutateJson read-modify-writes through a function', async () => {
    const file = path.join(root, 'state.json');
    await atomicMutateJson<{ counter: number }>(
      file,
      () => ({ counter: 0 }),
      (current) => ({ counter: current.counter + 1 }),
    );
    const after = JSON.parse(await fs.readFile(file, 'utf8')) as { counter: number };
    expect(after).toEqual({ counter: 1 });
  });

  it('atomicMutateJson is safe under concurrent calls (no lost updates)', async () => {
    const file = path.join(root, 'state.json');
    const init = (): { counter: number } => ({ counter: 0 });
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, () =>
        atomicMutateJson<{ counter: number }>(file, init, (cur) => ({ counter: cur.counter + 1 })),
      ),
    );
    const after = JSON.parse(await fs.readFile(file, 'utf8')) as { counter: number };
    expect(after.counter).toBe(N);
  });

  it('atomicMutateJson rolls back if mutator throws', async () => {
    const file = path.join(root, 'state.json');
    await atomicMutateJson<{ x: number }>(file, () => ({ x: 1 }), (cur) => ({ x: cur.x + 1 }));
    await expect(
      atomicMutateJson<{ x: number }>(
        file,
        () => ({ x: 0 }),
        () => {
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');
    const after = JSON.parse(await fs.readFile(file, 'utf8')) as { x: number };
    expect(after).toEqual({ x: 2 });
  });

  it('appendJsonLine writes one line per call and survives partial reads', async () => {
    const file = path.join(root, 'events.jsonl');
    await appendJsonLine(file, { i: 1 });
    await appendJsonLine(file, { i: 2 });
    await appendJsonLine(file, { i: 3 });
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => (JSON.parse(l) as { i: number }).i)).toEqual([1, 2, 3]);
  });

  it('appendJsonLine is safe under concurrency', async () => {
    const file = path.join(root, 'events.jsonl');
    const N = 50;
    await Promise.all(Array.from({ length: N }, (_, i) => appendJsonLine(file, { i })));
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(N);
    // every line must be a parseable JSON object
    for (const l of lines) {
      expect(() => JSON.parse(l) as unknown).not.toThrow();
    }
  });
});

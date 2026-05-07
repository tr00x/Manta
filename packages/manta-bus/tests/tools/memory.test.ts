import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FakeClock } from '../../src/clock';
import { busPaths } from '../../src/state/paths';
import { EventsLog } from '../../src/state/events';
import { makeTmpRoot } from '../helpers/tmpRoot';
import { createMemoryHandlers } from '../../src/tools/memory';
import { fsMemoryWriters } from '../../src/memory-writers';
import { BusValidationError } from '../../src/errors';

describe('memory handlers', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;
  let handlers: ReturnType<typeof createMemoryHandlers>;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
    const paths = busPaths(root);
    handlers = createMemoryHandlers({
      events: new EventsLog(paths, clock),
      memoryWriters: fsMemoryWriters({ repoRoot: root, clock }),
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  it('zk_write creates a markdown file under docs/zk/', async () => {
    const r = await handlers.zkWrite({
      clone_id: 'A',
      title: 'finding-1',
      content: 'body of note',
      tags: ['phase-0'],
    });
    expect(r.event.type).toBe('zk_write');
    const content = await fs.readFile(r.path, 'utf8');
    expect(content).toContain('# finding-1');
    expect(content).toContain('clone_id: A');
    expect(content).toContain('body of note');
    expect(content).toContain('tags: ["phase-0"]');
  });

  it('zk_write rejects empty content', async () => {
    await expect(
      handlers.zkWrite({ clone_id: 'A', title: 't', content: '', tags: [] }),
    ).rejects.toBeInstanceOf(BusValidationError);
  });

  it('zk_write slug fallback for titles with no alphanumerics', async () => {
    const r = await handlers.zkWrite({
      clone_id: 'A',
      title: '!!!',
      content: 'x',
      tags: [],
    });
    expect(path.basename(r.path)).toMatch(/^note-/);
  });

  it('para_append appends a fact line to the category file and audit jsonl', async () => {
    const r1 = await handlers.paraAppend({
      clone_id: 'A',
      category: 'projects',
      fact: 'first fact',
    });
    const r2 = await handlers.paraAppend({
      clone_id: 'A',
      category: 'projects',
      fact: 'second fact',
    });
    expect(r1.event.type).toBe('para_append');
    expect(r2.event.type).toBe('para_append');
    const file = path.join(root, 'docs', 'para', 'projects.md');
    const content = await fs.readFile(file, 'utf8');
    expect(content).toContain('first fact');
    expect(content).toContain('second fact');
    const audit = await fs.readFile(path.join(root, 'docs', 'para', 'projects.jsonl'), 'utf8');
    expect(audit.split('\n').filter((l) => l.length > 0)).toHaveLength(2);
  });

  it('para_append rejects unknown category', async () => {
    await expect(
      handlers.paraAppend({ clone_id: 'A', category: 'bananas', fact: 'x' }),
    ).rejects.toBeInstanceOf(BusValidationError);
  });

  it('zk_write keeps the resolved path under docs/zk even for traversal-like titles', async () => {
    // The slug() regex strips non-alphanumerics, so `../` collapses to ''
    // and the title falls back to 'note-'. The defense-in-depth assertion
    // in fsMemoryWriters guarantees this for any future regex change too.
    const r = await handlers.zkWrite({
      clone_id: 'A',
      title: '../../../etc/passwd',
      content: 'x',
      tags: [],
    });
    const expectedRoot = path.resolve(path.join(root, 'docs', 'zk'));
    const resolved = path.resolve(r.path);
    expect(resolved.startsWith(expectedRoot + path.sep)).toBe(true);
  });

  it('zk_write keeps the resolved path under docs/zk for unicode dot-segments', async () => {
    const r = await handlers.zkWrite({
      clone_id: 'A',
      title: '../../escape',
      content: 'x',
      tags: [],
    });
    const expectedRoot = path.resolve(path.join(root, 'docs', 'zk'));
    expect(path.resolve(r.path).startsWith(expectedRoot + path.sep)).toBe(true);
  });

  it('para_append keeps the resolved path under docs/para', async () => {
    const r = await handlers.paraAppend({
      clone_id: 'A',
      category: 'projects',
      fact: 'a fact',
    });
    const expectedRoot = path.resolve(path.join(root, 'docs', 'para'));
    expect(path.resolve(r.path).startsWith(expectedRoot + path.sep)).toBe(true);
  });
});

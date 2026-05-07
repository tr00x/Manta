import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FakeClock } from '../src/clock';
import { busPaths } from '../src/state/paths';
import { Registry } from '../src/state/registry';
import { LocksStore } from '../src/state/locks';
import { ClaimsStore } from '../src/state/claims';
import { ContractsStore } from '../src/state/contracts';
import { EventsLog } from '../src/state/events';
import { fsMemoryWriters } from '../src/memory-writers';
import { createLifecycleHandlers } from '../src/tools/lifecycle';
import { createLockHandlers } from '../src/tools/locks';
import { createWorkHandlers } from '../src/tools/work';
import { createContractHandlers } from '../src/tools/contract';
import { createMemoryHandlers } from '../src/tools/memory';
import { makeTmpRoot } from './helpers/tmpRoot';

/**
 * Fault-injection coverage for the audit-trail invariant
 * (ARCHITECTURE.md "Audit-trail invariant"): when `events.append` throws,
 * the state mutation it was paired with MUST NOT land. This exercises every
 * mutating tool family that couples to a JSON store.
 */
describe('audit-trail invariant — events.append fault aborts state mutation', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let clock: FakeClock;

  beforeEach(async () => {
    ({ root, cleanup } = await makeTmpRoot());
    clock = new FakeClock(1_000_000);
  });
  afterEach(async () => {
    await cleanup();
  });

  it('lifecycle.register: failing events.append leaves registry empty', async () => {
    const paths = busPaths(root);
    const registry = new Registry(paths, clock);
    const events = new EventsLog(paths, clock);
    vi.spyOn(events, 'append').mockRejectedValueOnce(new Error('disk full'));
    const handlers = createLifecycleHandlers({ registry, events });

    await expect(
      handlers.register({
        clone_id: 'A',
        mode: 'recon-swarm',
        parent_pid: 1,
        worktree: '/w',
        metadata: {},
      }),
    ).rejects.toThrow(/disk full/);

    // Registry file should not contain 'A' — the mutator was aborted before
    // the tmp+rename commit. (`registry.json` may exist as the empty
    // placeholder created before locking, but its parsed clones map is empty.)
    expect(await registry.list()).toEqual([]);
  });

  it('locks.lock: failing events.append leaves no lease', async () => {
    const paths = busPaths(root);
    const locks = new LocksStore(paths, clock, { staleAfterMs: 15_000 });
    const events = new EventsLog(paths, clock);
    vi.spyOn(events, 'append').mockRejectedValueOnce(new Error('lock log fail'));
    const handlers = createLockHandlers({ locks, events });

    await expect(
      handlers.lock({ clone_id: 'A', path: 'src/foo.ts' }),
    ).rejects.toThrow(/lock log fail/);

    expect(await locks.listOwned('A')).toEqual([]);
  });

  it('work.claim: failing events.append leaves no claim', async () => {
    const paths = busPaths(root);
    const claims = new ClaimsStore(paths, clock);
    const events = new EventsLog(paths, clock);
    vi.spyOn(events, 'append').mockRejectedValueOnce(new Error('claim log fail'));
    const handlers = createWorkHandlers({ claims, events });

    await expect(
      handlers.claim({ clone_id: 'A', item: 'task-1', timeout_ms: 60_000 }),
    ).rejects.toThrow(/claim log fail/);

    expect(await claims.list()).toEqual([]);
  });

  it('contract.write: failing events.append leaves no stored contract', async () => {
    const paths = busPaths(root);
    const contracts = new ContractsStore(paths, clock);
    const events = new EventsLog(paths, clock);
    vi.spyOn(events, 'append').mockRejectedValueOnce(new Error('contract log fail'));
    const handlers = createContractHandlers({ contracts, events });

    await expect(
      handlers.write({
        contract: {
          clone_id: 'A',
          mode: 'recon-swarm',
          task: 'do the thing',
          scope: {
            allowed_paths: ['src/'],
            forbidden_paths: [],
            max_files_changed: 5,
          },
          sibling_clones: [],
          deadline_ms: 60_000,
        },
      }),
    ).rejects.toThrow(/contract log fail/);

    // No contract file should exist for 'A' — the rename never ran.
    const contractFile = paths.contractFile('A');
    let exists = true;
    try {
      const stat = await fs.stat(contractFile);
      // The placeholder may exist (zero-byte) — what matters is no parsed
      // contract is stored.
      exists = stat.size > 0;
    } catch {
      exists = false;
    }
    if (exists) {
      // If the placeholder was upgraded to a real file, that would be a
      // protocol violation.
      const raw = await fs.readFile(contractFile, 'utf8');
      expect(raw).toBe('');
    }
  });

  it('memory.zk_write: failing events.append leaves no markdown file on disk', async () => {
    const paths = busPaths(root);
    const events = new EventsLog(paths, clock);
    const memoryWriters = fsMemoryWriters({ repoRoot: root, clock });
    vi.spyOn(events, 'append').mockRejectedValueOnce(new Error('zk log fail'));
    const handlers = createMemoryHandlers({ events, memoryWriters });

    await expect(
      handlers.zkWrite({ clone_id: 'A', title: 'lost', content: 'x', tags: [] }),
    ).rejects.toThrow(/zk log fail/);

    // The zk dir may have been created (mkdir is idempotent) but no .md
    // file should exist.
    const zkDir = path.join(root, 'docs', 'zk');
    let entries: string[] = [];
    try {
      entries = await fs.readdir(zkDir);
    } catch {
      // missing dir is fine — no write happened
      entries = [];
    }
    expect(entries.filter((e) => e.endsWith('.md'))).toEqual([]);
  });

  it('memory.para_append: failing events.append leaves no fact in markdown or jsonl', async () => {
    const paths = busPaths(root);
    const events = new EventsLog(paths, clock);
    const memoryWriters = fsMemoryWriters({ repoRoot: root, clock });
    vi.spyOn(events, 'append').mockRejectedValueOnce(new Error('para log fail'));
    const handlers = createMemoryHandlers({ events, memoryWriters });

    await expect(
      handlers.paraAppend({ clone_id: 'A', category: 'projects', fact: 'lost fact' }),
    ).rejects.toThrow(/para log fail/);

    const paraDir = path.join(root, 'docs', 'para');
    for (const f of ['projects.md', 'projects.jsonl']) {
      const target = path.join(paraDir, f);
      try {
        const raw = await fs.readFile(target, 'utf8');
        expect(raw).toBe('');
      } catch (err) {
        // ENOENT is acceptable — the file simply was never created.
        expect((err as { code?: string }).code).toBe('ENOENT');
      }
    }
  });
});

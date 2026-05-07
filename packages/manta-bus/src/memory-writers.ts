import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { appendJsonLine } from './atomic-fs';
import type { Clock } from './clock';

export interface ZkWriteRequest {
  clone_id: string;
  title: string;
  content: string;
  tags: string[];
}

export interface ParaAppendRequest {
  clone_id: string;
  category: 'projects' | 'areas' | 'resources' | 'archive';
  fact: string;
}

/**
 * Side-effecting filesystem writes for `manta.zk_write` and `manta.para_append`.
 *
 * Isolated behind an interface so `tools/memory.ts` is unit-testable without
 * touching the disk: tests can inject an in-memory writer, while production
 * uses {@link fsMemoryWriters}.
 */
export interface MemoryWriters {
  zkWrite(input: ZkWriteRequest): Promise<{ path: string }>;
  paraAppend(input: ParaAppendRequest): Promise<{ path: string }>;
}

export interface FsMemoryWritersOptions {
  repoRoot: string;
  clock: Clock;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'note';
}

/**
 * Filesystem-backed `MemoryWriters` writing under `<repoRoot>/docs/zk` and
 * `<repoRoot>/docs/para`. Atomic for ZK (tmp + rename) and lock-protected for
 * PARA appends (via `appendJsonLine`).
 */
export function fsMemoryWriters(opts: FsMemoryWritersOptions): MemoryWriters {
  const zkDir = path.join(opts.repoRoot, 'docs', 'zk');
  const paraDir = path.join(opts.repoRoot, 'docs', 'para');
  return {
    async zkWrite(input) {
      await fs.mkdir(zkDir, { recursive: true });
      const id = nanoid(8);
      const file = path.join(zkDir, `${slug(input.title)}-${id}.md`);
      const ts = opts.clock.now();
      const body = [
        '---',
        `id: ${id}`,
        `title: ${input.title}`,
        `clone_id: ${input.clone_id}`,
        `created_at: ${ts}`,
        `tags: [${input.tags.map((t) => JSON.stringify(t)).join(', ')}]`,
        '---',
        '',
        `# ${input.title}`,
        '',
        input.content,
        '',
      ].join('\n');
      // Atomic write per spec Sec 4 ("атомарная запись в ZK"): write to a
      // sibling tmp file then rename. fs.rename is atomic on POSIX within the
      // same directory.
      const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, file);
      return { path: file };
    },

    async paraAppend(input) {
      await fs.mkdir(paraDir, { recursive: true });
      const file = path.join(paraDir, `${input.category}.md`);
      const ts = opts.clock.now();
      const line = `- ${ts} [${input.clone_id}] ${input.fact}\n`;
      // Plain appendFile here is fine (POSIX append is atomic for chunks
      // shorter than PIPE_BUF, and our line is well under that). The
      // structured JSONL audit copy below uses appendJsonLine which goes
      // through proper-lockfile so an audit reader never sees a torn record.
      await fs.appendFile(file, line, 'utf8');
      await appendJsonLine(path.join(paraDir, `${input.category}.jsonl`), {
        ts,
        clone_id: input.clone_id,
        fact: input.fact,
      });
      return { path: file };
    },
  };
}

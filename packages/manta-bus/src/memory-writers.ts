import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { appendJsonLine } from './atomic-fs';
import type { Clock } from './clock';
import { BusValidationError } from './errors';

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
 *
 * `auditAppend` (optional) is invoked **before** the filesystem write — and
 * receives the computed target path so the audit event can record where the
 * write would land. If it throws, no file is created or modified. If the
 * filesystem write fails after a successful audit append, the audit log is
 * ahead of state — same write-ahead-log pattern as the JSON stores' fallback
 * path. See ARCHITECTURE.md "Audit-trail invariant".
 */
export interface MemoryWriters {
  zkWrite(
    input: ZkWriteRequest,
    auditAppend?: (computedPath: string) => Promise<void>,
  ): Promise<{ path: string }>;
  paraAppend(
    input: ParaAppendRequest,
    auditAppend?: (computedPath: string) => Promise<void>,
  ): Promise<{ path: string }>;
}

export interface FsMemoryWritersOptions {
  repoRoot: string;
  clock: Clock;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'note';
}

/**
 * Defense-in-depth path containment check. `slug()` already strips
 * non-alphanumerics so `../` collapses today, but a future regex change
 * could re-open the gap. This assert guarantees the resolved path stays
 * under `root` regardless of upstream slug semantics.
 */
function assertContained(root: string, file: string, label: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  if (
    resolvedFile !== resolvedRoot &&
    !resolvedFile.startsWith(resolvedRoot + path.sep)
  ) {
    throw new BusValidationError(
      `${label}: resolved path escapes memory root (${resolvedFile} not under ${resolvedRoot})`,
      [],
    );
  }
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
    async zkWrite(input, auditAppend) {
      await fs.mkdir(zkDir, { recursive: true });
      const id = nanoid(8);
      const file = path.join(zkDir, `${slug(input.title)}-${id}.md`);
      // Defense-in-depth: even if `slug()` ever lets a `../` segment slip
      // through, fail closed before touching the filesystem.
      assertContained(zkDir, file, 'zk_write');
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
      // Audit-first: if the caller's audit append fails, no file is written.
      // See ARCHITECTURE.md "Audit-trail invariant" for the rationale.
      if (auditAppend) await auditAppend(file);
      // Atomic write per spec Sec 4 ("атомарная запись в ZK"): write to a
      // sibling tmp file then rename. fs.rename is atomic on POSIX within the
      // same directory.
      const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, file);
      return { path: file };
    },

    async paraAppend(input, auditAppend) {
      await fs.mkdir(paraDir, { recursive: true });
      const file = path.join(paraDir, `${input.category}.md`);
      // Defense-in-depth: category is enum-restricted today by Zod, but the
      // assertion makes the containment guarantee explicit at the writer.
      assertContained(paraDir, file, 'para_append');
      const auditPath = path.join(paraDir, `${input.category}.jsonl`);
      assertContained(paraDir, auditPath, 'para_append');
      const ts = opts.clock.now();
      const line = `- ${ts} [${input.clone_id}] ${input.fact}\n`;
      if (auditAppend) await auditAppend(file);
      // Plain appendFile here is fine (POSIX append is atomic for chunks
      // shorter than PIPE_BUF, and our line is well under that). The
      // structured JSONL audit copy below uses appendJsonLine which goes
      // through proper-lockfile so an audit reader never sees a torn record.
      await fs.appendFile(file, line, 'utf8');
      await appendJsonLine(auditPath, {
        ts,
        clone_id: input.clone_id,
        fact: input.fact,
      });
      return { path: file };
    },
  };
}

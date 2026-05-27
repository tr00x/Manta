import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MergeAllResult, CloneGateEntry } from './merge-all';

export interface MergeAllDocument {
  filename: string;
  body: string;
}

export interface MergeAllWriter {
  write(doc: MergeAllDocument): Promise<{ path: string }>;
}

export interface FsMergeAllWriterOptions {
  repoRoot: string;
  mergeAllDir: string;
}

const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

function assertContained(root: string, candidate: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(`merge-all path escapes ${resolvedRoot}: ${resolvedCandidate}`);
  }
}

export function fsMergeAllWriter(opts: FsMergeAllWriterOptions): MergeAllWriter {
  return {
    async write(doc) {
      if (!SAFE_FILENAME.test(doc.filename)) {
        throw new Error(`unsafe merge-all filename: ${doc.filename}`);
      }
      const dir = path.resolve(opts.repoRoot, opts.mergeAllDir);
      await fs.mkdir(dir, { recursive: true });
      const file = path.resolve(dir, doc.filename);
      assertContained(dir, file);
      const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmp, doc.body, 'utf8');
      await fs.rename(tmp, file);
      return { path: file };
    },
  };
}

export interface InMemoryMergeAllWriter extends MergeAllWriter {
  captured: MergeAllDocument[];
}

export function inMemoryMergeAllWriter(): InMemoryMergeAllWriter {
  const captured: MergeAllDocument[] = [];
  return {
    captured,
    write(doc) {
      captured.push(doc);
      return Promise.resolve({ path: `mem://${doc.filename}` });
    },
  };
}

function gateStatusIcon(entry: CloneGateEntry): string {
  if (!entry.gate.hasDiff) return 'SKIP (empty diff)';
  if (!entry.gate.passed) return 'FAIL';
  return 'PASS';
}

export function renderMergeAllMarkdown(result: MergeAllResult): string {
  const lines: string[] = [];

  lines.push(`# Merge-All Report — ${result.castId}`);
  lines.push('');
  lines.push(`**Verdict:** ${result.verdict}`);
  lines.push(`**Merged:** ${result.merged.length} | **Skipped:** ${result.skipped.length} | **Conflicted:** ${result.conflicted.length}`);
  lines.push('');

  if (result.gateResults.length > 0) {
    lines.push('## Quality Gates');
    lines.push('');
    lines.push('| Clone | Status | Has Diff | TSC | Tests | Errors |');
    lines.push('|-------|--------|----------|-----|-------|--------|');
    for (const entry of result.gateResults) {
      const g = entry.gate;
      const errStr = g.errors.length > 0 ? g.errors.join('; ') : '—';
      lines.push(
        `| ${entry.cloneId} | ${gateStatusIcon(entry)} | ${g.hasDiff ? 'Yes' : 'No'} | ${g.tscOk ? 'Pass' : 'Fail'} | ${g.testsOk ? 'Pass' : 'Fail'} | ${errStr} |`,
      );
    }
    lines.push('');
  }

  if (result.merged.length > 0) {
    lines.push('## Merged Clones');
    lines.push('');
    for (const id of result.merged) {
      lines.push(`- ${id}: merged successfully`);
    }
    lines.push('');
  }

  if (result.skipped.length > 0) {
    lines.push('## Skipped Clones');
    lines.push('');
    for (const id of result.skipped) {
      const entry = result.gateResults.find(e => e.cloneId === id);
      const reason = entry && !entry.gate.hasDiff
        ? 'empty diff'
        : entry
          ? entry.gate.errors.join('; ')
          : 'unknown';
      lines.push(`- ${id}: ${reason}`);
    }
    lines.push('');
  }

  if (result.conflicted.length > 0) {
    lines.push('## Conflicted Clones (Escalated)');
    lines.push('');
    for (const id of result.conflicted) {
      lines.push(`- ${id}: merge conflict — aborted, requires manual resolution`);
    }
    lines.push('');
  }

  if (result.merged.length > 0) {
    lines.push('## Post-Merge');
    lines.push('');
    lines.push('Run `pnpm build && pnpm test` to verify merged state.');
    lines.push('');
  }

  return lines.join('\n');
}

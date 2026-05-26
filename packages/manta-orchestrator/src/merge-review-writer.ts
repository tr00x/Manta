import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface MergeReviewDocument {
  filename: string;
  body: string;
}

export interface MergeReviewWriter {
  write(doc: MergeReviewDocument): Promise<{ path: string }>;
}

export interface FsMergeReviewWriterOptions {
  repoRoot: string;
  mergeReviewDir: string;
}

const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

/**
 * Defense-in-depth: assert the resolved candidate path stays under root. The
 * SAFE_FILENAME regex above already rejects traversal sequences, but resolved-
 * path containment guards against future regex regressions.
 */
function assertContained(root: string, candidate: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(`merge-review path escapes ${resolvedRoot}: ${resolvedCandidate}`);
  }
}

export function fsMergeReviewWriter(opts: FsMergeReviewWriterOptions): MergeReviewWriter {
  return {
    async write(doc) {
      if (!SAFE_FILENAME.test(doc.filename)) {
        throw new Error(`unsafe merge-review filename: ${doc.filename}`);
      }
      const dir = path.resolve(opts.repoRoot, opts.mergeReviewDir);
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

export interface InMemoryMergeReviewWriter extends MergeReviewWriter {
  captured: MergeReviewDocument[];
}

export function inMemoryMergeReviewWriter(): InMemoryMergeReviewWriter {
  const captured: MergeReviewDocument[] = [];
  return {
    captured,
    write(doc) {
      captured.push(doc);
      return Promise.resolve({ path: `mem://${doc.filename}` });
    },
  };
}

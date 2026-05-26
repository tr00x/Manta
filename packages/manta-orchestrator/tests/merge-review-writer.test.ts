import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fsMergeReviewWriter, inMemoryMergeReviewWriter } from '../src/merge-review-writer';

describe('merge-review-writer', () => {
  it('inMemoryMergeReviewWriter captures writes', async () => {
    const w = inMemoryMergeReviewWriter();
    await w.write({ filename: 'cast-abc.md', body: '# Merge Review\n\nbody\n' });
    expect(w.captured).toHaveLength(1);
    expect(w.captured[0]!.filename).toBe('cast-abc.md');
    expect(w.captured[0]!.body).toContain('# Merge Review');
  });

  it('fsMergeReviewWriter writes atomically under repoRoot/mergeReviewDir', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-mr-'));
    try {
      const w = fsMergeReviewWriter({ repoRoot: root, mergeReviewDir: 'docs/merge-reviews' });
      await w.write({ filename: 'cast-xyz.md', body: '# Review\n' });
      const file = path.join(root, 'docs/merge-reviews', 'cast-xyz.md');
      const content = await fs.readFile(file, 'utf8');
      expect(content).toBe('# Review\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fsMergeReviewWriter creates the mergeReviewDir if missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-mr-'));
    try {
      const w = fsMergeReviewWriter({ repoRoot: root, mergeReviewDir: 'nested/deep/reviews' });
      await w.write({ filename: 'doc.md', body: 'content' });
      const file = path.join(root, 'nested/deep/reviews', 'doc.md');
      await expect(fs.access(file)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fsMergeReviewWriter rejects unsafe filenames', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-mr-'));
    try {
      const w = fsMergeReviewWriter({ repoRoot: root, mergeReviewDir: 'docs/merge-reviews' });
      await expect(w.write({ filename: '../escape.md', body: 'x' })).rejects.toThrow('unsafe merge-review filename');
      await expect(w.write({ filename: 'sub/dir.md', body: 'x' })).rejects.toThrow('unsafe merge-review filename');
      await expect(w.write({ filename: '/etc/passwd', body: 'x' })).rejects.toThrow('unsafe merge-review filename');
      await expect(w.write({ filename: '', body: 'x' })).rejects.toThrow('unsafe merge-review filename');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fsMergeReviewWriter returns path under configured directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-mr-'));
    try {
      const w = fsMergeReviewWriter({ repoRoot: root, mergeReviewDir: 'docs/merge-reviews' });
      const result = await w.write({ filename: 'cast-review-1.md', body: 'body\n' });
      const expectedDir = await fs.realpath(path.join(root, 'docs/merge-reviews'));
      const writtenReal = await fs.realpath(result.path);
      expect(writtenReal.startsWith(expectedDir + path.sep)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

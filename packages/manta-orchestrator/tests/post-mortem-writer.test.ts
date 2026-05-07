import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fsPostMortemWriter, inMemoryPostMortemWriter } from '../src/post-mortem-writer';

describe('post-mortem-writer', () => {
  it('inMemoryPostMortemWriter captures writes', async () => {
    const w = inMemoryPostMortemWriter();
    await w.write({ filename: '2026-05-06-cast-1-A.md', body: '# title\n\nbody\n' });
    expect(w.captured).toHaveLength(1);
    expect(w.captured[0]!.filename).toBe('2026-05-06-cast-1-A.md');
    expect(w.captured[0]!.body).toContain('# title');
  });

  it('fsPostMortemWriter writes atomically under repoRoot/postMortemDir', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-pm-'));
    try {
      const w = fsPostMortemWriter({ repoRoot: root, postMortemDir: 'docs/post-mortems' });
      await w.write({ filename: '2026-05-06-cast-1-A.md', body: '# A\n' });
      const file = path.join(root, 'docs/post-mortems', '2026-05-06-cast-1-A.md');
      const content = await fs.readFile(file, 'utf8');
      expect(content).toBe('# A\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fsPostMortemWriter creates the postMortemDir if missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-pm-'));
    try {
      const w = fsPostMortemWriter({ repoRoot: root, postMortemDir: 'nested/deep/dir' });
      await w.write({ filename: 'note.md', body: 'x' });
      const file = path.join(root, 'nested/deep/dir', 'note.md');
      await expect(fs.access(file)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fsPostMortemWriter rejects path traversal in filename', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-pm-'));
    try {
      const w = fsPostMortemWriter({ repoRoot: root, postMortemDir: 'docs/post-mortems' });
      await expect(w.write({ filename: '../escape.md', body: 'x' })).rejects.toThrow();
      await expect(w.write({ filename: 'sub/dir.md', body: 'x' })).rejects.toThrow();
      await expect(w.write({ filename: '/etc/passwd', body: 'x' })).rejects.toThrow();
      await expect(w.write({ filename: '..\\windows-escape.md', body: 'x' })).rejects.toThrow();
      await expect(w.write({ filename: '', body: 'x' })).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

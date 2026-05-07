import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface PostMortemDocument {
  filename: string;
  body: string;
}

export interface PostMortemWriter {
  write(doc: PostMortemDocument): Promise<{ path: string }>;
}

export interface FsPostMortemWriterOptions {
  repoRoot: string;
  postMortemDir: string;
}

const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

export function fsPostMortemWriter(opts: FsPostMortemWriterOptions): PostMortemWriter {
  return {
    async write(doc) {
      if (!SAFE_FILENAME.test(doc.filename)) {
        throw new Error(`unsafe post-mortem filename: ${doc.filename}`);
      }
      const dir = path.join(opts.repoRoot, opts.postMortemDir);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, doc.filename);
      const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmp, doc.body, 'utf8');
      await fs.rename(tmp, file);
      return { path: file };
    },
  };
}

export interface InMemoryPostMortemWriter extends PostMortemWriter {
  captured: PostMortemDocument[];
}

export function inMemoryPostMortemWriter(): InMemoryPostMortemWriter {
  const captured: PostMortemDocument[] = [];
  return {
    captured,
    write(doc) {
      captured.push(doc);
      return Promise.resolve({ path: `mem://${doc.filename}` });
    },
  };
}

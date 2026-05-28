import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

async function walkFiles(root: string, current: string, acc: string[]): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(current, e.name);
    if (e.isDirectory()) {
      await walkFiles(root, full, acc);
    } else if (e.isFile()) {
      acc.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
}

/**
 * Canonical content-tree hash for a directory.
 *
 * Algorithm:
 *  1. Walk every regular file under `root` (recursive).
 *  2. For each file, compute sha256 of its bytes (hex).
 *  3. Sort by relative path (POSIX separators).
 *  4. Build a transcript `<relpath>:<sha256>` per file, joined by '\n'.
 *  5. Return `sha256-` + base64(sha256(transcript)).
 *
 * Deterministic across machines: depends only on file paths and content,
 * not mtime, permissions, or directory inode order.
 */
export async function computeDirDigest(root: string): Promise<string> {
  const files: string[] = [];
  await walkFiles(root, root, files);
  files.sort();

  const lines: string[] = [];
  for (const rel of files) {
    const data = await fs.readFile(path.join(root, ...rel.split('/')));
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    lines.push(`${rel}:${sha}`);
  }
  const transcript = lines.join('\n');
  const final = crypto.createHash('sha256').update(transcript, 'utf8').digest('base64');
  return `sha256-${final}`;
}

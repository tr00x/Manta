import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as tar from 'tar';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCE_DIR = path.join(__dirname, 'sample-package');
const OUT_PATH = path.join(__dirname, 'sample-package.tgz');

const FIXED_MTIME = new Date('2026-01-01T00:00:00.000Z');

async function listFilesSorted(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const full = path.join(root, rel);
    const entries = await fs.readdir(full, { withFileTypes: true });
    for (const e of entries) {
      const child = rel === '' ? e.name : path.join(rel, e.name);
      if (e.isDirectory()) {
        await walk(child);
      } else if (e.isFile()) {
        out.push(child.split(path.sep).join('/'));
      }
    }
  }
  await walk('');
  out.sort();
  return out;
}

export async function buildSampleTarball(): Promise<string> {
  const files = await listFilesSorted(SOURCE_DIR);
  // Force every entry's mtime so the resulting tarball bytes are deterministic.
  for (const rel of files) {
    const full = path.join(SOURCE_DIR, ...rel.split('/'));
    await fs.utimes(full, FIXED_MTIME, FIXED_MTIME);
  }
  await tar.c(
    {
      gzip: true,
      file: OUT_PATH,
      cwd: SOURCE_DIR,
      portable: true,
      noMtime: true,
    },
    files,
  );
  return OUT_PATH;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildSampleTarball()
    .then((p) => {
      process.stdout.write(`built ${p}\n`);
    })
    .catch((err) => {
      process.stderr.write(`${String(err)}\n`);
      process.exit(1);
    });
}

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const FIXTURE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'sample-repo',
);

export interface SampleRepoFixture {
  root: string;
  cleanup: () => Promise<void>;
}

export async function makeSampleRepo(): Promise<SampleRepoFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-e2e-sample-'));
  await copyDir(FIXTURE_ROOT, root);
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await execa('git', ['config', 'user.email', 'e2e@example.com'], { cwd: root });
  await execa('git', ['config', 'user.name', 'Manta E2E'], { cwd: root });
  await execa('git', ['add', '.'], { cwd: root });
  await execa('git', ['commit', '-q', '-m', 'sample fixture'], { cwd: root });
  await fs.mkdir(path.join(root, '.manta', 'state', 'contracts'), { recursive: true });
  return { root, cleanup: async () => fs.rm(root, { recursive: true, force: true }) };
}

async function copyDir(src: string, dst: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await fs.mkdir(d, { recursive: true });
      await copyDir(s, d);
    } else {
      await fs.copyFile(s, d);
    }
  }
}

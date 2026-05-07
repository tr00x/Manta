import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';

export interface RepoFixture {
  root: string;
  cleanup: () => Promise<void>;
  run: (args: string[], cwd?: string) => Promise<{ stdout: string; stderr: string }>;
}

export async function makeRepoFixture(prefix = 'manta-cli-test-'): Promise<RepoFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const run = async (args: string[], cwd: string = root) => {
    const r = await execa('git', args, { cwd });
    return { stdout: r.stdout, stderr: r.stderr };
  };
  await run(['init', '-q', '-b', 'main']);
  await run(['config', 'user.email', 'test@example.com']);
  await run(['config', 'user.name', 'Test']);
  // Need at least one commit before worktree-add will work
  await fs.writeFile(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  await run(['add', 'README.md']);
  await run(['commit', '-q', '-m', 'initial']);
  await fs.mkdir(path.join(root, '.manta', 'state', 'contracts'), { recursive: true });
  return {
    root,
    run,
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
}

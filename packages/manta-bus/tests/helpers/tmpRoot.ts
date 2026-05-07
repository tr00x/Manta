import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export async function makeTmpRoot(prefix = 'manta-bus-test-'): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  // Pre-create .manta/state to mirror the runtime layout; stores still test their own mkdir behaviour.
  await fs.mkdir(path.join(root, '.manta', 'state', '.locks'), { recursive: true });
  await fs.mkdir(path.join(root, '.manta', 'state', 'contracts'), { recursive: true });
  return {
    root,
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
}

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

// @manta/* are no longer declared deps of this package (build-time-inlined, not
// published deps), so there is no node_modules/@manta symlink for vitest to
// resolve against. Point the test runner at the sibling source directly — the
// same modules the tsup bundle inlines.
const internalAlias = {
  '@manta/bus': resolve(here, '../manta-bus/src/index.ts'),
  '@manta/orchestrator': resolve(here, '../manta-orchestrator/src/index.ts'),
  '@manta/skill-validator': resolve(here, '../manta-skill-validator/src/index.ts'),
  '@manta/snapshot': resolve(here, '../manta-snapshot/src/index.ts'),
};

export default defineConfig({
  resolve: { alias: internalAlias },
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    environment: 'node',
    testTimeout: 30_000,
    // Hermetic git: ignore the host's global/system git config for every git
    // invocation the tests (and the spawner they exercise) shell out to.
    // Without this, a developer or CI runner who signs all commits by default
    // (`commit.gpgsign=true`) breaks every fixture `git commit` — the throwaway
    // repos have no signing key, so git aborts with "failed to write commit
    // object". Fixtures set their own per-repo identity, so dropping the host
    // config costs nothing. macOS|Linux only (see README); `/dev/null` is the
    // documented "no config" sentinel on both.
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/bin/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});

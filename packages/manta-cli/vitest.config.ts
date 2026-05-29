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

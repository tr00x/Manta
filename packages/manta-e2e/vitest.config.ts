import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    environment: 'node',
    // 30 minutes — recon-swarm with real claude can run ~20 min per clone × N clones serially
    // when we wait for completion. The fixture repo keeps it well under that.
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 60_000,
    // Hermetic git: ignore the host's global/system git config so a developer
    // or CI runner with `commit.gpgsign=true` doesn't break fixture commits
    // (and the real clones spawned here, which inherit this env) — the
    // throwaway repos have no signing key. Fixtures set their own per-repo
    // identity. macOS|Linux only (see README); `/dev/null` = "no config".
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  },
});

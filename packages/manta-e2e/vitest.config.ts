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
  },
});

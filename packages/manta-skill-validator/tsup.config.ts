import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'bin/manta-validate-skills': 'src/bin/manta-validate-skills.ts' },
  format: ['esm', 'cjs'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: true,
  target: 'node20',
  splitting: false,
  shims: true,
  // Use build-only tsconfig that disables `composite`/`incremental` so tsup's
  // DTS pipeline doesn't hit TS6307 — same pattern as @manta/bus.
  tsconfig: 'tsconfig.build.json',
  outExtension: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
  }),
});

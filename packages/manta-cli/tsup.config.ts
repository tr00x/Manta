import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'bin/manta': 'src/bin/manta.ts' },
  format: ['esm', 'cjs'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: true,
  target: 'node20',
  splitting: false,
  shims: true,
  tsconfig: 'tsconfig.build.json',
  outExtension: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
  }),
});

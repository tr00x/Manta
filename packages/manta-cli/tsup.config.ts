import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'bin/manta': 'src/bin/manta.ts',
    'bin/server': '../manta-bus/src/bin/server.ts',
    'bin/manta-validate-skills': '../manta-skill-validator/src/bin/manta-validate-skills.ts',
  },
  // Inline all internal @manta/* workspace packages into the bundle so the published
  // artifact carries zero unpublishable `workspace:*` runtime deps. Only the @manta/*
  // scope is internal — no external @manta/* npm package exists to accidentally swallow.
  noExternal: [/^@manta\//],
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

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const here = dirname(fileURLToPath(import.meta.url));

// The internal @manta/* workspace packages are NOT runtime dependencies of the
// published `manta` artifact — they are inlined at build time. They are also no
// longer declared in package.json (so they never leak into the published
// manifest, where `workspace:*`/`0.0.0` is unresolvable on `npm i`). Because
// there is no node_modules/@manta symlink to resolve against, point esbuild at
// the sibling source directly so the bundle still inlines them.
const internalAlias: Record<string, string> = {
  '@manta/bus': resolve(here, '../manta-bus/src/index.ts'),
  '@manta/orchestrator': resolve(here, '../manta-orchestrator/src/index.ts'),
  '@manta/skill-validator': resolve(here, '../manta-skill-validator/src/index.ts'),
  '@manta/snapshot': resolve(here, '../manta-snapshot/src/index.ts'),
};

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'bin/manta': 'src/bin/manta.ts',
    'bin/server': '../manta-bus/src/bin/server.ts',
    'bin/manta-validate-skills': '../manta-skill-validator/src/bin/manta-validate-skills.ts',
  },
  // Belt-and-suspenders: even though the alias resolves @manta/* to sibling
  // source files (so they bundle as local modules), keep noExternal so nothing
  // @manta-scoped can ever be emitted as an external require.
  noExternal: [/^@manta\//],
  esbuildOptions(options) {
    options.alias = { ...options.alias, ...internalAlias };
  },
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

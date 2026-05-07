import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: true,
  target: 'node20',
  splitting: false,
  shims: true,
  // Use a build-only tsconfig that disables `composite`/`incremental` so
  // tsup's DTS pipeline doesn't hit TS6307 ("file not in project file list");
  // the rootDir/include of the main tsconfig.json includes `tests/` to
  // satisfy `tsc --noEmit` from typecheck, which composite mode then rejects
  // for files imported from outside `rootDir`.
  tsconfig: 'tsconfig.build.json',
  outExtension: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.js',
  }),
});

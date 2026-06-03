import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const here = dirname(fileURLToPath(import.meta.url));

// Plugin payload build — DISTINCT from tsup.config.ts (the npm build).
//
// The npm `manta` package keeps third-party deps EXTERNAL: `npm i` resolves
// zod/commander/@modelcontextprotocol/sdk/etc. into node_modules. A Claude Code
// PLUGIN installs by git clone into the plugin cache with NO `npm install` step
// (verified: docs/audits/2026-05-30-plugin-distribution-mechanics.md), so the
// plugin bundle must be FULLY self-contained — every runtime dependency inlined.
// Hence noExternal: everything. Output goes to a dedicated dir so it never
// clobbers the npm `dist/` that Chunk-4's install-from-tarball e2e pins.
const internalAlias: Record<string, string> = {
  '@manta/bus': resolve(here, '../manta-bus/src/index.ts'),
  '@manta/orchestrator': resolve(here, '../manta-orchestrator/src/index.ts'),
  '@manta/skill-validator': resolve(here, '../manta-skill-validator/src/index.ts'),
  '@manta/snapshot': resolve(here, '../manta-snapshot/src/index.ts'),
};

export default defineConfig({
  entry: {
    'bin/manta': 'src/bin/manta.ts',
    'bin/server': '../manta-bus/src/bin/server.ts',
    // Tier 0 conditional statusLine — root settings.json points Claude Code at
    // ${CLAUDE_PLUGIN_ROOT}/dist/bin/manta-statusline.cjs. Zero-dep (node
    // builtins only), but bundled here so the committed plugin tree ships it.
    'bin/manta-statusline': 'src/bin/manta-statusline.ts',
    // SessionStart priming hook — hooks/hooks.json points Claude Code at
    // ${CLAUDE_PLUGIN_ROOT}/dist/bin/manta-session-priming.cjs. Zero-dep static
    // print of the orchestration contract; bundled here so the committed plugin
    // tree ships it just like the statusline.
    'bin/manta-session-priming': 'src/bin/manta-session-priming.ts',
    // UserPromptSubmit routing hook — hooks/hooks.json points Claude Code at
    // ${CLAUDE_PLUGIN_ROOT}/dist/bin/manta-prompt-router.cjs. On a Manta-intent
    // prompt it injects the manta-orchestrate skill body so the console is in
    // context the moment the user reaches for Manta. Bundled like the others.
    'bin/manta-prompt-router': 'src/bin/manta-prompt-router.ts',
    // PreToolUse cast gate + PostToolUse skill marker — hooks/hooks.json points
    // Claude Code at these. The gate denies a cast until a manta-* skill is
    // loaded this session; the marker records the load. "Read the skill, then act."
    'bin/manta-skill-gate': 'src/bin/manta-skill-gate.ts',
    'bin/manta-skill-mark': 'src/bin/manta-skill-mark.ts',
  },
  outDir: 'plugin-dist',
  // Inline EVERYTHING — the plugin runtime has no node_modules to fall back on.
  noExternal: [/.*/],
  esbuildOptions(options) {
    options.alias = { ...options.alias, ...internalAlias };
  },
  // CJS for both: server is invoked as server.cjs by .mcp.json, and a CJS manta
  // bin avoids ESM/CJS interop hazards when third-party ESM-only deps are inlined.
  format: ['cjs'],
  clean: true,
  sourcemap: false,
  target: 'node20',
  splitting: false,
  shims: true,
  tsconfig: 'tsconfig.build.json',
  outExtension: () => ({ js: '.cjs' }),
});

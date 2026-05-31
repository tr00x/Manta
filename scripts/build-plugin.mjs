#!/usr/bin/env node
// build-plugin.mjs — assemble the committed Claude Code plugin payload.
//
// Why this exists: a Claude Code plugin installs by GIT CLONE of the repo into
// ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ — there is NO
// `npm install` and NO build step on install (verified against live
// superpowers/claude-mem plugins, see
// docs/audits/2026-05-30-plugin-distribution-mechanics.md). So the plugin bundle
// must be FULLY self-contained (every runtime dep inlined) AND committed to git.
//
// The npm `manta` package keeps deps external (npm resolves them); the plugin
// cannot. tsup.plugin.config.ts therefore emits a noExternal:everything build
// into packages/manta-cli/plugin-dist/. This script copies those two
// self-contained bins up to the repo-root dist/bin/ that ${CLAUDE_PLUGIN_ROOT}/
// dist/bin/ resolves to, so the committed tree is installable as-is.
//
// Layout: repo root IS the plugin root (.claude-plugin/ at top). The plugin
// reuses the repo's existing skills/ and commands/ in place (single source of
// truth, no duplication) — only the bundle needs copying.
import { cpSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcBin = join(repoRoot, 'packages', 'manta-cli', 'plugin-dist', 'bin');
const destBin = join(repoRoot, 'dist', 'bin');
const destModules = join(repoRoot, 'dist', 'node_modules');

// Vendored RUNTIME node_modules (bug: plugin installs by git clone with NO npm
// install, so any dep that is require()'d at RUNTIME — not inlined by tsup — must
// ship on disk). `heartbeat-hook` does `require.resolve('proper-lockfile')` to
// build the touch-script, and the generated touch-script is a SEPARATE node
// process that `require('proper-lockfile')` itself — neither can use the inlined
// bundle. So we vendor proper-lockfile + its full runtime tree into
// dist/node_modules/, which node resolves from dist/bin/*.cjs. Without this every
// subcommand crashes `Cannot find module 'proper-lockfile'` on a fresh plugin clone.
const RUNTIME_MODULES = ['proper-lockfile', 'graceful-fs', 'retry', 'signal-exit'];

// Both are CJS so they load without a package.json "type":"module" in the cache.
// .mcp.json runs server.cjs; commands/*.md run manta.cjs — both via ${CLAUDE_PLUGIN_ROOT}.
// manta-statusline.cjs is the Tier 0 conditional statusLine bin (root
// settings.json → ${CLAUDE_PLUGIN_ROOT}/dist/bin/manta-statusline.cjs).
// manta-session-priming.cjs is the SessionStart priming hook bin (root
// hooks/hooks.json → ${CLAUDE_PLUGIN_ROOT}/dist/bin/manta-session-priming.cjs).
const artifacts = ['manta.cjs', 'server.cjs', 'manta-statusline.cjs', 'manta-session-priming.cjs'];

for (const f of artifacts) {
  if (!existsSync(join(srcBin, f))) {
    console.error(
      `build-plugin: missing ${join(srcBin, f)}\n` +
        `Run the plugin bundle first: \`pnpm --filter manta exec tsup --config tsup.plugin.config.ts\` ` +
        `(or just \`pnpm build:plugin\`, which does it for you).`,
    );
    process.exit(1);
  }
}

mkdirSync(destBin, { recursive: true });
for (const f of artifacts) {
  cpSync(join(srcBin, f), join(destBin, f));
  const { size } = statSync(join(destBin, f));
  console.log(`build-plugin: dist/bin/${f}  (${(size / 1024).toFixed(0)} KB, self-contained)`);
}
// Vendor the runtime module tree into dist/node_modules/ (flat layout — node
// resolves siblings via ../node_modules). Resolve real paths from manta-bus
// (where proper-lockfile is a dep) and from proper-lockfile's own context for its
// transitive deps, so versions are never hardcoded.
const busRequire = createRequire(join(repoRoot, 'packages', 'manta-bus', 'package.json'));
const plDir = dirname(busRequire.resolve('proper-lockfile/package.json'));
const plRequire = createRequire(join(plDir, 'package.json'));
const moduleDirs = {
  'proper-lockfile': plDir,
  'graceful-fs': dirname(plRequire.resolve('graceful-fs/package.json')),
  retry: dirname(plRequire.resolve('retry/package.json')),
  'signal-exit': dirname(plRequire.resolve('signal-exit/package.json')),
};
rmSync(destModules, { recursive: true, force: true });
for (const name of RUNTIME_MODULES) {
  const src = moduleDirs[name];
  if (!src || !existsSync(src)) {
    console.error(`build-plugin: cannot locate runtime module '${name}' (looked at ${src}). Run \`pnpm install\` first.`);
    process.exit(1);
  }
  // dereference: copy real files, not pnpm symlinks, so the committed tree is self-contained.
  cpSync(src, join(destModules, name), { recursive: true, dereference: true });
  console.log(`build-plugin: dist/node_modules/${name}  (vendored runtime dep)`);
}

console.log('build-plugin: plugin payload assembled at dist/ (${CLAUDE_PLUGIN_ROOT}/dist: bin/ + node_modules/)');

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
import { cpSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcBin = join(repoRoot, 'packages', 'manta-cli', 'plugin-dist', 'bin');
const destBin = join(repoRoot, 'dist', 'bin');

// Both are CJS so they load without a package.json "type":"module" in the cache.
// .mcp.json runs server.cjs; commands/*.md run manta.cjs — both via ${CLAUDE_PLUGIN_ROOT}.
const artifacts = ['manta.cjs', 'server.cjs'];

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
console.log('build-plugin: plugin payload assembled at dist/bin/ (${CLAUDE_PLUGIN_ROOT}/dist/bin)');

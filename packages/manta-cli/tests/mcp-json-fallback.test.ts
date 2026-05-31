import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// packages/manta-cli/tests -> packages/manta-cli -> packages -> repo root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Z2 guarantee: the committed repo-root `.mcp.json` is the *plugin* manifest.
 *
 * In a genuine plugin context Claude Code injects CLAUDE_PLUGIN_ROOT, so the
 * fallback is never used. `manta install` sidesteps the manifest entirely by
 * writing its own entry with an absolute path. The remaining case — the
 * manifest used with CLAUDE_PLUGIN_ROOT unset (dev / dogfood / a clone whose
 * worktree cwd has no dist/) — must NOT silently resolve a relative `.` and
 * fail with an opaque "cannot find module". It must hard-fail with an
 * actionable message instead. This test locks that contract so the silent
 * `${CLAUDE_PLUGIN_ROOT:-.}` relative-miss form can't regress back in.
 */
describe('.mcp.json manta-bus launcher (Z2)', () => {
  it('hard-fails with a clear message instead of a silent relative fallback', async () => {
    const raw = await fs.readFile(path.join(repoRoot, '.mcp.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, { type?: string; command?: string; args?: string[] }>;
    };

    const bus = parsed.mcpServers?.['manta-bus'];
    expect(bus, 'manta-bus must be registered in .mcp.json').toBeDefined();
    expect(bus!.type).toBe('stdio');
    expect(bus!.command).toBe('sh');

    const args = bus!.args ?? [];
    expect(args[0]).toBe('-c');
    const script = args[1] ?? '';

    // Resolves via the plugin root when set...
    expect(script).toContain('${CLAUDE_PLUGIN_ROOT');
    // ...but guards on the resolved entry existing...
    expect(script).toMatch(/\[\s*!\s*-f/);
    // ...and on a miss, fails loudly to stderr + non-zero exit (not silently).
    expect(script).toContain('>&2');
    expect(script).toContain('exit 1');
    expect(script.toLowerCase()).toContain('manta install');
    // Still launches the server when the entry is present.
    expect(script).toContain('exec node');

    // The bare silent relative form must be gone.
    expect(script).not.toContain('exec node "${CLAUDE_PLUGIN_ROOT:-.}/dist/bin/server.cjs"');
  });
});

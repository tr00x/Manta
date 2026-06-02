import { describe, it, expect } from 'vitest';
import { buildCloneMcpConfig } from '../../src/spawner/clone-mcp-config.js';

// Bug #M14: a clone is spawned with a CURATED MCP config — manta-bus always,
// plus the operator's LIGHT servers, with heavy/boot-blocking ones (serena's
// per-worktree full-repo index, etc.) filtered out. "All methods great, not
// just the bus" — but no serena-class wedger.
function parse(json: string): Record<string, { command?: string; args?: string[]; type?: string; url?: string }> {
  return (JSON.parse(json) as { mcpServers: Record<string, never> }).mcpServers;
}

describe('buildCloneMcpConfig (bug #M14)', () => {
  it('always includes manta-bus with the given server path', () => {
    const m = parse(buildCloneMcpConfig('/abs/server.cjs'));
    expect(m['manta-bus']).toEqual({ command: 'node', args: ['/abs/server.cjs'] });
  });

  it('FILTERS serena (the per-worktree cold-indexer that wedges boot)', () => {
    const m = parse(
      buildCloneMcpConfig('/b/server.cjs', {
        serena: { command: 'uvx', args: ['--from', 'git+https://github.com/oraios/serena', 'serena', 'start-mcp-server', '--project-from-cwd'] },
      }),
    );
    expect(m.serena).toBeUndefined();
    expect(m['manta-bus']).toBeDefined();
  });

  it('CARRIES light useful servers (context7, claude-mem) into the clone', () => {
    const m = parse(
      buildCloneMcpConfig('/b/server.cjs', {
        context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'], type: 'stdio' },
        'claude-mem': { command: 'node', args: ['/x/mcp-server.cjs'], type: 'stdio' },
      }),
    );
    expect(m.context7).toBeDefined();
    expect(m['claude-mem']).toBeDefined();
    expect(Object.keys(m).sort()).toEqual(['claude-mem', 'context7', 'manta-bus']);
  });

  it('re-adds manta-bus with OUR path even if the operator had a stale/relative entry', () => {
    const m = parse(
      buildCloneMcpConfig('/good/server.cjs', {
        'manta-bus': { command: 'node', args: ['./dist/bin/server.cjs'] }, // stale relative
      }),
    );
    expect(m['manta-bus']).toEqual({ command: 'node', args: ['/good/server.cjs'] });
  });

  it('filters other heavy classes (language-server, computer-use)', () => {
    const m = parse(
      buildCloneMcpConfig('/b/server.cjs', {
        'my-lsp': { command: 'some-language-server', args: [] },
        'computer-use': { command: 'uvx', args: ['computer-use-mcp'] },
        good: { command: 'npx', args: ['-y', 'thing'] },
      }),
    );
    expect(m['my-lsp']).toBeUndefined();
    expect(m['computer-use']).toBeUndefined();
    expect(m.good).toBeDefined();
  });

  it('skips malformed entries (stdio with no command)', () => {
    const m = parse(
      buildCloneMcpConfig('/b/server.cjs', {
        broken: { type: 'stdio' }, // no command
        httpok: { type: 'http', url: 'http://localhost:1/mcp' },
      }),
    );
    expect(m.broken).toBeUndefined();
    expect(m.httpok).toBeDefined();
  });

  it('empty inherited stack → just manta-bus', () => {
    const m = parse(buildCloneMcpConfig('/b/server.cjs', {}));
    expect(Object.keys(m)).toEqual(['manta-bus']);
  });
});

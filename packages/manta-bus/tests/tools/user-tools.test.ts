import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FakeClock } from '../../src/clock';
import { createBusServer } from '../../src/server';
import { makeTmpRoot } from '../helpers/tmpRoot';
import {
  resolveMantaCliBin,
  buildCastArgv,
  createUserTools,
  type CastInput,
} from '../../src/tools/user-tools';

const FAKE_BIN = path.resolve(__dirname, '..', 'helpers', 'fake-manta.cjs');
const USER_TOOLS_SRC = path.resolve(__dirname, '..', '..', 'src', 'tools', 'user-tools.ts');

interface TextContentBlock {
  type: 'text';
  text: string;
}

function readText(content: unknown): string {
  if (!Array.isArray(content)) throw new Error('expected MCP content array');
  for (const block of content) {
    if (block && typeof block === 'object' && (block as TextContentBlock).type === 'text') {
      return (block as TextContentBlock).text;
    }
  }
  throw new Error('no text block in MCP content');
}

/** Parse the stub binary's `{"argv":[…]}` stdout into a typed argv array. */
function jsonArgv(stdout: string): string[] {
  return (JSON.parse(stdout.trim()) as { argv: string[] }).argv;
}

// ---------------------------------------------------------------------------
// Binary resolution (no spawn — pure)
// ---------------------------------------------------------------------------

describe('resolveMantaCliBin', () => {
  it('env override (MANTA_CLI_BIN) wins over everything', () => {
    const r = resolveMantaCliBin({
      env: { MANTA_CLI_BIN: '/override/manta.cjs' },
      nodeExecPath: '/usr/bin/node',
      // Even if a sibling would exist, the env override must take precedence.
      serverDir: '/plugin/dist/bin',
      fileExists: () => true,
    });
    expect(r.source).toBe('env');
    expect(r.command).toBe('/usr/bin/node');
    expect(r.prefixArgs).toEqual(['/override/manta.cjs']);
    expect(r.scriptPath).toBe('/override/manta.cjs');
  });

  it('falls back to the sibling manta.cjs next to the server binary', () => {
    const r = resolveMantaCliBin({
      env: {},
      nodeExecPath: '/usr/bin/node',
      serverDir: '/plugin/dist/bin',
      fileExists: (p) => p === path.join('/plugin/dist/bin', 'manta.cjs'),
    });
    expect(r.source).toBe('sibling');
    expect(r.command).toBe('/usr/bin/node');
    expect(r.prefixArgs).toEqual([path.join('/plugin/dist/bin', 'manta.cjs')]);
  });

  it('falls back to `manta` on PATH when no sibling exists', () => {
    const r = resolveMantaCliBin({
      env: {},
      nodeExecPath: '/usr/bin/node',
      serverDir: '/nope',
      fileExists: () => false,
    });
    expect(r.source).toBe('path');
    expect(r.command).toBe('manta');
    expect(r.prefixArgs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Argv mapping (pure)
// ---------------------------------------------------------------------------

describe('buildCastArgv', () => {
  it('maps the minimal {mode, task} to `cast <mode> --task <task>`', () => {
    const input: CastInput = { mode: 'recon-swarm', task: 'map the codebase' };
    expect(buildCastArgv(input)).toEqual(['cast', 'recon-swarm', '--task', 'map the codebase']);
  });

  it('maps every optional flag in a deterministic order, joining paths to CSV', () => {
    const input: CastInput = {
      mode: 'forking-realities',
      task: 'try two designs',
      clones: 3,
      maxParallelClones: 4,
      maxFilesChanged: 12,
      allowedPaths: ['packages/a', 'packages/b'],
      forbiddenPaths: ['.manta/state', 'secrets/'],
      dryRun: true,
    };
    expect(buildCastArgv(input)).toEqual([
      'cast',
      'forking-realities',
      '--task',
      'try two designs',
      '--clones',
      '3',
      '--max-parallel-clones',
      '4',
      '--max-files-changed',
      '12',
      '--allowed-paths',
      'packages/a,packages/b',
      '--forbidden-paths',
      '.manta/state,secrets/',
      '--dry-run',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Handlers against the stub binary (real spawn path)
// ---------------------------------------------------------------------------

describe('createUserTools handlers (stub binary via MANTA_CLI_BIN)', () => {
  let savedBin: string | undefined;
  let savedMode: string | undefined;

  beforeEach(() => {
    savedBin = process.env.MANTA_CLI_BIN;
    savedMode = process.env.MANTA_FAKE_MODE;
    process.env.MANTA_CLI_BIN = FAKE_BIN;
  });
  afterEach(() => {
    if (savedBin === undefined) delete process.env.MANTA_CLI_BIN;
    else process.env.MANTA_CLI_BIN = savedBin;
    if (savedMode === undefined) delete process.env.MANTA_FAKE_MODE;
    else process.env.MANTA_FAKE_MODE = savedMode;
  });

  function tools(): ReturnType<typeof createUserTools> {
    // castIdTimeoutMs is spawnCast's SAFETY-NET timeout — it must NOT race the
    // real child signal these tests assert on (the stub's `cast.spawn` stderr
    // line at child-start / its self-exit). At 4_000ms it did: under full-suite
    // CPU/IO contention (vitest fans 180+ files across forks), child node
    // startup + the parent worker's event-loop scheduling latency can push
    // detection of the spawn line / exit past 4s, so the timeout fired FIRST and
    // resolved `launched:true, castId:null` — flipping the launched/castId/exited
    // assertions intermittently (green on retry, green in isolation). 20_000ms
    // keeps the safety net well clear of any realistic contention ladder, so the
    // resolution is always driven by the real child event — deterministic, not
    // raced. (Paired with the 20s per-test timeouts on the three spawn tests so
    // vitest's 5s default cannot kill a contended run before the real signal.)
    return createUserTools({ repoRoot: process.cwd(), castIdTimeoutMs: 20_000, captureTimeoutMs: 10_000 });
  }
  function tool(name: string): ReturnType<typeof createUserTools>[number] {
    const t = tools().find((e) => e.name === name);
    if (!t) throw new Error(`tool ${name} not found`);
    return t;
  }

  it('manta.cast maps {mode, task, clones} to the correct argv and returns the binary output', async () => {
    const out = (await tool('manta.cast').handle({
      mode: 'recon-swarm',
      task: 'investigate',
      clones: 3,
    })) as { argv: string[]; stdout: string; exited: boolean };
    // The tool echoes back the argv it built…
    expect(out.argv).toEqual(['cast', 'recon-swarm', '--task', 'investigate', '--clones', '3']);
    // …and the stub echoed that same argv back over stdout (real spawn round-trip).
    const echoed = JSON.parse(out.stdout.trim()) as { argv: string[] };
    expect(echoed.argv).toEqual(out.argv);
    expect(out.exited).toBe(true); // fast stub exit, not a real long-running cast
  });

  it('manta.cast returns promptly with the cast id when the cast launches (does NOT block)', async () => {
    process.env.MANTA_FAKE_MODE = 'cast-launched';
    const out = (await tool('manta.cast').handle({
      mode: 'recon-swarm',
      task: 'long running',
    })) as { castId: string | null; launched: boolean; exited: boolean };
    expect(out.castId).toBe('cast-9999999999999');
    expect(out.launched).toBe(true);
    expect(out.exited).toBe(false); // resolved via the stderr scan, child still alive
  }, 20_000); // see castIdTimeoutMs note: explicit bound > worst-case contended child startup

  it('audit #1: a transcript_fork.skipped warning before a FAILED spawn does NOT report launched', async () => {
    process.env.MANTA_FAKE_MODE = 'cast-forkskip-then-fail';
    const out = (await tool('manta.cast').handle({
      mode: 'recon-swarm',
      task: 'fork skipped then spawn fails',
    })) as { castId: string | null; launched: boolean; exited: boolean; exitCode: number | null };
    // The warning carries `cast-7777777777777` (captured for diagnostics), but
    // NO `cast.spawn` worktree line ever appears → must resolve via the non-zero
    // exit, NOT prematurely as launched on the warning's token.
    expect(out.launched).toBe(false);
    expect(out.exited).toBe(true);
    expect(out.exitCode).toBe(1);
    expect(out.castId).toBe('cast-7777777777777');
  }, 20_000); // see castIdTimeoutMs note: explicit bound > worst-case contended child startup

  it('audit #1: launched fires on the cast.spawn worktree line even after a preceding fork-skip warning', async () => {
    process.env.MANTA_FAKE_MODE = 'cast-forkskip-then-spawn';
    const out = (await tool('manta.cast').handle({
      mode: 'recon-swarm',
      task: 'fork skipped then real spawn',
    })) as { castId: string | null; launched: boolean; exited: boolean };
    expect(out.launched).toBe(true);
    expect(out.exited).toBe(false);
    expect(out.castId).toBe('cast-8888888888888');
  }, 20_000); // see castIdTimeoutMs note: explicit bound > worst-case contended child startup

  it('audit #4: manta.abort requires a reason (bare call is a validation error)', async () => {
    await expect(tool('manta.abort').handle({})).rejects.toThrow();
  });

  it('manta.cast rejects an invalid mode with a validation error', async () => {
    await expect(tool('manta.cast').handle({ mode: 'not-a-mode', task: 'x' })).rejects.toThrow();
    // phantom-lance is a real Mode but is NOT castable — must be rejected too.
    await expect(tool('manta.cast').handle({ mode: 'phantom-lance', task: 'x' })).rejects.toThrow();
  });

  it('manta.status runs `status` and passes through the binary stdout', async () => {
    const out = (await tool('manta.status').handle({})) as {
      stdout: string;
      exitCode: number | null;
    };
    expect(jsonArgv(out.stdout)).toEqual(['status']);
    expect(out.exitCode).toBe(0);
  });

  it('manta.inspect runs `inspect <id> --json` and parses the JSON stdout', async () => {
    const out = (await tool('manta.inspect').handle({ cloneId: 'A', events: 5 })) as {
      json: { argv: string[] } | null;
    };
    // The stub echoes argv as JSON → exercises both argv mapping AND JSON parse.
    expect(out.json?.argv).toEqual(['inspect', 'A', '--json', '--events', '5']);
  });

  it('manta.kill maps {cloneId, reason} to `kill <id> --reason <reason>`', async () => {
    const out = (await tool('manta.kill').handle({ cloneId: 'B', reason: 'wedged' })) as {
      stdout: string;
    };
    expect(jsonArgv(out.stdout)).toEqual(['kill', 'B', '--reason', 'wedged']);
  });

  it('manta.abort maps an optional reason to `abort --reason <reason>`', async () => {
    const out = (await tool('manta.abort').handle({ reason: 'user-stop' })) as { stdout: string };
    expect(jsonArgv(out.stdout)).toEqual(['abort', '--reason', 'user-stop']);
  });
});

// ---------------------------------------------------------------------------
// MCP registration + circular-dep guard
// ---------------------------------------------------------------------------

describe('user tools — MCP registration', () => {
  it('the 5 user tools are listed with introspectable schemas', async () => {
    const { root, cleanup } = await makeTmpRoot();
    const { server } = await createBusServer({ repoRoot: root, clock: new FakeClock(1_000_000) });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: 'user-tools-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(c);
    try {
      const listed = await client.listTools();
      const byName = new Map(listed.tools.map((t) => [t.name, t]));
      for (const name of ['manta.cast', 'manta.status', 'manta.inspect', 'manta.abort', 'manta.kill']) {
        expect(byName.has(name), `${name} must be registered`).toBe(true);
      }
      // The cast tool advertises a real parameter schema the orchestrator can read.
      const castSchema = byName.get('manta.cast')!.inputSchema as {
        type: string;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(castSchema.type).toBe('object');
      expect(castSchema.properties).toHaveProperty('mode');
      expect(castSchema.properties).toHaveProperty('task');
      expect(castSchema.required).toEqual(['mode', 'task']);
    } finally {
      await client.close();
      await server.close();
      await cleanup();
    }
  });

  it('unknown user tool args produce a validation_error envelope (not a crash)', async () => {
    const { root, cleanup } = await makeTmpRoot();
    const { server } = await createBusServer({ repoRoot: root, clock: new FakeClock(1_000_000) });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: 'user-tools-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(c);
    try {
      const resp = await client.callTool({ name: 'manta.cast', arguments: { task: 'missing mode' } });
      expect(resp.isError).toBe(true);
      const parsed = JSON.parse(readText(resp.content)) as { error: string };
      expect(parsed.error).toBe('validation_error');
    } finally {
      await client.close();
      await server.close();
      await cleanup();
    }
  });

  it('the circular-dep guard holds: @manta/bus never imports @manta/cli', () => {
    const src = fs.readFileSync(USER_TOOLS_SRC, 'utf8');
    // Guard against the IMPORT specifically (prose mentioning @manta/cli to
    // explain the avoidance is fine — `import … from '@manta/cli'` /
    // `require('@manta/cli')` are the circular dep).
    expect(src).not.toMatch(/from\s+['"]@manta\/cli['"]/);
    expect(src).not.toMatch(/require\(\s*['"]@manta\/cli['"]\s*\)/);
    expect(src).not.toMatch(/import\(\s*['"]@manta\/cli['"]\s*\)/);
  });
});

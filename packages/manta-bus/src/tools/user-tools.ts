import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { z } from 'zod';
import { ModeSchema, type Mode } from '@manta/snapshot';
import { parse } from './parse';

/**
 * USER / orchestrator-facing MCP tools (distinct from the 25 clone-coordination
 * tools). These let a user's Claude Code orchestrator drive Manta with NATIVE
 * tool calls instead of shelling out to the `/manta:*` slash commands.
 *
 * THE ARCHITECTURE (locked, see clone-A task contract):
 *   - `@manta/bus` does NOT depend on `@manta/cli` (the reverse is true). A
 *     bus-side tool therefore CANNOT import `runCastCommand` — that would be a
 *     circular dependency. So every user tool spawns the proven `manta` CLI
 *     BINARY as a child process and returns its output. Zero logic duplication,
 *     zero circular dep. The subprocess is invisible to the orchestrator — it
 *     just sees a clean tool call returning structured data.
 *
 * THE CAST GOTCHA (discovered while implementing — see the breakthrough
 * broadcast on cast-1780257722556): `manta cast` is BLOCKING. `runCastCommand`
 * runs the full orchestrator tick-loop until every clone is DEAD or the tick
 * budget (~25 min) elapses; it does NOT fork-and-return. And the cast id is
 * generated INTERNALLY (`cast-${Date.now()}`) and printed to stdout only at
 * the very end. Blocking an MCP tool call for 25 minutes is unacceptable, so
 * {@link spawnCast} runs the child non-blocking, scans its STDERR for the early
 * `cast.spawn ... worktree=…/clone-cast-<ts>-<CLONE>` reporter line to extract
 * the cast id, resolves the tool call promptly, and `unref()`s the child so the
 * orchestrator keeps running in the background. Fast-failing casts (dry-run,
 * validation errors) print to stdout / exit before any clone spawns, so they
 * fall through to the child-exit path and return their full output + exit code.
 */

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

export interface CliBinResolution {
  /** Executable to spawn: the node binary for a resolved script, or `manta` for the PATH fallback. */
  command: string;
  /** Args prepended before the CLI subcommand argv — `[scriptPath]` for node, `[]` for the PATH bin. */
  prefixArgs: string[];
  /** Which resolution branch won. Surfaced for diagnostics and asserted by tests. */
  source: 'env' | 'sibling' | 'path';
  /** The resolved script path when `source !== 'path'`. */
  scriptPath?: string;
}

export interface ResolveBinOptions {
  env?: NodeJS.ProcessEnv;
  /** Directory of the running server entry (`dist/bin/`); defaults to this module's own location. */
  serverDir?: string;
  /** Override `process.execPath` (the node binary). */
  nodeExecPath?: string;
  /** Override the file-existence probe (tests inject a stub). */
  fileExists?: (p: string) => boolean;
}

/**
 * Anchor on THIS module's own runtime location, never `process.cwd()`. After
 * tsup's `splitting:false` bundle, this module is inlined into the single
 * `dist/bin/server.cjs` entry, so `__dirname` resolves to `dist/bin/` and the
 * CLI is the sibling `dist/bin/manta.cjs` (the plugin layout — see
 * docs/internals/plugin-packaging.md). In dev/tests this resolves to a
 * non-existent sibling, which is exactly why `MANTA_CLI_BIN` is the explicit
 * override seam tests use.
 *
 * Uses `__dirname` rather than `import.meta.url`: the bus typechecks/builds as
 * CommonJS (where `import.meta` is illegal — TS1470), and tsup's `shims:true`
 * provides a `__dirname` shim in the ESM output too, so it is portable across
 * both emitted formats.
 */
function defaultServerDir(): string {
  return __dirname;
}

function defaultFileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the `manta` CLI binary. Resolution order (locked by the task
 * contract):
 *   1. `MANTA_CLI_BIN` env var — explicit override + test seam.
 *   2. Sibling `manta.cjs` next to the server binary (plugin layout).
 *   3. Bare `manta` on PATH (npm global install — the bin is itself a node
 *      shebang script, so it is spawned directly, not via `node`).
 */
export function resolveMantaCliBin(opts: ResolveBinOptions = {}): CliBinResolution {
  const env = opts.env ?? process.env;
  const node = opts.nodeExecPath ?? process.execPath;
  const exists = opts.fileExists ?? defaultFileExists;

  const override = env.MANTA_CLI_BIN?.trim();
  if (override) {
    return { command: node, prefixArgs: [override], source: 'env', scriptPath: override };
  }

  const serverDir = opts.serverDir ?? defaultServerDir();
  const sibling = path.join(serverDir, 'manta.cjs');
  if (exists(sibling)) {
    return { command: node, prefixArgs: [sibling], source: 'sibling', scriptPath: sibling };
  }

  return { command: 'manta', prefixArgs: [], source: 'path' };
}

// ---------------------------------------------------------------------------
// Child-process runners
// ---------------------------------------------------------------------------

export interface CaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when the child was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
}

export interface RunOptions {
  /** cwd for the child; the CLI resolves its repo root from here. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Hard ceiling for capture commands; the child is SIGTERM'd on overrun. Default 60s. */
  timeoutMs?: number;
}

const DEFAULT_CAPTURE_TIMEOUT_MS = 60_000;

/**
 * Spawn the CLI and capture stdout/stderr to completion. For the fast,
 * terminating read-only / mutating commands (status, cost, inspect, kill,
 * abort) — never for `cast`. A real child process against the real binary; the
 * spawn path is exercised, only the binary itself is a stub under test.
 */
export function runCliCapture(
  resolution: CliBinResolution,
  argv: string[],
  opts: RunOptions,
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(resolution.command, [...resolution.prefixArgs, ...argv], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Escalate if it ignores SIGTERM, so a wedged child can't pin the tool.
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, opts.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);

    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });

    const finish = (exitCode: number | null, errSuffix?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: errSuffix ? `${stderr}${errSuffix}` : stderr,
        exitCode,
        timedOut,
      });
    };

    child.on('error', (err) => finish(null, `\n[spawn error] ${String(err)}`));
    child.on('close', (code) => finish(code));
  });
}

/** Matches a Manta cast id (`cast-` + a millisecond timestamp). */
const CAST_ID_RE = /(cast-\d{10,})/;

export interface CastSpawnResult {
  /** The cast id, parsed from the child's output. Null if not observed yet. */
  castId: string | null;
  /** True when the child is still running in the background (the normal case for a real cast). */
  launched: boolean;
  /** True when the child already exited (dry-run, validation error, or a stub that exits fast). */
  exited: boolean;
  /** Exit code when `exited`; null while `launched`. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface CastSpawnOptions extends RunOptions {
  /**
   * If the cast id is not observed and the child has not exited within this
   * window, resolve anyway (launched, id unknown) so the tool never hangs.
   * Default 10s.
   */
  idTimeoutMs?: number;
}

const DEFAULT_CAST_ID_TIMEOUT_MS = 10_000;

/**
 * Spawn `manta cast …` NON-BLOCKING. Resolves as soon as one of:
 *   - the cast id appears on STDERR (real cast launched — the early
 *     `cast.spawn` reporter line carries `worktree=…/clone-cast-<ts>-<CLONE>`);
 *   - the child exits (dry-run, validation error, fast stub) — full output +
 *     exit code returned, id parsed from whichever stream carried it;
 *   - `idTimeoutMs` elapses (defensive: launched, id unknown).
 *
 * On the launched path the child is `unref()`d and its pipes are drained so it
 * keeps running the orchestrator in the background without leaking listeners or
 * blocking the bus server's event loop.
 */
export function spawnCast(
  resolution: CliBinResolution,
  argv: string[],
  opts: CastSpawnOptions,
): Promise<CastSpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(resolution.command, [...resolution.prefixArgs, ...argv], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let castId: string | null = null;
    let settled = false;

    const detach = (): void => {
      // Stop accumulating, drain to avoid backpressure, keep the child alive in
      // the background, and let the bus server exit independently of it.
      child.stdout?.removeListener('data', onOut);
      child.stderr?.removeListener('data', onErr);
      child.stdout?.resume();
      child.stderr?.resume();
      child.unref();
    };

    const resolveLaunched = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detach();
      resolve({ castId, launched: true, exited: false, exitCode: null, stdout, stderr });
    };

    function onOut(c: Buffer): void {
      stdout += c.toString('utf8');
      // stdout-only output (dry-run banner) must NOT early-resolve as launched;
      // we still capture the id for the eventual child-exit path.
      if (castId === null) {
        const m = CAST_ID_RE.exec(stdout);
        if (m) castId = m[1] ?? null;
      }
    }

    function onErr(c: Buffer): void {
      stderr += c.toString('utf8');
      // STDERR carries the reporter's `cast.spawn` event for a REAL cast that
      // actually started spawning clones → safe to declare "launched".
      if (castId === null) {
        const m = CAST_ID_RE.exec(stderr);
        if (m) {
          castId = m[1] ?? null;
          resolveLaunched();
        }
      }
    }

    child.stdout?.on('data', onOut);
    child.stderr?.on('data', onErr);

    const timer = setTimeout(resolveLaunched, opts.idTimeoutMs ?? DEFAULT_CAST_ID_TIMEOUT_MS);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        castId,
        launched: false,
        exited: true,
        exitCode: null,
        stdout,
        stderr: `${stderr}\n[spawn error] ${String(err)}`,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Final sweep of both streams (fast exit may have raced the data events).
      if (castId === null) {
        const m = CAST_ID_RE.exec(stderr) ?? CAST_ID_RE.exec(stdout);
        if (m) castId = m[1] ?? null;
      }
      resolve({ castId, launched: false, exited: true, exitCode: code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/**
 * The castable modes = every snapshot mode except `phantom-lance` (locked, not
 * spawnable in Phase 0–8 — the cast command rejects it). Derived from
 * `ModeSchema.options` so this list can never drift from the source of truth.
 */
const CASTABLE_MODES = ModeSchema.options.filter(
  (m: Mode): m is Exclude<Mode, 'phantom-lance'> => m !== 'phantom-lance',
);

const CastModeSchema = z.enum(
  CASTABLE_MODES as [Exclude<Mode, 'phantom-lance'>, ...Array<Exclude<Mode, 'phantom-lance'>>],
);

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

export const CastInputSchema = z.object({
  mode: CastModeSchema,
  task: z.string().min(1),
  clones: positiveInt.optional(),
  maxParallelClones: positiveInt.optional(),
  maxCastsPerHour: positiveInt.optional(),
  maxTokensEstimate: positiveInt.optional(),
  allowedPaths: z.array(z.string().min(1)).optional(),
  forbiddenPaths: z.array(z.string().min(1)).optional(),
  maxFilesChanged: nonNegativeInt.optional(),
  dryRun: z.boolean().optional(),
});
export type CastInput = z.infer<typeof CastInputSchema>;

export const CostInputSchema = z.object({
  period: z.enum(['today', 'weekly']).optional(),
});

export const InspectInputSchema = z.object({
  cloneId: z.string().min(1),
  events: positiveInt.optional(),
});

export const AbortInputSchema = z.object({
  reason: z.string().min(1).optional(),
});

export const KillInputSchema = z.object({
  cloneId: z.string().min(1),
  reason: z.string().min(1).optional(),
});

/**
 * Map a validated {@link CastInput} to the `manta cast` argv. Pure + exported so
 * the stub-binary test can assert the exact flag order without spawning. Note
 * `--allowed-paths` / `--forbidden-paths` are CSV at the CLI boundary (the cast
 * command splits on commas), so the string[] inputs are joined here.
 */
export function buildCastArgv(input: CastInput): string[] {
  const argv: string[] = ['cast', input.mode, '--task', input.task];
  if (input.clones !== undefined) argv.push('--clones', String(input.clones));
  if (input.maxParallelClones !== undefined)
    argv.push('--max-parallel-clones', String(input.maxParallelClones));
  if (input.maxCastsPerHour !== undefined)
    argv.push('--max-casts-per-hour', String(input.maxCastsPerHour));
  if (input.maxTokensEstimate !== undefined)
    argv.push('--max-tokens-estimate', String(input.maxTokensEstimate));
  if (input.maxFilesChanged !== undefined)
    argv.push('--max-files-changed', String(input.maxFilesChanged));
  if (input.allowedPaths !== undefined && input.allowedPaths.length > 0)
    argv.push('--allowed-paths', input.allowedPaths.join(','));
  if (input.forbiddenPaths !== undefined && input.forbiddenPaths.length > 0)
    argv.push('--forbidden-paths', input.forbiddenPaths.join(','));
  if (input.dryRun === true) argv.push('--dry-run');
  return argv;
}

// ---------------------------------------------------------------------------
// JSON-Schema descriptors (so the orchestrator can introspect parameters)
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

const castSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'task'],
  properties: {
    mode: { type: 'string', enum: CASTABLE_MODES, description: 'Cast mode (one of the 9 castable modes).' },
    task: { type: 'string', description: 'Task description handed to every clone.' },
    clones: { type: 'integer', minimum: 1, description: 'Number of clones (mode-specific bounds apply; default 2).' },
    maxParallelClones: { type: 'integer', minimum: 1, description: 'Parallelism cap (--max-parallel-clones).' },
    maxCastsPerHour: { type: 'integer', minimum: 1, description: 'Rolling-hour cast-rate cap (--max-casts-per-hour).' },
    maxTokensEstimate: { type: 'integer', minimum: 1, description: 'Per-cast usage ceiling, token-estimate proxy (--max-tokens-estimate).' },
    allowedPaths: { type: 'array', items: { type: 'string' }, description: 'Paths each clone may read/write (joined to CSV for --allowed-paths).' },
    forbiddenPaths: { type: 'array', items: { type: 'string' }, description: 'Paths each clone must not touch (joined to CSV for --forbidden-paths).' },
    maxFilesChanged: { type: 'integer', minimum: 0, description: 'Per-clone file-write cap; 0 = read-only (--max-files-changed).' },
    dryRun: { type: 'boolean', description: 'Preview usage without spawning (--dry-run).' },
  },
};

const emptyObjectSchema: JsonSchema = { type: 'object', additionalProperties: false, properties: {} };

const costSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    period: { type: 'string', enum: ['today', 'weekly'], description: 'Cost window (default today).' },
  },
};

const inspectSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['cloneId'],
  properties: {
    cloneId: { type: 'string', description: 'Clone id to inspect (e.g. "A").' },
    events: { type: 'integer', minimum: 1, description: 'How many recent events to include (default CLI behaviour).' },
  },
};

const abortSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: { type: 'string', description: 'Optional reason recorded on every clone post-mortem.' },
  },
};

const killSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['cloneId'],
  properties: {
    cloneId: { type: 'string', description: 'Clone id to mark DEAD (e.g. "A").' },
    reason: { type: 'string', description: 'Optional death reason recorded on the post-mortem.' },
  },
};

// ---------------------------------------------------------------------------
// Tool entries
// ---------------------------------------------------------------------------

export interface UserToolEntry {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handle: (args: unknown) => Promise<unknown>;
}

export interface CreateUserToolsDeps {
  /** Repo root — the spawned CLI uses it as cwd to resolve its own repo root deterministically. */
  repoRoot: string;
  /** Override binary resolution (tests). Defaults to {@link resolveMantaCliBin} reading `process.env` at call time. */
  resolveBin?: () => CliBinResolution;
  /** Override the cast-spawn id detection window (tests). */
  castIdTimeoutMs?: number;
  /** Override capture timeout (tests). */
  captureTimeoutMs?: number;
}

/**
 * Build the user/orchestrator-facing tool entries. Naming mirrors the
 * clone-coordination tools — registered with the `manta.` dot prefix
 * (`manta.cast`, `manta.status`, …), which the MCP client surfaces to the
 * orchestrator as `manta_cast`, `manta_status`, … (dots are namespaced to
 * underscores in the tool-call surface).
 */
export function createUserTools(deps: CreateUserToolsDeps): UserToolEntry[] {
  const resolveBin = deps.resolveBin ?? (() => resolveMantaCliBin());
  const runOpts = (): RunOptions => {
    const o: RunOptions = { cwd: deps.repoRoot };
    if (deps.captureTimeoutMs !== undefined) o.timeoutMs = deps.captureTimeoutMs;
    return o;
  };

  const cast: UserToolEntry = {
    name: 'manta.cast',
    description:
      'Spawn a Manta cast (the core verb). Maps inputs to `manta cast <mode> --task … [flags]` and ' +
      'launches it NON-BLOCKING: returns promptly with the cast id once the cast has started spawning ' +
      'clones (do not wait for clone completion — use manta_status to watch). A dry-run or a validation ' +
      'error returns its full output and exit code instead. Native alternative to the /manta:cast slash command.',
    inputSchema: castSchema,
    handle: async (args) => {
      const input = parse(CastInputSchema, args, 'manta.cast');
      const argv = buildCastArgv(input);
      const castOpts: CastSpawnOptions = { cwd: deps.repoRoot };
      if (deps.castIdTimeoutMs !== undefined) castOpts.idTimeoutMs = deps.castIdTimeoutMs;
      const result = await spawnCast(resolveBin(), argv, castOpts);
      return { argv, ...result };
    },
  };

  const status: UserToolEntry = {
    name: 'manta.status',
    description:
      'Orchestrator snapshot — live clones, their state, heartbeat age, locks, and claims. Runs `manta status`. ' +
      'Read-only. Returns raw text (the status CLI has no --json mode). Native alternative to /manta:status.',
    inputSchema: emptyObjectSchema,
    handle: async () => {
      const r = await runCliCapture(resolveBin(), ['status'], runOpts());
      return r;
    },
  };

  const cost: UserToolEntry = {
    name: 'manta.cost',
    description:
      'Usage/activity snapshot. Runs `manta cost [period]` and `manta charges`, returning both as raw text ' +
      '(neither has a --json mode). Usage-aware, NOT dollars (the budget repivot is done). Read-only. ' +
      'Native alternative to /manta:cost + /manta:charges.',
    inputSchema: costSchema,
    handle: async (args) => {
      const input = parse(CostInputSchema, args, 'manta.cost');
      const costArgv = input.period !== undefined ? ['cost', input.period] : ['cost'];
      const costResult = await runCliCapture(resolveBin(), costArgv, runOpts());
      const chargesResult = await runCliCapture(resolveBin(), ['charges'], runOpts());
      return { cost: costResult, charges: chargesResult };
    },
  };

  const inspect: UserToolEntry = {
    name: 'manta.inspect',
    description:
      "Deep-dive into one clone — registry, contract, locks, recent events. Runs `manta inspect <id> --json`. " +
      'Read-only. Returns the parsed JSON (plus raw text + exit code). Native alternative to /manta:inspect.',
    inputSchema: inspectSchema,
    handle: async (args) => {
      const input = parse(InspectInputSchema, args, 'manta.inspect');
      const argv = ['inspect', input.cloneId, '--json'];
      if (input.events !== undefined) argv.push('--events', String(input.events));
      const r = await runCliCapture(resolveBin(), argv, runOpts());
      let json: unknown = null;
      try {
        json = JSON.parse(r.stdout.trim());
      } catch {
        // inspect can exit non-zero (unknown clone) with a plain `[manta] …`
        // stderr line and no JSON on stdout — return raw + exit code instead.
      }
      return { json, raw: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: r.timedOut };
    },
  };

  const abort: UserToolEntry = {
    name: 'manta.abort',
    description:
      'Emergency stop — mark every live clone DEAD and write a post-mortem for each. Runs `manta abort`. ' +
      'MUTATING. Returns raw text. Native alternative to /manta:abort.',
    inputSchema: abortSchema,
    handle: async (args) => {
      const input = parse(AbortInputSchema, args, 'manta.abort');
      const argv = ['abort'];
      if (input.reason !== undefined) argv.push('--reason', input.reason);
      const r = await runCliCapture(resolveBin(), argv, runOpts());
      return r;
    },
  };

  const kill: UserToolEntry = {
    name: 'manta.kill',
    description:
      'Mark a single clone DEAD and write its post-mortem. Runs `manta kill <id>`. MUTATING. Returns raw text. ' +
      'Native alternative to /manta:kill.',
    inputSchema: killSchema,
    handle: async (args) => {
      const input = parse(KillInputSchema, args, 'manta.kill');
      const argv = ['kill', input.cloneId];
      if (input.reason !== undefined) argv.push('--reason', input.reason);
      const r = await runCliCapture(resolveBin(), argv, runOpts());
      return r;
    },
  };

  return [cast, status, cost, inspect, abort, kill];
}

/** The registered names of the user/orchestrator tools — for the dispatcher's caller-field map. */
export const USER_TOOL_NAMES = [
  'manta.cast',
  'manta.status',
  'manta.cost',
  'manta.inspect',
  'manta.abort',
  'manta.kill',
] as const;

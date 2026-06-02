import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bug #M14: a spawned clone is `claude --print` with NO `--mcp-config`, so it
 * inherits the OPERATOR's entire user-scope MCP stack from `~/.claude.json` —
 * including heavy servers the clone never needs. The worst offender is
 * **serena** (`uvx … serena … --project-from-cwd`): a clone boots with
 * `cwd=<worktree>` inside a large repo, so serena cold-indexes the whole project
 * in every clone's worktree. With several clones + the operator's own session,
 * that's N concurrent full-repo language-server indexes; the clone's boot wedges
 * in STARTING for minutes and is reaped "no first heartbeat" before it can ack.
 * Confirmed by measurement: in a large repo, cold `claude --print` with the full
 * inherited stack stayed slow + serena resident; with
 * `--strict-mcp-config --mcp-config <curated>` serena is gone and boot is ~5s.
 *
 * Fix posture (per the maintainer: "all the methods should be great, not just
 * the bus"): the clone gets a CURATED config — `manta-bus` ALWAYS (its
 * coordination channel) PLUS the operator's other LIGHT servers (context7,
 * claude-mem, …), with only the HEAVY/blocking ones filtered out. So a clone is
 * still a capable implementer, it just doesn't drag a per-worktree language-
 * server index or an auth-blocked remote into its boot.
 *
 * `server.cjs` is always a sibling of the running `manta(.cjs|.js)` entry (the
 * package's `bin["manta-bus"]` is `./dist/bin/server.cjs`), so anchor on this
 * module's own location — never `process.cwd()`. Mirrors bootstrap.ts's
 * `defaultServerPathResolver`. Injectable for tests.
 */
export const defaultBusServerPath = (): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'server.cjs');

/** An MCP server definition as it appears in `~/.claude.json` `mcpServers`. */
export interface McpServerDef {
  command?: string;
  args?: string[];
  type?: string;
  url?: string;
  [k: string]: unknown;
}

/**
 * Heavy / boot-blocking MCP servers a clone must NOT inherit (bug #M14). Matched
 * case-insensitively against the server NAME and its command+args. Kept as a
 * denylist (not an allowlist) so a clone still gets the operator's other useful
 * servers by default — only the known boot-wedgers are cut:
 *  - serena: per-worktree full-repo LSP cold-index (the #M14 reaper).
 *  - other language-server / full-repo indexers behave the same way.
 *  - computer-use / desktop control: heavy native deps, never needed by a clone.
 */
const HEAVY_MCP_PATTERNS = [
  'serena',
  'language-server',
  'lsp',
  'computer-use',
  'computer_use',
  'desktop',
] as const;

function isHeavy(name: string, def: McpServerDef): boolean {
  const hay = `${name} ${def.command ?? ''} ${(def.args ?? []).join(' ')}`.toLowerCase();
  return HEAVY_MCP_PATTERNS.some((p) => hay.includes(p));
}

/**
 * Should this inherited server be carried into the clone's config? Skip the
 * heavy denylist, skip the bus itself (we always re-add it with a known-good
 * path so a stale/relative operator entry can't break the clone), and skip
 * malformed entries (a stdio server with no command, or anything that isn't a
 * usable stdio/http definition).
 */
function isCloneSafe(name: string, def: McpServerDef): boolean {
  if (name === 'manta-bus') return false; // re-added explicitly below
  if (isHeavy(name, def)) return false;
  const hasStdio = typeof def.command === 'string' && def.command.length > 0;
  const hasHttp = (def.type === 'http' || def.type === 'sse') && typeof def.url === 'string';
  return hasStdio || hasHttp;
}

/**
 * Build the clone's curated MCP config: `manta-bus` (always, explicit path) plus
 * every inherited server that passes {@link isCloneSafe}. Pure (no I/O) so it's
 * unit-testable. `inherited` is the operator's `mcpServers` map (may be empty).
 */
export function buildCloneMcpConfig(
  busServerPath: string,
  inherited: Record<string, McpServerDef> = {},
): string {
  const servers: Record<string, McpServerDef> = {
    'manta-bus': { command: 'node', args: [busServerPath] },
  };
  for (const [name, def] of Object.entries(inherited)) {
    if (isCloneSafe(name, def)) servers[name] = def;
  }
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

/** Read the operator's user-scope `mcpServers` from `~/.claude.json`. Best-effort: {} on any error. */
async function readUserMcpServers(): Promise<Record<string, McpServerDef>> {
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.claude.json'), 'utf8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerDef> };
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

/**
 * Write the clone's curated MCP config into its worktree under `.manta/` and
 * return the absolute path, for `claude --strict-mcp-config --mcp-config <path>`.
 * Best-effort caller-side: if this throws, the caller should fall back to NO
 * mcp-config args (today's inherit-everything behaviour) rather than abort the
 * spawn — a clone with the full stack is slow, not broken.
 */
export async function writeCloneMcpConfig(args: {
  worktreePath: string;
  busServerPath?: string;
  /** Inject the inherited stack in tests; production reads ~/.claude.json. */
  inherited?: Record<string, McpServerDef>;
}): Promise<string> {
  const busPath = args.busServerPath ?? defaultBusServerPath();
  const inherited = args.inherited ?? (await readUserMcpServers());
  const dir = path.join(args.worktreePath, '.manta');
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, 'clone-mcp.json');
  await fs.writeFile(configPath, buildCloneMcpConfig(busPath, inherited), 'utf8');
  return configPath;
}

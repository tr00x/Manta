import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Clock } from './clock';
import { systemClock } from './clock';
import { busPaths } from './state/paths';
import { Registry } from './state/registry';
import { LocksStore } from './state/locks';
import { ClaimsStore } from './state/claims';
import { ContractsStore } from './state/contracts';
import { EventsLog } from './state/events';
import { fsMemoryWriters, type MemoryWriters } from './memory-writers';
import type { BusContext } from './tools/index';
import { createLifecycleHandlers } from './tools/lifecycle';
import { createContractHandlers } from './tools/contract';
import { createWorkHandlers } from './tools/work';
import { createLockHandlers } from './tools/locks';
import { createCommunicationHandlers } from './tools/communication';
import { createMemoryHandlers } from './tools/memory';
import {
  BusConflictError,
  BusLockedError,
  BusNotFoundError,
  BusStateError,
  BusValidationError,
} from './errors';

export interface CreateBusServerOptions {
  repoRoot: string;
  clock?: Clock;
  staleLockMs?: number;
  memoryWriters?: MemoryWriters;
}

export interface BusServerHandle {
  server: Server;
  /**
   * @internal
   * Exposed only for in-process tests and short-circuit unit wiring (e.g.
   * `tests/integration.test.ts`). External consumers should use the MCP
   * tool surface, not the underlying stores. Kept off the README so its
   * shape can change without a SemVer bump.
   */
  context: BusContext;
}

interface ToolEntry {
  name: string;
  description: string;
  inputSchema: { type: 'object'; additionalProperties: boolean };
  handle: (args: unknown) => Promise<unknown>;
}

/**
 * Minimal hand-rolled JSON Schema. The MCP SDK only requires a parseable
 * object — using `zod-to-json-schema` would add a dependency for cosmetic
 * value. The real validation happens in each handler via the corresponding
 * Zod schema; this descriptor exists so MCP clients can introspect the tool
 * surface and know an object is expected.
 */
function jsonSchema(): { type: 'object'; additionalProperties: boolean } {
  return { type: 'object', additionalProperties: true };
}

/**
 * Wire up an in-process MCP `Server` exposing the full Manta Bus tool surface
 * over whatever transport the caller plugs into `server.connect(...)`.
 *
 * Pure assembly — every state primitive is constructed here and passed into
 * the handler factories via `BusContext`. Tests that need to short-circuit
 * filesystem writes can pass a custom `memoryWriters` and a `FakeClock`.
 *
 * Returns a `Promise` for forward compatibility — Phase 5 daemon mode may
 * need to perform async setup here (warmup, initial events.append, etc.) —
 * even though Chunk 2 wiring is synchronous.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function createBusServer(opts: CreateBusServerOptions): Promise<BusServerHandle> {
  const clock = opts.clock ?? systemClock;
  const paths = busPaths(opts.repoRoot);
  const registry = new Registry(paths, clock);
  const locks = new LocksStore(paths, clock, { staleAfterMs: opts.staleLockMs ?? 15_000 });
  const claims = new ClaimsStore(paths, clock);
  const contracts = new ContractsStore(paths, clock);
  const events = new EventsLog(paths, clock);
  const memoryWriters =
    opts.memoryWriters ?? fsMemoryWriters({ repoRoot: opts.repoRoot, clock });
  const context: BusContext = {
    paths,
    clock,
    registry,
    locks,
    claims,
    contracts,
    events,
    memoryWriters,
  };

  const lifecycle = createLifecycleHandlers(context);
  const contractH = createContractHandlers(context);
  const work = createWorkHandlers(context);
  const lockH = createLockHandlers(context);
  const comm = createCommunicationHandlers(context);
  const memory = createMemoryHandlers(context);

  // Tool table: 18 entries spanning the 6 families. `manta.task_contract`'s
  // sub-commands from spec Sec 4 are encoded with a dot (`task_contract.read`,
  // `task_contract.write`) since MCP tool names cannot contain spaces.
  //
  // Each `handle` is an arrow-function adapter — not a direct method reference —
  // so the call site never depends on the handler object's `this` binding.
  // (eslint's `unbound-method` rule otherwise fires on each entry.)
  const tools: ToolEntry[] = [
    {
      name: 'manta.register',
      description: 'Register a new clone',
      inputSchema: jsonSchema(),
      handle: (args) => lifecycle.register(args),
    },
    {
      name: 'manta.heartbeat',
      description: 'Heartbeat from a clone',
      inputSchema: jsonSchema(),
      handle: (args) => lifecycle.heartbeat(args),
    },
    {
      name: 'manta.suicide_intent',
      description: 'Clone signals self-termination intent',
      inputSchema: jsonSchema(),
      handle: (args) => lifecycle.suicideIntent(args),
    },
    {
      name: 'manta.report_death',
      description: 'Final last-gasp report',
      inputSchema: jsonSchema(),
      handle: (args) => lifecycle.reportDeath(args),
    },
    {
      name: 'manta.task_contract.write',
      description: 'Write task contract for a clone',
      inputSchema: jsonSchema(),
      handle: (args) => contractH.write(args),
    },
    {
      name: 'manta.task_contract.read',
      description: 'Read task contract for a clone',
      inputSchema: jsonSchema(),
      handle: (args) => contractH.read(args),
    },
    {
      name: 'manta.ack_contract',
      description: 'Clone acks contract with interpretation',
      inputSchema: jsonSchema(),
      handle: (args) => contractH.ack(args),
    },
    {
      name: 'manta.contract_refresh',
      description: 'Main broadcasts a contract refresh',
      inputSchema: jsonSchema(),
      handle: (args) => contractH.refresh(args),
    },
    {
      name: 'manta.claim_work',
      description: 'Claim a work item',
      inputSchema: jsonSchema(),
      handle: (args) => work.claim(args),
    },
    {
      name: 'manta.release_work',
      description: 'Release a previously claimed item',
      inputSchema: jsonSchema(),
      handle: (args) => work.release(args),
    },
    {
      name: 'manta.lock',
      description: 'Acquire a heartbeat-based file lock',
      inputSchema: jsonSchema(),
      handle: (args) => lockH.lock(args),
    },
    {
      name: 'manta.unlock',
      description: 'Release a file lock',
      inputSchema: jsonSchema(),
      handle: (args) => lockH.unlock(args),
    },
    {
      name: 'manta.renew_lock',
      description: 'Renew a file lock heartbeat',
      inputSchema: jsonSchema(),
      handle: (args) => lockH.renew(args),
    },
    {
      name: 'manta.broadcast',
      description: 'Broadcast a filtered event (breakthrough/blocker/dependency)',
      inputSchema: jsonSchema(),
      handle: (args) => comm.broadcast(args),
    },
    {
      name: 'manta.message',
      description: 'Direct message between clones',
      inputSchema: jsonSchema(),
      handle: (args) => comm.message(args),
    },
    {
      name: 'manta.drift_report',
      description: 'Clone reports its drift score',
      inputSchema: jsonSchema(),
      handle: (args) => comm.driftReport(args),
    },
    {
      name: 'manta.zk_write',
      description: 'Atomic ZK note write',
      inputSchema: jsonSchema(),
      handle: (args) => memory.zkWrite(args),
    },
    {
      name: 'manta.para_append',
      description: 'Append fact to a PARA category',
      inputSchema: jsonSchema(),
      handle: (args) => memory.paraAppend(args),
    },
  ];
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: 'manta-bus', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  // The MCP SDK accepts a sync or async handler; ListTools is a pure read of
  // the in-memory tool table, so a `Promise.resolve` wrapper is enough.
  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const t = toolMap.get(request.params.name);
    if (!t) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'unknown_tool', name: request.params.name }),
          },
        ],
      };
    }
    try {
      const out = await t.handle(request.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    } catch (err) {
      const error = serializeError(err);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
    }
  });

  return { server, context };
}

interface SerializedError {
  error: string;
  message: string;
  details?: unknown;
}

/**
 * Map every typed bus error into a stable wire envelope. The set is closed —
 * any new error class added in the bus layer must be added here too, or it
 * will fall through to `internal_error` and lose its category. Tests
 * (server.test.ts + integration.test.ts) cover every branch.
 */
function serializeError(err: unknown): SerializedError {
  if (err instanceof BusValidationError) {
    return { error: 'validation_error', message: err.message, details: err.issues };
  }
  if (err instanceof BusNotFoundError) {
    return {
      error: 'not_found',
      message: err.message,
      details: { kind: err.kind, id: err.id },
    };
  }
  if (err instanceof BusConflictError) {
    return { error: 'conflict', message: err.message };
  }
  if (err instanceof BusLockedError) {
    return {
      error: 'locked',
      message: err.message,
      details: { path: err.path, ownerCloneId: err.ownerCloneId },
    };
  }
  if (err instanceof BusStateError) {
    return { error: 'state_error', message: err.message };
  }
  if (err instanceof Error) return { error: 'internal_error', message: err.message };
  return { error: 'internal_error', message: 'unknown' };
}

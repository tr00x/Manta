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
import { CastsStore } from './state/casts';
import { ChargeStore } from './state/charge-store';
import { DailySpendLedger } from './state/daily-spend';
import { EventsLog } from './state/events';
import { WorkQueueStore } from './state/work-queue';
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
  BusForkingIsolationError,
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
  const casts = new CastsStore(paths, clock);
  const charges = new ChargeStore(paths, clock);
  const dailySpend = new DailySpendLedger(paths, clock);
  const events = new EventsLog(paths, clock);
  const workQueue = new WorkQueueStore(paths, clock);
  const memoryWriters =
    opts.memoryWriters ?? fsMemoryWriters({ repoRoot: opts.repoRoot, clock });
  const context: BusContext = {
    paths,
    clock,
    registry,
    locks,
    claims,
    contracts,
    casts,
    charges,
    dailySpend,
    events,
    memoryWriters,
    workQueue,
  };

  const lifecycle = createLifecycleHandlers(context);
  const contractH = createContractHandlers(context);
  const work = createWorkHandlers(context);
  const lockH = createLockHandlers(context);
  const comm = createCommunicationHandlers(context);
  const memory = createMemoryHandlers(context);

  // Tool table: 25 entries spanning the 6 families + Phase 5 daemon tools.
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
      description: 'Broadcast a filtered event (breakthrough/blocker/dependency/self_certainty)',
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
      name: 'manta.read_broadcasts',
      description: 'Read broadcast events from siblings in the same cast',
      inputSchema: jsonSchema(),
      handle: (args) => comm.readBroadcasts(args),
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
    {
      name: 'manta.retask',
      description: 'Re-task an IDLE/WAITING daemon clone with new work',
      inputSchema: jsonSchema(),
      handle: (args) => lifecycle.retask(args),
    },
    {
      name: 'manta.pause',
      description: 'Pause a working daemon clone (transitions to IDLE)',
      inputSchema: jsonSchema(),
      handle: (args) => lifecycle.pause(args),
    },
    {
      name: 'manta.resume',
      description: 'Resume a paused daemon clone (transitions to WORKING)',
      inputSchema: jsonSchema(),
      handle: (args) => lifecycle.resume(args),
    },
    {
      name: 'manta.request_task',
      description: 'Clone signals it is idle and waiting for new work',
      inputSchema: jsonSchema(),
      handle: (args) => lifecycle.requestTask(args),
    },
    {
      name: 'manta.feedback',
      description: 'Send directed feedback to a working or idle clone',
      inputSchema: jsonSchema(),
      handle: (args) => comm.feedback(args),
    },
    {
      name: 'manta.enqueue_work',
      description: 'Enqueue a work item for a daemon clone',
      inputSchema: jsonSchema(),
      handle: (args) => work.enqueue(args),
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
    const args = request.params.arguments ?? {};
    try {
      const out = await t.handle(args);
      // Bug #9 structural fix (option d): any successful MCP call from a
      // registered clone is itself a liveness signal. Touch last_heartbeat_at
      // as a side effect so the orchestrator's death-detector reflects real
      // activity, not just explicit heartbeats. Silent no-op on unknown
      // clone_id and on DEAD clones (Registry.touch contract). Failure of the
      // touch must not fail the handler response — swallow errors and let the
      // caller's normal flow continue.
      // Bug #23: the caller is not always the literal `clone_id` field — for
      // `manta.message` it is `from_clone_id`; for `manta.task_contract.read`
      // with a `requesting_clone_id` it is the requester (not the subject);
      // for main-driven tools (`retask`/`pause`/`resume`/`feedback`/
      // `enqueue_work`/`contract_refresh`/`task_contract.write`) there is no
      // calling clone on the wire at all, so auto-touch must be a no-op.
      const cloneId = extractCloneId(request.params.name, args);
      if (cloneId) {
        try {
          await context.registry.touch(cloneId);
        } catch {
          // Touch failures are non-fatal observability; the handler already
          // succeeded and the clone-side caller does not need to know.
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    } catch (err) {
      const error = serializeError(err);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
    }
  });

  return { server, context };
}

/**
 * Per-tool caller-field map for the bus's auto-touch side effect.
 *
 * Each value is the ordered list of fields in the tool's args that name the
 * *calling* clone (whose `last_heartbeat_at` we advance on success). The
 * first field that resolves to a non-empty string wins; if none resolve,
 * auto-touch is a no-op.
 *
 * `null` means "main-driven — no caller on the wire": the call is initiated
 * by the main agent, the `clone_id`/`target_clone_id` argument names the
 * *target* of the action, and touching it would advance a clone's heartbeat
 * for work it did not do (bug #23, partial regression of bug #9).
 *
 * Adding a new tool? Decide its caller-field policy here at the same time
 * you wire it into the dispatcher above. If the tool surface grows without
 * a corresponding entry, the dispatcher silently skips auto-touch for it —
 * unknown tools never auto-touch (defensive default).
 */
const CALLER_FIELDS_BY_TOOL: Readonly<Record<string, readonly string[] | null>> = {
  'manta.register': ['clone_id'],
  'manta.heartbeat': ['clone_id'],
  'manta.suicide_intent': ['clone_id'],
  'manta.report_death': ['clone_id'],
  'manta.task_contract.write': null,
  'manta.task_contract.read': ['requesting_clone_id', 'clone_id'],
  'manta.ack_contract': ['clone_id'],
  'manta.contract_refresh': null,
  'manta.claim_work': ['clone_id'],
  'manta.release_work': ['clone_id'],
  'manta.lock': ['clone_id'],
  'manta.unlock': ['clone_id'],
  'manta.renew_lock': ['clone_id'],
  'manta.broadcast': ['clone_id'],
  'manta.message': ['from_clone_id'],
  'manta.drift_report': ['clone_id'],
  'manta.read_broadcasts': ['clone_id'],
  'manta.zk_write': ['clone_id'],
  'manta.para_append': ['clone_id'],
  'manta.retask': null,
  'manta.pause': null,
  'manta.resume': null,
  'manta.request_task': ['clone_id'],
  'manta.feedback': null,
  'manta.enqueue_work': null,
};

/**
 * Resolve the calling clone's id from a tool's args for auto-touch. Returns
 * the first non-empty string found via the per-tool caller-field map, or
 * `undefined` when the tool is main-driven, the field is missing/wrong type,
 * or the tool is unknown to the map (defensive — never auto-touch for
 * something we have not classified). Defensive type narrowing throughout so
 * a malformed arg payload cannot crash the dispatcher.
 */
function extractCloneId(toolName: string, args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const fields = CALLER_FIELDS_BY_TOOL[toolName];
  if (!fields) return undefined;
  const obj = args as Record<string, unknown>;
  for (const field of fields) {
    const v = obj[field];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
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
  if (err instanceof BusForkingIsolationError) {
    return {
      error: 'forking_isolation',
      message: err.message,
      details: {
        tool: err.tool,
        from: err.fromCloneId,
        to: err.toCloneId ?? null,
        cast_id: err.castId,
      },
    };
  }
  if (err instanceof BusStateError) {
    return { error: 'state_error', message: err.message };
  }
  if (err instanceof Error) return { error: 'internal_error', message: err.message };
  return { error: 'internal_error', message: 'unknown' };
}

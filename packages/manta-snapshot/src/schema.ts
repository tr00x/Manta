import { z } from 'zod';
import { CURRENT_SCHEMA_VERSION } from './version';

export const ModeSchema = z.enum([
  'recon-swarm',
  'forking-realities',
  'pair-programming',
  'test-storm',
  'bug-hunt',
  'refactor-wave',
  'documentation-chase',
  'phantom-lance',
  'council',
  'decoy',
]);

export type Mode = z.infer<typeof ModeSchema>;

export const ScopeSchema = z.object({
  allowedPaths: z.array(z.string().min(1)).min(1),
  forbiddenPaths: z.array(z.string().min(1)),
  maxFilesChanged: z.number().int().nonnegative(),
});

export const SessionModeSchema = z.enum(['batch', 'daemon']);
export type SessionMode = z.infer<typeof SessionModeSchema>;

export const TaskContractSchema = z.object({
  cloneId: z.string().min(1),
  mode: ModeSchema,
  task: z.string().min(1),
  scope: ScopeSchema,
  approachHint: z.string().nullable(),
  siblingClones: z.array(z.string().min(1)),
  deadlineSeconds: z.number().int().positive(),
  sessionMode: SessionModeSchema.default('batch'),
});

export type TaskContract = z.infer<typeof TaskContractSchema>;

export const TodoSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

export const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.string(),
  timestamp: z.string().datetime(),
});

export const OpenFileSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
});

// `tokensTotal`/`tokensUsed` track real transcript token accounting. The
// `tokensEstimated*` pair is the clone's internal per-clone usage cap — a token
// ESTIMATE (subscription usage proxy), NOT dollars. The 2026-05-31 budget
// repivot renamed the former `dollarsTotal`/`dollarsUsed` fields: Claude Code is
// a subscription (Pro/Max), not pay-per-token, so a dollar cap was meaningless.
export const BudgetSchema = z.object({
  tokensTotal: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
  tokensEstimatedTotal: z.number().nonnegative(),
  tokensEstimatedUsed: z.number().nonnegative(),
});

export const SnapshotSchema = z
  .object({
    version: z.literal(CURRENT_SCHEMA_VERSION),
    castId: z.string().min(1),
    // The REAL Claude Code session uuid of the parent (so a clone can resume
    // the parent's transcript — RB1/bug #56), or `null` when no parent session
    // is known. Historically this held the castId, which is the WRONG kind of
    // value (a cast id, not a session id); that conflation was bug #56.
    parentSessionId: z.string().min(1).nullable(),
    // Whether the clone should boot as a continuation of the parent's
    // transcript. Defaults to false (today's empty-context behaviour). The
    // refine below makes `resumeEnabled === true` imply a non-null
    // parentSessionId — we never resume without a real session id.
    resumeEnabled: z.boolean().default(false),
    parentPid: z.number().int().positive(),
    createdAt: z.string().datetime(),
    taskContract: TaskContractSchema,
    recentMessages: z.array(MessageSchema),
    activeTodos: z.array(TodoSchema),
    openFiles: z.array(OpenFileSchema),
    parentWorktree: z.string().min(1),
    cloneWorktree: z.string().min(1),
    mode: ModeSchema,
    budget: BudgetSchema,
    ttlSeconds: z.number().int().positive(),
    siblingCloneIds: z.array(z.string().min(1)),
    sessionMode: SessionModeSchema.default('batch'),
    sessionId: z.string().min(1).optional(),
  })
  .refine((s) => s.mode === s.taskContract.mode, {
    message: 'snapshot.mode must equal snapshot.taskContract.mode',
    path: ['mode'],
  })
  .refine((s) => !(s.resumeEnabled && s.parentSessionId === null), {
    message: 'resumeEnabled requires a non-null parentSessionId (never resume without a real session id)',
    path: ['resumeEnabled'],
  });

export type Snapshot = z.infer<typeof SnapshotSchema>;

// Inferred type re-exports for downstream callers (manta-cli, manta-orchestrator)
export type Scope = z.infer<typeof ScopeSchema>;
export type Todo = z.infer<typeof TodoSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type OpenFile = z.infer<typeof OpenFileSchema>;
export type Budget = z.infer<typeof BudgetSchema>;

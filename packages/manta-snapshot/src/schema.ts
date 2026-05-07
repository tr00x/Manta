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

export const TaskContractSchema = z.object({
  cloneId: z.string().min(1),
  mode: ModeSchema,
  task: z.string().min(1),
  scope: ScopeSchema,
  approachHint: z.string().nullable(),
  siblingClones: z.array(z.string().min(1)),
  deadlineSeconds: z.number().int().positive(),
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

export const BudgetSchema = z.object({
  tokensTotal: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
  dollarsTotal: z.number().nonnegative(),
  dollarsUsed: z.number().nonnegative(),
});

export const SnapshotSchema = z
  .object({
    version: z.literal(CURRENT_SCHEMA_VERSION),
    castId: z.string().min(1),
    parentSessionId: z.string().min(1),
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
  })
  .refine((s) => s.mode === s.taskContract.mode, {
    message: 'snapshot.mode must equal snapshot.taskContract.mode',
    path: ['mode'],
  });

export type Snapshot = z.infer<typeof SnapshotSchema>;

// Inferred type re-exports for downstream callers (manta-cli, manta-orchestrator)
export type Scope = z.infer<typeof ScopeSchema>;
export type Todo = z.infer<typeof TodoSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type OpenFile = z.infer<typeof OpenFileSchema>;
export type Budget = z.infer<typeof BudgetSchema>;

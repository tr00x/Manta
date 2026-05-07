import { z } from 'zod';

// Clone IDs are short ASCII slugs (alphanum + dash + underscore), max 64 chars.
export const CloneIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'clone_id must match /^[A-Za-z0-9_-]+$/');

// Mode catalog (Phase 0 only ships recon-swarm; the other modes are reserved values
// so that contracts written today can be read by Phase 1+ without migration).
export const ModeSchema = z.enum([
  'recon-swarm',
  'forking-realities',
  'refactor-wave',
  'bug-hunt',
  'documentation-chase',
  'pair-programming',
  'test-storm',
  'council',
  'phantom-lance',
  'decoy',
]);

export const CloneStateSchema = z.enum(['STARTING', 'WORKING', 'BLOCKED', 'WINDING_DOWN', 'DEAD']);

export const RegisterInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    mode: ModeSchema,
    parent_pid: z.number().int().positive(),
    worktree: z.string().min(1),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const HeartbeatInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    state: CloneStateSchema,
    progress: z.string().max(2_000).optional(),
  })
  .strict();

export const SuicideIntentInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    reason: z.string().min(1).max(2_000),
  })
  .strict();

export const ReportDeathInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    last_gasp_report_path: z.string().min(1),
  })
  .strict();

export const ScopeSchema = z
  .object({
    allowed_paths: z.array(z.string().min(1)).min(1),
    forbidden_paths: z.array(z.string().min(1)).default([]),
    max_files_changed: z.number().int().nonnegative(),
  })
  .strict();

export const TaskContractSchema = z
  .object({
    clone_id: CloneIdSchema,
    mode: ModeSchema,
    task: z.string().min(1).max(8_000),
    scope: ScopeSchema,
    approach_hint: z.string().max(8_000).optional(),
    sibling_clones: z.array(CloneIdSchema).default([]),
    deadline_ms: z.number().int().positive(),
  })
  .strict();

export const TaskContractWriteInputSchema = z
  .object({
    contract: TaskContractSchema,
  })
  .strict();

export const TaskContractReadInputSchema = z
  .object({
    clone_id: CloneIdSchema,
  })
  .strict();

export const AckContractInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    interpretation: z.string().min(1).max(8_000),
  })
  .strict();

export const ContractRefreshInputSchema = z
  .object({
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const ClaimWorkInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    item: z.string().min(1).max(512),
    timeout_ms: z.number().int().positive(),
  })
  .strict();

export const ReleaseWorkInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    item: z.string().min(1).max(512),
  })
  .strict();

// Repo-relative POSIX paths, no leading slash, no `..` segments.
const RepoRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((p) => !p.startsWith('/'), { message: 'path must be repo-relative (no leading /)' })
  .refine((p) => !p.split('/').includes('..'), { message: 'path must not contain `..` segments' });

export const LockInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    path: RepoRelativePathSchema,
  })
  .strict();

export const BroadcastEventTypeSchema = z.enum(['breakthrough', 'blocker', 'dependency']);

export const BroadcastInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    event_type: BroadcastEventTypeSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export const MessageInputSchema = z
  .object({
    from_clone_id: CloneIdSchema,
    to_clone_id: CloneIdSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export const DriftReportInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    score: z.number().min(0).max(1),
    evidence: z.string().min(1).max(8_000),
  })
  .strict();

export const ZkWriteInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    title: z.string().min(1).max(256),
    content: z.string().min(1),
    tags: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const ParaAppendInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    category: z.enum(['projects', 'areas', 'resources', 'archive']),
    fact: z.string().min(1),
  })
  .strict();

// Inferred types — exported so handlers and stores can share them.
export type CloneId = z.infer<typeof CloneIdSchema>;
export type Mode = z.infer<typeof ModeSchema>;
export type CloneState = z.infer<typeof CloneStateSchema>;
export type RegisterInput = z.infer<typeof RegisterInputSchema>;
export type HeartbeatInput = z.infer<typeof HeartbeatInputSchema>;
export type SuicideIntentInput = z.infer<typeof SuicideIntentInputSchema>;
export type ReportDeathInput = z.infer<typeof ReportDeathInputSchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export type TaskContract = z.infer<typeof TaskContractSchema>;
export type AckContractInput = z.infer<typeof AckContractInputSchema>;
export type ClaimWorkInput = z.infer<typeof ClaimWorkInputSchema>;
export type ReleaseWorkInput = z.infer<typeof ReleaseWorkInputSchema>;
export type LockInput = z.infer<typeof LockInputSchema>;
export type BroadcastEventType = z.infer<typeof BroadcastEventTypeSchema>;
export type BroadcastInput = z.infer<typeof BroadcastInputSchema>;
export type MessageInput = z.infer<typeof MessageInputSchema>;
export type DriftReportInput = z.infer<typeof DriftReportInputSchema>;
export type ZkWriteInput = z.infer<typeof ZkWriteInputSchema>;
export type ParaAppendInput = z.infer<typeof ParaAppendInputSchema>;

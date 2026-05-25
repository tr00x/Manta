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

// Matches CastIdSchema pattern — duplicated here because metadata is
// Record<string, string>, not typed against CastIdSchema directly.
const SafeCastIdRegex = /^[A-Za-z0-9._-]+$/;

export const RegisterInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    mode: ModeSchema,
    parent_pid: z.number().int().positive(),
    worktree: z.string().min(1),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .refine(
    (input) => {
      if (input.mode !== 'forking-realities') return true;
      const id = input.metadata.cast_id;
      return typeof id === 'string' && SafeCastIdRegex.test(id);
    },
    {
      message:
        'forking-realities clones must register with metadata.cast_id matching /^[A-Za-z0-9._-]+$/',
      path: ['metadata', 'cast_id'],
    },
  );

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
    requesting_clone_id: CloneIdSchema.optional(),
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

// Cast manifest — Sec 7 (best-of-N flow needs cast-level state) + research:
// docs/research/phase-2-codepath-map.md §2.3 (per-cast manifest motivation)
// + docs/research/phase-2-bus-isolation.md §4.4 (forward-compatible policy
// shape so future modes — council/decoy/etc. — slot in without branching on
// `mode === 'forking-realities'`).
export const CastIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9_.-]+$/, 'cast_id must match /^[A-Za-z0-9_.-]+$/');

export const CastPolicySchema = z
  .object({
    // Phase 2: 'allowed' (recon-swarm and friends) | 'denied' (forking-realities).
    // String-enum (rather than boolean) is the forward-compatible cut from
    // research §4.4 — a future `peer_messaging: 'role-based'` or 'main-only'
    // slots in additively.
    peer_messaging: z.enum(['allowed', 'denied']),
    // Phase 2: stays null (manual-merge default per research best-of-n §4 hybrid
    // mode); Phase 3+ can set a value in [0, 1]. Null encodes "manual review
    // required" without overloading the number space.
    auto_merge_threshold: z
      .number()
      .min(0)
      .max(1)
      .nullable(),
  })
  .strict();

export const CloneAssignmentSchema = z
  .object({
    task: z.string().min(1).max(8_000).optional(),
    approach_hint: z.string().max(8_000).optional(),
    scope: ScopeSchema.optional(),
    budget_usd: z.number().positive().optional(),
    deadline_seconds: z.number().int().positive().optional(),
  })
  .strict();

export const CastClonesEntrySchema = z
  .object({
    clone_id: CloneIdSchema,
    assignment: CloneAssignmentSchema.nullable(),
  })
  .strict();

export const CastManifestSchema = z
  .object({
    version: z.literal(1),
    cast_id: CastIdSchema,
    mode: ModeSchema,
    clones: z
      .array(CastClonesEntrySchema)
      .min(1)
      .refine(
        (xs) => new Set(xs.map((c) => c.clone_id)).size === xs.length,
        { message: 'roster must not contain duplicate clone_ids' },
      ),
    policy: CastPolicySchema,
    created_at: z.number().int().nonnegative(),
  })
  .strict();

export const CreateCastInputSchema = z
  .object({
    cast_id: CastIdSchema,
    mode: ModeSchema,
    clones: z
      .array(CastClonesEntrySchema)
      .min(1)
      .refine(
        (xs) => new Set(xs.map((c) => c.clone_id)).size === xs.length,
        { message: 'roster must not contain duplicate clone_ids' },
      ),
    policy: CastPolicySchema,
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
export type CastId = z.infer<typeof CastIdSchema>;
export type CastPolicy = z.infer<typeof CastPolicySchema>;
export type CloneAssignment = z.infer<typeof CloneAssignmentSchema>;
export type CastClonesEntry = z.infer<typeof CastClonesEntrySchema>;
export type CastManifest = z.infer<typeof CastManifestSchema>;
export type CreateCastInput = z.infer<typeof CreateCastInputSchema>;

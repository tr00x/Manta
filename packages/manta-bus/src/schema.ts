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

export const CloneStateSchema = z.enum([
  'STARTING', 'WORKING', 'BLOCKED', 'IDLE', 'WAITING_FOR_TASK',
  'WINDING_DOWN', 'DEAD',
]);

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

export const BroadcastEventTypeSchema = z.enum([
  'breakthrough', 'blocker', 'dependency', 'self_certainty',
  'task_complete', 'idle', 'feedback_received',
  // Wave-2: pair-programming
  'commit_ready', 'review_complete', 'writer_stuck',
  // Wave-2: test-storm
  'code_ready', 'tests_ready', 'fuzz_complete',
  // Wave-2: documentation-chase
  'docs_ready',
]);

// Bug #51 workaround: Claude Code's `--print`-mode MCP client occasionally
// JSON.stringify's nested object arguments before they reach the bus
// (whitespace-sensitive heuristic somewhere in the bridge). The bus's Zod
// schema would then reject with `Expected object, received string at
// path:["payload"]`. The preprocess tries `JSON.parse` on string inputs
// that look like a JSON object; on success the parsed object continues
// through the `z.record(...)` validator unchanged. Mirrors the pattern
// already in use for `ZkWriteInputSchema.tags` (CSV-to-array coercion).
// The bridge bug itself lives in the Claude Code SDK and is logged as
// #51 — this is a defensive widening, not a substitute for the root fix.
const PayloadObjectSchema = z.preprocess((v) => {
  if (typeof v === 'string' && v.length > 1 && v.startsWith('{') && v.endsWith('}')) {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}, z.record(z.string(), z.unknown()));

export const BroadcastInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    event_type: BroadcastEventTypeSchema,
    payload: PayloadObjectSchema,
  })
  .strict();

export const MessageInputSchema = z
  .object({
    from_clone_id: CloneIdSchema,
    to_clone_id: CloneIdSchema,
    payload: PayloadObjectSchema,
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
    tags: z
      .preprocess(
        (v) => (typeof v === 'string' ? v.split(',').map((s: string) => s.trim()).filter(Boolean) : v),
        z.array(z.string().min(1)),
      )
      .default([]),
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

export const ReadBroadcastsInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    cast_id: CastIdSchema,
    since_ts: z.number().int().nonnegative().optional(),
  })
  .strict();

// Phase 5 — Daemon-mode input schemas

export const RetaskInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    new_task: z.string().min(1).max(8_000),
    new_scope: ScopeSchema.optional(),
    new_approach_hint: z.string().max(8_000).optional(),
    new_deadline_ms: z.number().int().positive().optional(),
  })
  .strict();

export const PauseInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    reason: z.string().min(1).max(2_000),
  })
  .strict();

export const ResumeInputSchema = z
  .object({
    clone_id: CloneIdSchema,
  })
  .strict();

export const FeedbackInputSchema = z
  .object({
    clone_id: CloneIdSchema,
    from: z.string().min(1).max(64),
    feedback: z.string().min(1).max(8_000),
    severity: z.enum(['info', 'correction', 'blocker']),
  })
  .strict();

export const RequestTaskInputSchema = z
  .object({
    clone_id: CloneIdSchema,
  })
  .strict();

export const EnqueueWorkInputSchema = z
  .object({
    cast_id: CastIdSchema,
    target_clone_id: CloneIdSchema,
    prompt: z.string().min(1).max(16_000),
    priority: z.enum(['normal', 'high']).default('normal'),
  })
  .strict();

export const CastPolicySchema = z
  .object({
    peer_messaging: z.enum(['allowed', 'denied']),
    auto_merge_threshold: z
      .number()
      .min(0)
      .max(1)
      .nullable(),
    session_mode: z.enum(['batch', 'daemon']).default('batch'),
  })
  .strict();

export const CloneRoleSchema = z.enum([
  'writer', 'reviewer',
  'coder', 'tester', 'fuzzer',
  'documenter',
]);

export const CloneAssignmentSchema = z
  .object({
    task: z.string().min(1).max(8_000).optional(),
    approach_hint: z.string().max(8_000).optional(),
    scope: ScopeSchema.optional(),
    // Per-clone usage cap as a token ESTIMATE (subscription usage proxy), NOT
    // dollars. Renamed from `budget_usd` in the 2026-05-31 budget repivot.
    token_estimate: z.number().positive().optional(),
    deadline_seconds: z.number().int().positive().optional(),
    role: CloneRoleSchema.optional(),
  })
  .strict();

export const CastClonesEntrySchema = z
  .object({
    clone_id: CloneIdSchema,
    assignment: CloneAssignmentSchema.nullable(),
  })
  .strict();

// Phase 7c — trigger provenance. A reactively-spawned cast records which
// trigger fired it and the cause-chain of trigger names that led here, so the
// loop detector (Phase 7c Chunk 3) can refuse a spawn before it recurses. This
// is the frozen contract clone-A's share-bundle `castOrigin` block propagates
// verbatim — renaming these fields is a breaking change to that contract.
export const CastTriggerProvenanceSchema = z
  .object({
    trigger_name: z.string().min(2).max(48).regex(/^[a-z0-9-]+$/),
    fired_at: z.number().int().nonnegative(),
    parent_cast_id: CastIdSchema.nullable(), // null = user-fired / outside any Manta context
  })
  .strict();

export const CastMetadataSchema = z
  .object({
    trigger: CastTriggerProvenanceSchema.optional(),
    // trigger names; .max(8) is a backstop above the depth-3 refusal so a
    // poisoned manifest cannot carry an unbounded chain.
    cause_chain: z.array(z.string().min(2).max(48)).max(8).default([]),
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
    metadata: CastMetadataSchema.optional(),
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
    metadata: CastMetadataSchema.optional(),
  })
  .strict();

// Phase 3 — Charge system schemas

export const MODE_CHARGE_COST: Readonly<Record<Mode, number>> = {
  'recon-swarm': 1,
  'pair-programming': 1,
  'documentation-chase': 1,
  'forking-realities': 2,
  'test-storm': 2,
  'refactor-wave': 2,
  'bug-hunt': 2,
  'decoy': 2,
  'council': 3,
  'phantom-lance': 3,
};

export const ChargeStateSchema = z
  .object({
    version: z.literal(1),
    current_charges: z.number().int(),
    charges_max: z.number().int().positive(),
    charges_min: z.number().int(),
    last_idle_recovery_at: z.number().int().nonnegative(),
    last_cast_ended_at: z.number().int().nonnegative(),
    cooldown_until: z.number().int().nonnegative().nullable(),
    total_successes: z.number().int().nonnegative(),
    total_failures: z.number().int().nonnegative(),
    total_casts: z.number().int().nonnegative(),
  })
  .strict();

export const ChargeEventTypeSchema = z.enum([
  'cast_start',
  'cast_success',
  'cast_fail',
  'cast_neutral',
  'idle_recovery',
  'manual_refresh',
  'cooldown_triggered',
  'cooldown_cleared',
]);

export const ChargeEventSchema = z
  .object({
    ts: z.number().int().nonnegative(),
    type: ChargeEventTypeSchema,
    delta: z.number().int(),
    cast_id: z.string().nullable(),
    mode: ModeSchema.nullable(),
    cost: z.number().int().nonnegative().optional(),
    prev_charges: z.number().int(),
    next_charges: z.number().int(),
    reason: z.string().optional(),
  })
  .strict();

// Usage ledger entry. Claude Code is a subscription (Pro/Max), not pay-per-
// token, so the unit here is a TOKEN ESTIMATE — a rough proxy for how much of
// your subscription's usage/rate budget a cast consumes — NOT dollars. The
// repivot (2026-05-31) replaced the dollar accounting with this usage model.
export const DailySpendEntrySchema = z
  .object({
    cast_id: z.string(),
    mode: ModeSchema,
    clone_count: z.number().int().positive(),
    estimated_tokens: z.number().nonnegative(),
    estimate_type: z.enum(['estimate', 'actual']),
    started_at: z.number().int().nonnegative(),
  })
  .strict();

export const DailySpendStateSchema = z
  .object({
    version: z.literal(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    tokens_estimated: z.number().nonnegative(),
    entries: z.array(DailySpendEntrySchema),
  })
  .strict();

export const BudgetConfigSchema = z
  .object({
    // Usage-aware caps (token estimates, not dollars). `auto` per-clone =
    // per-cast / clone_count.
    token_estimate_per_cast: z.number().positive(),
    token_estimate_per_clone: z.union([z.number().positive(), z.literal('auto')]),
    daily_token_cap: z.number().positive(),
    // Parallelism cap: max clones a single cast may spawn concurrently.
    max_parallel_clones: z.number().int().positive(),
    // Cast-rate cap: max casts allowed to start within a rolling hour. Backed
    // by the charge ledger's cast_start events. The charge system remains the
    // primary rate primitive; this is a hard per-hour ceiling on top of it.
    max_casts_per_hour: z.number().int().positive(),
    token_estimates: z.record(ModeSchema, z.number().nonnegative()),
    auto_downgrade: z
      .object({
        enabled: z.boolean(),
        confirm: z.boolean(),
        min_clones: z.number().int().positive(),
      })
      .partial()
      .strict(),
    charges: z
      .object({
        initial: z.number().int().nonnegative(),
        max: z.number().int().positive(),
        min: z.number().int(),
        idle_recovery_minutes: z.number().int().positive(),
        cooldown_hours: z.number().int().positive(),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict()
  // Phase 7c Task 1.2: global hourly cap spanning ALL triggers (research §3.2),
  // on top of each trigger's own hourly_cap — covers many small triggers firing
  // simultaneously. Added via .extend() (NOT inside the .partial() block) so its
  // .default() actually fires: .partial() wraps each field in ZodOptional, which
  // short-circuits before reaching an inner ZodDefault.
  .extend({
    triggers: z
      .object({
        global_hourly_cap: z.number().int().positive().default(6),
      })
      .strict()
      .default({ global_hourly_cap: 6 }),
    // Phase 8: Aghanim's Scepter unlock (spec Sec 6.6). `decoy`, `council`, and
    // `phantom-lance` ship locked; the operator opts in per-repo by listing the
    // modes here (the env var MANTA_UNLOCK_AGHS is the ephemeral equivalent).
    // Validated against ModeSchema so a typo is a config error, not a silent
    // no-unlock. Defaults to none (everything locked).
    aghs: z
      .object({
        unlocked: z.array(ModeSchema).default([]),
      })
      .strict()
      .default({ unlocked: [] }),
  });

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
export type ReadBroadcastsInput = z.infer<typeof ReadBroadcastsInputSchema>;
export type ZkWriteInput = z.infer<typeof ZkWriteInputSchema>;
export type ParaAppendInput = z.infer<typeof ParaAppendInputSchema>;
export type CastId = z.infer<typeof CastIdSchema>;
export type CastPolicy = z.infer<typeof CastPolicySchema>;
export type CloneRole = z.infer<typeof CloneRoleSchema>;
export type CloneAssignment = z.infer<typeof CloneAssignmentSchema>;
export type CastClonesEntry = z.infer<typeof CastClonesEntrySchema>;
export type CastManifest = z.infer<typeof CastManifestSchema>;
export type CreateCastInput = z.infer<typeof CreateCastInputSchema>;
export type CastTriggerProvenance = z.infer<typeof CastTriggerProvenanceSchema>;
export type CastMetadata = z.infer<typeof CastMetadataSchema>;
export type ChargeState = z.infer<typeof ChargeStateSchema>;
export type ChargeEvent = z.infer<typeof ChargeEventSchema>;
export type ChargeEventType = z.infer<typeof ChargeEventTypeSchema>;
export type DailySpendEntry = z.infer<typeof DailySpendEntrySchema>;
export type DailySpendState = z.infer<typeof DailySpendStateSchema>;
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
export type RetaskInput = z.infer<typeof RetaskInputSchema>;
export type PauseInput = z.infer<typeof PauseInputSchema>;
export type ResumeInput = z.infer<typeof ResumeInputSchema>;
export type FeedbackInput = z.infer<typeof FeedbackInputSchema>;
export type RequestTaskInput = z.infer<typeof RequestTaskInputSchema>;
export type EnqueueWorkInput = z.infer<typeof EnqueueWorkInputSchema>;

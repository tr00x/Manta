import { z } from 'zod';
import { ModeSchema } from './schema';

// Phase 7c Task 1.3 — the trigger DSL. This is the ONLY user-authored,
// schema-validated artifact in Phase 7c, so it is the headline risk surface.
// Everything is .strict() (no unknown keys anywhere), forbidden_paths is
// mandatory, and budgets are capped relative to the safety block at PARSE TIME
// — never at fire time. Co-located in @manta/bus alongside BudgetConfigSchema
// so both the bus stores and the CLI validator import one parser (single source
// of truth). The mode list is reused from ModeSchema (never re-derived).

export const TriggerNameSchema = z.string().regex(/^[a-z0-9-]{2,48}$/);

export const EventSourceSchema = z.enum(['git', 'claude-code-hook', 'manual']);

export const ConditionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('shell'),
      cmd: z.string().min(1),
      timeout_ms: z.number().int().positive().max(300000),
      cwd: z.string().default('${repo.root}'),
    })
    .strict(),
  z.object({ type: z.literal('changed_files_gt'), value: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('changed_files_match_glob'), glob: z.string().min(1) }).strict(),
  z.object({ type: z.literal('exit_code_eq'), value: z.number().int() }).strict(),
  z.object({ type: z.literal('env_eq'), name: z.string().min(1), value: z.string() }).strict(),
  z
    .object({
      type: z.literal('payload_json_path_eq'),
      path: z.string().min(1),
      value: z.string().optional(),
      matches_glob: z.string().optional(),
    })
    .strict(),
]);

export const TriggerScopeSchema = z
  .object({
    allowed_paths: z.array(z.string().min(1)).min(1),
    forbidden_paths: z.array(z.string().min(1)),
    max_files_changed: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (s) => s.forbidden_paths.includes('.manta/state') && s.forbidden_paths.includes('secrets/'),
    { message: 'forbidden_paths MUST include both ".manta/state" and "secrets/"' },
  );

export const TriggerSafetySchema = z
  .object({
    hourly_cap: z.number().int().positive().default(3),
    per_fire_budget_usd: z.number().positive().default(3),
    loop: z
      .object({
        max_cause_chain_depth: z.number().int().positive().max(8).default(3),
        refuse_if_self_in_chain: z.boolean().default(true),
        refuse_if_any_in_chain: z.array(TriggerNameSchema).default([]),
      })
      .strict()
      .default({ max_cause_chain_depth: 3, refuse_if_self_in_chain: true, refuse_if_any_in_chain: [] }),
  })
  .strict();

export const TriggerActionSchema = z
  .object({
    mode: ModeSchema,
    clones: z.number().int().positive().max(8),
    task_template: z.string().min(1),
    scope: TriggerScopeSchema,
    budget: z
      .object({ per_clone_usd: z.number().positive(), per_cast_usd: z.number().positive() })
      .strict(),
  })
  .strict();

export const TriggerDefSchema = z
  .object({
    version: z.literal(1),
    name: TriggerNameSchema,
    enabled: z.literal(false), // MUST be false at add-time; arm flips bus state, not YAML
    description: z.string().default(''),
    event: z
      .object({
        source: EventSourceSchema,
        type: z.string().min(1),
        hook_matcher: z.string().nullable().default(null),
      })
      .strict(),
    conditions: z.array(ConditionSchema).default([]),
    debounce_ms: z.number().int().nonnegative().default(0),
    dedup_key: z.string().default(''),
    cooldown_s: z.number().int().nonnegative().default(300),
    safety: TriggerSafetySchema,
    action: TriggerActionSchema,
  })
  .strict()
  .refine((t) => t.action.budget.per_cast_usd <= t.safety.per_fire_budget_usd, {
    message: 'action.budget.per_cast_usd must be <= safety.per_fire_budget_usd',
    path: ['action', 'budget', 'per_cast_usd'],
  });

export type TriggerName = z.infer<typeof TriggerNameSchema>;
export type EventSource = z.infer<typeof EventSourceSchema>;
export type TriggerCondition = z.infer<typeof ConditionSchema>;
export type TriggerScope = z.infer<typeof TriggerScopeSchema>;
export type TriggerSafety = z.infer<typeof TriggerSafetySchema>;
export type TriggerAction = z.infer<typeof TriggerActionSchema>;
export type TriggerDef = z.infer<typeof TriggerDefSchema>;

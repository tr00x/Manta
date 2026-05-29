import { z } from 'zod';
import { CURRENT_SCHEMA_VERSION } from './version';
import { ModeSchema, SessionModeSchema, TaskContractSchema, TodoSchema, OpenFileSchema } from './schema';

/**
 * The leak-free shape produced by `manta share`'s snapshot sanitizer
 * (Phase 7b Task 1.3). Default-deny: every field that can carry host-local or
 * sensitive material is OMITTED entirely rather than redacted in place —
 * `parentSessionId`, `parentPid`, `recentMessages` (raw transcript),
 * `budget`, and the internal `sessionId` are gone. `parentWorktree` /
 * `cloneWorktree` collapse to opaque markers. `resumeEnabled` (RB1/bug #56) is
 * a harmless boolean and is KEPT — it carries no host-local or sensitive data,
 * and must be in the allow-list or `.strict()` would reject the round-trip.
 *
 * Built as a fresh `z.object` (not `SnapshotSchema.omit(...)`) because
 * `SnapshotSchema` is a `ZodEffects` (it carries a `.refine`), which has no
 * `.omit`. Field schemas are re-used from `./schema` so the kept fields stay
 * in lock-step with the source contract. `.strict()` guarantees a dropped
 * field re-appearing is a parse error, not a silent leak.
 */
export const SanitizedSnapshotSchema = z
  .object({
    version: z.literal(CURRENT_SCHEMA_VERSION),
    castId: z.string().min(1),
    createdAt: z.string().datetime(),
    // taskContract is sanitized separately (Task 1.4); the snapshot sanitizer
    // keeps it verbatim and the command swaps in the sanitized contract.
    taskContract: TaskContractSchema,
    activeTodos: z.array(TodoSchema),
    openFiles: z.array(OpenFileSchema),
    parentWorktree: z.literal('<worktree>'),
    cloneWorktree: z.string().regex(/^<worktree>\/clone-[^/]+$/),
    mode: ModeSchema,
    ttlSeconds: z.number().int().positive(),
    siblingCloneIds: z.array(z.string().min(1)),
    sessionMode: SessionModeSchema,
    resumeEnabled: z.boolean(),
  })
  .strict();

export type SanitizedSnapshot = z.infer<typeof SanitizedSnapshotSchema>;

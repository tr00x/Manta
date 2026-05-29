import { z } from 'zod';

/**
 * Cast lineage metadata recorded in a shared bundle's manifest.
 *
 * Phase 7b reads the originating cast's on-disk state read-only and records
 * where the bundle came from so an installer can audit its provenance. None
 * of these fields are sensitive by construction (random ids, a public repo
 * URL, a semver, an ISO timestamp) — the leak-prone material (paths, PIDs,
 * transcripts, secrets) is stripped by the per-artifact sanitizers before it
 * ever reaches a manifest.
 *
 * NOTE on module layout (Phase 7b): this file intentionally does NOT import
 * `./manifest-schema.js`. `manifest-schema.ts` imports `CastOriginSchema`
 * from here to add the gated `castOrigin.optional()` field, so a back-edge
 * would create a fatal eval-time circular import (`MantaPackageManifestSchema`
 * needs `CastOriginSchema` at `.optional()` call time while `CastOriginSchema`
 * is still mid-evaluation). The dependent `SharedBundleManifestSchema`
 * therefore lives in `manifest-schema.ts` (which has both schemas available)
 * and is re-exported from the package index alongside this file.
 */

/**
 * Mirrors the Phase 7c-frozen trigger contract (`CastManifest.metadata.trigger`).
 * Field names are the camelCase manifest-side mapping of clone-B's frozen
 * wire-side contract (`trigger_name` / `fired_at` / `parent_cast_id` +
 * `cause_chain`), copied verbatim. `parentCastId: null` ⇒ user-fired root cast.
 */
const ProvenanceSchema = z
  .object({
    triggerName: z.string().min(2).max(48),
    // Relativised: ms offset from the cast's `created_at`, NOT a wallclock
    // epoch (sanitization rule — wallclock epochs are stripped everywhere).
    firedAtOffsetMs: z.number().int(),
    parentCastId: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+$/)
      .max(96)
      .nullable(),
    causeChain: z.array(z.string().min(1).max(48)).max(8),
  })
  .strict();

export const CastOriginSchema = z
  .object({
    // CastId of the originating cast. Non-sensitive (a random id, not a path).
    castId: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+$/)
      .max(96),
    // One of the ten Mode literals (packages/manta-snapshot/src/schema.ts:4-15).
    castMode: z.enum([
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
    ]),
    // `git remote get-url origin` of the authoring repo, or null if local-only.
    // SANITIZED: must be a URL, never a filesystem path (a local remote leaks
    // an absolute path — see the castOrigin builder, Task 2.2).
    originalRepoOrigin: z.string().url().nullable(),
    // getMantaCliVersion() at bundle time.
    originalMantaVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    // ISO 8601 UTC, second precision (no offset — reduces correlation).
    bundledAt: z.string().datetime({ offset: false }),
    // The winning clone id (resolved per §winning-clone-resolution).
    winningCloneId: z.string().min(1).max(64),
    // Trigger provenance, or null for user-fired casts. See §auto-share.
    provenance: ProvenanceSchema.nullable(),
  })
  .strict();

export type CastOrigin = z.infer<typeof CastOriginSchema>;

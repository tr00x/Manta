import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicMutateJson, atomicReadJson } from '../atomic-fs';
import type { Clock } from '../clock';
import { BusConflictError, BusNotFoundError } from '../errors';
import type { CastManifest, CreateCastInput } from '../schema';
import { CastManifestSchema, CreateCastInputSchema } from '../schema';
import { canonicalize } from './canonicalize';
import type { BusPaths } from './paths';

/**
 * Per-cast state. Records the cast's mode, roster, and policy at spawn time.
 *
 * Each manifest is one file at `BusPaths.castFile(castId)`; `BusPaths.castsDir`
 * is the parent directory. The file is written atomically via `atomicMutateJson`
 * (same primitive `Registry`/`Contracts` use), so concurrent spawn attempts on
 * the same cast_id resolve cleanly: the first wins, the second sees the
 * existing manifest and (on identical content) succeeds idempotently.
 *
 * Phase 2 readers: bus filter (Phase 2b — sibling messaging), orchestrator
 * (Phase 2c — finalised-cast detection), CLI (Phase 2d — replay/audit).
 */
export class CastsStore {
  constructor(private readonly paths: BusPaths, private readonly clock: Clock) {}

  /**
   * Create a new manifest. Idempotent: re-create with the *same* content
   * returns the existing manifest unchanged (preserves the original
   * `created_at`). Re-create with *different* content (different mode,
   * different roster, different policy) throws BusConflictError — never
   * silently overwrites.
   */
  async create(
    rawInput: CreateCastInput,
    auditAppend?: () => Promise<void>,
  ): Promise<CastManifest> {
    const input = CreateCastInputSchema.parse(rawInput);
    await fs.mkdir(this.paths.castsDir, { recursive: true });
    const file = this.paths.castFile(input.cast_id);
    return atomicMutateJson<CastManifest>(
      file,
      // Default factory: only consulted when the file does not yet exist.
      // We stamp the creation timestamp here so repeated calls (after
      // idempotent return) do NOT clobber the original — the mutator below
      // returns `current` unchanged on identical input.
      () => ({
        version: 1,
        cast_id: input.cast_id,
        mode: input.mode,
        clones: input.clones,
        policy: input.policy,
        created_at: this.clock.now(),
      }),
      (current) => {
        // First-write path: defaultFactory's value is what `current` is. No
        // conflict checks needed — atomicMutateJson will write `current`
        // directly. We DO have to detect "first write" vs "already-existed"
        // because the conflict checks below assume an existing manifest.
        // The cleanest shape: compare `current` against the desired-without-
        // timestamp shape; if they match modulo created_at, this is either
        // (a) first-write (defaultFactory) or (b) idempotent rewrite — both
        // succeed by returning `current`.
        const sameMode = current.mode === input.mode;
        const sameRosterAndAssignments =
          JSON.stringify(canonicalize(current.clones)) ===
          JSON.stringify(canonicalize(input.clones));
        const samePolicy =
          JSON.stringify(canonicalize(current.policy)) ===
          JSON.stringify(canonicalize(input.policy));
        if (sameMode && sameRosterAndAssignments && samePolicy) {
          return current; // first-write OR identical idempotent rewrite
        }
        if (!sameMode) {
          throw new BusConflictError(
            `cast ${input.cast_id} already exists with mode=${current.mode}; refused to overwrite with mode=${input.mode}`,
          );
        }
        if (!sameRosterAndAssignments) {
          throw new BusConflictError(
            `cast ${input.cast_id} already exists with a different roster or per-clone assignments`,
          );
        }
        // Must be policy.
        throw new BusConflictError(
          `cast ${input.cast_id} already exists with a different policy`,
        );
      },
      auditAppend,
    );
  }

  async read(castId: string): Promise<CastManifest> {
    const file = this.paths.castFile(castId);
    const raw = await atomicReadJson<CastManifest | null>(file, () => null);
    if (raw == null) throw new BusNotFoundError('cast', castId);
    return CastManifestSchema.parse(raw);
  }

  async list(): Promise<CastManifest[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.paths.castsDir);
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'ENOENT'
      ) {
        return [];
      }
      throw err;
    }
    const out: CastManifest[] = [];
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      const raw = await atomicReadJson<CastManifest | null>(
        path.join(this.paths.castsDir, f),
        () => null,
      );
      if (raw != null) out.push(CastManifestSchema.parse(raw));
    }
    return out;
  }
}

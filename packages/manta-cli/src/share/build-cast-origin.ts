import { CastOriginSchema, type CastOrigin } from '@manta/skill-validator';
import { getMantaCliVersion } from '../library/cli-version.js';
import type { SanitizationWarning } from './types.js';

/**
 * Build the `castOrigin` lineage block for a shared bundle's manifest
 * (Phase 7b Task 2.2).
 *
 * Reads the originating cast manifest (`CastManifestSchema`) plus the resolved
 * winner and git remote, and maps the Phase 7c-frozen `metadata.trigger`
 * provenance fields 1:1 (wire snake_case → manifest camelCase). The mapping is
 * read DEFENSIVELY: `metadata?.trigger` is absent for user-fired casts and for
 * any pre-7c manifest, in which case `provenance` is `null`. This module does
 * NOT depend on Phase 7c landing first.
 *
 * Path-safety: `originalRepoOrigin` must be a URL. A local-path remote (e.g.
 * `git remote get-url origin` on a clone of a local repo) would leak an
 * absolute filesystem path, so a non-URL remote collapses to `null` + a
 * warning — the path NEVER reaches the output.
 */

/** A trigger block as it appears on a Phase 7c cast manifest (read-only). */
interface WireTrigger {
  trigger_name?: unknown;
  fired_at?: unknown;
  parent_cast_id?: unknown;
}

interface WireMetadata {
  trigger?: WireTrigger;
  cause_chain?: unknown;
}

export interface BuildCastOriginInput {
  /** Parsed `CastManifest` (read-only). Typed `unknown` because 7b reads the
   *  not-yet-landed 7c `metadata` block defensively off the raw object. */
  castManifest: unknown;
  winningCloneId: string;
  repoRoot: string;
  /** ISO second-precision UTC — injected for determinism/testability. */
  bundledAt: string;
  /** Resolved by the command via execa (`git remote get-url origin`); null if
   *  the repo has no `origin` remote. */
  gitRemoteOrigin: string | null;
}

function isHttpOrGitUrl(value: string): boolean {
  // Zod's `.url()` accepts `file://` and other schemes that still embed a
  // local path; the schema enforces `.url()`, but we additionally refuse
  // anything that is not an http(s)/ssh/git remote so a `file:///Users/...`
  // origin cannot smuggle a path past the URL check.
  try {
    const u = new URL(value);
    return ['http:', 'https:', 'ssh:', 'git:'].includes(u.protocol);
  } catch {
    return false;
  }
}

export function buildCastOrigin(
  input: BuildCastOriginInput,
): { castOrigin: CastOrigin; warnings: SanitizationWarning[] } {
  const warnings: SanitizationWarning[] = [];
  const cast = input.castManifest as {
    cast_id: string;
    mode: CastOrigin['castMode'];
    created_at: number;
    metadata?: WireMetadata;
  };

  // Provenance mapping (7c wire → manifest camelCase), read defensively.
  const trigger = cast.metadata?.trigger;
  let provenance: CastOrigin['provenance'] = null;
  if (trigger && typeof trigger === 'object' && typeof trigger.trigger_name === 'string') {
    const rawCauseChain = cast.metadata?.cause_chain;
    const causeChain = Array.isArray(rawCauseChain)
      ? rawCauseChain.filter((x): x is string => typeof x === 'string')
      : [];
    const firedAt = typeof trigger.fired_at === 'number' ? trigger.fired_at : cast.created_at;
    provenance = {
      triggerName: trigger.trigger_name,
      // Relativised offset from the cast's created_at (never a wallclock epoch).
      firedAtOffsetMs: firedAt - cast.created_at,
      parentCastId:
        typeof trigger.parent_cast_id === 'string' ? trigger.parent_cast_id : null,
      // FULL cause chain — the audit trail, NOT stripped.
      causeChain,
    };
  }

  // Path-safe git remote: URL → keep; non-URL (path) → null + warning.
  let originalRepoOrigin: string | null = null;
  if (input.gitRemoteOrigin !== null) {
    if (isHttpOrGitUrl(input.gitRemoteOrigin)) {
      originalRepoOrigin = input.gitRemoteOrigin;
    } else {
      warnings.push({
        rule: 'castOrigin.originalRepoOrigin',
        source: 'git remote get-url origin',
        message:
          'origin remote is a local path, not a URL; dropped to avoid leaking a filesystem path',
        severity: 'warning',
      });
    }
  }

  const castOrigin: CastOrigin = {
    castId: cast.cast_id,
    castMode: cast.mode,
    originalRepoOrigin,
    originalMantaVersion: getMantaCliVersion(),
    bundledAt: input.bundledAt,
    winningCloneId: input.winningCloneId,
    provenance,
  };

  // Fail-closed: the output must satisfy CastOriginSchema. A throw here means a
  // mapping bug shipped a malformed lineage block — better to refuse than to
  // emit an invalid manifest.
  return { castOrigin: CastOriginSchema.parse(castOrigin), warnings };
}

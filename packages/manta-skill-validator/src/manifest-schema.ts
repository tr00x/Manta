import { z } from 'zod';
import { CastOriginSchema } from './cast-origin-schema.js';

const NPM_BARE_NAME = /^[a-z][a-z0-9-]*$/;
const NPM_SCOPED_NAME = /^@[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const SEMVER_RANGE = /^(?:[\^~><=]{0,2}\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\s*-\s*\d+(?:\.\d+){0,2})?(?:\s+(?:[\^~><=]{0,2}\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?))*|\*)$/;

const SPDX_LICENSES = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MPL-2.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'Unlicense',
  'CC0-1.0',
] as const;

const BUILTIN_MODE_NAMES = [
  'recon-swarm',
  'forking-realities',
  'refactor-wave',
  'pair-programming',
  'test-storm',
  'documentation-chase',
  'bug-hunt',
] as const;

const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'PreCompact',
] as const;

const SESSION_MODES = ['batch', 'daemon'] as const;

const PackageNameSchema = z
  .string()
  .min(1)
  .max(214)
  .refine((v) => NPM_BARE_NAME.test(v) || NPM_SCOPED_NAME.test(v), {
    message: 'name must be a lowercase kebab npm name (bare or @scope/name)',
  });

const SemverSchema = z.string().regex(SEMVER, 'version must be semver MAJOR.MINOR.PATCH');

const SemverRangeSchema = z
  .string()
  .min(1)
  .refine((v) => SEMVER_RANGE.test(v.trim()), {
    message: 'must be a valid semver range',
  });

const UrlSchema = z.string().url();

const LicenseSchema = z.enum(SPDX_LICENSES);

const CloneCountSchema = z
  .object({
    min: z.number().int().min(1),
    max: z.number().int().min(1),
  })
  .strict()
  .refine((v) => v.min <= v.max, {
    message: 'cloneCount.min must be <= cloneCount.max',
    path: ['min'],
  });

const SkillContributionSchema = z
  .object({
    name: z.string().regex(NPM_BARE_NAME, 'skill name must be kebab-case'),
    description: z.string().min(10).max(280),
  })
  .strict();

const CommandContributionSchema = z
  .object({
    name: z.string().regex(/^manta:[a-z][a-z0-9-]*$/, 'command name must be `manta:<kebab>`'),
    description: z.string().min(10).max(280),
  })
  .strict();

const ModeContributionSchema = z
  .object({
    name: z.string().regex(NPM_BARE_NAME, 'mode name must be kebab-case'),
    description: z.string().min(10).max(280),
    basedOn: z.enum(BUILTIN_MODE_NAMES),
    cloneCount: CloneCountSchema,
    sessionMode: z.enum(SESSION_MODES),
    capabilityProfile: z.string().min(1).optional(),
    templates: z.array(z.string().min(1)).default([]),
  })
  .strict();

const TemplateContributionSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(10).max(280),
  })
  .strict();

const HookContributionSchema = z
  .object({
    event: z.enum(HOOK_EVENTS),
    script: z.string().min(1),
    requiresApproval: z.literal(true),
  })
  .strict();

const ContributesSchema = z
  .object({
    skills: z.array(SkillContributionSchema).default([]),
    commands: z.array(CommandContributionSchema).default([]),
    modes: z.array(ModeContributionSchema).default([]),
    templates: z.array(TemplateContributionSchema).default([]),
    hooks: z.array(HookContributionSchema).default([]),
  })
  .strict()
  .default({});

const IntegritySchema = z
  .object({
    contentHash: z.string().regex(/^sha256-[A-Za-z0-9+/=]+$/, 'contentHash must be sha256-<base64>'),
    publishedAt: z.string().datetime({ offset: false }),
  })
  .strict();

export const MantaPackageManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: PackageNameSchema,
    version: SemverSchema,
    description: z.string().min(10).max(280),
    author: z.string().min(1),
    license: LicenseSchema,
    homepage: UrlSchema.optional(),
    repository: UrlSchema.optional(),
    mantaVersionCompat: SemverRangeSchema,
    contributes: ContributesSchema,
    deps: z.record(SemverRangeSchema).default({}),
    integrity: IntegritySchema.optional(),
    // Phase 7b additive extension. OPTIONAL on the frozen 7a contract so the
    // install path (`validatePackage`) tolerates shared bundles (which carry
    // a populated `castOrigin`) AND pre-7b bundles (which omit it) through the
    // same schema. `null` is rejected (only absent or a valid CastOrigin) so
    // pre-7b bundles keep the field genuinely absent rather than present-null.
    castOrigin: CastOriginSchema.optional(),
  })
  .strict();

export type MantaPackageManifest = z.infer<typeof MantaPackageManifestSchema>;

/**
 * A *shared* bundle's manifest = the frozen flat 7a manifest + a REQUIRED
 * `castOrigin` block. Intersection, NOT a rewrite of `MantaPackageManifestSchema`
 * — the base schema stays back-compatible for the install path (where
 * `castOrigin` is optional), while a shared bundle must carry lineage.
 *
 * Lives here (not in `cast-origin-schema.ts`) to avoid a circular import:
 * the base schema already imports `CastOriginSchema`, so this file has both
 * halves of the intersection without a back-edge. Re-exported from the index.
 */
export const SharedBundleManifestSchema = MantaPackageManifestSchema.and(
  z.object({ castOrigin: CastOriginSchema }),
);

export type SharedBundleManifest = z.infer<typeof SharedBundleManifestSchema>;

export const LibraryModeJsonSchema = z
  .object({
    name: z.string().regex(NPM_BARE_NAME, 'mode name must be kebab-case'),
    description: z.string().min(10).max(280),
    basedOn: z.enum(BUILTIN_MODE_NAMES),
    cloneCount: CloneCountSchema,
    sessionMode: z.enum(SESSION_MODES),
    capabilityProfile: z.string().min(1).optional(),
    primingBlock: z.string().min(1).optional(),
  })
  .strict();

export type LibraryModeJson = z.infer<typeof LibraryModeJsonSchema>;

export const MANTA_LIBRARY_BUILTIN_MODES: readonly string[] = BUILTIN_MODE_NAMES;
export const MANTA_LIBRARY_HOOK_EVENTS: readonly string[] = HOOK_EVENTS;
export const MANTA_LIBRARY_SPDX_LICENSES: readonly string[] = SPDX_LICENSES;

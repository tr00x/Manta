import { z } from 'zod';

export const KEBAB_NAME = /^[a-z][a-z0-9-]*$/;

// `name` is the unique slug used to address a skill (`manta-as-clone`).
// `audience` distinguishes skills meant for the main agent vs. clones vs. shared system rules.
export const SkillFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(64).regex(KEBAB_NAME, 'name must be kebab-case'),
    description: z.string().min(10).max(280),
    audience: z.enum(['main', 'clone', 'system']),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver MAJOR.MINOR.PATCH'),
    related: z.array(z.string()).default([]),
  })
  .strict();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export const COMMAND_NAME = /^manta:[a-z][a-z0-9-]*$/;

export const SlashCommandFrontmatterSchema = z
  .object({
    name: z.string().regex(COMMAND_NAME, 'command name must be `manta:<kebab>`'),
    description: z.string().min(10).max(280),
    target: z.string().min(1),
    aliases: z.array(z.string()).default([]),
  })
  .strict();

export type SlashCommandFrontmatter = z.infer<typeof SlashCommandFrontmatterSchema>;

export const REQUIRED_SKILL_SECTIONS: ReadonlyArray<string> = ['Purpose', 'Allowed', 'Forbidden', 'Examples'];

export const REQUIRED_COMMAND_SECTIONS: ReadonlyArray<string> = ['Usage', 'Arguments', 'Behavior'];

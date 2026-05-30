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

// Claude Code plugin command frontmatter — the REAL format Claude Code discovers
// and `claude plugin validate` accepts (RB#3, 2026-05-30). Replaces the pre-plugin
// `target`/`aliases` descriptive shape: plugin commands are prompt bodies that shell
// out to the bundled bin via ${CLAUDE_PLUGIN_ROOT}, auto-namespaced to `/manta:*`.
export const SlashCommandFrontmatterSchema = z
  .object({
    name: z.string().regex(COMMAND_NAME, 'command name must be `manta:<kebab>`'),
    description: z.string().min(10).max(280),
    // `argument-hint` and `allowed-tools` are the Claude Code command fields.
    // allowed-tools may be a comma-string ("Bash, Read") or a YAML array.
    'argument-hint': z.string().optional(),
    'allowed-tools': z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict();

export type SlashCommandFrontmatter = z.infer<typeof SlashCommandFrontmatterSchema>;

export const REQUIRED_SKILL_SECTIONS: ReadonlyArray<string> = ['Purpose', 'Allowed', 'Forbidden', 'Examples'];

// Plugin command bodies are free-form prompts (instruction + a shell-out block),
// not structured docs — no headings are required. (Pre-plugin this was
// ['Usage', 'Arguments', 'Behavior']; the plugin format dropped them.)
export const REQUIRED_COMMAND_SECTIONS: ReadonlyArray<string> = [];

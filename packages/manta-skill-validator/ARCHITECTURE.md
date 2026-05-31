# @manta/skill-validator — Architecture

## Why this package exists

Skills and slash commands are content, not code. CI cannot run them; the test suite cannot exercise their behavior. The next-best gate is structural validation: every file declares its identity (frontmatter) and provides the same set of sections so a clone or main agent reading them can rely on a fixed shape. This package is that gate.

## Boundaries

- **In scope:** parse frontmatter via gray-matter; validate via zod; check required body sections; walk `skills/` and `commands/` discovering files; CLI bin that exits non-zero on any error.
- **Out of scope:**
  - Behavior validation / recorded fixtures
  - Plugin manifest / `plugin.json`
  - Hook validation (`hooks/` directory)

## Module map

| File | Responsibility |
|---|---|
| `errors.ts` | `ValidationError` + `ValidationIssue` shape |
| `schemas.ts` | Zod schemas for skill / command frontmatter; required-section constants |
| `parse.ts` | gray-matter wrapper + H2 heading extractor |
| `validate.ts` | Composes parse + schema + section check; returns `ValidationReport` |
| `walk.ts` | Discovers `skills/<name>/SKILL.md` and `commands/<name>.md`; emits `unsafe_path` warnings for hostile names |
| `bin/manta-validate-skills.ts` | CLI: `--root`, `--quiet`, exits non-zero on error |

## Design choices

- **gray-matter for parsing.** Battle-tested, handles edge cases (Windows line endings, escaped fences). Adding a parser of our own would be re-inventing.
- **Zod for frontmatter contracts.** Same pattern as `@manta/bus` / `@manta/snapshot`. Schemas live with their consumers; downstream tools (e.g. a plugin manifest generator) can re-import them.
- **No coupling to a fixed file list.** The validator runs against whatever it finds. Adding skills later requires zero validator changes — only new schema versions if the contract evolves.
- **Walk filters by safe names.** `[a-z][a-z0-9-]*` for directories, `[a-z][a-z0-9-]*\.md` for files. Anything else surfaces as an `unsafe_path` warning, never silently included.

## Test strategy

- **Unit per module** with focused fixtures embedded in tests.
- **Integration test** runs `validateAll(repoRoot)` against the actual Manta repo — proves the four Phase-0 skills and five Phase-0 commands are all present and clean.
- **Smoke** of `bin/manta-validate-skills` against an empty tmp dir to exercise the bin path.
- **Coverage** ≥ 80 %; `bin/**` excluded.

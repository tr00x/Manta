# @manta/skill-validator

Lints every skill (`skills/<name>/SKILL.md`) and slash-command (`commands/<name>.md`) file in the Manta repo against frontmatter + content schemas.

## Run

```
pnpm exec manta-validate-skills --root .
```

Exit code 0 if every file is valid, non-zero if any error issue exists.

## Schemas

### Skill frontmatter

| Field | Required | Validation |
|---|---|---|
| `name` | yes | kebab-case |
| `description` | yes | 10..280 chars |
| `audience` | yes | `main` / `clone` / `system` |
| `version` | yes | semver MAJOR.MINOR.PATCH |
| `related` | no | array of skill names |

### Skill body

Required H2 sections (in any order): `Purpose`, `Allowed`, `Forbidden`, `Examples`.

### Slash-command frontmatter

| Field | Required | Validation |
|---|---|---|
| `name` | yes | `manta:<kebab>` |
| `description` | yes | 10..280 chars |
| `target` | yes | non-empty |
| `aliases` | no | array of names |

### Slash-command body

Required H2 sections: `Usage`, `Arguments`, `Behavior`.

## Programmatic use

```typescript
import { validateAll } from '@manta/skill-validator';

const result = await validateAll('/path/to/repo');
if (!result.allOk) throw new Error(`${result.errorCount} error(s)`);
```

# Phase 0f — `recon-swarm` End-to-End Integration & Acceptance Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the Phase-0 stack — `@manta/snapshot` + `@manta/bus` + `@manta/orchestrator` + `@manta/cli` + `@manta/skill-validator` + the four skill files + the five slash commands — actually works end-to-end against a real `claude --print` binary. This is the Phase-0 acceptance gate. After this plan: a developer can clone the Manta repo, run `pnpm i && pnpm build && manta cast recon-swarm`, and watch real Claude Code instances produce a unified codebase map.

**Architecture:** No new TypeScript packages. This phase ships:
- A repo-root pnpm script (`pnpm e2e:recon-swarm`) that wires up `@manta/cli` to a real `claude` binary, runs the cast against a small fixture repo, and asserts the artifacts.
- A pnpm-workspace-level smoke test (`packages/manta-e2e/`) that runs the full pre-flight (`build` → `validator` → `cast` → `verify artifacts`) under vitest with `testTimeout: 30 minutes`. **Not included in default `pnpm test`** (gated by an env flag) to keep CI fast and to allow developers to run it on demand.
- Top-level `docs/user/getting-started.md` and `docs/user/recon-swarm.md` so the Phase-0 acceptance walkthrough is reproducible by a fresh contributor.
- An acceptance checklist (`docs/acceptance/phase-0.md`) the human signs off on before we declare Phase 0 shipped.

**Tech Stack:** TypeScript 5.x strict, vitest (long-timeout integration only), Node 20+, real `claude` CLI (the binary the user is reading this from). No new runtime deps.

**Non-goals for Phase 0f:**
- Running on CI by default — the e2e cast costs real money. Gated behind `MANTA_E2E=1` env var.
- Replacing the per-package unit / integration tests — those keep their <1-minute budget.
- Distribution as a Claude Code plugin (`npx manta@latest install`) — Phase 7.
- Multi-mode E2E — only `recon-swarm` is in scope. `forking-realities` E2E lands with Phase 2.
- Performance benchmarks / cost dashboards — Phase 11.0+ observability tier 4.

**Quality bar (CLAUDE.md / spec Sec 14):**
- The smoke test passes against a reference fixture repo (`tests/fixtures/sample-repo/`)
- All five Phase-0 packages build clean from a fresh `pnpm install`
- The skill validator reports zero errors and zero warnings
- The acceptance checklist is fully ticked by a human before merge of this plan's commit
- `docs/user/getting-started.md` walks a brand-new developer from `git clone` to a successful first cast

**Reference docs:**
- All five predecessor plans: `phase-0-foundation.md`, `phase-0b-bus.md`, `phase-0c-orchestrator.md`, `phase-0d-cli.md`, `phase-0e-skills-and-commands.md`
- Source-of-truth design: `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` — Sec 14 (Production Quality Standards), Sec 15 (Bootstrap Strategy — this is the Phase-0 → Phase-1 handoff)

---

## Chunks

1. **Chunk 1 — `@manta/e2e` smoke test + sample fixture** — package skeleton, sample fixture repo, env-gated smoke test that builds + validates + casts + verifies artifacts
2. **Chunk 2 — User docs + acceptance checklist + sign-off** — `docs/user/getting-started.md`, `docs/user/recon-swarm.md`, `docs/acceptance/phase-0.md`, top-level repo `README.md` updates, sign-off

---

## Chunk 1: `@manta/e2e` smoke test + sample fixture

**Goal of this chunk:** A single command (`MANTA_E2E=1 pnpm --filter @manta/e2e test`) runs the entire Phase-0 stack against a fixture repo and asserts the artifacts. The smoke test is its own package so its long-timeout vitest config doesn't pollute the per-package suites.

**Files (new):**
- Create: `packages/manta-e2e/package.json`
- Create: `packages/manta-e2e/tsconfig.json`
- Create: `packages/manta-e2e/vitest.config.ts`
- Create: `packages/manta-e2e/src/index.ts` (intentionally empty — package is tests-only)
- Create: `packages/manta-e2e/tests/fixtures/sample-repo/README.md`
- Create: `packages/manta-e2e/tests/fixtures/sample-repo/src/index.ts`
- Create: `packages/manta-e2e/tests/fixtures/sample-repo/src/auth.ts`
- Create: `packages/manta-e2e/tests/fixtures/sample-repo/src/billing.ts`
- Create: `packages/manta-e2e/tests/fixtures/sample-repo/src/logging.ts`
- Create: `packages/manta-e2e/tests/helpers/claudeBin.ts`
- Create: `packages/manta-e2e/tests/helpers/sampleRepo.ts`
- Create: `packages/manta-e2e/tests/preflight.test.ts`
- Create: `packages/manta-e2e/tests/recon-swarm.e2e.test.ts`
- Create: `packages/manta-e2e/README.md`
- Modify: root `tsconfig.json` — add `{ "path": "./packages/manta-e2e" }` to references
- Modify: root `package.json` — add `"e2e:recon-swarm": "MANTA_E2E=1 pnpm --filter @manta/e2e test"` script

**Why these boundaries:**
- A separate package keeps the long-timeout vitest config away from per-package suites.
- Sample fixture is checked in (small, ~5 files) so the smoke is reproducible. Larger benchmarks (Phase 11.0+) get their own fixture set.
- `claudeBin.ts` helper centralizes the "is `claude` available?" check so every test fails the same way (skip-if-missing) when run on a CI box without auth.
- `sampleRepo.ts` initialises a tmp git repo from the fixture content so each test gets a clean tree.

### Tasks

- [ ] **1.1: Verify Phase 0e shipped**

Run: `pnpm --filter @manta/skill-validator build && pnpm --filter @manta/skill-validator test`
Expected: both succeed.

- [ ] **1.2: Verify all five predecessor packages build clean**

Run: `pnpm -r build`
Expected: every package emits `dist/`. If any fails: STOP — Phase 0f gates on a green Phase-0 stack.

- [ ] **1.3: Verify the skill validator reports clean**

Run: `node packages/manta-skill-validator/dist/bin/manta-validate-skills.cjs --root .`
Expected: `9 file(s), 0 error(s), 0 warning(s)`; exit code 0.
If validator is unhappy: STOP and fix in the appropriate `phase-0e` step.

- [ ] **1.4: Create `packages/manta-e2e/package.json`**

```json
{
  "name": "@manta/e2e",
  "version": "0.0.0",
  "private": true,
  "description": "Manta end-to-end smoke tests — env-gated, runs real claude --print",
  "license": "MIT",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint \"src/**/*.ts\" \"tests/**/*.ts\"",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@manta/bus": "workspace:*",
    "@manta/cli": "workspace:*",
    "@manta/orchestrator": "workspace:*",
    "@manta/skill-validator": "workspace:*",
    "@manta/snapshot": "workspace:*",
    "execa": "^8.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **1.5: Create `packages/manta-e2e/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "references": [
    { "path": "../manta-bus" },
    { "path": "../manta-cli" },
    { "path": "../manta-orchestrator" },
    { "path": "../manta-skill-validator" },
    { "path": "../manta-snapshot" }
  ]
}
```

Note: `composite: true` is intentionally *omitted* — TypeScript rejects `composite + noEmit` (TS5069), and `@manta/e2e` is a tests-only leaf package that nothing else `references`, so it doesn't need to participate in project-references build. We can still `references` *into* the other packages so their declarations resolve, but we don't need to be referenced *by* anything.

- [ ] **1.6: Create `packages/manta-e2e/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    environment: 'node',
    // 30 minutes — recon-swarm with real claude can run ~20 min per clone × N clones serially
    // when we wait for completion. The fixture repo keeps it well under that.
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 60_000,
  },
});
```

- [ ] **1.7: Create `packages/manta-e2e/src/index.ts`**

Empty placeholder so the package can be referenced by tsconfig:

```typescript
export {};
```

- [ ] **1.8: (skip) Do NOT add `@manta/e2e` to root `tsconfig.json` references**

Because the package omits `composite: true` (see Task 1.5 note), it can't be a build-graph leaf for project references. Nothing else references it. Leave the root `tsconfig.json` untouched for this package.

- [ ] **1.9: Add the `e2e:recon-swarm` script to root `package.json`**

`Edit` root `package.json` `scripts` block to add:

```
"e2e:recon-swarm": "MANTA_E2E=1 pnpm --filter @manta/e2e test"
```

(Preserve existing scripts.)

- [ ] **1.10: Run `pnpm install`**

Run: `pnpm install`
Expected: lockfile updates; no resolution errors.

- [ ] **1.11: Create the sample fixture repo content**

Use `Write` for each file. The fixture is intentionally small but has cross-file imports so a recon-swarm has something interesting to map.

`packages/manta-e2e/tests/fixtures/sample-repo/README.md`:

```markdown
# sample-repo

Tiny fixture used by Manta's recon-swarm end-to-end smoke test. Three feature modules (`auth`, `billing`, `logging`) wired through a thin `index.ts`. Real enough to exercise cross-file mapping; small enough to fit in a single test budget.
```

`packages/manta-e2e/tests/fixtures/sample-repo/src/index.ts`:

```typescript
import { signIn } from './auth';
import { charge } from './billing';
import { log } from './logging';

export async function main(email: string, amountCents: number): Promise<void> {
  const user = await signIn(email);
  log('main', `signed in: ${user.id}`);
  await charge(user, amountCents);
  log('main', `charged ${amountCents} cents`);
}
```

`packages/manta-e2e/tests/fixtures/sample-repo/src/auth.ts`:

```typescript
import { log } from './logging';

export interface User { id: string; email: string }

export async function signIn(email: string): Promise<User> {
  log('auth', `signIn: ${email}`);
  return { id: `user-${email}`, email };
}
```

`packages/manta-e2e/tests/fixtures/sample-repo/src/billing.ts`:

```typescript
import type { User } from './auth';
import { log } from './logging';

export async function charge(user: User, amountCents: number): Promise<void> {
  if (amountCents <= 0) throw new Error('amount must be > 0');
  log('billing', `charge ${amountCents} for ${user.id}`);
}
```

`packages/manta-e2e/tests/fixtures/sample-repo/src/logging.ts`:

```typescript
export function log(scope: string, message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${scope}] ${message}`);
}
```

- [ ] **1.12: Write the `claudeBin` helper**

Create `packages/manta-e2e/tests/helpers/claudeBin.ts`:

```typescript
import { execa } from 'execa';

export interface ClaudeBinStatus {
  available: boolean;
  path?: string;
  version?: string;
  reason?: string;
}

/**
 * Probes whether a working `claude` binary is reachable. Used by the smoke test
 * to skip cleanly on machines where the binary isn't installed or authenticated.
 */
export async function probeClaudeBin(): Promise<ClaudeBinStatus> {
  if (process.env.MANTA_E2E !== '1') {
    return { available: false, reason: 'MANTA_E2E env var is not set to 1 (smoke is opt-in)' };
  }
  try {
    const r = await execa('claude', ['--version'], { reject: false, timeout: 10_000 });
    if (r.exitCode !== 0) {
      return { available: false, reason: `claude --version exited ${r.exitCode}: ${r.stderr || r.stdout}` };
    }
    return { available: true, path: 'claude', version: r.stdout.trim() };
  } catch (err) {
    return { available: false, reason: `claude not found on PATH: ${(err as Error).message}` };
  }
}
```

- [ ] **1.13: Write the `sampleRepo` helper**

Create `packages/manta-e2e/tests/helpers/sampleRepo.ts`:

```typescript
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const FIXTURE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'sample-repo',
);

export interface SampleRepoFixture {
  root: string;
  cleanup: () => Promise<void>;
}

export async function makeSampleRepo(): Promise<SampleRepoFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-e2e-sample-'));
  await copyDir(FIXTURE_ROOT, root);
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await execa('git', ['config', 'user.email', 'e2e@example.com'], { cwd: root });
  await execa('git', ['config', 'user.name', 'Manta E2E'], { cwd: root });
  await execa('git', ['add', '.'], { cwd: root });
  await execa('git', ['commit', '-q', '-m', 'sample fixture'], { cwd: root });
  await fs.mkdir(path.join(root, '.manta', 'state', 'contracts'), { recursive: true });
  return { root, cleanup: async () => fs.rm(root, { recursive: true, force: true }) };
}

async function copyDir(src: string, dst: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await fs.mkdir(d, { recursive: true });
      await copyDir(s, d);
    } else {
      await fs.copyFile(s, d);
    }
  }
}
```

- [ ] **1.14: Write the pre-flight smoke test**

Create `packages/manta-e2e/tests/preflight.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { validateAll } from '@manta/skill-validator';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('Phase-0 pre-flight (cheap, always runs)', () => {
  it('every workspace package builds clean', { timeout: 5 * 60 * 1000 }, async () => {
    const r = await execa('pnpm', ['-r', 'build'], { cwd: repoRoot, reject: false });
    expect(r.exitCode, r.stderr || r.stdout).toBe(0);
  });

  it('skill-validator finds 4 skills and 5 commands, zero errors', async () => {
    const result = await validateAll(repoRoot);
    expect(result.errorCount).toBe(0);
    const skills = result.reports.filter((r) => r.path.startsWith('skills/'));
    const commands = result.reports.filter((r) => r.path.startsWith('commands/'));
    expect(skills).toHaveLength(4);
    expect(commands).toHaveLength(5);
  });

  it('manta CLI is built and `manta status` runs cleanly on an empty tmp repo', { timeout: 5 * 60 * 1000 }, async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-preflight-'));
    try {
      const cli = path.join(repoRoot, 'packages/manta-cli/dist/bin/manta.cjs');
      const r = await execa('node', [cli, 'status'], { cwd: tmpDir, reject: false });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('No active clones');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **1.15: Run the pre-flight test**

Run: `pnpm --filter @manta/e2e test preflight.test.ts`
Expected: 3/3 passing. (Pre-flight is cheap; runs without `MANTA_E2E=1`.)

- [ ] **1.16: Write the recon-swarm e2e test**

Create `packages/manta-e2e/tests/recon-swarm.e2e.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { probeClaudeBin } from './helpers/claudeBin';
import { makeSampleRepo, type SampleRepoFixture } from './helpers/sampleRepo';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cliBin = path.join(repoRoot, 'packages/manta-cli/dist/bin/manta.cjs');

// NOTE: this suite proves the *harness* — that the spawn / bus / orchestrator /
// CLI / skills wiring carries a real `claude --print` clone through its full
// lifecycle and produces every expected on-disk artifact. It does NOT assert
// the *quality* of the answer the clone produced (e.g. that `docs/recon.md`
// usefully maps the codebase). Output-quality assessment is the human's job
// in `docs/acceptance/phase-0.md`.
describe('recon-swarm end-to-end against real claude', () => {
  let fx: SampleRepoFixture | undefined;
  let claude: Awaited<ReturnType<typeof probeClaudeBin>>;

  beforeAll(async () => {
    claude = await probeClaudeBin();
  });

  it('runs a 2-clone recon-swarm cast and produces post-mortems and ZK notes', async () => {
    if (!claude.available) {
      // eslint-disable-next-line no-console
      console.warn(`[recon-swarm.e2e] SKIPPED: ${claude.reason}`);
      return;
    }
    fx = await makeSampleRepo();
    const r = await execa(
      'node',
      [
        cliBin, 'cast', 'recon-swarm',
        '--clones', '2',
        '--task', 'Map every public export in src/. Produce a markdown summary as docs/recon.md.',
        '--cycle-interval-ms', '5000',
        '--tick-budget-ms', '1500000', // 25 min ceiling
        '--budget-per-clone-usd', '5',
      ],
      { cwd: fx.root, reject: false, timeout: 28 * 60 * 1000 },
    );

    // Surface stdout/stderr on failure for diagnosis
    if (r.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error('cast stdout:\n', r.stdout);
      // eslint-disable-next-line no-console
      console.error('cast stderr:\n', r.stderr);
    }
    expect(r.exitCode).toBe(0);

    // Both clones reached DEAD via the orchestrator. Use the public Registry API
    // (not raw JSON) so this assertion stays correct if the on-disk shape evolves.
    const { busPaths, Registry, systemClock } = await import('@manta/bus');
    const registry = new Registry(busPaths(fx.root), systemClock);
    const clones = await registry.list();
    expect(clones).toHaveLength(2);
    for (const c of clones) {
      expect(c.state).toBe('DEAD');
    }

    // Post-mortems on disk — at least 2 (orchestrator may write more if recover ran)
    const pmDir = path.join(fx.root, 'docs/post-mortems');
    const pmFiles = (await fs.readdir(pmDir)).filter((f) => f.endsWith('.md'));
    expect(pmFiles.length).toBeGreaterThanOrEqual(2);
    expect(pmFiles.some((f) => f.endsWith('-A.md'))).toBe(true);
    expect(pmFiles.some((f) => f.endsWith('-B.md'))).toBe(true);
    for (const f of pmFiles) {
      const body = await fs.readFile(path.join(pmDir, f), 'utf8');
      expect(body).toContain('# Post-mortem — clone');
      expect(body).toContain('## Event timeline');
    }

    // Each clone wrote at least one ZK note (1-3 per the manta-graceful-death skill)
    const zkDir = path.join(fx.root, 'docs/zk');
    const zkFiles = (await fs.readdir(zkDir)).filter((f) => f.endsWith('.md'));
    expect(zkFiles.length).toBeGreaterThanOrEqual(2);

    // Snapshots persisted under at least one cast directory
    const snapDirs = (await fs.readdir(path.join(fx.root, '.manta/snapshots')))
      .filter((d) => d.startsWith('cast-'));
    expect(snapDirs.length).toBeGreaterThanOrEqual(1);
    const snaps = await fs.readdir(path.join(fx.root, '.manta/snapshots', snapDirs[0]!));
    expect(snaps).toContain('A.snapshot.json');
    expect(snaps).toContain('B.snapshot.json');

    // Worktrees retained
    for (const id of ['A', 'B']) {
      const wt = path.join(fx.root, '.manta/worktrees', `clone-${id}`);
      await expect(fs.access(wt)).resolves.toBeUndefined();
    }
  }, 28 * 60 * 1000);
});
```

- [ ] **1.17: Run the e2e test (gated)**

Run on a developer box with a working, authenticated `claude` binary:
```
MANTA_E2E=1 pnpm --filter @manta/e2e test recon-swarm.e2e.test.ts
```
Expected outcome on a machine WITHOUT `claude`: the test logs SKIPPED and passes (defensive — we don't fail CI on missing auth).
Expected outcome on a machine WITH `claude`: 1/1 passing in ≤ 25 minutes; assertions match.

If the test fails: surface the cast stdout/stderr (already captured in the test on non-zero exit) and triage in the appropriate predecessor plan, not here. Do **not** patch this plan to "make the test pass" — that breaks the contract.

- [ ] **1.18: Write `packages/manta-e2e/README.md`**

Use `Write`:

````markdown
# @manta/e2e

End-to-end smoke tests for the Manta Phase-0 stack. Two suites:

## Pre-flight (always runs, ~2 minutes)

```
pnpm --filter @manta/e2e test preflight.test.ts
```

Asserts every workspace package builds, the skill validator is clean, and the CLI bin starts. Catches integration regressions without spending real money.

## Recon-swarm e2e (env-gated, ~25 minutes, costs money)

```
MANTA_E2E=1 pnpm --filter @manta/e2e test recon-swarm.e2e.test.ts
```

Spawns two real `claude --print` clones against a sample fixture repo, runs the orchestrator until both clones die cleanly, and verifies the artifacts (registry, post-mortems, ZK notes, snapshots, worktrees).

**Skipped automatically** when `MANTA_E2E` is unset OR when `claude --version` fails (no auth, not installed). Never silently passes — skipped runs print SKIPPED with the reason.

**Cost guard**: defaults to `--budget-per-clone-usd 5` and `--tick-budget-ms 1_500_000` (25 min). Override via env if you need to debug a longer-running scenario.
````

- [ ] **1.19: Commit Chunk 1**

```bash
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" add \
  packages/manta-e2e \
  package.json tsconfig.json pnpm-lock.yaml
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" commit -m "$(cat <<'EOF'
feat(e2e): add @manta/e2e — pre-flight + env-gated recon-swarm smoke

- preflight.test.ts (always runs): pnpm -r build, skill-validator clean,
  manta status on empty tmp repo
- recon-swarm.e2e.test.ts (gated by MANTA_E2E=1 + working `claude` binary):
  spawns 2 real clones against a sample fixture, asserts registry + post-
  mortems + ZK notes + snapshots + worktrees on disk
- Sample fixture repo (auth/billing/logging) checked in for reproducibility
- Cost guard: --budget-per-clone-usd 5, --tick-budget-ms 25min ceiling
- Root `pnpm e2e:recon-swarm` script

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 2: User docs + acceptance checklist + sign-off

**Goal of this chunk:** A fresh contributor can clone the repo and walk through Phase 0 from `git clone` to a successful first cast, using only `docs/user/getting-started.md`. The acceptance checklist documents what we have to verify before declaring Phase 0 shipped, and provides a sign-off line for the human.

**Files (new):**
- Create: `docs/user/getting-started.md`
- Create: `docs/user/recon-swarm.md`
- Create: `docs/acceptance/phase-0.md`
- Modify: top-level `README.md` — add a "Phase 0 — Try it" section pointing at `docs/user/getting-started.md`

### Tasks

- [ ] **2.1: Write `docs/user/getting-started.md`**

Use `Write`:

````markdown
# Manta — Getting Started (Phase 0)

> **Prerequisites:** Node ≥ 20, pnpm ≥ 9, git, an installed and authenticated `claude` CLI. macOS or Linux. Phase 0 ships only the `recon-swarm` mode.

## 1. Clone & install

```
git clone <manta-repo>
cd manta
pnpm install
pnpm -r build
```

Expected: every workspace package emits a `dist/`. If any package fails: read its build log; the predecessor plan's verification steps will tell you what's expected.

## 2. Register the Manta Bus as an MCP server

**This step is mandatory.** Real `claude --print` clones spawned by `manta cast` need to talk to `manta-bus` over MCP — without this registration every clone-side tool call fails at the transport layer and the cast times out silently.

```
claude mcp add manta-bus --command "node $(pwd)/packages/manta-bus/dist/bin/server.cjs"
```

Verify:

```
claude mcp list | grep manta-bus
```

Expected: at least one line containing `manta-bus`.

If you skip this, the CLI's pre-flight (`runCastCommand` calls `verifyMantaBusRegistered` before spawning) will fail with a friendly `spawn_failed` error pointing back at this step.

## 3. Validate skills

```
node packages/manta-skill-validator/dist/bin/manta-validate-skills.cjs --root .
```

Expected: `9 file(s), 0 error(s), 0 warning(s)`.

## 4. Run the pre-flight smoke

Cheap (~2 min), no API spend:

```
pnpm --filter @manta/e2e test preflight.test.ts
```

Expected: 3/3 passing.

## 5. Run a real recon-swarm cast

In a repo of your choice (or use the sample fixture in `packages/manta-e2e/tests/fixtures/sample-repo/`):

```
node packages/manta-cli/dist/bin/manta.cjs cast recon-swarm \
    --clones 2 \
    --task "Map every public export in src/" \
    --budget-per-clone-usd 5 \
    --budget-per-cast-usd 15
```

The CLI:
1. Creates `.manta/worktrees/clone-A` and `.manta/worktrees/clone-B`.
2. Writes per-clone snapshots to `.manta/snapshots/cast-<ts>/`.
3. Spawns two `claude --print` subprocesses, each pointing at its worktree.
4. Ticks the orchestrator while clones are alive.
5. When both clones exit (or after the 25-minute budget), prints `Cast cast-<ts> complete: 2 clone(s).`

## 6. Inspect outputs

- `docs/post-mortems/<date>-cast-<ts>-A.md` — what clone A did, the bus events it emitted, the reason it died.
- `docs/post-mortems/<date>-cast-<ts>-B.md` — same for clone B.
- `docs/zk/*.md` — atomic insights the clones wrote before dying.
- `docs/para/projects.md` — append-only fact log.
- `.manta/worktrees/clone-A/`, `clone-B/` — the actual worktrees, kept for inspection.

## 7. If something goes wrong

- `manta status` — current view of the bus.
- `manta recover` — runs one orchestrator cycle, reaping zombies.
- `manta abort` — mark every live clone DEAD with post-mortems.
- `manta kill <id>` — same for a single clone.

If a worktree won't go away or a lock is stuck, see `docs/manta-bugs.md` first; if it's not there, file it.

## 8. What's not in Phase 0

- Modes other than `recon-swarm` (forking-realities, refactor-wave, bug-hunt, …) — Phase 2+.
- The other 30+ slash commands (`/manta inspect`, `/manta tail`, `/manta promote`, …) — Phase 1+.
- Charges / cooldowns / fragility — Phase 3.
- Plugin distribution (`npx manta install`) — Phase 7.

See `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` for the full roadmap.
````

- [ ] **2.2: Write `docs/user/recon-swarm.md`**

Use `Write`:

````markdown
# `recon-swarm` — How it works

The `recon-swarm` mode batch-spawns N independent clones, each given a slice of the codebase via `taskContract.scope`, and each producing a structured artifact (a markdown map, a list of files, a per-feature summary). The clones do not talk to each other beyond filtered broadcasts; they don't merge. The main agent (you) reads the post-mortems and ZK notes and stitches the picture together.

## When to use it

Use the `manta-cast-decide` skill before casting. Recon-swarm is the right call when:
- The task reads >5 files spread across different layers.
- The work decomposes cleanly by directory or feature (each clone gets a sub-tree).
- You want a *map*, not a *change* — recon-swarm clones are recommended to run with `max_files_changed: 0` (read-only).

It's the **wrong** call for:
- Architectural alternatives (use `forking-realities` once Phase 2 ships).
- Same-pattern migrations (use `refactor-wave`).
- Tracking down a specific bug (use `bug-hunt`).

## Lifecycle of a clone in recon-swarm

1. **CLI spawn** — `manta cli` creates the worktree, builds a `Snapshot`, writes the `task_contract` to the bus, starts a `claude --print` subprocess pointing at the worktree.
2. **Register** — the spawner registered the clone *before* the process started, so on launch the clone reads its contract and acks via `manta.ack_contract`.
3. **Work** — read files within `scope.allowed_paths`, never write outside `forbidden_paths`, heartbeat every ≤ 10 s.
4. **Broadcast** — `breakthrough` / `blocker` / `dependency` only; bus traffic is for actionable events.
5. **Knowledge dump** — atomic `manta.zk_write` notes and `manta.para_append` facts before exit.
6. **Graceful death** — `manta.suicide_intent` then `manta.report_death`; exit 0.
7. **Orchestrator post-mortem** — markdown report under `docs/post-mortems/`.

If the clone exits without `report_death`, the orchestrator detects the stale heartbeat and writes the post-mortem itself with reason `heartbeat … ms ago > …`.

## Cost & time budget

- **Budget per clone**: default $5 in dollars (`--budget-per-clone-usd`).
- **Time per clone (TTL)**: hard ceiling 20 min via `taskContract.deadline_ms`; soft ceiling 25 min via the cast's `--tick-budget-ms`.
- **Charges / cooldowns**: not enforced in Phase 0. Watch your spend manually.

## Reading the output

Each clone leaves three artifact families:

| Artifact | Purpose | Where |
|---|---|---|
| Worktree branch | Optional file changes (Phase-0 typically read-only) | `.manta/worktrees/clone-<id>/` |
| Post-mortem | Lifecycle record + event timeline | `docs/post-mortems/` |
| ZK notes | Atomic insights | `docs/zk/` |

To stitch a unified map: read each post-mortem's "Event timeline" section to see what the clone explored, then read its ZK notes for distilled findings.
````

- [ ] **2.3: Write `docs/acceptance/phase-0.md`**

Use `Write`:

````markdown
# Phase 0 — Acceptance Checklist

Phase 0 is "shipped" when **every** box is ticked AND a human has signed off at the bottom. Cross-reference each item to the predecessor plan that owns it.

## Build & lint

- [ ] `pnpm install` from a clean clone succeeds
- [ ] `pnpm -r build` green for every package
- [ ] `pnpm -r lint` zero errors, zero warnings
- [ ] `pnpm -r typecheck` zero errors

## Per-package coverage gates (≥ 80 % on lines / functions / branches / statements)

Spec Sec 14.1 critical-path list:

- [ ] `@manta/snapshot` — `pnpm --filter @manta/snapshot test:coverage`
- [ ] `@manta/bus` — `pnpm --filter @manta/bus test:coverage`
- [ ] `@manta/orchestrator` — `pnpm --filter @manta/orchestrator test:coverage`
- [ ] `@manta/cli` — `pnpm --filter @manta/cli test:coverage`

Phase-0 additions (held to the same bar as a self-imposed quality discipline; not in spec Sec 14.1 list):

- [ ] `@manta/skill-validator` — `pnpm --filter @manta/skill-validator test:coverage`

## Skill / command validation

- [ ] `manta-validate-skills --root .` reports 9 files, 0 errors, 0 warnings
- [ ] All four Phase-0 skills present: `manta-as-clone`, `manta-coordinate`, `manta-graceful-death`, `manta-cast-decide`
- [ ] All five Phase-0 slash commands present: `cast`, `status`, `kill`, `abort`, `recover`

## Pre-flight smoke

- [ ] `pnpm --filter @manta/e2e test preflight.test.ts` green

## End-to-end (env-gated, real `claude`)

- [ ] On a developer machine with `claude` authenticated, `MANTA_E2E=1 pnpm e2e:recon-swarm` green within 25 minutes
- [ ] Both clones reached DEAD via the orchestrator
- [ ] Post-mortems on disk, parseable, contain Event-timeline sections
- [ ] ≥ 2 ZK notes written
- [ ] Snapshots persisted under `.manta/snapshots/cast-*/`
- [ ] Worktrees retained under `.manta/worktrees/clone-*/`
- [ ] Sample fixture's `docs/recon.md` (or equivalent task output) actually answers the task — **human review**

## Documentation

- [ ] `docs/user/getting-started.md` walks a new contributor from clone to first cast
- [ ] `docs/user/recon-swarm.md` describes the mode in user terms
- [ ] Every production package has a `README.md` AND an `ARCHITECTURE.md`: `@manta/snapshot`, `@manta/bus`, `@manta/orchestrator`, `@manta/cli`, `@manta/skill-validator`. `@manta/e2e` is tests-only and ships only `README.md`.
- [ ] `CHANGELOG.md` (top-level) records "Phase 0 — recon-swarm GA" with a date and a bullet list of what shipped
- [ ] `docs/manta-bugs.md` exists (bootstrap commit `50e7957` created it) and is current (any known issues from the e2e dogfood are logged)

## Operational

- [ ] `git log --oneline` shows atomic commits per chunk; no "fix later" / "WIP" commits in main
- [ ] Every commit authored by `Tim Hunt <tr00x@proton.me>` per CLAUDE.md
- [ ] No `// TODO: implement` strings anywhere outside ignored directories:
  ```
  rg -n "TODO: implement" --glob '!node_modules' --glob '!dist' --glob '!.git' --glob '!coverage' .
  ```
  (must return zero matches; this scope catches workspace-root configs / scripts that the per-directory variant misses)
- [ ] No mocks or feature flags in production code paths (spec Sec 14.4)

## Sign-off

```
Phase 0 acceptance signed off by: ________________________
Date (YYYY-MM-DD UTC): ________________________
e2e cast id (from successful run): ________________________
Cost of acceptance run ($): ________________________
Next action: open Phase 1 milestone in `docs/superpowers/plans/INDEX.md`.
```
````

- [ ] **2.4: Update top-level `README.md`**

`Edit` `README.md` (create if missing) so the top of the file includes a "Phase 0 — Try it" section. The exact insertion point depends on what's already there; if there's no README yet, create one with this content:

```markdown
# Manta

Self-cloning Claude Code pattern. Same system prompt, full transcript inheritance, parallel work without role specialization. See `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` for the full design.

## Phase 0 — Try it

```
git clone <manta-repo> && cd manta
pnpm install && pnpm -r build
node packages/manta-cli/dist/bin/manta.cjs cast recon-swarm --clones 2 --task "Map this codebase"
```

Full walkthrough: `docs/user/getting-started.md`. Acceptance checklist: `docs/acceptance/phase-0.md`.

## Status

- [x] Phase 0 — `recon-swarm` foundation (this commit)
- [ ] Phase 1 — `recon-swarm` production-grade lockdown
- [ ] Phase 2 — `forking-realities`
- [ ] Phase 3 — Charge system + budgets + cooldowns
- [ ] Phase 4 — Wave-1 closeout (`refactor-wave`, `bug-hunt`)
- [ ] Phase 5 — Daemon-mode runtime
- [ ] Phase 6 — Wave-2 modes
- [ ] Phase 7 — Manta Library + auto-cast triggers
- [ ] Phase 8 — Aghanim's-locked modes (`council`, `phantom-lance`, `decoy`)

## License

MIT — see `LICENSE`.
```

If a README already exists: read it first, then `Edit` to insert a "Phase 0 — Try it" section near the top without clobbering existing content.

- [ ] **2.4a: Author top-level `CHANGELOG.md`**

The acceptance checklist (Task 2.3) requires a CHANGELOG.md with a Phase-0 entry. Create it now using the Keep-a-Changelog format (per spec Sec 14.2 "Changelog discipline"):

```markdown
# Changelog

All notable changes to Manta. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — Phase 0 (recon-swarm foundation)

### Added

- `@manta/snapshot` — Zod-validated transcript + state serializer with explicit version migrations.
- `@manta/bus` — MCP server exposing the full Manta Bus API (18 tools across 6 families): lifecycle, contract, work-claim, file-locks, communication, memory.
- `@manta/orchestrator` — lifecycle policy: heartbeat / parent-PID death detection, stale-lock and expired-claim reaping, structured post-mortem authoring, idempotent `runCycle()`.
- `@manta/cli` — five Phase-0 commands: `cast`, `status`, `kill`, `abort`, `recover`. `recon-swarm` mode supported end-to-end.
- `@manta/skill-validator` — frontmatter + content validator gating skill / slash-command authoring.
- `@manta/e2e` — pre-flight smoke (always runs) + env-gated real-`claude` recon-swarm e2e.
- Four Phase-0 skill files (`manta-as-clone`, `manta-coordinate`, `manta-graceful-death`, `manta-cast-decide`) and five Phase-0 slash commands (`/manta cast / status / kill / abort / recover`).
- User docs: `docs/user/getting-started.md`, `docs/user/recon-swarm.md`. Per-package `README.md` + `ARCHITECTURE.md` for every production package.
- Acceptance checklist: `docs/acceptance/phase-0.md`.

### Phase-0 non-goals (deferred)

See the spec (`docs/superpowers/specs/2026-05-06-manta-pattern-design.md`) Sec 15.1 for the phase plan. Briefly: forking-realities (Phase 2), charges/cooldowns (Phase 3), Wave-1 closeout (Phase 4), daemon mode (Phase 5), Wave-2 modes (Phase 6), Library + auto-cast (Phase 7), Aghs-locked modes (Phase 8).
```

Use `Write` to create `CHANGELOG.md` at the repo root.

- [ ] **2.5: Verify the docs render as expected**

Run: `find docs -name '*.md' -newer docs/superpowers/plans/INDEX.md | head` to list newly added doc files.
Eyeball: each file is non-empty, parseable markdown, and links resolve relative to the repo root.

- [ ] **2.6: Final repo-wide sweep**

Run: `pnpm -r build && pnpm -r test && pnpm -r lint && pnpm -r typecheck && pnpm --filter @manta/e2e test preflight.test.ts`
Expected: every step green.

- [ ] **2.7: Commit Chunk 2**

```bash
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" add \
  docs/user docs/acceptance README.md CHANGELOG.md
git -c user.email="tr00x@proton.me" -c user.name="Tim Hunt" commit -m "$(cat <<'EOF'
docs(phase-0): user docs + acceptance checklist + CHANGELOG + README

- docs/user/getting-started.md: 8-step walkthrough from clone to first cast (incl. mandatory `claude mcp add manta-bus` step)
- docs/user/recon-swarm.md: how the mode works, when to use it, where to
  find the artifacts
- docs/acceptance/phase-0.md: checklist + human sign-off line for the
  Phase-0 GA gate
- CHANGELOG.md: 0.1.0 Phase-0 entry per Keep-a-Changelog
- README.md: top-level entry point + status table for the 8-phase roadmap

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Plan review checkpoint

After Chunk 2 commits:
1. Dispatch plan-document-reviewer with this plan + the design spec.
2. Apply any blocking feedback.
3. INDEX.md status flip is a user action.

## Phase 0 closeout

This plan ends Phase 0. The next step is `docs/acceptance/phase-0.md` — once a human signs off, declare Phase 0 shipped and open Phase 1 in `docs/superpowers/plans/INDEX.md`.

Phase 1 picks up:
- The `manta-bugs.md` log of issues found during the e2e dogfood
- Behavioral fixture tests for skills (deferred from Phase 0e)
- Hooks (PreToolUse capability enforcement)
- The remaining Sec-12 `recon-swarm`-relevant commands (`dry-run`, `inspect`, `tail`)

That's the bootstrap-by-Manta moment: from Phase 1 onward, the clones we just built start building Phase 1+ themselves.

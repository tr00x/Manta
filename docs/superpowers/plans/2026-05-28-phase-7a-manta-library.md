# Phase 7a — Manta Library: Install + Lockfile + ModeRegistry + Manifest

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `manta install`, `manta uninstall`, the `manta library …` observability subcommands, the on-disk lockfile (`manta-lock.json`), the global library store under `~/.manta/library/`, and the `ModeRegistry` seam that lets installed packages contribute new modes that `manta cast` can dispatch. Strictly scoped to install/registry plumbing — `/manta share` (Phase 7b) and `/manta trigger` (Phase 7c) are explicitly out of scope.

**Architecture:** All new state lives behind one new directory `packages/manta-cli/src/library/` (mode-registry, lockfile, local-store, registry-client) plus one new schema file in `packages/manta-skill-validator/`. The validator gains a single new exported function `validatePackage(packageRoot)` that calls existing `validateAll` plus the new `MantaPackageManifest` parser plus a `contributes` cross-check — no breaking changes to the validator's existing surface. `runCastCommand` swaps two call-sites from `SUPPORTED_MODES.has` to `modeRegistry.has`, and gains a one-call `verifyMantaVersionCompat` preflight before the registry lookup. Distribution is npm scope `@manta-library/*` primary + `git+https://` fallback. Custom registry, signing, sandboxing, hooks shipment, and author reputation are all explicitly Phase 8+ per clone-C MVTS-7 and clone-A research §7.

**Tech Stack:** TypeScript, Zod schemas, Vitest, `semver` npm dep (new — pinned to `^7.6.3`), `tar` npm dep (new — pinned to `^7.4.3`), shell-out to `npm pack` / `git clone --depth=1` via existing `execa`, atomic-fs helpers (`atomic-rename`/`atomic-write`) already used by `@manta/bus` state mutators.

**Research:** `docs/research/phase-7-manta-library.md` (clone-A, ground truth for this plan), `docs/research/phase-7-community-share-trust.md` (clone-C cross-reference for the `ModeRegistry` seam shape and the latent bug #18 fix scoped here).

**Out of scope (deferred):**

| Surface | Deferred to | Why |
|---|---|---|
| `manta share <cast-id>` bundling, sanitization pipeline (full snapshot/contract/timeline redaction enumeration) | Phase 7b | Larger surface; reuses the bug #18 sanitizer module (task 1.10) and the manifest schema (task 1.1) shipped here. |
| `manta trigger add/list <event> <action>` (auto-cast triggers) | Phase 7c | Independent of the install/registry surface; trigger taxonomy and watcher safety design is its own research (clone-B). |
| `hooks/` distribution inside library packages | Phase 8 | Clone-A research §7 open question 5; conservative recommendation to defer hook-shipping. Phase 7a manifest schema still allows declaration but the install command hard-refuses to copy any `hooks/` payload. |
| Code signing, author reputation, runtime sandbox | Phase 8+ | Clone-C MVTS-7 (e/f/g) — needs key registry / telemetry / VM sandbox infra none of which exists. |
| Custom HTTP registry + CDN | Phase 8+ | Build only when ≥100 published packages or after a supply-chain incident (clone-A §2.4). |
| `manta library search`, curated `manta-library/index` GitHub repo | Phase 8 | Clone-C §5 discovery layer — additive on top of npm scope; no Phase 7a dependency. |

---

## Chunk 1 — Shared foundation + happy-path install pipeline

This chunk lands the manifest schema, the registry seam, the lockfile, the global library store, the registry-client abstraction, the validator extension, the bug #18 sanitizer, the `manta install` command with a single happy-path code-path, and one user doc draft. After Chunk 1: `manta install ./local-package.tgz` succeeds end-to-end for a well-formed package, the lockfile is written, the installed mode shows up in `modeRegistry.list()`, and `manta cast <library-mode>` runs through the existing `basedOn` dispatcher branch.

**Build dependency chain:** Task 1.1 (manifest schema) + Task 1.10 (sanitizer) → workspace build → Task 1.2 / 1.3 / 1.4 / 1.5 / 1.6 (consumers of the schema; independent of each other) → Task 1.7 (install command — consumes all five) → Task 1.8 (cast.ts integration) → Task 1.9 (docs).

~700 LOC implementation estimated. Chunk 1 chunk-completes when every Task 1.x is green and `pnpm -r build && pnpm -r test && pnpm -r lint` is clean workspace-wide.

### Task 1.1: `MantaPackageManifest` Zod schema

**Files:**
- Create: `packages/manta-skill-validator/src/manifest-schema.ts`
- Create: `packages/manta-skill-validator/tests/manifest-schema.test.ts`
- Modify: `packages/manta-skill-validator/src/index.ts` — re-export `MantaPackageManifestSchema`, `LibraryModeJsonSchema`, and inferred types `MantaPackageManifest`, `LibraryModeJson`.

**Why:** The manifest is the only schema-validated artifact at install time; the install path's whole correctness story rests on this Zod parser. We put it in `@manta/skill-validator` (not in `@manta/cli`) because the validator package is the canonical home for parsing+validating plugin-shaped on-disk content, and the validator already owns `SkillFrontmatterSchema` / `SlashCommandFrontmatterSchema` (per `packages/manta-skill-validator/src/schemas.ts:7`, `:21`). Co-locating keeps one parser package, one set of tests, one set of error-message conventions.

**Schema (reuse verbatim from research §1.3):** Zod object with `schemaVersion: z.literal(1)`, `name` (npm-scoped or bare kebab regex), `version` (semver regex), `description` (10–280 chars), `author`, `license` (closed SPDX enum), `homepage` / `repository` optional URLs, `mantaVersionCompat` (semver range), `contributes` (`skills[]` / `commands[]` / `modes[]` with `name` / `description` / `basedOn` enum of the 7 built-in modes / `cloneCount.{min,max}` / `sessionMode` / `capabilityProfile?` / `templates[]` / `hooks[]` with `event` enum and hard-coded `requiresApproval: z.literal(true)`), `deps: z.record(z.string()).default({})`, optional `integrity` (`contentHash` `^sha256-…` + `publishedAt` ISO-8601). `.strict()` at top-level. **Also exports a second schema `LibraryModeJsonSchema`** — the per-mode `mode.json` payload referenced by `validatePackage` (Task 1.6) — fields `{ name, description, basedOn, cloneCount: {min,max}, sessionMode, capabilityProfile?, primingBlock?: string }`, `.strict()`. Inferred type `LibraryModeJson`.

**Acceptance criteria:**
- `MantaPackageManifest.parse(<valid manifest>)` returns the inferred type with `contributes.skills/commands/modes/templates/hooks` defaulted to `[]` when omitted.
- `MantaPackageManifest.parse(<missing schemaVersion>)` throws with path `["schemaVersion"]`.
- `MantaPackageManifest.parse(<schemaVersion: 2>)` throws (we want hard-fail on unknown manifest versions, per clone-C §1.3 design choice).
- `MantaPackageManifest.parse(<name: "Foo">)` throws (uppercase letters rejected).
- `MantaPackageManifest.parse(<version: "1.0">)` throws (semver requires three components).
- `MantaPackageManifest.parse(<license: "ProprietaryStuff">)` throws (enum mismatch).
- `MantaPackageManifest.parse(<hooks: [{event: "PreToolUse", script: "x.sh", requiresApproval: false}]>)` throws — `requiresApproval` is hard-coded `true` in the schema.
- Unknown top-level fields throw because of `.strict()`.
- `LibraryModeJsonSchema.parse(<valid mode.json>)` returns the inferred `LibraryModeJson` type.
- `LibraryModeJsonSchema.parse(<basedOn: "unknown-mode">)` throws.
- `LibraryModeJsonSchema.parse(<{name: "x", description: "x", basedOn: "recon-swarm", cloneCount: {min:1,max:1}, sessionMode: "batch", unknownField: 1}>)` throws because of `.strict()`.

**Tests (must achieve 100 % branch coverage of the new file):**

- [ ] **Step 1: Write failing tests** — one per acceptance criterion above, plus round-trip happy-path test that exercises a full populated manifest with all `contributes` arrays non-empty.

- [ ] **Step 2: Run tests — verify FAIL** (`cd packages/manta-skill-validator && pnpm vitest run tests/manifest-schema.test.ts`)

- [ ] **Step 3: Implement `manifest-schema.ts`** — paste research §1.3 schema verbatim (regex + enums + nested objects + `.strict()`). Export `MantaPackageManifestSchema` and `type MantaPackageManifest = z.infer<typeof MantaPackageManifestSchema>`.

- [ ] **Step 4: Re-export from validator package index** in `packages/manta-skill-validator/src/index.ts`.

- [ ] **Step 5: Run tests — verify PASS** + coverage check (`pnpm vitest run --coverage tests/manifest-schema.test.ts` should report 100 % statements + branches on the new file).

- [ ] **Step 6: Build workspace** — `pnpm -r build` clean. Downstream packages can now import `MantaPackageManifest` from `@manta/skill-validator`.

- [ ] **Step 7: Commit**

```
feat(skill-validator): MantaPackageManifest Zod schema for Phase 7a library packages
```

---

### Task 1.2: `ModeRegistry` extraction

**Files:**
- Create: `packages/manta-cli/src/library/mode-registry.ts`
- Create: `packages/manta-cli/tests/library/mode-registry.test.ts`
- Modify: `packages/manta-cli/src/index.ts` — re-export `ModeRegistry`

**Why:** `SUPPORTED_MODES` at `packages/manta-cli/src/commands/cast.ts:35` is a hardcoded `ReadonlySet<Mode>` of the seven built-in modes; `cast.ts:157` validates against it (line verified 2026-05-28; previous reviewer surfaced drift caused by the bug #19 fix that inserted `allocateCloneIds` above). Phase 7a needs a single seam that combines built-ins with library-installed modes — without that seam, the install command has nothing to register *into*. Clone-C §4.4 sketches a richer `ModeDefinition` (with `createDispatcher` / `primingBlock` / `invariants` callbacks); Phase 7a deliberately ships **only the minimum surface** needed by the install + cast integration. The richer factory-shaped registry is a follow-on chunk after Phase 7a proves the seam.

**Exported interface:**

```ts
// packages/manta-cli/src/library/mode-registry.ts
import type { Mode } from '@manta/snapshot';

export interface LibraryModeEntry {
  /** Library mode name, e.g. "mega-refactor" — must match manifest.contributes.modes[].name. */
  name: string;
  /** Built-in host dispatcher this library mode parameterises. */
  basedOn: Mode;
  /** Owning package: scoped or bare name from the manifest. */
  packageName: string;
  /** Pinned version from the lockfile entry. */
  packageVersion: string;
}

export interface ModeRegistrySnapshot {
  builtins: ReadonlySet<Mode>;
  library: ReadonlyMap<string, LibraryModeEntry>;
}

export class ModeRegistry {
  constructor(builtins: ReadonlySet<Mode>);
  /** Returns true for built-in modes (Mode literals) AND for library-mode names. */
  has(name: string): boolean;
  /** Resolve a library mode by name, or undefined for built-ins / unknowns. */
  resolveLibrary(name: string): LibraryModeEntry | undefined;
  /** Add a library mode. Throws ModeConflictError if name collides with a built-in OR with another already-registered library mode. */
  registerLibrary(entry: LibraryModeEntry): void;
  /** Remove a library mode (used by uninstall in Chunk 2). */
  unregisterLibrary(name: string): void;
  /** All registered names — built-ins ∪ library. Used by `manta library list` and by error messages that list available modes. */
  list(): { builtins: Mode[]; library: LibraryModeEntry[] };
  /** Snapshot for tests and for cast.ts to capture per-cast. */
  snapshot(): ModeRegistrySnapshot;
}

export class ModeConflictError extends Error {
  readonly code: 'mode_conflict_builtin' | 'mode_conflict_library';
  readonly conflictingName: string;
  readonly existingOwner?: string;  // package name for library-vs-library; undefined for builtin
}
```

**Built-in seed:** `ModeRegistry`'s constructor takes the existing `SUPPORTED_MODES` set from `cast.ts:35` (after Task 1.8 moves it). The factory helper `createDefaultModeRegistry()` (exported alongside the class) returns `new ModeRegistry(SUPPORTED_MODES)`. Cast.ts (Task 1.8) calls `createDefaultModeRegistry()` once at module load and then `registry.registerLibrary(...)` for each lockfile entry whose `basedOn` is satisfied by the built-ins.

**Acceptance criteria:**
- `registry.has('recon-swarm')` returns `true` (built-in).
- `registry.has('mega-refactor')` returns `false` before registration, `true` after `registerLibrary({ name: 'mega-refactor', basedOn: 'pair-programming', packageName: '@manta-library/refactor-megapack', packageVersion: '1.3.0' })`.
- `registry.registerLibrary({ name: 'recon-swarm', basedOn: 'recon-swarm', … })` throws `ModeConflictError` with `code: 'mode_conflict_builtin'`.
- Registering the same library name twice from the same package throws `ModeConflictError` with `code: 'mode_conflict_library'` and `existingOwner` populated.
- `registry.list().builtins.length === 7` after construction with the current built-in set.
- `registry.resolveLibrary('recon-swarm')` returns `undefined` even though `has('recon-swarm')` is `true` — `resolveLibrary` is for library entries only.
- `unregisterLibrary('mega-refactor')` after `registerLibrary` makes `has` return `false` again.

**Tests:**

- [ ] **Step 1: Write failing tests** — one per acceptance criterion. Use `recon-swarm` as the built-in in fixtures, `mega-refactor` as the library mode.

- [ ] **Step 2: Run tests — verify FAIL** (`cd packages/manta-cli && pnpm vitest run tests/library/mode-registry.test.ts`).

- [ ] **Step 3: Implement `mode-registry.ts`** with `Map<string, LibraryModeEntry>` storage; `ModeConflictError` extends `Error`, has discriminated `code`.

- [ ] **Step 4: Re-export from `@manta/cli` index.**

- [ ] **Step 5: Run tests — verify PASS.**

- [ ] **Step 6: Commit**

```
feat(cli): ModeRegistry seam to combine built-in modes with library-installed modes
```

---

### Task 1.3: Lockfile read/write — `manta-lock.json`

**Files:**
- Create: `packages/manta-cli/src/library/lockfile.ts`
- Create: `packages/manta-cli/tests/library/lockfile.test.ts`
- Modify: `packages/manta-cli/src/runtime.ts:36` — `Runtime` interface gains a `lockfile: LockfileStore` field; `createRuntime` constructs it.

**Why:** The lockfile is the single source of truth for which library packages a repo depends on. It lives at repo root, is committed to git, and is read by `manta cast` to know which modes are valid (Task 1.8) and at every cast to verify hash integrity (Chunk 2 task 2.4). Without a lockfile, the install command can't make its mutations reproducible across machines.

**Schema (per research §5.1 + Chunk 2 task 2.4 hash-pin prerequisite):** `schemaVersion: 1`, `mantaVersion: "<semver>"`, `generatedAt: "<ISO-8601>"`, `packages: Record<string, LockEntry>` where `LockEntry` has `version`, `resolved` (URL), `integrity` (`sha256-…` base64; the tarball hash captured at install time), `directoryDigest` (`sha256-…` base64; the canonical hash of the installed directory's content tree, computed by Task 1.7 step 10 — see below), `contributes: { modes, skills, commands, templates }`, `mantaVersionCompat: "<semver range>"`, `installedAt: "<ISO-8601>"`. Stable key order (alphabetical), two-space indent, trailing newline. JSON, not JSONC — `package-lock.json` style.

**Why `directoryDigest` is here in Chunk 1 (not retrofitted from Chunk 2):** Chunk 2 task 2.4 hash-pin verification needs to compare the on-disk directory's content tree against a known-good hash. Computing that hash *post-install* (Chunk 2) would mean writing back to the lockfile entry after Chunk 1's `install` already committed it — schema retrofit + race window. Per the reviewer must-fix, we ship `directoryDigest` in Chunk 1 lockfile schema and Task 1.7 computes it inline before lockfile write; Chunk 2 task 2.4 only reads + compares. **Computation:** sorted list of `<relative-path>:<sha256-of-content>` for every regular file in the install dir, joined by `\n`, then sha256 of that. Implementation helper lives in `packages/manta-cli/src/library/dir-digest.ts` (created in Task 1.4 alongside `LocalStore`; called from Task 1.7 step 10 and from Chunk 2 task 2.4).

**Exported interface:**

```ts
// packages/manta-cli/src/library/lockfile.ts
import type { z } from 'zod';

export const ManifestLockEntrySchema: z.ZodTypeAny;       // strict
export const LockfileSchema: z.ZodTypeAny;                // strict, top-level

export type LockfileEntry = z.infer<typeof ManifestLockEntrySchema>;
export type Lockfile = z.infer<typeof LockfileSchema>;

export interface LockfileStore {
  /** Repo-root path to manta-lock.json. */
  readonly path: string;
  /** Read+parse. Returns null when file does not exist (fresh repo). */
  read(): Promise<Lockfile | null>;
  /** Replace whole file atomically (tmp + rename). Caller is responsible for stable key ordering — `write` enforces it via canonicalize step. */
  write(lock: Lockfile): Promise<void>;
  /** Convenience: read, mutate via callback, write. Concurrent-safe through a per-process mutex. */
  mutate(fn: (current: Lockfile | null) => Promise<Lockfile> | Lockfile): Promise<Lockfile>;
}

export function createLockfileStore(opts: { repoRoot: string }): LockfileStore;
```

**Atomic-write pattern:** reuse the project-standard `atomicMutateJson` from `packages/manta-bus/src/atomic-fs.ts:81` — the same primitive `@manta/bus` uses for `registry.json` / `claims.json` / `casts.json`. It already provides cross-process safety via `proper-lockfile` (`packages/manta-bus/src/atomic-fs.ts:6`) — strictly stronger than a per-process mutex which only prevents same-process races. **Prerequisite (must land in this task):** widen `packages/manta-bus/src/index.ts` to re-export `atomicMutateJson` + `atomicReadJson` from `atomic-fs.ts` (currently they are not re-exported — verified 2026-05-28 by grep). Library lockfile + LocalStore (task 1.4) consume the re-exported helpers; no new lockfile library, no new mutex impl. **Rejected alternative — per-process mutex (e.g. `async-mutex`):** does NOT prevent two `manta install` shells from racing on the same `manta-lock.json` or on `~/.manta/library/index.json`. We pick `proper-lockfile` + tmp+rename precisely because Phase 7c auto-cast triggers may invoke `manta install` from a hook concurrently with a user-typed `manta install`.

**Acceptance criteria:**
- `await store.read()` on a fresh repo (no `manta-lock.json`) returns `null` — not throw.
- `await store.write(lock)` produces a file with deterministic byte content: alphabetically-sorted `packages` keys, two-space indent, trailing newline. Two writes of the same `Lockfile` produce byte-identical files.
- `await store.read()` after `write` returns the same structured object.
- `LockfileSchema.parse(<unknown extra field>)` throws — `.strict()`.
- Concurrent `mutate` calls (10 parallel `Promise.all`) all succeed; lockfile final state contains the union of mutations (no lost writes).
- Crash simulation: writing to a corrupted parent dir surfaces the OS error verbatim (no silent swallow).

**Tests:**

- [ ] **Step 1: Write failing tests** — `tmp` directory per test via `os.tmpdir()` + `mkdtemp`. Mutate-concurrency test uses `Promise.all` with 10 distinct package-name mutations.

- [ ] **Step 2: Run tests — verify FAIL** (`cd packages/manta-cli && pnpm vitest run tests/library/lockfile.test.ts`).

- [ ] **Step 3: Implement `lockfile.ts`** with `Zod` schemas, canonical JSON writer, atomic rename, per-process mutex.

- [ ] **Step 4: Wire into `Runtime` interface** at `packages/manta-cli/src/runtime.ts:36` — add `lockfile: LockfileStore`. Update `createRuntime` to construct `createLockfileStore({ repoRoot })`.

- [ ] **Step 5: Run tests — verify PASS.**

- [ ] **Step 6: Commit**

```
feat(cli): manta-lock.json read/write with atomic rename + per-process mutex
```

---

### Task 1.4: Global `LocalStore` — `~/.manta/library/`

**Files:**
- Create: `packages/manta-cli/src/library/local-store.ts`
- Create: `packages/manta-cli/tests/library/local-store.test.ts`
- Modify: `packages/manta-cli/src/runtime.ts` — `Runtime` gains `localStore: LocalStore` constructed from `~/.manta/library/`.

**Why:** Each repo's lockfile records *which* library packages are pinned, but the unpacked package payloads (skills, commands, mode definitions) live in the user-global `~/.manta/library/<scope>/<name>/<version>/`. Multi-version coexistence means two repos in the same user homedir can pin different versions of the same package without stepping on each other. The index file `~/.manta/library/index.json` is the global registry of *what is installed*; the lockfile is the per-repo *what we depend on*. `LocalStore` owns the global side.

**Layout:**

```
~/.manta/library/
├── index.json                                  ← global registry
├── .staging/                                   ← scratch dir for in-flight extractions
│   └── <random>/                               ← removed on success or failure
└── @manta-library/
    └── refactor-megapack/
        └── 1.3.0/
            ├── manta-package.json
            ├── README.md
            └── skills/...
```

**`index.json` schema (Zod, `.strict()`):**

```ts
{
  schemaVersion: 1,
  updatedAt: '<ISO-8601>',
  installs: [
    {
      packageName: '@manta-library/refactor-megapack',
      version: '1.3.0',
      path: '/Users/<u>/.manta/library/@manta-library/refactor-megapack/1.3.0',
      contributes: { modes: [...], skills: [...], commands: [...], templates: [...] },
      installedAt: '<ISO-8601>',
      integrity: 'sha256-<base64>',
    },
    ...
  ],
}
```

**Exported interface:**

```ts
// packages/manta-cli/src/library/local-store.ts
export interface StagedPackage {
  /** Absolute path to the staged (unpacked) directory under .staging/. */
  readonly stagingDir: string;
  /** Caller invokes commit() after validation passes; commit performs the atomic rename. */
  commit(): Promise<{ finalDir: string }>;
  /** Caller invokes discard() on any failure; discard removes the staging dir best-effort. */
  discard(): Promise<void>;
}

export interface LocalStore {
  /** Root path (~/.manta/library/). */
  readonly root: string;
  /** Stage an extracted tarball under .staging/<random>/ and return a handle. */
  stage(opts: { unpackedTarballDir: string }): Promise<StagedPackage>;
  /** Read the global install index. Returns empty index if file absent. */
  readIndex(): Promise<GlobalLibraryIndex>;
  /** Append-or-replace an install entry; atomic write. */
  upsertIndexEntry(entry: GlobalLibraryIndexEntry): Promise<void>;
  /** Remove an install entry by packageName+version. Atomic write. */
  removeIndexEntry(packageName: string, version: string): Promise<void>;
  /** Path where a package version lives (or would live) once committed. */
  pathFor(packageName: string, version: string): string;
  /** True if pathFor(packageName, version) exists on disk. */
  isInstalled(packageName: string, version: string): Promise<boolean>;
}

export function createLocalStore(opts: { homeDir?: string }): LocalStore;
```

**Atomic stage→commit→index pattern:**

1. `stage()`: `await mkdtemp(join(root, '.staging', 'pkg-'))`; copy the unpacked tarball contents into the staging dir. Return `StagedPackage` with the path.
2. Caller validates (Task 1.6) against the staging dir.
3. On validation pass: caller calls `commit()`. Internally: ensure parent dirs exist (`mkdir -p ~/.manta/library/<scope>/<name>/`); `rename(staging, finalDir)` — atomic when both paths are on the same filesystem (they are by construction; both under `~/.manta/library/`).
4. After successful `rename`, caller calls `upsertIndexEntry(...)` to update `index.json`.
5. If step 3 collides with an existing dir (same name+version installed), `commit()` rejects with `LocalStoreError('collision', { packageName, version })`. Caller decides — happy path is to call `discard()` and surface to user; `--force` flag (Chunk 2) overrides by `rm -rf finalDir` first.

**Acceptance criteria:**
- Two parallel `stage()` calls return distinct `stagingDir` paths.
- `commit()` on a non-colliding stage moves the directory and removes the staging slot.
- `commit()` on a collision rejects without touching the existing install.
- `discard()` after `stage()` removes the staging dir.
- `discard()` is idempotent — calling twice is safe.
- `readIndex()` on a fresh `~/.manta/library/` returns `{ schemaVersion: 1, updatedAt: <now>, installs: [] }`.
- `upsertIndexEntry` followed by `readIndex` returns the entry, with `updatedAt` refreshed.
- `removeIndexEntry` of an unknown entry is a no-op (does not throw).
- All writes survive a simulated crash (write to tmp, kill before rename → next read sees old content; not partial).

**Tests:**

- [ ] **Step 1: Write failing tests** under a per-test `os.tmpdir()` fake home directory passed via `createLocalStore({ homeDir: tmp })`.

- [ ] **Step 2: Run tests — verify FAIL** (`cd packages/manta-cli && pnpm vitest run tests/library/local-store.test.ts`).

- [ ] **Step 3: Implement `local-store.ts`** with `node:fs/promises` (`mkdtemp`, `rename`, `rm`, `cp` for staging copy from external tarball-extract dir, `readFile`/`writeFile`). Reuse atomic-write helper from Task 1.3 for `index.json`.

- [ ] **Step 4: Wire into `Runtime`.**

- [ ] **Step 5: Run tests — verify PASS.**

- [ ] **Step 6: Commit**

```
feat(cli): LocalStore for ~/.manta/library global install layout with atomic stage→commit
```

---

### Task 1.5: Registry client abstraction — `NpmClient` + `GitClient`

**Files:**
- Create: `packages/manta-cli/src/library/registry-client.ts`
- Create: `packages/manta-cli/tests/library/registry-client.test.ts`
- Modify: `packages/manta-cli/package.json` — add `semver: ^7.6.3` and `tar: ^7.4.3` deps

**Why:** The install command resolves a user-typed spec (`@manta-library/foo@^1.0`, `git+https://github.com/u/r#tag`, `./local.tgz`) to a fetchable artifact. We need a small abstraction with two impls (npm, git) plus a `LocalTarball` shortcut for `./*.tgz` inputs. The seam is injectable so tests can pass a fake (`NetworkRunner` pattern) rather than shell out.

**Exported interface:**

```ts
// packages/manta-cli/src/library/registry-client.ts

export interface ResolvedPackage {
  /** Original spec the user typed. */
  spec: string;
  /** Parsed kind. */
  kind: 'npm' | 'git' | 'local-tgz';
  /** Resolved canonical name (from manifest, post-fetch). */
  name: string;
  /** Resolved exact version. */
  version: string;
  /** Resolved URL or filesystem path for lockfile.resolved. */
  resolved: string;
  /** Path to the on-disk tarball (always .tgz). For git inputs the GitClient packs to tgz first. */
  tarballPath: string;
  /** sha256 hex of the tarball content (NOT base64 — base64 conversion happens in install when forming lockfile.integrity). */
  contentSha256Hex: string;
}

export interface NetworkRunner {
  /** Equivalent of `npm pack <spec>` writing the tgz under `cwd`. Returns the tarball filename. */
  npmPack(spec: string, opts: { cwd: string }): Promise<string>;
  /** Equivalent of `git clone --depth=1 --branch <ref?> <url> <dest>`. */
  gitClone(opts: { url: string; ref?: string; dest: string }): Promise<void>;
}

export interface RegistryClient {
  parseSpec(spec: string): { kind: 'npm' | 'git' | 'local-tgz'; npmName?: string; npmRange?: string; gitUrl?: string; gitRef?: string; localPath?: string };
  resolve(spec: string, opts: { workDir: string }): Promise<ResolvedPackage>;
}

export function createRegistryClient(opts: { runner: NetworkRunner }): RegistryClient;
export function createDefaultNetworkRunner(): NetworkRunner;
```

**`parseSpec` semantics:**
- `^@manta-library\/[a-z][a-z0-9-]*(@.+)?$` → npm scoped.
- `^[a-z][a-z0-9-]*(@.+)?$` → npm bare.
- `^git\+(https?|ssh):\/\/.+$` → git (parse `#<ref>` off the end if present).
- `^(\.\/|\/).+\.tgz$` → local tarball.
- Anything else → throw `RegistryClientError('unrecognized_spec', { spec })`.

**`resolve` for npm:** `await runner.npmPack(parsed.spec, { cwd: workDir })` → tarball filename → read the tgz, extract `manta-package.json` (the manifest authoritative for `.name` and `.version`), compute sha256 of the tarball bytes. The npm registry URL for `lockfile.resolved` is derived from `npm pack --json` metadata (npm's standard output includes a `filename` and we reconstruct `https://registry.npmjs.org/<name>/-/<filename>`).

**`resolve` for git:** `await runner.gitClone({ url, ref, dest: join(workDir, 'src') })`; pack the directory with `tar` npm package (or shell `tar -czf` via execa) to `<workDir>/<name>-<version>.tgz`. Read manifest from the cloned dir for `.name`+`.version`. Compute sha256.

**`resolve` for local-tgz:** just `cp`/symlink, compute sha256, peek inside the tgz to read `manta-package.json` without unpacking the whole thing (use `tar.list` from the `tar` npm dep with an entry filter).

**Acceptance criteria:**
- `parseSpec('@manta-library/foo@^1.0')` returns `{ kind: 'npm', npmName: '@manta-library/foo', npmRange: '^1.0' }`.
- `parseSpec('git+https://github.com/u/r#v1.2.3')` returns `{ kind: 'git', gitUrl: 'https://github.com/u/r', gitRef: 'v1.2.3' }`.
- `parseSpec('./pkg.tgz')` returns `{ kind: 'local-tgz', localPath: './pkg.tgz' }`.
- `parseSpec('not a package')` throws.
- `resolve('./fixture.tgz', { workDir })` with the test fixture `tests/fixtures/library/sample-package.tgz` returns a `ResolvedPackage` with the fixture's manifest name+version, a `contentSha256Hex` matching `sha256sum` of the fixture, and `tarballPath` pointing to a copy under `workDir`.
- `resolve` with a fake `NetworkRunner` that produces a known-byte-content tarball for `'npm'` kind returns the expected sha256.
- `resolve` of a git URL via a fake runner that materialises a known directory produces a tarball whose sha256 is reproducible across two consecutive calls (deterministic tar packaging — use `portable: true` mode and a fixed mtime if needed; document this in the test).

**Tests:**

- [ ] **Step 1: Create fixture** `packages/manta-cli/tests/fixtures/library/sample-package/` containing a minimal valid Phase-7 package (manta-package.json + one skill + one mode). Pack to `sample-package.tgz` via a one-shot `pnpm tsx tests/fixtures/library/build-sample.ts` script (also created); the script is run during fixture setup, not at test time.

- [ ] **Step 2: Write failing tests** for `parseSpec` (table-driven), then for `resolve` with `kind: 'local-tgz'` against the fixture, then for npm and git with a fake `NetworkRunner` returning canned bytes.

- [ ] **Step 3: Run tests — verify FAIL** (`cd packages/manta-cli && pnpm vitest run tests/library/registry-client.test.ts`).

- [ ] **Step 4: Implement `registry-client.ts`.** Add `semver` and `tar` to `package.json` dependencies and run `pnpm install` at the workspace root.

- [ ] **Step 5: Run tests — verify PASS.**

- [ ] **Step 6: Commit**

```
feat(cli): RegistryClient with NpmClient/GitClient/LocalTarball resolution paths
```

---

### Task 1.6: `validatePackage` extension to `@manta/skill-validator`

**Files:**
- Modify: `packages/manta-skill-validator/src/walk.ts` — add `validatePackage(packageRoot)` exported function.
- Create: `packages/manta-skill-validator/tests/validate-package.test.ts`
- Modify: `packages/manta-skill-validator/src/index.ts` — re-export `validatePackage`.

**Why:** The install pipeline reaches the staging dir and must answer "is this a well-formed Manta package?" in one call. The existing `validateAll(repoRoot)` (`packages/manta-skill-validator/src/walk.ts:74` per research §6.3) already validates `<root>/skills/` + `<root>/commands/` content; we wrap it with manifest parsing + a `contributes` cross-check. No breaking change to existing exports; pure addition.

**Surgical change:** add the following function at the end of `walk.ts` (no changes to `walkSkillsAndCommands` or `validateAll`):

```ts
// (new in packages/manta-skill-validator/src/walk.ts)
import { MantaPackageManifestSchema, type MantaPackageManifest } from './manifest-schema.js';

export interface ValidatePackageResult {
  manifest: MantaPackageManifest;
  validationReport: ValidationReport[];   // existing type from validateAll
  contributesCrossCheck: { ok: true } | { ok: false; issues: string[] };
  fatal: boolean;                          // true if anything in here would block install
}

export async function validatePackage(packageRoot: string): Promise<ValidatePackageResult>;
```

**`validatePackage` algorithm:**
1. Read `<packageRoot>/manta-package.json`. Parse via `MantaPackageManifestSchema`. Any Zod error → `fatal: true` with synthetic `ValidationReport` containing the error path.
2. Run `validateAll(packageRoot)` (existing). Collect `ValidationReport[]`. `fatal: true` if any report has severity `error`.
3. Cross-check: for every entry in `manifest.contributes.skills`, ensure the corresponding `<packageRoot>/skills/<name>/SKILL.md` exists AND was discovered by `walkSkillsAndCommands`. Conversely, every `walkSkillsAndCommands`-discovered skill must be listed in `manifest.contributes.skills`. Same for `contributes.commands`. Mismatches → `contributesCrossCheck: { ok: false, issues: […] }`, `fatal: true`. (This is the defence-in-depth rule from research §1.3 — packages cannot ship "drive-by" skills not declared in the manifest.)
4. For each `manifest.contributes.modes`, verify `<packageRoot>/modes/<name>/mode.json` exists and parses against `LibraryModeJsonSchema` — see Task 1.1 acceptance criterion "exports `LibraryModeJsonSchema`" (added per reviewer must-fix; forward-reference was undefined in the original draft).
5. For each `manifest.contributes.templates`, verify the file exists under `<packageRoot>/templates/`.
6. Hooks (`manifest.contributes.hooks`): existence check only. `validatePackage` does **not** decide whether to install hooks — that's the install command's responsibility (Chunk 2 task 2.1, where `--no-hooks` defaults to hard-refuse).

**Acceptance criteria:**
- Sample fixture from Task 1.5 (`tests/fixtures/library/sample-package`) passes validation with `fatal: false`.
- Removing `manta-package.json` from a copy of the fixture produces `fatal: true` with a clear "manifest not found" report.
- Adding an undeclared skill (`skills/sneaky/SKILL.md` not in `contributes.skills`) produces `fatal: true` with `contributesCrossCheck.ok === false`.
- Declaring a skill in `contributes.skills` that does not exist on disk produces `fatal: true`.
- Hook listed in `manifest.contributes.hooks` whose script file is missing produces `fatal: true`.

**Tests:**

- [ ] **Step 1: Set up fixture variants** under `packages/manta-skill-validator/tests/fixtures/packages/` — `good/`, `missing-manifest/`, `drive-by-skill/`, `dangling-skill/`, `missing-hook-script/`.

- [ ] **Step 2: Write failing tests** — one per variant.

- [ ] **Step 3: Run tests — verify FAIL** (`cd packages/manta-skill-validator && pnpm vitest run tests/validate-package.test.ts`).

- [ ] **Step 4: Implement `validatePackage` in `walk.ts`.**

- [ ] **Step 5: Re-export from validator index.**

- [ ] **Step 6: Run tests — verify PASS.**

- [ ] **Step 7: Commit**

```
feat(skill-validator): validatePackage cross-checks manifest contributes against disk
```

---

### Task 1.7: `manta install` command — happy path only

**Files:**
- Create: `packages/manta-cli/src/commands/install.ts`
- Create: `packages/manta-cli/tests/commands/install.test.ts`
- Modify: `packages/manta-cli/src/bin/manta.ts:375` — register `.command('install <spec>')` adjacent to existing commands (between `feedback` registration and `await program.parseAsync(process.argv)` per research §6.1).
- Modify: `packages/manta-cli/src/index.ts:12` — re-export `runInstallCommand` next to `runCastCommand`.
- **Modify (prerequisite — schema-first per CLAUDE.md HARD RULE):** `packages/manta-cli/src/errors.ts` — widen `CliErrorKind` union by adding these new kinds before any install code references them: `'install_spec_parse_failed'`, `'install_network_failed'`, `'install_manifest_invalid'`, `'install_validation_failed'`, `'install_compat_unmet'`, `'install_already_installed'`. This widening is Task 1.7 Step 0 — must land before Step 1 tests reference these kinds. Same pattern as bug #19 fix that added `'concurrent_cast_limit_reached'`. Failure to widen first = the CLAUDE.md `bug #13` class re-surfaces.

**Why:** This task glues 1.1–1.6 into a single command. **Chunk 1 ships only the happy path** — no `--force`, no `--offline`, no `--dry-run`, no `--integrity` pin. The flag completeness work moves to Chunk 2 task 2.1. The point of separating the chunks is that Chunk 1 is a single linear code-path easy to review and easy to test end-to-end with one fixture; Chunk 2 adds the policy knobs without re-litigating the happy path.

**Exported interface:**

```ts
// packages/manta-cli/src/commands/install.ts
export interface RunInstallCommandOptions {
  spec: string;                          // positional arg
  noValidate?: false;                    // Chunk 1 hard-codes false; flag plumbed in Chunk 2
  noHooks?: true;                        // Chunk 1 hard-codes true (hooks deferred to Phase 8); flag plumbed in Chunk 2
  force?: false;                         // Chunk 2
  offline?: false;                       // Chunk 2
  integrity?: undefined;                 // Chunk 2
  json?: false;                          // Chunk 2
  dryRun?: false;                        // Chunk 2
}

export interface RunInstallCommandResult {
  packageName: string;
  version: string;
  installedPath: string;
  contributedModes: string[];
  contributedSkills: number;
  contributedCommands: number;
  contributedTemplates: number;
}

export async function runInstallCommand(
  runtime: Runtime,
  opts: RunInstallCommandOptions,
): Promise<RunInstallCommandResult>;
```

**Happy-path pipeline (per research §3.1):**
1. Make `workDir = await mkdtemp(os.tmpdir() + '/manta-install-')`.
2. `resolved = await registryClient.resolve(opts.spec, { workDir })`.
3. Extract `resolved.tarballPath` to `workDir/unpacked/` via `tar.x({ file: resolved.tarballPath, cwd: workDir + '/unpacked', strict: true, filter: (p) => !p.startsWith('/') && !p.includes('..') && !path.isAbsolute(p) })` — zip-slip / tar-bomb guard per reviewer advisory. Reject paths containing `..` or starting with `/` before extraction.
4. Pre-flight compat check: read `<unpacked>/manta-package.json` minimally (just `mantaVersionCompat`), call `verifyMantaVersionCompat(manifest.mantaVersionCompat, getMantaCliVersion())`. Fail fast on mismatch with exit code 16 + the friendly multi-recovery-option message from research §5.2 (paraphrased here, full message body in the `compat-error-message.ts` helper).
5. `staged = await localStore.stage({ unpackedTarballDir: workDir + '/unpacked' })`.
6. `result = await validatePackage(staged.stagingDir)`. If `result.fatal` → `await staged.discard()` + throw `InstallError('library_validation_failed', { reports: result.validationReport, crossCheck: result.contributesCrossCheck })` → exit 14.
7. Collision check: `await localStore.isInstalled(packageName, version)` → if true, `await staged.discard()` and throw `InstallError('already_installed', { … })` → exit 15. (`--force` override comes in Chunk 2.)
8. Hooks gate (Chunk 1 hardcodes `noHooks = true`): if `manifest.contributes.hooks.length > 0`, log a one-line warning "Package <name> declares hooks; hooks distribution is deferred to Phase 8. Continuing install without hooks." Do **not** prompt, do **not** copy. (Chunk 2 task 2.1 wires the flag formally; the behaviour stays hard-refuse.)
9. `committed = await staged.commit()` → returns the final dir under `~/.manta/library/<scope>/<name>/<version>/`.
10. Compute two hashes: (a) `integrity = 'sha256-' + base64(resolved.contentSha256Hex)` — base64-encoded SHA-256 of the resolved tarball (npm-compatible form); (b) `directoryDigest = await computeDirDigest(committed.finalDir)` — canonical content-tree hash for Chunk 2 task 2.4 hash-pin verification. Both go into the lockfile entry in step 12.
11. `await localStore.upsertIndexEntry({ packageName: manifest.name, version: manifest.version, path: committed.finalDir, contributes: { … }, installedAt: <now>, integrity })`.
12. `await runtime.lockfile.mutate(current => addEntry(current, manifest, resolved, integrity, directoryDigest))`.
13. Clean up `workDir` (best-effort `rm -rf`).
14. Build `RunInstallCommandResult`, log the summary line per research §3.1 step 10, return.

**Error paths (Chunk 1 scope — install command surfaces these; full error matrix at research §3.3 ships in Chunk 2 task 2.1):**

| Failure | Exit code | Message |
|---|---|---|
| Spec parse | 11 | `[manta] install: cannot parse spec <spec>` |
| Network / npm pack failure | 11 | `[manta] install: cannot reach registry (cause: <err>)` |
| manifest invalid (Zod) | 14 | `[manta] install: invalid manta-package.json: <zod path>` |
| validatePackage `fatal` | 14 | structured per-file report |
| compat unmet | 16 | full multi-option message from research §5.2 |
| collision | 15 | `[manta] install: <name>@<version> already installed` |

**Acceptance criteria:**
- `await runInstallCommand(runtime, { spec: './tests/fixtures/library/sample-package.tgz' })` succeeds, creates the install dir under the fake `~/.manta/library/`, writes `index.json` entry, writes `manta-lock.json` entry.
- Lockfile entry has `integrity: 'sha256-<base64>'` matching the tarball's actual hash.
- Re-installing the same fixture returns `InstallError('already_installed')` and leaves the on-disk state unchanged.
- Installing a fixture whose manifest declares `mantaVersionCompat: '>=99.0.0'` against the test fake CLI version `0.7.2` fails with exit code 16 and prints the upgrade/downgrade/uninstall recovery list.
- Installing a fixture with an undeclared skill (`drive-by-skill` variant) fails with exit code 14 and surfaces the validator report.
- `runtime.localStore.readIndex()` after install contains exactly one entry; the entry's `path` exists on disk and contains `manta-package.json`.

**Tests:**

- [ ] **Step 0 (prerequisite — schema-first): Widen `CliErrorKind` union** at `packages/manta-cli/src/errors.ts` with the six new kinds listed in the Files block above. No test for this step — it's a one-line schema change verified by the test-compile in Step 1. Per CLAUDE.md "Schema-first, then text" HARD RULE.

- [ ] **Step 1: Write integration test** that constructs a `Runtime` with `lockfile` pointing at a per-test repo root tmp dir and `localStore` pointing at a per-test fake home dir. Use the sample-package fixture from Task 1.5.

- [ ] **Step 2: Write the per-error-path tests** (collision, compat, validator-fail) using fixture variants.

- [ ] **Step 3: Run tests — verify FAIL** (`cd packages/manta-cli && pnpm vitest run tests/commands/install.test.ts`).

- [ ] **Step 4: Implement `install.ts`** per the pipeline above. The `compat-error-message.ts` helper lives next to `install.ts` and is unit-tested directly.

- [ ] **Step 5: Register in `bin/manta.ts`** between `feedback` and `parseAsync` (per research §6.1). The commander block:

```ts
program
  .command('install <spec>')
  .description('Install a Manta Library package (npm spec, git URL, or local .tgz)')
  .action(async (spec: string, _opts, cmd) => {
    await runWithRuntime(cmd, async (runtime) => {
      await runInstallCommand(runtime, { spec });
    });
  });
```

- [ ] **Step 6: Re-export `runInstallCommand` from `@manta/cli` index.**

- [ ] **Step 7: Run tests — verify PASS.**

- [ ] **Step 8: Build workspace + sanity check** — `pnpm -r build && pnpm -r test`.

- [ ] **Step 9: Commit**

```
feat(cli): manta install command — happy-path pipeline (npm/git/local-tgz)
```

---

### Task 1.8: `ModeRegistry` integration with `cast.ts`

**Files:**
- Modify: `packages/manta-cli/src/commands/cast.ts:35` — keep `SUPPORTED_MODES` as the **built-in seed only**; rename to `BUILTIN_MODES` for clarity.
- Modify: `packages/manta-cli/src/commands/cast.ts:157` — replace `SUPPORTED_MODES.has(opts.mode)` with `modeRegistry.has(opts.mode)`. (Line as of 2026-05-28 HEAD; re-grep before edit.)
- Modify: `packages/manta-cli/src/commands/cast.ts` — add `verifyMantaVersionCompat(lock, mantaCliVersion)` preflight call before the registry lookup.
- Create: `packages/manta-cli/src/library/compat.ts` — exports `verifyMantaVersionCompat(lock, mantaCliVersion): { ok: true } | { ok: false; offendingPackage: string; offendingPackageRange: string; currentVersion: string }`.
- Create: `packages/manta-cli/tests/library/compat.test.ts`
- Modify: `packages/manta-cli/tests/commands/cast.test.ts` (or equivalent integration tests) — add test for library-mode cast resolution.

**Why:** This task closes the loop. Tasks 1.2 + 1.7 added the seam and the install command, but `cast.ts` still validates against `SUPPORTED_MODES` directly. After this task, a library-installed mode shows up in the cast mode allowlist, and a `mantaVersion` mismatch surfaces a friendly multi-recovery-option error before the cast spawns clones.

**Surgical change A — `BUILTIN_MODES` rename:** rename the `SUPPORTED_MODES` literal at `cast.ts:35` to `BUILTIN_MODES`. Its definition stays unchanged (the seven literals). It becomes the seed passed to `new ModeRegistry(BUILTIN_MODES)`.

**Surgical change B — registry construction:** at the top of `runCastCommand` (`cast.ts:153`, after the `SUPPORTED_MODES.has` validation block), build the registry once per command invocation:

```ts
const modeRegistry = new ModeRegistry(BUILTIN_MODES);
const lock = await runtime.lockfile.read();
if (lock) {
  for (const [packageName, entry] of Object.entries(lock.packages)) {
    for (const modeName of entry.contributes.modes) {
      modeRegistry.registerLibrary({
        name: modeName,
        basedOn: resolveBasedOnFromLocalStore(runtime, packageName, entry.version, modeName),
        packageName,
        packageVersion: entry.version,
      });
    }
  }
}
```

`resolveBasedOnFromLocalStore` reads the package's `manta-package.json` from `~/.manta/library/<scope>/<name>/<version>/` (via `runtime.localStore.pathFor`) and pulls `contributes.modes[]` entry by name → returns its `basedOn`. Cheap (sub-ms; the manifests are tiny). Cached per-cast.

**Surgical change C — compat preflight:** between the registry construction and the mode lookup at `cast.ts:157`, call:

```ts
const compat = verifyMantaVersionCompat(lock, getMantaCliVersion());
if (!compat.ok) {
  throw new CliError({
    code: 'manta_version_compat_unmet',
    message: buildCompatErrorMessage(compat),
    exitCode: 16,
  });
}
```

`getMantaCliVersion()` reads `packages/manta-cli/package.json#version` at runtime (or import-time constant; either works). `buildCompatErrorMessage` reuses the helper from Task 1.7.

**Surgical change D — mode lookup:** replace the `SUPPORTED_MODES.has(opts.mode)` check at `cast.ts:157` with `modeRegistry.has(opts.mode)`. **Preflight ordering (critical, reviewer-flagged):** registry construction → compat preflight (change C) → **integrity preflight (task 2.4 hash-pin check, added in Chunk 2)** → `modeRegistry.has(opts.mode)`. Integrity check must NOT come before compat — otherwise a tampered file masks the actionable "upgrade or downgrade" message when the user has a compat issue. The error message on miss should now list `modeRegistry.list().builtins.concat(modeRegistry.list().library.map(e => e.name))` rather than the hard-coded set.

**Surgical change E — dispatcher dispatch unchanged:** the per-mode branch table at `cast.ts:160`/`:166`/`:404`/`:413`/`:424`/`:606` (research §6.2) stays as-is in Chunk 1. Library modes inherit a host dispatcher via their `basedOn`, but Phase 7a routes library-mode cast invocations *through their host dispatcher branch directly* — i.e., if a library mode has `basedOn: 'pair-programming'`, `runCastCommand` treats `opts.mode` as `'pair-programming'` for branch-selection purposes after recording the library origin in the cast manifest. This is the minimum integration; richer per-mode dispatcher overrides (clone-C §4.4 `createDispatcher`) are a follow-on chunk.

**Acceptance criteria:**
- `manta cast recon-swarm` (built-in) still works — no regressions.
- `manta cast mega-refactor` with a lockfile entry whose `contributes.modes` includes `mega-refactor` (and `basedOn: 'pair-programming'`) succeeds: clones spawn through the `pair-programming` branch.
- `manta cast unknown-mode` lists both built-ins and library modes in the error message.
- `manta cast mega-refactor` with a lockfile whose entry's `mantaVersionCompat: '>=99.0.0'` fails with exit 16 and the multi-option recovery message (upgrade / downgrade / uninstall), per research §5.2.
- Cast manifests now record `{ baseMode: 'pair-programming', libraryMode: '@manta-library/refactor-megapack/mega-refactor' }` when a library mode is used (so post-mortems and the bus can record both the host dispatcher and the library origin, per research §6.2).

**Tests:**

- [ ] **Step 1: Write `compat.ts` failing tests** — `verifyMantaVersionCompat` against a synthetic lockfile with `0.7.2` cli version + entries with `>=0.7 <0.8` (ok), `>=99` (fail), `>=0.7` (ok). Verify `offendingPackage` is set.

- [ ] **Step 2: Implement `compat.ts`** using `semver.satisfies`.

- [ ] **Step 3: Run compat tests — verify PASS.**

- [ ] **Step 4: Write cast.test.ts failing integration test** — happy-path library mode, unknown-mode error message, compat-unmet error.

- [ ] **Step 5: Apply surgical changes A–D in `cast.ts`.**

- [ ] **Step 6: Run cast tests — verify PASS.**

- [ ] **Step 7: Sanity check that no existing cast test regressed** — `cd packages/manta-cli && pnpm vitest run`.

- [ ] **Step 8: Commit**

```
feat(cli): cast.ts integrates ModeRegistry + verifyMantaVersionCompat (replaces SUPPORTED_MODES gate)
```

---

### Task 1.9: User docs — `docs/user/manta-library.md` (Chunk 1 surface)

**Files:**
- Create: `docs/user/manta-library.md` — Chunk 1 draft covering happy-path install + ModeRegistry concept + lockfile.

**Why:** CLAUDE.md "Quality bar — PROD only" requires user-facing docs shipped in the same commit as the code. We ship a Chunk-1 draft now; Chunk 2 task 2.6 completes it (uninstall + library subcommands + flags + e2e). The draft is structured so Chunk 2's edits are append-only — no rewriting.

**Doc structure (Chunk 1 sections only):**

1. **What is Manta Library?** — one-paragraph intro, points at clone-A §1.1 precedent comparison; "like VS Code extensions, like npm modules, but for Manta modes / skills / commands / templates".
2. **Installing a package** — `manta install @manta-library/refactor-megapack`, `manta install git+https://...#v1.0`, `manta install ./local.tgz`. One-line description per spec form.
3. **The lockfile (`manta-lock.json`)** — what it is, where it lives (repo root), whether to commit it (yes, always), shape pointer at schema reference in the source tree.
4. **The global library store (`~/.manta/library/`)** — what lives there, multi-version coexistence, why it's outside the repo.
5. **Compatibility checking** — `mantaVersionCompat` in manifests, what happens on mismatch at install vs cast time, how to recover.
6. **Mode resolution at cast time** — how `manta cast <library-mode>` finds the mode; the role of `basedOn` (it inherits the host dispatcher's behaviour); the cast manifest records both `baseMode` and `libraryMode`.
7. **Phase 7a limitations** — hooks not yet installed (Phase 8); `manta share` not yet shipped (Phase 7b); `manta trigger` not yet shipped (Phase 7c); flag completeness for `manta install` lands in Chunk 2.
8. **Troubleshooting (Chunk 1)** — `[manta] install: cannot reach registry` → check `npm ping`; `[manta] install: library_validation_failed` → run `manta library doctor` (forward reference; ships in Chunk 2); `[manta] cast: manta_version_compat_unmet` → upgrade/downgrade/uninstall per the printed message.

Length target: ~250 lines markdown. Mirror the cadence of existing `docs/user/recon-swarm.md` and `docs/user/getting-started.md` (concise, action-oriented, examples up front).

**Acceptance criteria:**
- File exists at `docs/user/manta-library.md`.
- All commands shown in the doc are exactly the commands shipped in Chunk 1 (no forward references except clearly marked "Phase 7a Chunk 2" or "Phase 7b/7c").
- Cross-references to the lockfile schema point at the source file `packages/manta-cli/src/library/lockfile.ts` (with the `LockfileSchema` exported name), not at a frozen schema dump that will drift.

- [ ] **Step 1: Draft the doc** per structure above.

- [ ] **Step 2: Run any link-checker / spellcheck currently configured** (or skip if none configured; the repo doesn't run one in CI today).

- [ ] **Step 3: Commit**

```
docs(user): manta-library.md Chunk 1 draft — install + lockfile + ModeRegistry concept
```

---

### Task 1.10: Bug #18 fix — post-mortem `record.metadata` allowlist redactor

**Files:**
- Modify: `packages/manta-orchestrator/src/post-mortem.ts:83-87` — replace unconditional `record.metadata` iteration with `redactPostMortemMetadata(record.metadata)`.
- Create: `packages/manta-orchestrator/src/sanitize/metadata-allowlist.ts` — exports `redactPostMortemMetadata(meta) → SanitizedMetadata` + `POST_MORTEM_METADATA_ALLOWLIST: readonly string[]`.
- Create: `packages/manta-orchestrator/tests/sanitize/metadata-allowlist.test.ts`
- Modify: `packages/manta-orchestrator/src/index.ts` — re-export the sanitizer so Phase 7b (`manta share`) can reuse it.

**Why:** Bug #18 (`docs/manta-bugs.md` #18) — `post-mortem.ts:83-87` unconditionally renders every key=value pair in `record.metadata` into the post-mortem markdown. The metadata field is open-shape `Record<string,string>`, callers may add arbitrary new keys (auto-cast triggers may add `triggered_by: <name>`; a future user-stamp field might add `user_email: <value>`); whatever lands there ends up on disk and, in Phase 7b, in a published share bundle. The Phase 7a fix is the cheap defence-in-depth layer (a): allowlist the keys that may be rendered. The Phase 7b sanitization pipeline (deferred) will add the second defence-in-depth layer that enumerates every artifact path.

The sanitizer module also belongs in Phase 7a because the install pipeline is the first off-machine surface Manta acquires — even though install reads and writes are local, the **manta share** command (Phase 7b) will reuse this exact module, and lockstepping the rename + new layout into Phase 7a keeps Phase 7b a pure-additive change.

**Allowlist (initial set):**

```ts
// packages/manta-orchestrator/src/sanitize/metadata-allowlist.ts
export const POST_MORTEM_METADATA_ALLOWLIST = Object.freeze([
  'cast_id',
  'cast_mode',
] as const) satisfies readonly string[];

export type SanitizedMetadata = Readonly<Record<typeof POST_MORTEM_METADATA_ALLOWLIST[number], string>>;

export function redactPostMortemMetadata(
  meta: Readonly<Record<string, string>>,
): { kept: SanitizedMetadata; dropped: string[] };
```

The two allowlisted keys cover the current population (`cast_id`, `cast_mode` are set by the spawner per `packages/manta-cli/src/spawner/clone-spawner.ts` — both safe to render). New metadata fields must be added to the allowlist deliberately; the default is drop.

**Surgical change in `post-mortem.ts:83-87`:** replace the unconditional `for (const [k, v] of Object.entries(record.metadata))` loop with a call to `redactPostMortemMetadata(record.metadata)` and iterate only the `kept` object. Emit a single trailing line "`Dropped <n> non-allowlisted metadata fields: <key1>, <key2>`" when `dropped.length > 0` — this preserves visibility into intentional drops without leaking the values.

**Acceptance criteria:**
- `redactPostMortemMetadata({ cast_id: 'cast-1', cast_mode: 'recon-swarm' })` returns `{ kept: { cast_id: 'cast-1', cast_mode: 'recon-swarm' }, dropped: [] }`.
- `redactPostMortemMetadata({ cast_id: 'cast-1', triggered_by: 'on-push-trigger', user_email: 'x@y.z' })` returns `{ kept: { cast_id: 'cast-1' }, dropped: ['triggered_by', 'user_email'] }`.
- Generated post-mortem markdown for a clone whose metadata has both allowlisted and non-allowlisted keys renders only the allowlisted keys + the trailing "Dropped <n> non-allowlisted metadata fields" line.
- Generated post-mortem for a clone with only allowlisted keys is byte-identical to the pre-fix output (no behavioural drift in the happy path).
- Existing post-mortem tests continue to pass.

**Tests:**

- [ ] **Step 1: Write failing unit tests** for `redactPostMortemMetadata` (table-driven over allowlisted/non-allowlisted permutations).

- [ ] **Step 2: Write failing integration test** in the existing post-mortem render test file — assert that `record.metadata.triggered_by` does not appear in the rendered markdown when set.

- [ ] **Step 3: Run tests — verify FAIL.**

- [ ] **Step 4: Implement `metadata-allowlist.ts` + apply the surgical change at `post-mortem.ts:83-87`.**

- [ ] **Step 5: Re-export the sanitizer from `@manta/orchestrator` index.**

- [ ] **Step 6: Run tests — verify PASS** + check that all existing orchestrator tests stay green.

- [ ] **Step 7: Update `docs/manta-bugs.md` bug #18 status** to `Partial — layer (a) applied in Phase 7a; layer (b) deferred to Phase 7b`, with a note pointing at the Phase 7b plan for the full enumeration sanitizer. (Reviewer must-fix: bug log convention uses `Fixed in <release>` or `Partial — …`, not `In progress`.)

- [ ] **Step 8: Commit**

```
fix(orchestrator): allowlist-redact post-mortem record.metadata (bug #18 layer a)
```

---

### Chunk 1 complete when

- All ten task commits land on the chunk-1 branch.
- `pnpm -r build` clean across the workspace.
- `pnpm -r test` green across the workspace (existing 928 tests + the new tests from this chunk).
- `pnpm -r lint` clean (no new warnings, no `eslint-disable` without `// Reason: …` justification per CLAUDE.md "Запрещено в merged-коде").
- Manual happy-path verification: build a sample-package fixture tgz, run `node packages/manta-cli/dist/bin/manta.cjs install ./sample-package.tgz` in a tmp git repo, observe `manta-lock.json` created at repo root with the right entry, observe `~/.manta/library/@manta-library/sample-package/0.1.0/` populated, then run `node packages/manta-cli/dist/bin/manta.cjs cast <library-mode-name> --clones 2 --dry-run` and observe the library mode resolved through `ModeRegistry`.
- `docs/superpowers/plans/INDEX.md` updated with the Phase 7 section and a Chunk-1-only Phase 7a entry — the row is added in Chunk 2 task 2.7 after Chunk 2 lands, **not** at end of Chunk 1; this keeps INDEX.md row contents accurate (single Phase 7a row covers both chunks once Chunk 2 ships).
- Bug #18 in `docs/manta-bugs.md` moved to "Partial — layer (a) applied in Phase 7a; layer (b) deferred to Phase 7b".
- Post-mortem written for the chunk-1 cast in `docs/post-mortems/`.

---

## Chunk 2 — Uninstall + library CLI + flag completeness + e2e

Chunk 2 turns the happy-path install command into a production-grade command surface, adds `manta uninstall`, ships the `manta library …` observability subcommands, plumbs per-cast hash-pin verification, lands the env-gated e2e test, completes the user doc, adds the architecture note for `ModeRegistry`, and finalises INDEX.md + CHANGELOG.md.

**Build dependency chain:** Task 2.1 (install flags) and Task 2.2 (uninstall command) are independent of each other and parallelisable. Task 2.3 (library CLI commands) depends on the index format from Chunk 1 and is parallelisable with 2.1/2.2. Task 2.4 (hash-pin verification) is a small surgical change in `runCastCommand` (independent). Task 2.5 (e2e) depends on 2.1 + 2.2 + 2.3. Task 2.6 (docs) and Task 2.7 (INDEX + CHANGELOG) land last.

~700 LOC implementation estimated. Chunk 2 chunk-completes when every Task 2.x is green and `pnpm -r build && pnpm -r test && pnpm -r lint` is clean workspace-wide, including the new env-gated e2e test running successfully under `MANTA_E2E=1`.

### Task 2.1: `manta install` flag completeness

**Files:**
- Modify: `packages/manta-cli/src/commands/install.ts` — wire all flags from research §3.2.
- Modify: `packages/manta-cli/src/bin/manta.ts` — register flags on the `install` command.
- Modify: `packages/manta-cli/tests/commands/install.test.ts` — add per-flag test cases.

**Why:** Chunk 1 shipped the happy path. Chunk 2 hardens it. Each flag from research §3.2 maps to a concrete code-path:

| Flag | Behaviour |
|---|---|
| `--no-validate` | Skip the `validatePackage` call. Warn loudly: `[manta] install: --no-validate; manifest is parsed but content is not validated`. Reserved for CI replay of an already-validated tarball; not advertised. |
| `--no-hooks` | **Default `true` in Phase 7a** — hard-refuse to install any `manifest.contributes.hooks` entries. Setting `--no-hooks=false` is rejected at flag parse with `[manta] install: hooks distribution is deferred to Phase 8; --no-hooks cannot be disabled`. Shipping the flag with hard-refuse semantics now means Phase 7c can flip the default without breaking the CLI contract. |
| `--force` | Override the collision path. Implementation: before `staged.commit()`, `await rm(finalDir, { recursive: true, force: true })` if it exists. Surface a one-line warning. |
| `--offline` | Force `RegistryClient` to refuse network calls; only `local-tgz` specs are allowed. Other spec kinds fail with exit code 11 (`network_required_for_spec_kind`). Implementation: pass `offline: true` through the NetworkRunner; runner methods throw `OfflineRefusedError`. |
| `--integrity sha256-<hash>` | Pre-compute the user-pinned expected hash; compare against `resolved.contentSha256Hex` after fetch; mismatch → exit 13 (`checksum_mismatch`) with both values printed. |
| `--json` | Replace human-readable summary output with a single JSON line `{ name, version, integrity, contributedModes, contributedSkills, contributedCommands, contributedTemplates, lockfilePath, installPath }`. Errors emit `{ error: { code, message, hint? } }`. |
| `--dry-run` | Execute steps 1–6 of the install pipeline (parse, resolve, fetch, extract, compat, validate) but skip `staged.commit()` and the lockfile/index writes. Print what *would* happen, exit 0. Used by `manta library doctor` (Task 2.3) and by CI replay. |

**Acceptance criteria:**
- `manta install <fixture.tgz> --force` overwrites an existing same-version install.
- `manta install @manta-library/foo --offline` against a fixture that's not in cache fails with exit 11 and `network_required_for_spec_kind`.
- `manta install <fixture.tgz> --integrity sha256-AAA…` (wrong hash) fails with exit 13 and prints both expected and actual.
- `manta install <fixture.tgz> --dry-run` does not modify `~/.manta/library/` or `manta-lock.json`; exits 0; prints the would-be summary.
- `manta install <fixture.tgz> --json` emits valid JSON parseable with `JSON.parse`.
- `manta install <fixture-with-hooks.tgz> --no-hooks=false` is rejected at flag parse time with the deferred-to-Phase-8 message.

**Tests:**

- [ ] **Step 1: Write failing tests** — one per flag/combination above.

- [ ] **Step 2: Implement each flag** in `install.ts` and wire registrations in `bin/manta.ts`.

- [ ] **Step 3: Run tests — verify PASS.**

- [ ] **Step 4: Commit**

```
feat(cli): manta install flag completeness — force/offline/integrity/json/dry-run/no-validate/no-hooks
```

---

### Task 2.2: `manta uninstall <name>[@<version>]` command

**Files:**
- Create: `packages/manta-cli/src/commands/uninstall.ts`
- Create: `packages/manta-cli/tests/commands/uninstall.test.ts`
- Modify: `packages/manta-cli/src/bin/manta.ts` — register the command adjacent to `install`.
- Modify: `packages/manta-cli/src/index.ts` — re-export `runUninstallCommand`.

**Why:** Symmetric to `install`. Required for the install/uninstall round-trip e2e (Task 2.5) and for users to recover from a bad install.

**Exported interface:**

```ts
// packages/manta-cli/src/commands/uninstall.ts
export interface RunUninstallCommandOptions {
  spec: string;                  // "@manta-library/foo" or "@manta-library/foo@1.3.0"
  force?: boolean;               // override in-use check
}
export interface RunUninstallCommandResult {
  removedPackageName: string;
  removedVersion: string;
  removedPath: string;
}
export async function runUninstallCommand(
  runtime: Runtime,
  opts: RunUninstallCommandOptions,
): Promise<RunUninstallCommandResult>;
```

**Pipeline (per research §3.4):**
1. Parse `spec` into `{ packageName, version? }`.
2. `index = await runtime.localStore.readIndex()`.
3. Find all installs of `packageName`. If `version` omitted and >1 install exists → exit 18 with `[manta] uninstall: multiple versions of <name> installed: <list>. Specify one.`. If `version` omitted and exactly 1 exists → proceed with that one.
4. **In-use check (must-fix expansion):** 
   a. Read the to-be-removed package's entry from `runtime.localStore.readIndex()` → extract `entry.contributes.modes` (array of library-mode names this package owns).
   b. `clones = await runtime.ctx.registry.list()`.
   c. For each clone where `clone.state !== 'DEAD'` (i.e. `state` ∈ `{STARTING, WORKING, BLOCKED, IDLE, WAITING_FOR_TASK, WINDING_DOWN}` — all six non-DEAD states enumerated explicitly per reviewer must-fix), check whether `clone.mode ∈ entry.contributes.modes`. Any match = in-use.
   d. If any in-use match → exit 18 `[manta] uninstall: <name>@<version> is in use by cast <cast-id> (clones: <ids>; modes: <matched-modes>). Run \`manta abort <cast-id>\` first.` — unless `--force` AND every matched clone is in `{IDLE, WAITING_FOR_TASK, WINDING_DOWN}` (the "soft" non-DEAD states). **`--force` is rejected** when any matched clone is in `{STARTING, WORKING, BLOCKED}` (the "hot" non-DEAD states) — uninstalling files mid-read by a live `claude --print` subprocess corrupts the in-flight cast. Print refusal: `[manta] uninstall --force: refusing while clones <ids> are <state>. Run \`manta abort <cast-id>\` first.` Exit 18.
5. `await runtime.localStore.removeIndexEntry(packageName, version)`.
6. `await rm(installPath, { recursive: true, force: true })`.
7. `await runtime.lockfile.mutate(current => removeEntry(current, packageName))` — drop the lockfile entry. If the package has multiple versions installed but only one is in the lockfile, removing the *installed* version that matches the lockfile is correct; mismatch is unreachable post-install logic.
8. Print summary.

**Acceptance criteria:**
- `manta uninstall @manta-library/foo@1.3.0` (with one install) removes the dir, updates index.json, drops the lockfile entry. Exit 0.
- `manta uninstall @manta-library/foo` (with two versions installed) fails with exit 18 and lists the available versions.
- `manta uninstall @manta-library/foo@1.3.0` (with an active cast referencing the mode) fails with exit 18 unless `--force`.
- `manta uninstall @manta-library/unknown` fails with exit 12 (`not_installed`).
- Idempotency: re-running uninstall after success is a no-op + clear "not installed" message.

**Tests:**

- [ ] **Step 1: Write failing tests** — single-version uninstall, multi-version refusal, in-use refusal, force override, unknown-name, idempotent re-run.

- [ ] **Step 2: Implement `uninstall.ts` + register in bin.**

- [ ] **Step 3: Run tests — verify PASS.**

- [ ] **Step 4: Commit**

```
feat(cli): manta uninstall — multi-version check, in-use check, lockfile drop
```

---

### Task 2.3: `manta library` observability subcommands

**Files:**
- Create: `packages/manta-cli/src/commands/library.ts` — exports `runLibraryListCommand`, `runLibraryShowCommand`, `runLibraryOutdatedCommand`, `runLibraryDoctorCommand`.
- Create: `packages/manta-cli/tests/commands/library.test.ts`
- Modify: `packages/manta-cli/src/bin/manta.ts` — register `library` subcommand group.
- Modify: `packages/manta-cli/src/index.ts` — re-export.

**Why:** Research §3.5 — Phase 7a ships four observability subcommands. None of them mutate state; all read from `~/.manta/library/index.json` and the lockfile.

**Subcommands:**

- `manta library list [--json]` — table of installed packages with columns `Name`, `Version`, `Modes`, `Skills`, `Cmds`, `Templates`, `Path`. Reads index.json. Exit 0 even when empty.

- `manta library show <name>[@<version>] [--json]` — pretty-print one package's manifest + contributed surface + lockfile entry. Exit 12 when not installed.

- `manta library outdated [--json]` — for each npm-installed package, shell out `npm view <name> versions --json` (via injected NetworkRunner) to find newer versions satisfying lockfile range. Git-installed packages are reported as `pinned`. Exit 0 always; the report is the value.

- `manta library doctor [--json]` — for each installed package, import `validatePackage` from `@manta/skill-validator` (the function added in Task 1.6) and call `validatePackage(installPath)`. Catches `mantaVersionCompat` drift after the user upgraded the CLI: any package whose `mantaVersionCompat` no longer satisfies the current `mantaCliVersion` is flagged. Exit 0 when all healthy, **exit 20 (`library_unhealthy`)** when any package is unhealthy. (Exit 19 is reserved for `library_tampered` from task 2.4 — distinct codes so CI/JSON consumers can distinguish "re-install" from "upgrade-cli or uninstall".)

**Acceptance criteria:**
- `manta library list` on a fresh repo prints "No library packages installed." and exits 0.
- `manta library list --json` produces machine-parseable JSON `{ installs: [...] }`.
- `manta library show @manta-library/unknown` exits 12.
- `manta library outdated` with a fake `NetworkRunner` that reports a newer version produces "@manta-library/foo: 1.3.0 → 1.4.0 available (range >=1.0 <2.0)".
- `manta library doctor` after a simulated CLI upgrade that breaks compat for one package returns exit 20 and lists the offender. (Exit 19 reserved for tamper.)

**Tests:**

- [ ] **Step 1: Write failing tests** — table-driven across the four subcommands.

- [ ] **Step 2: Implement `library.ts` + register the subcommand group in `bin/manta.ts`.**

- [ ] **Step 3: Run tests — verify PASS.**

- [ ] **Step 4: Commit**

```
feat(cli): manta library list/show/outdated/doctor observability subcommands
```

---

### Task 2.4: Hash-pin verification on every cast

**Files:**
- Modify: `packages/manta-cli/src/commands/cast.ts` — add `verifyLibraryIntegrity(lock, localStore)` call between the `verifyMantaVersionCompat` preflight (Task 1.8) and the `modeRegistry.has` lookup.
- Create: `packages/manta-cli/src/library/integrity.ts` — exports `verifyLibraryIntegrity(lock, localStore): Promise<{ ok: true } | { ok: false; offendingPackage: string; expected: string; actual: string }>`.
- Create: `packages/manta-cli/tests/library/integrity.test.ts`

**Why:** Research §5.3 — on every `manta cast`, recompute on-disk content hash for each lockfile entry and compare against the lockfile's `directoryDigest` field (added to schema in Chunk 1 task 1.3). Mismatch → exit 19 `library_tampered`. The cost is microseconds for typical Manta packages (skill markdown + JSON; cold-disk fs walk for a single-version directory).

**Call-site ordering (reviewer must-fix):** the integrity preflight goes **after** `verifyMantaVersionCompat` and **before** `modeRegistry.has`. Full ordering at `runCastCommand`:
1. `cloneIds = await allocateCloneIds(...)` (bug #19 fix, current HEAD).
2. `modeRegistry = await loadModeRegistry(runtime)` (Chunk 1 task 1.8 change B).
3. `await verifyMantaVersionCompat(lock, mantaCliVersion)` — fail with exit 16 (Chunk 1 task 1.8 change C).
4. **`await verifyLibraryIntegrity(lock, runtime.localStore)`** — fail with exit 19 (this task). Comes after compat so a tampered-AND-compat-broken install surfaces the actionable upgrade message first, not the tamper message.
5. `if (!modeRegistry.has(opts.mode)) throw ...` (Chunk 1 task 1.8 change D).

**Algorithm:**
1. For each `[packageName, entry]` in `lock.packages`:
   - `path = localStore.pathFor(packageName, entry.version)`.
   - If path missing → return `{ ok: false, offendingPackage: packageName, expected: entry.directoryDigest, actual: '<missing>' }`. This handles the case where the user committed the lockfile but didn't run `manta install` (or `rm -rf ~/.manta/library/` happened).
   - `actual = await computeDirDigest(path)` — reuse the helper from Task 1.4's `dir-digest.ts` (no new walker here).
   - Compare `actual` to `entry.directoryDigest`. Return on first mismatch.
2. All match → `{ ok: true }`.

**Note on hash form:** `directoryDigest` (lockfile field) is the canonical directory-content hash captured at install time by Task 1.7 step 10. This task only reads + compares — no retrofit to Chunk 1 schema (schema includes `directoryDigest` as of Chunk 1 task 1.3 per the reviewer must-fix).

**Acceptance criteria:**
- Unmodified install → `{ ok: true }` in microseconds.
- Tampered install (one byte changed in a skill file) → `{ ok: false }` with offendingPackage and both hashes.
- Missing install dir → `{ ok: false }` with `actual: '<missing>'`.
- `manta cast` exits 19 with `library_tampered` message that includes the offending package + recovery hint: `Run \`manta install <name>@<version> --force\` to re-fetch.`

**Tests:**

- [ ] **Step 1: Write failing unit tests** for `verifyLibraryIntegrity` against happy/tampered/missing fixtures.

- [ ] **Step 2: ~~Update lockfile schema~~** — REMOVED per reviewer must-fix; `directoryDigest` ships in Chunk 1 task 1.3 schema, no Chunk-2 retrofit. Verify the field is present in the Chunk 1 deliverable before this step proceeds (`grep directoryDigest packages/manta-cli/src/library/lockfile.ts`).

- [ ] **Step 3: Implement `integrity.ts`.**

- [ ] **Step 4: Wire into `runCastCommand` between compat preflight and mode lookup.**

- [ ] **Step 5: Run tests — verify PASS.**

- [ ] **Step 6: Commit**

```
feat(cli): hash-pin verification on every cast — exit 19 library_tampered on mismatch
```

---

### Task 2.5: E2E test — install + cast a library mode

**Files:**
- Create: `packages/manta-e2e/tests/manta-library.e2e.test.ts` (project convention is `tests/` not `src/` — verified 2026-05-28 against existing `packages/manta-e2e/tests/recon-swarm.e2e.test.ts`)
- Create: `packages/manta-e2e/tests/fixtures/library-mode-package/` — a self-contained library package fixture whose `contributes.modes[0]` has `basedOn: 'recon-swarm'`.

**Why:** The Phase 7a contract is "you can install a library package and cast a library mode through it end-to-end." This test exercises every Chunk-1 + Chunk-2 surface together against the real CLI. Env-gated by `MANTA_E2E=1` using the existing `probeClaudeBin()` helper at `packages/manta-e2e/tests/helpers/claudeBin.ts:19` (returns `{ available: false, reason }` when `MANTA_E2E !== '1'` or `claude --version` fails — reuse, don't reinvent).

**Pipeline:**
1. **Preflight (always runs even without `MANTA_E2E`):** `pnpm -r build` clean, `node packages/manta-cli/dist/bin/manta.cjs --help` lists `install`, `uninstall`, `library`.
2. **Env-gated body** — call `const probe = await probeClaudeBin()`; if `!probe.available` use `it.skip` semantics (return early with a skip message including `probe.reason`). When `probe.available === true`:
   - Build the fixture package into a tgz under a per-test tmp dir.
   - Make a per-test tmp git repo + tmp home dir (so `~/.manta/library/` is sandboxed).
   - Run `manta install <fixture.tgz>` via execa. Assert exit 0, `manta-lock.json` exists with the right entry, `<tmp-home>/.manta/library/...` populated.
   - Run `manta library list --json` via execa. Parse JSON. Assert the install entry is present.
   - Run `manta cast <library-mode-name> --clones 2 --dry-run`. Assert exit 0; assert the mode resolved through the library — capture stderr/stdout and grep for the library-mode origin marker.
   - Run `manta cast <library-mode-name> --clones 2` (real spawn — same path as the existing recon-swarm e2e). Assert all clones reach `DEAD`, post-mortems exist, the cast manifest records `libraryMode: '<library-mode-name>'`.
   - Run `manta uninstall <package-name>@<version>`. Assert exit 0, install dir removed, lockfile entry dropped.

**Acceptance criteria:**
- Preflight runs in CI on every PR (not env-gated).
- Body runs under `MANTA_E2E=1` and passes within a 30-minute test timeout (same as `recon-swarm.e2e.test.ts`).
- Body skips gracefully (test marked SKIP, not FAIL) when `claude --version` is unavailable or `MANTA_E2E !== '1'`.

**Tests:**

- [ ] **Step 1: Build the fixture package** + commit fixture sources under `packages/manta-e2e/tests/fixtures/library-mode-package/`.

- [ ] **Step 2: Write the preflight test.**

- [ ] **Step 3: Write the env-gated body test.**

- [ ] **Step 4: Run preflight locally — verify PASS.**

- [ ] **Step 5: Run the env-gated body under `MANTA_E2E=1` — verify PASS.**

- [ ] **Step 6: Commit**

```
test(e2e): install + cast a library mode end-to-end (env-gated MANTA_E2E=1)
```

---

### Task 2.6: Documentation completion + architecture note

**Files:**
- Modify: `docs/user/manta-library.md` — append the Chunk 2 sections (uninstall, library subcommands, full flag matrix for install, hash-pin verification user-facing behaviour, troubleshooting expansion).
- Create: `docs/internals/mode-registry.md` — architecture note for the `ModeRegistry` seam (audience: future contributors, future Phase 7b/7c plan-writers).

**Why:** CLAUDE.md requires user-facing docs + architecture note in the same commit as the feature. Chunk 1 shipped the user-doc draft; Chunk 2 completes it. The architecture note is new and explains the `basedOn`/host-dispatcher inheritance model so future contributors don't reinvent it.

**`mode-registry.md` outline:**
1. **Problem:** `SUPPORTED_MODES` as a closed set blocks library extensibility; the closed set was correct for Phase 0–6 (clarity beats flexibility), wrong for Phase 7+ (need to register library modes).
2. **Solution:** `ModeRegistry` class seeded with built-ins; library entries registered from lockfile at `runCastCommand` entry.
3. **`basedOn` semantics:** library modes parameterise a built-in dispatcher rather than ship dispatcher code. Threat-model rationale (no arbitrary JS execution).
4. **Why not a richer registry now:** clone-C §4.4 outlines a richer `ModeDefinition` with `createDispatcher`/`primingBlock`/`invariants`. We deferred — pinpoint why (YAGNI for Phase 7a; the richer factory pattern earns its complexity only when library modes need to override dispatcher behaviour, which Phase 7a deliberately disallows).
5. **Cast-manifest dual recording:** how `baseMode` + `libraryMode` are both recorded; why both matter (post-mortems, share bundles, audit).
6. **Future work pointers:** where to extend when Phase 7c/8 needs more.

**Acceptance criteria:**
- `docs/user/manta-library.md` covers every shipped command and flag accurately.
- `docs/internals/mode-registry.md` exists and is ~200 lines markdown.
- Both docs cross-reference each other where relevant.

**Tests:**

- [ ] **Step 1: Append Chunk 2 sections to `docs/user/manta-library.md`.**

- [ ] **Step 2: Draft `docs/internals/mode-registry.md`.**

- [ ] **Step 3: Run the test-suite skill-validator + e2e preflight** to confirm nothing in the docs breaks doc-discovery (none of the Phase 7a docs are skills; this is a paranoia check).

- [ ] **Step 4: Commit**

```
docs: manta-library Chunk 2 completion + mode-registry architecture note
```

---

### Task 2.7: INDEX.md + CHANGELOG.md update

**Files:**
- Modify: `docs/superpowers/plans/INDEX.md` — insert the Phase 7 section between Phase 6 and the existing "Phase 7+ — TBD" placeholder; add a Phase 7a row with status TODO (Chunk 2 lands on the row's eventual `Executed` status post-merge; the plan-file ships as TODO at write-time).
- Modify: `CHANGELOG.md` — add a `0.x.0` entry describing the Phase 7a surface (install + uninstall + library subcommands + lockfile + ModeRegistry + bug #18 partial fix).

**Why:** INDEX.md is the source-of-truth map of the plan corpus. Phase 7a is now planned; the row must exist as TODO so future sessions discover it. CHANGELOG.md ships with every phase per CLAUDE.md.

**INDEX.md insertion:**

After the existing Phase 6 section ("## Phase 6 — Wave-2 Modes (...)" and its row) and before the existing "## Phase 7+ — TBD" placeholder, insert:

```markdown
## Phase 7 — Manta Library + auto-cast triggers + community

Цель: реализация Manta Library (install / uninstall / lockfile / ModeRegistry / manifest schema), auto-cast triggers, и community-layer (share bundle + discovery). Каждая sub-фаза = отдельный план-файл. Build by **heavy dogfood** — клоны строят Phase 7 sub-фазы.

| План | Статус | Содержит |
|---|---|---|
| `2026-05-28-phase-7a-manta-library.md` | **TODO** | 2 chunks, 17 tasks, ~1400 LOC implementation. Chunk 1: `MantaPackageManifest` Zod schema, `ModeRegistry` seam, `manta-lock.json` read/write, `LocalStore` for `~/.manta/library/`, `NpmClient`/`GitClient` registry-client abstraction, `validatePackage` validator extension, `manta install` happy-path command (npm/git/local-tgz), cast.ts integration (`SUPPORTED_MODES` → `modeRegistry.has` + `verifyMantaVersionCompat` preflight), user doc draft, bug #18 layer-(a) post-mortem metadata allowlist redactor (sanitizer module reused by Phase 7b). Chunk 2: install flag completeness (`--force`/`--offline`/`--integrity`/`--json`/`--dry-run`/`--no-validate`; `--no-hooks` ships with hard-refuse semantics — hooks deferred to Phase 8), `manta uninstall` (multi-version check + in-use check), `manta library list/show/outdated/doctor` observability subcommands, hash-pin verification on every cast (exit 19 `library_tampered`), env-gated e2e test (install + cast + uninstall round-trip), full user doc + `docs/internals/mode-registry.md` architecture note, CHANGELOG entry. Research-backed: 3-clone recon-swarm cast-1779977834212 (`docs/research/phase-7-manta-library.md`, `docs/research/phase-7-community-share-trust.md`). |
| `2026-05-28-phase-7b-manta-share.md` | TODO (not yet written) | Will cover `manta share <cast-id>`, full sanitization enumeration (snapshot/contract/timeline/post-mortem/ZK redaction pipeline), bundle integrity, `--publish` flow to npm, threat-model gates. Reuses Phase 7a's manifest schema + sanitizer module + lockfile. |
| `2026-05-28-phase-7c-auto-triggers.md` | TODO (not yet written) | Will cover `manta trigger add/list <event> <action>`, trigger taxonomy (git-pull, failing-tests, file-watch), watcher safety, infinite-loop prevention. Independent of Phase 7a/7b implementation surface. |
```

**Two-commit pattern (reviewer must-fix — atomicity):** Task 2.7 ships as TWO commits, not one, to resolve the chicken-and-egg of inline-commit-SHA references:
1. **Commit A (this task's main commit):** add the Phase 7 INDEX.md section with the Phase 7a row at status `**TODO**` + CHANGELOG entry referencing the upcoming `Executed` status.
2. **Commit B (separate follow-up, last commit of Phase 7a):** flip the Phase 7a row from `**TODO**` to `**Executed** — Chunk 1 (<sha1>) + Chunk 2 (<sha2..sha8>) + post-merge fixes <sha>` with all real commit hashes inline. This mirrors the post-merge INDEX-update pattern from Phase 6 (`bfcc7c3`) and the Phase 4 lockdown (`093e4dd`, `2520528`).

The Chunk-2 task count therefore becomes **eight task commits** (2.1–2.7 + 2.7-followup), not seven.

Also remove the "Phase 7: Manta Library + auto-cast triggers + community" bullet from the existing "## Phase 7+ — TBD" section since Phase 7 is now planned; replace the placeholder with just the Phase 8 bullet:

```markdown
## Phase 8+ — TBD

Per spec Sec 15.1. Each phase = separate plan file:
- Phase 8: Aghs-locked modes (`council`, `phantom-lance`, `decoy`); hooks distribution from library packages; custom HTTP registry (only if ≥100 packages or supply-chain incident).
```

**CHANGELOG.md entry:**

```markdown
## [0.x.0] - 2026-05-?? — Phase 7a Manta Library (install/uninstall/lockfile/ModeRegistry)

### Added
- `manta install <spec>` command — supports npm scopes (`@manta-library/*`), git URLs, and local `.tgz` files
- `manta uninstall <name>[@<version>]` command — with multi-version + in-use safety checks
- `manta library list|show|outdated|doctor` observability subcommands
- `MantaPackageManifest` Zod schema (in `@manta/skill-validator`) — strict validation of library packages
- `ModeRegistry` class (`@manta/cli`) — built-in modes + library-installed modes resolved through one seam
- `manta-lock.json` at repo root — atomic read/write, deterministic key ordering, hash-pinned
- `~/.manta/library/<scope>/<name>/<version>/` global install layout with `~/.manta/library/index.json` index
- `verifyMantaVersionCompat` preflight in `manta cast` — exit 16 with multi-recovery-option message
- Hash-pin verification on every `manta cast` — exit 19 `library_tampered` on mismatch

### Fixed
- Bug #18 (partial — layer a): post-mortem `record.metadata` now allowlisted to `cast_id`/`cast_mode` only; non-allowlisted keys dropped with a single-line audit footer. Full enumeration sanitizer arrives with Phase 7b.

### Deferred to later phases
- `manta share <cast-id>` — Phase 7b
- `manta trigger add/list` — Phase 7c
- Hook distribution inside library packages — Phase 8
- Code signing, author reputation, runtime sandbox — Phase 8+
- Custom HTTP registry — Phase 8+
- `manta library search` + curated GitHub index — Phase 8
```

- [ ] **Step 1: Apply the INDEX.md insertion.**

- [ ] **Step 2: Apply the CHANGELOG.md entry.**

- [ ] **Step 3: Flip Phase 7a row status to `**Executed**`** with the actual chunk commits inline once Chunk 2 lands.

- [ ] **Step 4: Run skill-validator integration test** to confirm INDEX.md is still parsable (it's a docs change but the test suite walks the planning dir).

- [ ] **Step 5: Commit**

```
chore: Phase 7a complete — INDEX.md + CHANGELOG.md + status flip
```

---

### Chunk 2 complete when

- All eight task commits (2.1–2.7 + 2.7-followup status flip) land on the chunk-2 branch.
- `pnpm -r build` clean.
- `pnpm -r test` green workspace-wide.
- `pnpm -r lint` clean.
- `MANTA_E2E=1 pnpm -F @manta/e2e test manta-library.e2e.test.ts` runs and passes (install → cast → uninstall round trip on a real claude-code spawn).
- Manual happy-path verification: in a fresh git repo, `manta install ./fixture.tgz`, `manta library list`, `manta library doctor`, `manta cast <library-mode> --clones 2`, `manta uninstall @manta-library/fixture@0.1.0` — all succeed and produce the expected on-disk state changes.
- `docs/user/manta-library.md` reflects every shipped command + flag.
- `docs/internals/mode-registry.md` exists and explains the `basedOn` host-dispatcher inheritance model.
- `docs/superpowers/plans/INDEX.md` has the Phase 7 section with Phase 7a marked `**Executed**` and the chunk commits inline.
- `CHANGELOG.md` has the Phase 7a entry.
- `docs/manta-bugs.md` bug #18 status updated to `Fixed in <release> — layer a (allowlist); layer b (full enumeration sanitizer) ships in Phase 7b`.
- Post-mortem written for the chunk-2 cast in `docs/post-mortems/`.

---

## Cross-phase notes

**Reuse contracts (Phase 7a → Phase 7b/7c):** the manifest schema (Task 1.1), the lockfile (Task 1.3), the `ModeRegistry` (Task 1.2), the `LocalStore` index (Task 1.4), the metadata allowlist sanitizer (Task 1.10), and `verifyMantaVersionCompat` (Task 1.8) are all consumed by later sub-phases. Any field rename or behavioural change after Phase 7a ships becomes a breaking change to the lockfile/share-bundle contract — treat them with the same care as bus schemas.

**Phase 7b (deferred — outline only):** `manta share <cast-id>` builds a `*.mantapkg.tar.gz` from a finalised cast; reuses Phase 7a's `MantaPackageManifest` shape augmented with a `castOrigin` block (per clone-A research §1.3 not-yet-shipped fields), full sanitization enumeration covering every leak path (clone-C §1.4 table + clone-A §4.3 table — 20+ redaction rules), `--publish` flow to npm with threat-model gates (two interactive confirms, login check, scope ownership check, size cap), and a complete forensic-timeline redactor. The Phase 7a sanitizer module from Task 1.10 is the seed; Phase 7b enumerates the rest.

**Phase 7c (deferred — outline only):** `manta trigger add <event> <action>` ships the auto-cast trigger taxonomy (clone-B research is the seed). Independent of the install/share surfaces. Flips `--no-hooks` default behaviour to support hook-bearing modes — but that requires the Phase 8 hook-execution security review first.

**Cooldown on the `--no-hooks` decision:** the Phase 7a hard-refuse for hooks is a *policy* knob; it should be reviewed once Phase 8's hook sandboxing design is complete. The flag exists in Phase 7a with the right name and the right exit semantics so that flipping it is a one-line change later, not a CLI API break.

---

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `npm pack` shell-out fails on some platforms (Windows) | Medium | Medium — install path broken there | `tar`-based fallback for local-tgz inputs (always works); npm-spec inputs require npm in PATH (documented as a prereq). Phase 7a does not target Windows-first; matches the rest of the project (POSIX-only). |
| Library package author lies in `contributes.modes[].basedOn` (says `recon-swarm`, dispatcher behaviour is incompatible) | Low | Medium — cast might misbehave | Phase 7a's `basedOn` enum is the seven built-ins. Any value outside that closed enum is a schema error (Task 1.1). Library packages cannot dispatch arbitrary code, so the worst case is "library mode runs `recon-swarm` clones with a bad priming preamble", not "library mode owns the process." Mitigated structurally. |
| Mode-name collision between two library packages | Medium | Low | `ModeRegistry.registerLibrary` throws `ModeConflictError` with `code: 'mode_conflict_library'`; install command surfaces it as exit 14 with clear "uninstall the other package first" recovery. Clone-A §7 open question 1 (first-installed-wins vs hard-fail) — we picked **hard-fail** for predictability. Documented in `docs/user/manta-library.md`. |
| User installs a library package whose `mantaVersionCompat` is satisfied at install but the user later upgrades the CLI past the range | Medium | Medium — cast suddenly errors | Three-checkpoint compat strategy (clone-C §3.2 — install / lockfile-load / cast-time). Phase 7a ships install-time + cast-time (Task 1.8); the arm-time check from clone-C is moot because we don't have an arm step. `manta library doctor` (Task 2.3) catches drift proactively. |
| Lockfile corruption (manual edit) | Low | High — cast refuses to start with cryptic error | Lockfile is parsed by a strict Zod schema (Task 1.3). Parse error surface is friendly: `[manta] cast: cannot parse manta-lock.json: <Zod path>. Run \`manta library doctor --repair\` (Phase 8) or delete the lockfile and re-run \`manta install …\` for each entry.` Phase 7a does not ship `--repair`; lists it as Phase 8 work in the doc. |
| Race between `manta install` and `manta cast` accessing the lockfile | Low | Medium — `cast` reads partial lockfile | Atomic-rename pattern + per-process mutex (Task 1.3). Cross-process race window is the brief moment between tmp-rename and `fsync`; the lockfile is one small JSON file so the window is sub-ms. The cast lockfile read is read-only and re-fetches each invocation; on a parse failure due to mid-rename, the friendly Zod error path catches it (Phase 7a) and a retry-once wrapper is a reasonable Phase 8 polish. |

---

## File scoping summary

For each chunk's PR review, the reviewer should grep for the file list to ensure the surface stays within the planned envelope:

**Chunk 1 new files (11):**
- `packages/manta-skill-validator/src/manifest-schema.ts`
- `packages/manta-skill-validator/tests/manifest-schema.test.ts`
- `packages/manta-skill-validator/tests/validate-package.test.ts`
- `packages/manta-cli/src/library/mode-registry.ts`
- `packages/manta-cli/src/library/lockfile.ts`
- `packages/manta-cli/src/library/local-store.ts`
- `packages/manta-cli/src/library/registry-client.ts`
- `packages/manta-cli/src/library/compat.ts`
- `packages/manta-cli/src/commands/install.ts`
- `packages/manta-cli/tests/library/{mode-registry,lockfile,local-store,registry-client,compat}.test.ts` (5 files)
- `packages/manta-cli/tests/commands/install.test.ts`
- `packages/manta-orchestrator/src/sanitize/metadata-allowlist.ts`
- `packages/manta-orchestrator/tests/sanitize/metadata-allowlist.test.ts`
- `docs/user/manta-library.md` (Chunk 1 draft)

**Chunk 1 surgical edits (4):**
- `packages/manta-skill-validator/src/walk.ts` (add `validatePackage`)
- `packages/manta-skill-validator/src/index.ts` (re-exports)
- `packages/manta-cli/src/runtime.ts:36` (add `lockfile` + `localStore` fields)
- `packages/manta-cli/src/bin/manta.ts:375` (register `install` command)
- `packages/manta-cli/src/commands/cast.ts:35`/`:132` (rename + replace; add compat preflight)
- `packages/manta-cli/src/index.ts:12` (re-export `runInstallCommand`)
- `packages/manta-orchestrator/src/post-mortem.ts:83-87` (call sanitizer)
- `packages/manta-orchestrator/src/index.ts` (re-export sanitizer)
- `packages/manta-cli/package.json` (`semver` + `tar` deps)

**Chunk 2 new files:**
- `packages/manta-cli/src/commands/uninstall.ts` + test
- `packages/manta-cli/src/commands/library.ts` + test
- `packages/manta-cli/src/library/integrity.ts` + test
- `packages/manta-e2e/tests/manta-library.e2e.test.ts` + fixture under `packages/manta-e2e/tests/fixtures/library-mode-package/`
- `docs/internals/mode-registry.md`

**Chunk 2 surgical edits:**
- `packages/manta-cli/src/commands/install.ts` (flag plumbing)
- `packages/manta-cli/src/commands/cast.ts` (integrity preflight)
- `packages/manta-cli/src/bin/manta.ts` (register `uninstall`, `library` subgroup)
- `packages/manta-cli/src/library/lockfile.ts` (add `directoryDigest` field to entry schema)
- `docs/user/manta-library.md` (Chunk 2 sections)
- `docs/superpowers/plans/INDEX.md` (Phase 7 section)
- `CHANGELOG.md` (Phase 7a entry)
- `docs/manta-bugs.md` (bug #18 status)

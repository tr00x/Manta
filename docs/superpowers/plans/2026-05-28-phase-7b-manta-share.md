# Phase 7b — Manta Share: Bundle generation + sanitization + integrity + `--publish`

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `manta share <cast-id>` — the command that turns one finalised cast's on-disk filesystem state into a publishable `*.manta-pkg.tar.gz` bundle. Three deliverables: (1) a **full default-deny sanitization pipeline** that strips every absolute path, host PID, wallclock epoch, raw transcript fragment, and secret-format token from the snapshot / task-contract / post-mortems / ZK notes / event timeline / worktree-diff before any byte leaves the repo; (2) **bundle integrity** — a `checksum.json` witness file plus a `castOrigin` manifest extension recording cast lineage, verifiable manifest-vs-disk before install; (3) a **`--publish` flow to npm** gated by the MVTS-7 threat model (informed-consent + best-effort static scan, *not* a security boundary). Strictly scoped to *producing* and *publishing* a bundle — `/manta install` (Phase 7a, shipped) consumes it; `/manta trigger` (Phase 7c) is a separate plan.

**Architecture:** All new code lives behind one new directory `packages/manta-cli/src/share/` (sanitizers, secret-scanner, bundle-assembler, publish-flow) plus one additive schema extension in `@manta/skill-validator` (`CastOriginSchema` + a `SharedBundleManifestSchema` that intersects the shipped `MantaPackageManifestSchema` with the new `castOrigin` field). The `manta share` command reads cast state through the existing `@manta/bus` state stores (read-only) and the existing post-mortem / ZK / events files on disk, runs each artifact through its dedicated sanitizer, assembles the unpacked tree, computes per-file SHA-256 via the **already-shipped** `computeDirDigest` primitive (`packages/manta-cli/src/library/dir-digest.ts:30`), and tars deterministically. `--publish` shells out to `npm publish` behind two interactive human confirmations. Reuses Phase 7a verbatim: `MantaPackageManifestSchema` (`packages/manta-skill-validator/src/manifest-schema.ts:139`), `computeDirDigest` (`dir-digest.ts:30`), the lockfile only for `mantaVersion` provenance (`packages/manta-cli/src/library/lockfile.ts:39`), and the metadata-allowlist sanitizer seed (`packages/manta-orchestrator/src/sanitize/metadata-allowlist.ts:17`).

**Tech Stack:** TypeScript, Zod schemas, Vitest, `tar` npm dep (already added in Phase 7a — `packages/manta-cli/package.json`), `node:crypto` for SHA-256, `execa` (already a dep) for `npm publish` / `git diff` shell-outs, the atomic-fs helpers re-exported from `@manta/bus` (`atomicReadJson` — verified re-exported, consumed by `lockfile.ts:4`). No new runtime dependency.

**Research:** `docs/research/phase-7-community-share-trust.md` (clone-C, ground truth — §0 trust model, §1 bundle anatomy, §1.4 sanitization table, §2 threat model). Cross-reference: `docs/research/phase-7-manta-library.md` (clone-A, the install side this bundle feeds). Sibling Phase 7c (clone-B `2026-05-28-phase-7c-auto-triggers.md`) owns the trigger taxonomy; this plan consumes B's **frozen** `CastManifest.metadata.trigger` / `cause_chain` field names for provenance (see §"Auto-share + trigger provenance" below).

**Spec anchors:** `docs/superpowers/specs/2026-05-06-manta-pattern-design.md:486` (`/manta share`), `:542`–`:543` (`/manta install` / `/manta share` surface), `:644` (Phase 7 community charter).

---

## 0. Headline trust decision (inherited from research §0 — restated so the plan is self-contained)

Phase 7b ships **MVTS-7**: *informed consent + best-effort static analysis*, explicitly **not** a security boundary. The honest message to a publishing author and an installing user is: *"a Manta bundle is a user-vetted dev tool, like a VS Code extension or an `npx` script. We make the contents inspectable, we statically scan for obviously hostile patterns and for secrets, but publishing/installing is equivalent to running an untrusted shell script — review the bundle, publish/install only from authors you trust."*

| Mitigation | Phase 7b ship? | Rationale |
|---|---|---|
| Default-deny sanitization of every bundled artifact | **Yes** | The core deliverable. Allowlist-driven, schema-first; fails closed when a source schema grows a new field. |
| Secret-format pre-publish scan (refuse on match) | **Yes** | Cheap regex pass over task text + approach-hint + worktree-diff. Hard-block, not warn. |
| `checksum.json` integrity witness + manifest-vs-disk verify | **Yes** | Catches accidental corruption; shifts the tamper surface from "edit one payload silently" to "rewrite the whole tarball, which `manta library preview` would surface." Not strong without signing — documented as such. |
| Static malicious-pattern scan of bundled JS (advisory + hard-block exceptions) | **Yes** | Reuses research §2 mitigation (d) pattern table. Only relevant when a bundle ships built dispatcher JS; Phase 7b modes are `basedOn` built-ins (no JS), so the scanner runs but usually finds nothing. Ships for forward-compat. |
| Two interactive confirms + npm-login + scope-ownership before `--publish` | **Yes** | The publish gate. Non-bypassable; auto-share (trigger-fired) can build a bundle but **cannot** publish (see §auto-share). |
| Code signing (author signs, install verifies) | **DEFERRED to Phase 8+** | Needs a key registry, revocation, rotation, lost-key recovery — none exists; "optional signing" without infra is theater. |
| Author reputation (install count, time-to-issue) | **DEFERRED to Phase 8+** | Needs a telemetry backend + privacy/legal story we do not have. |
| Runtime sandbox (mode runs in a jailed VM) | **DEFERRED indefinitely** | The clone subprocess the mode dispatches into has full shell access by design; sandboxing the dispatcher while the clone is unsandboxed is theater. Fix in-tree modes first if ever. |

**Out of scope (deferred):**

| Surface | Deferred to | One-line reason |
|---|---|---|
| Code signing / signature verification | Phase 8+ | No key registry / revocation / rotation infra exists. |
| Author reputation surfacing | Phase 8+ | No telemetry backend or privacy story. |
| Runtime sandbox for cast-time mode execution | Indefinite | The dispatched clone has full shell access; sandboxing only the dispatcher is theater. |
| `manta library search` / curated GitHub `manta-library/index` repo | Phase 8 | Discovery layer; additive on top of npm scope, no 7b dependency (research §5). |
| Auto-**publish** (trigger fires `npm publish` with no human) | Never (policy) | Violates §0 informed-consent; trigger-fired casts may build a local bundle, a human pulls the publish trigger (see §auto-share). |
| `screenshots/` bundle payload | Phase 8 | No cast produces screenshots in Phase 7; research §1.2 marks it optional/out-of-scope. |
| Extracting in-tree modes to first-party library packages | On community pull | Research §4.2 — bundled-now, extract-on-demand; YAGNI until a community fork needs it. |

---

## Cast-state inputs `manta share` reads (all read-only, all already on disk)

`manta share <cast-id>` is a *read-only consumer* of state other commands already wrote. Verified source surfaces (file:line):

| Input | On-disk location | Reader / schema | Cited |
|---|---|---|---|
| Cast manifest (roster, mode, policy, created_at) | `.manta/state/casts/<cast-id>.json` | `busPaths.castFile(castId)` | `packages/manta-bus/src/state/paths.ts:53` |
| Cast manifest schema (fields: `version`,`cast_id`,`mode`,`clones[]`,`policy`,`created_at`; `.strict()`) | — | `CastManifestSchema` | `packages/manta-bus/src/schema.ts:332-347` |
| Clone roster entry (`clone_id` + `assignment`) | — | `CastClonesEntrySchema` | `packages/manta-bus/src/schema.ts:325-330` |
| Snapshot (per clone) | `MANTA_SNAPSHOT_PATH` JSON written at spawn | `SnapshotSchema` | `packages/manta-snapshot/src/schema.ts:65-88` |
| Task contract (per clone) | `.manta/state/contracts/<clone-id>.json` | `busPaths.contractFile(cloneId)` + `TaskContractSchema` | `paths.ts:46-52`, `schema.ts:28-37` |
| Post-mortem markdown (per clone) | `docs/post-mortems/<day>-<cast>-<clone>.md` | `runPostMortem` filename `${day}-${cast}-${cloneId}.md` | `packages/manta-orchestrator/src/post-mortem.ts:77` |
| Event timeline | `.manta/state/events.jsonl` | `busPaths.eventsLog` + `events.ts:readAll()` | `paths.ts:36` |
| ZK notes (per clone) | `docs/zk/<slug>-<id>.md` | `fsMemoryWriters.zkWrite` writes here | `packages/manta-bus/src/memory-writers.ts:81-115` |
| Worktree diff | `git diff <merge-base>..<winning-branch>` | execa shell-out | new |
| Manta version (provenance) | `MANTA_CLI_VERSION` | `getMantaCliVersion()` | `packages/manta-cli/src/library/cli-version.ts:11` |

**Winning-clone resolution (no `winner` field exists in `CastManifestSchema`):** the cast manifest records the roster but not a winner. `manta share` resolves the shippable clone/branch in this order:
1. Explicit `--clone <id>` flag → use that clone's worktree branch.
2. Else, if `docs/merge-reviews/cast-<id>.md` exists (forking-realities verdict per CLAUDE.md post-cast ceremony) → parse the verdict's winning clone id.
3. Else (recon-swarm / no single winner / no shippable diff) → **error** `share_no_winner`, exit 21: *"recon-swarm casts produce no single shippable mode; pass `--clone <id>` to select one explicitly, or share a forking-realities/implementation cast."*

---

## Auto-share + trigger provenance (cross-cut with Phase 7c, coordinated via broadcast cast-1780019284984)

**Decision (broadcast to clone-B, 2026-05-29):** auto-share splits into two capabilities with different trust postures:

1. **Bundle generation MAY be trigger-fired.** A Phase 7c trigger may invoke `manta share <cast-id> --no-edit --non-interactive` to produce a *local* `*.manta-pkg.tar.gz` reviewable artifact. Non-interactive mode forbids `$EDITOR`, forbids `--accept-warnings` (any warning is fatal), and requires the static + secret scans to pass clean. No network.
2. **`--publish` is NEVER trigger-fired.** Publishing to npm always requires two interactive human confirmations + an npm-login check + a scope-ownership check. A trigger-fired cast publishing unreviewed code to a public registry violates §0 informed-consent. A human always pulls the publish trigger.

**Provenance contract (B's field names are FROZEN — copied verbatim per B's broadcast):** Phase 7c widens `CastManifestSchema` (`packages/manta-bus/src/schema.ts:332`, currently `.strict()` with no `metadata`) with an optional `metadata` block:

```ts
// OWNED BY Phase 7c — Phase 7b reads it READ-ONLY. Field names frozen.
metadata: {
  trigger: {
    trigger_name: string,        // 2..48 chars
    fired_at: number,            // int, nonneg, ms epoch
    parent_cast_id: CastId | null, // null = user-fired
  },
  cause_chain: string[],         // max 8, default []
} // optional on CastManifest
```

When `manta share` reads a cast manifest that carries `metadata.trigger`, it copies `trigger_name`, `fired_at` (relativised — see sanitization), `parent_cast_id`, and the **full** `cause_chain` (NOT stripped — it is the audit trail) into the bundle's `castOrigin.provenance` block (Task 1.1). When `metadata.trigger` is absent (user-fired cast), `castOrigin.provenance` is `null`. This plan does **not** depend on Phase 7c landing first: `castOrigin.provenance` is optional and reads `metadata?.trigger` defensively; if 7c never ships the field, provenance is always `null`.

---

## Chunk 1 — Sanitization pipeline + `castOrigin` manifest extension

This chunk lands the data layer: the `castOrigin` schema extension, the secret-format scanner, and one sanitizer module per bundled artifact, each returning `{ sanitized, warnings }`. No CLI command yet — Chunk 1 is pure functions over fixtures, end-to-end testable without spawning a cast. After Chunk 1: every sanitizer transforms a real on-disk artifact into a leak-free object and enumerates its warnings; `SharedBundleManifestSchema` parses.

**Build dependency chain:** Task 1.1 (`castOrigin` + manifest extension) + Task 1.2 (`SanitizationWarning` type + secret-scanner) → workspace build → Task 1.3 / 1.4 / 1.5 / 1.6 / 1.7 (the five artifact sanitizers; independent of each other, all consume 1.2). ~650 LOC. Chunk-completes when every Task 1.x is green and `pnpm gate` is clean.

### Task 1.1: `CastOriginSchema` + `SharedBundleManifestSchema`

**Files:**
- Create: `packages/manta-skill-validator/src/cast-origin-schema.ts`
- Create: `packages/manta-skill-validator/tests/cast-origin-schema.test.ts`
- Modify: `packages/manta-skill-validator/src/index.ts` — re-export `CastOriginSchema`, `SharedBundleManifestSchema`, and inferred types `CastOrigin`, `SharedBundleManifest`.

**Why:** The shipped `MantaPackageManifestSchema` (`packages/manta-skill-validator/src/manifest-schema.ts:139-154`) is **flat** — verified 2026-05-28: it has `schemaVersion`, `name`, `version`, `description`, `author` (a plain `z.string()`, *not* an object), `license`, `homepage?`, `repository?`, `mantaVersionCompat`, `contributes`, `deps`, `integrity?`. It has **no** `castOrigin`, **no** `declares`, **no** `mode` block, **no** `type` enum (research §1.3 proposed all of those; 7a shipped without them). Phase 7b's job is the *additive* extension: a shared bundle is a `MantaPackageManifest` **plus** a `castOrigin` block recording lineage. We must not mutate `MantaPackageManifestSchema` (it is a frozen 7a contract consumed by `validatePackage` and the install path) — instead we **intersect**.

**Schema:**

```ts
// packages/manta-skill-validator/src/cast-origin-schema.ts
import { z } from 'zod';
import { MantaPackageManifestSchema } from './manifest-schema.js';

// Mirrors the 7c-frozen trigger contract (CastManifest.metadata.trigger).
// Phase 7b reads it read-only; field names copied verbatim from clone-B's
// broadcast (cast-1780019284984). parent_cast_id null = user-fired.
const ProvenanceSchema = z
  .object({
    triggerName: z.string().min(2).max(48),
    // Relativised: ms offset from cast created_at, NOT wallclock epoch
    // (sanitization rule — see Task 1.3 timestamp handling).
    firedAtOffsetMs: z.number().int(),
    parentCastId: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(96).nullable(),
    causeChain: z.array(z.string().min(1).max(48)).max(8),
  })
  .strict();

export const CastOriginSchema = z
  .object({
    // CastId of the originating cast. Non-sensitive (a random id, not a path).
    castId: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(96),
    // One of the ten Mode literals (packages/manta-snapshot/src/schema.ts:4-15).
    castMode: z.enum([
      'recon-swarm', 'forking-realities', 'pair-programming', 'test-storm',
      'bug-hunt', 'refactor-wave', 'documentation-chase',
      'phantom-lance', 'council', 'decoy',
    ]),
    // `git remote get-url origin` of the authoring repo, or null if local-only.
    // SANITIZED: must be a URL, never a filesystem path (a local remote leaks
    // an absolute path — see Task 1.4 rule).
    originalRepoOrigin: z.string().url().nullable(),
    // getMantaCliVersion() at bundle time.
    originalMantaVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    // ISO 8601 UTC, second precision (no sub-second — reduces correlation).
    bundledAt: z.string().datetime({ offset: false }),
    // The winning clone id (resolved per §winning-clone-resolution).
    winningCloneId: z.string().min(1).max(64),
    // Trigger provenance, or null for user-fired casts. See §auto-share.
    provenance: ProvenanceSchema.nullable(),
  })
  .strict();

export type CastOrigin = z.infer<typeof CastOriginSchema>;

// A shared bundle's manifest = the shipped flat manifest + castOrigin.
// Intersection, NOT a rewrite of MantaPackageManifestSchema — that schema
// stays frozen for the install path.
export const SharedBundleManifestSchema = MantaPackageManifestSchema.and(
  z.object({ castOrigin: CastOriginSchema }),
);

export type SharedBundleManifest = z.infer<typeof SharedBundleManifestSchema>;
```

**Acceptance criteria:**
- `SharedBundleManifestSchema.parse(<valid 7a manifest + castOrigin>)` returns the intersected type.
- `SharedBundleManifestSchema.parse(<valid 7a manifest, no castOrigin>)` throws (castOrigin required for a *shared* bundle).
- `CastOriginSchema.parse(<originalRepoOrigin: "/Users/x/repo">)` throws — must be a URL or null, never a path.
- `CastOriginSchema.parse(<provenance: null>)` succeeds (user-fired cast).
- `CastOriginSchema.parse(<provenance.causeChain: [9 entries]>)` throws (max 8).
- `CastOriginSchema.parse(<castMode: "not-a-mode">)` throws.
- `ProvenanceSchema` field names match B's frozen contract: `triggerName`/`firedAtOffsetMs`/`parentCastId`/`causeChain` (camelCase manifest convention; B's wire-side `metadata.trigger.{trigger_name,fired_at,parent_cast_id}` + `cause_chain` map 1:1 — the mapping is asserted in Task 2.2 where the manifest is built).
- Unknown top-level field on `CastOriginSchema` throws (`.strict()`).

**Tests (100 % branch coverage of the new file + regression on the 7a-frozen edit):**

- [ ] **Step 0: Add the additive `castOrigin.optional()` field to the SHIPPED `MantaPackageManifestSchema`** (`packages/manta-skill-validator/src/manifest-schema.ts` ≈ line 139). Add a single optional field `castOrigin: CastOriginSchema.optional()`; import the new schema from `./cast-origin-schema.js`. This is THE only edit to a 7a-frozen file in all of Phase 7b — it is safe because the field is optional, but the regression coverage MUST land in this same step (see Step 0a) before any other Task 1.x change touches the validator.
- [ ] **Step 0a: Regression test on the 7a-frozen surface** — `packages/manta-skill-validator/tests/manifest-schema.test.ts` already exists; ADD three cases: (i) every existing fixture in `packages/manta-skill-validator/tests/fixtures/packages/` still parses with the augmented schema (loop over them, expect no throw); (ii) `MantaPackageManifestSchema.parse(<7a manifest without castOrigin>)` succeeds (back-compat); (iii) `MantaPackageManifestSchema.parse(<7a manifest with castOrigin: null>)` THROWS (`null` ≠ `undefined` under `.optional()`, and we want the optional field to be ABSENT in pre-7b bundles, not present-but-null). The validator-side `validatePackage` from 7a (Task 1.6) must continue to resolve pre-7b bundles without touching the install path.
- [ ] **Step 1: Write failing tests for the new `cast-origin-schema.ts`** — one per acceptance criterion, plus a round-trip happy-path with a fully-populated `castOrigin` including provenance.
- [ ] **Step 2: Run tests — verify FAIL** (`cd packages/manta-skill-validator && pnpm vitest run tests/cast-origin-schema.test.ts tests/manifest-schema.test.ts`).
- [ ] **Step 3: Implement `cast-origin-schema.ts`** per the schema above. Import `MantaPackageManifestSchema` from `./manifest-schema.js`.
- [ ] **Step 4: Re-export from validator package index** — both `CastOriginSchema` and `SharedBundleManifestSchema` PLUS the type re-exports.
- [ ] **Step 5: Run tests — verify PASS** + coverage check (100 % statements + branches on the new file; existing manifest-schema fixtures still all green).
- [ ] **Step 6: Build workspace** — `pnpm -r build` clean.
- [ ] **Step 7: Commit**

```
feat(skill-validator): CastOriginSchema + SharedBundleManifest + castOrigin.optional() on MantaPackageManifestSchema (Phase 7b)
```

**Why the Step 0 / 0a additive edit lives here (not in Task 2.1):** the schema-contradiction blocker from independent review (cast-1780019284984 reviewer) — Task 1.1 defined `SharedBundleManifestSchema` as the intersection of the 7a schema + required `castOrigin`, but Task 2.1's prose then admitted the install path's `.strict()` would throw on the unknown key and "resolved" it inline. That resolution is here, in Task 1.1's checklist, with its own regression coverage and acceptance criterion. Task 2.1's prose is corrected to point back here.

---

### Task 1.2: `SanitizationWarning` type + secret-format scanner

**Files:**
- Create: `packages/manta-cli/src/share/types.ts`
- Create: `packages/manta-cli/src/share/secret-scanner.ts`
- Create: `packages/manta-cli/src/share/tests/secret-scanner.test.ts`

**Why:** Every sanitizer (Tasks 1.3–1.7) returns the same shape: the sanitized artifact plus a `SanitizationWarning[]`. The `manta share` command (Chunk 2) aggregates all warnings, renders them, and blocks publish until either resolved or `--accept-warnings` is passed (interactive only — never in `--non-interactive` / trigger mode). The secret-scanner is the one **hard-block** rule (research §1.4: task text + worktree-diff refuse to bundle on a secret-format match; not a warning, a fatal). Centralised so the regex set lives in one tested place.

**Exported interface:**

```ts
// packages/manta-cli/src/share/types.ts
export type SanitizationSeverity = 'warning' | 'fatal';

export interface SanitizationWarning {
  /** Stable rule id, e.g. "snapshot.parentWorktree", "zk.body.path". */
  rule: string;
  /** Which artifact + field this came from, for the rendered report. */
  source: string;
  /** Human-readable description of what was found and what was done. */
  message: string;
  severity: SanitizationSeverity;
  /** For path/secret findings: the matched substring, already masked
   *  (first 4 chars + "…") so the report itself never re-leaks it. */
  maskedMatch?: string;
}
```

```ts
// packages/manta-cli/src/share/secret-scanner.ts
export interface SecretFinding {
  /** Provider label, e.g. "aws-access-key", "openai-key", "github-pat". */
  kind: string;
  /** Masked sample (first 4 chars + "…") — never the full token. */
  masked: string;
}

/**
 * Scan arbitrary text for common secret formats. Returns every match.
 * Used by the task-text, approach-hint, and worktree-diff sanitizers as a
 * HARD BLOCK (research §1.4): a match refuses the bundle. False negatives
 * are acceptable — this is best-effort, not a security boundary (§0).
 */
export function scanForSecrets(text: string): SecretFinding[];

/** Mask a secret for safe inclusion in a report. */
export function maskSecret(s: string): string;
```

**Secret-format regex set (research §1.4 + extended — every rule is a HARD BLOCK):**

| Provider | Pattern |
|---|---|
| AWS access key | `AKIA[0-9A-Z]{16}` |
| OpenAI / Anthropic-style key | `sk-[A-Za-z0-9_-]{20,}` |
| GitHub PAT (classic) | `ghp_[A-Za-z0-9]{36}` |
| GitHub fine-grained PAT | `github_pat_[A-Za-z0-9_]{40,}` |
| Slack token | `xox[baprs]-[A-Za-z0-9-]{10,}` |
| Google API key | `AIza[0-9A-Za-z_-]{35}` |
| Generic private key header | `-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----` |
| JWT (three base64url segments) | `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` |
| Generic `KEY=`/`TOKEN=`/`SECRET=`/`PASSWORD=` assignment with a long value | `(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}` |

**Acceptance criteria:**
- `scanForSecrets('AKIAIOSFODNN7EXAMPLE')` returns one finding `kind: 'aws-access-key'`, `masked: 'AKIA…'`.
- `scanForSecrets('export OPENAI_KEY=sk-abc123…')` returns ≥1 finding; `masked` never contains the full token.
- `scanForSecrets('a normal sentence about refactoring')` returns `[]`.
- `scanForSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nMIIE…')` returns one finding.
- `maskSecret('ghp_0123456789abcdef0123456789abcdef0123')` returns `'ghp_…'` and never the rest.
- A JWT-shaped string is detected.
- Each provider regex has at least one positive and one negative test.

**Tests:**

- [ ] **Step 1: Write failing tests** — table-driven (provider × positive/negative). Verify masking never re-leaks.
- [ ] **Step 2: Run tests — verify FAIL** (`cd packages/manta-cli && pnpm vitest run src/share/tests/secret-scanner.test.ts`).
- [ ] **Step 3: Implement `types.ts` + `secret-scanner.ts`.** Compile the regex set once at module load; `maskSecret` keeps first 4 chars.
- [ ] **Step 4: Run tests — verify PASS.**
- [ ] **Step 5: Commit**

```
feat(cli): SanitizationWarning type + secret-format scanner for share bundles
```

---

### Task 1.3: Snapshot sanitizer

**Files:**
- Create: `packages/manta-cli/src/share/sanitize-snapshot.ts`
- Create: `packages/manta-cli/src/share/tests/sanitize-snapshot.test.ts`
- Create: `packages/manta-snapshot/src/sanitized-schema.ts` — `SanitizedSnapshotSchema` (the leak-free output shape).
- Modify: `packages/manta-snapshot/src/index.ts` — re-export `SanitizedSnapshotSchema`, `SanitizedSnapshot`.

**Why:** The snapshot is the richest leak surface. Verified fields of `SnapshotSchema` (`packages/manta-snapshot/src/schema.ts:65-88`): `version`, `castId`, `parentSessionId` (Claude Code internal session id — **drop**), `parentPid` (host PID — **drop**), `createdAt`, `taskContract` (sanitized separately, Task 1.4), `recentMessages` (raw transcript — **drop entirely**, research §1.4 "highest risk"), `activeTodos`, `openFiles[].path` (relativise or drop), `parentWorktree` (absolute path — **redact**), `cloneWorktree` (absolute path — **redact**), `mode`, `budget` (dollar amounts — **drop**), `ttlSeconds`, `siblingCloneIds`, `sessionMode`, `sessionId?` (internal — **drop**).

**Sanitization rules (default-deny — `SanitizedSnapshotSchema` omits dropped fields entirely):**

| Field (schema.ts:line) | Rule | Warning? |
|---|---|---|
| `parentSessionId` (:69) | Drop | no |
| `parentPid` (:70) | Drop | no |
| `parentWorktree` (:76) | Replace with literal `<worktree>` | no |
| `cloneWorktree` (:77) | Replace with literal `<worktree>/clone-<id>` | no |
| `recentMessages` (:73) | Drop entirely (raw transcript) | warn if non-empty: "dropped N transcript messages" |
| `budget` (:79) | Drop entirely | no |
| `sessionId?` (:83) | Drop | no |
| `openFiles[].path` (:75/:53-56) | Relativise to repo root; if outside repo, drop the entry | warn per dropped entry |
| `createdAt` (:71) | Keep (ISO already; non-sensitive) | no |
| `castId`,`mode`,`taskContract`,`activeTodos`,`siblingCloneIds`,`ttlSeconds`,`sessionMode`,`version` | Keep (taskContract sanitized by Task 1.4) | — |

**Timestamp note:** `createdAt` is the anchor for relativising other artifacts' wallclock epochs (post-mortem, events). The snapshot itself keeps `createdAt` as the ISO origin; downstream artifacts express times as `+Nms` offsets from it.

**Exported interface:**

```ts
// packages/manta-cli/src/share/sanitize-snapshot.ts
import type { Snapshot } from '@manta/snapshot';
import type { SanitizedSnapshot } from '@manta/snapshot';
import type { SanitizationWarning } from './types.js';

export function sanitizeSnapshot(s: Snapshot): {
  sanitized: SanitizedSnapshot;
  warnings: SanitizationWarning[];
};
```

**Acceptance criteria:**
- Input snapshot with absolute `parentWorktree` → output has `parentWorktree: '<worktree>'`, no warning.
- Input with non-empty `recentMessages` → output omits the field, one warning `rule: 'snapshot.recentMessages'`.
- Input with `openFiles: [{ path: '/etc/passwd', reason: 'x' }]` → entry dropped, one warning; `[{ path: '<repoRoot>/src/a.ts', … }]` → relativised to `src/a.ts`.
- Output omits `parentPid`, `parentSessionId`, `budget`, `sessionId` entirely.
- `SanitizedSnapshotSchema.parse(output)` succeeds for every test (the sanitizer output always validates).
- `SanitizedSnapshotSchema` rejects any of the dropped fields if present (`.strict()`).

**Tests:**

- [ ] **Step 1: Write failing tests** — fixture snapshots covering each rule. Use a realistic absolute worktree path in fixtures.
- [ ] **Step 2: Run tests — verify FAIL** (`cd packages/manta-cli && pnpm vitest run src/share/tests/sanitize-snapshot.test.ts`).
- [ ] **Step 3: Implement `SanitizedSnapshotSchema`** in `@manta/snapshot` (derive from `SnapshotSchema` via `.omit({ parentSessionId, parentPid, recentMessages, budget, sessionId })` then override `parentWorktree`/`cloneWorktree` to literal markers). Build the package.
- [ ] **Step 4: Implement `sanitize-snapshot.ts`.**
- [ ] **Step 5: Run tests — verify PASS.**
- [ ] **Step 6: Commit**

```
feat(cli): snapshot sanitizer — drop transcript/PID/session/budget, redact worktree paths
```

---

### Task 1.4: Task-contract sanitizer

**Files:**
- Create: `packages/manta-cli/src/share/sanitize-task-contract.ts`
- Create: `packages/manta-cli/src/share/tests/sanitize-task-contract.test.ts`

**Why:** The on-disk task contract lives at `.manta/state/contracts/<clone-id>.json` (`packages/manta-bus/src/state/paths.ts:46-52`), schema `TaskContractSchema` (`packages/manta-snapshot/src/schema.ts:28-37`). Verified fields: `cloneId`, `mode`, `task` (author-written — secret-scan, HARD BLOCK on match), `scope` (`allowedPaths`/`forbiddenPaths`/`maxFilesChanged` — relativise paths), `approachHint` (nullable, author-written — secret-scan), `siblingClones`, `deadlineSeconds`, `sessionMode`.

**Sanitization rules:**

| Field | Rule | Severity |
|---|---|---|
| `task` | `scanForSecrets` → **fatal** on match (refuse bundle); else keep | fatal |
| `approachHint` | `scanForSecrets` → **fatal** on match; else keep | fatal |
| `scope.allowedPaths[]` | Relativise each to repo root; if outside repo, drop entry + warn | warning |
| `scope.forbiddenPaths[]` | Same relativisation | warning |
| `scope.maxFilesChanged`, `cloneId`, `mode`, `siblingClones`, `deadlineSeconds`, `sessionMode` | Keep (non-sensitive) | — |

**Exported interface:**

```ts
// packages/manta-cli/src/share/sanitize-task-contract.ts
import type { TaskContract } from '@manta/snapshot';
import type { SanitizationWarning } from './types.js';

export function sanitizeTaskContract(
  c: TaskContract,
  opts: { repoRoot: string },
): { sanitized: TaskContract; warnings: SanitizationWarning[] };
```

**Acceptance criteria:**
- A task containing `AKIA…` → throws `ShareSanitizationError('secret_in_task_contract', { findings })` (or returns a `fatal`-severity warning that the share command treats as a hard block — pick the throw form for fail-closed clarity; documented in test).
- `scope.allowedPaths: ['/abs/outside/repo']` → entry dropped, warning emitted.
- `scope.allowedPaths: ['<repoRoot>/src']` → relativised to `src`.
- `approachHint: null` → passes through as null.
- A clean contract → no warnings, `sanitized` equals input modulo path relativisation.

**Tests:**

- [ ] **Step 1: Write failing tests** — clean contract, secret-in-task, secret-in-approachHint, out-of-repo path, repo-relative path.
- [ ] **Step 2: Run tests — verify FAIL** (`cd packages/manta-cli && pnpm vitest run src/share/tests/sanitize-task-contract.test.ts`).
- [ ] **Step 3: Implement `sanitize-task-contract.ts`** reusing `scanForSecrets` from Task 1.2.
- [ ] **Step 4: Run tests — verify PASS.**
- [ ] **Step 5: Commit**

```
feat(cli): task-contract sanitizer — secret hard-block + path relativisation
```

---

### Task 1.5: Post-mortem markdown sanitizer

**Files:**
- Create: `packages/manta-cli/src/share/sanitize-post-mortem.ts`
- Create: `packages/manta-cli/src/share/tests/sanitize-post-mortem.test.ts`

**Why — and a key correction to research §1.4:** Research §1.4's table assumed `events[].payload` needs a recursive path-scan at share time. **Verified false as of 2026-05-28:** `renderEventPayload` (`packages/manta-orchestrator/src/post-mortem.ts:156-219`) **already** applies a per-type allowlist projection with default-deny (bug #29 + bug #46 fixes — the comment at `:141-155` literally cites "Post-mortems are then bundled by `manta share` (Phase 7), so a leak here ships externally" as the motivation). So the event-timeline payloads in the rendered markdown are **already** leak-free. What is **not** yet sanitized is the post-mortem *header* (`renderMarkdown` at `:97-121`): `Worktree:` line (`:102`, absolute path), `Parent PID:` line (`:103`), and the three epoch-ms timestamp lines (`:104-106`). Phase 7b operates on the **rendered markdown file on disk** (share reads the file, not the live `BusEvent[]`), so the sanitizer is a line-oriented markdown transform of those header fields plus a defense-in-depth full-text path/secret scan.

**Sanitization rules (operate on the markdown text read from `docs/post-mortems/<file>.md`):**

| Markdown line (rendered by post-mortem.ts:line) | Rule | Severity |
|---|---|---|
| `- Worktree: <abs>` (:102) | Replace value with `<worktree>` | warning |
| `- Parent PID: <n>` (:103) | Drop the whole line | none |
| `- Registered at (epoch ms): <n>` (:104) | Replace with `+0ms` (anchor) | none |
| `- Last heartbeat at (epoch ms): <n>` (:105) | Replace with `+<delta>ms` from registered | none |
| `- Died at (epoch ms): <n>` (:106) | Replace with `+<delta>ms` or `unknown` | none |
| `## Metadata` block (:111-120) | Already allowlisted by `redactPostMortemMetadata` at render time — leave intact | none |
| `## Event timeline` body (:128-136) | Already projected by `renderEventPayload` — leave intact | none |
| Full-text defense-in-depth | `scanForSecrets` over the whole body → **fatal** on match; path-regex (`^/`, `~/`, parent-worktree prefix) → warn per remaining absolute path | fatal / warning |

**Exported interface:**

```ts
// packages/manta-cli/src/share/sanitize-post-mortem.ts
import type { SanitizationWarning } from './types.js';

export function sanitizePostMortemMarkdown(
  markdown: string,
  opts: { repoRoot: string },
): { sanitized: string; warnings: SanitizationWarning[] };
```

**Acceptance criteria:**
- A post-mortem with `- Worktree: /Users/x/repo/.manta/worktrees/clone-A` → output line is `- Worktree: <worktree>`.
- The `- Parent PID:` line is removed.
- Epoch-ms timestamp lines become relative offsets; `Died at … unknown` stays `unknown`.
- A metadata block already containing only `cast_id`/`cast_mode` passes through unchanged (no double-sanitisation).
- A body containing a leaked `AKIA…` (e.g. a clone wrote it into a ZK summary that got echoed) → throws fatal.
- A remaining stray absolute path not on a known header line → one warning, value masked.

**Tests:**

- [ ] **Step 1: Write failing tests** — use a fixture post-mortem generated by feeding a fake `CloneRecord` + events through the real `renderMarkdown` (import it; keeps the fixture honest to the real renderer's output shape).
- [ ] **Step 2: Run tests — verify FAIL** (`cd packages/manta-cli && pnpm vitest run src/share/tests/sanitize-post-mortem.test.ts`).
- [ ] **Step 3: Implement `sanitize-post-mortem.ts`** — line-oriented transform + full-text scan.
- [ ] **Step 4: Run tests — verify PASS.**
- [ ] **Step 5: Commit**

```
feat(cli): post-mortem markdown sanitizer — header redaction + defense-in-depth scan
```

---

### Task 1.6: ZK-note sanitizer

**Files:**
- Create: `packages/manta-cli/src/share/sanitize-zk-note.ts`
- Create: `packages/manta-cli/src/share/tests/sanitize-zk-note.test.ts`

**Why:** ZK notes live at `docs/zk/<slug>-<id>.md` (`packages/manta-bus/src/memory-writers.ts:81-115`). Verified frontmatter (`:92-101`): `id`, `title`, `clone_id`, `created_at` (epoch ms — replace with `castOrigin.bundledAt` ISO), `tags`. Body is user/clone-written prose — research §1.4: scan for paths and secrets, **warn** (do not auto-redact, because prose may be inseparable from the path reference) — the author must accept warnings before publish.

**Sanitization rules:**

| Source (memory-writers.ts:line) | Field | Rule | Severity |
|---|---|---|---|
| `:96` | `created_at` (epoch ms) | Replace with `castOrigin.bundledAt` ISO | none |
| `:94` | `clone_id` | Keep | — |
| `:93`,`:97` | `id`, `tags` | Keep | — |
| `:93` | `title` | Keep, but `scanForSecrets` → fatal on match | fatal |
| body | prose | `scanForSecrets` → **fatal**; path-regex → **warn** (no auto-redact) | fatal / warning |

**Exported interface:**

```ts
// packages/manta-cli/src/share/sanitize-zk-note.ts
import type { SanitizationWarning } from './types.js';

export function sanitizeZkNote(
  markdown: string,
  opts: { repoRoot: string; bundledAt: string },
): { sanitized: string; warnings: SanitizationWarning[] };
```

**Acceptance criteria:**
- `created_at: 1780019289206` frontmatter line → replaced with `created_at: <bundledAt ISO>`.
- A body mentioning `/Users/x/secret-project/notes` → one warning, value masked, body text **unchanged** (no auto-redact).
- A body containing `sk-…` → throws fatal.
- Frontmatter `tags`, `clone_id`, `id`, `title` preserved.
- A clean note → no warnings, only `created_at` rewritten.

**Tests:**

- [ ] **Step 1: Write failing tests** — fixture ZK note built by the real `fsMemoryWriters.zkWrite` shape; clean / path-in-body / secret-in-body / secret-in-title variants.
- [ ] **Step 2: Run tests — verify FAIL** (`cd packages/manta-cli && pnpm vitest run src/share/tests/sanitize-zk-note.test.ts`).
- [ ] **Step 3: Implement `sanitize-zk-note.ts`.**
- [ ] **Step 4: Run tests — verify PASS.**
- [ ] **Step 5: Commit**

```
feat(cli): ZK-note sanitizer — created_at rewrite + body path/secret scan (warn-no-redact)
```

---

### Task 1.7: Event-timeline + worktree-diff sanitizers

**Files:**
- Create: `packages/manta-cli/src/share/sanitize-events.ts`
- Create: `packages/manta-cli/src/share/sanitize-worktree-diff.ts`
- Create: `packages/manta-cli/src/share/tests/sanitize-events.test.ts`
- Create: `packages/manta-cli/src/share/tests/sanitize-worktree-diff.test.ts`

**Why — events:** The bundle ships a sanitized `events.jsonl` (research §1.2). The events come from `.manta/state/events.jsonl` (`paths.ts:36`), schema `BusEvent` (`packages/manta-bus/src/state/events.ts`). Crucially, the on-disk `events.jsonl` is the **raw** event log — its `payload` is *not* pre-sanitized (only the post-mortem *render* projects it). So the event sanitizer must apply the **same per-type allowlist** that `renderEventPayload` (`post-mortem.ts:156-219`) uses — re-implemented as a payload projection over the raw `BusEvent[]`, filtered to the winning clone, with wallclock `ts` relativised to `castOrigin` offsets. **Reuse note:** factor the per-type allowlist table out of `post-mortem.ts` is tempting but out of scope (it would touch a frozen orchestrator file); instead Phase 7b ships an *independent* projection keyed by the same event types, and a test asserts the two tables agree on every event type (drift guard).

**Why — worktree-diff:** The diff is `git diff <merge-base>..<winning-branch>` (the actual code change). Inherent risk: the diff may contain hardcoded credentials. Rule (research §1.4): `scanForSecrets` over the full diff → **fatal** on match. No path relativisation (diffs are repo-relative by construction). This is the rule that makes `--confirm-no-secrets` mandatory for publish (Chunk 3).

**Exported interfaces:**

```ts
// packages/manta-cli/src/share/sanitize-events.ts
import type { BusEvent } from '@manta/bus';
import type { SanitizationWarning } from './types.js';

export function sanitizeEvents(
  events: BusEvent[],
  opts: { winningCloneId: string; castCreatedAt: number },
): { sanitized: Array<Record<string, unknown>>; warnings: SanitizationWarning[] };

// packages/manta-cli/src/share/sanitize-worktree-diff.ts
export function sanitizeWorktreeDiff(
  diff: string,
): { sanitized: string; warnings: SanitizationWarning[] }; // throws on secret match
```

**Acceptance criteria — events:**
- A raw `broadcast` event with a free-form `body` → projected to `{ event_type }` only (matches `renderEventPayload` `:173`).
- A `heartbeat` event with a `progress` field → projected to `{ state }` only (`progress` dropped, matching bug #46 fix at `:163-172`).
- An unknown event type → `<payload omitted>` (default-deny, matching `:216-217`).
- `ts` values become `+<delta>ms` offsets from `castCreatedAt`.
- Events from clones other than `winningCloneId` are excluded.
- **Drift-guard test:** for every event type the projection handles, assert the allowlisted key set equals the one `renderEventPayload` uses (import a shared list, or assert against a hardcoded table copied from `post-mortem.ts:159-218` with a comment pinning the source line).

**Acceptance criteria — worktree-diff:**
- A diff containing `+const KEY = "AKIA…"` → throws `ShareSanitizationError('secret_in_worktree_diff', { findings })`.
- A clean diff → passes through unchanged, no warnings.

**Tests:**

- [ ] **Step 1: Write failing tests** for both files.
- [ ] **Step 2: Run tests — verify FAIL** (both test files).
- [ ] **Step 3: Implement both sanitizers.** Events: switch over `e.type` mirroring `post-mortem.ts:159-218`. Diff: single `scanForSecrets` pass.
- [ ] **Step 4: Run tests — verify PASS.**
- [ ] **Step 5: Commit**

```
feat(cli): event-timeline + worktree-diff sanitizers (per-type projection + secret hard-block)
```

---

### Chunk 1 complete when

- Every Task 1.x is green.
- `pnpm gate` clean (typecheck + lint + test).
- Each sanitizer is independently unit-tested against a realistic fixture.
- The events drift-guard test passes (projection agrees with `renderEventPayload`).
- `SharedBundleManifestSchema` round-trips a fully-populated bundle manifest.

---

## Chunk 2 — Bundle assembly + integrity + `manta share` (local bundle, no publish)

This chunk glues Chunk 1's sanitizers into the `manta share <cast-id>` command, producing a verified `*.manta-pkg.tar.gz` on disk. **No npm publish yet** — that is Chunk 3. After Chunk 2: `manta share <cast-id> --clone <id>` produces a sanitized, checksummed, schema-valid bundle the existing Phase 7a `manta install ./bundle.tgz` can consume.

**Build dependency chain:** Task 2.1 (bundle assembler + checksum) → Task 2.2 (`CastOrigin` builder from cast state) → Task 2.3 (README auto-gen) → Task 2.4 (`manta share` command — consumes 2.1/2.2/2.3 + all Chunk 1 sanitizers) → Task 2.5 (`bin/manta.ts` registration + errors widening). ~550 LOC.

### Task 2.1: Bundle assembler + `checksum.json`

**Files:**
- Create: `packages/manta-cli/src/share/bundle-assembler.ts`
- Create: `packages/manta-cli/src/share/tests/bundle-assembler.test.ts`

**Why:** Takes the sanitized artifacts + the manifest and writes the unpacked tree (research §1.2 layout), computes `checksum.json` (sha256 of every other file), and tars it deterministically. **Integrity reuse:** `checksum.json` is the per-file map; the canonical directory hash reuses the **shipped** `computeDirDigest` (`packages/manta-cli/src/library/dir-digest.ts:30`) — same algorithm Phase 7a's `verifyLibraryIntegrity` (`packages/manta-cli/src/library/integrity.ts:58`) checks at cast time, so a shared-then-installed bundle's `directoryDigest` is computed by one shared primitive. No new hashing code.

**`checksum.json` schema (Zod, `.strict()`):**

```ts
// in bundle-assembler.ts
{
  algorithm: 'sha256',
  // relative-path -> hex sha256 of file bytes. Excludes checksum.json itself.
  files: Record<string, string /* 64-hex */>,
}
```

**Unpacked tree (research §1.2 — only the artifacts Phase 7b actually produces):**

```
<name>-<version>/
├─ manta-package.json    (SharedBundleManifest — manifest + castOrigin)
├─ README.md             (auto-generated, Task 2.3)
├─ LICENSE               (copied from repo root, or templated from manifest.license)
├─ task-contract.json    (sanitized — Task 1.4)
├─ snapshot.json         (sanitized — Task 1.3)
├─ post-mortems/<clone>.md  (sanitized — Task 1.5)
├─ zk-notes/<slug>-<id>.md  (sanitized — Task 1.6)
├─ events.jsonl          (sanitized — Task 1.7)
├─ worktree-diff.patch   (sanitized — Task 1.7)
├─ skills/<name>/SKILL.md (optional — if the cast added/modified a skill)
└─ checksum.json         (this task)
```

**Note on manifest filename:** the install path (Phase 7a `validatePackage`) reads `<packageRoot>/manta-package.json` (verified: research §6 / 7a Task 1.6 algorithm step 1). The bundle's manifest file is named `manta-package.json` and must satisfy **both** the shipped `MantaPackageManifestSchema` (so install works) **and** carry `castOrigin` (so `SharedBundleManifestSchema` validates). The compatibility resolution — adding `castOrigin: CastOriginSchema.optional()` to `MantaPackageManifestSchema` so the install path tolerates the extra key — is **landed in Task 1.1 Steps 0/0a** (one source of truth for the frozen-file edit, with regression coverage). The two schemas relate as: base `MantaPackageManifestSchema` has `castOrigin` optional (back-compat for non-shared 7a installs); `SharedBundleManifestSchema = MantaPackageManifestSchema.and(z.object({ castOrigin: CastOriginSchema }))` makes it required *for shared bundles only*. The bundle ships exactly one `manta-package.json`.

**Exported interface:**

```ts
// packages/manta-cli/src/share/bundle-assembler.ts
export interface BundleArtifacts {
  manifest: SharedBundleManifest;
  readme: string;
  license: string;
  taskContract: unknown;      // sanitized
  snapshot: unknown;          // sanitized
  postMortems: Array<{ cloneId: string; markdown: string }>;
  zkNotes: Array<{ filename: string; markdown: string }>;
  eventsJsonl: string;        // sanitized, one JSON object per line
  worktreeDiff: string;       // sanitized
  skills?: Array<{ relPath: string; content: string }>;
}

export interface AssembledBundle {
  /** Path to the .tar.gz. */
  tarballPath: string;
  /** Path to the unpacked staging dir (kept for `--no-tar` / inspection). */
  unpackedDir: string;
  /** computeDirDigest of the unpacked tree (sha256-<base64>). */
  directoryDigest: string;
  /** Per-file checksum map written to checksum.json. */
  checksums: Record<string, string>;
}

export async function assembleBundle(
  artifacts: BundleArtifacts,
  opts: { outDir: string; packageBaseName: string },
): Promise<AssembledBundle>;

/** Recompute checksums from an unpacked dir and compare to its checksum.json.
 *  Used by Chunk 3 publish preflight and re-usable by `manta library preview`. */
export async function verifyBundleChecksums(
  unpackedDir: string,
): Promise<{ ok: true } | { ok: false; mismatches: string[] }>;
```

**Deterministic tar:** use the `tar` npm dep (already in `package.json`) with `{ portable: true, mtime: <castOrigin.bundledAt as Date>, gzip: true, cwd: parentOfUnpacked }` and a **sorted** file list, so two assembles of the same artifacts produce byte-identical tarballs (mirrors the `dir-digest.ts` determinism guarantee).

**Acceptance criteria:**
- `assembleBundle(<artifacts>, { outDir, packageBaseName: 'foo-1.0.0' })` writes `foo-1.0.0.manta-pkg.tar.gz` + an unpacked `foo-1.0.0/` dir.
- `checksum.json` contains a sha256 for every file except itself; `verifyBundleChecksums` returns `{ ok: true }`.
- Mutating one byte of any payload file then `verifyBundleChecksums` → `{ ok: false, mismatches: [<that file>] }`.
- `directoryDigest` equals `computeDirDigest(unpackedDir)` (the shipped primitive) — assert by importing both.
- Two assembles of identical artifacts produce byte-identical tarballs (determinism).
- The unpacked `manta-package.json` parses against `SharedBundleManifestSchema`.

**Tests:**

- [ ] **Step 1: Write failing tests** with a fully-populated `BundleArtifacts` fixture.
- [ ] **Step 2: Run tests — verify FAIL.**
- [ ] **Step 3: Implement `bundle-assembler.ts`.** Reuse `computeDirDigest` from `../library/dir-digest.js`.
- [ ] **Step 4: Run tests — verify PASS.**
- [ ] **Step 5: Commit**

```
feat(cli): bundle assembler + checksum.json (reuses computeDirDigest) for share bundles
```

---

### Task 2.2: `CastOrigin` builder from live cast state

**Files:**
- Create: `packages/manta-cli/src/share/build-cast-origin.ts`
- Create: `packages/manta-cli/src/share/tests/build-cast-origin.test.ts`

**Why:** Reads the cast manifest (`busPaths.castFile(castId)` → `CastManifestSchema`, `schema.ts:332`), the winning clone id, `getMantaCliVersion()` (`cli-version.ts:11`), and `git remote get-url origin` to build the `castOrigin` block. **This is where B's frozen `metadata.trigger` fields are mapped 1:1** to `castOrigin.provenance` (camelCase). Reads `metadata?.trigger` defensively — null when absent (user-fired or pre-7c manifest).

**Field mapping (wire → manifest, asserted by test):**

| 7c CastManifest wire field | castOrigin.provenance field |
|---|---|
| `metadata.trigger.trigger_name` | `triggerName` |
| `metadata.trigger.fired_at` (ms epoch) | `firedAtOffsetMs` (= `fired_at - cast.created_at`) |
| `metadata.trigger.parent_cast_id` | `parentCastId` |
| `metadata.cause_chain` (full, NOT stripped) | `causeChain` |

**Other fields:** `castId` ← `cast.cast_id`; `castMode` ← `cast.mode`; `originalRepoOrigin` ← `git remote get-url origin` (validate it is a URL; if it is a local path or absent → `null` + warning, never leak the path); `originalMantaVersion` ← `getMantaCliVersion()`; `bundledAt` ← current time as ISO second-precision UTC; `winningCloneId` ← resolved winner.

**Exported interface:**

```ts
// packages/manta-cli/src/share/build-cast-origin.ts
import type { CastOrigin } from '@manta/skill-validator';
import type { SanitizationWarning } from './types.js';

export interface BuildCastOriginInput {
  castManifest: unknown;        // parsed CastManifest (read-only)
  winningCloneId: string;
  repoRoot: string;
  bundledAt: string;            // ISO — injected for determinism/testability
  gitRemoteOrigin: string | null; // injected (resolved by command via execa)
}

export function buildCastOrigin(
  input: BuildCastOriginInput,
): { castOrigin: CastOrigin; warnings: SanitizationWarning[] };
```

**Acceptance criteria:**
- A user-fired cast (no `metadata`) → `provenance: null`.
- A trigger-fired cast with `metadata.trigger` → `provenance` populated; `firedAtOffsetMs === fired_at - created_at`; `causeChain` copied **verbatim** (length preserved, not truncated).
- `gitRemoteOrigin: '/Users/x/repo'` (a path, not a URL) → `originalRepoOrigin: null` + one warning; the path never appears in output.
- `gitRemoteOrigin: 'https://github.com/u/r.git'` → `originalRepoOrigin` set to it.
- `gitRemoteOrigin: null` → `originalRepoOrigin: null`, no warning (absent remote is normal).
- Output validates against `CastOriginSchema`.

**Tests:**

- [ ] **Step 1: Write failing tests** — user-fired / trigger-fired / path-remote / url-remote / no-remote variants. Use a synthetic CastManifest with the 7c `metadata.trigger` shape (forward-compat; field names from B's frozen contract).
- [ ] **Step 2: Run tests — verify FAIL.**
- [ ] **Step 3: Implement `build-cast-origin.ts`.**
- [ ] **Step 4: Run tests — verify PASS.**
- [ ] **Step 5: Commit**

```
feat(cli): castOrigin builder — maps 7c trigger provenance verbatim, path-safe git remote
```

---

### Task 2.3: README auto-generation

**Files:**
- Create: `packages/manta-cli/src/share/generate-readme.ts`
- Create: `packages/manta-cli/src/share/tests/generate-readme.test.ts`

**Why:** Research §1.6 — README auto-generated from the cast post-mortem + ZK notes. Sections: *Overview / What this mode does / Cast lineage / Compat / Installation / Author / License*. Author may edit before publish (`$EDITOR`, unless `--no-edit`). The generator is pure (markdown in → markdown out); the `$EDITOR` open is the command's job (Task 2.4).

**Inputs:** the **sanitized** post-mortem markdown (so no leaks bleed into the README), the **sanitized** ZK note bodies (first paragraph of each), the `SharedBundleManifest` (for name/version/description/compat/author/license), the `castOrigin` (for lineage), and diff stats (files changed, +/- lines — computed from the sanitized diff).

**Exported interface:**

```ts
// packages/manta-cli/src/share/generate-readme.ts
export interface ReadmeInput {
  manifest: SharedBundleManifest;
  castOrigin: CastOrigin;
  sanitizedPostMortem: string;
  sanitizedZkFirstParagraphs: string[];
  diffStats: { filesChanged: number; insertions: number; deletions: number };
}
export function generateReadme(input: ReadmeInput): string;
```

**Acceptance criteria:**
- Output contains all seven sections.
- Installation section shows `manta install @<scope>/<name>@<version>` derived from manifest.
- Cast lineage shows `castMode` + (if provenance) `triggerName`; user-fired casts omit the trigger line.
- No absolute paths or secrets in output (it consumes only sanitized inputs — assert by running `scanForSecrets` over the output in a test).
- Deterministic: same input → same output.

**Tests:**

- [ ] **Step 1: Write failing tests** — section presence, install string, lineage with/without provenance, scan-clean.
- [ ] **Step 2: Run tests — verify FAIL.**
- [ ] **Step 3: Implement `generate-readme.ts`.**
- [ ] **Step 4: Run tests — verify PASS.**
- [ ] **Step 5: Commit**

```
feat(cli): README auto-generation from sanitized cast artifacts
```

---

### Task 2.4: `manta share <cast-id>` command (local bundle)

**Files:**
- Create: `packages/manta-cli/src/commands/share.ts`
- Create: `packages/manta-cli/tests/commands/share.test.ts`
- Modify: `packages/manta-cli/src/index.ts` — re-export `runShareCommand`, `ShareError`.

**Why:** Orchestrates the full pipeline: resolve winner → read all cast artifacts → sanitize each → build castOrigin → assemble manifest → generate README → assemble bundle → report. **Chunk 2 ships only the local-bundle path** (no `--publish`; that is Chunk 3). The point of the split: Chunk 2 is one linear pipeline easy to test end-to-end against a fixture cast directory; Chunk 3 adds the network publish gate without re-litigating assembly.

**Exported interface:**

```ts
// packages/manta-cli/src/commands/share.ts
export interface RunShareCommandOptions {
  castId: string;                  // positional
  clone?: string;                  // --clone <id>; winner override
  outDir?: string;                 // --out <dir>; default: ./
  noEdit?: boolean;                // --no-edit; skip $EDITOR README pass
  acceptWarnings?: boolean;        // --accept-warnings; interactive only
  nonInteractive?: boolean;        // --non-interactive; trigger/CI mode
  publish?: false;                 // Chunk 3 plumbs this; Chunk 2 hard-false
}

export interface RunShareCommandResult {
  tarballPath: string;
  packageName: string;
  version: string;
  directoryDigest: string;
  warnings: SanitizationWarning[];
  winningCloneId: string;
}

export async function runShareCommand(
  runtime: Runtime,
  opts: RunShareCommandOptions,
): Promise<RunShareCommandResult>;
```

**Pipeline:**
1. Read cast manifest via `runtime` bus state (`busPaths.castFile(castId)`); parse `CastManifestSchema`. Not found → `ShareError('cast_not_found')` exit 20.
2. Resolve winner (§winning-clone-resolution): `--clone` → merge-review → error `share_no_winner` exit 21.
3. Read the winner's snapshot, task-contract (`busPaths.contractFile`), post-mortem (`docs/post-mortems/<day>-<cast>-<clone>.md`), ZK notes (query `events.jsonl` for `zk_write` events from the winner per research §6.C, read each `payload.path`), events (`events.ts:readAll()` filtered to winner), worktree-diff (`git diff <merge-base>..<winning-branch>` via execa).
4. Sanitize each (Chunk 1 functions). Aggregate warnings. **Any fatal (secret hard-block) → abort** `ShareError('secret_detected')` exit 22, listing masked findings.
5. Resolve `git remote get-url origin` (execa, tolerate failure → null).
6. `buildCastOrigin(...)`.
7. Assemble `SharedBundleManifest` (review-fix: spell out every derivation, the implementer no longer guesses):
   - `name`: `--name <@scope/kebab>` CLI flag REQUIRED (no default — npm scope must be opt-in; the runner refuses to invent a scope). Validated against the same regex as `MantaPackageManifestSchema.name` (`manifest-schema.ts`).
   - `version`: `--version <semver>` CLI flag REQUIRED (no auto-bump — author decides). Validated as semver.
   - `description`: `--description <text>` CLI flag, default = first line of the winning post-mortem's "Reason" header (truncated to 280 chars; trimmed; falls back to `"Manta cast <castId> deliverable"` if no post-mortem).
   - `author`: derive in this order — `--author <text>` flag → authoring repo's `package.json#author` field → `git config user.name` via execa (tolerate missing → throw `share_author_missing` exit 25 with hint to pass `--author`).
   - `license`: `--license <SPDX>` flag → authoring repo's `package.json#license` → throw `share_license_missing` exit 26 (no silent default; license is a legal claim, the author MUST assert it explicitly per spec Sec 12).
   - `mantaVersionCompat`: `--manta-version-compat <range>` flag → default to a CARET-pin on the current manta runtime version. Resolve "current manta runtime version" by reading the workspace's `packages/manta-cli/package.json#version` field at share time (single source of truth; the cast was run against this version). Format: `^<major>.<minor>.<patch>`. Validated as a semver range. Rationale: the bundle was built against this manta; downgrading the consumer's manta would be unsafe.
   - `contributes`: walk the winning clone's worktree under `skills/<name>/`, `commands/<name>.md`, `modes/<name>.json`, `templates/<name>/`, `hooks/<name>/` (the layout 7a's `validatePackage` cross-checks). For each present subtree, append the corresponding `contributes.{skills|commands|modes|templates|hooks}` entry with `name` + `description` + `basedOn` (modes) per 7a's `LibraryModeJsonSchema`. **If no subtree is present, error `share_nothing_to_ship` exit 23** (no shippable contribution).
   - `castOrigin`: attached from Task 2.2's `buildCastOrigin(...)` result.
8. `generateReadme(...)`. If `!noEdit && !nonInteractive` → open `$EDITOR` on the generated README, re-read after close.
9. **Warnings gate:** if non-fatal warnings exist:
   - `nonInteractive` → any warning is **fatal**; abort exit 24. (Trigger-mode must be clean.)
   - interactive + `!acceptWarnings` → render warnings, abort exit 24 with hint to re-run with `--accept-warnings`.
   - interactive + `acceptWarnings` → proceed.
10. `assembleBundle(...)`. Log summary (tarball path, size, warning count, winner). Return.

**Error matrix:**

| Failure | Exit | Message |
|---|---|---|
| Cast not found | 20 | `[manta] share: cast <id> not found` |
| No resolvable winner | 21 | `[manta] share: no winner; pass --clone <id>` |
| Secret detected (fatal sanitization) | 22 | masked findings + refusal |
| Nothing shippable (no mode/skill) | 23 | `[manta] share: cast produced no shippable contribution` |
| Unaccepted warnings | 24 | warning list + `--accept-warnings` hint |
| Author missing (cannot derive) | 25 | `[manta] share: cannot derive author; pass --author "<name>"` |
| License missing (cannot derive) | 26 | `[manta] share: cannot derive license; pass --license <SPDX>` |

**Acceptance criteria:**
- `runShareCommand(runtime, { castId, clone })` against a fixture cast dir produces a valid bundle; `manta install <that tarball>` (Phase 7a `runInstallCommand`) then succeeds — **cross-phase integration assertion**.
- A fixture with a secret in the worktree-diff → exit 22, no tarball written.
- `--non-interactive` with any non-fatal warning → exit 24.
- A recon-swarm cast with no `--clone` → exit 21.
- Two runs against the same fixture produce byte-identical tarballs (determinism, via injected `bundledAt`).

**Tests:**

- [ ] **Step 1: Build a fixture cast dir** under `packages/manta-cli/tests/fixtures/share/sample-cast/` — a `.manta/state/casts/<id>.json`, one clone's contract + snapshot + post-mortem + one ZK note + an events.jsonl + a winning-branch diff. Built by a one-shot `tests/fixtures/share/build-fixture.ts` (run at fixture-setup, not test time — mirrors 7a Task 1.5 pattern).
- [ ] **Step 2: Write integration test** constructing a `Runtime` pointed at the fixture repo root + a fake home, plus the per-error-path tests.
- [ ] **Step 3: Run tests — verify FAIL.**
- [ ] **Step 4: Implement `share.ts`** per the pipeline. Inject `bundledAt` + `gitRemoteOrigin` resolvers so tests are deterministic.
- [ ] **Step 5: Add the round-trip assertion** (`share` → `install`) reusing `runInstallCommand` from Phase 7a.
- [ ] **Step 6: Run tests — verify PASS.**
- [ ] **Step 7: Commit**

```
feat(cli): manta share command — local bundle pipeline (sanitize → assemble → verify)
```

---

### Task 2.5: `bin/manta.ts` registration + `CliErrorKind` widening

**Files:**
- **Modify (prerequisite — schema-first per CLAUDE.md HARD RULE):** `packages/manta-cli/src/errors.ts` — widen `CliErrorKind` with `'share_cast_not_found'`, `'share_no_winner'`, `'share_secret_detected'`, `'share_nothing_to_ship'`, `'share_warnings_unaccepted'`, `'share_publish_blocked'` (last one used in Chunk 3) **before** any share code references them. Same pattern as the 7a Task 1.7 Step 0 widening.
- Modify: `packages/manta-cli/src/bin/manta.ts` — register `.command('share <castId>')` near the existing `install`/`uninstall` registrations (verified registration block: `install` is registered and imported at `bin/manta.ts:21`, `uninstall` at `:22`; the commander chain runs through `runWithRuntime` at `:49`). Re-grep exact insertion line before edit.

**Why:** Wire the command into the CLI. Schema-first widening avoids the bug #13 class (text references a field the schema doesn't have yet).

**Commander block:**

```ts
program
  .command('share <castId>')
  .description('Build a publishable Manta package bundle from a finalised cast')
  .option('--clone <id>', 'winning clone to bundle (overrides merge-review)')
  .option('--out <dir>', 'output directory for the .tar.gz', '.')
  .option('--no-edit', 'skip the $EDITOR README pass')
  .option('--accept-warnings', 'proceed despite non-fatal sanitization warnings')
  .option('--non-interactive', 'CI/trigger mode: no $EDITOR, any warning is fatal, no publish')
  .action(async (castId: string, opts, cmd) => {
    await runWithRuntime(cmd, async (runtime) => {
      await runShareCommand(runtime, {
        castId, clone: opts.clone, outDir: opts.out,
        noEdit: !opts.edit, acceptWarnings: opts.acceptWarnings,
        nonInteractive: opts.nonInteractive,
      });
    });
  });
```

**Acceptance criteria:**
- `manta share --help` lists every flag.
- `manta share <fixture-cast> --clone <id> --out <tmp> --no-edit` produces a tarball (smoke test via the command, not just the function).
- The six new `CliErrorKind` members compile and are referenced by `share.ts`.

**Tests:**

- [ ] **Step 0 (schema-first): Widen `CliErrorKind`.** No standalone test; verified by Step 1 compile.
- [ ] **Step 1: Add a CLI-level smoke test** (or extend the command test) that invokes the registered command end-to-end against the fixture.
- [ ] **Step 2: Register in `bin/manta.ts`** (re-grep insertion line first).
- [ ] **Step 3: Re-export `runShareCommand` from `@manta/cli` index.**
- [ ] **Step 4: `pnpm gate` — verify PASS.**
- [ ] **Step 5: Commit**

```
feat(cli): register manta share command + widen CliErrorKind for share errors
```

---

### Chunk 2 complete when

- All Task 2.x green.
- `pnpm gate` clean.
- The **round-trip integration assertion** passes: `manta share <fixture> --clone <id>` → `manta install <tarball>` succeeds and the installed mode appears in `modeRegistry.list()`.
- Two shares of the same fixture are byte-identical (determinism).
- A secret-bearing fixture is refused (exit 22, no tarball).

---

## Chunk 3 — `--publish` flow + static malicious-pattern scan + docs

This chunk adds the npm publish gate (MVTS-7), the static JS scanner (research §2 mitigation d — for forward-compat when bundles ship dispatcher JS), the auto-share non-interactive guard, and all docs + INDEX/CHANGELOG. After Chunk 3: `manta share <cast-id> --publish` publishes to npm behind two human confirms; a trigger can build a bundle but not publish; the threat model is documented.

**Build dependency chain:** Task 3.1 (static scanner) + Task 3.2 (publish-flow) → Task 3.3 (`--publish` wiring + non-interactive guard) → Task 3.4 (docs) → Task 3.5 (INDEX + CHANGELOG + bug #18 status). ~450 LOC.

### Task 3.1: Static malicious-pattern scanner

**Files:**
- Create: `packages/manta-cli/src/share/static-scanner.ts`
- Create: `packages/manta-cli/src/share/tests/static-scanner.test.ts`

**Why:** Research §2 mitigation (d). Scans any JS the bundle ships (Phase 7b modes are `basedOn` built-ins and ship **no** JS, so this usually finds nothing — but it ships now for forward-compat and runs at both publish time and, later, install/preview time). Returns `{ blocked, warnings }`; publish short-circuits on any `blocked`.

**Pattern table (research §2 mitigation d — verbatim):**

| Pattern | Action |
|---|---|
| `eval(` | warn |
| `new Function(` | warn |
| `child_process.exec`/`execSync` with non-literal first arg | **block** |
| `child_process.exec`/`execSync` with literal arg, mode undeclared `requiresChildProcess` | **block** |
| `child_process.spawn` non-literal | warn |
| `require(` non-literal | warn |
| `fetch(`/`http.request(` to host not declared | warn |
| `process.env.X` where X matches `(API\|TOKEN\|SECRET\|KEY\|PASSWORD)` | warn |
| read `~/.ssh`/`~/.aws`/`~/.npmrc`/`~/.netrc` | **block** |
| write `<repo>/.git/`, `.env`, `.envrc` | **block** |

**Implementation note:** regex pass for v1 (cheap, defeated by obfuscation — documented as accepted, §0). AST via `acorn` is a Phase 8 hardening; v1 regex is honest about its limits. The scanner runs over every `.js` file in the bundle's `skills/`/`dispatch/` payloads (Phase 7b bundles have none, so the test ships a synthetic JS fixture to exercise the rules).

**Exported interface:**

```ts
// packages/manta-cli/src/share/static-scanner.ts
export interface ScanFinding { rule: string; file: string; line: number; severity: 'block' | 'warn'; snippet: string; }
export function scanBundleJs(files: Array<{ relPath: string; content: string }>): { blocked: ScanFinding[]; warnings: ScanFinding[] };
```

**Acceptance criteria:**
- A JS file with `child_process.execSync(userInput)` → one `block` finding.
- A JS file reading `~/.aws/credentials` → one `block`.
- A JS file with `eval(x)` → one `warn`.
- A clean JS file → `{ blocked: [], warnings: [] }`.
- An empty file list (Phase 7b typical) → `{ blocked: [], warnings: [] }`.
- `snippet` is the matched line, truncated, never a full file.

**Tests:**

- [ ] **Step 1: Write failing tests** — one synthetic JS fixture per rule.
- [ ] **Step 2: Run tests — verify FAIL.**
- [ ] **Step 3: Implement `static-scanner.ts`** (regex pass, line-numbered).
- [ ] **Step 4: Run tests — verify PASS.**
- [ ] **Step 5: Commit**

```
feat(cli): static malicious-pattern scanner for bundle JS (advisory + hard-block)
```

---

### Task 3.2: npm publish-flow with MVTS-7 gates

**Files:**
- Create: `packages/manta-cli/src/share/publish-flow.ts`
- Create: `packages/manta-cli/src/share/tests/publish-flow.test.ts`

**Why:** The gated path to npm. MVTS-7 gates, in order: (1) static scan clean (no `blocked`); (2) checksum re-verify (`verifyBundleChecksums`); (3) `npm whoami` login check; (4) scope-ownership check (`npm access ls-packages` or `npm org ls` — the publisher owns `@<scope>`); (5) **two** interactive confirmations (first: "publish `<name>@<version>` to npm as `<whoami>`?"; second: "this is PUBLIC and PERMANENT — npm does not allow unpublish after 72h. Confirm?"); (6) size cap (refuse if tarball > a configured max, default 5 MB — a published mode should be small; oversize signals a packaging mistake). All shell-outs via an injected `PublishRunner` seam (like 7a's `NetworkRunner`) so tests never hit the network.

**Exported interface:**

```ts
// packages/manta-cli/src/share/publish-flow.ts
export interface PublishRunner {
  whoami(): Promise<string | null>;            // npm whoami; null if not logged in
  listScopePackages(scope: string): Promise<string[]>; // packages publisher can publish under scope
  publish(tarballPath: string, opts: { access: 'public' }): Promise<void>; // npm publish
}
export interface Confirmer { confirm(prompt: string): Promise<boolean>; }

export interface PublishOptions {
  tarballPath: string;
  unpackedDir: string;
  manifest: SharedBundleManifest;
  bundleJsFiles: Array<{ relPath: string; content: string }>;
  maxBytes?: number;       // default 5 * 1024 * 1024
  runner: PublishRunner;
  confirmer: Confirmer;
}
export type PublishResult =
  | { ok: true; published: string /* name@version */ }
  | { ok: false; reason: 'scan_blocked' | 'checksum_mismatch' | 'not_logged_in' | 'scope_not_owned' | 'declined' | 'too_large'; detail: string };

export async function publishBundle(opts: PublishOptions): Promise<PublishResult>;
```

**Acceptance criteria:**
- Static scan with a `block` finding → `{ ok: false, reason: 'scan_blocked' }`; `runner.publish` never called.
- `whoami()` returns null → `not_logged_in`; publish not called.
- Scope `@foo` not in `listScopePackages` ownership → `scope_not_owned`.
- Either confirmation declined → `declined`; publish not called.
- Tarball > maxBytes → `too_large`.
- Checksum mismatch → `checksum_mismatch`.
- All gates pass + both confirms accepted → `runner.publish` called once with `{ access: 'public' }`, returns `{ ok: true, published: '<name>@<version>' }`.
- **Order assertion:** scan → checksum → whoami → scope → confirms → size → publish; a failure at any gate skips all later gates (test the short-circuit).

**Tests:**

- [ ] **Step 1: Write failing tests** with a fake `PublishRunner` + `Confirmer`. One test per gate failure + the all-pass path + the order/short-circuit assertion.
- [ ] **Step 2: Run tests — verify FAIL.**
- [ ] **Step 3: Implement `publish-flow.ts`.**
- [ ] **Step 4: Run tests — verify PASS.**
- [ ] **Step 5: Commit**

```
feat(cli): npm publish-flow with MVTS-7 gates (scan/checksum/login/scope/double-confirm/size)
```

---

### Task 3.3: Wire `--publish` into `manta share` + non-interactive guard

**Files:**
- Modify: `packages/manta-cli/src/commands/share.ts` — add the `--publish` branch after assembly; enforce the non-interactive guard.
- Modify: `packages/manta-cli/src/bin/manta.ts` — add `--publish` + `--max-bytes <n>` options to the `share` command; add a **pre-commander guard** that hard-rejects `--publish` together with `--non-interactive` (mirrors the existing `install --no-hooks` pre-commander guard at `bin/manta.ts:65-95`).
- Modify: `packages/manta-cli/tests/commands/share.test.ts` — add `--publish` path tests + the non-interactive guard test.

**Why:** Close the loop. **The auto-share trust boundary is enforced here:** `--publish` + `--non-interactive` is a hard error before commander parses (so a trigger literally cannot construct a publishing invocation), mirroring how 7a's `--no-hooks` cannot be disabled. Interactive `--publish` proceeds through `publishBundle` with a real `Confirmer` (stdin prompt) and the default `PublishRunner` (execa `npm`).

**Pre-commander guard (in `bin/manta.ts`, before `parseAsync`):**

```ts
// A trigger-fired cast may build a bundle but MUST NOT publish (Phase 7b §0
// informed-consent). --publish requires interactive human confirmation, so
// --publish + --non-interactive is structurally rejected before commander
// runs — same enforcement shape as the install --no-hooks guard above.
function guardSharePublish(argv: string[]): void {
  const idx = argv.indexOf('share');
  if (idx === -1) return;
  const rest = argv.slice(idx);
  if (rest.includes('--publish') && rest.includes('--non-interactive')) {
    process.stderr.write(
      '[manta] share: --publish cannot be combined with --non-interactive; ' +
      'publishing always requires interactive human confirmation (Phase 7b trust model)\n',
    );
    process.exit(2);
  }
}
```

**Acceptance criteria:**
- `manta share <cast> --publish --non-interactive` → exit 2, guard message, before any work.
- `runShareCommand({ …, publish: true, nonInteractive: true })` (bypassing CLI) → still throws `ShareError('share_publish_blocked')` (defense-in-depth: the guard is the CLI layer, the command also refuses).
- Interactive `--publish` with all `publishBundle` gates faked-passing → publishes once; result reports the published name@version.
- `--publish` with a `scan_blocked`/`declined`/etc. result → command exits non-zero with the reason; no tarball is deleted (the local bundle survives for re-inspection).

**Tests:**

- [ ] **Step 1: Write failing tests** — guard rejection, command-layer refusal, happy publish (faked runner/confirmer), each `publishBundle` failure surfaced.
- [ ] **Step 2: Run tests — verify FAIL.**
- [ ] **Step 3: Implement the `--publish` branch + guard.** Inject `PublishRunner`/`Confirmer` into `runShareCommand` via the runtime (default = real; tests pass fakes).
- [ ] **Step 4: Run tests — verify PASS.**
- [ ] **Step 5: `pnpm gate`.**
- [ ] **Step 6: Commit**

```
feat(cli): manta share --publish flow + non-interactive publish hard-block (auto-share guard)
```

---

### Task 3.4: User + internals docs

**Files:**
- Create: `docs/user/manta-share.md`
- Create: `docs/internals/share-sanitization.md`

**Why:** CLAUDE.md — every feature ships with user-facing docs + an architecture note in the same phase.

**`docs/user/manta-share.md` covers:** the command + every flag; the winning-clone resolution rule; what gets sanitized (the full table, user-readable); the warning vs fatal distinction; `--publish` and the two confirmations; the explicit statement that publishing is PUBLIC/PERMANENT and equivalent to publishing an npm package; the trust model in plain language (§0); what is deferred (signing/reputation/sandbox) and why.

**`docs/internals/share-sanitization.md` (~200 lines) covers:** the default-deny/allowlist philosophy and why it survives schema evolution; the per-artifact sanitizer map with file:line of each source field; the correction that post-mortem event payloads are already sanitized at render time (bug #29/#46) so 7b only does header redaction; the `castOrigin` extension and the 7c provenance contract (field mapping table); the integrity model (`checksum.json` + `computeDirDigest` reuse) and its honest limits without signing; the MVTS-7 gate order in `publishBundle`; the auto-share trust boundary (build-yes / publish-no).

**Acceptance criteria:**
- `docs/user/manta-share.md` documents every shipped flag and exit code accurately.
- `docs/internals/share-sanitization.md` cites the real source file:lines for every sanitized field.
- Both cross-reference Phase 7a's `docs/user/manta-library.md` (install side) and the research doc.

**Tests:**

- [ ] **Step 1: Draft `docs/user/manta-share.md`.**
- [ ] **Step 2: Draft `docs/internals/share-sanitization.md`.**
- [ ] **Step 3: Run skill-validator integration test** (paranoia — confirm the docs don't break doc-discovery; none are skills).
- [ ] **Step 4: Commit**

```
docs: manta share user guide + share-sanitization architecture note
```

---

### Task 3.5: INDEX.md + CHANGELOG.md + bug #18 status + plan status flip

**Files:**
- Modify: `docs/superpowers/plans/INDEX.md` — flip the Phase 7b row from `TODO (not yet written)` to a populated row, then (follow-up commit) to `**Executed**` once chunks land.
- Modify: `CHANGELOG.md` — add the Phase 7b entry.
- Modify: `docs/manta-bugs.md` — update bug #18 status: layer (b) full-enumeration sanitizer shipped in Phase 7b (was "layer a only" after 7a; research §1.4 + this plan's Chunk 1 complete the enumeration).

**Why:** INDEX.md is the source-of-truth plan map; CHANGELOG ships every phase; bug #18 (the metadata-leak bug whose layer-a fix shipped in 7a) is now fully closed by Chunk 1's sanitizer enumeration.

**INDEX.md — replace the existing Phase 7b placeholder row** (currently `| 2026-05-28-phase-7b-manta-share.md | TODO (not yet written) | Will cover … |`) with:

```markdown
| `2026-05-28-phase-7b-manta-share.md` | **TODO** | 3 chunks, 17 tasks, ~1650 LOC. Chunk 1: `CastOriginSchema` + `SharedBundleManifest` (additive `castOrigin` extension to the shipped flat manifest), secret-format scanner, five artifact sanitizers (snapshot/task-contract/post-mortem-md/ZK/events+diff) — default-deny, schema-first; completes bug #18 layer (b). Chunk 2: bundle assembler + `checksum.json` (reuses shipped `computeDirDigest`), `castOrigin` builder (maps 7c trigger provenance verbatim), README auto-gen, `manta share <cast-id>` local-bundle command (round-trips into Phase 7a `manta install`). Chunk 3: static malicious-pattern scanner, npm publish-flow with MVTS-7 gates (scan/checksum/login/scope/double-confirm/size), `--publish` wiring + non-interactive publish hard-block (auto-share trust boundary), user+internals docs. Deferred: signing/reputation/sandbox (Phase 8+). Research-backed: clone-C `docs/research/phase-7-community-share-trust.md` §0/§1/§2; cross-cut with 7c provenance (cast-1780019284984 broadcast). |
```

**CHANGELOG.md entry:**

```markdown
## [0.x.0] - 2026-05-?? — Phase 7b Manta Share (bundle generation + sanitization + publish)

### Added
- `manta share <cast-id>` — builds a publishable `*.manta-pkg.tar.gz` from a finalised cast
- `--clone <id>` / `--out <dir>` / `--no-edit` / `--accept-warnings` / `--non-interactive` flags
- `manta share --publish` — npm publish behind MVTS-7 gates (static scan, checksum re-verify, npm-login, scope-ownership, two human confirmations, 5 MB size cap)
- `CastOriginSchema` + `SharedBundleManifest` (additive `castOrigin` extension; carries cast lineage + 7c trigger provenance)
- Full default-deny sanitization pipeline: snapshot, task-contract, post-mortem, ZK notes, event timeline, worktree-diff
- Secret-format scanner (AWS/OpenAI/GitHub/Slack/Google/private-key/JWT) — hard-block on match
- `checksum.json` bundle integrity (per-file sha256 + `computeDirDigest` directory hash)
- Static malicious-pattern scanner for bundled JS (advisory + hard-block exceptions)

### Fixed
- Bug #18 (full — layer b): every free-form field across every bundled artifact is now allowlist-sanitized before publish; completes the layer-a metadata allowlist shipped in Phase 7a.

### Deferred to later phases
- Code signing / signature verification — Phase 8+
- Author reputation surfacing — Phase 8+
- Runtime sandbox for cast-time mode execution — indefinite
- Auto-publish (trigger fires npm publish) — never (policy): triggers may build a bundle, a human publishes
```

**Two-commit pattern (atomicity, mirrors 7a Task 2.7):**
1. Commit A: populate the INDEX row at `**TODO**` + CHANGELOG + bug #18 status.
2. Commit B (last commit of Phase 7b): flip the row to `**Executed** — Chunk 1 (<sha>) + Chunk 2 (<sha>) + Chunk 3 (<sha>)` with real hashes.

- [ ] **Step 1: Apply the INDEX.md row replacement.**
- [ ] **Step 2: Apply the CHANGELOG entry.**
- [ ] **Step 3: Update bug #18 status in `docs/manta-bugs.md`.**
- [ ] **Step 4: Run skill-validator integration test** (confirm INDEX.md still parses).
- [ ] **Step 5: Commit** (`chore: Phase 7b — INDEX + CHANGELOG + bug #18 full close`)
- [ ] **Step 6 (follow-up, after all chunks): flip row to `**Executed**`** with real hashes.

---

### Chunk 3 complete when

- All Task 3.x green.
- `pnpm gate` clean.
- `manta share <cast> --publish --non-interactive` is structurally rejected (exit 2).
- A faked all-gates-pass publish calls `npm publish` exactly once with `--access public`.
- `docs/user/manta-share.md` + `docs/internals/share-sanitization.md` exist and cite real file:lines.
- `docs/superpowers/plans/INDEX.md` Phase 7b row marked `**Executed**` with inline chunk commits.
- `CHANGELOG.md` has the Phase 7b entry.
- `docs/manta-bugs.md` bug #18 marked fully fixed.

---

## Cross-phase notes

**Reuse contracts (Phase 7a → 7b — verified file:line, do not drift):**
- `MantaPackageManifestSchema` (`packages/manta-skill-validator/src/manifest-schema.ts:139`) — **flat**; 7b adds `castOrigin: CastOriginSchema.optional()` (the one unavoidable additive edit to a frozen 7a file; safe because optional — see Task 2.1 must-fix).
- `computeDirDigest` (`packages/manta-cli/src/library/dir-digest.ts:30`) — reused verbatim for the bundle's `directoryDigest`; same primitive `verifyLibraryIntegrity` (`integrity.ts:58`) checks at cast time.
- `redactPostMortemMetadata` (`packages/manta-orchestrator/src/sanitize/metadata-allowlist.ts:17`) — already applied at post-mortem render; 7b's post-mortem sanitizer leaves the metadata block intact (no double-sanitisation).
- Lockfile (`packages/manta-cli/src/library/lockfile.ts:39`) — read-only, only for `mantaVersion` provenance; 7b does not mutate it.
- `runInstallCommand` (Phase 7a) — consumed by Chunk 2's round-trip integration test.

**Phase 7c contract (frozen — clone-B broadcast cast-1780019284984):** 7c adds optional `metadata.trigger` (`trigger_name`/`fired_at`/`parent_cast_id`) + `cause_chain` to `CastManifestSchema` (`packages/manta-bus/src/schema.ts:332`). 7b reads them **read-only** in `build-cast-origin.ts` and maps them 1:1 to `castOrigin.provenance` (camelCase). 7b does **not** depend on 7c landing — `metadata?.trigger` is read defensively, `provenance` is `null` when absent. **Auto-share boundary:** a 7c trigger may invoke `manta share --non-interactive` to build a bundle; it can **never** publish (`--publish + --non-interactive` is a hard error).

**Field-drift guard for the implementer:** before writing any call into a 7a-shipped or 7c-owned surface, `grep -n` the signature in the source file (not in this plan). The schemas cited here were verified against HEAD on 2026-05-28; re-verify line numbers before each edit (per CLAUDE.md #1 blocker class).

---

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Sanitizer misses a leak path (new field added to a source schema after 7b ships) | Medium | High — secret/path leaks externally | Default-deny: sanitizers omit unenumerated fields and `SanitizedSnapshotSchema` is `.strict()`, so a new source field is dropped, not passed through. The events drift-guard test catches projection divergence. |
| `castOrigin` added to `MantaPackageManifestSchema` breaks the 7a install path | Low | High — install rejects all bundles | The field is `.optional()` — additive, backwards-compatible. A Chunk 2 round-trip test (`share` → `install`) is the regression gate. |
| Author publishes a bundle whose worktree-diff has a secret the regex missed | Medium | Critical | Honest §0 limitation — best-effort, not a boundary. Two human confirms + the PUBLIC/PERMANENT warning put the final check on the human. Documented. |
| Trigger-fired cast tries to publish | Low | Critical | Structural: `--publish + --non-interactive` rejected pre-commander (exit 2) AND `runShareCommand` refuses (`share_publish_blocked`). Two layers. |
| Non-deterministic tarball breaks reproducibility | Low | Medium | `tar` portable mode + fixed mtime (`castOrigin.bundledAt`) + sorted file list; determinism asserted by a Chunk 2 test. |
| Post-mortem double-sanitisation corrupts the already-projected event timeline | Low | Low | 7b post-mortem sanitizer is line-oriented over header fields only; leaves `## Event timeline` / `## Metadata` blocks intact (they are already safe). Tested. |

---

## File scoping summary

**Chunk 1 new files:**
- `packages/manta-skill-validator/src/cast-origin-schema.ts` + test
- `packages/manta-cli/src/share/types.ts`
- `packages/manta-cli/src/share/secret-scanner.ts` + test
- `packages/manta-cli/src/share/sanitize-snapshot.ts` + test
- `packages/manta-cli/src/share/sanitize-task-contract.ts` + test
- `packages/manta-cli/src/share/sanitize-post-mortem.ts` + test
- `packages/manta-cli/src/share/sanitize-zk-note.ts` + test
- `packages/manta-cli/src/share/sanitize-events.ts` + test
- `packages/manta-cli/src/share/sanitize-worktree-diff.ts` + test
- `packages/manta-snapshot/src/sanitized-schema.ts`

**Chunk 1 surgical edits:**
- `packages/manta-skill-validator/src/index.ts` (re-exports)
- `packages/manta-skill-validator/src/manifest-schema.ts` (add optional `castOrigin` — the one frozen-file edit, additive)
- `packages/manta-snapshot/src/index.ts` (re-export sanitized schema)

**Chunk 2 new files:**
- `packages/manta-cli/src/share/bundle-assembler.ts` + test
- `packages/manta-cli/src/share/build-cast-origin.ts` + test
- `packages/manta-cli/src/share/generate-readme.ts` + test
- `packages/manta-cli/src/commands/share.ts` + test
- `packages/manta-cli/tests/fixtures/share/` (fixture cast + build script)

**Chunk 2 surgical edits:**
- `packages/manta-cli/src/index.ts` (re-export `runShareCommand`)
- `packages/manta-cli/src/errors.ts` (widen `CliErrorKind`)
- `packages/manta-cli/src/bin/manta.ts` (register `share`)

**Chunk 3 new files:**
- `packages/manta-cli/src/share/static-scanner.ts` + test
- `packages/manta-cli/src/share/publish-flow.ts` + test
- `docs/user/manta-share.md`
- `docs/internals/share-sanitization.md`

**Chunk 3 surgical edits:**
- `packages/manta-cli/src/commands/share.ts` (`--publish` branch)
- `packages/manta-cli/src/bin/manta.ts` (`--publish` options + guard)
- `docs/superpowers/plans/INDEX.md`, `CHANGELOG.md`, `docs/manta-bugs.md`

---

## Verification

The gate commands a reviewer runs before approving (each must pass; do not claim green without running):

1. **Canonical pre-merge gate (CLAUDE.md HARD RULE):**
   ```
   pnpm gate            # = pnpm typecheck && pnpm lint && pnpm test (fail-fast)
   ```
   Must be clean workspace-wide. Never claim green without an explicit `pnpm gate` run (bug #36).

2. **Per-package targeted runs (sanity, if `gate` is slow to bisect):**
   ```
   pnpm -F @manta/skill-validator vitest run tests/cast-origin-schema.test.ts
   pnpm -F @manta/cli vitest run src/share/tests/
   pnpm -F @manta/cli vitest run tests/commands/share.test.ts
   ```

3. **Coverage floor (CLAUDE.md ≥ 80 % all packages; new files 100 % branch per task):**
   ```
   pnpm -F @manta/cli vitest run --coverage src/share/
   pnpm -F @manta/skill-validator vitest run --coverage tests/cast-origin-schema.test.ts
   ```

4. **Round-trip integration (the contract that 7b feeds 7a):**
   ```
   pnpm -F @manta/cli vitest run tests/commands/share.test.ts -t 'round-trip'
   # asserts: manta share <fixture> --clone <id>  →  manta install <tarball>  succeeds
   ```

5. **Determinism assertion:**
   ```
   pnpm -F @manta/cli vitest run -t 'byte-identical'
   # two assembles of identical artifacts produce identical tarballs
   ```

6. **Sanitization leak-proof assertions (the security-critical tests):**
   ```
   pnpm -F @manta/cli vitest run -t 'secret'      # every fatal hard-block fires
   pnpm -F @manta/cli vitest run -t 'drift-guard' # event projection agrees with renderEventPayload
   ```

7. **Auto-share boundary assertion:**
   ```
   pnpm -F @manta/cli vitest run -t 'non-interactive'   # --publish + --non-interactive rejected
   ```

8. **Field-drift manual check (reviewer, not automated):** confirm every `file:line` citation in this plan still resolves at HEAD:
   ```
   grep -n 'MantaPackageManifestSchema' packages/manta-skill-validator/src/manifest-schema.ts   # expect :139
   grep -n 'export async function computeDirDigest' packages/manta-cli/src/library/dir-digest.ts # expect :30
   grep -n 'function renderEventPayload' packages/manta-orchestrator/src/post-mortem.ts          # expect :156
   grep -n 'export const CastManifestSchema' packages/manta-bus/src/schema.ts                    # expect :332
   grep -n 'castFile' packages/manta-bus/src/state/paths.ts                                       # expect :53
   ```

9. **Build artifact sanity (the bundle actually installs):** in a scratch dir, run `manta share` against a real finalised cast, then `manta install ./<bundle>.manta-pkg.tar.gz`, then `manta library list` — the shared mode appears. (Manual; complements the automated round-trip.)

**Approval bar:** all of (1)–(7) green in an independent re-run by the reviewer (not trusting the implementer's claim — CLAUDE.md `feedback-impl-self-reports`), (8) all citations resolve, (9) manual round-trip succeeds. Any secret-leak test failing is a hard block — no merge.

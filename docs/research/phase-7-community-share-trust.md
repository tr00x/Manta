# Phase 7 — Community layer: Share, trust, version compat, in-tree migration

Author: clone-C, cast-1779977834212 (recon-swarm, Phase 7 research).
Sibling deliverables: `phase-7-manta-library.md` (clone A — package format / registry / install), `phase-7-auto-cast-triggers.md` (clone B — trigger taxonomy / safety / watcher).
Scope of this doc: everything community-facing that is **not** the package format itself — share publishing flow, the trust model, version compatibility semantics, the in-tree-mode migration question, discovery, and an end-to-end codebase audit with file:line citations.

> **Source-of-truth sections:** spec `docs/superpowers/specs/2026-05-06-manta-pattern-design.md`
> — Sec 11.1 line 486 (`/manta share`), Sec 12 lines 542–543 (`/manta install` / `/manta share`), Sec 15.1 line 644 ("Phase 7 — Manta Library + auto-cast triggers + community").

---

## 0. Headline decision — Phase 7 trust model

**Ship the Minimum Viable Trust Set (MVTS-7). Defer everything that needs key infrastructure, telemetry backends, or runtime isolation. Be honest that we are shipping "informed-consent + best-effort static analysis", not a true security boundary.**

| Mitigation | Phase 7 ship? | Rationale |
|---|---|---|
| (a) Read-only mode preview before install | **Yes** | Cheap. Manifest declares `declares.bashPatterns`, `declares.filePatterns`, `declares.networkHosts`. `manta library preview <name>` renders them. User must `manta library arm <name>` before mode appears in cast registry. |
| (b) Sandbox extract to `~/.manta/library/<name>/` | **Yes** | Filesystem-level. Library packages live outside repo; no auto-write into project worktree. Already implied by spec ("install path" — see Sec 12 line 542). |
| (c) Manifest schema validation (Zod, fail-closed) | **Yes** | Without this the install path has no contract. Built on the existing `@manta/skill-validator` pattern (see §6.D). |
| (d) Malicious-pattern static scan | **Yes (advisory, with hard-block exceptions)** | Scan entrypoint JS for `eval(`, `new Function(`, `child_process.exec`, raw `fetch(` to non-allowlisted hosts, dynamic `require()`. Hard-block on `child_process.exec` of user input; warn on the rest. Cheap, runs in the same install pass. |
| (e) Code signing (author signs, install verifies) | **No (Phase 8+)** | Needs key registry, revocation list, key rotation, lost-key recovery. None of that exists. Without infra, "optional signing" is theater. |
| (f) Author reputation (install count, time-to-first-issue) | **No (Phase 8+)** | Needs telemetry backend. We have neither the infra nor the legal/privacy story for collecting it. Punt. |
| (g) Runtime sandbox (mode runs in a jailed Node VM) | **No (defer indefinitely)** | The host Claude Code that the mode dispatches into is not sandboxed; the clone subprocess has full shell access by design. A sandboxed mode that spawns an unsandboxed clone is security theater — and the mode's job is fundamentally to run code in the user's repo. Document the threat clearly; don't pretend to fix it. |

**Bottom line:** the trust story we tell users is *"Manta Library packages are user-vetted dev tools, like VS Code extensions or `npx` scripts. We make the contents inspectable and we statically scan for obviously hostile patterns, but installing an untrusted mode is equivalent to running an untrusted shell script — review the preview, install only from authors you trust."* No magical promises. This matches what we can actually deliver in Phase 7.

The rest of this document walks the supporting design: bundle anatomy (§1), the four MVTS-7 mitigations in detail (§2), version compat (§3), the in-tree migration question (§4 — answer: leave bundled, build the registry seam, extract only on community pull), discovery (§5 — answer: GitHub curated index over npm; no custom registry), and the codebase audit with file:line refs (§6).

---

## 1. Share-bundle anatomy

### 1.1 Picking up where clone A left off

Clone A's phase-7 task (see `docs/research/phase-7-recon-tasks.yaml` clones.A) owns Library *package format* and *install/registry*. The format clone A defines is the format `/manta share` produces. To avoid contract drift between the two clones in parallel, this doc nails down what `/manta share` produces from one cast's filesystem state — and trusts clone A's `phase-7-manta-library.md` to define what `/manta install` does with it.

The bundle is the only contact surface between `/manta share` and `/manta install`. Treat its schema as a versioned interface.

### 1.2 Directory layout on disk

`/manta share <cast-id>` produces a single `.tar.gz`:

```
<name>-<version>.manta-pkg.tar.gz
└─ <name>-<version>/
   ├─ manifest.json              (canonical, schema-validated)
   ├─ README.md                  (auto-generated; user may edit before publish)
   ├─ LICENSE                    (copied from authoring repo or templated from manifest.license)
   ├─ task-contract.json         (sanitized — see §1.4)
   ├─ snapshot.json              (sanitized — see §1.4)
   ├─ priming.txt                (the priming preamble the winning clone received)
   ├─ post-mortems/
   │  ├─ <clone-id>.md           (sanitized — see §1.4)
   │  └─ ...
   ├─ zk-notes/
   │  └─ <slug>-<id>.md          (the ZK notes the winning clone wrote)
   ├─ events.jsonl               (sanitized event timeline — see §1.4)
   ├─ worktree-diff.patch        (the actual code change — `git diff <merge-base>..<winning-branch>`)
   ├─ skills/                    (optional — if the cast added or modified a skill)
   │  └─ <skill-name>/SKILL.md
   ├─ dispatch/                  (optional — only if type=mode and mode is a daemon-mode-style dispatcher)
   │  └─ index.js                (built, runnable JS — see §1.5)
   ├─ screenshots/               (optional — out-of-scope for Phase 7 unless mode generated any)
   └─ checksum.json              (sha256 of every other file; manifest verifies via integrity field)
```

The unpacked tree is what lives at `~/.manta/library/<name>/` after `manta library install`. No file outside the package is touched at install time — that's mitigation (b).

### 1.3 `manifest.json` — Zod schema

The manifest is the only schema-validated artifact in the bundle. Everything else is a payload the install path can refuse to touch if the manifest is invalid. This matches the existing `@manta/skill-validator` philosophy: parse-once at the gate, then trust within (`packages/manta-skill-validator/src/validate.ts:16-52`).

```ts
// proposed: packages/manta-library/src/manifest-schema.ts (new package — Phase 7 ship)
import { z } from 'zod';

const KEBAB_NAME = /^[a-z][a-z0-9-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?(\+[0-9A-Za-z-.]+)?$/;
const SEMVER_RANGE = /^(>=|<=|>|<|=|\^|~)?\d+\.\d+(\.\d+)?(\s+(>=|<=|>|<|=|\^|~)?\d+\.\d+(\.\d+)?)*$/;
const SPDX_LICENSE = /^[A-Za-z0-9.+-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

// Author identity. email is optional because publish flow may run without it
// (CI publishing, anonymous community submissions). GitHub handle preferred
// when present — pairs with discovery (§5).
const AuthorSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(254).optional(),
  github: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).optional(),
  url: z.string().url().max(2048).optional(),
}).strict();

// Provenance — where this package was originally cast from. Used by /manta
// share to record cast lineage without leaking absolute filesystem paths.
// originalRepoOrigin is the `git remote get-url origin` of the authoring repo,
// or null if the repo had no remote (local-only authoring).
const CastOriginSchema = z.object({
  castId: z.string().regex(/^cast-\d{10,16}$/),
  castMode: z.enum([
    'recon-swarm', 'forking-realities', 'bug-hunt', 'refactor-wave',
    'pair-programming', 'test-storm', 'documentation-chase',
  ]),
  originalRepoOrigin: z.string().url().nullable(),
  originalMantaVersion: z.string().regex(SEMVER),
  bundledAt: z.string().datetime(),  // ISO 8601 UTC
}).strict();

// "What the mode declares it will do" — drives the preview UI (mitigation a).
// These are author-asserted patterns, not enforced runtime restrictions. They
// give the user a single screen of "here's what this thing claims to touch."
// If a malicious mode lies, the static scan (mitigation d) catches obvious
// cases; runtime isolation (mitigation g) is explicitly out of scope. See §2.
const DeclarationsSchema = z.object({
  // Bash command patterns the mode might shell out to. Glob-ish strings.
  // Example: ["pnpm test", "git diff", "vitest run **"].
  bashPatterns: z.array(z.string().min(1).max(256)).max(64).default([]),
  // File globs the mode declares it may read/write in the user's worktree.
  // Example: ["docs/**", "packages/*/src/**"].
  filePatterns: z.array(z.string().min(1).max(256)).max(64).default([]),
  // Network hosts the mode declares it may contact (must be reachable for
  // `manta library preview` to render). Allowlist hint, not enforced.
  networkHosts: z.array(z.string().min(1).max(253)).max(32).default([]),
  // Whether the mode requires spawning child processes (Node child_process,
  // shell, etc). If true and not declared, install hard-blocks per §2.
  requiresChildProcess: z.boolean().default(false),
  // Whether the mode requires direct write access to .manta/state (must be
  // declared; Phase 7 = always false; only future first-party bundles may
  // override and only with --force flag).
  requiresStateAccess: z.boolean().default(false),
}).strict();

// Integrity — sha256 of every other file in the bundle. checksum.json is the
// witness file; the install path recomputes and compares before unpacking.
const IntegritySchema = z.object({
  algorithm: z.literal('sha256'),
  // Map of "relative/path/from/bundle/root" -> sha256 hex digest.
  files: z.record(z.string().regex(/^[^./][^\0]{0,1023}$/), z.string().regex(SHA256)),
}).strict();

export const ManifestSchema = z.object({
  // Schema version of the manifest itself — independent of pkg version. Bump
  // when manifest fields change in a breaking way; install path refuses
  // unknown manifest schema versions.
  manifestSchemaVersion: z.literal(1),

  name: z.string().min(1).max(64).regex(KEBAB_NAME),
  version: z.string().regex(SEMVER),
  description: z.string().min(10).max(280),

  author: AuthorSchema,
  license: z.string().min(1).max(64).regex(SPDX_LICENSE),

  // Manta core version range this package is compatible with. See §3 for
  // semver semantics and install/cast-time check.
  mantaVersion: z.string().regex(SEMVER_RANGE),

  // What kind of package this is. Phase 7 ships `mode` and `template`; `skill`
  // ships if clone A's package-format research finds a use for skill-only
  // packages.
  type: z.enum(['mode', 'template', 'skill']),

  // Only present when type === 'mode'. Encodes the cast-time invariants that
  // are currently hardcoded in cast.ts:148-171 — clone count range, session
  // mode, dispatch protocol.
  mode: z.object({
    sessionMode: z.enum(['batch', 'daemon']),
    cloneCount: z.object({
      min: z.number().int().min(1).max(5),
      max: z.number().int().min(1).max(5),
    }).refine(c => c.min <= c.max, 'mode.cloneCount.min must be <= max'),
    // dispatcher entrypoint, relative to bundle root. Only present for
    // daemon-mode packages (batch modes need no dispatcher).
    dispatcher: z.string().min(1).max(256).optional(),
    // priming block entrypoint, relative to bundle root. The text the
    // spawner prepends to the clone's system prompt — see priming.ts:1-19.
    primingBlock: z.string().min(1).max(256).optional(),
  }).optional()
    .refine(
      (m) => m === undefined || true, // structural constraint enforced at top-level by refine below
      { message: 'mode block only valid when type === mode' },
    ),

  declares: DeclarationsSchema,

  // Skills bundled with this package — registered into `<repoRoot>/skills/`
  // namespace via the skill-validator (see §6.D). Skill manifests inside the
  // bundle are validated using the existing SkillFrontmatterSchema
  // (packages/manta-skill-validator/src/schemas.ts:7-15).
  skills: z.array(z.object({
    name: z.string().min(1).max(64).regex(KEBAB_NAME),
    path: z.string().min(1).max(256),  // relative to bundle root
  })).max(16).default([]),

  // Provenance — null when authored by hand rather than `/manta share`.
  castOrigin: CastOriginSchema.nullable(),

  // Integrity — sha256 of every other file in the bundle.
  integrity: IntegritySchema,

  // Optional npm runtime deps (only resolved if the package ships a
  // dispatcher). Strict allowlist enforced at install time — see §2.
  dependencies: z.record(
    z.string().regex(/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/),
    z.string().regex(SEMVER_RANGE),
  ).default({}),
}).strict()
  .refine(
    (m) => (m.type === 'mode') === (m.mode !== undefined),
    { message: 'manifest.mode must be present iff manifest.type === "mode"', path: ['mode'] },
  );

export type Manifest = z.infer<typeof ManifestSchema>;
```

Two design choices worth flagging:

- **`.strict()` everywhere.** This matches the project-wide convention enforced by the bus parsers (e.g. `packages/manta-bus/src/tools/memory.ts:16` parses via `parse()` which is strict by construction). Unknown fields in a manifest are an install-time hard error — no silent forward-compat.
- **`integrity.files` is mandatory and exhaustive.** Every file in the bundle must have a checksum, computed by the share command before tarring. Install recomputes and compares. This is the only line of defense against tampering between author publish and user install when there is no code signing (§2 mitigation e is deferred). It's not strong — anyone who can rewrite the tarball can rewrite the manifest — but it catches accidental corruption and shifts the attack surface from "modify any payload file silently" to "rewrite the whole package, which the user would notice in `library preview`."

### 1.4 Sanitization — what to strip before publishing

The biggest correctness risk in `/manta share` is *not* the manifest schema. It is the artifacts the schema points at. The cast filesystem contains absolute paths to the user's home directory, the user's git email, environment-dependent timestamps, raw transcript fragments, and PIDs from the user's machine. None of that belongs in a published package.

**Sanitization runs against a defined allowlist of fields, not a blocklist of patterns.** Default-deny: any field not enumerated below is dropped, not transformed. Schema-driven, not regex-driven.

| Source (file:line) | Field | Risk | Sanitization rule |
|---|---|---|---|
| `post-mortem.ts:75` (`renderMarkdown`) | `record.worktree` | Absolute path leaks user home + repo path | Replace with literal `<worktree>` or `<repo>/.manta/worktrees/clone-X` |
| `post-mortem.ts:76` | `record.parent_pid` | Host PID — minor but useless to bundle consumer | Drop (omit field entirely) |
| `post-mortem.ts:77-78` | `registered_at`, `last_heartbeat_at`, `died_at` | Wallclock epoch ms — could correlate with other logs | Replace with relative offsets from `registered_at` (`+0ms`, `+12ms`, `+34s`) |
| `post-mortem.ts:83-87` | `metadata` | Arbitrary `Record<string,string>` — could carry `cast_id` (fine) but also any future caller-injected field | Allowlist: `cast_id`, `cast_mode`. Drop all other keys. |
| `post-mortem.ts:100-101` | `events[].payload` | Free-form JSON — broadcasts/zk_writes embed file paths | Recursively scan payload strings for absolute paths matching `^/`, `~/`, or the parent worktree prefix; redact to `<path>` |
| `snapshot-builder.ts:49-50` (`buildCloneSnapshot`) | `parentWorktree`, `cloneWorktree` | Absolute paths | Replace with `<worktree>` literal |
| `snapshot-builder.ts` via `captureState` | `parentSessionId` | Claude Code session ID — internal | Drop |
| `snapshot-builder.ts:14` | `parentPid` | Host PID | Drop |
| `snapshot.recentMessages` | Raw transcript (user-owned text) | **Highest risk.** Could contain API keys, secrets, anything the user typed | **Drop entirely.** A bundle is the *output* of a cast, not the user's working context. The transcript adds zero value to a published mode. |
| `snapshot.openFiles[].path` | Absolute or repo-relative paths | Path leak | Convert all to repo-relative; if outside repo, drop entry |
| `snapshot.budget` | Dollar amounts | Cost may be sensitive | Drop entirely from published bundle — irrelevant to consumer |
| `registry.ts:7-23` (`CloneRecord`) — embedded in events | `worktree`, `parent_pid` | Same as above | Same as above |
| `events.ts:7-13` (`BusEvent`) | `payload` (arbitrary) | Same as post-mortem events | Same as post-mortem events |
| ZK note frontmatter — `memory-writers.ts:91-105` | `clone_id`, `created_at` | Low risk; `created_at` is wallclock ms | Replace `created_at` with `<bundled-at>` ISO date from manifest.castOrigin |
| ZK note body | User-written prose | **High risk** — clone may have inadvertently included paths/secrets | Run the same path-scan as post-mortem events; warn (do not auto-redact) — author must accept warning before publish |
| Task contract (`bus/state/contracts/<clone>.json`) | `scope.allowedPaths` | Could be absolute | Relativize to repo root; if outside, drop |
| Task contract — `task` text | Author-written task description | **High risk** — may mention internal services, customer names | Refuse to bundle if task contains regex patterns matching common secret formats (`AKIA[0-9A-Z]{16}`, `sk-[a-zA-Z0-9]{40,}`, `ghp_[a-zA-Z0-9]{36}`, `xox[bp]-`, etc.). Otherwise pass through with author warning. |
| `worktree-diff.patch` | Code diff | Inherent risk: diff may contain hardcoded credentials | Same secret-format scan as task text; refuse to bundle on match. The cost of false negatives here is acceptable because anyone publishing must explicitly run `/manta share --confirm-no-secrets`. |

**Implementation seam:** add `packages/manta-cli/src/share/sanitize.ts` with one exported function per sanitization target, returning the sanitized object plus a list of `SanitizationWarning[]`. The `manta share` command renders the warnings to the user, blocks publish until either `--accept-warnings` or every warning is resolved.

The reason for schema-driven sanitization (allowlist) over regex-driven (blocklist) is the same reason `@manta/bus` uses `.strict()` Zod everywhere: it's the only approach that survives schema evolution. When someone adds a field to `CloneRecord` next quarter, the sanitizer fails closed (drops it) instead of failing open (silently shipping it).

### 1.5 `dispatch/index.js` — what runs at cast time

For `type: 'mode'` packages that need a dispatcher (currently: `pair-programming`, `test-storm`, `documentation-chase` — Wave 2 daemon modes; see `packages/manta-cli/src/dispatch/`), the bundle ships a *built* JS file at `dispatch/index.js`. Not source TS. This means:

- Author runs `pnpm build` before `manta share`; the share command refuses to bundle if the dispatcher source has unbuilt edits (`git status --porcelain dispatch/`).
- Install path does not run a TS compiler. Type-checking is the author's job. Install does run the static malicious-pattern scan (§2 mitigation d) against the built JS.
- The built JS imports from a small, frozen surface: a `@manta/dispatch-api` package (Phase 7 ships v0.1.0). Anything else in `dependencies` is loaded via the user's local node_modules — install warns if any dep isn't on the conservative allowlist (`@manta/*`, common test/lint utils).

The discipline parallels VS Code extensions: source lives in author's repo, only built artifacts ship. This is the only way the install path can statically reason about what the mode does without running it.

### 1.6 README auto-generation

Per task: README is auto-generated from the cast post-mortem. Concretely:

1. `manta share` reads `docs/post-mortems/<date>-<cast-id>-<winning-clone>.md` for the winning clone.
2. Extracts: cast mode, sanitized task description, key event-timeline milestones, final diff stats (files changed, +/- lines).
3. Reads any `zk-notes/` written by the winning clone, embeds first paragraph of each.
4. Composes a templated README with sections: *Overview / What this mode does / Cast lineage / Compat / Installation / Author / License*.

Author can edit the generated README before publishing — `manta share` opens it in `$EDITOR` after generation, unless `--no-edit` is passed. The author's edit is the canonical README; the auto-generation is a starting point.

---

## 2. Trust model — Manta Library is community code

### 2.1 Threat model

| Threat | Severity | In-scope for Phase 7? |
|---|---|---|
| Malicious mode runs `rm -rf` on install | Critical | **Yes** — mitigation (d) catches the obvious case (`child_process.exec` of `rm`); mitigation (b) bounds the blast radius to `~/.manta/library/<name>/`. Not bulletproof but not theater. |
| Malicious mode exfiltrates `.env` after install via dispatch | Critical | **Partially** — mitigation (a) requires the mode to declare `requiresChildProcess: true` and the network hosts it contacts; deception is possible but raises social cost. No runtime sandbox (g, deferred). |
| Author publishes good mode → key stolen → bad update | Critical | **Out of scope** — no signing (e, deferred). User pinning to a specific version (`manta library install <name>@<version>`) is the only mitigation, and it's user-driven. |
| Typosquatting (`refacor-wave` vs `refactor-wave`) | High | **Partially** — discovery via curated GitHub index (§5) screens at registration; npm scope (§5) doesn't. Document the risk. |
| Mode silently uses huge tokens, blows budget | Medium | **Already covered** by Phase 3 budget gates (`packages/manta-cli/src/budget/pre-spawn-gate.ts` — exists). |
| Mode triggers infinite cast loop | Medium | **Out of scope here** — clone B owns this in `phase-7-auto-cast-triggers.md` (auto-cast safety design). |
| Compromised npm registry serves bad bytes | Low | Existing npm registry attacks — mitigation via `integrity.files` checksum (§1.3) when distribution is via tarball; per-version pinning when via npm. Same trust model as any npm-dependent tool. |

### 2.2 The four MVTS-7 mitigations in detail

#### Mitigation (a) — Read-only preview before install

Command:

```
manta library preview <name>             # against npm or GitHub index
manta library preview ./local-pkg.tar.gz # against local file (testing)
```

Output renders the manifest's `declares` block, the author identity, the licence, the cast lineage, and a summary of the malicious-pattern scan results — *before* extracting anything. The user must run `manta library install <name>` to proceed.

Once installed, the package lives under `~/.manta/library/<name>/`. It is *not yet* in the cast mode registry — the user must run `manta library arm <name>`. This second confirmation defends against scripted-install attacks where the user pipes a curl into `manta`. Pure install is reversible (`manta library uninstall <name>` deletes the directory). Arming is the trust-granting step.

#### Mitigation (b) — Filesystem sandbox

Install target: `~/.manta/library/<name>/<version>/` (versioned dir; multiple versions can coexist; arm picks one). Install never writes to the user's repo. The only writes to `<repo>/` happen at cast time: the dispatcher writes inside its clone's worktree, just like in-tree modes.

This bounds the install blast radius. The mode can still misbehave at *cast* time — see §2.2 mitigation (g) for why we don't try to fix that.

#### Mitigation (c) — Manifest schema validation, fail-closed

Already specified in §1.3. Install path is one call: `ManifestSchema.parse(JSON.parse(manifestText))`. If it throws, install aborts with the Zod error path. This is the same pattern used by `packages/manta-bus/src/tools/memory.ts:16` (`parse(ZkWriteInputSchema, ...)`) and `packages/manta-bus/src/tools/parse.ts` more broadly. No new mechanism, just reusing the project's existing parsing discipline at the install gate.

#### Mitigation (d) — Static malicious-pattern scan

For every JS file referenced by the manifest (`mode.dispatcher`, `mode.primingBlock`, anything in `entrypoints`), run a static pass:

| Pattern | Action |
|---|---|
| `eval(` (any arg) | **Warn** — common in legitimate sandboxed eval, but flag |
| `new Function(` (any arg) | **Warn** |
| `child_process.exec(` / `execSync(` with **non-literal** first arg | **Hard block** — exec-of-user-input is the canonical rm-rf vector |
| `child_process.exec(` / `execSync(` with literal first arg, mode hasn't declared `requiresChildProcess` | **Hard block** — undeclared shell-out |
| `child_process.spawn(` with non-literal first arg | **Warn** — spawn is harder to abuse than exec but still flag |
| `require(` with non-literal arg (`require(varName)`) | **Warn** — dynamic require can load arbitrary packages |
| `fetch(` / `http.request(` to host not in `declares.networkHosts` | **Warn** — undeclared network |
| `process.env.X` for X matching `(API|TOKEN|SECRET|KEY|PASSWORD)` | **Warn** — possible env-var harvesting |
| Reading `~/.ssh`, `~/.aws`, `~/.npmrc`, `~/.netrc` | **Hard block** |
| Writing to `<repo>/.git/`, `<repo>/.env`, `<repo>/.envrc` | **Hard block** |

The scan is static (regex + AST via `@babel/parser` or `acorn` for accuracy). It is *trivially* defeated by obfuscation. That's accepted — the goal is to catch the lazy malicious mode and the careless honest mode, not the determined attacker. Document this explicitly.

Implementation: `packages/manta-library/src/scanner.ts` (Phase 7 ship). Returns `{ blocked: Finding[]; warnings: Finding[] }`. Install command short-circuits on any `blocked`; warnings require `--accept-warnings` to proceed.

#### Mitigations (e), (f), (g) — explicitly deferred

For each, the cost-to-ship far exceeds the security improvement that ships with it, given the rest of the trust model:

- **(e) Signing** requires: key registration (where? GitHub? our own service?), revocation, key rotation, lost-key recovery, signature format spec, library-side verification, threat model for compromised signing key, threat model for compromised root CA. Without all of that, "optional signing" is a checkbox that signals safety without delivering it. Phase 8+. Maybe ever.

- **(f) Reputation** requires: a telemetry endpoint, a privacy policy, a takedown process, a moderation team, an appeals process. None of that exists. We could fake it by scraping GitHub stars, but that's gameable and we'd be misleading users. Phase 8+ at earliest, and possibly never if discovery (§5) stays on GitHub — the GitHub stars + issue tracker *is* reputation infra, just not ours.

- **(g) Runtime sandbox** is the most tempting and the most pointless. The clone subprocess is `claude-code` invoking the user's shell on the user's filesystem with the user's credentials. Sandboxing the *dispatcher* (a few hundred lines of orchestration JS) while the *clone it dispatches* has unrestricted access is theater. The mode's job is fundamentally to run code in the user's repo. If we ever fix this, we fix it for in-tree modes first, not just for library modes.

The Phase 7 message to users is: "you are installing a developer tool that runs in your project. Read the preview. Install from authors you trust. We do basic static analysis but we do not sandbox at runtime." This is the same trust model as VS Code extensions, npm dependencies, and Claude Code plugins themselves. It is honest. Honest beats reassuring.

---

## 3. Version compatibility

### 3.1 Semver for Manta itself

Manta is currently `0.0.0` (root `package.json` line 3 — `manta-monorepo`). Phase 7 is the right moment to declare the version policy because the first `manta library install` consumes it.

**Proposed policy for `0.x`:**

| Version field | Means | Examples |
|---|---|---|
| `0.MINOR.0` bump | Breaking change permitted in any public API (CLI flags, bus tools, manifest schema, snapshot schema) | `0.7.0 → 0.8.0` |
| `0.MINOR.PATCH` bump | Bug fixes, internal refactors, additive non-breaking changes | `0.7.0 → 0.7.1` |
| `1.0.0` | Library install is stable, no breaking changes without major bump | Future |

Library packages declare their compat range via `manifest.mantaVersion` (Zod-validated as `SEMVER_RANGE` in §1.3). Examples:

- `mantaVersion: ">=0.7 <0.8"` — pinned to one minor (most common during 0.x).
- `mantaVersion: ">=0.7"` — author promises forward compat (rare; risky; warn at publish).
- `mantaVersion: "^1.0"` — caret only legal once Manta ≥ 1.0.

### 3.2 Compat check decision matrix

| When | Check | Result if mismatch |
|---|---|---|
| `manta library install <name>` | Installed manta version satisfies `manifest.mantaVersion`? | **Hard block** with suggested upgrade/downgrade path. User can pass `--force` to install anyway (records `forced: true` in local lockfile). |
| `manta library arm <name>` | Same check, in case manta was upgraded between install and arm | **Hard block.** No force option here — arming a known-incompatible mode is too easy to forget. User must `manta library install <name>@<version>` again. |
| `manta cast <name>` resolves to a library mode | Same check, in case manta was upgraded between arm and cast | **Soft warn** by default (cast continues), `--strict-compat` flag (or `MANTA_STRICT_COMPAT=1`) flips to hard block. Rationale: cast-time hard-block is a footgun if a user upgrades manta mid-day and suddenly all their library modes refuse to run; soft-warn lets the cast proceed while making the risk visible. |
| `manta library list` | Show compat status of every armed mode | Display compat: `ok` / `outdated` / `incompatible`. |

Why three checkpoints instead of one: each catches a different time window. Install-time alone misses the case where the user upgrades manta later. Cast-time alone is too late (clone is already spawning). Belt-and-suspenders is cheap because the check is `semver.satisfies(currentVersion, manifest.mantaVersion)` — microseconds.

### 3.3 What "breaking" means concretely for Manta

This is the list of surfaces a library package can observe, which the 0.x policy is committing to versioning correctly:

| Surface | Where it lives | Breaking-change examples |
|---|---|---|
| Bus tool inputs/outputs | `packages/manta-bus/src/schema.ts`, `packages/manta-bus/src/tools/*.ts` | Adding required field to `manta.heartbeat`; removing a tool |
| Snapshot schema | `packages/manta-snapshot/src/schema.ts` | Adding required field to `TaskContractSchema`; renaming `cloneId` → `clone_id` |
| Mode dispatch API | (Phase 7 introduces `@manta/dispatch-api`) | Changing the signature of the dispatcher's `onCycleComplete` callback |
| Priming text contract | `packages/manta-cli/src/spawner/priming.ts` | Changing the env var name that the snapshot path is exposed under (`MANTA_SNAPSHOT_PATH`) |
| CLI flags | `packages/manta-cli/src/commands/*.ts` | Renaming `--clones` to `--clone-count` |
| Filesystem layout | `packages/manta-bus/src/state/paths.ts` | Moving `.manta/state/registry.json` to `.manta/state/clones.json` |

Phase 7's job is to lock these into a versioned `@manta/library-api` surface — a thin re-export package whose public exports are what library modes are allowed to import. Anything outside `@manta/library-api` is internal; library packages that reach into it accept the risk of breakage. Mirror of how Next.js does `next` vs internal modules.

---

## 4. In-tree mode migration

### 4.1 The question

The 7 in-tree modes (`recon-swarm`, `forking-realities`, `bug-hunt`, `refactor-wave`, `pair-programming`, `test-storm`, `documentation-chase`) currently live in `@manta/cli`. Should they migrate to "first-party Library packages" — bundled with the CLI install but installable/upgradable independently?

**Pros (hypothesised):**
- Upgrade modes without upgrading whole manta CLI.
- Community can fork an in-tree mode as a starting point.
- Forces the library extension points to be real (no special "in-tree mode" code path).

**Cons (hypothesised):**
- Runtime complexity — bundled-but-overridable is harder to reason about than "bundled".
- Version skew — user has manta 0.7 with bundled modes 0.7, then library-installs `recon-swarm@0.6` shadowing the bundle, then `forking-realities` (still using bundled 0.7) silently expects the 0.7 contract.
- Cost of extraction is large — see §4.3.

### 4.2 Recommendation: **bundled now, extract on demand**

Concretely:

1. **Phase 7 ships the registry seam, not the extraction.** Introduce `ModeRegistry` (§4.4) that in-tree modes register into at startup. Library modes register at arm-time. The cast dispatcher resolves both through the same interface. This makes the architecture extension-ready without paying the extraction cost.

2. **Keep all 7 modes in `@manta/cli` source.** They continue to ship with the CLI install (`npx manta@latest install`). They are *not* library packages — they are first-party modes with privileged access to internal surfaces that library packages can't import. This avoids the API-versioning headache for the modes that are most tightly coupled to manta itself.

3. **Extract on community pull, not on architectural prediction.** The trigger for extracting a mode to a library package is: a community author has forked it, made a meaningful change, and the only path to ship that change is a real library package. Until that happens, extraction is YAGNI.

4. **First library mode is a new mode, not an extracted one.** The dogfood for Phase 7 is: someone writes a *new* mode (clone B's auto-trigger research hints at candidates — a mode designed around git-pull triggers, say) and publishes it via `/manta share`. That validates the publish + install + cast path on a mode that wasn't already in-tree. If it works for a new mode, extraction of existing modes becomes a refactor question (and a possibly-unnecessary one).

### 4.3 Cost evidence from the code

Why "extract now" is expensive:

- **`SUPPORTED_MODES` is a closed Set.** `packages/manta-cli/src/commands/cast.ts:35-43` defines `const SUPPORTED_MODES: ReadonlySet<Mode>` with seven literal strings, validated against by `cast.ts:132-137`. Library mode names won't be in this set. Either widen to `Set<string>` (loses type safety) or replace with a registry lookup.
- **`Mode` is a Zod `z.enum`.** `packages/manta-snapshot/src/schema.ts:4-15` defines `ModeSchema` with ten literals (the seven shipping + three Aghs). It is referenced in `TaskContractSchema` (`schema.ts:30`) and `SnapshotSchema.refine` (`schema.ts:85-88`). A library mode breaks the enum. Either widen to `z.string()` (loses the closed-set guarantee everywhere downstream) or split into `BuiltinModeSchema` (enum) and `LibraryModeIdSchema` (regex) with a discriminated union — a real refactor.
- **Per-mode hardcoded validation.** `cast.ts:148-171` has six per-mode `if` blocks enforcing clone-count rules, daemon-mode requirements, refactor-wave tasks file presence, etc. These are mode metadata, currently hardcoded against literal mode names. They need to move to `manifest.mode.cloneCount` (`min`/`max`) and similar fields — work already done by the manifest schema in §1.3, but the *consuming side* (the validation in cast.ts) needs to be refactored to read from registry-resolved manifests instead of hardcoded `if`s.
- **Per-mode hardcoded dispatchers.** `cast.ts:27-30` imports four dispatcher classes (`PairDispatcher`, `DocChaseDispatcher`, `TestStormDispatcher`, `BroadcastReader`) and instantiates them per-mode. To make this registry-driven, each dispatcher needs a registration call and the cast loop reads dispatchers from the registry.
- **Per-mode hardcoded priming.** `packages/manta-cli/src/spawner/priming.ts:1-19` has the base template and (presumably, given the constants we read) per-mode blocks (`BUG_HUNT_BLOCK`, `MODULE_BOUNDARY_BLOCK`, `DAEMON_MODE_BLOCK`, `DOC_CHASE_BLOCK`, `PAIR_PROTOCOL_BLOCK`). Each is appended via mode-specific switch logic. To extract, every block needs to ship as a `priming.txt` artifact in the mode's package, loaded at cast time.

That's 5 distinct refactor surfaces. Doing all five at once *and* designing the registry seam *and* designing the share/install path is too much for one phase. Pick the registry seam (cheap, high leverage), defer the rest.

### 4.4 The registry seam Phase 7 should ship

Minimal interface:

```ts
// proposed: packages/manta-cli/src/modes/registry.ts (new file)
import type { Mode } from '@manta/snapshot';
import type { DispatchEnqueuer } from '../dispatch/types.js';

export interface ModeDefinition {
  /** Stable identifier — for in-tree, equals the Mode literal; for library, equals manifest.name. */
  id: string;
  /** True when the mode is part of @manta/cli source, false when loaded from ~/.manta/library. */
  origin: 'in-tree' | 'library';
  /** Cast-time clone count bounds, replaces the if-block at cast.ts:148-171. */
  cloneCount: { min: number; max: number };
  /** "batch" or "daemon" session mode. */
  sessionMode: 'batch' | 'daemon';
  /** Optional dispatcher factory; only present for daemon modes. */
  createDispatcher?: () => DispatchEnqueuer;
  /** Priming text block for this mode. */
  primingBlock: string;
  /** Cross-mode invariants — refactor-wave needs --tasks, etc. */
  invariants?: (opts: { cloneCount: number; tasksFile: string | null }) => string | null;
}

export class ModeRegistry {
  private modes = new Map<string, ModeDefinition>();
  register(def: ModeDefinition): void { /* … */ }
  resolve(id: string): ModeDefinition | undefined { /* … */ }
  list(origin?: 'in-tree' | 'library'): ModeDefinition[] { /* … */ }
}
```

Wire-up:

- In `packages/manta-cli/src/index.ts` (or a new bootstrap file): register all 7 in-tree modes at startup. Each registration moves the current cast.ts:148-171 logic into the registry entry.
- In `cast.ts:132`: replace `SUPPORTED_MODES.has(opts.mode)` with `registry.resolve(opts.mode) !== undefined`.
- In `cast.ts:148-171`: replace per-mode if-blocks with `const def = registry.resolve(opts.mode); def.invariants?.({ cloneCount, tasksFile })`.
- In `cast.ts:27-30` and downstream: replace direct dispatcher imports with `def.createDispatcher?.()`.

Once that lands, library modes register via the same `ModeRegistry.register()` call — invoked by the install/arm path after manifest validation. The in-tree modes don't move; the seam exists; YAGNI is respected.

Note for plan-phase reviewer: this refactor is mechanical but touches every per-mode `if` in cast.ts. Worth a dedicated chunk in the Phase 7 plan. Estimate: one cast (forking-realities, 2 clones racing two different registry designs).

---

## 5. Discovery

### 5.1 Recommendation: GitHub curated index now; npm scope for actual hosting; no custom registry

Concretely Phase 7 ships:

1. **`manta-library/index` GitHub repo** (under a new `manta-library` GitHub org we create). One JSON file per package, named `<name>.json`, containing manifest summary + GitHub repo URL + npm package name. Curated by manta maintainers via PR review.
2. **`manta library search <query>`** searches the local cache of `index.json` (re-fetched on `manta library refresh`). Plain string-match against name and description. No fancy ranking.
3. **Packages themselves live on npm** under `@manta-library/<name>`. `manta library install <name>` resolves via the index, then `npm pack`s the resolved package, then unpacks under `~/.manta/library/<name>/`.

Why not the alternatives:

- **npm-only search** (no curated index): npm's search is poor for this use case. There's no concept of "manta mode" in npm metadata. Anyone could publish `@manta-library/*` if they squat the scope, or worse, publish under random scopes claiming to be manta modes.
- **Custom registry HTTP API + CDN**: infrastructure we don't have, can't pay for, and shouldn't take on as a maintenance burden in Phase 7.
- **Website**: explicitly out of scope per task brief. Could come in Phase 8.
- **Git-based install** (`manta library install git+https://...`): support it as a fallback for local dev and forks, not as the primary path. Doesn't require infrastructure but doesn't help discovery.

### 5.2 The curated-index bootstrap

The index repo starts with zero packages. The first commit adds an empty `packages/` directory and a `CONTRIBUTING.md` explaining the PR review checklist (mostly: manifest passes schema, scan passes, name doesn't typosquat, license is OSI-approved). The first PR is one of the seven in-tree modes (or, per §4.2, a *new* mode someone writes specifically to validate the path).

This bootstraps slowly. That's fine. Slow community growth is preferable to a flood of low-quality packages that erode the trust model.

### 5.3 Squatting and naming

The index has authority over names. If `recon-swarm` is added to the index pointing at `@manta-library/recon-swarm`, a future attempt to add a different package with the same name is a PR-review rejection. npm scope `@manta-library/*` is owned by the manta org; maintainers control who can publish.

For non-curated packages (private forks, internal-only modes), `manta library install git+https://...` works without going through the index. Those packages are visible to nobody but the user installing them. That's by design.

---

## 6. Codebase audit — file:line references for Phase 7 implementation

Numbered to match the task's section (6). Each entry is "where the change goes" for the implementing plan.

### 6.A — Snapshot builder and task-contract sanitization

**File:** `packages/manta-cli/src/spawner/snapshot-builder.ts`
**Build site:** `buildCloneSnapshot()` at lines 24–62. This is the constructor of every `Snapshot` that flows into the bus and onto disk via `captureState`.
**Fields that need sanitization before publishing:**

- `parentWorktree` (line 49) — absolute path.
- `cloneWorktree` (line 50) — absolute path.
- `parentPid` (line 14, used in `parentPid:` field) — host PID.
- `parentSessionId` (line 16, used in `parentSessionId:` field) — internal Claude Code session identifier.
- Everything that `captureState` constructs downstream — see `packages/manta-snapshot/src/serialize.ts` and `capture.ts` (read those when implementing sanitizer).

**Sanitization seam:** add `packages/manta-cli/src/share/sanitize-snapshot.ts` exporting `sanitizeSnapshot(s: Snapshot): { sanitized: SanitizedSnapshot; warnings: SanitizationWarning[] }`. The output type is a new Zod schema in `packages/manta-snapshot/src/schema.ts` (call it `SanitizedSnapshotSchema`) that omits the four fields above and replaces them with literal markers.

**Task-contract:** the on-disk task contract lives at `<repo>/.manta/state/contracts/<clone-id>.json` (computed by `packages/manta-bus/src/state/paths.ts:46-52`). The schema is `TaskContractSchema` (`packages/manta-snapshot/src/schema.ts:28-39`). Fields needing sanitization:
- `scope.allowedPaths` / `scope.forbiddenPaths` — relativize.
- `task` — secret-format scan.
- `approachHint` — secret-format scan.

**There is no existing `snapshot-builder` sanitizer.** Phase 7 introduces it.

### 6.B — Post-mortem writer (PII enumeration)

**File:** `packages/manta-orchestrator/src/post-mortem.ts`
**Render site:** `renderMarkdown()` at lines 69–106. Every line emits a field that ends up in the bundled post-mortem.

Fields, by line:

| Line | Field | Sanitize? |
|---|---|---|
| 71 | Heading: clone_id | No (cloneId is non-sensitive) |
| 73 | `record.mode` | No |
| 74 | `record.worktree` | **Yes** — absolute path |
| 75 | `record.parent_pid` | **Yes** — drop |
| 76 | `record.registered_at` | **Yes** — make relative |
| 77 | `record.last_heartbeat_at` | **Yes** — make relative |
| 78 | `record.died_at` | **Yes** — make relative |
| 79 | `record.state` | No |
| 80 | `opts.reason` | No (caller-provided; from orchestrator code, not user data) |
| 81 | `record.death_reason` | No |
| 83–87 | `record.metadata` entries | **Yes** — allowlist (only `cast_id`, `cast_mode`) |
| 100–101 | `events[].payload` | **Yes** — recursive path-scan |

**Writer:** `fsPostMortemWriter` (`packages/manta-orchestrator/src/post-mortem-writer.ts:37-53`) writes under `<repo>/docs/post-mortems/`. For sharing, `/manta share` reads from the same directory (post-mortems are already on disk by the time share runs).

**Sanitization seam:** `packages/manta-cli/src/share/sanitize-post-mortem.ts`. Input: raw markdown body + the `BusEvent[]` array still on disk via `events.ts:readAll()`. Output: sanitized markdown + warnings.

### 6.C — ZK note write path

**MCP tool handler:** `packages/manta-bus/src/tools/memory.ts:14-32` (`createMemoryHandlers.zkWrite`). Parses input via `ZkWriteInputSchema` (referenced at line 16; defined in `packages/manta-bus/src/schema.ts`). Emits a `zk_write` event (line 27) and delegates to the writer.

**Filesystem writer:** `packages/manta-bus/src/memory-writers.ts:80-116` (`fsMemoryWriters.zkWrite`). Writes under `<repo>/docs/zk/<slug>-<id>.md`. Frontmatter format at lines 91-105:

```
---
id: <nanoid8>
title: <user-provided>
clone_id: <user-provided>
created_at: <epoch ms>
tags: [<json-encoded tags>]
---

# <title>

<body — user-provided>
```

**For bundling:**
- Frontmatter: replace `created_at` (epoch ms) with the manifest's `castOrigin.bundledAt` ISO date. Keep `clone_id`, `title`, `tags`, `id` unchanged.
- Body: user-controlled prose. Scan for path patterns (absolute paths matching `^/`, `~/`, or the parent-worktree prefix) and secret-format patterns; warn (do not auto-redact — the prose may be inseparable from the path reference).

**Discovery:** `/manta share` finds the relevant ZK notes by querying the events log (`events.jsonl` at `paths.eventsLog` per `packages/manta-bus/src/state/paths.ts:36`) for `type: 'zk_write'` events from the winning clone, then reads each file at the recorded `payload.path`. No new scanning needed — the audit trail is already there.

### 6.D — Skill-validator extension for library packages

**File:** `packages/manta-skill-validator/src/walk.ts:22-65` (`walkSkillsAndCommands`). Walks `<repoRoot>/skills/` and `<repoRoot>/commands/`.

**File:** `packages/manta-skill-validator/src/schemas.ts:7-15` (`SkillFrontmatterSchema`). Currently validates: `name`, `description`, `audience`, `version`, `related`. Strict.

**File:** `packages/manta-skill-validator/src/validate.ts:54-60` (`validateSkill` / `validateCommand`). Pure function over (path, source). No filesystem coupling.

**Library extension needed:**

1. **Library-aware walk.** Add `walkLibrarySkills(repoRoot: string, libraryRoot: string): Promise<DiscoveredFile[]>` that also walks `~/.manta/library/*/skills/`. Same validation rules apply via the existing `validateSkill`.
2. **Manifest validator.** Add `validateLibraryManifest(source: string): ValidationReport` in a new file `packages/manta-skill-validator/src/validate-manifest.ts`, using `ManifestSchema` from §1.3. The library install path calls this before extracting.
3. **Combined report.** `validateAll(repoRoot)` (`walk.ts:74-87`) returns a `ValidateAllResult`. Extend to optionally include library-installed skills under a separate `librarySkills` field. The repo's own skill validity must remain independent of any library state.

**No breaking changes** to the existing validator surface. The library logic is additive — `@manta/skill-validator` becomes the single entry point for both in-repo and library content validation.

### 6.E — `cast.ts` mode resolution (where library modes register)

**File:** `packages/manta-cli/src/commands/cast.ts`

The choke points where mode registration matters:

| Line | What it does | Phase 7 change |
|---|---|---|
| 35–43 | `const SUPPORTED_MODES: ReadonlySet<Mode>` (hardcoded 7) | Replace with `registry.list()` call |
| 45–49 | `const DAEMON_MODES: ReadonlySet<Mode>` (hardcoded 3) | Replace with `def.sessionMode === 'daemon'` check |
| 132–137 | `if (!SUPPORTED_MODES.has(opts.mode))` validation | Replace with `if (!registry.resolve(opts.mode))` |
| 148–171 | Per-mode invariant if-blocks | Move to `ModeDefinition.invariants` callback |
| 27–30 | Dispatcher imports + per-mode instantiation | Move to `ModeDefinition.createDispatcher` factory |

**Registry initialisation site:** `packages/manta-cli/src/index.ts` (or a new `src/modes/builtin.ts`). Each of the 7 in-tree modes registers itself with the registry at module load. Library-installed modes register via the `manta library arm <name>` command, which calls `registry.register(loadFromManifest(<name>))`.

**Priming text:** `packages/manta-cli/src/spawner/priming.ts:1-19` builds the priming text via `PRIMING_TEMPLATE`. Mode-specific blocks (`BUG_HUNT_BLOCK`, `MODULE_BOUNDARY_BLOCK`, `DAEMON_MODE_BLOCK`, `DOC_CHASE_BLOCK`, `PAIR_PROTOCOL_BLOCK`) are appended conditional on the mode. Phase 7 change: replace the conditional appends with `def.primingBlock` lookup.

### 6.F — Other file:line refs cited in this doc

- spec community Sections: `docs/superpowers/specs/2026-05-06-manta-pattern-design.md:486` (`Manta Share`), `:542` (`/manta install`), `:543` (`/manta share`), `:644` (Phase 7 community charter).
- Bus tools surface: `packages/manta-bus/src/tools/parse.ts` (the `parse()` helper used everywhere), `packages/manta-bus/src/tools/memory.ts:16` (the canonical `.strict()` parse pattern this doc adopts).
- Forbidden state: `packages/manta-bus/src/state/paths.ts:24-61` enumerates every file under `.manta/state/`. Library install must never touch this directory — the sandbox boundary is at `~/.manta/library/`. The `.gitignore` already excludes `.manta/state` (per CLAUDE.md "что в репо не должно появляться"); Phase 7's contribution is the install-side equivalent.

---

## 7. Open questions for plan phase

1. **Where does the manifest's `mantaVersion` range get evaluated?** Library install command needs a semver lib. We have none in `@manta/cli` deps today. Recommendation: `semver` (npm) — small, well-known, MIT. Add it to `@manta/library`'s dependencies, not to `@manta/cli` itself.

2. **`dispatch/index.js` ABI.** When Phase 7 ships `@manta/dispatch-api`, what exactly is in it? Minimum surface: the `DispatchEnqueuer` interface from `packages/manta-cli/src/dispatch/types.ts`, plus the `BroadcastReader` class. Anything else is internal until proven needed.

3. **Local-package install for dev.** Authors developing a mode want `manta library install ./my-mode/` to install from a directory. Should this bypass the integrity check? Recommendation: yes, with a banner — "installed from local directory; integrity check skipped; not suitable for production." Same pattern as `npm link`.

4. **Removing a library mode mid-cast.** What happens if the user runs `manta library uninstall <name>` while a cast using that mode is in flight? Recommendation: uninstall refuses if any active cast references the mode (check the registry against `<repo>/.manta/state/casts/`). Force flag overrides but with a destructive-action confirmation.

5. **License compatibility for first-party extracted modes.** When/if we extract an in-tree mode to a library package, the package inherits Manta's MIT license. The manifest declares MIT, the GitHub repo is MIT. Document this as the canonical first-party path so community licence questions have a precedent.

6. **Telemetry boundary.** Even the GitHub-index discovery path has a privacy question: does `manta library refresh` fetch the index over HTTP? Recommendation: yes, but as the only network call the library subsystem makes by default. No fetches during `cast` or `install` of an already-resolved package. Document it.

---

## 8. Phase 7 implementation sketch — for the plan-phase author

Suggested chunk breakdown (NOT a plan — that's the next document's job):

| Chunk | Scope | Roughly |
|---|---|---|
| C1 | Manifest schema (`@manta/library` package, `ManifestSchema` + `validateLibraryManifest`) | small, no UI |
| C2 | `ModeRegistry` (registry data structure, in-tree-mode registrations, cast.ts refactor to use it) | medium, touches cast.ts widely |
| C3 | `manta library install/uninstall/arm/preview` commands (no scanner yet — that's C5) | medium, new CLI surface |
| C4 | Sanitization (snapshot, post-mortem, ZK, task contract) + `manta share` command | medium, multiple new sanitizer files |
| C5 | Static malicious-pattern scanner + `manta library preview` integration | medium, new scanner package |
| C6 | Discovery (`manta library search`, `manta library refresh`, GitHub-index protocol, `manta-library/index` repo bootstrap) | small + external repo creation |
| C7 | Version compat check (install/arm/cast checkpoints, `semver` integration) | small but cross-cuts every entry point |
| C8 | End-to-end test cast: publish-a-mode → install-a-mode → cast-it round trip on a real new mode | medium, exercises everything |

Chunks C1, C2 are parallelisable (no shared files). C3 depends on C1, C2. C4 is independent of all of them and parallelisable with C2 and C3. C5 depends on C3 (scanner is invoked by install). C6 depends on C3. C7 depends on C2. C8 depends on all.

Plausible cast layout: forking-realities for C2 (registry design has real alternatives); recon-swarm to map the sanitizer field-by-field before C4; the rest are single-clone implementation tasks.

---

## 9. Sibling-clone deliverables to cross-read at plan phase

- `phase-7-manta-library.md` (clone A): the `/manta install` flow, the `~/.manta/library/` layout, the registry/distribution decision. This doc's §1.2 directory layout and §5 discovery recommendation must match what clone A produces. If they diverge, the share/install contract is broken — block plan phase until reconciled.
- `phase-7-auto-cast-triggers.md` (clone B): the auto-cast safety story. This doc's §2 trust model intentionally does not cover the "trigger → cast → modifies file → triggers again" loop; that's clone B's territory. Cross-reference rather than duplicate.

If clones A and B produce designs that contradict the recommendations here (in particular: §1.2 bundle layout, §3 mantaVersion semantics, §4 registry seam shape), reconcile through a Plan-phase reviewer subagent pass before any chunk lands — same `reviewer-per-chunk` discipline CLAUDE.md mandates.

---

## 10. References

- Spec — `docs/superpowers/specs/2026-05-06-manta-pattern-design.md` lines 486, 542, 543, 644 (community surface).
- CLAUDE.md "Quality bar — PROD only" — informs the deferred-vs-shipped mitigations in §2.
- CLAUDE.md "Skill/priming/enforcement HARD RULES" — the trust-model deferrals in §2 reflect the same "hard invariants must be enforced by harness, not by markdown" lesson, applied to install-time vs runtime.
- `packages/manta-skill-validator/src/{schemas,validate,walk}.ts` — the parser/validator pattern this doc reuses for the manifest.
- `packages/manta-bus/src/tools/memory.ts:14-32` and `packages/manta-bus/src/memory-writers.ts:80-116` — ZK write audit-first pattern, referenced when sanitizing ZK notes for publish.
- `packages/manta-orchestrator/src/post-mortem.ts:69-106` and `post-mortem-writer.ts:37-53` — post-mortem render+write surfaces being sanitized in §6.B.
- `packages/manta-cli/src/commands/cast.ts:35-171` — mode validation, the surface refactored by the registry in §4.4.
- `packages/manta-snapshot/src/schema.ts:4-88` — Mode + Snapshot schemas being extended in §3.3 and §4.3.
- `packages/manta-cli/src/spawner/snapshot-builder.ts:24-62` and `priming.ts:1-19` — clone-spawn surfaces feeding sanitization (§6.A) and priming-block extraction (§6.E).

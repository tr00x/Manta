# Phase 7 — Manta Library

**Status:** Research deliverable (recon-swarm clone-A, cast-1779977834212, 2026-05-28)
**Scope:** Design the package format, registry, distribution model, and install/share command surface for Manta Library (spec Sec 11.1 line 476, Sec 12 lines 542–543).
**Source of truth (what we are building):** `docs/superpowers/specs/2026-05-06-manta-pattern-design.md`
**Phase budget heuristic:** prefer the option that ships in **1–2 chunks**, not the option that's "best in 2 years". Custom registry is Phase 8+.

---

## TL;DR — Recommendation block

| Axis | Decision | Why now |
|---|---|---|
| Package format | Mirror Claude Code plugin layout (`skills/`, `commands/`, `hooks/`, `modes/`, `templates/`, `config/`) with root **`manta-package.json`** manifest | Spec Sec 9 line 397 already commits Manta itself to plugin form; library packages are *the same thing*, smaller scope. Reuse `@manta/skill-validator` (`packages/manta-skill-validator/src/walk.ts:22`) instead of inventing a parallel discovery surface. |
| Registry primary | **npm scope `@manta-library/*`** + tarball download via `npm pack` | Zero infra. Existing auth (`npm login`), provenance (npm sigstore), versioning (semver), CDN (registry.npmjs.org), and security scanning come free. Matches `npx manta@latest install` precedent (spec line 397). |
| Registry fallback | **Git URL** install (`manta install git+https://github.com/u/r#tag`) | Lets packages exist before publishing, supports private repos, decentralised authoring. Same resolve→validate pipeline. |
| Registry deferred | Custom HTTP API + moderation CDN | Phase 8+. Add only after npm volume justifies it (≥100 published packages OR a sandbox-breakout incident). |
| Install destination | `~/.manta/library/<scope>/<name>/<version>/` (content-addressed by manifest hash inside the version dir) | Multi-version coexistence, no global mutex, atomic swap via `rename(2)`. |
| Lockfile | `manta-lock.json` at repo root, JSON, manifest-version + hash-pinned | Same shape as `package-lock.json` lessons; round-trippable; one source of truth per repo. |
| Share output | `./manta-shares/<cast-id>.mantapkg.tar.gz` (local-only by default) | Threat-model default-deny: no auto-publish. `--publish` is an explicit second action with login + interactive confirm. |
| Mode registration | Move `SUPPORTED_MODES` (`packages/manta-cli/src/commands/cast.ts:35`) behind a `ModeRegistry` seeded with built-ins + library entries | Single seam for `manta cast` to discover both first-party and installed-library modes. |

**Chunk plan (1–2 chunks total):**

* **Chunk 1 — Install path:** `manta-package.json` schema, `~/.manta/library/` layout, `manta install <pkg>` (npm + git), lockfile read/write, validator integration, `ModeRegistry` retrofit so installed modes appear in `manta cast` mode list.
* **Chunk 2 — Share path + uninstall:** `manta share <cast-id>` bundling with sanitization, `manta uninstall`, compat check on `manta cast`, `--publish` flow (login passthrough only — does not host).

Custom registry, signature verification beyond npm provenance, sandbox-per-mode, and moderation tooling are explicitly **Phase 8+** to keep Phase 7 in the 1–2 chunk envelope.

---

## 1. Package format — disk layout + manifest schema

### 1.1 Precedent comparison

| System | Manifest | Discovery | Versioning | Verdict for Manta |
|---|---|---|---|---|
| Claude Code plugin (Manta itself, spec line 397) | implicit (npm `package.json` + Claude-Code-specific entry hints) | `skills/`, `commands/`, `hooks/` directory walk | npm semver | **Match this.** Zero cognitive overhead for users; same brain that loaded Manta loads a Library package. |
| VS Code extension | `package.json` + `contributes.*` block | `activationEvents` declares triggers up front | npm semver via VSIX | Useful idea: a `contributes` block declares *what kinds of things this package adds*, so the loader skips dir-walking sections that don't apply. **Borrow this.** |
| Homebrew formula | Ruby DSL + bottle | curl from GitHub | semver in formula | Too imperative. We want declarative manifests, not code that runs at install. **Skip.** |
| npm module | `package.json` + `main` / `exports` | `node_modules/` resolution | semver | We're using the *registry*, not the resolver. Manta packages are data + markdown, not Node libraries. Manifest borrows shape, not semantics. |

**Lesson taken from the comparison:** declarative manifest, dir-walked content, version pinned by hash, *no install-time code execution*. Install-time code is how supply-chain attacks live. Manta packages are markdown + JSON + (optionally) hook scripts that run inside the user's existing Claude Code sandbox under the same PreToolUse hooks they already have.

### 1.2 On-disk layout

```
@manta-library/refactor-megapack/
├── manta-package.json          ← REQUIRED root manifest
├── README.md
├── LICENSE
├── skills/
│   └── <skill-name>/SKILL.md   ← validated by walkSkills, packages/manta-skill-validator/src/walk.ts:29
├── commands/
│   └── <name>.md               ← validated by walkCommands, packages/manta-skill-validator/src/walk.ts:49
├── modes/
│   └── <mode-name>/
│       ├── mode.json           ← name, description, capability profile
│       └── priming.md          ← optional preamble appended to clone --append-system-prompt
├── templates/                  ← cast templates (saved configurations from spec Sec 11.1 #4)
│   └── <template-name>.yaml
├── hooks/                      ← optional, ALWAYS opt-in at install time
│   └── pre-tool-use/<name>.sh
└── config/
    └── defaults.json           ← merged into user's manta.config.json on install
```

**Why this layout:**

* `skills/` and `commands/` are byte-identical to the existing repo-level layout (`packages/manta-skill-validator/src/walk.ts:30`, `:50`). The validator can run unmodified — point its `repoRoot` argument at the unpacked package dir.
* `modes/<name>/mode.json` is the **new** payload that motivates the whole feature. Without library modes, this whole layer is just "shared skills" which is solvable with `git submodule`. Modes — community-authored cast configurations with priming, capability profile, and policy — are the differentiator.
* `hooks/` is **opt-in at install time** with an explicit prompt: "Package X wants to install hooks that run on Y events. Allow? [y/N]". Default no. This is the only install-time-executable surface, treated as a privileged operation.
* `templates/` is the disk format for spec Sec 11.1 #4 (Manta Templates). Sharing a template *is the most common case*, so it gets a top-level dir.

### 1.3 Manifest schema — `manta-package.json`

Zod-style for forward parity with the existing `packages/manta-snapshot/src/schema.ts:4` style.

```ts
const MantaPackageManifest = z.object({
  // Identity ─────────────────────────────────────────────────
  schemaVersion: z.literal(1),                    // bump when manifest shape breaks
  name: z.string().regex(/^@manta-library\/[a-z][a-z0-9-]*$/)
        .or(z.string().regex(/^[a-z][a-z0-9-]*$/)), // scoped (npm) or bare (git)
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/), // semver
  description: z.string().min(10).max(280),
  author: z.string().min(1),
  license: z.enum(['MIT','Apache-2.0','BSD-3-Clause','BSD-2-Clause',
                   'ISC','MPL-2.0','GPL-3.0','UNLICENSED']),
  homepage: z.string().url().optional(),
  repository: z.string().url().optional(),

  // Compatibility ────────────────────────────────────────────
  mantaVersionCompat: z.string(),  // semver range, e.g. ">=0.8.0 <1.0.0"
                                   // checked against manta-cli pkg version at install
                                   // AND at `manta cast` time (per spec deliverable §5)

  // What this package contributes (VS-Code "contributes" pattern) ─
  contributes: z.object({
    skills: z.array(z.string()).default([]),      // relative paths under skills/
    commands: z.array(z.string()).default([]),    // relative paths under commands/
    modes: z.array(z.object({
      name: z.string().regex(/^[a-z][a-z0-9-]*$/),
      description: z.string().min(10).max(280),
      basedOn: z.enum([                           // inherits behaviour from a built-in
        'recon-swarm','forking-realities','bug-hunt',
        'refactor-wave','pair-programming','test-storm','documentation-chase'
      ]),
      cloneCount: z.object({ min: z.number(), max: z.number() }),
      sessionMode: z.enum(['batch','daemon']),
      capabilityProfile: z.string().optional(),   // future Phase 4 capability hook
    })).default([]),
    templates: z.array(z.string()).default([]),
    hooks: z.array(z.object({
      event: z.enum(['PreToolUse','PostToolUse','UserPromptSubmit',
                     'SessionStart','Stop']),
      script: z.string(),                         // relative path under hooks/
      requiresApproval: z.literal(true),          // hard-coded; never silent install
    })).default([]),
  }),

  // Dependencies (other library packages) ────────────────────
  deps: z.record(z.string()).default({}),         // name → semver range, install-time resolved

  // Integrity (filled by `manta install`, not by author) ─────
  // Persisted in manta-lock.json after install. Authors leave this empty.
  integrity: z.object({
    contentHash: z.string().regex(/^sha256-[A-Za-z0-9+/]+=*$/),
    publishedAt: z.string(),  // ISO-8601
  }).optional(),
});
```

**Key design choices:**

* `mantaVersionCompat` is **mandatory** — packages must declare compatibility. Friendly error path described in §5.
* `contributes` declares the surface up front. The loader skips the `skills/` directory walk entirely if `contributes.skills` is empty — defence-in-depth against drive-by content.
* `hooks[].requiresApproval` is hard-coded `true` in the schema. The loader refuses to install a hook silently even if the manifest doesn't ask. Belt-and-braces.
* `basedOn` makes library modes *parameterise* an existing dispatcher rather than ship runtime code. A library mode that says `basedOn: "pair-programming"` reuses `PairDispatcher` (`packages/manta-cli/src/commands/cast.ts:27`) with a different priming preamble + clone-count window. **No arbitrary JS in modes.**

### 1.4 Why no `entrypoint: "index.js"`

Tempting, but no. Arbitrary JS execution from a downloaded package = full supply-chain risk surface (cf. npm `colors.js` Jan 2022, `event-stream` 2018). Manta packages are **declarative**: priming text, skill markdown, mode parameters, optional hooks that ride the user's already-approved hook policy. If a future package genuinely needs custom code, that future package files a Phase 8+ feature request and we design the sandbox properly.

---

## 2. Distribution registry — comparison + recommendation

### 2.1 Options matrix

| Option | Infra cost | Time to ship | Auth | Moderation | Verdict |
|---|---|---|---|---|---|
| **(a) npm scope `@manta-library/*`** | $0 | days | `npm login` + sigstore provenance | npm abuse team + we curate the scope | **Primary.** |
| **(b) Custom registry HTTP API + CDN** | $20–200/mo (R2 + Cloudflare Worker) | weeks–months | bespoke OAuth, JWT, key rotation | we build it | Phase 8+. |
| **(c) GitHub repos w/ manifest discovery (`manta search`)** | $0 | medium | GitHub login | nothing | Discovery layer for git-installed packages — additive, not primary. |
| **(d) git URL install (`git+https://`)** | $0 | hours | Whatever the git host enforces | nothing | **Fallback / alpha distribution path.** |

### 2.2 Why npm primary

1. **Spec already commits to npm** for Manta itself (`npx manta@latest install`, spec line 397). Using the same registry for library means *one user mental model*.
2. **Sigstore provenance** is free for public packages — npm verifies `git+sha → tarball → signature` end-to-end on publish. We get supply-chain integrity without writing it.
3. **Semver, dist-tags, deprecation, unpublish-with-grace-period** are all solved problems on npm. Phase 8 custom registry would reinvent each.
4. **Search:** `npm search @manta-library/` is a free `manta search <term>` impl until we want fancier.
5. **Moderation outsourced:** npm abuse@npmjs.com handles takedowns; we own the scope, so we can deprecate squatters via the scope admin tools.

### 2.3 Why git URL fallback (not "decentralised primary")

`manta install git+https://github.com/user/repo#v1.2.3`:

* Lets a package exist *before* being npm-published — useful for internal/private libs, early prototyping.
* Supports private repos via `gh auth` token reuse.
* **Same** validator pipeline (§3): clone → checkout tag → resolve manifest → validate.

But not primary because:

* No central discoverability (would need (c) on top).
* No content-addressed integrity for a `main` branch ref — git URLs without a `#<tag>` are hash-pinned via the lockfile only after first install.
* Forks make trust signal harder to reason about.

### 2.4 Custom registry — explicitly Phase 8+ trigger conditions

Build a custom registry only when *one* of these is true:

* ≥ 100 published `@manta-library/*` packages AND we need moderation richer than npm provides.
* A sandbox-breakout or supply-chain incident in npm-published Manta packages forces us to own the publishing pipeline.
* Enterprise users need private registries that npm Enterprise doesn't satisfy.

Until any of those — `npm registry + git URL` is sufficient for years.

---

## 3. `/manta install <package>` flow

### 3.1 Resolve → verify → extract → register → validate → surface

```
manta install <spec>
  1. Parse spec → { kind: 'npm' | 'git' | 'local-tgz', name, range }
  2. Compat preflight: read manifest.json without extracting
     (npm: `npm pack --dry-run` + tar header; git: shallow clone + cat manta-package.json)
     → reject early if mantaVersionCompat doesn't satisfy manta-cli version
  3. Fetch:
       npm  → `npm pack <name>@<range>` to a temp dir
       git  → `git clone --depth=1 --branch <ref>` to a temp dir; pack to tgz
       local → use as-is
  4. Compute sha256 of tarball → contentHash
  5. Extract to ~/.manta/library/.staging/<random>/
  6. Validate via @manta/skill-validator:
       a. read manta-package.json, parse against MantaPackageManifest zod schema
       b. walkSkillsAndCommands(stagingDir) → must have zero error-severity issues
       c. for each mode in contributes.modes: schema-validate mode.json
       d. for each hook: ensure script path exists, has +x bit, has shebang
       e. Cross-check: contributes.skills declares each path that walkSkills found,
          one-to-one. Drive-by skills not listed in manifest fail loudly.
  7. Atomic move: rename(staging/, ~/.manta/library/<scope>/<name>/<version>/)
  8. Append to manta-lock.json
  9. Register modes/skills/commands in ~/.manta/library/index.json
       (the registry that ModeRegistry reads at cast time)
 10. Print summary: skills/commands/modes added, hooks pending approval if any.
```

### 3.2 CLI flags

```
manta install <spec>            Install a package
                                spec ::= npm-spec | git-url | path
                                npm-spec ::= @manta-library/<name>[@<version>]
                                git-url ::= git+https://<host>/<path>[#<ref>]
                                path ::= ./local-package.tgz

  --no-validate                 Skip skill-validator (CI only; explicit)
  --no-hooks                    Refuse to install hooks even if approved
                                (default: hooks prompt interactively)
  --force                       Overwrite an existing same-version install
  --offline                     Only resolve from local cache; fail if uncached
  --integrity sha256-<hash>     Pin expected content hash; abort on mismatch
  --json                        Machine-readable output
  --dry-run                     Resolve + validate; do not write to ~/.manta/library
```

### 3.3 Error paths

| Failure | Surface | Cleanup |
|---|---|---|
| **Network — DNS / timeout / 5xx** | `[manta] install: cannot reach registry (cause: <err>). Retry, or use --offline if cached.` Exit 11. | Nothing on disk yet. |
| **Resolution — version not found** | `[manta] install: no version of <name> satisfies <range>. Available: <list>.` Exit 12. | Nothing on disk. |
| **Checksum / integrity** | `[manta] install: content hash mismatch (expected sha256-X, got sha256-Y). Refusing.` Exit 13. | Staging dir removed. |
| **Manifest invalid** | Validator's structured report, file:line per zod error. Exit 14. | Staging dir removed. |
| **Skill validation error** | Reuse existing `ValidationReport` from `packages/manta-skill-validator/src/walk.ts:74` `validateAll`. Print per-skill issues. Exit 14. | Staging dir removed. |
| **Conflict — same name+version already installed** | `[manta] install: <name>@<version> already installed at <path>. Use --force to replace, or `manta install <name>@<other-version>` to coexist.` Exit 15. | Nothing changed. |
| **Conflict — mode name collides with built-in** | `[manta] install: mode <name> conflicts with built-in mode. Rename in manta-package.json or do not contribute this mode.` Exit 14. | Staging dir removed. |
| **Hook approval declined** | Two outcomes via flag: continue install without hooks (default prompt), or fail install (`--require-hooks` for CI). | Hooks not copied; rest installed. |
| **manta-version-compat unmet** | `[manta] install: <name>@<ver> requires manta <range>; you have <current>. Upgrade with `npx manta@latest install` or pick an older package version.` Exit 16. | Nothing on disk. |
| **Disk full / EACCES on ~/.manta** | Surface the OS error verbatim, exit 17. | Staging cleaned on best-effort. |
| **Validator timeout** | Hard cap 30 s on validator; exit 14 with `validation_timeout`. | Staging removed. |

### 3.4 `manta uninstall <name>[@<version>]`

```
manta uninstall <spec>
  - If <version> omitted: refuse if multiple installed; print versions list.
  - Read ~/.manta/library/index.json → list contributed modes/skills/commands.
  - Remove ~/.manta/library/<scope>/<name>/<version>/ directory.
  - Drop from manta-lock.json.
  - Re-emit index.json without the package.
  - Refuse uninstall if any active cast (registry.json) is using a mode from
    this package — fail with exit 18 ("in-use"), advise `manta abort` first.
```

### 3.5 `manta library` — observability

```
manta library list           Installed packages + versions + paths
manta library show <name>    Manifest + contributed surface
manta library outdated       Available updates (npm-only; git URLs reported as "pinned")
manta library doctor         Re-run validator on every installed package
                             (catches manta-version-compat drift after `npx manta upgrade`)
```

---

## 4. `/manta share <cast-id>` flow

### 4.1 Bundle contents

```
<cast-id>.mantapkg.tar.gz
├── manta-share.json          ← share manifest (schema below)
├── README.md                 ← auto-generated narrative summary
├── contract/
│   └── <clone>.json          ← redacted task contract per clone
├── post-mortems/
│   └── <clone>.md            ← from .manta/state/post-mortems (sanitised)
├── last-gasps/
│   └── <clone>.md            ← copied from worktree root last-gasp-report.md
├── zk-notes/
│   └── <id>.md               ← ZK notes tagged with cast-<id> or clone-<id>
├── diffs/
│   └── <clone>.patch         ← `git format-patch` against cast base
├── merge-review.md           ← if forking-realities, the merge review verdict
├── timeline/
│   └── events.ndjson         ← redacted forensic timeline
└── insights.md               ← auto-extracted breakthroughs/blockers from events
```

### 4.2 Share manifest schema — `manta-share.json`

```ts
const ShareManifest = z.object({
  schemaVersion: z.literal(1),
  castId: z.string(),
  mode: ModeSchema,                            // reuse @manta/snapshot Mode union
  cloneCount: z.number().int().positive(),
  sessionMode: z.enum(['batch','daemon']),
  exportedAt: z.string(),                      // ISO-8601
  exportedBy: z.string().default('anonymous'), // auto-redacted unless --include-author
  mantaVersion: z.string(),                    // version of manta-cli that produced this
  redactionsApplied: z.array(z.string()),      // list of redaction rules applied
  contents: z.object({
    contracts: z.boolean(),
    postMortems: z.boolean(),
    lastGasps: z.boolean(),
    zkNotes: z.boolean(),
    diffs: z.boolean(),
    timeline: z.boolean(),
    mergeReview: z.boolean(),
  }),
  // Threat-model gates ───────────────────────────────────────
  publishable: z.boolean(),                    // true only after `--publish-ok` review
  signature: z.string().optional(),            // present only if user signed the bundle
});
```

### 4.3 Sanitization — exhaustive enumeration (default-deny)

Approach hint says: enumerate *every* artifact path that could leak. Doing that explicitly.

| Source | Path | Risk | Action |
|---|---|---|---|
| Snapshot | `.manta/snapshots/<cast>/<clone>.snapshot.json:taskContract.task` | Task may quote user paths / hostnames | **Redact** `$HOME` → `~`, hostname → `<host>`. Surface in `manta-share.json` `redactionsApplied`. |
| Snapshot | same file `: parentWorktree`, `cloneWorktree` | Full local paths reveal user identity | **Replace** with `<parent-worktree>`, `<clone-worktree>` placeholders. |
| Snapshot | `parentPid`, `castId` (timestamps in ms) | Mild fingerprint; ms-precision timestamp + uptime = device fingerprint | **Quantize** timestamps to day resolution; drop `parentPid`. |
| Snapshot | `recentMessages[]` | Often contain user prompts verbatim; emails/tokens common | **Hard exclude.** Never include. |
| Snapshot | `openFiles[]` | Reveals what user was reading | **Hard exclude.** |
| Registry | `.manta/state/registry.json` | Contains active PIDs, worktrees | **Hard exclude.** Re-derive minimal fields from contract + post-mortems. |
| Bus events | `.manta/state/events.jsonl` (timeline) | Broadcast payloads can contain raw error stacks, file paths | **Pass through redactor:** strip `$HOME`, hostnames, IPs, emails, common token shapes (`sk-…`, `ghp_…`, `npm_…`, `xoxb-…`, JWT-like base64`.…`). |
| Bus events | `.manta/state/timelines/<cast>.ndjson` | Same risk | Same pipeline. |
| Contracts | `.manta/state/contracts/<clone>.json` | Same as snapshot taskContract | Redact paths/hostnames. |
| Casts | `.manta/state/casts/<cast>.json` | Roster + policy. Contains `cloneAssignments` with `task` + `approachHint` per clone | Redact paths/hostnames in `task` and `approachHint`. |
| Worktree | `last-gasp-report.md` | Author-written; may include paths/hostnames | Pass through redactor; keep narrative. |
| Worktree | full file tree | Could include `.env`, secrets, untracked files | **Use `git format-patch` against cast base branch only.** Never `tar` raw working dir. |
| Post-mortems | `docs/post-mortems/<date>-cast-<id>-<clone>.md` | Author-written | Pass through redactor. |
| ZK notes | `docs/zk/*.md` filtered by tag `cast-<id>` or `clone-<id>` | Author-written; often surgical | Pass through redactor. |
| Forensic timeline | bus's NDJSON | Heartbeat metadata leaks parent_pid, exact ms | Quantize timestamps to second; drop `parent_pid` field. |
| Env | Any captured `process.env` | API keys, paths | **Hard exclude.** Never collect env. |
| MCP creds | `~/.claude/mcp.json` or per-project | Tokens, keys | **Hard exclude — out of share scope by design.** |
| Locks / claims | `.manta/state/locks.json`, `claims.json` | Operational state, no semantic value to share | **Hard exclude.** |
| Charges | `.manta/state/charges.json` | Cost ledger | **Hard exclude.** |
| Daily spend | `.manta/state/daily-spend.json` | Cost ledger | **Hard exclude.** |

**Redactor implementation:** single ordered pipeline executed before write. Pseudocode:

```
function redact(input: string, ctx: RedactCtx): string {
  return input
    .replaceAll(ctx.homeDir, '~')
    .replaceAll(ctx.hostname, '<host>')
    .replaceAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/gi, '<email>')
    .replaceAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replaceAll(/\b(sk|pk|ghp|gho|github_pat|npm|xoxb|xoxp|AKIA)[_-][A-Za-z0-9_-]{16,}/g, '<token>')
    .replaceAll(/eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+/g, '<jwt>')
    ;
}
```

The redactor runs *after* whitelisting which file paths we read from, not before. Two layers: only-known-safe paths + content scrub.

### 4.4 CLI flags

```
manta share <cast-id>
  -o, --out <path>            Output tgz path. Default: ./manta-shares/<cast-id>.mantapkg.tar.gz
      --publish               Push to npm registry after writing local file.
                              Requires `npm login` and interactive confirm.
      --name <pkg>            Required with --publish: target package name (@manta-library/...)
      --no-diffs              Exclude git patches (sometimes proprietary code)
      --no-zk                 Exclude ZK notes
      --include-author        Include git author from `git log -1 --format=%ae`.
                              Default: anonymous.
      --include-timeline      Include forensic timeline (verbose; default off)
      --dry-run               Build the bundle in a temp dir and print included
                              files, but do not write final tgz.
      --sign                  Sign the bundle with `gpg --detach-sign`.
      --json                  Machine-readable output
```

### 4.5 Publishing path — threat model

* **Default:** `manta share` writes a local file. **Zero network calls.** Period.
* **`--publish`** triggers, *in this order*:
  1. Refuse unless `manta-share.json.publishable === true` (set only after `--review-passed` step below).
  2. Run `manta share <id> --dry-run --json` and print the file list to stderr; require interactive `Type the cast-id to confirm publish:` (no `--yes` shortcut).
  3. Verify the user is logged in: `npm whoami`. If not, fail with `manta share: not logged in. Run \`npm login\` first.`
  4. Verify the target name is in the user's scope: `npm access ls-packages` or attempt scope ownership.
  5. `npm publish` the tgz.
* `--review-passed` is set automatically only when the bundle passes a checklist:
  * No tokens detected post-redaction (run redactor twice; second pass must be no-op).
  * No paths beginning with `/` in any included text file.
  * No file matching the `*.env` / `*.pem` / `id_rsa*` blocklist.
  * Bundle size < 5 MB (anything bigger is suspect; require `--allow-large`).
* **Never auto-publish.** Even with `--publish`, the interactive confirm is mandatory in TTY; in CI, require `MANTA_SHARE_PUBLISH_TOKEN` env var that the user has explicitly created and the CI's `--ci-confirm <cast-id>` flag, both matching.

### 4.6 Source artifacts — file:line references

* Snapshot schema (the canonical fields we redact): `packages/manta-snapshot/src/capture.ts:14` (parentPid, recentMessages, openFiles, parentWorktree, cloneWorktree).
* Contract on disk: written via `rt.ctx.contracts.write(busContract)` at `packages/manta-cli/src/commands/cast.ts:383`.
* Post-mortem writer: `packages/manta-orchestrator/src/post-mortem-writer.ts:15` (`postMortemDir` is the directory we copy from).
* Forensic timeline: `packages/manta-cli/src/commands/cast.ts:461` (`new ForensicTimelineWriter(timelinePath, …)`).
* Cast roster: `packages/manta-cli/src/commands/cast.ts:303` (carries `assignment` per clone, contains user-typed `task`).
* Snapshot path used by clones: `MANTA_SNAPSHOT_PATH` env var at `packages/manta-cli/src/spawner/clone-spawner.ts:162` — confirms snapshots are an MCP/CLI seam, safe to read.

---

## 5. Lockfile + version compatibility

### 5.1 `manta-lock.json` shape

Lives at repo root, **committed** to git. One file per repo. JSON. Stable key order, two-space indent (diff-friendly).

```jsonc
{
  "schemaVersion": 1,
  "mantaVersion": "0.7.2",          // version of manta-cli that wrote this lock
  "generatedAt": "2026-05-28T14:18:00Z",
  "packages": {
    "@manta-library/refactor-megapack": {
      "version": "1.3.0",
      "resolved": "https://registry.npmjs.org/@manta-library/refactor-megapack/-/refactor-megapack-1.3.0.tgz",
      "integrity": "sha256-aBcD...=",
      "contributes": {
        "modes": ["mega-refactor"],
        "skills": ["refactor-megapack-rules"],
        "commands": [],
        "templates": ["refactor-pr-flow"]
      },
      "mantaVersionCompat": ">=0.7.0 <1.0.0",
      "installedAt": "2026-05-28T14:18:00Z"
    },
    "@org/internal-bugfix-modes": {
      "version": "0.4.1-pre",
      "resolved": "git+https://github.com/org/internal-bugfix-modes.git#v0.4.1-pre",
      "integrity": "sha256-Xyz...=",
      "contributes": { "modes": ["triage-swarm"], "skills": [], "commands": [], "templates": [] },
      "mantaVersionCompat": ">=0.7.0",
      "installedAt": "2026-05-28T14:18:00Z"
    }
  }
}
```

### 5.2 Compat check on `manta cast`

Hook into the existing entry path:

* `runCastCommand` (`packages/manta-cli/src/commands/cast.ts:128`) currently validates `mode` against the hard-coded `SUPPORTED_MODES` set at `:35`.
* Phase 7 retrofit: replace `SUPPORTED_MODES.has(opts.mode)` (`:132`) with `modeRegistry.has(opts.mode)` where `ModeRegistry` is seeded from:
  1. Built-ins (the existing literal set — single source of truth migrates here).
  2. Lockfile-listed packages whose `contributes.modes[].name` matches.
* Before the `modeRegistry.has` lookup, run `verifyMantaVersionCompat(lock, mantaCliVersion)` once per cast. On mismatch:

```
[manta] cast: mode "mega-refactor" comes from @manta-library/refactor-megapack@1.3.0
        which requires manta >=0.7.0 <1.0.0. You have manta 0.6.5.

        Either:
          - Upgrade:    npx manta@latest install
          - Downgrade:  manta install @manta-library/refactor-megapack@<compatible-version>
          - Uninstall:  manta uninstall @manta-library/refactor-megapack
```

Exit code 16 (matches install-time `manta_version_compat_unmet`). Friendly, mechanical, lists three explicit recovery options. No silent "the mode disappears from the list."

### 5.3 Hash-pin policy

* `npm`-installed packages: `integrity` is the sha256 of the tarball (matches what npm records in its own `package-lock.json` as `integrity`).
* `git+`-installed packages: `integrity` is sha256 of the resolved-commit tree (`git archive --format=tar HEAD | sha256sum`). This is **strictly stricter** than the git ref alone — protects against force-push of a tag.
* On every `manta cast`, run a fast cheap check: compare on-disk content hash for each lock entry against the lock's integrity. Mismatch → exit 19 with `library_tampered`. (Re-validate is cheap; skill markdown is tiny.)

### 5.4 Why repo-root lockfile (not user-global)

* A `manta-lock.json` per repo means two engineers on the same project use the same library versions reproducibly. This is the same lesson as `package-lock.json`.
* A user-global registry (`~/.manta/library/index.json`) holds the *installation set* — multi-version coexistence. The repo lockfile holds the *active subset* for this project.
* `manta install <pkg>` writes to both. `manta cast` reads only the lockfile.

---

## 6. Codebase audit — concrete file:line references

### 6.1 Where `/manta install` and `/manta share` plug in

The existing CLI uses `commander` with one `.command(...)` chain per subcommand in **`packages/manta-cli/src/bin/manta.ts`**. Each subcommand:

1. Calls into a `runXCommand` function from `packages/manta-cli/src/commands/<x>.ts`.
2. Wraps it in `runWithRuntime` so it gets a composed `Runtime` (`packages/manta-cli/src/runtime.ts:36`).

Concrete insertion points:

* **Register `install`:** add the new `.command('install <spec>')` block in `packages/manta-cli/src/bin/manta.ts` adjacent to existing subcommand registrations. The current command registrations span roughly **`packages/manta-cli/src/bin/manta.ts:59`** (`cast`) through **`packages/manta-cli/src/bin/manta.ts:373`** (`feedback`). The natural locations:
  * `install`, `uninstall`, `library` — insert as a new group between `feedback` registration and `await program.parseAsync(process.argv)` at **`packages/manta-cli/src/bin/manta.ts:375`**.
  * `share` — insert in the post-mortem group near `replay` (`packages/manta-cli/src/bin/manta.ts:244`) since both deal with cast-id-keyed historical artifacts.
* **Implementation:** new files
  * `packages/manta-cli/src/commands/install.ts` — exports `runInstallCommand`, mirrors signature pattern of `runCastCommand` (`packages/manta-cli/src/commands/cast.ts:128`).
  * `packages/manta-cli/src/commands/share.ts` — exports `runShareCommand`. Reads via `rt.ctx.casts`, `rt.ctx.contracts`, `rt.ctx.events`, post-mortem writer's read counterpart.
  * `packages/manta-cli/src/commands/library.ts` — exports `runLibraryListCommand`, `runLibraryShowCommand`, etc.
* **Public re-export:** add the new commands to **`packages/manta-cli/src/index.ts:12`** so they sit next to `export * from './commands/cast.js'`.

### 6.2 Where installed-library modes register

* Hard-coded mode union: **`packages/manta-snapshot/src/schema.ts:4`** (`ModeSchema = z.enum([...])`). This is the *type-level* source of truth and stays as the **built-in catalog**.
* Hard-coded runtime allowlist: **`packages/manta-cli/src/commands/cast.ts:35`** (`SUPPORTED_MODES`). Phase 7 refactor: move this into a `ModeRegistry` class that combines `built-in modes` + `library-installed modes`.
* The validation check `if (!SUPPORTED_MODES.has(opts.mode))` at **`packages/manta-cli/src/commands/cast.ts:132`** becomes `if (!modeRegistry.has(opts.mode))`.
* Library modes that declare `basedOn: 'pair-programming'` (`contributes.modes[]` in the manifest) must wire into the same dispatcher branch as built-in pair-programming. The branch table currently:
  * Pair-programming preconditions/dispatcher: **`packages/manta-cli/src/commands/cast.ts:160`** + **`:404`**.
  * Test-storm preconditions/dispatcher: **`packages/manta-cli/src/commands/cast.ts:166`** + **`:413`**.
  * Documentation-chase queue prefill: **`packages/manta-cli/src/commands/cast.ts:424`**.
  * Refactor-wave / forking-realities (no dispatcher): merge-review path at **`packages/manta-cli/src/commands/cast.ts:606`**.
* For Phase 7, library modes inherit one of these branches via their `basedOn` field — we *do not* let library packages ship dispatcher code. They pick a host branch, configure parameters (clone count window, priming text), and ride that branch.

Schema-level extension point: the `Mode` literal union (`packages/manta-snapshot/src/schema.ts:4`) becomes a *base* — for the `mode` field flowing through `TaskContract` (`packages/manta-snapshot/src/schema.ts:28`) and `toBusContract` (`packages/manta-cli/src/commands/cast.ts:804`), library modes must serialise as `{ baseMode: 'pair-programming', libraryMode: '@manta-library/foo/mega-pair' }` so the bus, registry, and post-mortems can record both the host dispatcher and the library origin. The on-the-wire `Mode` literal remains one of the built-in seven; the library mode rides alongside.

### 6.3 Skill-validator integration for library-installed skills

The existing surface:

* **`packages/manta-skill-validator/src/walk.ts:22`** — `walkSkillsAndCommands(repoRoot)` is the *only* discovery entry point. It looks at `<root>/skills/` and `<root>/commands/`.
* **`packages/manta-skill-validator/src/walk.ts:74`** — `validateAll(repoRoot)` returns `ValidationReport[]` and a `errorCount`. This is exactly what we need at install time.
* **`packages/manta-skill-validator/src/schemas.ts:7`** — `SkillFrontmatterSchema` enforces frontmatter shape. Library skills must satisfy this exactly the same as repo-local skills.
* **`packages/manta-skill-validator/src/schemas.ts:21`** — `SlashCommandFrontmatterSchema` likewise.

Integration plan:

1. `manta install` calls `validateAll(stagingDir)` (line 74 of walk.ts) — **no change to the validator**. The validator is already root-relative; pointing it at the unpacked staging dir is sufficient.
2. `errorCount > 0` → abort install with exit 14 (`library_validation_failed`). The validator emits structured `ValidationReport` already (`packages/manta-skill-validator/src/validate.ts`), reuse the existing formatter from the `manta-validate` bin if one exists, or call `validateAll` and pretty-print issues.
3. `walkSkillsAndCommands` skips unsafe names already (`packages/manta-skill-validator/src/walk.ts:38`, `:58`) — a package containing `skills/../etc/passwd/` is caught at discovery, *not* at install copy. Good — but the install step must additionally refuse if `warnings.length > 0`, where the in-repo walk merely logs warnings.

A small **deliberate** addition: the validator must learn `manta-package.json` as a fifth artifact. Suggested API:

```ts
// new in packages/manta-skill-validator/src/walk.ts
export async function validatePackage(packageRoot: string): Promise<ValidatePackageResult>;
```

It runs `validateAll` (existing), then parses `manta-package.json` against `MantaPackageManifest` (the new schema from §1.3, added in `packages/manta-skill-validator/src/schemas.ts`), then cross-checks that `contributes.skills/commands` reference declared file paths only. Single new exported function; everything else is reused.

### 6.4 Lockfile + global library index — new files

* `packages/manta-cli/src/library/lockfile.ts` — read/write `manta-lock.json`. Wired into `Runtime` via a new `lockfile: LockfileStore` field added at **`packages/manta-cli/src/runtime.ts:36`** (alongside `repoRoot`, `ctx`, `orchestrator`).
* `packages/manta-cli/src/library/local-store.ts` — manages `~/.manta/library/<scope>/<name>/<version>/` and `~/.manta/library/index.json`.
* `packages/manta-cli/src/library/registry-client.ts` — small abstraction with `resolve(spec): ResolvedPackage` and `fetch(resolved): Promise<TarballStream>`. Two impls: `NpmClient` (shells out to `npm pack`), `GitClient` (uses execa for `git clone --depth=1`).
* `packages/manta-cli/src/library/mode-registry.ts` — combines built-in modes + library modes. **This** is what `cast.ts:132` queries instead of `SUPPORTED_MODES.has`.

### 6.5 Wiring summary diagram

```
manta install <spec>
    │
    ▼
registry-client.resolve → fetch
    │
    ▼
local-store.stage → validatePackage (skill-validator)
    │
    ▼
local-store.commit (atomic rename)
    │
    ▼
lockfile.add  +  local-store.indexAdd
    │
    ▼
modeRegistry.invalidate

──────── on `manta cast <mode>` ────────

bin/manta.ts:60 → runCastCommand (cast.ts:128)
    │
    ▼
modeRegistry.has(mode)            ← was SUPPORTED_MODES.has(mode) at cast.ts:132
    │
    ▼
verifyMantaVersionCompat(lock, mantaCliVersion)
    │
    ▼
existing branches dispatch on `basedOn` for library modes
```

---

## 7. Open questions left for Phase 7 plan-phase

These are intentionally **not** answered in research — they are design judgement calls the plan-writing step should resolve with the spec author:

1. **Mode-name collision policy.** First-installed wins, last-installed wins, or hard-fail at install? Recommendation: hard-fail at install (predictability > convenience), but plan-phase decides.
2. **Cross-package skill name collisions.** Two packages both ship a skill `manta-as-clone-extended`. Same answer needed.
3. **`@manta-library/*` scope governance.** Who controls the npm scope? Recommendation: org scope owned by core maintainers, packages added via PR review; explicit non-goal to lock everything down (anyone can publish under `manta-library-<their-username>` unscoped or under their own scope and we discover via `manta search`).
4. **`manta search` source.** Phase 7 ships none, Phase 8 builds. Acceptable?
5. **Hooks distribution.** Whether to allow `hooks/` at all in Phase 7, or defer hook-shipping to Phase 8. Conservative recommendation: **defer hooks to Phase 8.** Markdown + JSON only in v1.
6. **Telemetry on installs.** None, per Manta's no-phone-home stance. Confirm.
7. **`manta share --publish` to non-npm.** Out of scope for Phase 7. Custom destinations are Phase 8+.

---

## Appendix A — Decision rationale for the "ship in 1-2 chunks" constraint

| Decision | Cheaper alternative considered | Why rejected |
|---|---|---|
| npm scope vs flat names | Flat npm names | Squatting risk; scope gives namespace ownership. |
| `manta-package.json` vs reusing `package.json` | Reuse npm's | Conflates Node package metadata with Manta payload; `dependencies` would mean two different things. |
| Hash-pin in lockfile vs trust-on-resolve | Trust npm's integrity field directly | Allows git URL parity (npm integrity doesn't exist for git refs); makes tampering check uniform. |
| Mode dispatcher inheritance (`basedOn`) vs library-supplied JS | Library JS | Supply-chain risk; sandbox cost > Phase 7 budget. |
| Sanitization default-deny vs default-allow | Default-allow with grep blocklist | Half the design effort is enumeration; blocklist always loses to a clever payload. Default-deny enumerates explicitly. |
| Lockfile in repo root vs `.manta/lock.json` | `.manta/lock.json` | Repo-root is the convention users expect; `.manta/state/*` is treated as runtime-mutable and `.gitignore`'d everywhere. |
| `~/.manta/library/<scope>/<name>/<version>/` vs flat `~/.manta/library/<name>/` | Flat | Multi-version coexistence is essential when two repos in the same user's homedir pin different versions. |

---

## Appendix B — File-path quick reference

| Concern | File | Line(s) |
|---|---|---|
| CLI entry, command registration | `packages/manta-cli/src/bin/manta.ts` | 50 (`main`), 59 (`cast`), 244 (`replay` — near `share` insert site), 373 (`feedback`), 375 (`parseAsync`) |
| Public CLI exports | `packages/manta-cli/src/index.ts` | 12 |
| Runtime composition (add `lockfile`, `library` here) | `packages/manta-cli/src/runtime.ts` | 36 (`Runtime` interface), 45 (`createRuntime`) |
| Mode validation gate | `packages/manta-cli/src/commands/cast.ts` | 35 (`SUPPORTED_MODES`), 132 (`!SUPPORTED_MODES.has(opts.mode)`), 160 / 166 (pair / test-storm preconditions) |
| Mode dispatcher selection | `packages/manta-cli/src/commands/cast.ts` | 404 (`PairDispatcher`), 413 (`TestStormDispatcher`), 424 (`documentation-chase` enqueue), 606 (`forking-realities` merge-review) |
| Snapshot ↔ bus contract translation (mode flows here) | `packages/manta-cli/src/commands/cast.ts` | 804 (`toBusContract`) |
| Canonical Mode union | `packages/manta-snapshot/src/schema.ts` | 4 |
| Skill discovery (reuse for library) | `packages/manta-skill-validator/src/walk.ts` | 22 (`walkSkillsAndCommands`), 30 (skill dir), 50 (commands dir), 74 (`validateAll`) |
| Skill frontmatter schema | `packages/manta-skill-validator/src/schemas.ts` | 7 (skill), 21 (slash command) |
| Snapshot fields needing redaction | `packages/manta-snapshot/src/capture.ts` | 14 (`parentPid`), 16 (`recentMessages`), 18 (`openFiles`), 19 (`parentWorktree`), 20 (`cloneWorktree`) |
| Post-mortem writer (source for share bundle) | `packages/manta-orchestrator/src/post-mortem-writer.ts` | 15 (`postMortemDir`) |
| Forensic timeline (source for share bundle) | `packages/manta-cli/src/commands/cast.ts` | 461 (`ForensicTimelineWriter`) |
| Contract storage | `packages/manta-cli/src/commands/cast.ts` | 383 (`rt.ctx.contracts.write`) |
| Snapshot env var seam (confirms safe export point) | `packages/manta-cli/src/spawner/clone-spawner.ts` | 162 (`MANTA_SNAPSHOT_PATH`) |

— end clone-A deliverable —

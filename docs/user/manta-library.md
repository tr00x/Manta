# Manta Library — install + lockfile + ModeRegistry (Phase 7a Chunk 1)

> **Status:** Phase 7a Chunk 1 — happy-path `manta install` only. Uninstall, `manta library list/show/outdated/doctor`, install-flag completeness, and hash-pin verification land in Chunk 2. `manta share` is Phase 7b. `manta trigger` is Phase 7c.

## What is Manta Library?

Manta Library is the package ecosystem for Manta — like VS Code extensions for VS Code, like npm modules for Node, but for Manta **modes**, **skills**, **commands**, and **templates**. A library package is a small archive whose `manta-package.json` declares what it contributes; once installed, those contributions show up where Manta looks for them: modes appear in `manta cast`'s allowlist, skills become loadable, commands become callable.

The point of a library is to share a curated workflow without copying it. If you've found a useful refactor pattern, a domain-specific dispatch shape, or a research template, ship it as a library package; teammates `manta install` it once and run it the same way you do.

For the design history and precedent comparison, see `docs/research/phase-7-manta-library.md`.

## Installing a package

Phase 7a Chunk 1 ships the install pipeline for three spec forms:

```sh
# npm registry, scoped under @manta-library/
manta install @manta-library/refactor-megapack
manta install @manta-library/refactor-megapack@^1.0

# git URL, with optional ref
manta install git+https://github.com/u/r
manta install git+https://github.com/u/r#v1.2.3

# local tarball — useful for testing in-flight package authoring
manta install ./local-package.tgz
manta install /abs/path/to/local-package.tgz
```

The command:

1. Resolves the spec (parses, fetches the tarball, computes its SHA-256).
2. Extracts the tarball into a temp workdir with a zip-slip / tar-bomb guard (absolute paths and `..` segments are refused).
3. Reads `manta-package.json` from the unpacked tree and checks `mantaVersionCompat` against the CLI version. Compat mismatch fails immediately with exit 16 and a recovery message.
4. Stages the unpacked tree into `~/.manta/library/.staging/<random>/`.
5. Validates the staged package via `@manta/skill-validator validatePackage` — manifest schema, validator reports per skill/command, and a contributes-vs-disk cross-check. Drive-by skills (on disk but undeclared) and dangling entries (declared but missing) both fail with exit 14.
6. Verifies no other install of the same name+version already exists. If one does, fails with exit 15. (Override coming in Chunk 2 as `--force`.)
7. Refuses to install any `manifest.contributes.hooks` payload — hooks distribution is deferred to Phase 8. Manifests declaring hooks log a warning but continue without copying.
8. Atomically renames the staging dir to `~/.manta/library/<scope>/<name>/<version>/`.
9. Computes the install dir's content-tree hash (`directoryDigest`) and records both `integrity` (tarball hash, npm-compatible `sha256-<base64>`) and `directoryDigest` in the per-repo lockfile.
10. Updates `~/.manta/library/index.json` with the new install entry.

On success, the command prints a short summary:

```
Installed @manta-library/refactor-megapack@1.3.0
  path:    /Users/you/.manta/library/@manta-library/refactor-megapack/1.3.0
  lockfile: /path/to/repo/manta-lock.json
  modes:   1
  skills:  4
  commands: 2
  templates: 1
```

## The lockfile (`manta-lock.json`)

The lockfile lives at your repo root. It is committed to git. It is the source of truth for **which** library packages this repo depends on; the global library store under `~/.manta/library/` is the source of truth for **where** each version's content is on disk.

Lockfile structure (see `packages/manta-cli/src/library/lockfile.ts` for the authoritative `LockfileSchema`):

```jsonc
{
  "schemaVersion": 1,
  "mantaVersion": "0.7.2",
  "generatedAt": "2026-05-28T11:30:00.000Z",
  "packages": {
    "@manta-library/refactor-megapack": {
      "version": "1.3.0",
      "resolved": "https://registry.npmjs.org/@manta-library/refactor-megapack/-/refactor-megapack-1.3.0.tgz",
      "integrity": "sha256-<base64>",
      "directoryDigest": "sha256-<base64>",
      "contributes": { "modes": ["mega-refactor"], "skills": [...], "commands": [...], "templates": [...] },
      "mantaVersionCompat": ">=0.7.0 <1.0.0",
      "installedAt": "2026-05-28T11:30:00.000Z"
    }
  }
}
```

- `integrity` is the SHA-256 of the resolved tarball bytes.
- `directoryDigest` is the canonical content-tree hash of the installed directory. Every cast verifies this against on-disk content (Chunk 2 lands the per-cast check); a mismatch surfaces tampering before any clone spawns.
- Package keys are alphabetically sorted; the writer guarantees deterministic byte output so two writes of the same content produce byte-identical files.

The lockfile is read+written atomically (tmp + rename) under `proper-lockfile`, so concurrent `manta install` invocations in the same repo serialize safely.

**Commit `manta-lock.json`.** Always. It is the only way teammates and CI can reproduce your library state without re-resolving everything from the network.

## The global library store (`~/.manta/library/`)

All installed packages live under your user home:

```
~/.manta/library/
├── index.json                    ← global registry of installed packages
├── .staging/                     ← scratch dir for in-flight installs
└── @manta-library/
    └── refactor-megapack/
        ├── 1.3.0/                ← per-version directory; multi-version coexists
        │   └── manta-package.json + skills/ + modes/ + ...
        └── 1.4.0/
```

Two repos under the same homedir can pin different versions of the same package without stepping on each other — the path includes the version. Removing one version leaves others intact (uninstall lands in Chunk 2).

`~/.manta/library/index.json` records the global install set: every entry has `packageName`, `version`, on-disk `path`, the contributed surface, `installedAt`, and `integrity` (tarball hash). This is the source of truth `manta library list` (Chunk 2) reads.

## Compatibility checking

Every manifest declares `mantaVersionCompat` (a semver range). The install command refuses to install a package whose range doesn't satisfy the current CLI version. `manta cast` also verifies compat on every invocation, so an installed package whose range stops being satisfied after a CLI upgrade fails *before* any clones spawn.

Compat-failure exit code is **16**, with a recovery message listing three options:

```
Package @manta-library/refactor-megapack requires Manta >=0.8.0 <1.0.0; you have 0.7.2.

Recovery options:
  1) Upgrade the Manta CLI to a version satisfying >=0.8.0 <1.0.0.
  2) Install an older @manta-library/refactor-megapack satisfying 0.7.2.
  3) Uninstall @manta-library/refactor-megapack via `manta uninstall @manta-library/refactor-megapack`.
```

The compat check happens **before** integrity verification (which lands in Chunk 2). Order matters: a tampered-AND-compat-broken install should show the actionable upgrade message first, not the tamper alarm.

## Mode resolution at cast time

When you cast a library mode, `manta cast` resolves it through the `ModeRegistry` seam (`packages/manta-cli/src/library/mode-registry.ts`). The registry is seeded with the seven built-in modes and then augmented at every `manta cast` invocation with one entry per lockfile-declared library mode.

A library mode has a `basedOn` field naming a built-in host dispatcher. The library mode parameterises that dispatcher rather than shipping dispatcher code:

- `basedOn: 'recon-swarm'` → clones spawn through the recon-swarm dispatcher branch.
- `basedOn: 'pair-programming'` → clones spawn through the pair-programming dispatcher branch.

Library packages cannot ship arbitrary JavaScript; the threat model is closed by the `basedOn` enum. The worst a malicious package can do is run a built-in dispatcher with a bad priming preamble — not "own the process."

The cast manifest on disk records the host dispatcher mode (`mode: 'recon-swarm'`). A reporter event `cast.library_mode_resolved` captures the library origin (`libraryMode`, `basedOn`, `packageName`, `packageVersion`) so post-mortems and the bus can audit both layers.

## Phase 7a limitations

- **Hooks (`PreToolUse`, `PostToolUse`, …) are not installed.** Manifests may declare `contributes.hooks[]` but `manta install` refuses to copy them. Hook distribution is deferred to Phase 8 once the sandboxing design is in place.
- **`manta uninstall`, `manta library list/show/outdated/doctor` ship in Chunk 2.** Today, removing a package means deleting it from `manta-lock.json`, `~/.manta/library/index.json`, and the install directory by hand. Don't get clever — let Chunk 2 do this for you when it lands.
- **Install flag completeness (`--force`, `--offline`, `--integrity`, `--dry-run`, `--json`, `--no-validate`) ships in Chunk 2.** The default `--no-hooks` semantics are hard-coded for now.
- **Hash-pin verification on every cast ships in Chunk 2.** Today, `directoryDigest` is recorded but not yet compared. A tampered install dir won't be caught until you re-install.
- **`manta share` (publish a cast as a library package) is Phase 7b.**
- **`manta trigger add` (auto-cast triggers) is Phase 7c.**
- **Custom HTTP registry / code signing / runtime sandbox are Phase 8+.** The npm registry under the `@manta-library/*` scope plus the git+https fallback are the only distribution surfaces shipped here.

## Troubleshooting (Chunk 1)

| Symptom | What it means | What to do |
|---|---|---|
| `[manta] install: install_spec_parse_failed: cannot parse spec "..."` | The spec form isn't one of the three supported shapes. | Use `@scope/name@range`, `git+https://...#ref`, or `./local.tgz`. |
| `[manta] install: install_network_failed: cannot fetch ...` | `npm pack` or `git clone` shelled out and failed. | Check `npm ping` and your network. Phase 7a requires `npm` in `$PATH` for npm-spec installs. |
| `[manta] install: install_manifest_invalid: ...` | The tarball's `manta-package.json` is missing, not JSON, or fails the schema. | Inspect the tarball with `tar tzf <path>` and validate the manifest by hand against `MantaPackageManifestSchema` in `@manta/skill-validator`. |
| `[manta] install: install_validation_failed: ...` | A skill/command/mode declared in the manifest doesn't exist on disk, or one exists on disk that the manifest doesn't declare. | Re-check the package author's contributes table — fix the manifest or the on-disk file. The error message names the offending path. |
| `[manta] install: install_compat_unmet: ...` | The package's `mantaVersionCompat` range doesn't include this CLI version. | Follow the printed recovery options (upgrade CLI / install older package / uninstall). |
| `[manta] install: install_already_installed: ...` | A previous install of the same name+version exists. | Wait for `--force` in Chunk 2, or manually remove `~/.manta/library/<scope>/<name>/<version>/`. |
| `[manta] cast: manta_version_compat_unmet` (exit 16) | An installed library package no longer satisfies the CLI's version after an upgrade. | Same recovery options as above. |

## Where to go next

- **Building a library package:** the package layout mirrors the validator's `validatePackage` contract — top-level `manta-package.json` plus `skills/<name>/SKILL.md`, `commands/<name>.md`, `modes/<name>/mode.json`, `templates/<name>`. Drive-by files (on disk but undeclared) are rejected; declare everything in `contributes`.
- **Phase 7a Chunk 2:** uninstall, library subcommands, install flag completeness, hash-pin verification, and the env-gated `MANTA_E2E=1` end-to-end install→cast→uninstall round trip.
- **Phase 7b:** `manta share` builds a `.mantapkg.tar.gz` from a finalised cast, reusing the manifest schema and the bug #18 metadata sanitizer that landed alongside this chunk.
- **Phase 7c:** `manta trigger add/list <event> <action>` ships the auto-cast trigger taxonomy.

# Manta Library — install + uninstall + lockfile + ModeRegistry

> **What ships today:** `manta install` (full flag matrix), `manta uninstall`, `manta library list/show/outdated/doctor`, the lockfile, the `ModeRegistry` seam, and per-cast hash-pin verification. `manta share` (publish a cast as a package) is documented in [`manta-share.md`](./manta-share.md). Auto-cast triggers and hook distribution are not yet shipped.

## What is Manta Library?

Manta Library is the package ecosystem for Manta — like VS Code extensions for VS Code, like npm modules for Node, but for Manta **modes**, **skills**, **commands**, and **templates**. A library package is a small archive whose `manta-package.json` declares what it contributes; once installed, those contributions show up where Manta looks for them: modes appear in `manta cast`'s allowlist, skills become loadable, commands become callable.

The point of a library is to share a curated workflow without copying it. If you've found a useful refactor pattern, a domain-specific dispatch shape, or a research template, ship it as a library package; teammates `manta install` it once and run it the same way you do.

## Installing a package

Manta installs packages from three spec forms:

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
6. Verifies no other install of the same name+version already exists. If one does, fails with exit 15. (Pass `--force` to overwrite.)
7. Refuses to install any `manifest.contributes.hooks` payload — hook distribution is not yet shipped. Manifests declaring hooks log a warning but continue without copying.
8. Atomically renames the staging dir to `~/.manta/library/<scope>/<name>/<version>/`.
9. Computes the install dir's content-tree hash (`directoryDigest`) and records both `integrity` (tarball hash, npm-compatible `sha256-<base64>`) and `directoryDigest` in the per-repo lockfile.
10. Updates `~/.manta/library/index.json` with the new install entry.

On success, the command prints a short summary:

```
Installed @manta-library/refactor-megapack@1.3.0
  path:    /Users/you/.manta/library/@manta-library/refactor-megapack/1.3.0
  lockfile: /path/to/repo/manta-lock.json
  integrity: sha256-<base64>
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
- `directoryDigest` is the canonical content-tree hash of the installed directory. Every `manta cast` recomputes the on-disk hash and compares it against this field; a mismatch surfaces tampering with exit 19 before any clone spawns. See the "Hash-pin verification on every cast" section below.
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

Two repos under the same homedir can pin different versions of the same package without stepping on each other — the path includes the version. Removing one version leaves others intact.

`~/.manta/library/index.json` records the global install set: every entry has `packageName`, `version`, on-disk `path`, the contributed surface, `installedAt`, and `integrity` (tarball hash). This is the source of truth `manta library list` reads.

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

The compat check happens **before** integrity verification (see the next section). Order matters: a tampered-AND-compat-broken install should show the actionable upgrade message first, not the tamper alarm.

## Hash-pin verification on every cast

Every `manta cast` invocation runs a hash-pin check immediately after the compat preflight and before the mode lookup. For each entry in `manta-lock.json` the CLI recomputes the on-disk directory hash and compares it against the `directoryDigest` captured at install time. On the first mismatch the cast refuses to start with **exit 19** and a `library_tampered` message:

```
Library package @manta-library/refactor-megapack@1.3.0 failed hash-pin verification: on-disk content hash does not match the lockfile.
  expected: sha256-<base64>
  actual:   sha256-<base64>

Run `manta install @manta-library/refactor-megapack@1.3.0 --force` to re-fetch.
```

If the install directory is missing entirely (e.g. the lockfile was checked in but `manta install` hasn't been run, or `~/.manta/library/` was deleted), the same exit code surfaces with `actual: <missing>` and the same recovery hint.

The check is fast: each library package is a few kilobytes of skill markdown + JSON, and the fs walk completes in single-digit ms cold. It catches three failure modes proactively, before any clones spawn:

- **Manual edit.** Someone opened a file under `~/.manta/library/` and changed it.
- **Corrupted install.** Disk error or interrupted install left bytes drifted.
- **Missing install.** Lockfile committed without a corresponding `manta install`.

The exit-code split between compat (16), tamper (19), and observability-doctor unhealthy (20) means CI consumers can route each fault class distinctly — "upgrade CLI" vs. "re-fetch the package" vs. "uninstall the package."

## Uninstalling a package

```sh
manta uninstall @manta-library/refactor-megapack
manta uninstall @manta-library/refactor-megapack@1.3.0
manta uninstall @manta-library/refactor-megapack --force
```

The pipeline mirrors install in reverse:

1. Parse the spec into `{ packageName, version? }`.
2. Read `~/.manta/library/index.json`. If `version` is omitted and multiple versions of `packageName` are installed, refuse with exit 18 and list the candidates: `multiple versions of <name> installed: <list>. Specify one.`
3. **In-use check.** For each non-`DEAD` clone in the registry — that is, any clone in `STARTING`, `WORKING`, `BLOCKED`, `IDLE`, `WAITING_FOR_TASK`, or `WINDING_DOWN` — verify that none of them are running a mode contributed by the package about to be removed. Any match is "in use" and the uninstall refuses with exit 18: `<name>@<version> is in use by cast <cast-id> (clones: <ids>; modes: <matched-modes>). Run \`manta abort <cast-id>\` first.`
4. `--force` overrides the in-use refusal only when every matched clone is in the **soft** non-DEAD states (`IDLE`, `WAITING_FOR_TASK`, `WINDING_DOWN`). When any matched clone is in the **hot** states (`STARTING`, `WORKING`, `BLOCKED`), `--force` is itself rejected: `refusing while clones <ids> are <state>. Run \`manta abort <cast-id>\` first.` Removing files mid-read by a live `claude --print` subprocess would corrupt the in-flight cast — `--force` is not a foot-gun unlocker, it is a fast-path for known-quiet daemons.
5. Drop the index entry from `~/.manta/library/index.json`.
6. Remove the install directory.
7. Drop the lockfile entry from `manta-lock.json`.
8. Print a one-line summary.

Idempotency: re-running uninstall after success exits 12 (`not_installed`) with a clear message; the second run is a safe no-op.

Common exit codes:

| Code | Meaning |
|---|---|
| 0 | Uninstall completed successfully. |
| 12 | `not_installed` — no such package + version on disk. |
| 18 | `in_use` — a live clone is running a mode contributed by this package, or a multi-version install needs a `@<version>` qualifier. |

## `manta install` flag matrix

The full install command surface. Every flag is a deliberate trade-off; defaults are conservative.

| Flag | Behaviour | Notes |
|---|---|---|
| `--force` | Override the "already installed" collision; the existing install at `~/.manta/library/<scope>/<name>/<version>/` is removed before the staged install is renamed in. | Surfaces a one-line warning. Use for re-installing a tampered or partially-installed package; also the recovery action printed by exit 19. |
| `--offline` | Refuse any network call. Only `./local.tgz` spec forms succeed; `@scope/name` and `git+https://…` specs fail with exit 11 (`install_network_required_for_spec_kind`). | Used by CI replay against a vendored tarball; also a safety net when working on a flight. |
| `--integrity sha256-<base64>` | Pre-pin the expected tarball hash; the fetch step refuses to proceed if the actual `contentSha256Hex` after fetch does not match. Prints both values on failure with exit 13 (`checksum_mismatch`). | Belt-and-suspenders against npm-cache-poisoning or git-tag-mutation; mirrors `--integrity` in lockfile-based package managers. |
| `--dry-run` | Run the install pipeline through steps 1–6 (parse, resolve, fetch, extract, compat, validate) but skip the staged commit and lockfile/index writes. Print the would-be summary, exit 0. | Used by CI replay to confirm a tarball still validates after the CLI upgraded. |
| `--json` | Emit the success summary as a single JSON line with `{ name, version, integrity, contributedModes, contributedSkills, contributedCommands, contributedTemplates, lockfilePath, installPath, dryRun }`. On error, emit `{ error: { code, message } }`. | Pipe to `jq`; pair with `--dry-run` to query what an install would do. |
| `--no-validate` | Skip the `validatePackage` call. Prints a loud warning: `[manta] install: --no-validate; manifest is parsed but content is not validated` | Reserved for CI replay of a tarball that was already validated upstream. Not advertised — production installs should always validate. |
| `--no-hooks` | **Defaults to `true`.** Refuses to copy any `manifest.contributes.hooks` payload. `--no-hooks=false` (and `--hooks`) is rejected at flag parse (exit 11) with `[manta] install: hooks distribution is not yet available; --no-hooks cannot be disabled`. | The flag ships with hard-refuse semantics now so the default can be flipped later without a CLI API break. |

## `manta library` observability subcommands

Four read-only subcommands surface the global install set. None of them mutate state; all of them honour `--json` for machine consumers.

```sh
manta library list [--json]
manta library show @manta-library/refactor-megapack[@<version>] [--json]
manta library outdated [--json]
manta library doctor [--json]
```

- **`list`** — table of every installed package with columns `Name`, `Version`, `Modes`, `Skills`, `Cmds`, `Templates`, `Path`. Exits 0 even when the table is empty (`No library packages installed.`).
- **`show`** — pretty-print one package's manifest, the contributed surface, and the matching lockfile entry. Exits 12 (`not_installed`) when the package or version is not on disk.
- **`outdated`** — for each npm-resolved package, look up newer versions on the registry and report any that still satisfy the lockfile's range. Git-resolved packages report as `pinned`. Always exits 0; the report is the value.
- **`doctor`** — for every installed package, run `validatePackage` from `@manta/skill-validator` and check `mantaVersionCompat` against the current CLI. Healthy → exits 0. Any unhealthy package → exits **20** (`library_unhealthy`) and lists the offenders. Distinct from exit 19 (`library_tampered`) so CI consumers can branch on which remediation applies — upgrade or uninstall (doctor) vs. re-fetch (tamper).

`doctor` is the friendly preflight to run after a CLI upgrade: any package whose compat range no longer satisfies the new CLI version is surfaced before the next cast trips the same check.

## Mode resolution at cast time

When you cast a library mode, `manta cast` resolves it through the `ModeRegistry` seam (`packages/manta-cli/src/library/mode-registry.ts`). The registry is seeded with the seven built-in modes and then augmented at every `manta cast` invocation with one entry per lockfile-declared library mode.

A library mode has a `basedOn` field naming a built-in host dispatcher. The library mode parameterises that dispatcher rather than shipping dispatcher code:

- `basedOn: 'recon-swarm'` → clones spawn through the recon-swarm dispatcher branch.
- `basedOn: 'pair-programming'` → clones spawn through the pair-programming dispatcher branch.

Library packages cannot ship arbitrary JavaScript; the threat model is closed by the `basedOn` enum. The worst a malicious package can do is run a built-in dispatcher with a bad priming preamble — not "own the process."

The cast manifest on disk records the host dispatcher mode (`mode: 'recon-swarm'`). A reporter event `cast.library_mode_resolved` captures the library origin (`libraryMode`, `basedOn`, `packageName`, `packageVersion`) so post-mortems and the bus can audit both layers.

## Limitations

- **Hooks (`PreToolUse`, `PostToolUse`, …) are not installed.** Manifests may declare `contributes.hooks[]` but `manta install` refuses to copy them. Hook distribution is not yet shipped — it needs a sandboxing design first. `--no-hooks=false` is a flag-parse-time error; the flag exists with the right name and exit semantics so the default can be flipped later without breaking the CLI contract.
- **Library packages cannot ship dispatcher code.** A library mode parameterises an existing built-in dispatcher named by `basedOn`. There is no `createDispatcher` hook in the manifest schema. The threat model is closed by the `basedOn` enum (seven built-ins); see `docs/internals/mode-registry.md` for the rationale and the deferred richer-registry sketch.
- **`manta share` (publish a cast as a library package)** is documented in [`manta-share.md`](./manta-share.md). It reuses the metadata sanitizer that ships with install.
- **Auto-cast triggers (`manta trigger add`)** are not yet shipped.
- **Custom HTTP registry / code signing / runtime sandbox** are not yet shipped. The npm registry under the `@manta-library/*` scope plus the git+https fallback are the only distribution surfaces today.
- **`manta library search` + curated GitHub index** are not yet shipped — the current discovery surfaces are `list`/`show`/`outdated`/`doctor`, not directory-style browsing.

## Troubleshooting

| Symptom | Exit | What it means | What to do |
|---|---|---|---|
| `install_spec_parse_failed: cannot parse spec "..."` | 11 | The spec form isn't one of the three supported shapes. | Use `@scope/name@range`, `git+https://...#ref`, or `./local.tgz`. |
| `install_network_failed: cannot fetch ...` | 11 | `npm pack` or `git clone` shelled out and failed. | Check `npm ping` and your network. npm-spec installs require `npm` in `$PATH`. Re-run with `--offline` against a local tarball if you have one. |
| `install_network_required_for_spec_kind` | 11 | `--offline` was given but the spec needs the network. | Vendor a tarball and install from `./vendored.tgz`, or drop `--offline`. |
| `install_manifest_invalid: ...` | 14 | The tarball's `manta-package.json` is missing, not JSON, or fails the schema. | Inspect the tarball with `tar tzf <path>` and validate the manifest by hand against `MantaPackageManifestSchema` in `@manta/skill-validator`. |
| `checksum_mismatch` | 13 | `--integrity sha256-<base64>` was given and the fetched tarball did not match. | Confirm the expected hash; if it is right, treat the source as compromised and report to the package author. |
| `install_validation_failed: ...` | 14 | A skill/command/mode declared in the manifest doesn't exist on disk, or one exists on disk that the manifest doesn't declare. | Re-check the package author's contributes table — fix the manifest or the on-disk file. The error message names the offending path. |
| `install_already_installed: ...` | 15 | A previous install of the same name+version exists. | Re-run with `--force` to overwrite, or run `manta uninstall <name>@<version>` first. |
| `cast: manta_version_compat_unmet` | 16 | An installed library package no longer satisfies the CLI's version after an upgrade. | Follow the three printed recovery options. `manta library doctor` reports this proactively. |
| `uninstall: multiple versions of <name> installed` | 18 | The spec omitted a version and more than one is installed. | Re-run with `@<version>`. |
| `uninstall: <name>@<version> is in use by cast <cast-id>` | 18 | A live (non-DEAD) clone is running a mode contributed by this package. | `manta abort <cast-id>` first, then re-run uninstall. `--force` covers IDLE/WAITING_FOR_TASK/WINDING_DOWN only. |
| `cast: library_tampered` | 19 | A lockfile-recorded `directoryDigest` no longer matches the on-disk install. | `manta install <name>@<version> --force` to re-fetch. If the failure says `actual: <missing>`, the install was removed; the same `--force` re-install fixes it. |
| `library: doctor: library_unhealthy` | 20 | One or more installed packages failed `validatePackage` or compat after a CLI upgrade. | `manta library show <name>` for details; then upgrade the CLI, install an older package version, or uninstall the offender. |

## Where to go next

- **Building a library package:** the package layout mirrors the validator's `validatePackage` contract — top-level `manta-package.json` plus `skills/<name>/SKILL.md`, `commands/<name>.md`, `modes/<name>/mode.json`, `templates/<name>`. Drive-by files (on disk but undeclared) are rejected; declare everything in `contributes`.
- **`ModeRegistry` architecture note:** [`docs/internals/mode-registry.md`](../internals/mode-registry.md) covers the `basedOn` host-dispatcher inheritance model, the cast-manifest dual recording, and where to extend when richer library-mode semantics are wanted.
- **`manta share`:** builds a `.manta-pkg.tar.gz` from a finalised cast, reusing the manifest schema and the metadata sanitizer. See [`manta-share.md`](./manta-share.md).

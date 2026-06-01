import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';
import {
  validatePackage,
  MantaPackageManifestSchema,
  type MantaPackageManifest,
} from '@manta/skill-validator';
import type { LockfileStore, Lockfile, LockfileEntry } from '../library/lockfile.js';
import type { LocalStore } from '../library/local-store.js';
import { LocalStoreError } from '../library/local-store.js';
import {
  RegistryClientError,
  type RegistryClient,
} from '../library/registry-client.js';
import { computeDirDigest } from '../library/dir-digest.js';
import {
  isMantaVersionCompatible,
  buildCompatErrorMessage,
} from '../library/compat.js';

export type InstallErrorCode =
  | 'install_spec_parse_failed'
  | 'install_network_failed'
  | 'install_network_required_for_spec_kind'
  | 'install_checksum_mismatch'
  | 'install_manifest_invalid'
  | 'install_validation_failed'
  | 'install_compat_unmet'
  | 'install_already_installed';

const EXIT_CODES: Record<InstallErrorCode, number> = {
  install_spec_parse_failed: 11,
  install_network_failed: 11,
  install_network_required_for_spec_kind: 11,
  install_checksum_mismatch: 13,
  install_manifest_invalid: 14,
  install_validation_failed: 14,
  install_already_installed: 15,
  install_compat_unmet: 16,
};

export class InstallError extends Error {
  readonly code: InstallErrorCode;
  readonly exitCode: number;
  readonly details: Record<string, unknown>;
  constructor(code: InstallErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
    this.exitCode = EXIT_CODES[code];
    this.details = details;
  }
}

export interface InstallRuntime {
  readonly repoRoot: string;
  readonly lockfile: LockfileStore;
  readonly localStore: LocalStore;
  readonly registryClient: RegistryClient;
  readonly mantaCliVersion: string;
}

export interface RunInstallCommandOptions {
  spec: string;
  /** Skip the `validatePackage` call. Schema validation of the manifest still runs. */
  noValidate?: boolean;
  /**
   * Hooks distribution is deferred to Phase 8. Default `true` — hooks declared
   * by the manifest are not materialized. The bin entrypoint rejects
   * `--no-hooks=false` at parse time so this flag can only be `true` or absent.
   */
  noHooks?: boolean;
  /** Overwrite an existing same-version install before commit. */
  force?: boolean;
  /** Refuse network calls; only `local-tgz` specs allowed. */
  offline?: boolean;
  /** User-pinned `sha256-<base64>` integrity to compare against the resolved tarball. */
  integrity?: string;
  /** Run steps 1–6 of the pipeline but skip commit, lockfile and index writes. */
  dryRun?: boolean;
}

export interface RunInstallCommandResult {
  packageName: string;
  version: string;
  installedPath: string;
  lockfilePath: string;
  integrity: string;
  contributedModes: string[];
  contributedSkills: number;
  contributedCommands: number;
  contributedTemplates: number;
  dryRun: boolean;
}

async function safeRmRf(p: string): Promise<void> {
  try {
    await fs.rm(p, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function rejectUnsafeTarEntry(p: string): boolean {
  // zip-slip / tar-bomb guard: deny absolute paths and any `..` segment.
  return !p.startsWith('/') && !p.split(/[\\/]/).includes('..');
}

function summariseContributes(manifest: MantaPackageManifest): {
  modes: string[];
  skills: string[];
  commands: string[];
  templates: string[];
} {
  return {
    modes: manifest.contributes.modes.map((m) => m.name),
    skills: manifest.contributes.skills.map((s) => s.name),
    commands: manifest.contributes.commands.map((c) => c.name),
    templates: manifest.contributes.templates.map((t) => t.name),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function hexToIntegrity(hex: string): string {
  return `sha256-${Buffer.from(hex, 'hex').toString('base64')}`;
}

async function parseManifestSchemaOnly(stagingDir: string, spec: string): Promise<MantaPackageManifest> {
  const manifestPath = path.join(stagingDir, 'manta-package.json');
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (cause) {
    throw new InstallError(
      'install_manifest_invalid',
      'package tarball does not contain manta-package.json at root',
      { spec, cause: String(cause) },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new InstallError(
      'install_manifest_invalid',
      `manta-package.json is not valid JSON: ${String(cause)}`,
      { spec },
    );
  }
  const result = MantaPackageManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new InstallError(
      'install_manifest_invalid',
      `manta-package.json schema validation failed: ${issues}`,
      { spec },
    );
  }
  return result.data;
}

export async function runInstallCommand(
  rt: InstallRuntime,
  opts: RunInstallCommandOptions,
): Promise<RunInstallCommandResult> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manta-install-'));
  try {
    // Step 1+2: parse + resolve.
    let resolved;
    try {
      resolved = await rt.registryClient.resolve(opts.spec, { workDir });
    } catch (err) {
      if (err instanceof RegistryClientError) {
        if (err.code === 'unrecognized_spec') {
          throw new InstallError('install_spec_parse_failed', `cannot parse spec "${opts.spec}"`, { spec: opts.spec, cause: err.message });
        }
        if (err.code === 'offline_refused') {
          throw new InstallError(
            'install_network_required_for_spec_kind',
            err.message,
            { spec: opts.spec, ...err.details },
          );
        }
        if (err.code === 'network_failure') {
          throw new InstallError('install_network_failed', `cannot fetch ${opts.spec}: ${err.message}`, { spec: opts.spec });
        }
        if (err.code === 'manifest_missing') {
          throw new InstallError('install_manifest_invalid', `${opts.spec}: ${err.message}`, { spec: opts.spec });
        }
      }
      throw err;
    }

    // Step 2.5: --integrity preflight (before extract / stage / network egress
    // on the rest of the pipeline). A user-pinned hash that disagrees with the
    // fetched tarball is a hard stop — the operator asked us to refuse anything
    // we cannot prove matches their pin.
    const computedIntegrity = hexToIntegrity(resolved.contentSha256Hex);
    if (opts.integrity !== undefined && opts.integrity !== computedIntegrity) {
      throw new InstallError(
        'install_checksum_mismatch',
        `--integrity mismatch for ${opts.spec}:\n  expected: ${opts.integrity}\n  actual:   ${computedIntegrity}`,
        { spec: opts.spec, expected: opts.integrity, actual: computedIntegrity },
      );
    }

    // Step 3: extract with zip-slip / tar-bomb guard.
    const unpacked = path.join(workDir, 'unpacked');
    await fs.mkdir(unpacked, { recursive: true });
    await tar.x({
      file: resolved.tarballPath,
      cwd: unpacked,
      strict: true,
      filter: rejectUnsafeTarEntry,
    });

    // Step 4: pre-flight compat check from manifest.
    const manifestPath = path.join(unpacked, 'manta-package.json');
    let manifestRaw: string;
    try {
      manifestRaw = await fs.readFile(manifestPath, 'utf8');
    } catch {
      throw new InstallError('install_manifest_invalid', 'package tarball does not contain manta-package.json at root', {
        spec: opts.spec,
      });
    }
    let preManifestRaw: unknown;
    try {
      preManifestRaw = JSON.parse(manifestRaw);
    } catch (err) {
      throw new InstallError('install_manifest_invalid', `manta-package.json is not valid JSON: ${String(err)}`, { spec: opts.spec });
    }
    const mantaVersionCompat =
      preManifestRaw !== null &&
      typeof preManifestRaw === 'object' &&
      typeof (preManifestRaw as Record<string, unknown>).mantaVersionCompat === 'string'
        ? ((preManifestRaw as Record<string, unknown>).mantaVersionCompat as string)
        : null;
    if (!mantaVersionCompat) {
      throw new InstallError('install_manifest_invalid', 'manta-package.json is missing mantaVersionCompat', { spec: opts.spec });
    }
    if (!isMantaVersionCompatible(mantaVersionCompat, rt.mantaCliVersion)) {
      const ctx = {
        offendingPackage: resolved.name,
        offendingPackageRange: mantaVersionCompat,
        currentVersion: rt.mantaCliVersion,
      };
      throw new InstallError('install_compat_unmet', buildCompatErrorMessage(ctx), ctx);
    }

    // Step 5: stage into LocalStore.
    const staged = await rt.localStore.stage({ unpackedTarballDir: unpacked });

    let committed: { finalDir: string } | null = null;
    try {
      // Step 6: validate (or skip with loud warning under --no-validate).
      let manifest: MantaPackageManifest;
      if (opts.noValidate === true) {
        process.stderr.write(
          '[manta] install: --no-validate; manifest is parsed but content is not validated\n',
        );
        manifest = await parseManifestSchemaOnly(staged.stagingDir, opts.spec);
      } else {
        const validation = await validatePackage(staged.stagingDir);
        if (validation.fatal) {
          const validationIssues = validation.validationReport.flatMap((r) =>
            r.issues.filter((i) => i.severity === 'error').map((i) => `${r.path}: ${i.message}`),
          );
          const crossIssues = validation.contributesCrossCheck.ok ? [] : validation.contributesCrossCheck.issues;
          throw new InstallError(
            'install_validation_failed',
            `package failed validation:\n  ${[...validationIssues, ...crossIssues].join('\n  ')}`,
            { validationReport: validation.validationReport, crossCheck: validation.contributesCrossCheck },
          );
        }
        manifest = validation.manifest!;
      }

      // Step 7: collision check (with --force override).
      const finalDirPath = rt.localStore.pathFor(manifest.name, manifest.version);
      if (await rt.localStore.isInstalled(manifest.name, manifest.version)) {
        if (opts.force !== true) {
          throw new InstallError(
            'install_already_installed',
            `${manifest.name}@${manifest.version} already installed`,
            { packageName: manifest.name, version: manifest.version },
          );
        }
        process.stderr.write(
          `[manta] install: --force overwriting existing ${manifest.name}@${manifest.version} at ${finalDirPath}\n`,
        );
        await fs.rm(finalDirPath, { recursive: true, force: true });
      }

      // Step 8: hooks gate. Phase 7a hard-refuses to install hook contributions;
      // any manifest declaring `contributes.hooks` keeps a warning trail in
      // stderr so the operator knows the hook surface is not yet active.
      // `--no-hooks=false` is rejected at flag parse in bin/manta.ts.
      if (manifest.contributes.hooks.length > 0) {
        process.stderr.write(
          `[manta] install: package ${manifest.name} declares ${manifest.contributes.hooks.length} hook(s); hooks distribution is not yet available. Continuing install without hooks.\n`,
        );
      }

      const summary = summariseContributes(manifest);

      // Step 9: dry-run short-circuit. We have validated + collision-checked +
      // hook-summarised everything; the only remaining steps are the side
      // effects (commit, integrity hashing, index, lockfile). Skip them and
      // return a result the caller can render.
      if (opts.dryRun === true) {
        await staged.discard();
        return {
          packageName: manifest.name,
          version: manifest.version,
          installedPath: finalDirPath,
          lockfilePath: rt.lockfile.path,
          integrity: computedIntegrity,
          contributedModes: summary.modes,
          contributedSkills: summary.skills.length,
          contributedCommands: summary.commands.length,
          contributedTemplates: summary.templates.length,
          dryRun: true,
        };
      }

      // Step 10: commit.
      try {
        committed = await staged.commit({ packageName: manifest.name, version: manifest.version });
      } catch (err) {
        if (err instanceof LocalStoreError && err.code === 'collision') {
          throw new InstallError('install_already_installed', err.message, err.details);
        }
        throw err;
      }

      // Step 11: hashes.
      const integrity = computedIntegrity;
      const directoryDigest = await computeDirDigest(committed.finalDir);

      // Step 12: upsert index.
      const installedAt = nowIso();
      await rt.localStore.upsertIndexEntry({
        packageName: manifest.name,
        version: manifest.version,
        path: committed.finalDir,
        contributes: summary,
        installedAt,
        integrity,
      });

      // Step 13: lockfile mutate.
      const lockEntry: LockfileEntry = {
        version: manifest.version,
        resolved: resolved.resolved,
        integrity,
        directoryDigest,
        contributes: summary,
        mantaVersionCompat: manifest.mantaVersionCompat,
        installedAt,
      };
      await rt.lockfile.mutate((current): Lockfile => {
        const base: Lockfile = current ?? {
          schemaVersion: 1,
          mantaVersion: rt.mantaCliVersion,
          generatedAt: installedAt,
          packages: {},
        };
        return {
          ...base,
          mantaVersion: rt.mantaCliVersion,
          generatedAt: installedAt,
          packages: { ...base.packages, [manifest.name]: lockEntry },
        };
      });

      return {
        packageName: manifest.name,
        version: manifest.version,
        installedPath: committed.finalDir,
        lockfilePath: rt.lockfile.path,
        integrity,
        contributedModes: summary.modes,
        contributedSkills: summary.skills.length,
        contributedCommands: summary.commands.length,
        contributedTemplates: summary.templates.length,
        dryRun: false,
      };
    } catch (err) {
      if (!committed) {
        await staged.discard();
      }
      throw err;
    }
  } finally {
    await safeRmRf(workDir);
  }
}

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';
import { validatePackage, type MantaPackageManifest } from '@manta/skill-validator';
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
  | 'install_manifest_invalid'
  | 'install_validation_failed'
  | 'install_compat_unmet'
  | 'install_already_installed';

const EXIT_CODES: Record<InstallErrorCode, number> = {
  install_spec_parse_failed: 11,
  install_network_failed: 11,
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
  /** Reserved for Chunk 2: validation skip. Chunk 1 ignores. */
  noValidate?: false;
  /** Hooks deferred to Phase 8 — Chunk 1 hard-codes refuse-to-install. */
  noHooks?: true;
  /** Chunk-2 force flag — Chunk 1 ignores. */
  force?: false;
  /** Chunk-2 offline flag. */
  offline?: false;
  /** Chunk-2 user-pinned integrity. */
  integrity?: undefined;
  /** Chunk-2 JSON output. */
  json?: false;
  /** Chunk-2 dry-run. */
  dryRun?: false;
}

export interface RunInstallCommandResult {
  packageName: string;
  version: string;
  installedPath: string;
  lockfilePath: string;
  contributedModes: string[];
  contributedSkills: number;
  contributedCommands: number;
  contributedTemplates: number;
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
        if (err.code === 'network_failure') {
          throw new InstallError('install_network_failed', `cannot fetch ${opts.spec}: ${err.message}`, { spec: opts.spec });
        }
        if (err.code === 'manifest_missing') {
          throw new InstallError('install_manifest_invalid', `${opts.spec}: ${err.message}`, { spec: opts.spec });
        }
      }
      throw err;
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
      // Step 6: validate against staging dir.
      const validation = await validatePackage(staged.stagingDir);
      if (validation.fatal) {
        const validationIssues = validation.validationReport
          .flatMap((r) => r.issues.filter((i) => i.severity === 'error').map((i) => `${r.path}: ${i.message}`));
        const crossIssues = validation.contributesCrossCheck.ok ? [] : validation.contributesCrossCheck.issues;
        throw new InstallError(
          'install_validation_failed',
          `package failed validation:\n  ${[...validationIssues, ...crossIssues].join('\n  ')}`,
          { validationReport: validation.validationReport, crossCheck: validation.contributesCrossCheck },
        );
      }
      const manifest = validation.manifest!;

      // Step 7: collision check.
      if (await rt.localStore.isInstalled(manifest.name, manifest.version)) {
        throw new InstallError(
          'install_already_installed',
          `${manifest.name}@${manifest.version} already installed`,
          { packageName: manifest.name, version: manifest.version },
        );
      }

      // Step 8: hooks gate (Chunk 1: hard-refuse).
      if (manifest.contributes.hooks.length > 0) {
        process.stderr.write(
          `[manta] install: package ${manifest.name} declares ${manifest.contributes.hooks.length} hook(s); hooks distribution is deferred to Phase 8. Continuing install without hooks.\n`,
        );
      }

      // Step 9: commit.
      try {
        committed = await staged.commit({ packageName: manifest.name, version: manifest.version });
      } catch (err) {
        if (err instanceof LocalStoreError && err.code === 'collision') {
          throw new InstallError('install_already_installed', err.message, err.details);
        }
        throw err;
      }

      // Step 10: hashes.
      const integrity = `sha256-${Buffer.from(resolved.contentSha256Hex, 'hex').toString('base64')}`;
      const directoryDigest = await computeDirDigest(committed.finalDir);

      // Step 11: upsert index.
      const summary = summariseContributes(manifest);
      const installedAt = nowIso();
      await rt.localStore.upsertIndexEntry({
        packageName: manifest.name,
        version: manifest.version,
        path: committed.finalDir,
        contributes: summary,
        installedAt,
        integrity,
      });

      // Step 12: lockfile mutate.
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
        contributedModes: summary.modes,
        contributedSkills: summary.skills.length,
        contributedCommands: summary.commands.length,
        contributedTemplates: summary.templates.length,
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

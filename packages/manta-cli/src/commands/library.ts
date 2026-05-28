import * as fs from 'node:fs/promises';
import semver from 'semver';
import { validatePackage } from '@manta/skill-validator';
import { isMantaVersionCompatible } from '../library/compat.js';
import type { LockfileStore, LockfileEntry } from '../library/lockfile.js';
import type { LocalStore, GlobalLibraryIndexEntry } from '../library/local-store.js';

export type LibraryErrorCode = 'library_not_installed' | 'library_unhealthy';

const EXIT_CODES: Record<LibraryErrorCode, number> = {
  library_not_installed: 12,
  // 19 is reserved for Clone B's `library_tampered` hash-pin verification at
  // cast time — using 20 keeps CI/JSON consumers able to distinguish
  // "re-install to fix tamper" from "upgrade CLI or uninstall to fix compat".
  library_unhealthy: 20,
};

export class LibraryError extends Error {
  readonly code: LibraryErrorCode;
  readonly exitCode: number;
  readonly details: Record<string, unknown>;
  constructor(
    code: LibraryErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'LibraryError';
    this.code = code;
    this.exitCode = EXIT_CODES[code];
    this.details = details;
  }
}

/**
 * Library-scoped network interface. `outdated` is the only library subcommand
 * that needs network — list/show/doctor are all-local. We keep this distinct
 * from `NetworkRunner` (registry-client.ts) because the install/cast paths
 * already wire that abstraction and we don't want to widen it just to add
 * `npmView` to every consumer.
 */
export interface LibraryNetworkRunner {
  /** `npm view <name> versions --json` — returns the package's published versions. */
  npmView(name: string): Promise<string[]>;
}

export interface LibraryRuntime {
  readonly repoRoot: string;
  readonly lockfile: LockfileStore;
  readonly localStore: LocalStore;
  readonly network: LibraryNetworkRunner;
  readonly mantaCliVersion: string;
}

export interface LibraryListItem {
  packageName: string;
  version: string;
  modes: string[];
  skills: string[];
  commands: string[];
  templates: string[];
  path: string;
  installedAt: string;
  integrity: string;
}

export interface RunLibraryListCommandResult {
  exitCode: 0;
  installs: LibraryListItem[];
}

function toListItem(entry: GlobalLibraryIndexEntry): LibraryListItem {
  return {
    packageName: entry.packageName,
    version: entry.version,
    modes: entry.contributes.modes,
    skills: entry.contributes.skills,
    commands: entry.contributes.commands,
    templates: entry.contributes.templates,
    path: entry.path,
    installedAt: entry.installedAt,
    integrity: entry.integrity,
  };
}

export async function runLibraryListCommand(
  rt: LibraryRuntime,
): Promise<RunLibraryListCommandResult> {
  const index = await rt.localStore.readIndex();
  return {
    exitCode: 0,
    installs: index.installs.map(toListItem),
  };
}

export interface RunLibraryShowCommandOptions {
  /** `@scope/name` or `@scope/name@version`. */
  spec: string;
}

export interface RunLibraryShowCommandResult {
  exitCode: 0;
  install: LibraryListItem;
  lockEntry: LockfileEntry | null;
}

function parseSpec(spec: string): { packageName: string; version: string | undefined } {
  if (spec.startsWith('@')) {
    const versionAt = spec.indexOf('@', 1);
    if (versionAt < 0) return { packageName: spec, version: undefined };
    return {
      packageName: spec.slice(0, versionAt),
      version: spec.slice(versionAt + 1) || undefined,
    };
  }
  const at = spec.indexOf('@');
  if (at < 0) return { packageName: spec, version: undefined };
  return { packageName: spec.slice(0, at), version: spec.slice(at + 1) || undefined };
}

export async function runLibraryShowCommand(
  rt: LibraryRuntime,
  opts: RunLibraryShowCommandOptions,
): Promise<RunLibraryShowCommandResult> {
  const { packageName, version } = parseSpec(opts.spec);
  const index = await rt.localStore.readIndex();
  const candidates = index.installs.filter((e) => e.packageName === packageName);
  if (candidates.length === 0) {
    throw new LibraryError(
      'library_not_installed',
      `${packageName} is not installed`,
      { packageName },
    );
  }
  let entry: GlobalLibraryIndexEntry;
  if (version !== undefined) {
    const found = candidates.find((e) => e.version === version);
    if (!found) {
      throw new LibraryError(
        'library_not_installed',
        `${packageName}@${version} is not installed. Available: ${candidates.map((e) => e.version).sort().join(', ')}.`,
        { packageName, version, available: candidates.map((e) => e.version) },
      );
    }
    entry = found;
  } else if (candidates.length > 1) {
    // Ambiguous bare name — return the latest by semver-string sort so the
    // human gets *something* and the JSON consumer sees a deterministic pick.
    const sorted = [...candidates].sort((a, b) => semver.rcompare(a.version, b.version));
    entry = sorted[0]!;
  } else {
    entry = candidates[0]!;
  }
  const lock = await rt.lockfile.read();
  const lockEntry = lock?.packages[entry.packageName] ?? null;
  return { exitCode: 0, install: toListItem(entry), lockEntry };
}

export type OutdatedStatus = 'up-to-date' | 'outdated' | 'pinned' | 'unknown';

export interface OutdatedReportItem {
  packageName: string;
  currentVersion: string;
  status: OutdatedStatus;
  latestSatisfying?: string;
  range: string;
  resolved: string;
  reason?: string;
}

export interface RunLibraryOutdatedCommandResult {
  exitCode: 0;
  report: OutdatedReportItem[];
}

function isGitResolved(resolved: string): boolean {
  return resolved.startsWith('git+') || resolved.startsWith('git://');
}

function isNpmResolved(resolved: string): boolean {
  return /^https?:\/\/registry\./.test(resolved);
}

export async function runLibraryOutdatedCommand(
  rt: LibraryRuntime,
): Promise<RunLibraryOutdatedCommandResult> {
  const lock = await rt.lockfile.read();
  if (lock === null) return { exitCode: 0, report: [] };
  const report: OutdatedReportItem[] = [];
  for (const [packageName, entry] of Object.entries(lock.packages).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const baseItem = {
      packageName,
      currentVersion: entry.version,
      range: entry.mantaVersionCompat,
      resolved: entry.resolved,
    };
    if (isGitResolved(entry.resolved)) {
      report.push({ ...baseItem, status: 'pinned' });
      continue;
    }
    if (!isNpmResolved(entry.resolved)) {
      // local-tgz installs (absolute path) and anything we don't recognise.
      report.push({
        ...baseItem,
        status: 'unknown',
        reason: 'resolved is not an npm registry URL or git+ ref',
      });
      continue;
    }
    let versions: string[];
    try {
      versions = await rt.network.npmView(packageName);
    } catch (cause) {
      report.push({
        ...baseItem,
        status: 'unknown',
        reason: `npm view failed: ${String((cause as Error)?.message ?? cause)}`,
      });
      continue;
    }
    // Plan §2.3 says "find newer versions satisfying lockfile range" — the
    // lockfile only records `version` (resolved exact) and `mantaVersionCompat`
    // (a CLI range, not a package range). So the practical heuristic is:
    // among valid semver published versions, anything strictly greater than
    // the currently installed version is a candidate; report the highest.
    // The operator decides whether to upgrade.
    const valid = versions.filter((v): v is string => typeof v === 'string' && semver.valid(v) !== null);
    if (valid.length === 0) {
      report.push({ ...baseItem, status: 'unknown', reason: 'no valid semver versions returned by npm view' });
      continue;
    }
    const newer = valid.filter((v) => semver.gt(v, entry.version));
    if (newer.length === 0) {
      report.push({ ...baseItem, status: 'up-to-date' });
      continue;
    }
    const latest = newer.sort(semver.rcompare)[0]!;
    report.push({ ...baseItem, status: 'outdated', latestSatisfying: latest });
  }
  return { exitCode: 0, report };
}

export interface DoctorReportItem {
  packageName: string;
  version: string;
  healthy: boolean;
  issues: string[];
}

export interface RunLibraryDoctorCommandResult {
  exitCode: 0;
  healthy: DoctorReportItem[];
  unhealthy: DoctorReportItem[];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function runLibraryDoctorCommand(
  rt: LibraryRuntime,
): Promise<RunLibraryDoctorCommandResult> {
  const index = await rt.localStore.readIndex();
  const lock = await rt.lockfile.read();
  const healthy: DoctorReportItem[] = [];
  const unhealthy: DoctorReportItem[] = [];

  for (const entry of index.installs) {
    const issues: string[] = [];
    const installPath = rt.localStore.pathFor(entry.packageName, entry.version);
    if (!(await pathExists(installPath))) {
      issues.push(
        `install dir missing at ${installPath} — run \`manta install ${entry.packageName}@${entry.version} --force\` to re-fetch`,
      );
    } else {
      try {
        const validation = await validatePackage(installPath);
        if (validation.fatal) {
          const errs = validation.validationReport.flatMap((r) =>
            r.issues.filter((i) => i.severity === 'error').map((i) => `${r.path}: ${i.message}`),
          );
          const cross = validation.contributesCrossCheck.ok
            ? []
            : validation.contributesCrossCheck.issues;
          issues.push(...errs, ...cross);
        }
      } catch (cause) {
        issues.push(`validatePackage threw: ${String((cause as Error)?.message ?? cause)}`);
      }
    }
    // mantaVersionCompat drift via the lockfile (the install dir's manifest
    // may not include mantaVersionCompat if the user manually altered it;
    // the lockfile is authoritative for the recorded range).
    const lockEntry = lock?.packages[entry.packageName];
    if (lockEntry && !isMantaVersionCompatible(lockEntry.mantaVersionCompat, rt.mantaCliVersion)) {
      issues.push(
        `mantaVersionCompat ${lockEntry.mantaVersionCompat} not satisfied by CLI ${rt.mantaCliVersion}`,
      );
    }

    const report: DoctorReportItem = {
      packageName: entry.packageName,
      version: entry.version,
      healthy: issues.length === 0,
      issues,
    };
    if (issues.length === 0) healthy.push(report);
    else unhealthy.push(report);
  }

  if (unhealthy.length > 0) {
    throw new LibraryError(
      'library_unhealthy',
      `${unhealthy.length} unhealthy package(s): ${unhealthy.map((u) => `${u.packageName}@${u.version}`).join(', ')}`,
      { healthy, unhealthy },
    );
  }

  return { exitCode: 0, healthy, unhealthy };
}

/** Default `LibraryNetworkRunner` — shells out to `npm view`. */
export async function defaultNpmView(name: string): Promise<string[]> {
  const { execa } = await import('execa');
  const r = await execa('npm', ['view', name, 'versions', '--json'], { reject: false });
  if (r.exitCode !== 0) {
    throw new Error(`npm view ${name} exited ${r.exitCode}: ${r.stderr || r.stdout}`);
  }
  const parsed: unknown = JSON.parse(r.stdout);
  if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
  if (typeof parsed === 'string') return [parsed];
  return [];
}

export function createDefaultLibraryNetworkRunner(): LibraryNetworkRunner {
  return { npmView: defaultNpmView };
}

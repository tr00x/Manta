import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as tar from 'tar';
import { execa } from 'execa';

export type SpecKind = 'npm' | 'git' | 'local-tgz';

export interface ParsedSpec {
  kind: SpecKind;
  npmName?: string | undefined;
  npmRange?: string | undefined;
  gitUrl?: string | undefined;
  gitRef?: string | undefined;
  localPath?: string | undefined;
}

export interface ResolvedPackage {
  /** Original user-typed spec. */
  spec: string;
  kind: SpecKind;
  name: string;
  version: string;
  /** Lockfile.resolved value: URL for npm/git, absolute path for local-tgz. */
  resolved: string;
  /** On-disk path to the resolved .tgz under workDir. */
  tarballPath: string;
  /** SHA-256 of the tarball bytes as hex. */
  contentSha256Hex: string;
}

export interface NetworkRunner {
  /** `npm pack <spec>` into `cwd`. Returns the produced tarball filename. */
  npmPack(spec: string, opts: { cwd: string }): Promise<string>;
  /** `git clone --depth=1 [--branch <ref>] <url> <dest>`. */
  gitClone(opts: { url: string; ref?: string | undefined; dest: string }): Promise<void>;
}

export interface RegistryClient {
  parseSpec(spec: string): ParsedSpec;
  resolve(spec: string, opts: { workDir: string }): Promise<ResolvedPackage>;
}

export type RegistryClientErrorCode = 'unrecognized_spec' | 'manifest_missing' | 'network_failure' | 'tarball_corrupt';

export class RegistryClientError extends Error {
  readonly code: RegistryClientErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: RegistryClientErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RegistryClientError';
    this.code = code;
    this.details = details;
  }
}

const SCOPED_NPM = /^(@[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*)(?:@(.+))?$/;
const BARE_NPM = /^([a-z][a-z0-9-]*)(?:@(.+))?$/;
const GIT_PREFIX = /^git\+(https?|ssh):\/\//;
const LOCAL_TGZ = /^(?:\.{1,2}\/|\/).+\.tgz$/;

export function parseSpec(spec: string): ParsedSpec {
  if (LOCAL_TGZ.test(spec)) {
    return { kind: 'local-tgz', localPath: spec };
  }
  if (GIT_PREFIX.test(spec)) {
    const stripped = spec.replace(/^git\+/, '');
    const hashIdx = stripped.indexOf('#');
    if (hashIdx === -1) {
      return { kind: 'git', gitUrl: stripped, gitRef: undefined };
    }
    return {
      kind: 'git',
      gitUrl: stripped.slice(0, hashIdx),
      gitRef: stripped.slice(hashIdx + 1) || undefined,
    };
  }
  const scopedMatch = SCOPED_NPM.exec(spec);
  if (scopedMatch) {
    return { kind: 'npm', npmName: scopedMatch[1], npmRange: scopedMatch[2] };
  }
  const bareMatch = BARE_NPM.exec(spec);
  if (bareMatch) {
    return { kind: 'npm', npmName: bareMatch[1], npmRange: bareMatch[2] };
  }
  throw new RegistryClientError('unrecognized_spec', `cannot parse spec: ${spec}`, { spec });
}

async function sha256Hex(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function extractManifestFromTarball(tarballPath: string): Promise<{ name: string; version: string }> {
  let captured: { name?: string; version?: string } = {};
  await tar.t({
    file: tarballPath,
    onentry: (entry) => {
      const p = entry.path.replace(/^\.\//, '');
      if (p === 'manta-package.json' || p.endsWith('/manta-package.json')) {
        const chunks: Buffer[] = [];
        entry.on('data', (c: Buffer) => chunks.push(c));
        entry.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (typeof json.name === 'string' && typeof json.version === 'string') {
              captured = { name: json.name, version: json.version };
            }
          } catch {
            // Surfaced below if name/version missing.
          }
        });
      }
    },
  });
  if (!captured.name || !captured.version) {
    throw new RegistryClientError('manifest_missing', 'tarball did not contain a parseable manta-package.json', { tarballPath });
  }
  return { name: captured.name, version: captured.version };
}

async function readManifestFromDir(dir: string): Promise<{ name: string; version: string }> {
  const p = path.join(dir, 'manta-package.json');
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (cause) {
    throw new RegistryClientError('manifest_missing', `manta-package.json not found in ${dir}`, { dir, cause: String(cause) });
  }
  const json = JSON.parse(raw);
  if (typeof json.name !== 'string' || typeof json.version !== 'string') {
    throw new RegistryClientError('manifest_missing', `manta-package.json is missing name or version in ${dir}`, { dir });
  }
  return { name: json.name, version: json.version };
}

async function packDirToTarball(srcDir: string, outPath: string): Promise<void> {
  const files = await fs.readdir(srcDir);
  await tar.c(
    {
      file: outPath,
      cwd: srcDir,
      gzip: true,
      portable: true,
      noMtime: true,
    },
    files,
  );
}

export interface CreateRegistryClientOptions {
  runner: NetworkRunner;
}

export function createRegistryClient(opts: CreateRegistryClientOptions): RegistryClient {
  async function resolveLocalTgz(spec: string, parsed: ParsedSpec, workDir: string): Promise<ResolvedPackage> {
    const localPath = path.resolve(parsed.localPath!);
    const destName = path.basename(localPath);
    const dest = path.join(workDir, destName);
    await fs.copyFile(localPath, dest);
    const { name, version } = await extractManifestFromTarball(dest);
    const sha = await sha256Hex(dest);
    return { spec, kind: 'local-tgz', name, version, resolved: localPath, tarballPath: dest, contentSha256Hex: sha };
  }

  async function resolveNpm(spec: string, parsed: ParsedSpec, workDir: string): Promise<ResolvedPackage> {
    const fetchSpec = parsed.npmRange ? `${parsed.npmName}@${parsed.npmRange}` : parsed.npmName!;
    let filename: string;
    try {
      filename = await opts.runner.npmPack(fetchSpec, { cwd: workDir });
    } catch (cause) {
      throw new RegistryClientError('network_failure', `npm pack failed for ${fetchSpec}`, { cause: String(cause) });
    }
    const tarballPath = path.join(workDir, filename);
    const { name, version } = await extractManifestFromTarball(tarballPath);
    const sha = await sha256Hex(tarballPath);
    const resolved = `https://registry.npmjs.org/${name}/-/${path.basename(filename)}`;
    return { spec, kind: 'npm', name, version, resolved, tarballPath, contentSha256Hex: sha };
  }

  async function resolveGit(spec: string, parsed: ParsedSpec, workDir: string): Promise<ResolvedPackage> {
    const cloneDir = path.join(workDir, 'src');
    try {
      await opts.runner.gitClone({ url: parsed.gitUrl!, ref: parsed.gitRef, dest: cloneDir });
    } catch (cause) {
      throw new RegistryClientError('network_failure', `git clone failed for ${parsed.gitUrl}`, { cause: String(cause) });
    }
    const { name, version } = await readManifestFromDir(cloneDir);
    const safeName = name.replace(/[/@]/g, '-').replace(/^-+/, '');
    const tarballPath = path.join(workDir, `${safeName}-${version}.tgz`);
    await packDirToTarball(cloneDir, tarballPath);
    const sha = await sha256Hex(tarballPath);
    return { spec, kind: 'git', name, version, resolved: spec, tarballPath, contentSha256Hex: sha };
  }

  return {
    parseSpec: (s) => parseSpec(s),
    async resolve(spec, options) {
      const parsed = parseSpec(spec);
      const wd = path.resolve(options.workDir);
      await fs.mkdir(wd, { recursive: true });
      switch (parsed.kind) {
        case 'local-tgz':
          return resolveLocalTgz(spec, parsed, wd);
        case 'npm':
          return resolveNpm(spec, parsed, wd);
        case 'git':
          return resolveGit(spec, parsed, wd);
      }
    },
  };
}

/** Default runner shells out to `npm pack` and `git clone`. */
export function createDefaultNetworkRunner(): NetworkRunner {
  return {
    async npmPack(spec, runOpts) {
      const { stdout } = await execa('npm', ['pack', spec, '--silent'], { cwd: runOpts.cwd });
      const trimmed = stdout.trim().split(/\r?\n/).pop();
      if (!trimmed) {
        throw new RegistryClientError('network_failure', `npm pack returned no output for ${spec}`);
      }
      return trimmed;
    },
    async gitClone(runOpts) {
      const args = ['clone', '--depth=1'];
      if (runOpts.ref) {
        args.push('--branch', runOpts.ref);
      }
      args.push(runOpts.url, runOpts.dest);
      await execa('git', args);
    },
  };
}

import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';
import {
  SharedBundleManifestSchema,
  LibraryModeJsonSchema,
  type SharedBundleManifest,
  type MantaPackageManifest,
} from '@manta/skill-validator';
import { SnapshotSchema, TaskContractSchema } from '@manta/snapshot';
import { CastManifestSchema } from '@manta/bus';
import type { Runtime } from '../runtime.js';
import { getMantaCliVersion } from '../library/cli-version.js';
import { sanitizeSnapshot } from '../share/sanitize-snapshot.js';
import { cloneWorktreePath } from '../spawner/worktree.js';
import { sanitizeTaskContract } from '../share/sanitize-task-contract.js';
import { sanitizePostMortemMarkdown } from '../share/sanitize-post-mortem.js';
import { sanitizeZkNote } from '../share/sanitize-zk-note.js';
import { sanitizeEvents } from '../share/sanitize-events.js';
import { sanitizeWorktreeDiff } from '../share/sanitize-worktree-diff.js';
import { buildCastOrigin } from '../share/build-cast-origin.js';
import { generateReadme } from '../share/generate-readme.js';
import { assembleBundle, type BundleArtifacts } from '../share/bundle-assembler.js';
import {
  publishBundle,
  type PublishRunner,
  type Confirmer,
} from '../share/publish-flow.js';
import { ShareSanitizationError } from '../share/errors.js';
import type { SanitizationWarning } from '../share/types.js';
import * as readline from 'node:readline/promises';

/**
 * `manta share <cast-id>` — local-bundle pipeline (Phase 7b Task 2.4).
 *
 * Orchestrates: resolve winner → read all cast artifacts → sanitize each →
 * build castOrigin → assemble manifest → generate README → assemble bundle.
 * Chunk 2 ships ONLY the local-bundle path; `--publish` is Chunk 3 and is
 * hard-`false` here. Environment-dependent inputs (clock, git remote, git
 * diff, clone-worktree location) are injected via `deps` so tests are fully
 * deterministic; the bin entrypoint supplies execa-backed defaults.
 */

const EXIT_CODES = {
  share_cast_not_found: 20,
  share_no_winner: 21,
  share_secret_detected: 22,
  share_nothing_to_ship: 23,
  share_warnings_unaccepted: 24,
  share_author_missing: 25,
  share_license_missing: 26,
  share_publish_blocked: 27,
} as const;

export type ShareErrorCode = keyof typeof EXIT_CODES;

export class ShareError extends Error {
  readonly code: ShareErrorCode;
  readonly exitCode: number;
  readonly details: Record<string, unknown>;
  constructor(code: ShareErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ShareError';
    this.code = code;
    this.exitCode = EXIT_CODES[code];
    this.details = details;
  }
}

export interface ShareDeps {
  /** Bundle time, ISO second-precision UTC. Injected for determinism. */
  now: () => string;
  /** `git remote get-url origin` → URL string, or null if absent/local. */
  resolveGitRemote: (repoRoot: string) => Promise<string | null>;
  /** Unified diff of the winning clone's branch vs its merge base. */
  resolveWorktreeDiff: (opts: { repoRoot: string; castId: string; cloneId: string }) => Promise<string>;
  /** Absolute path to the winning clone's worktree (skills/modes walk source). */
  resolveCloneWorktree: (opts: { repoRoot: string; castId: string; cloneId: string }) => string;
  /** npm publish shell-outs (Chunk 3). Default = execa-backed; tests inject fakes. */
  publishRunner: PublishRunner;
  /** Interactive yes/no prompter (Chunk 3). Default = stdin readline; tests inject fakes. */
  confirmer: Confirmer;
}

export interface RunShareCommandOptions {
  castId: string;
  clone?: string;
  outDir?: string;
  noEdit?: boolean;
  acceptWarnings?: boolean;
  nonInteractive?: boolean;
  /** Publish the assembled bundle to npm behind the MVTS-7 gates (Chunk 3). */
  publish?: boolean;
  /** Override the publish size cap (bytes). Default 5 MB (see publish-flow). */
  maxBytes?: number;
  // Manifest field overrides (CLI flags). name/version are REQUIRED.
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  mantaVersionCompat?: string;
  /** Injected environment seams; defaults provided by the bin entrypoint. */
  deps?: Partial<ShareDeps>;
}

export interface RunShareCommandResult {
  tarballPath: string;
  packageName: string;
  version: string;
  directoryDigest: string;
  warnings: SanitizationWarning[];
  winningCloneId: string;
  /** `<name>@<version>` if `--publish` ran and succeeded; undefined otherwise. */
  published?: string;
}

function defaultDeps(): ShareDeps {
  return {
    now: () => `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
    resolveGitRemote: async (repoRoot) => {
      try {
        const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot });
        return stdout.trim() || null;
      } catch {
        return null;
      }
    },
    resolveWorktreeDiff: async ({ repoRoot, castId, cloneId }) => {
      const branch = `manta/${castId}/${cloneId}`;
      try {
        const { stdout } = await execa('git', ['diff', `main...${branch}`], { cwd: repoRoot });
        return stdout;
      } catch {
        return '';
      }
    },
    resolveCloneWorktree: ({ repoRoot, castId, cloneId }) =>
      cloneWorktreePath(repoRoot, castId, cloneId),
    publishRunner: {
      whoami: async () => {
        try {
          const { stdout } = await execa('npm', ['whoami']);
          return stdout.trim() || null;
        } catch {
          return null;
        }
      },
      listScopePackages: async (scope) => {
        // `npm access list packages @<scope>` → JSON map of pkg → permission.
        try {
          const { stdout } = await execa('npm', ['access', 'list', 'packages', `@${scope}`, '--json']);
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          return Object.keys(parsed);
        } catch {
          return [];
        }
      },
      publish: async (tarballPath, opts) => {
        await execa('npm', ['publish', tarballPath, '--access', opts.access], { stdio: 'inherit' });
      },
    },
    confirmer: {
      confirm: async (prompt) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
          return answer === 'y' || answer === 'yes';
        } finally {
          rl.close();
        }
      },
    },
  };
}

async function readJsonFile(p: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Parse the winning clone id out of a forking-realities merge-review verdict. */
function parseMergeReviewWinner(markdown: string): string | null {
  // Accepts `**Winner:** B`, `Verdict: merge A`, `winning clone: clone-B`.
  const patterns = [
    /winner[:*\s]+`?(?:clone-)?([A-Za-z0-9_]+)`?/i,
    /verdict[:*\s]+merge\s+`?(?:clone-)?([A-Za-z0-9_]+)`?/i,
    /winning clone[:*\s]+`?(?:clone-)?([A-Za-z0-9_]+)`?/i,
  ];
  for (const re of patterns) {
    const m = re.exec(markdown);
    if (m && m[1]) return m[1];
  }
  return null;
}

async function resolveWinner(
  rt: Runtime,
  castId: string,
  explicitClone: string | undefined,
): Promise<string> {
  if (explicitClone !== undefined) return explicitClone;
  const reviewPath = path.join(rt.repoRoot, 'docs', 'merge-reviews', `${castId}.md`);
  try {
    const md = await fs.readFile(reviewPath, 'utf8');
    const winner = parseMergeReviewWinner(md);
    if (winner !== null) return winner;
  } catch {
    // no merge review on disk
  }
  throw new ShareError(
    'share_no_winner',
    `no winner; pass --clone <id> (recon-swarm casts produce no single shippable mode)`,
    { castId },
  );
}

async function findPostMortem(
  rt: Runtime,
  castId: string,
  cloneId: string,
): Promise<string | null> {
  const dir = path.join(rt.repoRoot, 'docs', 'post-mortems');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  // Filename: `${day}-${cast}-${cloneId}.md` (post-mortem.ts:77).
  const match = entries.find((f) => f.endsWith(`-${castId}-${cloneId}.md`));
  if (match === undefined) return null;
  return fs.readFile(path.join(dir, match), 'utf8');
}

interface ZkNoteFile {
  filename: string;
  markdown: string;
}

async function findZkNotes(rt: Runtime, cloneId: string): Promise<ZkNoteFile[]> {
  // ZK notes are surfaced via `zk_write` events: payload carries note_id; the
  // file lives under docs/zk/<slug>-<id>.md. We resolve by id suffix.
  const events = await rt.ctx.events.readAll();
  const noteIds = new Set<string>();
  for (const e of events) {
    if (e.type === 'zk_write' && e.clone_id === cloneId && e.payload && typeof e.payload === 'object') {
      const id = (e.payload as Record<string, unknown>).note_id;
      if (typeof id === 'string') noteIds.add(id);
    }
  }
  if (noteIds.size === 0) return [];
  const dir = path.join(rt.repoRoot, 'docs', 'zk');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: ZkNoteFile[] = [];
  for (const f of entries) {
    for (const id of noteIds) {
      if (f.includes(id) && f.endsWith('.md')) {
        out.push({ filename: f, markdown: await fs.readFile(path.join(dir, f), 'utf8') });
        break;
      }
    }
  }
  return out;
}

function readFrontmatterField(markdown: string, field: string): string | null {
  const re = new RegExp(`^${field}:\\s*(.+)$`, 'm');
  const m = re.exec(markdown);
  return m && m[1] ? m[1].trim() : null;
}

/** Walk the winning clone's worktree for shippable contributions (skills/modes). */
async function walkContributes(
  cloneWorktree: string,
): Promise<MantaPackageManifest['contributes']> {
  const contributes: MantaPackageManifest['contributes'] = {
    skills: [],
    commands: [],
    modes: [],
    templates: [],
    hooks: [],
  };

  // Skills: skills/<name>/SKILL.md
  const skillsDir = path.join(cloneWorktree, 'skills');
  try {
    for (const name of await fs.readdir(skillsDir)) {
      const skillMd = path.join(skillsDir, name, 'SKILL.md');
      try {
        const md = await fs.readFile(skillMd, 'utf8');
        const desc = readFrontmatterField(md, 'description') ?? `Skill ${name}`;
        contributes.skills.push({ name, description: desc.slice(0, 280) });
      } catch {
        // not a skill dir
      }
    }
  } catch {
    // no skills dir
  }

  // Modes: modes/<name>.json (LibraryModeJsonSchema → ModeContribution)
  // M2 fix (code-review cast-1780023574334): parse against
  // LibraryModeJsonSchema instead of the previous loose typeof guards +
  // `m.basedOn as never` cast. Malformed JSON now safely skips with a
  // typed result instead of smuggling unvalidated fields into the manifest
  // (and the cast disappears with the validation).
  const modesDir = path.join(cloneWorktree, 'modes');
  try {
    for (const file of await fs.readdir(modesDir)) {
      if (!file.endsWith('.json')) continue;
      const parsed = await readJsonFile(path.join(modesDir, file));
      const result = LibraryModeJsonSchema.safeParse(parsed);
      if (!result.success) continue; // skip malformed; never bypass validation
      const m = result.data;
      contributes.modes.push({
        name: m.name,
        description: m.description,
        basedOn: m.basedOn,
        cloneCount: m.cloneCount,
        sessionMode: m.sessionMode,
        templates: [],
        ...(m.capabilityProfile !== undefined ? { capabilityProfile: m.capabilityProfile } : {}),
      });
    }
  } catch {
    // no modes dir
  }

  return contributes;
}

async function collectSkillFiles(
  cloneWorktree: string,
): Promise<Array<{ relPath: string; content: string }>> {
  const out: Array<{ relPath: string; content: string }> = [];
  async function walk(rel: string): Promise<void> {
    const abs = path.join(cloneWorktree, rel);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = path.join(rel, e.name);
      if (e.isDirectory()) await walk(childRel);
      else if (e.isFile()) {
        out.push({
          relPath: childRel.split(path.sep).slice(1).join('/'), // strip leading "skills/"
          content: await fs.readFile(path.join(cloneWorktree, childRel), 'utf8'),
        });
      }
    }
  }
  await walk('skills');
  return out;
}

function firstReasonLine(postMortem: string | null, castId: string): string {
  if (postMortem === null) return `Manta cast ${castId} deliverable`;
  const m = /^#+\s*Reason\s*\n+(.+)$/im.exec(postMortem) ?? /Reason[:*\s]+(.+)$/im.exec(postMortem);
  const line = m && m[1] ? m[1].trim() : `Manta cast ${castId} deliverable`;
  return line.slice(0, 280);
}

export async function runShareCommand(
  rt: Runtime,
  opts: RunShareCommandOptions,
): Promise<RunShareCommandResult> {
  // Command-layer defense-in-depth (Task 3.3): the CLI's pre-commander guard
  // rejects `--publish --non-interactive` with exit 2 before commander runs, so
  // a trigger literally cannot construct a publishing invocation. This second
  // layer refuses the same combination even when runShareCommand is called
  // programmatically (bypassing the CLI). Publishing ALWAYS requires interactive
  // human confirmation (Phase 7b §0 informed-consent — auto-share may build a
  // bundle, never publish one).
  if (opts.publish === true && opts.nonInteractive === true) {
    throw new ShareError(
      'share_publish_blocked',
      '--publish cannot be combined with --non-interactive; publishing requires interactive human confirmation',
    );
  }
  const deps: ShareDeps = { ...defaultDeps(), ...(opts.deps ?? {}) };
  const warnings: SanitizationWarning[] = [];
  // Compute the bundle timestamp exactly ONCE so the zk-note created_at rewrite
  // and castOrigin.bundledAt agree, and so two runs with an injected clock are
  // byte-identical.
  const bundledAt = deps.now();

  // 1. Read + parse the cast manifest.
  const castPath = rt.ctx.paths.castFile(opts.castId);
  const rawCast = await readJsonFile(castPath);
  if (rawCast === null) {
    throw new ShareError('share_cast_not_found', `cast ${opts.castId} not found`, { castId: opts.castId });
  }
  const castManifest = CastManifestSchema.parse(rawCast);

  // 2. Resolve the winning clone.
  const winningCloneId = await resolveWinner(rt, opts.castId, opts.clone);

  // 3. Read winner artifacts.
  const snapshotPath = path.join(
    rt.repoRoot,
    '.manta',
    'snapshots',
    opts.castId,
    `${winningCloneId}.snapshot.json`,
  );
  const rawSnapshot = await readJsonFile(snapshotPath);
  if (rawSnapshot === null) {
    throw new ShareError('share_no_winner', `winner ${winningCloneId} has no snapshot on disk`, {
      castId: opts.castId,
      winningCloneId,
    });
  }
  const snapshot = SnapshotSchema.parse(rawSnapshot);

  const rawContract = await readJsonFile(rt.ctx.paths.contractFile(winningCloneId));
  const contract = rawContract !== null ? TaskContractSchema.parse(rawContract) : snapshot.taskContract;

  const postMortem = await findPostMortem(rt, opts.castId, winningCloneId);
  const zkNotes = await findZkNotes(rt, winningCloneId);
  const events = await rt.ctx.events.readAll();
  const worktreeDiff = await deps.resolveWorktreeDiff({
    repoRoot: rt.repoRoot,
    castId: opts.castId,
    cloneId: winningCloneId,
  });

  // 4. Sanitize each (fatal secret → abort exit 22).
  let sanitizedSnapshot: ReturnType<typeof sanitizeSnapshot>['sanitized'];
  let sanitizedContract;
  let sanitizedPostMortem = '';
  const sanitizedZk: Array<{ filename: string; markdown: string }> = [];
  let sanitizedDiff = '';
  let sanitizedEventsJsonl = '';
  try {
    const snapRes = sanitizeSnapshot(snapshot);
    sanitizedSnapshot = snapRes.sanitized;
    warnings.push(...snapRes.warnings);

    const contractRes = sanitizeTaskContract(contract, { repoRoot: rt.repoRoot });
    sanitizedContract = contractRes.sanitized;
    warnings.push(...contractRes.warnings);

    if (postMortem !== null) {
      const pmRes = sanitizePostMortemMarkdown(postMortem, { repoRoot: rt.repoRoot });
      sanitizedPostMortem = pmRes.sanitized;
      warnings.push(...pmRes.warnings);
    }

    for (const zk of zkNotes) {
      const zkRes = sanitizeZkNote(zk.markdown, { repoRoot: rt.repoRoot, bundledAt });
      sanitizedZk.push({ filename: zk.filename, markdown: zkRes.sanitized });
      warnings.push(...zkRes.warnings);
    }

    const diffRes = sanitizeWorktreeDiff(worktreeDiff);
    sanitizedDiff = diffRes.sanitized;
    warnings.push(...diffRes.warnings);

    const evRes = sanitizeEvents(events, {
      winningCloneId,
      castCreatedAt: castManifest.created_at,
    });
    sanitizedEventsJsonl = evRes.sanitized.map((e) => JSON.stringify(e)).join('\n') + (evRes.sanitized.length > 0 ? '\n' : '');
    warnings.push(...evRes.warnings);
  } catch (err) {
    if (err instanceof ShareSanitizationError) {
      throw new ShareError('share_secret_detected', `secret detected: ${err.code}`, {
        code: err.code,
        findings: err.details.findings,
      });
    }
    throw err;
  }

  // 5. git remote (path-safe).
  const gitRemoteOrigin = await deps.resolveGitRemote(rt.repoRoot);

  // 6. Build castOrigin.
  const originRes = buildCastOrigin({
    castManifest,
    winningCloneId,
    repoRoot: rt.repoRoot,
    bundledAt,
    gitRemoteOrigin,
  });
  warnings.push(...originRes.warnings);

  // 7. Assemble the manifest.
  const cloneWorktree = deps.resolveCloneWorktree({
    repoRoot: rt.repoRoot,
    castId: opts.castId,
    cloneId: winningCloneId,
  });
  const contributes = await walkContributes(cloneWorktree);
  const hasContribution =
    contributes.skills.length + contributes.modes.length + contributes.commands.length + contributes.templates.length >
    0;
  if (!hasContribution) {
    throw new ShareError('share_nothing_to_ship', 'cast produced no shippable contribution', {
      cloneWorktree,
    });
  }

  const author = opts.author ?? null;
  if (author === null) {
    throw new ShareError('share_author_missing', 'cannot derive author; pass --author "<name>"');
  }
  const license = opts.license ?? null;
  if (license === null) {
    throw new ShareError('share_license_missing', 'cannot derive license; pass --license <SPDX>');
  }
  const description =
    opts.description ?? firstReasonLine(postMortem, opts.castId);
  const cliVersion = getMantaCliVersion();
  const mantaVersionCompat =
    opts.mantaVersionCompat ?? `^${cliVersion}`;

  const manifestCandidate = {
    schemaVersion: 1 as const,
    name: opts.name,
    version: opts.version,
    description: description.length >= 10 ? description : `Manta cast ${opts.castId} deliverable`,
    author,
    license,
    mantaVersionCompat,
    contributes,
    deps: {},
    castOrigin: originRes.castOrigin,
  };
  const manifest: SharedBundleManifest = SharedBundleManifestSchema.parse(manifestCandidate);

  // 8. README (Chunk 2: no $EDITOR pass — that needs interactive plumbing; the
  //    --no-edit flag is honoured by skipping the editor unconditionally here,
  //    the interactive editor lands with --publish in Chunk 3).
  const diffStats = computeDiffStats(sanitizedDiff);
  const zkFirstParas = sanitizedZk.map((z) => z.markdown.split(/\n\s*\n/).find((b) => b.trim() && !b.trim().startsWith('-') && !b.trim().startsWith('#')) ?? '');
  const readme = generateReadme({
    manifest,
    castOrigin: originRes.castOrigin,
    sanitizedPostMortem,
    sanitizedZkFirstParagraphs: zkFirstParas,
    diffStats,
  });

  // 9. Warnings gate.
  const nonFatal = warnings.filter((w) => w.severity === 'warning');
  if (nonFatal.length > 0) {
    if (opts.nonInteractive === true) {
      throw new ShareError('share_warnings_unaccepted', `${nonFatal.length} sanitization warning(s); --non-interactive forbids any warning`, {
        warnings: nonFatal,
      });
    }
    if (opts.acceptWarnings !== true) {
      throw new ShareError('share_warnings_unaccepted', `${nonFatal.length} sanitization warning(s); re-run with --accept-warnings to proceed`, {
        warnings: nonFatal,
      });
    }
  }

  // 10. Assemble the bundle.
  const skillFiles = await collectSkillFiles(cloneWorktree);
  const artifacts: BundleArtifacts = {
    manifest,
    readme,
    license: license === 'MIT' ? defaultLicenseText(license, author) : `${license}\n`,
    taskContract: sanitizedContract,
    snapshot: sanitizedSnapshot,
    postMortems: postMortem !== null ? [{ cloneId: winningCloneId, markdown: sanitizedPostMortem }] : [],
    zkNotes: sanitizedZk,
    eventsJsonl: sanitizedEventsJsonl,
    worktreeDiff: sanitizedDiff,
    ...(skillFiles.length > 0 ? { skills: skillFiles } : {}),
  };
  const baseName = `${opts.name.replace(/^@/, '').replace(/\//g, '-')}-${opts.version}`;
  const outDir = opts.outDir ?? '.';
  const assembled = await assembleBundle(artifacts, { outDir, packageBaseName: baseName });

  // 11. Publish gate (Chunk 3). The local bundle is already on disk and SURVIVES
  //     any publish failure — `publishBundle` never deletes it, so a blocked /
  //     declined publish leaves the tarball for re-inspection. bundleJsFiles =
  //     the shipped skill payload (scanBundleJs skips non-JS; Phase 7b bundles
  //     ship no JS, so the static scan is usually a no-op).
  let published: string | undefined;
  if (opts.publish === true) {
    const pubRes = await publishBundle({
      tarballPath: assembled.tarballPath,
      unpackedDir: assembled.unpackedDir,
      manifest,
      bundleJsFiles: skillFiles,
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      runner: deps.publishRunner,
      confirmer: deps.confirmer,
    });
    if (!pubRes.ok) {
      throw new ShareError('share_publish_blocked', `publish ${pubRes.reason}: ${pubRes.detail}`, {
        reason: pubRes.reason,
        tarballPath: assembled.tarballPath,
      });
    }
    published = pubRes.published;
  }

  return {
    tarballPath: assembled.tarballPath,
    packageName: manifest.name,
    version: manifest.version,
    directoryDigest: assembled.directoryDigest,
    warnings,
    winningCloneId,
    ...(published !== undefined ? { published } : {}),
  };
}

function computeDiffStats(diff: string): {
  filesChanged: number;
  insertions: number;
  deletions: number;
} {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) filesChanged += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) insertions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { filesChanged, insertions, deletions };
}

function defaultLicenseText(spdx: string, author: string): string {
  return `${spdx} License\n\nCopyright (c) ${author}\n`;
}

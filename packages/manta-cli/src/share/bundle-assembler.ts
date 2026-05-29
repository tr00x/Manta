import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as tar from 'tar';
import type { SharedBundleManifest } from '@manta/skill-validator';
import { computeDirDigest } from '../library/dir-digest.js';

/**
 * Bundle assembler + integrity witness for `manta share` (Phase 7b Task 2.1).
 *
 * Takes the SANITIZED artifacts (every input has already been through its
 * Chunk-1 sanitizer) plus the manifest, writes the unpacked tree
 * (research §1.2 layout), computes a per-file `checksum.json` witness, and
 * tars deterministically. The canonical directory hash reuses the SHIPPED
 * `computeDirDigest` primitive (same one Phase 7a's `verifyLibraryIntegrity`
 * checks at cast time), so a shared-then-installed bundle's `directoryDigest`
 * is produced by exactly one shared algorithm. No new hashing code.
 */

export const CHECKSUM_FILENAME = 'checksum.json';
export const MANIFEST_FILENAME = 'manta-package.json';

export interface BundleArtifacts {
  manifest: SharedBundleManifest;
  readme: string;
  license: string;
  taskContract: unknown; // sanitized (Task 1.4)
  snapshot: unknown; // sanitized (Task 1.3)
  postMortems: Array<{ cloneId: string; markdown: string }>;
  zkNotes: Array<{ filename: string; markdown: string }>;
  eventsJsonl: string; // sanitized, one JSON object per line (Task 1.7)
  worktreeDiff: string; // sanitized (Task 1.7)
  skills?: Array<{ relPath: string; content: string }>;
}

export interface AssembledBundle {
  /** Path to the `.manta-pkg.tar.gz`. */
  tarballPath: string;
  /** Path to the unpacked staging dir (kept for `--no-tar` / inspection). */
  unpackedDir: string;
  /** computeDirDigest of the unpacked tree (`sha256-<base64>`). */
  directoryDigest: string;
  /** Per-file checksum map written to checksum.json (relpath → 64-hex sha256). */
  checksums: Record<string, string>;
}

interface ChecksumFile {
  algorithm: 'sha256';
  /** relative-path → hex sha256. Excludes checksum.json itself. */
  files: Record<string, string>;
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Recursively list every regular file under `root` as POSIX-relative paths. */
async function listFiles(root: string, current: string, acc: string[]): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(current, e.name);
    if (e.isDirectory()) {
      await listFiles(root, full, acc);
    } else if (e.isFile()) {
      acc.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
}

async function writeFileEnsuringDir(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

/**
 * Assemble the bundle: write the unpacked tree, compute `checksum.json`, hash
 * the directory, and tar deterministically.
 */
export async function assembleBundle(
  artifacts: BundleArtifacts,
  opts: { outDir: string; packageBaseName: string },
): Promise<AssembledBundle> {
  const unpackedDir = path.join(opts.outDir, opts.packageBaseName);
  // Clean any prior staging so a re-assemble is reproducible (no stale files).
  await fs.rm(unpackedDir, { recursive: true, force: true });
  await fs.mkdir(unpackedDir, { recursive: true });

  // 1. Write every payload file (research §1.2 layout).
  await writeFileEnsuringDir(
    path.join(unpackedDir, MANIFEST_FILENAME),
    `${JSON.stringify(artifacts.manifest, null, 2)}\n`,
  );
  await writeFileEnsuringDir(path.join(unpackedDir, 'README.md'), artifacts.readme);
  await writeFileEnsuringDir(path.join(unpackedDir, 'LICENSE'), artifacts.license);
  await writeFileEnsuringDir(
    path.join(unpackedDir, 'task-contract.json'),
    `${JSON.stringify(artifacts.taskContract, null, 2)}\n`,
  );
  await writeFileEnsuringDir(
    path.join(unpackedDir, 'snapshot.json'),
    `${JSON.stringify(artifacts.snapshot, null, 2)}\n`,
  );
  for (const pm of artifacts.postMortems) {
    await writeFileEnsuringDir(
      path.join(unpackedDir, 'post-mortems', `${pm.cloneId}.md`),
      pm.markdown,
    );
  }
  for (const zk of artifacts.zkNotes) {
    await writeFileEnsuringDir(path.join(unpackedDir, 'zk-notes', zk.filename), zk.markdown);
  }
  await writeFileEnsuringDir(path.join(unpackedDir, 'events.jsonl'), artifacts.eventsJsonl);
  await writeFileEnsuringDir(
    path.join(unpackedDir, 'worktree-diff.patch'),
    artifacts.worktreeDiff,
  );
  for (const skill of artifacts.skills ?? []) {
    await writeFileEnsuringDir(path.join(unpackedDir, 'skills', skill.relPath), skill.content);
  }

  // 2. Compute checksum.json over every file written so far (excludes itself).
  const fileList: string[] = [];
  await listFiles(unpackedDir, unpackedDir, fileList);
  fileList.sort();
  const checksums: Record<string, string> = {};
  for (const rel of fileList) {
    const bytes = await fs.readFile(path.join(unpackedDir, ...rel.split('/')));
    checksums[rel] = sha256Hex(bytes);
  }
  const checksumFile: ChecksumFile = { algorithm: 'sha256', files: checksums };
  await fs.writeFile(
    path.join(unpackedDir, CHECKSUM_FILENAME),
    `${JSON.stringify(checksumFile, null, 2)}\n`,
    'utf8',
  );

  // 3. Canonical directory hash via the SHIPPED primitive (includes checksum.json).
  const directoryDigest = await computeDirDigest(unpackedDir);

  // 4. Deterministic tar: portable mode + fixed mtime (bundledAt) + sorted
  //    entries ⇒ two assembles of identical artifacts are byte-identical.
  const allEntries: string[] = [];
  await listFiles(unpackedDir, unpackedDir, allEntries);
  allEntries.sort();
  const fixedMtime = new Date(artifacts.manifest.castOrigin.bundledAt);
  const tarballPath = path.join(opts.outDir, `${opts.packageBaseName}.manta-pkg.tar.gz`);
  // NO `prefix`: Phase 7a `manta install` extracts with `cwd: unpacked` and
  // reads `manta-package.json` at the tarball ROOT — a prefix dir would break
  // the round-trip. Files sit at the archive root via `cwd: unpackedDir`.
  await tar.c(
    {
      file: tarballPath,
      cwd: unpackedDir,
      gzip: true,
      portable: true,
      mtime: fixedMtime,
    },
    allEntries,
  );

  return { tarballPath, unpackedDir, directoryDigest, checksums };
}

/**
 * Recompute checksums from an unpacked dir and compare to its checksum.json.
 * Used by Chunk 3 publish preflight and re-usable by `manta library preview`.
 */
export async function verifyBundleChecksums(
  unpackedDir: string,
): Promise<{ ok: true } | { ok: false; mismatches: string[] }> {
  const raw = await fs.readFile(path.join(unpackedDir, CHECKSUM_FILENAME), 'utf8');
  const parsed = JSON.parse(raw) as ChecksumFile;
  const mismatches: string[] = [];
  for (const [rel, expected] of Object.entries(parsed.files)) {
    let actual: string;
    try {
      const bytes = await fs.readFile(path.join(unpackedDir, ...rel.split('/')));
      actual = sha256Hex(bytes);
    } catch {
      mismatches.push(rel);
      continue;
    }
    if (actual !== expected) mismatches.push(rel);
  }
  if (mismatches.length > 0) return { ok: false, mismatches };
  return { ok: true };
}

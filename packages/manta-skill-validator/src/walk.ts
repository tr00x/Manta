import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { validateSkill, validateCommand, type ValidationReport } from './validate.js';
import type { ValidationIssue } from './errors.js';
import {
  MantaPackageManifestSchema,
  LibraryModeJsonSchema,
  type MantaPackageManifest,
} from './manifest-schema.js';

const SAFE_DIR = /^[a-z][a-z0-9-]*$/;
const SAFE_FILE = /^[a-z][a-z0-9-]*\.md$/;

const isDotfile = (name: string): boolean => name.startsWith('.');

export interface DiscoveredFile {
  name: string;
  filePath: string;
}

export interface WalkResult {
  skills: DiscoveredFile[];
  commands: DiscoveredFile[];
  warnings: ValidationIssue[];
}

export async function walkSkillsAndCommands(repoRoot: string): Promise<WalkResult> {
  const warnings: ValidationIssue[] = [];
  const skills = await walkSkills(repoRoot, warnings);
  const commands = await walkCommands(repoRoot, warnings);
  return { skills, commands, warnings };
}

async function walkSkills(repoRoot: string, warnings: ValidationIssue[]): Promise<DiscoveredFile[]> {
  const dir = path.join(repoRoot, 'skills');
  let entries: string[];
  try { entries = await fs.readdir(dir); } catch { return []; }
  const out: DiscoveredFile[] = [];
  for (const e of entries) {
    // Silently skip dotfile/dotdir entries — filesystem artifacts (e.g. macOS .DS_Store)
    // that no Manta concept owns. Hostile non-dotfile names still surface below.
    if (isDotfile(e)) continue;
    if (!SAFE_DIR.test(e)) {
      warnings.push({ severity: 'warning', code: 'unsafe_path', message: `skipping unsafe skill directory name: ${e}` });
      continue;
    }
    const file = path.join(dir, e, 'SKILL.md');
    try { await fs.access(file); } catch { continue; }
    out.push({ name: e, filePath: file });
  }
  return out;
}

async function walkCommands(repoRoot: string, warnings: ValidationIssue[]): Promise<DiscoveredFile[]> {
  const dir = path.join(repoRoot, 'commands');
  let entries: string[];
  try { entries = await fs.readdir(dir); } catch { return []; }
  const out: DiscoveredFile[] = [];
  for (const e of entries) {
    // Silently skip dotfile entries — filesystem artifacts (e.g. macOS .DS_Store)
    // that no Manta concept owns. Hostile non-dotfile names still surface below.
    if (isDotfile(e)) continue;
    if (!SAFE_FILE.test(e)) {
      warnings.push({ severity: 'warning', code: 'unsafe_path', message: `skipping unsafe command file name: ${e}` });
      continue;
    }
    out.push({ name: e.replace(/\.md$/, ''), filePath: path.join(dir, e) });
  }
  return out;
}

export interface ValidateAllResult {
  reports: ValidationReport[];
  warnings: ValidationIssue[];
  allOk: boolean;
  errorCount: number;
}

export async function validateAll(repoRoot: string): Promise<ValidateAllResult> {
  const walked = await walkSkillsAndCommands(repoRoot);
  const reports: ValidationReport[] = [];
  for (const s of walked.skills) {
    const src = await fs.readFile(s.filePath, 'utf8');
    reports.push(validateSkill(path.relative(repoRoot, s.filePath), src));
  }
  for (const c of walked.commands) {
    const src = await fs.readFile(c.filePath, 'utf8');
    reports.push(validateCommand(path.relative(repoRoot, c.filePath), src));
  }
  const errorCount = reports.reduce((acc, r) => acc + r.issues.filter((i) => i.severity === 'error').length, 0);
  return { reports, warnings: walked.warnings, allOk: errorCount === 0, errorCount };
}

export interface ValidatePackageResult {
  manifest: MantaPackageManifest | null;
  validationReport: ValidationReport[];
  contributesCrossCheck: { ok: true } | { ok: false; issues: string[] };
  fatal: boolean;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function validatePackage(packageRoot: string): Promise<ValidatePackageResult> {
  const manifestPath = path.join(packageRoot, 'manta-package.json');
  const validationReport: ValidationReport[] = [];
  const crossCheckIssues: string[] = [];

  // Step 1: read + parse manifest.
  let manifest: MantaPackageManifest | null = null;
  let manifestRaw: string | null = null;
  try {
    manifestRaw = await fs.readFile(manifestPath, 'utf8');
  } catch {
    validationReport.push({
      path: 'manta-package.json',
      ok: false,
      issues: [{ severity: 'error', code: 'manifest_missing', message: 'manta-package.json not found at package root' }],
    });
    return { manifest: null, validationReport, contributesCrossCheck: { ok: false, issues: ['manta-package.json not found'] }, fatal: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch (err) {
    validationReport.push({
      path: 'manta-package.json',
      ok: false,
      issues: [{ severity: 'error', code: 'manifest_parse_error', message: `manta-package.json is not valid JSON: ${String(err)}` }],
    });
    return { manifest: null, validationReport, contributesCrossCheck: { ok: false, issues: ['manta-package.json parse error'] }, fatal: true };
  }
  const manifestResult = MantaPackageManifestSchema.safeParse(parsed);
  if (!manifestResult.success) {
    const issues = manifestResult.error.issues.map((i) => ({
      severity: 'error' as const,
      code: 'manifest_invalid' as const,
      message: `manta-package.json ${i.path.join('.') || '<root>'}: ${i.message}`,
    }));
    validationReport.push({ path: 'manta-package.json', ok: false, issues });
    return {
      manifest: null,
      validationReport,
      contributesCrossCheck: { ok: false, issues: issues.map((i) => i.message) },
      fatal: true,
    };
  }
  manifest = manifestResult.data;

  // Step 2: run existing validateAll.
  const allReport = await validateAll(packageRoot);
  for (const r of allReport.reports) validationReport.push(r);

  // Step 3: cross-check contributes.skills vs walked.
  const walked = await walkSkillsAndCommands(packageRoot);
  const onDiskSkills = new Set(walked.skills.map((s) => s.name));
  const declaredSkills = new Set(manifest.contributes.skills.map((s) => s.name));
  for (const declared of declaredSkills) {
    if (!onDiskSkills.has(declared)) {
      crossCheckIssues.push(
        `manifest declares skill "${declared}" but skills/${declared}/SKILL.md was not found on disk`,
      );
    }
  }
  for (const onDisk of onDiskSkills) {
    if (!declaredSkills.has(onDisk)) {
      crossCheckIssues.push(
        `skills/${onDisk}/SKILL.md exists on disk but is not declared in contributes.skills (drive-by skill)`,
      );
    }
  }

  // commands cross-check.
  const onDiskCommands = new Set(walked.commands.map((c) => c.name));
  const declaredCommands = new Set(manifest.contributes.commands.map((c) => c.name));
  for (const declared of declaredCommands) {
    if (!onDiskCommands.has(declared)) {
      crossCheckIssues.push(
        `manifest declares command "${declared}" but commands/${declared}.md was not found on disk`,
      );
    }
  }
  for (const onDisk of onDiskCommands) {
    if (!declaredCommands.has(onDisk)) {
      crossCheckIssues.push(
        `commands/${onDisk}.md exists on disk but is not declared in contributes.commands (drive-by command)`,
      );
    }
  }

  // modes cross-check + per-mode mode.json parse.
  for (const mode of manifest.contributes.modes) {
    const modeJsonPath = path.join(packageRoot, 'modes', mode.name, 'mode.json');
    if (!(await fileExists(modeJsonPath))) {
      crossCheckIssues.push(`manifest declares mode "${mode.name}" but modes/${mode.name}/mode.json was not found on disk`);
      continue;
    }
    let modeRaw: string;
    try {
      modeRaw = await fs.readFile(modeJsonPath, 'utf8');
    } catch (err) {
      crossCheckIssues.push(`modes/${mode.name}/mode.json could not be read: ${String(err)}`);
      continue;
    }
    let modeParsed: unknown;
    try {
      modeParsed = JSON.parse(modeRaw);
    } catch (err) {
      crossCheckIssues.push(`modes/${mode.name}/mode.json is not valid JSON: ${String(err)}`);
      continue;
    }
    const modeResult = LibraryModeJsonSchema.safeParse(modeParsed);
    if (!modeResult.success) {
      for (const issue of modeResult.error.issues) {
        crossCheckIssues.push(
          `modes/${mode.name}/mode.json ${issue.path.join('.') || '<root>'}: ${issue.message}`,
        );
      }
    }
  }

  // templates existence check.
  for (const tmpl of manifest.contributes.templates) {
    const tmplPath = path.join(packageRoot, 'templates', tmpl.name);
    if (!(await fileExists(tmplPath))) {
      crossCheckIssues.push(`manifest declares template "${tmpl.name}" but templates/${tmpl.name} was not found on disk`);
    }
  }

  // hooks script existence check.
  for (const hook of manifest.contributes.hooks) {
    const hookPath = path.join(packageRoot, hook.script);
    if (!(await fileExists(hookPath))) {
      crossCheckIssues.push(
        `manifest declares hook "${hook.event}" with script "${hook.script}" but the file was not found at ${hook.script}`,
      );
    }
  }

  const validationErrorCount = validationReport.reduce(
    (acc, r) => acc + r.issues.filter((i) => i.severity === 'error').length,
    0,
  );
  const contributesCrossCheck: ValidatePackageResult['contributesCrossCheck'] =
    crossCheckIssues.length === 0 ? { ok: true } : { ok: false, issues: crossCheckIssues };
  const fatal = validationErrorCount > 0 || crossCheckIssues.length > 0;

  return { manifest, validationReport, contributesCrossCheck, fatal };
}

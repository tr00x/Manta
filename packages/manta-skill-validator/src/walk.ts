import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { validateSkill, validateCommand, type ValidationReport } from './validate.js';
import type { ValidationIssue } from './errors.js';

const SAFE_DIR = /^[a-z][a-z0-9-]*$/;
const SAFE_FILE = /^[a-z][a-z0-9-]*\.md$/;

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
    if (e.startsWith('.')) continue;
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
    if (e.startsWith('.')) continue;
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

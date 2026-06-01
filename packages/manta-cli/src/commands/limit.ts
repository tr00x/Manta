import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Runtime } from '../runtime.js';
import type { Reporter } from '../output/reporter.js';
import type { CommandResult } from './status.js';
import { loadBudgetConfig, type ResolvedBudgetConfig } from '../config/budget-config.js';
import { BudgetConfigSchema } from '@manta/bus';

export interface LimitCommandOptions {
  subcommand: 'get' | 'set';
  key?: string;
  value?: string;
  reporter: Reporter;
}

interface FlatEntry {
  key: string;
  display: string;
}

function flattenConfig(c: ResolvedBudgetConfig): FlatEntry[] {
  // Claude Code is a subscription, not pay-per-token, so the only tunable limit
  // is parallelism — how many clone processes run at once.
  return [{ key: 'max_parallel_clones', display: String(c.maxParallelClones) }];
}

function resolvedValue(
  config: Awaited<ReturnType<typeof loadBudgetConfig>>,
  key: string,
): string | undefined {
  const map: Record<string, unknown> = {
    max_parallel_clones: config.maxParallelClones,
  };
  const v = map[key];
  return v !== undefined ? String(v) : undefined;
}

async function handleGet(
  rt: Runtime,
  opts: LimitCommandOptions,
): Promise<CommandResult> {
  const config = await loadBudgetConfig(rt.repoRoot);

  if (opts.key) {
    const v = resolvedValue(config, opts.key);
    if (v === undefined) {
      return { exitCode: 1, stdout: `Unknown key: ${opts.key}` };
    }
    return { exitCode: 0, stdout: `${opts.key}: ${v}` };
  }

  const entries = flattenConfig(config);
  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`${e.key}:`.padEnd(35) + e.display);
  }
  opts.reporter.info('limit.get');
  return { exitCode: 0, stdout: lines.join('\n') };
}

function parseValue(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'auto') return 'auto';
  const num = Number(raw);
  if (!Number.isNaN(num)) return num;
  return raw;
}

function setNested(obj: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const parts = dottedKey.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

async function handleSet(
  rt: Runtime,
  opts: LimitCommandOptions,
): Promise<CommandResult> {
  if (!opts.key || opts.value === undefined) {
    return { exitCode: 1, stdout: 'Usage: manta limit set <key> <value>' };
  }

  const oldConfig = await loadBudgetConfig(rt.repoRoot);
  const oldVal = resolvedValue(oldConfig, opts.key);
  if (oldVal === undefined) {
    return { exitCode: 1, stdout: `Unknown key: ${opts.key}` };
  }

  const configPath = join(rt.repoRoot, '.manta', 'config', 'budget.json');

  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, 'utf-8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File doesn't exist yet
  }

  const parsedValue = parseValue(opts.value);
  setNested(existing, opts.key, parsedValue);

  const validation = BudgetConfigSchema.safeParse(existing);
  if (!validation.success) {
    return {
      exitCode: 1,
      stdout: `Invalid value: ${validation.error.issues.map((i) => i.message).join(', ')}`,
    };
  }

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

  opts.reporter.info('limit.set', { key: opts.key, old: oldVal, new: String(parsedValue) });

  return {
    exitCode: 0,
    stdout: `Updated ${opts.key}: ${oldVal} → ${parsedValue}`,
  };
}

export async function runLimitCommand(
  rt: Runtime,
  opts: LimitCommandOptions,
): Promise<CommandResult> {
  return opts.subcommand === 'set' ? handleSet(rt, opts) : handleGet(rt, opts);
}

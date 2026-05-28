import { readFile } from 'node:fs/promises';

const GIT_MUTATING_PATTERNS = [
  /\bgit\s+(add|commit|checkout|stash|merge|rebase|reset|cherry-pick|revert|push)\b/,
];

export interface CheckGitLockInput {
  tool: string;
  input: { command?: string };
  cloneId: string;
  locksPath: string;
}

export interface CheckGitLockResult {
  blocked: boolean;
  message?: string;
}

interface LocksFile {
  version: number;
  leases: Record<string, { path: string; owner_clone_id: string; acquired_at: number; last_heartbeat_at: number }>;
}

export async function checkGitLock(ctx: CheckGitLockInput): Promise<CheckGitLockResult> {
  if (ctx.tool !== 'Bash') return { blocked: false };

  const cmd = ctx.input.command ?? '';
  const isGitMutating = GIT_MUTATING_PATTERNS.some((p) => p.test(cmd));
  if (!isGitMutating) return { blocked: false };

  try {
    const raw = await readFile(ctx.locksPath, 'utf8');
    const data = JSON.parse(raw) as LocksFile;
    const gitLock = data.leases?.['GIT_OPERATIONS'];

    if (gitLock?.owner_clone_id === ctx.cloneId) {
      return { blocked: false };
    }

    if (gitLock) {
      return {
        blocked: true,
        message: `GIT_OPERATIONS lock held by ${gitLock.owner_clone_id}, not ${ctx.cloneId}. Wait for release or acquire via manta.lock({ clone_id: "${ctx.cloneId}", path: "GIT_OPERATIONS" }).`,
      };
    }
  } catch {
    // No locks file or parse error — lock not held
  }

  return {
    blocked: true,
    message: `GIT_OPERATIONS lock not held by ${ctx.cloneId}. Acquire via manta.lock({ clone_id: "${ctx.cloneId}", path: "GIT_OPERATIONS" }) before git commands.`,
  };
}

export function buildGitLockHookScript(locksPath: string, cloneId: string): string {
  return `#!/usr/bin/env node
'use strict';
const fs = require('fs');

const LOCKS_PATH = ${JSON.stringify(locksPath)};
const CLONE_ID = process.env.MANTA_CLONE_ID || ${JSON.stringify(cloneId)};

const GIT_MUTATING = /\\bgit\\s+(add|commit|checkout|stash|merge|rebase|reset|cherry-pick|revert|push)\\b/;

// Read hook input from stdin (Claude Code PreToolUse format)
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const tool = data.tool_name || '';
    const cmd = (data.tool_input && data.tool_input.command) || '';

    if (tool !== 'Bash' || !GIT_MUTATING.test(cmd)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Check locks.json
    let locks;
    try {
      locks = JSON.parse(fs.readFileSync(LOCKS_PATH, 'utf8'));
    } catch {
      // No locks file — block
      process.stdout.write(JSON.stringify({
        continue: false,
        reason: 'GIT_OPERATIONS lock not held by ' + CLONE_ID + '. Acquire via manta.lock before git commands.',
      }));
      process.exit(0);
    }

    const gitLock = locks.leases && locks.leases['GIT_OPERATIONS'];
    if (gitLock && gitLock.owner_clone_id === CLONE_ID) {
      process.stdout.write(JSON.stringify({ continue: true }));
    } else {
      const holder = gitLock ? gitLock.owner_clone_id : 'nobody';
      process.stdout.write(JSON.stringify({
        continue: false,
        reason: 'GIT_OPERATIONS lock held by ' + holder + ', not ' + CLONE_ID + '. Acquire lock first.',
      }));
    }
  } catch (err) {
    // Outer parse failed (truncated frame, encoding error, harness bug, or
    // an attacker probing the hook). Bug #39 fix: fail **closed**. The hook
    // is installed with matcher 'Bash' only, so a parse failure means we
    // cannot tell whether the would-be Bash command is git-mutating. A
    // blocked benign \`pnpm test\` is recoverable noise; an unlocked
    // \`git commit\` corrupts the shared index. Default to safety.
    process.stdout.write(JSON.stringify({
      continue: false,
      reason: 'manta git-lock hook: PreToolUse input could not be parsed (' + (err && err.message ? err.message : 'unknown') + '). Blocking for safety — acquire the GIT_OPERATIONS lock and retry, or investigate hook input format.',
    }));
  }
  process.exit(0);
});
`;
}

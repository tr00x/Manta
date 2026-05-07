import { posix } from 'node:path';
import type { z } from 'zod';
import type { MessageSchema, OpenFileSchema } from './schema';

type Message = z.infer<typeof MessageSchema>;
type OpenFile = z.infer<typeof OpenFileSchema>;

export interface DistillInput {
  messages: Message[];
  openFiles: OpenFile[];
  maxRecentMessages: number;
  allowedPaths?: string[];
}

export interface DistillOutput {
  recentMessages: Message[];
  openFiles: OpenFile[];
}

function isPathAllowed(rawPath: string, allowedPaths: string[]): boolean {
  // Normalize to posix form for stable cross-platform matching.
  const normalized = posix.normalize(rawPath);

  // Defense-in-depth: even after normalization, reject any leftover `..` segment.
  // posix.normalize collapses safe `..` sequences but preserves leading `..`
  // (e.g. `../foo`) and never escapes a segment we explicitly disallow.
  const segments = normalized.split('/');
  if (segments.includes('..')) {
    return false;
  }

  return allowedPaths.some((p) => {
    const normalizedAllowed = posix.normalize(p);
    if (normalized === normalizedAllowed) {
      return true;
    }
    // Treat allowed entry as a directory: require segment-boundary match.
    const withSlash = normalizedAllowed.endsWith('/')
      ? normalizedAllowed
      : `${normalizedAllowed}/`;
    return normalized.startsWith(withSlash);
  });
}

export function distillContext(input: DistillInput): DistillOutput {
  if (!Number.isInteger(input.maxRecentMessages) || input.maxRecentMessages <= 0) {
    throw new Error(
      `distillContext: maxRecentMessages must be a positive integer (got ${input.maxRecentMessages})`,
    );
  }

  const recentMessages =
    input.messages.length > input.maxRecentMessages
      ? input.messages.slice(input.messages.length - input.maxRecentMessages)
      : [...input.messages];

  const allowed = input.allowedPaths;
  const openFiles = allowed
    ? input.openFiles.filter((f) => isPathAllowed(f.path, allowed))
    : [...input.openFiles];

  return { recentMessages, openFiles };
}
